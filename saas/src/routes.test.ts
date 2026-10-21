import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import Fastify, { type FastifyInstance } from 'fastify';
import { generateClientKey, generateSigningKey, randomId, sha256Hex, signingPublicKey, verifyAuthz } from '@nopear/core/crypto';
import { PLAINTEXT_DISABLED_MESSAGE, type Machine, type SaasToWorker } from '@nopear/protocol';
import { openStore } from './store';
import { buildServer, hubOf } from './server';
import { WorkerHub } from './hub';
import { EventsBus, registerRoutes } from './routes';
import { Collab } from './collab';
import type { SaasConfigEnv } from './config';

const dir = mkdtempSync(join(tmpdir(), 'saas-routes-'));
const signing = generateSigningKey();
const store = await openStore(`sqlite:${join(dir, 'saas.db')}`);
const config: SaasConfigEnv = {
  port: 0,
  publicUrl: 'http://localhost',
  publicUrlExplicit: false,
  dataDir: dir,
  db: `sqlite:${join(dir, 'saas.db')}`,
  signingSeed: signing.seed,
  sessionSecret: 'test-secret',
  googleClientId: null,
  googleClientSecret: null,
  devLogin: true,
  bootstrapToken: null,
  redirectAllowlist: ['nopear://'],
  bodyLimitBytes: 64 * 1024 * 1024,
  webDir: join(dir, 'no-web'),
  bootstrapAdmin: null,
  workerTgz: null,
};
const app: FastifyInstance = await buildServer({ config, store });
await app.listen({ port: 0, host: '127.0.0.1' });
const addr = app.server.address();
const port = typeof addr === 'object' && addr ? addr.port : 0;
const base = `http://127.0.0.1:${port}`;
after(async () => { await app.close(); await store.close(); });

async function json(path: string, init: RequestInit & { token?: string } = {}) {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.body && !headers['content-type']) headers['content-type'] = 'application/json';
  const res = await fetch(base + path, { ...init, headers });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function login(email: string) {
  const r = await json('/api/auth/dev', { method: 'POST', body: JSON.stringify({ email }) });
  assert.equal(r.status, 200);
  return r.body as { token: string; user: { id: string; email: string } };
}

interface FakeWorker { ws: WebSocket; frames: SaasToWorker[]; next(pred: (f: SaasToWorker) => boolean): Promise<SaasToWorker> }

async function fakeWorker(workerId: string, secret: string, hello: Record<string, unknown>): Promise<FakeWorker> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/worker/connect`, {
    headers: { authorization: `Bearer ${secret}`, 'x-nopear-worker': workerId },
  });
  const frames: SaasToWorker[] = [];
  const waiters: { pred: (f: SaasToWorker) => boolean; resolve: (f: SaasToWorker) => void }[] = [];
  ws.on('message', (d) => {
    const f = JSON.parse(String(d)) as SaasToWorker;
    frames.push(f);
    for (const w of [...waiters]) if (w.pred(f)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(f); }
  });
  await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
  ws.send(JSON.stringify({ t: 'hello', ...hello }));
  return {
    ws, frames,
    next: (pred) => {
      const hit = frames.find(pred);
      if (hit) { frames.splice(frames.indexOf(hit), 1); return Promise.resolve(hit); }
      return new Promise((resolve) => waiters.push({ pred, resolve: (f) => { frames.splice(frames.indexOf(f), 1); resolve(f); } }));
    },
  };
}

async function registerWorker(workerId: string) {
  const secret = randomId(24);
  const key = generateClientKey();
  const r = await json('/worker/register', { method: 'POST', body: JSON.stringify({ workerId, workerPub: key.pub, secretHash: sha256Hex(secret) }) });
  assert.equal(r.status, 200);
  assert.equal(r.body.platformPub, signing.pub);
  // Idempotent: the same identity re-registering (lost response → retry) is ok and returns platformPub again.
  const same = await json('/worker/register', { method: 'POST', body: JSON.stringify({ workerId, workerPub: key.pub, secretHash: sha256Hex(secret) }) });
  assert.equal(same.status, 200);
  assert.equal(same.body.platformPub, signing.pub);
  // A different identity under the same workerId is a conflict.
  const otherPub = await json('/worker/register', { method: 'POST', body: JSON.stringify({ workerId, workerPub: generateClientKey().pub, secretHash: sha256Hex(secret) }) });
  assert.equal(otherPub.status, 409);
  const otherSecret = await json('/worker/register', { method: 'POST', body: JSON.stringify({ workerId, workerPub: key.pub, secretHash: sha256Hex(randomId(24)) }) });
  assert.equal(otherSecret.status, 409);
  return { secret, key };
}

/** Read an SSE stream into blocks until predicate on accumulated text matches. */
async function readSse(res: Response, until: (text: string) => boolean): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = '';
  while (!until(text)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
  }
  await reader.cancel().catch(() => {});
  return text;
}

test('config + dev login + me + logout', async () => {
  const cfg = await json('/api/config');
  assert.deepEqual(cfg.body, { googleEnabled: false, devLogin: true, publicUrl: 'http://localhost' });
  const { token, user } = await login('me@x.com');
  const me = await json('/api/me', { token });
  assert.equal(me.status, 200);
  assert.deepEqual(me.body.user, user);
  assert.equal((await json('/api/me')).status, 401);
  assert.equal((await json('/api/auth/logout', { method: 'POST', token })).status, 200);
  assert.equal((await json('/api/me', { token })).status, 401);
  assert.equal((await json('/api/auth/google/start?redirect=nopear://auth')).status, 404);
});

test('full flow: clients, claim, authz, data plane checks, rpc & watch relay', async () => {
  const alice = await login('alice@x.com');
  const bob = await login('bob@x.com');
  const client = generateClientKey();
  const reg = await json('/api/clients', { method: 'POST', token: alice.token, body: JSON.stringify({ clientPub: client.pub, label: 'web' }) });
  assert.equal(reg.status, 201);
  assert.equal(reg.body.client.clientPub, client.pub);
  assert.equal((await json('/api/clients', { token: alice.token })).body.clients.length, 1);

  const workerId = 'w_' + 'a'.repeat(16);
  const { secret } = await registerWorker(workerId);
  // bad secret rejected
  const bad = new WebSocket(`ws://127.0.0.1:${port}/worker/connect`, { headers: { authorization: 'Bearer nope', 'x-nopear-worker': workerId } });
  await new Promise<void>((res) => { bad.once('error', () => res()); bad.once('unexpected-response', () => res()); });

  // events SSE for alice
  const evAbort = new AbortController();
  const evRes = await fetch(base + '/api/events', { headers: { authorization: `Bearer ${alice.token}` }, signal: evAbort.signal });
  assert.equal(evRes.status, 200);

  const claimToken = randomId(24);
  const w = await fakeWorker(workerId, secret, { version: '3.0.0', label: 'box', claimTokenHash: sha256Hex(claimToken) });
  const first = await w.next((f) => f.t === 'authz');
  assert.equal(first.t === 'authz' && first.claimed, false);

  // claim: wrong token → 400
  assert.equal((await json('/api/machines/claim', { method: 'POST', token: alice.token, body: JSON.stringify({ workerId, claimToken: 'wrong' }) })).status, 400);
  const claim = await json('/api/machines/claim', { method: 'POST', token: alice.token, body: JSON.stringify({ workerId, claimToken, label: 'Alice box' }) });
  assert.equal(claim.status, 200);
  assert.equal(claim.body.machine.workerId, workerId);
  assert.equal(claim.body.machine.online, true);
  const authz = await w.next((f) => f.t === 'authz' && f.claimed);
  assert.ok(authz.t === 'authz');
  assert.equal(authz.userId, alice.user.id);
  assert.equal(authz.clients.length, 1);
  assert.ok(verifyAuthz(signing.pub, alice.user.id, client.pub, authz.clients[0]!.sig));
  // second claim → 400
  assert.equal((await json('/api/machines/claim', { method: 'POST', token: bob.token, body: JSON.stringify({ workerId, claimToken }) })).status, 400);

  const machines = await json('/api/machines', { token: alice.token });
  assert.equal(machines.body.machines.length, 1);
  assert.equal(machines.body.machines[0].label, 'Alice box');

  const evText = await readSse(evRes, (t) => t.includes('"machines"'));
  assert.match(evText, /"type":"machines"/);
  evAbort.abort();

  // ---- data plane checks ----
  const payload = new Uint8Array([1, 2, 3, 250]);
  const rpcPost = (wid: string, token?: string, clientPub?: string) =>
    fetch(`${base}/api/w/${wid}/rpc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(clientPub ? { 'x-nopear-client': clientPub } : {}),
      },
      body: payload,
    });
  assert.equal((await rpcPost(workerId)).status, 401);
  assert.equal((await rpcPost(workerId, alice.token, generateClientKey().pub)).status, 403);
  const bobClient = generateClientKey();
  await json('/api/clients', { method: 'POST', token: bob.token, body: JSON.stringify({ clientPub: bobClient.pub, label: 'b' }) });
  assert.equal((await rpcPost(workerId, bob.token, bobClient.pub)).status, 403);
  assert.equal((await rpcPost('w_doesnotexist', alice.token, client.pub)).status, 404);

  // online rpc: worker echoes payload reversed
  w.ws.on('message', (d) => {
    const f = JSON.parse(String(d));
    if (f.t === 'rpc') {
      assert.equal(f.clientPub, client.pub);
      w.ws.send(JSON.stringify({ t: 'rpc.res', id: f.id, payload: f.payload }));
    }
  });
  const ok = await rpcPost(workerId, alice.token, client.pub);
  assert.equal(ok.status, 200);
  assert.deepEqual(new Uint8Array(await ok.arrayBuffer()), payload);

  // watch: worker sends 2 data frames then end
  const watchP = w.next((f) => f.t === 'watch');
  const wres = await fetch(`${base}/api/w/${workerId}/watch`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${alice.token}`, 'x-nopear-client': client.pub },
    body: payload,
  });
  assert.equal(wres.status, 200);
  assert.match(wres.headers.get('content-type') ?? '', /text\/event-stream/);
  const wf = await watchP;
  assert.ok(wf.t === 'watch');
  w.ws.send(JSON.stringify({ t: 'watch.data', id: wf.id, payload: 'AAA' }));
  w.ws.send(JSON.stringify({ t: 'watch.data', id: wf.id, payload: 'BBB' }));
  w.ws.send(JSON.stringify({ t: 'watch.end', id: wf.id, code: 'gone' }));
  const wtext = await readSse(wres, (t) => t.includes('event: end'));
  assert.match(wtext, /data: AAA\n\n/);
  assert.match(wtext, /data: BBB\n\n/);
  assert.match(wtext, /event: end\ndata: gone\n\n/);

  // second watch; worker disconnects → offline
  const watch2P = w.next((f) => f.t === 'watch');
  const wres2 = await fetch(`${base}/api/w/${workerId}/watch`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${alice.token}`, 'x-nopear-client': client.pub },
    body: payload,
  });
  await watch2P;
  w.ws.close();
  const wtext2 = await readSse(wres2, (t) => t.includes('event: offline'));
  assert.match(wtext2, /event: offline/);

  // offline → 503
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await rpcPost(workerId, alice.token, client.pub)).status, 503);

  // rename + unclaim
  assert.equal((await json(`/api/machines/${workerId}`, { method: 'PATCH', token: alice.token, body: JSON.stringify({ label: 'renamed' }) })).status, 200);
  assert.equal((await json(`/api/machines/${workerId}`, { method: 'DELETE', token: alice.token })).status, 200);
  assert.equal((await json('/api/machines', { token: alice.token })).body.machines.length, 0);
  assert.equal((await json(`/api/clients/${client.pub}`, { method: 'DELETE', token: alice.token })).status, 200);
  assert.equal((await json('/api/clients', { token: alice.token })).body.clients.length, 0);
});

test('authz is pushed once on attach, not after every hello', async () => {
  const workerId = 'w_' + 'b'.repeat(16);
  const { secret } = await registerWorker(workerId);
  const w = await fakeWorker(workerId, secret, { version: '3.0.0', label: 'x', claimTokenHash: sha256Hex('t1') });
  w.ws.send(JSON.stringify({ t: 'hello', version: '3.0.0', label: 'x', claimTokenHash: sha256Hex('t2') }));
  w.ws.send(JSON.stringify({ t: 'hello', version: '3.0.0', label: 'x', claimTokenHash: sha256Hex('t3') }));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(w.frames.filter((f) => f.t === 'authz').length, 1);
  // latest hello's claim token is the one that works
  const u = await login('carol@x.com');
  assert.equal((await json('/api/machines/claim', { method: 'POST', token: u.token, body: JSON.stringify({ workerId, claimToken: 't3' }) })).status, 200);
  w.ws.close();
});

test('client aborting a watch sends watch.cancel to the worker', async () => {
  const u = await login('dave@x.com');
  const client = generateClientKey();
  await json('/api/clients', { method: 'POST', token: u.token, body: JSON.stringify({ clientPub: client.pub, label: 'c' }) });
  const workerId = 'w_' + 'c'.repeat(16);
  const { secret } = await registerWorker(workerId);
  const w = await fakeWorker(workerId, secret, { version: '3', label: 'd', claimTokenHash: sha256Hex('ct') });
  assert.equal((await json('/api/machines/claim', { method: 'POST', token: u.token, body: JSON.stringify({ workerId, claimToken: 'ct' }) })).status, 200);
  const watchP = w.next((f) => f.t === 'watch');
  const ac = new AbortController();
  const res = await fetch(`${base}/api/w/${workerId}/watch`, {
    method: 'POST', signal: ac.signal,
    headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${u.token}`, 'x-nopear-client': client.pub },
    body: new Uint8Array([9, 9, 9]),
  });
  assert.equal(res.status, 200);
  const wf = await watchP;
  assert.ok(wf.t === 'watch');
  // stream must stay open (not cancelled merely because the request body was consumed)
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(w.frames.some((f) => f.t === 'watch.cancel'), false);
  const cancelP = w.next((f) => f.t === 'watch.cancel');
  ac.abort();
  const c = await cancelP;
  assert.ok(c.t === 'watch.cancel' && c.id === wf.id);
  w.ws.close();
});

async function claimedWorker(email: string, workerId: string, version = '3.1.0') {
  const u = await login(email);
  const client = generateClientKey();
  await json('/api/clients', { method: 'POST', token: u.token, body: JSON.stringify({ clientPub: client.pub, label: 'c' }) });
  const { secret } = await registerWorker(workerId);
  const w = await fakeWorker(workerId, secret, { version, label: 'd', claimTokenHash: sha256Hex('ct') });
  assert.equal((await json('/api/machines/claim', { method: 'POST', token: u.token, body: JSON.stringify({ workerId, claimToken: 'ct' }) })).status, 200);
  const headers = { 'content-type': 'application/octet-stream', authorization: `Bearer ${u.token}`, 'x-nopear-client': client.pub };
  return { u, client, w, headers };
}

test('client disconnecting mid-RPC drops the pending entry; late rpc.res is ignored', async () => {
  const workerId = 'w_' + 'e'.repeat(16);
  const { w, headers } = await claimedWorker('erin@x.com', workerId);
  const rpcP = w.next((f) => f.t === 'rpc');
  const ac = new AbortController();
  const resP = fetch(`${base}/api/w/${workerId}/rpc`, { method: 'POST', signal: ac.signal, headers, body: new Uint8Array([1, 2, 3]) }).catch((e) => e);
  const rf = await rpcP;
  if (rf.t !== 'rpc') throw new Error('expected rpc frame');
  assert.equal(hubOf(app).pendingRpcCount(workerId), 1);
  ac.abort();
  await resP;
  for (let i = 0; i < 50 && hubOf(app).pendingRpcCount(workerId) > 0; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(hubOf(app).pendingRpcCount(workerId), 0);
  w.ws.send(JSON.stringify({ t: 'rpc.res', id: rf.id, payload: 'AAAA' })); // late — must be ignored without error
  await new Promise((r) => setTimeout(r, 50));
  // server still healthy
  assert.equal((await json('/api/config')).status, 200);
  w.ws.close();
});

test('watch SSE is closed (and watch.cancel sent) when the client stops reading and buffering exceeds the cap', async () => {
  const workerId = 'w_' + 'f'.repeat(16);
  const { w, headers } = await claimedWorker('fred@x.com', workerId);
  const watchP = w.next((f) => f.t === 'watch');
  const res = await fetch(`${base}/api/w/${workerId}/watch`, { method: 'POST', headers, body: new Uint8Array([7]) });
  assert.equal(res.status, 200);
  const wf = await watchP;
  if (wf.t !== 'watch') throw new Error('expected watch frame');
  const cancelP = w.next((f) => f.t === 'watch.cancel');
  const big = 'A'.repeat(1024 * 1024);
  // never read res.body → server-side buffer grows past the 16MB cap
  for (let i = 0; i < 40; i++) w.ws.send(JSON.stringify({ t: 'watch.data', id: wf.id, payload: big }));
  const c = await Promise.race([cancelP, new Promise<null>((r) => setTimeout(() => r(null), 5000))]);
  assert.ok(c && c.t === 'watch.cancel' && c.id === wf.id, 'expected watch.cancel after buffer overflow');
  await res.body?.cancel().catch(() => {});
  w.ws.close();
});

test('events SSE is dropped when the client stops reading and buffering exceeds the cap', async () => {
  // Own app so the test can drive the EventsBus directly.
  const events = new EventsBus();
  const hub = new WorkerHub({ store, signingSeed: signing.seed, onPresence: () => {} });
  const collab = new Collab({ store, hub, events });
  const app2 = Fastify({ logger: false });
  registerRoutes(app2, { config, store, hub, events, collab, signingPub: signingPublicKey(signing.seed) });
  await app2.listen({ port: 0, host: '127.0.0.1' });
  const ac = new AbortController();
  try {
    const a2 = app2.server.address();
    const base2 = `http://127.0.0.1:${typeof a2 === 'object' && a2 ? a2.port : 0}`;
    const u = await login('gina@x.com');
    const res = await fetch(base2 + '/api/events', { headers: { authorization: `Bearer ${u.token}` }, signal: ac.signal });
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 50));
    const big = 'B'.repeat(1024 * 1024);
    // never read res.body → server-side buffer grows past the 16MB cap
    for (let i = 0; i < 40; i++) {
      events.emit(u.user.id, { type: 'machine.updated', machine: { workerId: 'w_x', label: big, workerPub: 'p', online: true, lastSeenAt: null, version: '3' } });
    }
    // the server must destroy the stream (client then reconnects for a fresh snapshot) instead of silently dropping events
    const drained = (async () => {
      const reader = res.body!.getReader();
      try { for (;;) { const { done } = await reader.read(); if (done) return 'ended'; } } catch { return 'ended'; }
    })();
    const r = await Promise.race([drained, new Promise<string>((ok) => setTimeout(() => ok('open'), 5000))]);
    assert.equal(r, 'ended', 'expected the events stream to be closed after buffer overflow');
  } finally {
    ac.abort();
    await app2.close();
  }
});

test('bootstrap token is required and checked when configured', async () => {
  const cfg2: SaasConfigEnv = { ...config, bootstrapToken: 'boot-secret', db: `sqlite:${join(dir, 'saas2.db')}` };
  const store2 = await openStore(cfg2.db);
  const app2 = await buildServer({ config: cfg2, store: store2 });
  try {
    const key = generateClientKey();
    const body = JSON.stringify({ workerId: 'w_' + 'g'.repeat(16), workerPub: key.pub, secretHash: sha256Hex('s') });
    const bad = await app2.inject({ method: 'POST', url: '/worker/register', headers: { 'content-type': 'application/json', authorization: 'Bearer boot-secreX' }, payload: body });
    assert.equal(bad.statusCode, 401);
    const ok = await app2.inject({ method: 'POST', url: '/worker/register', headers: { 'content-type': 'application/json', authorization: 'Bearer boot-secret' }, payload: body });
    assert.equal(ok.statusCode, 200);
  } finally { await app2.close(); await store2.close(); }
});

test('SaaS-layer errors are plaintext {error:{code,message}} (413, unknown /api)', async () => {
  // Declare an oversized body via content-length; Fastify rejects it up front (no 64MB upload needed).
  const { request } = await import('node:http');
  const r413 = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(`${base}/api/w/w_x/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(config.bodyLimitBytes + 10) },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', (e) => { if ((e as NodeJS.ErrnoException).code !== 'EPIPE' && (e as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(e); });
    req.write(Buffer.alloc(16));
  });
  assert.equal(r413.status, 413);
  const b = JSON.parse(r413.body) as { error: { code: string; message: string } };
  assert.equal(b.error.code, 'too_large');
  assert.equal(typeof b.error.message, 'string');
  const bad = await fetch(`${base}/api/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
  assert.equal(bad.status, 400);
  assert.equal(typeof ((await bad.json()) as { error: { code: string } }).error.code, 'string');
  const nf = await fetch(`${base}/api/nope`);
  assert.equal(nf.status, 404);
  assert.equal(((await nf.json()) as { error: { code: string } }).error.code, 'not_found');
});

test('redirect allowlist: nopear:// only in the default', async () => {
  const { loadSaasConfig } = await import('./config');
  const d = mkdtempSync(join(tmpdir(), 'saas-cfg-'));
  assert.deepEqual(loadSaasConfig({ SAAS_DATA_DIR: d } as NodeJS.ProcessEnv).redirectAllowlist, ['nopear://']);
  assert.deepEqual(loadSaasConfig({ SAAS_DATA_DIR: d, SAAS_REDIRECT_ALLOWLIST: 'https://app.example' } as NodeJS.ProcessEnv).redirectAllowlist, ['https://app.example']);
});

test('app.close() resolves promptly while /api/events and a watch SSE are open (no manual teardown)', async () => {
  const cfg3: SaasConfigEnv = { ...config, db: `sqlite:${join(dir, 'saas-close.db')}` };
  const store3 = await openStore(cfg3.db);
  const app3 = await buildServer({ config: cfg3, store: store3 });
  await app3.listen({ port: 0, host: '127.0.0.1' });
  const a3 = app3.server.address();
  const p3 = typeof a3 === 'object' && a3 ? a3.port : 0;
  const b3 = `http://127.0.0.1:${p3}`;
  const post = (path: string, body: unknown, token?: string) => fetch(b3 + path, {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  try {
    const u = (await post('/api/auth/dev', { email: 'close@x.com' })).body as { token: string };
    const client = generateClientKey();
    await post('/api/clients', { clientPub: client.pub, label: 'c' }, u.token);
    const workerId = 'w_' + 'c'.repeat(16);
    const secret = randomId(24);
    assert.equal((await post('/worker/register', { workerId, workerPub: generateClientKey().pub, secretHash: sha256Hex(secret) })).status, 200);
    const ws = new WebSocket(`ws://127.0.0.1:${p3}/worker/connect`, { headers: { authorization: `Bearer ${secret}`, 'x-nopear-worker': workerId } });
    await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
    ws.on('error', () => {});
    ws.send(JSON.stringify({ t: 'hello', version: '3', label: 'c', claimTokenHash: sha256Hex('ct3') }));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await post('/api/machines/claim', { workerId, claimToken: 'ct3' }, u.token)).status, 200);

    const ev = await fetch(b3 + '/api/events', { headers: { authorization: `Bearer ${u.token}` } });
    assert.equal(ev.status, 200);
    const watch = await fetch(`${b3}/api/w/${workerId}/watch`, {
      method: 'POST', body: new Uint8Array([1, 2, 3]),
      headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${u.token}`, 'x-nopear-client': client.pub },
    });
    assert.equal(watch.status, 200);
    await new Promise((r) => setTimeout(r, 50));

    const t0 = Date.now();
    const closed = await Promise.race([
      app3.close().then(() => 'closed'),
      new Promise<string>((ok) => setTimeout(() => ok('hung'), 2000)),
    ]);
    assert.equal(closed, 'closed', 'app.close() must not hang on open SSE streams');
    assert.ok(Date.now() - t0 < 2000);
  } finally {
    await app3.close().catch(() => {});
    await store3.close();
  }
});

test('HTML responses carry anti-framing headers', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const webDir = join(dir, 'web-frame');
  mkdirSync(webDir, { recursive: true });
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>x</title>');
  const cfg4: SaasConfigEnv = { ...config, webDir, db: `sqlite:${join(dir, 'saas-frame.db')}` };
  const store4 = await openStore(cfg4.db);
  const app4 = await buildServer({ config: cfg4, store: store4 });
  try {
    for (const url of ['/', '/s/w_x/abc']) {
      const r = await app4.inject({ method: 'GET', url });
      assert.equal(r.statusCode, 200);
      assert.equal(r.headers['x-frame-options'], 'DENY');
      assert.equal(r.headers['content-security-policy'], "frame-ancestors 'none'");
    }
  } finally { await app4.close(); await store4.close(); }
});

// ---------------------------------------------------------------------------
// v3.1 collaboration hub
// ---------------------------------------------------------------------------

/** Subscribe to /api/events and collect parsed events; `waitFor` resolves on the first matching event. */
async function eventStream(token: string, b = base) {
  const ac = new AbortController();
  const res = await fetch(b + '/api/events', { headers: { authorization: `Bearer ${token}` }, signal: ac.signal });
  assert.equal(res.status, 200);
  const seen: Array<{ type: string; [k: string]: unknown }> = [];
  const waiters: Array<{ pred: (e: { type: string; [k: string]: unknown }) => boolean; resolve: (e: { type: string; [k: string]: unknown }) => void }> = [];
  void (async () => {
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = block.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          const e = JSON.parse(line.slice(6)) as { type: string };
          seen.push(e);
          for (const w of [...waiters]) if (w.pred(e)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(e); }
        }
      }
    } catch { /* aborted */ }
  })();
  return {
    waitFor(pred: (e: { type: string; [k: string]: unknown }) => boolean) {
      const hit = seen.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise<{ type: string; [k: string]: unknown }>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('event not received')), 3000);
        waiters.push({ pred, resolve: (e) => { clearTimeout(t); resolve(e); } });
      });
    },
    close: () => ac.abort(),
  };
}

const indexEntry = (workerId: string, i: number) => ({
  workerId, sessionId: `s${i}`, title: `title ${i}`, preview: `preview ${i}`, status: 'idle', projectId: null, cwd: '/tmp',
  createdAt: new Date(1_700_000_000_000 + i).toISOString(), lastActivityAt: new Date(1_700_000_000_000 + i).toISOString(),
});

test('collab REST: every collab endpoint requires a saasToken', async () => {
  const eps: Array<[string, string]> = [
    ['GET', '/api/settings'], ['PATCH', '/api/settings'],
    ['GET', '/api/projects'], ['POST', '/api/projects'], ['GET', '/api/projects/p1'], ['PATCH', '/api/projects/p1'], ['DELETE', '/api/projects/p1'],
    ['GET', '/api/cards'], ['POST', '/api/cards'], ['PATCH', '/api/cards/c1'], ['DELETE', '/api/cards/c1'],
    ['GET', '/api/memory?scope=global'], ['PUT', '/api/memory'],
    ['GET', '/api/sessions'],
    ['POST', '/api/tokens'], ['GET', '/api/tokens'], ['DELETE', '/api/tokens/t1'],
    ['POST', '/api/machines/install-code'],
    ['POST', '/api/tools/card_list'],
  ];
  for (const [method, path] of eps) {
    const r = await json(path, { method, ...(method === 'GET' || method === 'DELETE' ? {} : { body: '{}' }) });
    assert.equal(r.status, 401, `${method} ${path}`);
    assert.equal(r.body.error.code, 'unauthorized');
  }
});

test('collab REST: envelopes, card rules, dispatch, sessions clamp, deletes', async () => {
  const workerId = 'w_' + 'h'.repeat(16);
  const { u, w } = await claimedWorker('hank@x.com', workerId);
  const token = u.token;
  const ev = await eventStream(token);
  try {
    const settings = await json('/api/settings', { token });
    assert.deepEqual(settings.body, { settings: { e2e: false, autoCompact: { enabled: true, thresholdTokens: 300_000, keepRecentTokens: 20_000 } } });

    // projects
    const forbidden = await json('/api/projects', { method: 'POST', token, body: JSON.stringify({ name: 'X', paths: { w_nobodysmachine: '/x' } }) });
    assert.equal(forbidden.status, 403);
    const pc = await json('/api/projects', { method: 'POST', token, body: JSON.stringify({ name: 'P', paths: { [workerId]: '/src/p' } }) });
    assert.equal(pc.status, 200);
    const project = pc.body.project as { id: string; name: string; paths: Record<string, string> };
    assert.equal(project.name, 'P');
    assert.deepEqual(project.paths, { [workerId]: '/src/p' });
    assert.equal((await json('/api/projects', { token })).body.projects.length, 1);
    assert.equal((await json(`/api/projects/${project.id}`, { token })).body.project.id, project.id);
    const pp = await json(`/api/projects/${project.id}`, { method: 'PATCH', token, body: JSON.stringify({ name: 'P2' }) });
    assert.equal(pp.body.project.name, 'P2');
    assert.equal((await json('/api/projects/nope', { token })).status, 404);

    // memory
    const gm = await json('/api/memory?scope=global', { token });
    assert.equal(gm.status, 200);
    assert.equal(gm.body.memory.content, '');
    const pm = await json(`/api/memory?scope=project&projectId=${project.id}`, { token });
    assert.equal(pm.body.memory.content, '');
    const put = await json('/api/memory', { method: 'PUT', token, body: JSON.stringify({ scope: 'project', projectId: project.id, content: 'hello' }) });
    assert.equal(put.status, 200);
    assert.equal(put.body.memory.content, 'hello');
    assert.equal((await json(`/api/memory?scope=project&projectId=${project.id}`, { token })).body.memory.content, 'hello');

    // cards
    const cc = await json('/api/cards', { method: 'POST', token, body: JSON.stringify({ title: 'a', projectId: project.id }) });
    assert.equal(cc.status, 200);
    const card = cc.body.card as { id: string; state: string };
    assert.equal(card.state, 'inbox');
    await ev.waitFor((e) => e.type === 'card.updated' && (e.card as { id: string }).id === card.id);
    assert.equal((await json('/api/cards?state=inbox', { token })).body.cards.length, 1);
    assert.equal((await json(`/api/cards?projectId=${project.id}`, { token })).body.cards.length, 1);
    const running = await json(`/api/cards/${card.id}`, { method: 'PATCH', token, body: JSON.stringify({ state: 'running' }) });
    assert.equal(running.status, 400);
    assert.equal(running.body.error.code, 'bad_request');
    const foreign = await json(`/api/cards/${card.id}`, { method: 'PATCH', token, body: JSON.stringify({ state: 'queued', workerId: 'w_nobodysmachine' }) });
    assert.equal(foreign.status, 403);
    const cardsP = w.next((f) => f.t === 'cards' && f.cards.some((c) => c.id === card.id));
    const q = await json(`/api/cards/${card.id}`, { method: 'PATCH', token, body: JSON.stringify({ state: 'queued', workerId, order: 3 }) });
    assert.equal(q.status, 200);
    assert.equal(q.body.card.state, 'queued');
    assert.equal(q.body.card.workerId, workerId);
    await cardsP;

    // sessions index: 501 entries, limit clamps to 500
    w.ws.send(JSON.stringify({ t: 'index', full: true, sessions: Array.from({ length: 501 }, (_, i) => indexEntry(workerId, i)), removed: [] }));
    await ev.waitFor((e) => e.type === 'session.indexed');
    const all = await json('/api/sessions?limit=1000', { token });
    assert.equal(all.status, 200);
    assert.equal(all.body.sessions.length, 500);
    assert.equal(all.body.sessions[0].sessionId, 's500');
    assert.equal((await json('/api/sessions', { token })).body.sessions.length, 50);
    const hit = await json('/api/sessions?q=TITLE%2042', { token });
    assert.deepEqual(hit.body.sessions.map((s: { sessionId: string }) => s.sessionId), ['s429', 's428', 's427', 's426', 's425', 's424', 's423', 's422', 's421', 's420', 's42']);

    // deletes
    const removedP = w.next((f) => f.t === 'cards' && !f.cards.some((c) => c.id === card.id));
    assert.deepEqual((await json(`/api/cards/${card.id}`, { method: 'DELETE', token })).body, { ok: true });
    await removedP;
    assert.equal((await json(`/api/cards/${card.id}`, { method: 'DELETE', token })).status, 404);
    assert.deepEqual((await json(`/api/projects/${project.id}`, { method: 'DELETE', token })).body, { ok: true });
    assert.equal((await json(`/api/projects/${project.id}`, { token })).status, 404);
  } finally {
    ev.close();
    w.ws.close();
  }
});

test('/api/tools/:name, settings e2e push, plain data plane', async () => {
  const workerId = 'w_' + 'i'.repeat(16);
  const { u, w, headers } = await claimedWorker('ivy@x.com', workerId);
  const token = u.token;
  const ev = await eventStream(token);
  try {
    const t = await json('/api/tools/card_create', { method: 'POST', token, body: JSON.stringify({ args: { title: 'x' } }) });
    assert.equal(t.status, 200);
    assert.equal(t.body.result.card.title, 'x');
    const bad = await json('/api/tools/card_create', { method: 'POST', token, body: JSON.stringify({ args: {} }) });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'bad_request');

    // plain mode, e2e off → relayed with plain:true, plaintext reply returned verbatim
    const plainBody = new Uint8Array([5, 6, 7, 8]);
    const rpcP = w.next((f) => f.t === 'rpc');
    const resP = fetch(`${base}/api/w/${workerId}/rpc`, { method: 'POST', headers: { ...headers, 'x-nopear-plain': '1' }, body: plainBody });
    const rf = await rpcP;
    if (rf.t !== 'rpc') throw new Error('expected rpc');
    assert.equal(rf.plain, true);
    assert.deepEqual(new Uint8Array(Buffer.from(rf.payload, 'base64url')), plainBody);
    const reply = Buffer.from([42, 43, 44]);
    w.ws.send(JSON.stringify({ t: 'rpc.res', id: rf.id, payload: reply.toString('base64url'), plain: true }));
    const res = await resP;
    assert.equal(res.status, 200);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), reply);
    // encrypted (no header) requests are not marked plain
    const rpc2P = w.next((f) => f.t === 'rpc');
    const res2P = fetch(`${base}/api/w/${workerId}/rpc`, { method: 'POST', headers, body: plainBody });
    const rf2 = await rpc2P;
    if (rf2.t !== 'rpc') throw new Error('expected rpc');
    assert.equal(rf2.plain, undefined);
    w.ws.send(JSON.stringify({ t: 'rpc.res', id: rf2.id, payload: 'AAAA' }));
    assert.equal((await res2P).status, 200);
    // only x-nopear-plain: 1 turns plain mode on
    const rpc3P = w.next((f) => f.t === 'rpc');
    const res3P = fetch(`${base}/api/w/${workerId}/rpc`, { method: 'POST', headers: { ...headers, 'x-nopear-plain': '0' }, body: plainBody });
    const rf3 = await rpc3P;
    if (rf3.t !== 'rpc') throw new Error('expected rpc');
    assert.equal(rf3.plain, undefined);
    w.ws.send(JSON.stringify({ t: 'rpc.res', id: rf3.id, payload: 'AAAA' }));
    assert.equal((await res3P).status, 200);
    // plain watch → watch frame carries plain:true
    const watchP = w.next((f) => f.t === 'watch');
    const wres = await fetch(`${base}/api/w/${workerId}/watch`, { method: 'POST', headers: { ...headers, 'x-nopear-plain': '1' }, body: plainBody });
    assert.equal(wres.status, 200);
    const wf = await watchP;
    assert.ok(wf.t === 'watch' && wf.plain === true);
    await wres.body?.cancel().catch(() => {});

    // e2e on → authz re-pushed with e2e:true, settings.updated emitted, plain requests 409, session tools 409
    const authzP = w.next((f) => f.t === 'authz' && f.e2e === true);
    const s = await json('/api/settings', { method: 'PATCH', token, body: JSON.stringify({ e2e: true }) });
    assert.equal(s.status, 200);
    assert.deepEqual(s.body, { settings: { e2e: true, autoCompact: { enabled: true, thresholdTokens: 300_000, keepRecentTokens: 20_000 } } });
    await authzP;
    await ev.waitFor((e) => e.type === 'settings.updated' && (e.settings as { e2e: boolean }).e2e === true);
    const plainRefused = await fetch(`${base}/api/w/${workerId}/rpc`, { method: 'POST', headers: { ...headers, 'x-nopear-plain': '1' }, body: plainBody });
    assert.equal(plainRefused.status, 409);
    assert.equal(((await plainRefused.json()) as { error: { code: string } }).error.code, 'e2e_enabled');
    const watchRefused = await fetch(`${base}/api/w/${workerId}/watch`, { method: 'POST', headers: { ...headers, 'x-nopear-plain': '1' }, body: plainBody });
    assert.equal(watchRefused.status, 409);
    const hist = await json('/api/tools/session_history', { method: 'POST', token, body: JSON.stringify({ args: { workerId, sessionId: 's1' } }) });
    assert.equal(hist.status, 409);
    assert.equal(hist.body.error.code, 'e2e_enabled');
    assert.equal((await json('/api/settings', { method: 'PATCH', token, body: JSON.stringify({ e2e: 'yes' }) })).status, 400);

    // e2e off + worker offline → 503 machine_offline
    assert.equal((await json('/api/settings', { method: 'PATCH', token, body: JSON.stringify({ e2e: false }) })).status, 200);
    w.ws.close();
    for (let i = 0; i < 50 && hubOf(app).isOnline(workerId); i++) await new Promise((r) => setTimeout(r, 20));
    const off = await json('/api/tools/session_history', { method: 'POST', token, body: JSON.stringify({ args: { workerId, sessionId: 's1' } }) });
    assert.equal(off.status, 503);
    assert.equal(off.body.error.code, 'machine_offline');
  } finally {
    ev.close();
    w.ws.close();
  }
});

test('pre-3.1 worker: plaintext relays refused with the plaintext-disabled 400 (client falls back to sealed); session tools e2e_enabled', async () => {
  const workerId = 'w_' + 't'.repeat(16);
  const { u, w, headers } = await claimedWorker('olga@x.com', workerId, '3.0.0');
  try {
    const body = new Uint8Array([1, 2, 3]);
    const plainHeaders = { ...headers, 'x-nopear-plain': '1' };
    const r = await fetch(`${base}/api/w/${workerId}/rpc`, { method: 'POST', headers: plainHeaders, body });
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: { code: 'bad_request', message: PLAINTEXT_DISABLED_MESSAGE } });
    const wr = await fetch(`${base}/api/w/${workerId}/watch`, { method: 'POST', headers: plainHeaders, body });
    assert.equal(wr.status, 400);
    assert.deepEqual(await wr.json(), { error: { code: 'bad_request', message: PLAINTEXT_DISABLED_MESSAGE } });
    assert.equal(w.frames.some((f) => f.t === 'rpc' || f.t === 'watch'), false, 'nothing relayed to the old worker');
    const hist = await json('/api/tools/session_history', { method: 'POST', token: u.token, body: JSON.stringify({ args: { workerId, sessionId: 's1' } }) });
    assert.equal(hist.status, 409);
    assert.equal(hist.body.error.code, 'e2e_enabled');
    // sealed requests still relay
    const rpcP = w.next((f) => f.t === 'rpc');
    const sealedP = fetch(`${base}/api/w/${workerId}/rpc`, { method: 'POST', headers, body });
    const rf = await rpcP;
    if (rf.t !== 'rpc') throw new Error('expected rpc');
    assert.equal(rf.plain, undefined);
    w.ws.send(JSON.stringify({ t: 'rpc.res', id: rf.id, payload: 'AAAA' }));
    assert.equal((await sealedP).status, 200);
    // unknown / empty version counts as old
    w.ws.send(JSON.stringify({ t: 'hello', version: '', label: 'd' }));
    for (let i = 0; i < 50 && (await store.workers.get(workerId))?.version !== ''; i++) await new Promise((res) => setTimeout(res, 20));
    assert.equal((await fetch(`${base}/api/w/${workerId}/rpc`, { method: 'POST', headers: plainHeaders, body })).status, 400);
    // upgraded worker (hello 3.1.0) → plaintext relayed again
    w.ws.send(JSON.stringify({ t: 'hello', version: '3.1.0', label: 'd' }));
    for (let i = 0; i < 50 && (await store.workers.get(workerId))?.version !== '3.1.0'; i++) await new Promise((res) => setTimeout(res, 20));
    const rpc2P = w.next((f) => f.t === 'rpc');
    const plainP = fetch(`${base}/api/w/${workerId}/rpc`, { method: 'POST', headers: plainHeaders, body });
    const rf2 = await rpc2P;
    if (rf2.t !== 'rpc') throw new Error('expected rpc');
    assert.equal(rf2.plain, true);
    w.ws.send(JSON.stringify({ t: 'rpc.res', id: rf2.id, payload: 'AAAA', plain: true }));
    assert.equal((await plainP).status, 200);
  } finally {
    w.ws.close();
  }
});

test('offline machine with a stale pre-3.1 version: plaintext request → 503 offline (not the sticky plaintext-disabled 400)', async () => {
  const workerId = 'w_' + 'v'.repeat(16);
  const { w, headers } = await claimedWorker('vera-stale@x.com', workerId, '3.0.0');
  w.ws.close();
  for (let i = 0; i < 50 && hubOf(app).isOnline(workerId); i++) await new Promise((res) => setTimeout(res, 20));
  assert.equal(hubOf(app).isOnline(workerId), false);
  assert.equal((await store.workers.get(workerId))?.version, '3.0.0');
  const body = new Uint8Array([1, 2, 3]);
  const plainHeaders = { ...headers, 'x-nopear-plain': '1' };
  for (const path of ['rpc', 'watch']) {
    const r = await fetch(`${base}/api/w/${workerId}/${path}`, { method: 'POST', headers: plainHeaders, body });
    assert.equal(r.status, 503, path);
    assert.equal(((await r.json()) as { error: { code: string } }).error.code, 'offline', path);
  }
});

test('two-user isolation: B cannot read or change A\'s projects, cards, memory, sessions, tokens or machines', async () => {
  const workerId = 'w_' + 'u'.repeat(16);
  const { u: a, w } = await claimedWorker('iso-a@x.com', workerId);
  const b = await login('iso-b@x.com');
  try {
    const project = (await json('/api/projects', { method: 'POST', token: a.token, body: JSON.stringify({ name: 'A-proj', paths: { [workerId]: '/a' } }) })).body.project;
    const card = (await json('/api/cards', { method: 'POST', token: a.token, body: JSON.stringify({ title: 'A-card', projectId: project.id }) })).body.card;
    assert.equal((await json('/api/memory', { method: 'PUT', token: a.token, body: JSON.stringify({ scope: 'project', projectId: project.id, content: 'A-secret' }) })).status, 200);
    assert.equal((await json('/api/memory', { method: 'PUT', token: a.token, body: JSON.stringify({ scope: 'global', content: 'A-global' }) })).status, 200);
    assert.equal((await json('/api/tokens', { method: 'POST', token: a.token, body: JSON.stringify({ label: 'a' }) })).status, 200);
    const tokenId = (await json('/api/tokens', { token: a.token })).body.tokens[0].id as string;
    w.ws.send(JSON.stringify({ t: 'index', full: true, sessions: [indexEntry(workerId, 1)], removed: [] }));
    for (let i = 0; i < 50 && (await json('/api/sessions', { token: a.token })).body.sessions.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal((await json('/api/sessions', { token: a.token })).body.sessions.length, 1);

    const expect = async (path: string, init: RequestInit, status: number) => {
      const r = await json(path, { ...init, token: b.token });
      assert.equal(r.status, status, `${init.method ?? 'GET'} ${path} → ${JSON.stringify(r.body)}`);
    };
    // projects
    await expect(`/api/projects/${project.id}`, {}, 404);
    await expect(`/api/projects/${project.id}`, { method: 'PATCH', body: JSON.stringify({ name: 'pwned' }) }, 404);
    await expect(`/api/projects/${project.id}`, { method: 'DELETE' }, 404);
    assert.deepEqual((await json('/api/projects', { token: b.token })).body.projects, []);
    // cards
    await expect(`/api/cards/${card.id}`, { method: 'PATCH', body: JSON.stringify({ title: 'pwned' }) }, 404);
    await expect(`/api/cards/${card.id}`, { method: 'DELETE' }, 404);
    assert.deepEqual((await json('/api/cards', { token: b.token })).body.cards, []);
    // memory
    await expect(`/api/memory?scope=project&projectId=${project.id}`, {}, 404);
    await expect('/api/memory', { method: 'PUT', body: JSON.stringify({ scope: 'project', projectId: project.id, content: 'pwned' }) }, 404);
    assert.equal((await json('/api/memory?scope=global', { token: b.token })).body.memory.content, '');
    // sessions index
    assert.deepEqual((await json('/api/sessions', { token: b.token })).body.sessions, []);
    assert.deepEqual((await json(`/api/sessions?workerId=${workerId}`, { token: b.token })).body.sessions, []);
    // API tokens
    await expect(`/api/tokens/${tokenId}`, { method: 'DELETE' }, 404);
    assert.deepEqual((await json('/api/tokens', { token: b.token })).body.tokens, []);
    // machines / session-class tools
    await expect(`/api/machines/${workerId}`, { method: 'PATCH', body: JSON.stringify({ label: 'pwned' }) }, 403);
    await expect('/api/tools/session_history', { method: 'POST', body: JSON.stringify({ args: { workerId, sessionId: 's1' } }) }, 403);
    await expect('/api/tools/session_start', { method: 'POST', body: JSON.stringify({ args: { workerId, prompt: 'x' } }) }, 403);
    const bCard = (await json('/api/cards', { method: 'POST', token: b.token, body: JSON.stringify({ title: 'B' }) })).body.card;
    await expect(`/api/cards/${bCard.id}`, { method: 'PATCH', body: JSON.stringify({ state: 'queued', workerId }) }, 403);

    // A's data is untouched
    assert.equal((await json(`/api/projects/${project.id}`, { token: a.token })).body.project.name, 'A-proj');
    assert.equal((await json('/api/cards', { token: a.token })).body.cards[0].title, 'A-card');
    assert.equal((await json(`/api/memory?scope=project&projectId=${project.id}`, { token: a.token })).body.memory.content, 'A-secret');
    assert.equal((await json('/api/memory?scope=global', { token: a.token })).body.memory.content, 'A-global');
    assert.equal((await json('/api/tokens', { token: a.token })).body.tokens.length, 1);
  } finally {
    w.ws.close();
  }
});

test('API tokens: created once, listed without secret, only valid for /mcp, deletable', async () => {
  const u = await login('jack@x.com');
  const created = await json('/api/tokens', { method: 'POST', token: u.token, body: JSON.stringify({ label: 'claude' }) });
  assert.equal(created.status, 200);
  const apiToken = created.body.token as string;
  assert.equal(typeof apiToken, 'string');
  assert.ok(apiToken.length > 20);
  const list = await json('/api/tokens', { token: u.token });
  assert.equal(list.body.tokens.length, 1);
  const info = list.body.tokens[0] as Record<string, unknown>;
  assert.deepEqual(Object.keys(info).sort(), ['createdAt', 'id', 'label', 'lastUsedAt']);
  assert.equal(info.label, 'claude');
  assert.equal(info.lastUsedAt, null);
  assert.ok(!JSON.stringify(list.body).includes(apiToken));
  // API token cannot access /api/*
  assert.equal((await json('/api/projects', { token: apiToken })).status, 401);
  assert.equal((await json('/api/me', { token: apiToken })).status, 401);

  // MCP: raw JSON-RPC initialize + tools/list
  const mcpHeaders = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const mcp = (tok: string, body: unknown) => fetch(base + '/mcp', { method: 'POST', headers: { ...mcpHeaders, authorization: `Bearer ${tok}` }, body: JSON.stringify(body) });
  const init = await mcp(apiToken, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '1' } },
  });
  assert.equal(init.status, 200);
  assert.equal(((await init.json()) as { result: { serverInfo: { name: string } } }).result.serverInfo.name, 'nopear');
  const tl = await mcp(apiToken, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  assert.equal(tl.status, 200);
  assert.equal(((await tl.json()) as { result: { tools: unknown[] } }).result.tools.length, 15);
  const call = await mcp(apiToken, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'card_create', arguments: { title: 'from mcp' } } });
  const callBody = (await call.json()) as { result: { content: Array<{ text: string }> } };
  assert.equal(JSON.parse(callBody.result.content[0]!.text).card.title, 'from mcp');
  assert.equal((await json('/api/cards', { token: u.token })).body.cards[0].title, 'from mcp');
  assert.notEqual((await json('/api/tokens', { token: u.token })).body.tokens[0].lastUsedAt, null);
  // a saasToken is not an API token
  assert.equal((await mcp(u.token, { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} })).status, 401);

  assert.deepEqual((await json(`/api/tokens/${info.id as string}`, { method: 'DELETE', token: u.token })).body, { ok: true });
  assert.equal((await json(`/api/tokens/${info.id as string}`, { method: 'DELETE', token: u.token })).status, 404);
  assert.equal((await json('/api/tokens', { token: u.token })).body.tokens.length, 0);
  assert.equal((await mcp(apiToken, { jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} })).status, 401);
});

test('install code: command uses request origin; register auto-claims (single use, expiry, idempotent retry)', async () => {
  const u = await login('kate@x.com');
  const ev = await eventStream(u.token);
  try {
    const ic = await json('/api/machines/install-code', { method: 'POST', token: u.token, body: JSON.stringify({ label: 'wsl' }) });
    assert.equal(ic.status, 200);
    const { code, command, expiresAt } = ic.body as { code: string; command: string; expiresAt: string };
    assert.equal(typeof code, 'string');
    assert.equal(command, `curl -fsSL '${base}/install.sh?code=${code}' | bash`);
    const ttl = Date.parse(expiresAt) - Date.now();
    assert.ok(ttl > 29 * 60 * 1000 && ttl <= 30 * 60 * 1000, `ttl ${ttl}`);

    const reg = (workerId: string, key: string, secretHash: string, installCode: string) =>
      json('/worker/register', { method: 'POST', body: JSON.stringify({ workerId, workerPub: key, secretHash, installCode }) });
    const workerId = 'w_' + 'k'.repeat(16);
    const key = generateClientKey().pub;
    const secretHash = sha256Hex(randomId(24));
    const r = await reg(workerId, key, secretHash, code);
    assert.equal(r.status, 200);
    assert.equal(r.body.platformPub, signing.pub);
    const machines = (await json('/api/machines', { token: u.token })).body.machines as Array<{ workerId: string; label: string }>;
    assert.deepEqual(machines.map((m) => [m.workerId, m.label]), [[workerId, 'wsl']]);
    await ev.waitFor((e) => e.type === 'machine.updated' && (e.machine as { workerId: string }).workerId === workerId);
    // same workerId + identity retries → idempotent 200
    assert.equal((await reg(workerId, key, secretHash, code)).status, 200);
    // reuse by another worker → 400, not registered
    const other = 'w_' + 'l'.repeat(16);
    const reuse = await reg(other, generateClientKey().pub, sha256Hex('x'), code);
    assert.equal(reuse.status, 400);
    assert.equal(await store.workers.get(other), null);
    // expired → 400
    const expired = randomId(18);
    await store.installCodes.create(u.user.id, sha256Hex(expired), null, Date.now() - 1000);
    assert.equal((await reg(other, generateClientKey().pub, sha256Hex('x'), expired)).status, 400);
    assert.equal(await store.workers.get(other), null);
    // unknown code → 400
    assert.equal((await reg(other, generateClientKey().pub, sha256Hex('x'), 'nope')).status, 400);
    // install.sh reachable through buildServer (no web dir here)
    const sh = await fetch(`${base}/install.sh?code=nope`);
    assert.equal(sh.status, 200);
    assert.match(await sh.text(), /exit 1/);
  } finally {
    ev.close();
  }
});

test('install code with SAAS_PUBLIC_URL + bootstrap token; install routes not swallowed by the SPA fallback', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const webDir = join(dir, 'web-install');
  mkdirSync(webDir, { recursive: true });
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>spa</title>');
  const cfg5: SaasConfigEnv = {
    ...config, webDir, bootstrapToken: 'boot-secret', publicUrl: 'https://nopear.example', publicUrlExplicit: true,
    db: `sqlite:${join(dir, 'saas-install.db')}`,
  };
  const store5 = await openStore(cfg5.db);
  const app5 = await buildServer({ config: cfg5, store: store5 });
  try {
    const inj = async (method: 'GET' | 'POST', url: string, body?: unknown, token?: string) => {
      const r = await app5.inject({
        method, url,
        headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
      });
      return { status: r.statusCode, body: r.body ? (() => { try { return JSON.parse(r.body); } catch { return r.body; } })() : null, raw: r };
    };
    const u = (await inj('POST', '/api/auth/dev', { email: 'liz@x.com' })).body as { token: string; user: { id: string } };
    const ic = await inj('POST', '/api/machines/install-code', {}, u.token);
    assert.equal(ic.status, 200);
    const code = ic.body.code as string;
    assert.equal(ic.body.command, `curl -fsSL 'https://nopear.example/install.sh?code=${code}' | bash`);

    // install.sh with a valid code embeds it; the tarball downloads
    const sh = await inj('GET', `/install.sh?code=${code}`);
    assert.equal(sh.status, 200);
    assert.match(String(sh.body), /^#!\/usr\/bin\/env bash/);
    assert.ok(String(sh.body).includes(code));
    assert.ok(!String(sh.body).includes('<title>spa</title>'));
    const tgz = await inj('GET', '/install/worker.tgz');
    assert.equal(tgz.status, 200);
    assert.match(String(tgz.raw.headers['content-type']), /gzip/);
    assert.ok(tgz.raw.rawPayload.length > 0);

    // invalid code, no bearer → 400 (not registered)
    const wid = 'w_' + 'm'.repeat(16);
    const key = generateClientKey().pub;
    const bad = await inj('POST', '/worker/register', { workerId: wid, workerPub: key, secretHash: sha256Hex('s'), installCode: 'nope' });
    assert.equal(bad.status, 400);
    assert.equal(await store5.workers.get(wid), null);
    // no code, no bearer → 401
    assert.equal((await inj('POST', '/worker/register', { workerId: wid, workerPub: key, secretHash: sha256Hex('s') })).status, 401);
    // valid code replaces the bootstrap token
    const ok = await inj('POST', '/worker/register', { workerId: wid, workerPub: key, secretHash: sha256Hex('s'), installCode: code });
    assert.equal(ok.status, 200);
    assert.equal((await store5.workers.get(wid))?.userId, u.user.id);
  } finally { await app5.close(); await store5.close(); }
});

test('unclaiming a machine returns its cards to the inbox and drops its index entries', async () => {
  const workerId = 'w_' + 'n'.repeat(16);
  const { u, w } = await claimedWorker('nina@x.com', workerId);
  const token = u.token;
  try {
    const project = (await json('/api/projects', { method: 'POST', token, body: JSON.stringify({ name: 'NP', paths: { [workerId]: '/src/np' } }) })).body.project as { id: string };
    const card = (await json('/api/cards', { method: 'POST', token, body: JSON.stringify({ title: 'q' }) })).body.card as { id: string };
    assert.equal((await json(`/api/cards/${card.id}`, { method: 'PATCH', token, body: JSON.stringify({ state: 'queued', workerId }) })).status, 200);
    await w.next((f) => f.t === 'cards' && f.cards.some((c) => c.id === card.id));
    for (let i = w.frames.length - 1; i >= 0; i--) if (w.frames[i]!.t === 'cards') w.frames.splice(i, 1);
    const ev = await eventStream(token);
    w.ws.send(JSON.stringify({ t: 'index', full: true, sessions: [indexEntry(workerId, 1), indexEntry(workerId, 2)], removed: [] }));
    await ev.waitFor((e) => e.type === 'session.indexed');
    ev.close();
    assert.equal((await json(`/api/sessions?workerId=${workerId}`, { token })).body.sessions.length, 2);

    const emptyCardsP = w.next((f) => f.t === 'cards' && f.cards.length === 0);
    assert.equal((await json(`/api/machines/${workerId}`, { method: 'DELETE', token })).status, 200);
    // the (online) worker is told its card set is now empty
    await emptyCardsP;
    // its path is dropped from the project
    assert.deepEqual((await json(`/api/projects/${project.id}`, { token })).body.project.paths, {});
    const after = (await json(`/api/cards?state=inbox`, { token })).body.cards as Array<{ id: string; workerId: string | null; state: string }>;
    const moved = after.find((c) => c.id === card.id);
    assert.ok(moved);
    assert.equal(moved.state, 'inbox');
    assert.equal(moved.workerId, null);
    assert.equal((await json('/api/sessions', { token })).body.sessions.length, 0);
  } finally {
    w.ws.close();
  }
});

test('unclaim: machine.removed is emitted even when the collab cascade throws', async () => {
  const events = new EventsBus();
  const hub = new WorkerHub({ store, signingSeed: signing.seed, onPresence: () => {} });
  const collab = new Collab({ store, hub, events });
  collab.onMachineRemoved = async () => { throw new Error('cascade boom'); };
  const app2 = Fastify({ logger: false });
  registerRoutes(app2, { config, store, hub, events, collab, signingPub: signingPublicKey(signing.seed) });
  try {
    const u = await login('olga@x.com');
    const workerId = 'w_' + 'o'.repeat(16);
    assert.equal(await store.workers.register(workerId, generateClientKey().pub, sha256Hex('s')), 'ok');
    await store.workers.claimDirect(workerId, u.user.id, null);
    const seen: string[] = [];
    const unsub = events.subscribe(u.user.id, (e) => { if (e.type === 'machine.removed') seen.push(e.workerId); });
    const r = await app2.inject({ method: 'DELETE', url: `/api/machines/${workerId}`, headers: { authorization: `Bearer ${u.token}` } });
    unsub();
    assert.equal(r.statusCode, 200);
    assert.deepEqual(seen, [workerId]);
    assert.equal((await store.workers.get(workerId))?.userId, null);
  } finally {
    await app2.close();
  }
});

/** Store whose every method yields (setTimeout) before running, so concurrent requests interleave between store calls. */
function slowStore(s: typeof store): typeof store {
  return new Proxy(s, {
    get(target, key) {
      const group = (target as unknown as Record<string | symbol, unknown>)[key];
      if (typeof group === 'function') return (group as (...a: unknown[]) => unknown).bind(target);
      if (typeof group !== 'object' || group === null) return group;
      return new Proxy(group as Record<string | symbol, unknown>, {
        get(g, k) {
          const f = g[k];
          if (typeof f !== 'function') return f;
          return async (...a: unknown[]) => {
            await new Promise((r) => setTimeout(r, 5));
            return (f as (...x: unknown[]) => unknown).apply(g, a);
          };
        },
      });
    },
  });
}

test('install code: two workers racing on one code → exactly one claims, the loser gets 400 and is not registered', async () => {
  const events = new EventsBus();
  const slow = slowStore(store);
  const hub = new WorkerHub({ store: slow, signingSeed: signing.seed, onPresence: () => {} });
  const collab = new Collab({ store: slow, hub, events });
  const app2 = Fastify({ logger: false });
  registerRoutes(app2, { config: { ...config, bootstrapToken: 'boot-secret' }, store: slow, hub, events, collab, signingPub: signingPublicKey(signing.seed) });
  try {
    const u = await login('pete@x.com');
    const code = randomId(18);
    await store.installCodes.create(u.user.id, sha256Hex(code), 'race', Date.now() + 60_000);
    const ids = ['w_' + 'p'.repeat(16), 'w_' + 'q'.repeat(16)];
    const rs = await Promise.all(ids.map((workerId) => app2.inject({
      method: 'POST', url: '/worker/register', headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ workerId, workerPub: generateClientKey().pub, secretHash: sha256Hex(workerId), installCode: code }),
    })));
    assert.deepEqual(rs.map((r) => r.statusCode).sort(), [200, 400]);
    const winner = ids[rs.findIndex((r) => r.statusCode === 200)]!;
    const loser = ids[rs.findIndex((r) => r.statusCode === 400)]!;
    assert.equal((await store.workers.get(winner))?.userId, u.user.id);
    assert.equal(await store.workers.get(loser), null, 'loser must not be registered (it skipped the bootstrap token)');
    assert.equal((await store.installCodes.get(sha256Hex(code)))?.usedBy, winner);
  } finally {
    await app2.close();
  }
});

test('install code register: identity conflict → 409; machine owned elsewhere → 409 without consuming the code', async () => {
  const u = await login('quinn@x.com');
  const other = await login('rita@x.com');
  const reg = (workerId: string, workerPub: string, secretHash: string, installCode: string) =>
    json('/worker/register', { method: 'POST', body: JSON.stringify({ workerId, workerPub, secretHash, installCode }) });
  // owned elsewhere
  const owned = 'w_' + 'r'.repeat(16);
  const key = generateClientKey().pub;
  assert.equal(await store.workers.register(owned, key, sha256Hex('r')), 'ok');
  await store.workers.claimDirect(owned, other.user.id, null);
  const code = (await json('/api/machines/install-code', { method: 'POST', token: u.token, body: '{}' })).body.code as string;
  const r1 = await reg(owned, key, sha256Hex('r'), code);
  assert.equal(r1.status, 409);
  assert.equal((await store.workers.get(owned))?.userId, other.user.id);
  assert.equal((await store.installCodes.get(sha256Hex(code)))?.usedBy, null);
  // identity conflict
  const r2 = await reg(owned, generateClientKey().pub, sha256Hex('r'), code);
  assert.equal(r2.status, 409);
  assert.equal((await store.installCodes.get(sha256Hex(code)))?.usedBy, null);
  // non-string install code → 400
  assert.equal((await json('/worker/register', { method: 'POST', body: JSON.stringify({ workerId: owned, workerPub: key, secretHash: sha256Hex('r'), installCode: 5 }) })).status, 400);
});

test('install code command shell-quotes the request origin', async () => {
  const u = await login('sam@x.com');
  const ic = await json('/api/machines/install-code', { method: 'POST', token: u.token, body: '{}', headers: { 'x-forwarded-host': "evil'$(id)" } });
  assert.equal(ic.status, 200);
  const code = ic.body.code as string;
  assert.equal(ic.body.command, `curl -fsSL 'http://evil'\\''$(id)/install.sh?code=${code}' | bash`);
});

test('collab REST: repeated query keys and non-string ids are 400, not 500', async () => {
  const u = await login('tina@x.com');
  const token = u.token;
  const project = (await json('/api/projects', { method: 'POST', token, body: JSON.stringify({ name: 'T' }) })).body.project as { id: string };
  const card = (await json('/api/cards', { method: 'POST', token, body: JSON.stringify({ title: 't', projectId: project.id }) })).body.card as { id: string };
  for (const path of [
    '/api/cards?projectId=a&projectId=b', '/api/cards?workerId=a&workerId=b', '/api/cards?state=inbox&state=done',
    '/api/sessions?workerId=a&workerId=b', '/api/sessions?projectId=a&projectId=b', '/api/sessions?q=a&q=b', '/api/sessions?limit=1&limit=2',
    '/api/memory?scope=global&scope=project', `/api/memory?scope=project&projectId=${project.id}&projectId=x`,
  ]) {
    const r = await json(path, { token });
    assert.equal(r.status, 400, path);
    assert.equal(r.body.error.code, 'bad_request', path);
  }
  const bad: Array<[string, string, unknown]> = [
    ['POST', '/api/cards', { title: 'x', projectId: 5 }],
    ['POST', '/api/cards', { title: 'x', projectId: '' }],
    ['POST', '/api/cards', { title: 'x', projectId: ['a'] }],
    ['PATCH', `/api/cards/${card.id}`, { projectId: '' }],
    ['PATCH', `/api/cards/${card.id}`, { projectId: 7 }],
    ['PATCH', `/api/cards/${card.id}`, { projectId: { a: 1 } }],
    ['PATCH', `/api/cards/${card.id}`, { state: 'queued', workerId: 5 }],
    ['PATCH', `/api/cards/${card.id}`, { state: 'queued', workerId: ['w_a'] }],
  ];
  for (const [method, path, body] of bad) {
    const r = await json(path, { method, token, body: JSON.stringify(body) });
    assert.equal(r.status, 400, `${method} ${path} ${JSON.stringify(body)}`);
    assert.equal(r.body.error.code, 'bad_request');
  }
  // the card is untouched; projectId:null still clears the project
  assert.equal((await json(`/api/cards?projectId=${project.id}`, { token })).body.cards.length, 1);
  const cleared = await json(`/api/cards/${card.id}`, { method: 'PATCH', token, body: JSON.stringify({ projectId: null }) });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.card.projectId, null);
});

test('worker self-update: build + latest on the machine, POST update sends the frame, progress relayed, guards', async () => {
  const workerId = 'w_' + 'upd'.repeat(5) + 'x';
  const { u, w } = await claimedWorker('upd@x.com', workerId, '3.2.0');
  const hub = hubOf(app);
  // the server builds worker.tgz in the background: let that finish first so it cannot overwrite latestBuild mid-test
  for (let i = 0; i < 600 && !hub.latestBuild; i++) await new Promise((r) => setTimeout(r, 50));
  const prevLatest = hub.latestBuild;
  hub.setLatestBuild('newbuild0001');
  const machine = async () => ((await json('/api/machines', { token: u.token })).body as { machines: Machine[] }).machines.find((m) => m.workerId === workerId)!;
  try {
    // no self-update capability yet (hello had no build) → 409
    assert.deepEqual((await machine()).update, { self: false, latest: 'newbuild0001' });
    assert.equal((await json(`/api/machines/${workerId}/update`, { method: 'POST', token: u.token, body: '{}' })).status, 409);
    w.ws.send(JSON.stringify({ t: 'hello', version: '3.2.0', label: 'd', build: 'oldbuild0001', selfUpdate: true }));
    for (let i = 0; i < 50 && (await machine()).update?.build !== 'oldbuild0001'; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual((await machine()).update, { self: true, build: 'oldbuild0001', latest: 'newbuild0001' });
    // another account cannot trigger it
    const other = await login('other-upd@x.com');
    assert.equal((await json(`/api/machines/${workerId}/update`, { method: 'POST', token: other.token, body: '{}' })).status, 403);
    const frameP = w.next((f) => f.t === 'update');
    const r = await json(`/api/machines/${workerId}/update`, { method: 'POST', token: u.token, body: '{}' });
    assert.equal(r.status, 200);
    assert.equal((r.body as { machine: Machine }).machine.update?.state, 'downloading');
    await frameP;
    // a second click while it runs: no second frame
    assert.equal((await json(`/api/machines/${workerId}/update`, { method: 'POST', token: u.token, body: '{}' })).status, 200);
    await new Promise((res) => setTimeout(res, 50));
    assert.ok(!w.frames.some((f) => f.t === 'update'));
    w.ws.send(JSON.stringify({ t: 'update.state', state: 'waiting', message: '等 2 个会话空闲后重启' }));
    for (let i = 0; i < 50 && (await machine()).update?.state !== 'waiting'; i++) await new Promise((r2) => setTimeout(r2, 20));
    assert.equal((await machine()).update?.message, '等 2 个会话空闲后重启');
    w.ws.send(JSON.stringify({ t: 'update.state', state: 'bogus' }));
    await new Promise((res) => setTimeout(res, 50));
    assert.equal((await machine()).update?.state, 'waiting');
  } finally {
    if (prevLatest) hub.setLatestBuild(prevLatest); else hub.latestBuild = null;
    w.ws.close();
  }
  for (let i = 0; i < 50 && (await machine()).online; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal((await machine()).update, undefined); // offline: nothing known
  assert.equal((await json(`/api/machines/${workerId}/update`, { method: 'POST', token: u.token, body: '{}' })).status, 409);
});
