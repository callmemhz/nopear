// Login allowlist: config, bootstrap, enforcement, admin API, /api/me.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { generateClientKey, generateSigningKey, randomId, sha256Hex } from '@nopear/core/crypto';
import { loadSaasConfig, type SaasConfigEnv } from './config';
import { buildServer } from './server';
import { openStore, type SaasStore } from './store';

const dir = mkdtempSync(join(tmpdir(), 'saas-allowlist-'));
const tgz = join(dir, 'worker.tgz');
writeFileSync(tgz, 'not-a-real-tgz');
const signing = generateSigningKey();
const baseConfig: SaasConfigEnv = {
  port: 0,
  publicUrl: 'http://localhost',
  publicUrlExplicit: false,
  dataDir: dir,
  db: '',
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
  workerTgz: tgz,
};

interface Srv { app: FastifyInstance; store: SaasStore; base: string }
const servers: Srv[] = [];
after(async () => { for (const s of servers) { await s.app.close(); await s.store.close(); } });

async function server(over: Partial<SaasConfigEnv> = {}): Promise<Srv> {
  const config: SaasConfigEnv = { ...baseConfig, db: `sqlite:${join(dir, `${randomId(8)}.db`)}`, ...over };
  const store = await openStore(config.db);
  const app = await buildServer({ config, store });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const s = { app, store, base: `http://127.0.0.1:${port}` };
  servers.push(s);
  return s;
}

function client(base: string) {
  const json = async (path: string, init: RequestInit & { token?: string } = {}) => {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    if (init.body && !headers['content-type']) headers['content-type'] = 'application/json';
    const res = await fetch(base + path, { ...init, headers, redirect: 'manual' });
    const text = await res.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: res.status, body, headers: res.headers };
  };
  const login = async (email: string) => {
    const r = await json('/api/auth/dev', { method: 'POST', body: JSON.stringify({ email }) });
    assert.equal(r.status, 200, `login ${email}: ${JSON.stringify(r.body)}`);
    return r.body as { token: string; user: { id: string; email: string } };
  };
  const put = (email: string, role: unknown, token?: string) =>
    json(`/api/admin/allowlist/${encodeURIComponent(email)}`, { method: 'PUT', token, body: JSON.stringify({ role }) });
  const del = (email: string, token?: string) => json(`/api/admin/allowlist/${encodeURIComponent(email)}`, { method: 'DELETE', token });
  return { json, login, put, del };
}

test('loadSaasConfig: SAAS_BOOTSTRAP_ADMIN normalized / invalid throws; SAAS_WORKER_TGZ resolved', () => {
  const d = mkdtempSync(join(tmpdir(), 'saas-cfg-'));
  const c = loadSaasConfig({ SAAS_DATA_DIR: d } as NodeJS.ProcessEnv);
  assert.equal(c.bootstrapAdmin, null);
  assert.equal(c.workerTgz, null);
  const c2 = loadSaasConfig({ SAAS_DATA_DIR: d, SAAS_BOOTSTRAP_ADMIN: '  Boss@X.com ', SAAS_WORKER_TGZ: 'rel/w.tgz' } as NodeJS.ProcessEnv);
  assert.equal(c2.bootstrapAdmin, 'boss@x.com');
  assert.equal(c2.workerTgz, resolve('rel/w.tgz'));
  assert.throws(() => loadSaasConfig({ SAAS_DATA_DIR: d, SAAS_BOOTSTRAP_ADMIN: 'not-an-email' } as NodeJS.ProcessEnv), /SAAS_BOOTSTRAP_ADMIN/);
});

test('buildServer bootstrap: empty list → inserts admin; non-empty list unchanged', async () => {
  const db = `sqlite:${join(dir, 'boot.db')}`;
  const s1 = await server({ db, bootstrapAdmin: 'boss@x.com' });
  const rows = await s1.store.allowlist.list();
  assert.equal(rows.length, 1);
  assert.deepEqual({ email: rows[0]!.email, role: rows[0]!.role, addedBy: rows[0]!.addedBy }, { email: 'boss@x.com', role: 'admin', addedBy: 'bootstrap' });
  // Same DB, a different bootstrap admin: list is non-empty → no change.
  const s2 = await server({ db, bootstrapAdmin: 'other@x.com' });
  assert.deepEqual((await s2.store.allowlist.list()).map((e) => e.email), ['boss@x.com']);
  // No bootstrapAdmin → stays open.
  const s3 = await server();
  assert.equal(await s3.store.allowlist.count(), 0);
});

test('dev login: refused (403, no user, access request filed) when not allowed; allowed emails normalized', async () => {
  const s = await server({ bootstrapAdmin: 'boss@x.com' });
  const c = client(s.base);
  const r = await c.json('/api/auth/dev', { method: 'POST', body: JSON.stringify({ email: 'intruder@x.com' }) });
  assert.equal(r.status, 403);
  assert.deepEqual(r.body, { error: { code: 'access_pending', message: '已提交加入申请，等管理员批准后即可登录' } });
  assert.equal((await s.store.accessRequests.get('intruder@x.com'))?.status, 'pending');
  const users = (s.store as unknown as { db: { prepare(sql: string): { get(): { n: number } } } }).db.prepare('SELECT COUNT(*) AS n FROM users').get();
  assert.equal(Number(users.n), 0);
  const ok = await c.login('  BOSS@x.com ');
  assert.equal(ok.user.email, 'boss@x.com');
});

test('/api/me: open mode / admin / member', async () => {
  const open = client((await server()).base);
  const u = await open.login('a@x.com');
  const me = await open.json('/api/me', { token: u.token });
  assert.deepEqual(me.body, { user: u.user, role: null, allowlistEnabled: false });

  const s = await server({ bootstrapAdmin: 'boss@x.com' });
  const c = client(s.base);
  const boss = await c.login('boss@x.com');
  assert.deepEqual((await c.json('/api/me', { token: boss.token })).body, { user: boss.user, role: 'admin', allowlistEnabled: true });
  assert.equal((await c.put('m@x.com', 'member', boss.token)).status, 200);
  const m = await c.login('m@x.com');
  assert.deepEqual((await c.json('/api/me', { token: m.token })).body, { user: m.user, role: 'member', allowlistEnabled: true });
});

test('admin API: every branch', async (t) => {
  await t.test('open mode', async () => {
    const s = await server();
    const c = client(s.base);
    const a = await c.login('a@x.com');
    assert.equal((await c.json('/api/admin/allowlist')).status, 401);
    assert.equal((await c.put('a@x.com', 'admin')).status, 401);
    assert.equal((await c.del('a@x.com')).status, 401);
    assert.deepEqual((await c.json('/api/admin/allowlist', { token: a.token })).body, { entries: [] });
    assert.equal((await c.del('a@x.com', a.token)).status, 404);
    // PUT someone else, or self as member → 400
    const other = await c.put('b@x.com', 'admin', a.token);
    assert.equal(other.status, 400);
    assert.equal(other.body.error.code, 'bad_request');
    assert.equal((await c.put('a@x.com', 'member', a.token)).status, 400);
    assert.equal(await s.store.allowlist.count(), 0);
    // PUT self as admin (case-insensitive) → enabled
    const self = await c.put('A@X.com', 'admin', a.token);
    assert.equal(self.status, 200);
    assert.equal(self.body.entry.email, 'a@x.com');
    assert.equal(self.body.entry.role, 'admin');
    assert.equal(self.body.entry.addedBy, 'a@x.com');
    assert.equal(typeof self.body.entry.createdAt, 'string');
    assert.equal((await c.json('/api/me', { token: a.token })).body.allowlistEnabled, true);
    // Others are now locked out.
    assert.equal((await c.json('/api/auth/dev', { method: 'POST', body: JSON.stringify({ email: 'b@x.com' }) })).status, 403);
  });

  await t.test('enabled', async () => {
    const s = await server({ bootstrapAdmin: 'boss@x.com' });
    const c = client(s.base);
    const boss = await c.login('boss@x.com');
    // params
    assert.equal((await c.put('nope', 'member', boss.token)).status, 400);
    assert.equal((await c.put('x@x.com', 'owner', boss.token)).status, 400);
    assert.equal((await c.put('x@x.com', undefined, boss.token)).status, 400);
    assert.equal((await c.del('nope', boss.token)).status, 400);
    // add member; list sorted
    const added = await c.put(' Mem@X.com ', 'member', boss.token);
    assert.equal(added.status, 200);
    assert.deepEqual({ ...added.body.entry, createdAt: undefined }, { email: 'mem@x.com', role: 'member', addedBy: 'boss@x.com', createdAt: undefined });
    const list = await c.json('/api/admin/allowlist', { token: boss.token });
    assert.deepEqual(list.body.entries.map((e: { email: string }) => e.email), ['boss@x.com', 'mem@x.com']);
    // member → 403 on every admin endpoint
    const mem = await c.login('mem@x.com');
    for (const r of [await c.json('/api/admin/allowlist', { token: mem.token }), await c.put('z@x.com', 'member', mem.token), await c.del('boss@x.com', mem.token)]) {
      assert.equal(r.status, 403);
      assert.equal(r.body.error.code, 'forbidden');
    }
    // last admin: demote / delete → 409
    const demote = await c.put('boss@x.com', 'member', boss.token);
    assert.equal(demote.status, 409);
    assert.equal(demote.body.error.code, 'conflict');
    assert.equal((await c.del('boss@x.com', boss.token)).status, 409);
    // not found
    assert.equal((await c.del('ghost@x.com', boss.token)).status, 404);
    // promote member, then the admin removes themself → ok, and their next request is 401
    assert.equal((await c.put('mem@x.com', 'admin', boss.token)).body.entry.role, 'admin');
    assert.deepEqual((await c.del('BOSS@x.com', boss.token)).body, { ok: true });
    assert.equal((await c.json('/api/me', { token: boss.token })).status, 401);
    assert.equal((await c.json('/api/me', { token: mem.token })).body.role, 'admin');
  });
});

test('removed from the allowlist → 401 everywhere (me, api(), events, data plane, mcp); re-adding restores', async () => {
  const s = await server({ bootstrapAdmin: 'boss@x.com' });
  const c = client(s.base);
  const boss = await c.login('boss@x.com');
  await c.put('m@x.com', 'member', boss.token);
  const m = await c.login('m@x.com');
  const key = generateClientKey();
  assert.equal((await c.json('/api/clients', { method: 'POST', token: m.token, body: JSON.stringify({ clientPub: key.pub, label: 'w' }) })).status, 201);
  // a machine owned by m (via install code) so the data plane gets past ownership checks
  const code = await c.json('/api/machines/install-code', { method: 'POST', token: m.token, body: JSON.stringify({}) });
  assert.equal(code.status, 200);
  const workerId = 'w_' + 'm'.repeat(16);
  const reg = await c.json('/worker/register', {
    method: 'POST',
    body: JSON.stringify({ workerId, workerPub: generateClientKey().pub, secretHash: sha256Hex(randomId(24)), installCode: code.body.code }),
  });
  assert.equal(reg.status, 200);
  const apiToken = (await c.json('/api/tokens', { method: 'POST', token: m.token, body: JSON.stringify({ label: 'mcp' }) })).body.token as string;

  const mcp = () => fetch(s.base + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${apiToken}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  const events = async () => {
    const ac = new AbortController();
    const r = await fetch(s.base + '/api/events', { headers: { authorization: `Bearer ${m.token}` }, signal: ac.signal });
    ac.abort();
    return r.status;
  };
  const rpc = async () => (await fetch(`${s.base}/api/w/${workerId}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${m.token}`, 'x-nopear-client': key.pub },
    body: new Uint8Array([1, 2, 3]),
  })).status;
  const statuses = async () => ({
    me: (await c.json('/api/me', { token: m.token })).status,
    projects: (await c.json('/api/projects', { token: m.token })).status,
    events: await events(),
    rpc: await rpc(),
    mcp: (await mcp()).status,
  });

  // Allowed: rpc reaches the offline check (503), everything else 200.
  assert.deepEqual(await statuses(), { me: 200, projects: 200, events: 200, rpc: 503, mcp: 200 });
  assert.deepEqual((await c.del('m@x.com', boss.token)).body, { ok: true });
  assert.deepEqual(await statuses(), { me: 401, projects: 401, events: 401, rpc: 401, mcp: 401 });
  // Tokens were not deleted: re-adding restores access.
  await c.put('m@x.com', 'member', boss.token);
  assert.deepEqual(await statuses(), { me: 200, projects: 200, events: 200, rpc: 503, mcp: 200 });
});

test('google callback: not allowed → #error=access_pending (request filed); unverified → not_allowed; allowed → #token', async () => {
  const s = await server({ bootstrapAdmin: 'boss@x.com', googleClientId: 'cid', googleClientSecret: 'csecret' });
  const c = client(s.base);
  const origFetch = globalThis.fetch;
  let info: Record<string, unknown> = {};
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'at' });
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo') return Response.json(info);
    return origFetch(input, init);
  }) as typeof fetch;
  try {
    const start = async () => {
      const r = await c.json(`/api/auth/google/start?redirect=${encodeURIComponent('http://localhost/auth/callback?n=abc')}`);
      assert.equal(r.status, 302);
      return new URL(r.headers.get('location')!).searchParams.get('state')!;
    };
    const callback = async () => {
      const r = await c.json(`/api/auth/google/callback?code=x&state=${encodeURIComponent(await start())}`);
      assert.equal(r.status, 302);
      return r.headers.get('location')!;
    };
    const userCount = () => Number((s.store as unknown as { db: { prepare(sql: string): { get(): { n: number } } } }).db.prepare('SELECT COUNT(*) AS n FROM users').get().n);

    info = { sub: 's1', email: 'intruder@x.com', email_verified: true };
    assert.equal(await callback(), 'http://localhost/auth/callback?n=abc#error=access_pending');
    // once rejected, a later attempt is a plain refusal
    await s.store.accessRequests.setStatus('intruder@x.com', 'rejected');
    assert.equal(await callback(), 'http://localhost/auth/callback?n=abc#error=not_allowed');
    info = { sub: 's2', email: 'boss@x.com', email_verified: false };
    assert.equal(await callback(), 'http://localhost/auth/callback?n=abc#error=not_allowed');
    info = { sub: 's2', email: 'boss@x.com' };
    assert.equal(await callback(), 'http://localhost/auth/callback?n=abc#error=not_allowed');
    assert.equal(userCount(), 0);

    info = { sub: 's2', email: 'Boss@X.com', email_verified: true };
    const loc = await callback();
    assert.match(loc, /^http:\/\/localhost\/auth\/callback\?n=abc#token=/);
    const token = decodeURIComponent(loc.split('#token=')[1]!);
    const me = await c.json('/api/me', { token });
    assert.equal(me.status, 200);
    assert.equal(me.body.role, 'admin');
    assert.equal(userCount(), 1);
  } finally {
    globalThis.fetch = origFetch;
  }
});
