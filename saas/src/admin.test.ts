// Admin console: access requests, disabling accounts (everywhere at once), overview / users / machines, force unbind.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { generateClientKey, generateSigningKey, randomId, sha256Hex } from '@nopear/core/crypto';
import type { AdminMachine, AdminOverview, AdminUser } from '@nopear/protocol';
import type { SaasConfigEnv } from './config';
import { buildServer } from './server';
import { openStore, type SaasStore } from './store';

const dir = mkdtempSync(join(tmpdir(), 'saas-admin-'));
const tgz = join(dir, 'worker.tgz');
writeFileSync(tgz, 'not-a-real-tgz');
const baseConfig: SaasConfigEnv = {
  port: 0, publicUrl: 'http://localhost', publicUrlExplicit: false, dataDir: dir, db: '',
  signingSeed: generateSigningKey().seed, sessionSecret: 'test-secret', googleClientId: null, googleClientSecret: null,
  devLogin: true, bootstrapToken: null, redirectAllowlist: ['nopear://'], bodyLimitBytes: 64 * 1024 * 1024,
  webDir: join(dir, 'no-web'), bootstrapAdmin: 'boss@x.com', workerTgz: tgz,
};

interface Srv { app: FastifyInstance; store: SaasStore; base: string; port: number }
const servers: Srv[] = [];
after(async () => { for (const s of servers) { await s.app.close(); await s.store.close(); } });

async function server(over: Partial<SaasConfigEnv> = {}): Promise<Srv> {
  const config: SaasConfigEnv = { ...baseConfig, db: `sqlite:${join(dir, `${randomId(8)}.db`)}`, ...over };
  const store = await openStore(config.db);
  const app = await buildServer({ config, store });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const s = { app, store, base: `http://127.0.0.1:${port}`, port };
  servers.push(s);
  return s;
}

function client(base: string) {
  const json = async (path: string, init: RequestInit & { token?: string } = {}) => {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    if (init.body && !headers['content-type']) headers['content-type'] = 'application/json';
    const res = await fetch(base + path, { ...init, headers });
    const text = await res.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: res.status, body };
  };
  const tryLogin = (email: string) => json('/api/auth/dev', { method: 'POST', body: JSON.stringify({ email }) });
  const login = async (email: string) => {
    const r = await tryLogin(email);
    assert.equal(r.status, 200, `login ${email}: ${JSON.stringify(r.body)}`);
    return r.body as { token: string; user: { id: string; email: string } };
  };
  return { json, tryLogin, login };
}

/** Register a worker through an install code minted by `token`'s account → claimed by that account. */
async function claimedWorker(s: Srv, token: string) {
  const c = client(s.base);
  const code = (await c.json('/api/machines/install-code', { method: 'POST', token, body: JSON.stringify({ label: 'box' }) })).body.code as string;
  const workerId = wid();
  const secret = randomId(24);
  const r = await c.json('/worker/register', {
    method: 'POST', body: JSON.stringify({ workerId, workerPub: generateClientKey().pub, secretHash: sha256Hex(secret), installCode: code }),
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { workerId, secret };
}
function connect(s: Srv, workerId: string, secret: string): Promise<{ ws?: WebSocket; status?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/worker/connect`, { headers: { authorization: `Bearer ${secret}`, 'x-nopear-worker': workerId } });
    ws.once('open', () => resolve({ ws }));
    ws.once('unexpected-response', (_q, res) => { resolve({ status: res.statusCode }); ws.terminate(); });
    ws.once('error', () => { /* unexpected-response handles rejections */ });
  });
}
const wid = () => `w_${randomId(16).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
const until = async (pred: () => boolean | Promise<boolean>, ms = 3000) => {
  const t0 = Date.now();
  while (!(await pred())) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 20)); }
};

test('admin console is admin-only (members 403) and needs the allowlist (open mode 403)', async () => {
  const s = await server();
  const c = client(s.base);
  const boss = await c.login('boss@x.com');
  await c.json('/api/admin/allowlist/mem%40x.com', { method: 'PUT', token: boss.token, body: JSON.stringify({ role: 'member' }) });
  const mem = await c.login('mem@x.com');
  for (const path of ['/api/admin/overview', '/api/admin/users', '/api/admin/requests', '/api/admin/machines']) {
    assert.equal((await c.json(path, { token: boss.token })).status, 200, path);
    assert.equal((await c.json(path, { token: mem.token })).status, 403, path);
    assert.equal((await c.json(path)).status, 401, path);
  }
  const open = await server({ bootstrapAdmin: null });
  const oc = client(open.base);
  const anyone = await oc.login('anyone@x.com');
  assert.equal((await oc.json('/api/admin/overview', { token: anyone.token })).status, 403);
});

test('sign-in outside the allowlist files a request; reject sticks; approve admits', async () => {
  const s = await server();
  const c = client(s.base);
  const boss = await c.login('boss@x.com');
  let r = await c.tryLogin('New.Person@X.com');
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'access_pending');
  await c.tryLogin('new.person@x.com');
  let reqs = (await c.json('/api/admin/requests', { token: boss.token })).body.requests;
  assert.deepEqual(reqs.map((x: any) => [x.email, x.status, x.attempts]), [['new.person@x.com', 'pending', 2]]);
  assert.equal(((await c.json('/api/admin/overview', { token: boss.token })).body as AdminOverview).pendingRequests, 1);

  // reject: further attempts stay rejected (no new pending), the response is a plain refusal
  assert.equal((await c.json('/api/admin/requests/new.person%40x.com/reject', { method: 'POST', token: boss.token })).status, 200);
  r = await c.tryLogin('new.person@x.com');
  assert.equal(r.body.error.code, 'forbidden');
  reqs = (await c.json('/api/admin/requests', { token: boss.token })).body.requests;
  assert.deepEqual(reqs.map((x: any) => [x.status, x.attempts]), [['rejected', 3]]);

  // approve (a rejected request can still be approved): allowlisted as member, request gone, login works
  const a = await c.json('/api/admin/requests/new.person%40x.com/approve', { method: 'POST', token: boss.token, body: '{}' });
  assert.equal(a.status, 200);
  assert.deepEqual([a.body.entry.email, a.body.entry.role], ['new.person@x.com', 'member']);
  assert.deepEqual((await c.json('/api/admin/requests', { token: boss.token })).body.requests, []);
  await c.login('new.person@x.com');
  assert.equal((await c.json('/api/admin/requests/nobody%40x.com/approve', { method: 'POST', token: boss.token, body: '{}' })).status, 404);
});

test('disabling an account takes effect everywhere at once; re-enabling restores it', async () => {
  const s = await server();
  const c = client(s.base);
  const boss = await c.login('boss@x.com');
  await c.json('/api/admin/allowlist/mem%40x.com', { method: 'PUT', token: boss.token, body: JSON.stringify({ role: 'member' }) });
  const mem = await c.login('mem@x.com');
  const apiToken = (await c.json('/api/tokens', { method: 'POST', token: mem.token, body: JSON.stringify({ label: 'mcp' }) })).body.token as string;
  const { workerId, secret } = await claimedWorker(s, mem.token);
  const live = await connect(s, workerId, secret);
  assert.ok(live.ws, 'worker connects before the disable');
  const closed = new Promise<void>((r) => live.ws!.once('close', () => r()));
  const mcp = () => c.json('/mcp', { method: 'POST', token: apiToken, headers: { accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
  assert.equal((await mcp()).status, 200);

  // guards: not yourself, not an admin
  assert.equal((await c.json(`/api/admin/users/${boss.user.id}`, { method: 'PATCH', token: boss.token, body: JSON.stringify({ disabled: true }) })).status, 400);
  await c.json('/api/admin/allowlist/mem%40x.com', { method: 'PUT', token: boss.token, body: JSON.stringify({ role: 'admin' }) });
  assert.equal((await c.json(`/api/admin/users/${mem.user.id}`, { method: 'PATCH', token: boss.token, body: JSON.stringify({ disabled: true }) })).status, 409);
  await c.json('/api/admin/allowlist/mem%40x.com', { method: 'PUT', token: boss.token, body: JSON.stringify({ role: 'member' }) });

  const d = await c.json(`/api/admin/users/${mem.user.id}`, { method: 'PATCH', token: boss.token, body: JSON.stringify({ disabled: true }) });
  assert.equal(d.status, 200);
  assert.equal(d.body.user.disabled, true);
  assert.equal((await c.json('/api/me', { token: mem.token })).status, 401, 'session token dead');
  assert.equal((await c.tryLogin('mem@x.com')).status, 403, 'cannot sign in again');
  assert.equal((await mcp()).status, 401, 'API token refused');
  await closed; // live tunnel dropped
  assert.equal((await connect(s, workerId, secret)).status, 403, 'machine cannot reconnect');
  const users = (await c.json('/api/admin/users', { token: boss.token })).body.users as AdminUser[];
  assert.equal(users.find((x) => x.id === mem.user.id)!.disabled, true);

  await c.json(`/api/admin/users/${mem.user.id}`, { method: 'PATCH', token: boss.token, body: JSON.stringify({ disabled: false }) });
  const again = await c.login('mem@x.com');
  assert.equal((await c.json('/api/me', { token: again.token })).status, 200);
  assert.equal((await mcp()).status, 200, 'API token works again');
  const back = await connect(s, workerId, secret);
  assert.ok(back.ws);
  back.ws!.close();
});

test('overview, users and machines; force-unbind a claimed machine, delete an unclaimed one', async () => {
  const s = await server();
  const c = client(s.base);
  const boss = await c.login('boss@x.com');
  await c.json('/api/admin/allowlist/mem%40x.com', { method: 'PUT', token: boss.token, body: JSON.stringify({ role: 'member' }) });
  const mem = await c.login('mem@x.com');
  const { workerId, secret } = await claimedWorker(s, mem.token);
  const live = await connect(s, workerId, secret);
  await until(async () => ((await c.json('/api/admin/machines', { token: boss.token })).body.machines as AdminMachine[]).some((m) => m.online));
  // an unclaimed record (registered, never claimed)
  const stray = wid();
  await c.json('/worker/register', { method: 'POST', body: JSON.stringify({ workerId: stray, workerPub: generateClientKey().pub, secretHash: sha256Hex('x') }) });

  const ov = (await c.json('/api/admin/overview', { token: boss.token })).body as AdminOverview;
  assert.deepEqual([ov.users, ov.allowlist, ov.machines, ov.machinesOnline, ov.disabledUsers], [2, 2, 1, 1, 0]);
  assert.equal(ov.signups.length, 30);
  assert.equal(ov.signups.at(-1)!.count, 2, 'both accounts signed up today');

  const users = (await c.json('/api/admin/users', { token: boss.token })).body.users as AdminUser[];
  const m = users.find((x) => x.email === 'mem@x.com')!;
  assert.deepEqual([m.role, m.machines, m.machinesOnline, m.disabled], ['member', 1, 1, false]);
  assert.equal(users.find((x) => x.email === 'boss@x.com')!.role, 'admin');

  const machines = (await c.json('/api/admin/machines', { token: boss.token })).body.machines as AdminMachine[];
  assert.deepEqual(machines.map((x) => [x.workerId === workerId ? 'claimed' : 'stray', x.ownerEmail]).sort(),
    [['claimed', 'mem@x.com'], ['stray', null]]);

  // force unbind: the owner loses it; the record stays (unclaimed)
  assert.deepEqual((await c.json(`/api/admin/machines/${workerId}`, { method: 'DELETE', token: boss.token })).body, { ok: true, deleted: false });
  assert.deepEqual((await c.json('/api/machines', { token: mem.token })).body.machines, []);
  // unclaimed: the record is deleted
  assert.deepEqual((await c.json(`/api/admin/machines/${stray}`, { method: 'DELETE', token: boss.token })).body, { ok: true, deleted: true });
  const left = (await c.json('/api/admin/machines', { token: boss.token })).body.machines as AdminMachine[];
  assert.deepEqual(left.map((x) => [x.workerId, x.ownerId]), [[workerId, null]]);
  live.ws?.close();
});
