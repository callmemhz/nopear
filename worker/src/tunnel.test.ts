import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  b64url, deriveKey, encodeFrame, generateClientKey, generateSigningKey, randomId, seal, sha256Hex, signAuthz,
} from '@nopear/core/crypto';
import { Gateway as RealGateway, type OpHandlers, type WatchHandlers } from './gateway';
import { loadConfig } from './config';
import { loadOrCreateIdentity, saveIdentity } from './identity';
import { PlatformKeyMismatchError, RegisterRejectedError, TunnelClient } from './tunnel';
import type { Gateway } from './gateway';

const waitFor = async (cond: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

test('tunnel: register once, auth headers, hello claim hash, rpc relay, reconnect', async () => {
  const platform = generateSigningKey();
  let registers = 0;
  const conns: { req: IncomingMessage; ws: WebSocket; frames: any[] }[] = [];
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/worker/register') {
      registers++;
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        const j = JSON.parse(b);
        assert.ok(j.workerId && j.workerPub && j.secretHash);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ platformPub: platform.pub }));
      });
      return;
    }
    res.statusCode = 404; res.end();
  });
  const wss = new WebSocketServer({ server, path: '/worker/connect' });
  wss.on('connection', (ws, req) => {
    const c = { req, ws, frames: [] as any[] };
    conns.push(c);
    ws.on('message', (d) => c.frames.push(JSON.parse(String(d))));
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  const home = mkdtempSync(join(tmpdir(), 'nopear-tun-'));
  const config = loadConfig({ NOPEAR_SAAS_URL: `http://127.0.0.1:${port}`, NOPEAR_HOME: home });
  const identity = loadOrCreateIdentity(home);
  const gateway = {
    setAuthz() {},
    handleRpc: async (_c: string, p: string) => ({ payload: 'echo:' + p }),
    handleWatch: () => ({ cancel() {} }),
  } as unknown as Gateway;
  const links: string[] = [];
  const tc = new TunnelClient({ config, identity, gateway, onClaimLink: (u: string) => links.push(u), reconnectBaseMs: 50 });
  await tc.start();
  try {
    await waitFor(() => conns.length === 1 && conns[0]!.frames.some((f) => f.t === 'hello'));
    assert.equal(registers, 1);
    assert.equal(loadOrCreateIdentity(home).platformPub, platform.pub);
    const c = conns[0]!;
    assert.equal(c.req.headers.authorization, `Bearer ${identity.secret}`);
    assert.equal(c.req.headers['x-nopear-worker'], identity.workerId);
    const hello = c.frames.find((f) => f.t === 'hello');
    // first hello carries no claim token; no claim link before the server reports unclaimed
    assert.equal(hello.claimTokenHash, undefined);
    assert.equal(links.length, 0);
    c.ws.send(JSON.stringify({ t: 'authz', claimed: false, clients: [] }));
    await waitFor(() => links.length === 1);
    await waitFor(() => c.frames.filter((f) => f.t === 'hello').length === 2);
    const u = new URL(links[0]!);
    assert.equal(u.pathname, '/claim');
    assert.equal(u.searchParams.get('w'), identity.workerId);
    const hello2 = c.frames.filter((f) => f.t === 'hello')[1];
    assert.equal(hello2.claimTokenHash, sha256Hex(u.searchParams.get('t')!));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(links.length, 1, 'exactly one claim link per authz{claimed:false}');
    c.ws.send(JSON.stringify({ t: 'rpc', id: 'r1', clientPub: 'cp', payload: 'P' }));
    await waitFor(() => c.frames.some((f) => f.t === 'rpc.res'));
    assert.deepEqual(c.frames.find((f) => f.t === 'rpc.res'), { t: 'rpc.res', id: 'r1', payload: 'echo:P' });
    c.ws.close();
    await waitFor(() => conns.length === 2 && conns[1]!.frames.some((f) => f.t === 'hello'));
    assert.equal(registers, 1);
  } finally {
    await tc.stop();
    wss.close();
    server.close();
  }
});

test('tunnel: TTL rotation re-mints while unclaimed; claimed stops rotation', async () => {
  const platform = generateSigningKey();
  const conns: { ws: WebSocket; frames: any[] }[] = [];
  const server = createServer((_req, res) => { res.statusCode = 404; res.end(); });
  const wss = new WebSocketServer({ server, path: '/worker/connect' });
  wss.on('connection', (ws) => {
    const c = { ws, frames: [] as any[] };
    conns.push(c);
    ws.on('message', (d) => c.frames.push(JSON.parse(String(d))));
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  const home = mkdtempSync(join(tmpdir(), 'nopear-tun-'));
  const config = loadConfig({ NOPEAR_SAAS_URL: `http://127.0.0.1:${port}`, NOPEAR_HOME: home });
  const identity = loadOrCreateIdentity(home);
  identity.platformPub = platform.pub;
  const gateway = { setAuthz() {}, handleRpc: async () => ({ payload: '' }), handleWatch: () => ({ cancel() {} }) } as unknown as Gateway;
  const links: string[] = [];
  const tc = new TunnelClient({ config, identity, gateway, onClaimLink: (u: string) => links.push(u), claimTtlMs: 80 });
  await tc.start();
  try {
    await waitFor(() => conns.length === 1 && conns[0]!.frames.some((f) => f.t === 'hello'));
    const c = conns[0]!;
    c.ws.send(JSON.stringify({ t: 'authz', claimed: false, clients: [] }));
    // onClaimLink fires before the hello frame reaches the server → wait on server-received claim hellos.
    const claimHellos = () => c.frames.filter((f) => f.t === 'hello' && f.claimTokenHash);
    await waitFor(() => claimHellos().length >= 3);
    const hashes = claimHellos().map((f) => f.claimTokenHash as string);
    assert.equal(new Set(hashes).size, hashes.length, 'each rotation mints a new token');
    assert.ok(links.length >= hashes.length);
    hashes.forEach((h, i) => {
      assert.equal(h, sha256Hex(new URL(links[i]!).searchParams.get('t')!), `hello ${i} hash matches link ${i} token`);
    });
    c.ws.send(JSON.stringify({ t: 'authz', claimed: true, userId: 'u1', clients: [] }));
    await new Promise((r) => setTimeout(r, 50));
    const n = links.length;
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(links.length, n, 'no rotation after claimed');
  } finally {
    await tc.stop();
    wss.close();
    server.close();
  }
});

test('F5 tunnel: revoked client watch → watch.end{code:unauthorized} sent to SaaS', async () => {
  const platform = generateSigningKey();
  const conns: { ws: WebSocket; frames: any[] }[] = [];
  const server = createServer((_req, res) => { res.statusCode = 404; res.end(); });
  const wss = new WebSocketServer({ server, path: '/worker/connect' });
  wss.on('connection', (ws) => {
    const c = { ws, frames: [] as any[] };
    conns.push(c);
    ws.on('message', (d) => c.frames.push(JSON.parse(String(d))));
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  const home = mkdtempSync(join(tmpdir(), 'nopear-tun-'));
  const config = loadConfig({ NOPEAR_SAAS_URL: `http://127.0.0.1:${port}`, NOPEAR_HOME: home });
  const identity = loadOrCreateIdentity(home);
  identity.platformPub = platform.pub;
  const watches = {
    'machine.watch': async (_a: unknown, _e: unknown, signal: AbortSignal) => {
      await new Promise<void>((r) => signal.addEventListener('abort', () => r()));
    },
  } as unknown as WatchHandlers;
  const gateway = new RealGateway({ identity, ops: {} as OpHandlers, watches });
  const client = generateClientKey();
  const tc = new TunnelClient({ config, identity, gateway, onClaimLink: () => {} });
  await tc.start();
  try {
    await waitFor(() => conns.length === 1 && conns[0]!.frames.some((f) => f.t === 'hello'));
    const c = conns[0]!;
    c.ws.send(JSON.stringify({ t: 'authz', claimed: true, userId: 'u1',
      clients: [{ clientPub: client.pub, label: 'c', sig: signAuthz(platform.seed, 'u1', client.pub) }] }));
    await new Promise((r) => setTimeout(r, 30));
    const key = deriveKey(client.priv, identity.pub, identity.workerId, client.pub);
    const payload = b64url(seal(key, encodeFrame({ v: 3, rid: randomId(), ts: Date.now(), op: 'machine.watch', args: {} })));
    c.ws.send(JSON.stringify({ t: 'watch', id: 'w1', clientPub: client.pub, payload }));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(c.frames.some((f) => f.t === 'watch.end'), false);
    c.ws.send(JSON.stringify({ t: 'authz', claimed: true, userId: 'u1', clients: [] }));
    await waitFor(() => c.frames.some((f) => f.t === 'watch.end'));
    assert.deepEqual(c.frames.filter((f) => f.t === 'watch.end'), [{ t: 'watch.end', id: 'w1', code: 'unauthorized' }]);
  } finally {
    await tc.stop();
    wss.close();
    server.close();
  }
});

test('F27 tunnel: handshake 401 is logged (status, no secret) and backoff keeps retrying', async () => {
  let attempts = 0;
  const server = createServer((_req, res) => { attempts++; res.statusCode = 401; res.end('nope'); });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  const home = mkdtempSync(join(tmpdir(), 'nopear-tun-'));
  const config = loadConfig({ NOPEAR_SAAS_URL: `http://127.0.0.1:${port}`, NOPEAR_HOME: home });
  const identity = loadOrCreateIdentity(home);
  identity.platformPub = generateSigningKey().pub;
  const logs: string[] = [];
  const gateway = { setAuthz() {} } as unknown as Gateway;
  const tc = new TunnelClient({ config, identity, gateway, onClaimLink: () => {}, reconnectBaseMs: 20, log: (m: string) => logs.push(m) });
  await tc.start();
  try {
    await waitFor(() => attempts >= 2 && logs.length >= 2);
    assert.ok(logs.some((l) => l.includes('401')), `logged status: ${logs.join(' | ')}`);
    assert.ok(logs.every((l) => !l.includes(identity.secret)), 'never logs the worker secret');
  } finally {
    await tc.stop();
    server.close();
  }
});

test('tunnel: register retries with backoff on 503 then proceeds (F3)', async () => {
  const platform = generateSigningKey();
  let registers = 0;
  let connected = 0;
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/worker/register') {
      registers++;
      req.resume();
      if (registers <= 2) { res.statusCode = 503; res.end(); return; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ platformPub: platform.pub }));
      return;
    }
    res.statusCode = 404; res.end();
  });
  const wss = new WebSocketServer({ server, path: '/worker/connect' });
  wss.on('connection', () => { connected++; });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  const home = mkdtempSync(join(tmpdir(), 'nopear-tun-'));
  const config = loadConfig({ NOPEAR_SAAS_URL: `http://127.0.0.1:${port}`, NOPEAR_HOME: home });
  const identity = loadOrCreateIdentity(home);
  const gateway = { setAuthz() {}, handleRpc: async () => ({ payload: '' }), handleWatch: () => ({ cancel() {} }) } as unknown as Gateway;
  const logs: string[] = [];
  const tc = new TunnelClient({ config, identity, gateway, onClaimLink: () => {}, log: (m: string) => logs.push(m), registerBackoffMs: [10, 20, 40] });
  try {
    await tc.start();
    await waitFor(() => connected === 1);
    assert.equal(registers, 3);
    assert.equal(identity.platformPub, platform.pub);
    assert.ok(logs.some((l) => l.includes('503')));
    assert.ok(!logs.some((l) => l.includes(identity.secret)));
  } finally {
    await tc.stop();
    wss.close();
    server.close();
  }
});

test('tunnel: register fails fast on permanent 4xx (401/409), keeps retrying 408/429', async () => {
  const run = async (statuses: number[]) => {
    const platform = generateSigningKey();
    let registers = 0;
    const server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/worker/register') {
        const st = statuses[registers++];
        req.resume();
        if (st !== undefined) { res.statusCode = st; res.end(); return; }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ platformPub: platform.pub }));
        return;
      }
      res.statusCode = 404; res.end();
    });
    const wss = new WebSocketServer({ server, path: '/worker/connect' });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const home = mkdtempSync(join(tmpdir(), 'nopear-tun-'));
    const config = loadConfig({ NOPEAR_SAAS_URL: `http://127.0.0.1:${port}`, NOPEAR_HOME: home });
    const identity = loadOrCreateIdentity(home);
    const gateway = { setAuthz() {}, handleRpc: async () => ({ payload: '' }), handleWatch: () => ({ cancel() {} }) } as unknown as Gateway;
    const tc = new TunnelClient({ config, identity, gateway, onClaimLink: () => {}, log: () => {}, registerBackoffMs: [10] });
    try {
      const err = await tc.start().then(() => null, (e: unknown) => e as Error);
      return { err, registers, platformPub: identity.platformPub };
    } finally {
      await tc.stop();
      wss.close();
      server.close();
    }
  };
  for (const st of [401, 403, 409]) {
    const r = await run([st, st, st]);
    assert.ok(r.err, `HTTP ${st} must reject start()`);
    assert.match(r.err!.message, new RegExp(String(st)));
    assert.equal(r.registers, 1, `HTTP ${st} must not be retried`);
    assert.ok(!r.platformPub);
  }
  const ok = await run([408, 429]);
  assert.equal(ok.err, null);
  assert.equal(ok.registers, 3);
});

/** SaaS stub whose /worker/connect rejects the first `rejectFirst` upgrades with 401 (unknown worker). */
async function rerigServer(opts: { rejectFirst: number; registerStatus?: number; platformPub: string }) {
  let registers = 0;
  let upgrades = 0;
  let connected = 0;
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/worker/register') {
      registers++;
      req.resume();
      if (opts.registerStatus) { res.statusCode = opts.registerStatus; res.end(); return; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ platformPub: opts.platformPub }));
      return;
    }
    res.statusCode = 404; res.end();
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (upgrades++ < opts.rejectFirst) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, () => { connected++; });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    stats: () => ({ registers, upgrades, connected }),
    close: () => { for (const c of wss.clients) c.terminate(); wss.close(); server.close(); },
  };
}

test('F1 tunnel: handshake 401 → one re-register returning the SAME platform key → keeps pin, reconnects', async () => {
  const platform = generateSigningKey();
  const srv = await rerigServer({ rejectFirst: 1, platformPub: platform.pub });
  const home = mkdtempSync(join(tmpdir(), 'nopear-tun-'));
  const config = loadConfig({ NOPEAR_SAAS_URL: srv.url, NOPEAR_HOME: home });
  const identity = loadOrCreateIdentity(home, srv.url);
  identity.platformPub = platform.pub;
  const logs: string[] = [];
  const fatal: Error[] = [];
  const gateway = { setAuthz() {}, handleRpc: async () => ({ payload: '' }), handleWatch: () => ({ cancel() {} }) } as unknown as Gateway;
  const tc = new TunnelClient({ config, identity, gateway, onClaimLink: () => {}, reconnectBaseMs: 20, log: (m: string) => logs.push(m),
    onFatal: (e: Error) => fatal.push(e) });
  await tc.start();
  try {
    await waitFor(() => srv.stats().connected === 1);
    assert.equal(srv.stats().registers, 1);
    assert.equal(identity.platformPub, platform.pub);
    assert.equal(fatal.length, 0);
    assert.ok(logs.some((l) => l.includes('not registered with this SaaS') && l.includes('identity.json')), logs.join(' | '));
    assert.ok(logs.every((l) => !l.includes(identity.secret)));
  } finally {
    await tc.stop();
    srv.close();
  }
});

test('F1 tunnel: handshake 401 → re-register returning a DIFFERENT platform key → pin unchanged, fatal, no reconnect loop', async () => {
  const pinned = generateSigningKey();
  const rogue = generateSigningKey();
  const srv = await rerigServer({ rejectFirst: 1, platformPub: rogue.pub });
  const home = mkdtempSync(join(tmpdir(), 'nopear-tun-'));
  const config = loadConfig({ NOPEAR_SAAS_URL: srv.url, NOPEAR_HOME: home });
  const identity = loadOrCreateIdentity(home, srv.url);
  identity.platformPub = pinned.pub;
  saveIdentity(home, identity);
  const logs: string[] = [];
  const fatal: Error[] = [];
  const gateway = { setAuthz() {} } as unknown as Gateway;
  const tc = new TunnelClient({ config, identity, gateway, onClaimLink: () => {}, reconnectBaseMs: 20, log: (m: string) => logs.push(m),
    onFatal: (e: Error) => fatal.push(e) });
  await tc.start();
  try {
    await waitFor(() => fatal.length === 1);
    assert.match(fatal[0]!.message, /platform key mismatch/);
    assert.ok(fatal[0]!.message.includes(join(home, 'identity.json')), fatal[0]!.message);
    assert.equal(identity.platformPub, pinned.pub, 'in-memory pin untouched');
    assert.equal(loadOrCreateIdentity(home, srv.url).platformPub, pinned.pub, 'persisted pin untouched');
    const before = srv.stats().upgrades;
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(srv.stats().upgrades, before, 'stopped reconnecting after fatal');
    assert.equal(srv.stats().connected, 0);
    assert.equal(srv.stats().registers, 1);
    assert.ok(logs.some((l) => l.includes('platform key mismatch')), logs.join(' | '));
  } finally {
    await tc.stop();
    srv.close();
  }
});

test('F4 tunnel: re-register after handshake 401 answered 409 → fatal (onFatal), no more reconnects', async () => {
  const srv = await rerigServer({ rejectFirst: 1000, registerStatus: 409, platformPub: 'x' });
  const home = mkdtempSync(join(tmpdir(), 'nopear-tun-'));
  const config = loadConfig({ NOPEAR_SAAS_URL: srv.url, NOPEAR_HOME: home });
  const identity = loadOrCreateIdentity(home);
  identity.platformPub = 'stale-pin';
  const fatal: Error[] = [];
  const gateway = { setAuthz() {} } as unknown as Gateway;
  const tc = new TunnelClient({ config, identity, gateway, onClaimLink: () => {}, reconnectBaseMs: 20, log: () => {},
    onFatal: (e: Error) => fatal.push(e) });
  await tc.start();
  try {
    await waitFor(() => fatal.length === 1);
    assert.match(fatal[0]!.message, /409/);
    const before = srv.stats().upgrades;
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(srv.stats().upgrades, before, 'stopped reconnecting after fatal');
    assert.equal(srv.stats().registers, 1);
  } finally {
    await tc.stop();
    srv.close();
  }
});

test('F1 tunnel: identity recorded for a different SaaS → pin dropped, re-registers and pins the new SaaS key', async () => {
  const platform = generateSigningKey();
  const srv = await rerigServer({ rejectFirst: 0, platformPub: platform.pub });
  const home = mkdtempSync(join(tmpdir(), 'nopear-tun-'));
  const old = loadOrCreateIdentity(home, 'https://old.example', () => {});
  saveIdentity(home, { ...old, platformPub: generateSigningKey().pub });
  const logs: string[] = [];
  const identity = loadOrCreateIdentity(home, srv.url, (m) => logs.push(m));
  assert.equal(identity.platformPub, null, 'pin dropped');
  assert.ok(logs.some((l) => l.includes('https://old.example') && l.includes(srv.url)), logs.join(' | '));
  const config = loadConfig({ NOPEAR_SAAS_URL: srv.url, NOPEAR_HOME: home });
  const gateway = { setAuthz() {}, handleRpc: async () => ({ payload: '' }), handleWatch: () => ({ cancel() {} }) } as unknown as Gateway;
  const tc = new TunnelClient({ config, identity, gateway, onClaimLink: () => {}, log: () => {} });
  await tc.start();
  try {
    await waitFor(() => srv.stats().connected === 1);
    assert.equal(srv.stats().registers, 1);
    const persisted = loadOrCreateIdentity(home, srv.url);
    assert.equal(persisted.platformPub, platform.pub);
    assert.equal(persisted.saasUrl, srv.url);
  } finally {
    await tc.stop();
    srv.close();
  }
});

// ---- v3.1 collaboration link (CollabLink) ----

type Conn = { ws: WebSocket; frames: any[] };
/** Fake SaaS: /worker/connect records frames per connection; /worker/register answers `register(body)`. */
async function collabHarness(opts: {
  register?: (body: any) => { status: number; body?: unknown };
  tunnel?: Partial<ConstructorParameters<typeof TunnelClient>[0]>;
  gateway?: Partial<Gateway>;
  pinned?: boolean;
  env?: Record<string, string>;
} = {}) {
  const platform = generateSigningKey();
  const conns: Conn[] = [];
  const registers: any[] = [];
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/worker/register') {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        const body = JSON.parse(b);
        registers.push(body);
        const r = opts.register?.(body) ?? { status: 200, body: { platformPub: platform.pub } };
        res.statusCode = r.status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(r.body ?? {}));
      });
      return;
    }
    res.statusCode = 404; res.end();
  });
  const wss = new WebSocketServer({ server, path: '/worker/connect' });
  wss.on('connection', (ws) => {
    const c = { ws, frames: [] as any[] };
    conns.push(c);
    ws.on('message', (d) => c.frames.push(JSON.parse(String(d))));
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  const home = mkdtempSync(join(tmpdir(), 'nopear-tun-'));
  const config = loadConfig({ NOPEAR_SAAS_URL: `http://127.0.0.1:${port}`, NOPEAR_HOME: home, ...opts.env });
  config.envFile = join(home, '.env');
  const identity = loadOrCreateIdentity(home);
  if (opts.pinned !== false) identity.platformPub = platform.pub;
  const gateway = {
    setAuthz() {},
    handleRpc: async () => ({ payload: '' }),
    handleWatch: () => ({ cancel() {} }),
    ...opts.gateway,
  } as unknown as Gateway;
  const tc = new TunnelClient({ config, identity, gateway, onClaimLink: () => {}, log: () => {}, reconnectBaseMs: 20, ...opts.tunnel });
  return {
    tc, conns, registers, config, identity,
    close: async () => { await tc.stop(); for (const c of wss.clients) c.terminate(); wss.close(); server.close(); },
  };
}
const helloed = (conns: Conn[], n = 1) => () => conns.length >= n && conns[n - 1]!.frames.some((f) => f.t === 'hello');

test('collab: callTool sends t:tool with sessionId and resolves on tool.res; error tool.res → {ok:false,error}', async () => {
  const h = await collabHarness();
  await h.tc.start();
  try {
    await waitFor(helloed(h.conns));
    assert.equal(h.tc.workerId, h.identity.workerId);
    assert.equal(h.tc.connected(), true);
    const c = h.conns[0]!;
    const p1 = h.tc.callTool('card_list', { projectId: 'p_1' }, 's1');
    await waitFor(() => c.frames.some((f) => f.t === 'tool'));
    const t1 = c.frames.find((f) => f.t === 'tool');
    assert.equal(typeof t1.id, 'string');
    assert.deepEqual(t1, { t: 'tool', id: t1.id, name: 'card_list', args: { projectId: 'p_1' }, sessionId: 's1' });
    c.ws.send(JSON.stringify({ t: 'tool.res', id: t1.id, result: [{ id: 'c_1' }] }));
    assert.deepEqual(await p1, { ok: true, result: [{ id: 'c_1' }] });

    const p2 = h.tc.callTool('project_list', {});
    await waitFor(() => c.frames.filter((f) => f.t === 'tool').length === 2);
    const t2 = c.frames.filter((f) => f.t === 'tool')[1];
    assert.equal('sessionId' in t2, false, 'no sessionId when not given');
    assert.notEqual(t2.id, t1.id);
    c.ws.send(JSON.stringify({ t: 'tool.res', id: t2.id, error: { code: 'not_found', message: 'nope' } }));
    assert.deepEqual(await p2, { ok: false, error: { code: 'not_found', message: 'nope' } });
  } finally {
    await h.close();
  }
});

test('collab: callTool not connected → saas_unreachable immediately; close while pending → saas_unreachable; no reply → timeout', async () => {
  const h = await collabHarness({ tunnel: { toolTimeoutMs: 80, reconnectBaseMs: 5000 } });
  try {
    assert.equal(h.tc.connected(), false);
    const r0 = await h.tc.callTool('project_list', {});
    assert.equal(r0.ok, false);
    assert.equal((r0 as any).error.code, 'saas_unreachable');
    await h.tc.start();
    await waitFor(helloed(h.conns));
    const c = h.conns[0]!;
    const t0 = Date.now();
    const timedOut = await h.tc.callTool('project_list', {});
    assert.equal((timedOut as any).error.code, 'timeout');
    assert.ok(Date.now() - t0 >= 70);
    const pending = h.tc.callTool('project_list', {});
    await waitFor(() => c.frames.filter((f) => f.t === 'tool').length === 2);
    c.ws.close();
    const r = await pending;
    assert.equal(r.ok, false);
    assert.equal((r as any).error.code, 'saas_unreachable');
    await waitFor(() => !h.tc.connected());
  } finally {
    await h.close();
  }
});

test('collab: cards and projects.changed frames reach listeners; onConnected fires after each open', async () => {
  const h = await collabHarness();
  const cards: any[][] = [];
  let changed = 0;
  const connectedAt: number[] = [];
  h.tc.onCards((cs) => cards.push(cs));
  const offChanged = h.tc.onProjectsChanged(() => changed++);
  h.tc.onConnected(() => connectedAt.push(h.conns.length));
  await h.tc.start();
  try {
    await waitFor(helloed(h.conns));
    await waitFor(() => connectedAt.length === 1);
    const c = h.conns[0]!;
    const card = { id: 'c_1', title: 't', body: '', projectId: null, state: 'queued', workerId: h.identity.workerId,
      sessionId: null, order: 1, error: null, createdAt: 'x', updatedAt: 'x' };
    c.ws.send(JSON.stringify({ t: 'cards', cards: [card] }));
    c.ws.send(JSON.stringify({ t: 'projects.changed' }));
    await waitFor(() => cards.length === 1 && changed === 1);
    assert.deepEqual(cards[0], [card]);
    offChanged();
    c.ws.send(JSON.stringify({ t: 'projects.changed' }));
    c.ws.close();
    await waitFor(helloed(h.conns, 2));
    await waitFor(() => connectedAt.length === 2);
    assert.equal(changed, 1, 'unsubscribed listener no longer fires');
  } finally {
    await h.close();
  }
});

test('collab: onConnected fires right after hello is sent', async () => {
  const h = await collabHarness();
  h.tc.onConnected(() => h.tc.sendIndex({ full: true, sessions: [], removed: [] }));
  await h.tc.start();
  try {
    await waitFor(() => h.conns.length === 1 && h.conns[0]!.frames.length >= 2);
    assert.deepEqual(h.conns[0]!.frames.slice(0, 2).map((f) => f.t), ['hello', 'index']);
  } finally {
    await h.close();
  }
});

test('collab: onClaimChanged fires only when authz claimed/userId actually changes (first authz is the baseline)', async () => {
  const h = await collabHarness();
  const seen: { claimed: boolean; userId?: string }[] = [];
  const off = h.tc.onClaimChanged((s) => seen.push(s));
  await h.tc.start();
  try {
    await waitFor(helloed(h.conns));
    const c = h.conns[0]!;
    const authz = (claimed: boolean, userId?: string) =>
      c.ws.send(JSON.stringify({ t: 'authz', claimed, ...(userId ? { userId } : {}), clients: [], e2e: true }));
    const hellos = () => c.frames.filter((f) => f.t === 'hello').length;
    authz(false);
    await waitFor(() => hellos() === 2); // unclaimed → re-hello with a claim hash
    authz(true, 'u1'); // claimed by QR after connecting
    await waitFor(() => seen.length === 1);
    assert.deepEqual(seen, [{ claimed: true, userId: 'u1' }]);
    authz(true, 'u1'); // client list refresh: no change
    authz(true, 'u2'); // re-claimed by another account
    await waitFor(() => seen.length === 2);
    assert.deepEqual(seen[1], { claimed: true, userId: 'u2' });
    authz(false); // unbind
    await waitFor(() => seen.length === 3);
    assert.deepEqual(seen[2], { claimed: false });
    // Reconnect: the same state again is not a change.
    c.ws.close();
    await waitFor(helloed(h.conns, 2));
    const c2 = h.conns[1]!;
    c2.ws.send(JSON.stringify({ t: 'authz', claimed: false, clients: [], e2e: true }));
    await waitFor(() => c2.frames.filter((f) => f.t === 'hello').length === 2);
    off();
    c2.ws.send(JSON.stringify({ t: 'authz', claimed: true, userId: 'u3', clients: [], e2e: true }));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(seen.length, 3, 'no change on reconnect; unsubscribed listener no longer fires');
  } finally {
    await h.close();
  }
});

test('collab: sendIndex / sendCardState emit the frames', async () => {
  const h = await collabHarness();
  await h.tc.start();
  try {
    await waitFor(helloed(h.conns));
    const entry = { sessionId: 's1', title: 'T', cwd: '/x', projectId: 'p_1', status: 'idle', model: null,
      updatedAt: '2026-01-01T00:00:00.000Z', lastPreview: '' } as any;
    h.tc.sendIndex({ full: false, sessions: [entry], removed: ['s0'] });
    h.tc.sendCardState({ cardId: 'c_1', state: 'running', sessionId: 's1' });
    h.tc.sendCardState({ cardId: 'c_2', state: 'review', error: 'boom' });
    const c = h.conns[0]!;
    await waitFor(() => c.frames.filter((f) => f.t === 'card.state').length === 2);
    assert.deepEqual(c.frames.find((f) => f.t === 'index'), { t: 'index', full: false, sessions: [entry], removed: ['s0'] });
    assert.deepEqual(c.frames.filter((f) => f.t === 'card.state'), [
      { t: 'card.state', cardId: 'c_1', state: 'running', sessionId: 's1' },
      { t: 'card.state', cardId: 'c_2', state: 'review', error: 'boom' },
    ]);
  } finally {
    await h.close();
  }
});

test('collab: rpc/watch plain:true → gateway gets plain=true and rpc.res / watch.data carry plain:true', async () => {
  const rpcCalls: any[] = [];
  const watchCalls: any[] = [];
  const h = await collabHarness({
    gateway: {
      handleRpc: (async (cp: string, p: string, plain?: boolean) => { rpcCalls.push([cp, p, plain]); return { payload: 'R:' + p }; }) as any,
      handleWatch: ((cp: string, p: string, send: (x: string) => void, _end: unknown, plain?: boolean) => {
        watchCalls.push([cp, p, plain]);
        queueMicrotask(() => send('W:' + p));
        return { cancel() {} };
      }) as any,
    },
  });
  await h.tc.start();
  try {
    await waitFor(helloed(h.conns));
    const c = h.conns[0]!;
    c.ws.send(JSON.stringify({ t: 'rpc', id: 'r1', clientPub: 'saas', payload: 'P1', plain: true }));
    c.ws.send(JSON.stringify({ t: 'rpc', id: 'r2', clientPub: 'cp', payload: 'P2' }));
    c.ws.send(JSON.stringify({ t: 'watch', id: 'w1', clientPub: 'cp', payload: 'P3', plain: true }));
    c.ws.send(JSON.stringify({ t: 'watch', id: 'w2', clientPub: 'cp', payload: 'P4' }));
    await waitFor(() => c.frames.filter((f) => f.t === 'rpc.res').length === 2 && c.frames.filter((f) => f.t === 'watch.data').length === 2);
    assert.deepEqual(rpcCalls, [['saas', 'P1', true], ['cp', 'P2', false]]);
    assert.deepEqual(watchCalls, [['cp', 'P3', true], ['cp', 'P4', false]]);
    const byId = (t: string, id: string) => c.frames.find((f) => f.t === t && f.id === id);
    assert.deepEqual(byId('rpc.res', 'r1'), { t: 'rpc.res', id: 'r1', payload: 'R:P1', plain: true });
    assert.deepEqual(byId('rpc.res', 'r2'), { t: 'rpc.res', id: 'r2', payload: 'R:P2' });
    assert.deepEqual(byId('watch.data', 'w1'), { t: 'watch.data', id: 'w1', payload: 'W:P3', plain: true });
    assert.deepEqual(byId('watch.data', 'w2'), { t: 'watch.data', id: 'w2', payload: 'W:P4' });
  } finally {
    await h.close();
  }
});

test('collab: register sends installCode, then removes NOPEAR_INSTALL_CODE from the env file', async () => {
  const h = await collabHarness({ pinned: false, env: { NOPEAR_INSTALL_CODE: 'IC-123' } });
  writeFileSync(h.config.envFile, 'NOPEAR_SAAS_URL=http://x\nNOPEAR_INSTALL_CODE=IC-123\n');
  await h.tc.start();
  try {
    await waitFor(helloed(h.conns));
    assert.equal(h.registers.length, 1);
    assert.equal(h.registers[0].installCode, 'IC-123');
    assert.equal(readFileSync(h.config.envFile, 'utf8'), 'NOPEAR_SAAS_URL=http://x\n');
  } finally {
    await h.close();
  }
});

test('collab: register without install code omits installCode', async () => {
  const h = await collabHarness({ pinned: false });
  await h.tc.start();
  try {
    await waitFor(helloed(h.conns));
    assert.equal('installCode' in h.registers[0], false);
  } finally {
    await h.close();
  }
});

test('collab: register 400 → RegisterRejectedError(400) mentioning the install code; env file kept', async () => {
  const h = await collabHarness({ pinned: false, env: { NOPEAR_INSTALL_CODE: 'IC-bad' }, register: () => ({ status: 400 }) });
  writeFileSync(h.config.envFile, 'NOPEAR_INSTALL_CODE=IC-bad\n');
  try {
    const err = await h.tc.start().then(() => null, (e: unknown) => e as Error);
    assert.ok(err instanceof RegisterRejectedError);
    assert.equal((err as RegisterRejectedError).status, 400);
    assert.match(err!.message, /install code/);
    assert.equal(h.registers.length, 1, 'not retried');
    assert.equal(readFileSync(h.config.envFile, 'utf8'), 'NOPEAR_INSTALL_CODE=IC-bad\n');
  } finally {
    await h.close();
  }
});

test('collab: install code with an existing pin → register (same identity) claims, pin kept, code removed from env', async () => {
  const h = await collabHarness({ env: { NOPEAR_INSTALL_CODE: 'IC-again' } });
  writeFileSync(h.config.envFile, 'NOPEAR_INSTALL_CODE=IC-again\n');
  const pinned = h.identity.platformPub;
  await h.tc.start();
  try {
    await waitFor(helloed(h.conns));
    assert.equal(h.registers.length, 1);
    assert.equal(h.registers[0].installCode, 'IC-again');
    assert.equal(h.registers[0].workerId, h.identity.workerId);
    assert.equal(h.identity.platformPub, pinned, 'pin kept');
    assert.equal(readFileSync(h.config.envFile, 'utf8'), '');
  } finally {
    await h.close();
  }
});

test('collab: existing pin without install code → no register', async () => {
  const h = await collabHarness();
  await h.tc.start();
  try {
    await waitFor(helloed(h.conns));
    assert.equal(h.registers.length, 0);
  } finally {
    await h.close();
  }
});

test('collab: install code with an existing pin, SaaS returns a different platform key → PlatformKeyMismatchError, no connect', async () => {
  const rogue = generateSigningKey();
  const h = await collabHarness({ env: { NOPEAR_INSTALL_CODE: 'IC-x' }, register: () => ({ status: 200, body: { platformPub: rogue.pub } }) });
  const pinned = h.identity.platformPub;
  try {
    const err = await h.tc.start().then(() => null, (e: unknown) => e as Error);
    assert.ok(err instanceof PlatformKeyMismatchError);
    assert.equal(h.registers.length, 1, 'not retried');
    assert.equal(h.identity.platformPub, pinned);
    assert.equal(h.conns.length, 0);
  } finally {
    await h.close();
  }
});

test('F1 collab: successful redemption clears config.installCode, persists the code hash; a restart with the same code skips register', async () => {
  const h = await collabHarness({ env: { NOPEAR_INSTALL_CODE: 'IC-once' } });
  await h.tc.start();
  let tc2: TunnelClient | null = null;
  try {
    await waitFor(helloed(h.conns));
    assert.equal(h.registers.length, 1);
    assert.equal(h.config.installCode, null, 'in-memory code cleared after redemption');
    const persisted = JSON.parse(readFileSync(join(h.config.home, 'identity.json'), 'utf8'));
    assert.equal(persisted.redeemedInstallCodeHash, sha256Hex('IC-once'));
    assert.equal(persisted.platformPub, h.identity.platformPub, 'pin persisted');
    // restart: the code is still in the environment (shell/systemd env, or .env edit failed)
    const config2 = loadConfig({ NOPEAR_SAAS_URL: h.config.saasUrl, NOPEAR_HOME: h.config.home, NOPEAR_INSTALL_CODE: 'IC-once' });
    config2.envFile = h.config.envFile;
    const identity2 = loadOrCreateIdentity(h.config.home, h.config.saasUrl);
    const gateway = { setAuthz() {}, handleRpc: async () => ({ payload: '' }), handleWatch: () => ({ cancel() {} }) } as unknown as Gateway;
    tc2 = new TunnelClient({ config: config2, identity: identity2, gateway, onClaimLink: () => {}, log: () => {}, reconnectBaseMs: 20 });
    await tc2.start();
    await waitFor(helloed(h.conns, 2));
    assert.equal(h.registers.length, 1, 'already-redeemed code is not sent again');
    assert.equal(config2.installCode, null);
  } finally {
    await tc2?.stop();
    await h.close();
  }
});

test('F1 collab: pinned worker + install code rejected 400 → warning, code ignored, still connects', async () => {
  const logs: string[] = [];
  const h = await collabHarness({
    env: { NOPEAR_INSTALL_CODE: 'IC-expired' },
    register: () => ({ status: 400, body: { error: { code: 'invalid_code', message: 'install code invalid or expired' } } }),
    tunnel: { log: (m) => logs.push(m) },
  });
  const pinned = h.identity.platformPub;
  try {
    await h.tc.start();
    await waitFor(helloed(h.conns));
    assert.equal(h.registers.length, 1, 'not retried');
    assert.equal(h.identity.platformPub, pinned);
    assert.equal(h.config.installCode, null, 'ignored code dropped from memory');
    assert.ok(logs.some((l) => /install code invalid\/expired\/used — ignoring it; this worker keeps its existing registration/.test(l)),
      logs.join(' | '));
  } finally {
    await h.close();
  }
});

test('F1 collab: unpinned 400 stays fatal and carries the SaaS error message', async () => {
  const h = await collabHarness({
    pinned: false, env: { NOPEAR_INSTALL_CODE: 'IC-bad' },
    register: () => ({ status: 400, body: { error: { code: 'invalid_code', message: 'install code expired XYZ' } } }),
  });
  try {
    const err = await h.tc.start().then(() => null, (e: unknown) => e as Error);
    assert.ok(err instanceof RegisterRejectedError);
    assert.equal((err as RegisterRejectedError).status, 400);
    assert.match(err!.message, /install code expired XYZ/);
    assert.equal(h.conns.length, 0);
  } finally {
    await h.close();
  }
});

test('F1 collab: 409 owned_elsewhere → fatal, message carries SaaS message + "claimed by another account" hint', async () => {
  const h = await collabHarness({
    pinned: false, env: { NOPEAR_INSTALL_CODE: 'IC-409' },
    register: () => ({ status: 409, body: { error: { code: 'conflict', message: 'machine belongs to another account' } } }),
  });
  try {
    const err = await h.tc.start().then(() => null, (e: unknown) => e as Error);
    assert.ok(err instanceof RegisterRejectedError);
    assert.equal((err as RegisterRejectedError).status, 409);
    assert.match(err!.message, /machine belongs to another account/);
    assert.match(err!.message, /machine may be claimed by another account — unbind it there first, or identity conflict/);
  } finally {
    await h.close();
  }
});
