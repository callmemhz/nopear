import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from './store';
import { MIGRATIONS_COUNT } from './sqlite-store';

async function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'saas-store-'));
  return openStore(`sqlite:${join(dir, 'saas.db')}`);
}

test('users: upsertDev / upsertGoogle / get', async () => {
  const s = await fresh();
  const a = await s.users.upsertDev('a@x.com');
  const a2 = await s.users.upsertDev('a@x.com');
  assert.equal(a.id, a2.id);
  assert.equal(a.email, 'a@x.com');
  const g = await s.users.upsertGoogle('sub-1', 'g@x.com');
  const g2 = await s.users.upsertGoogle('sub-1', 'g2@x.com');
  assert.equal(g.id, g2.id);
  assert.equal(g2.email, 'g2@x.com');
  assert.equal(g.googleSub, 'sub-1');
  assert.deepEqual((await s.users.get(a.id))?.email, 'a@x.com');
  assert.equal(await s.users.get('nope'), null);
  await s.close();
});

test('tokens: create / get / delete', async () => {
  const s = await fresh();
  const u = await s.users.upsertDev('t@x.com');
  await s.tokens.create(u.id, 'h1', 12345);
  assert.deepEqual(await s.tokens.get('h1'), { userId: u.id, expiresAt: 12345 });
  await s.tokens.delete('h1');
  assert.equal(await s.tokens.get('h1'), null);
  await s.close();
});

test('clients: upsert idempotent / list / delete', async () => {
  const s = await fresh();
  const u = await s.users.upsertDev('c@x.com');
  const c = await s.clients.upsert(u.id, 'PUB', 'web', 'SIG');
  const c2 = await s.clients.upsert(u.id, 'PUB', 'web2', 'SIG2');
  assert.equal(c.createdAt, c2.createdAt);
  assert.equal(c2.label, 'web2');
  assert.equal((await s.clients.list(u.id)).length, 1);
  assert.equal(await s.clients.delete(u.id, 'PUB'), true);
  assert.equal(await s.clients.delete(u.id, 'PUB'), false);
  assert.equal((await s.clients.list(u.id)).length, 0);
  await s.close();
});

test('workers: register / exists / claim atomicity / update / unclaim', async () => {
  const s = await fresh();
  const u = await s.users.upsertDev('w@x.com');
  const u2 = await s.users.upsertDev('w2@x.com');
  assert.equal(await s.workers.register('w_1', 'WPUB', 'SH'), 'ok');
  // Same identity re-registering is idempotent; a mismatched pub or secret is a conflict.
  assert.equal(await s.workers.register('w_1', 'WPUB', 'SH'), 'ok');
  assert.equal(await s.workers.register('w_1', 'OTHER', 'SH'), 'exists');
  assert.equal(await s.workers.register('w_1', 'WPUB', 'SH2'), 'exists');
  const w = await s.workers.get('w_1');
  assert.equal(w?.userId, null);
  assert.equal(w?.workerPub, 'WPUB');
  const now = 1_000_000;
  await s.workers.setClaimTokenHash('w_1', 'CT', now + 1000);
  assert.equal(await s.workers.claim('w_1', 'WRONG', u.id, undefined, now), null, 'wrong token');
  assert.equal(await s.workers.claim('w_1', 'CT', u.id, undefined, now + 2000), null, 'expired');
  const claimed = await s.workers.claim('w_1', 'CT', u.id, 'my box', now);
  assert.equal(claimed?.userId, u.id);
  assert.equal(claimed?.label, 'my box');
  assert.equal(claimed?.claimTokenHash, null);
  assert.equal(await s.workers.claim('w_1', 'CT', u2.id, undefined, now), null, 'reclaim');
  await s.workers.setClaimTokenHash('w_1', 'CT2', now + 1000);
  assert.equal(await s.workers.claim('w_1', 'CT2', u2.id, undefined, now), null, 'already claimed');
  assert.equal((await s.workers.listByUser(u.id)).length, 1);
  await s.workers.update('w_1', { label: 'L', lastSeenAt: '2026-01-01T00:00:00.000Z', version: '3.0.0' });
  const w2 = await s.workers.get('w_1');
  assert.equal(w2?.label, 'L');
  assert.equal(w2?.version, '3.0.0');
  assert.equal(w2?.lastSeenAt, '2026-01-01T00:00:00.000Z');
  await s.workers.unclaim('w_1');
  assert.equal((await s.workers.get('w_1'))?.userId, null);
  assert.equal((await s.workers.listByUser(u.id)).length, 0);
  await s.close();
});

test('openStore rejects postgres', async () => {
  await assert.rejects(openStore('postgres://x'), /postgres store not implemented/);
});

// ---------- v3.1 collaboration data ----------

const V1_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL, google_sub TEXT UNIQUE, dev_email TEXT UNIQUE, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS clients (
  user_id TEXT NOT NULL, client_pub TEXT NOT NULL, label TEXT NOT NULL, sig TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, client_pub));
CREATE TABLE IF NOT EXISTS workers (
  worker_id TEXT PRIMARY KEY, worker_pub TEXT NOT NULL, secret_hash TEXT NOT NULL, user_id TEXT, label TEXT NOT NULL DEFAULT '',
  claim_token_hash TEXT, claim_expires_at INTEGER, last_seen_at TEXT, version TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS workers_user ON workers(user_id);
`;

test('migrates a v3 database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'saas-store-'));
  const path = join(dir, 'saas.db');
  const old = new DatabaseSync(path);
  old.exec(V1_SCHEMA);
  old.prepare('INSERT INTO users (id, email, dev_email, created_at) VALUES (?, ?, ?, ?)').run('u_old', 'o@x.com', 'o@x.com', '2026-01-01T00:00:00.000Z');
  old.close();
  const s = await openStore(`sqlite:${path}`);
  assert.equal((await s.users.get('u_old'))?.email, 'o@x.com');
  assert.deepEqual(await s.projects.list('u_old'), []);
  await s.close();
  const check = new DatabaseSync(path);
  assert.equal((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, MIGRATIONS_COUNT);
  check.close();
  // Reopening an up-to-date DB is a no-op.
  const s2 = await openStore(`sqlite:${path}`);
  assert.equal((await s2.users.get('u_old'))?.email, 'o@x.com');
  await s2.close();
});

test('projects CRUD', async () => {
  const s = await fresh();
  const u = (await s.users.upsertDev('p@x.com')).id;
  const u2 = (await s.users.upsertDev('p2@x.com')).id;
  const a = await s.projects.create(u, { name: 'a', description: '', paths: { w_1: '/x' } });
  assert.match(a.id, /^p_[0-9a-f]+$/);
  assert.equal(a.name, 'a');
  assert.deepEqual(a.paths, { w_1: '/x' });
  assert.equal(a.createdAt, a.updatedAt);
  await new Promise((r) => setTimeout(r, 2));
  const b = await s.projects.create(u, { name: 'b', description: 'd', paths: { w_1: '/y', w_2: '/z' } });
  assert.deepEqual((await s.projects.list(u)).map((p) => p.name), ['a', 'b']);
  assert.deepEqual(await s.projects.list(u2), []);
  assert.equal(await s.projects.get(u2, a.id), null, 'other user');
  const up = await s.projects.update(u, a.id, { paths: { w_3: '/q' }, description: 'new' });
  assert.deepEqual(up?.paths, { w_3: '/q' });
  assert.equal(up?.description, 'new');
  assert.equal(up?.name, 'a');
  assert.equal(await s.projects.update(u2, a.id, { name: 'hack' }), null);
  assert.deepEqual(await s.projects.get(u, a.id), up);
  const changed = await s.projects.removeWorkerPaths(u, 'w_1');
  assert.deepEqual(changed.map((p) => p.id), [b.id]);
  assert.deepEqual(changed[0]!.paths, { w_2: '/z' });
  assert.deepEqual((await s.projects.get(u, b.id))?.paths, { w_2: '/z' });
  assert.deepEqual(await s.projects.removeWorkerPaths(u, 'w_1'), []);
  assert.equal(await s.projects.delete(u2, a.id), false);
  assert.equal(await s.projects.delete(u, a.id), true);
  assert.equal(await s.projects.get(u, a.id), null);
  assert.equal(await s.projects.delete(u, a.id), false);
  await s.close();
});

test('cards order + filters', async () => {
  const s = await fresh();
  const u = (await s.users.upsertDev('c@x.com')).id;
  const u2 = (await s.users.upsertDev('c2@x.com')).id;
  const cs = [];
  for (let i = 0; i < 3; i++) {
    cs.push(await s.cards.create(u, { title: `t${i}`, body: 'b', projectId: i === 2 ? 'p_1' : null, order: i }));
  }
  for (const [i, c] of cs.entries()) {
    assert.match(c.id, /^c_[0-9a-f]+$/);
    assert.equal(c.state, 'inbox');
    assert.equal(c.order, i);
    assert.equal(c.workerId, null);
    assert.equal(c.sessionId, null);
    assert.equal('error' in c, false);
  }
  assert.equal(await s.cards.maxOrder(u, 'inbox', null), 2);
  assert.equal(await s.cards.maxOrder(u, 'queued', 'w_1'), -1);
  assert.equal(await s.cards.maxOrder(u2, 'inbox', null), -1);
  const q = await s.cards.update(u, cs[0]!.id, { state: 'queued', workerId: 'w_1', order: 0 });
  assert.equal(q?.state, 'queued');
  assert.equal(q?.workerId, 'w_1');
  assert.equal(await s.cards.update(u2, cs[0]!.id, { title: 'x' }), null, 'other user');
  await s.cards.update(u, cs[1]!.id, { state: 'running', workerId: 'w_1', sessionId: 's_1', order: -1, error: 'boom' });
  await s.cards.update(u, cs[2]!.id, { state: 'queued', workerId: 'w_2', order: 0 });
  assert.equal(await s.cards.maxOrder(u, 'queued', 'w_1'), 0);
  assert.equal((await s.cards.list(u, { state: 'queued', workerId: 'w_1' })).length, 1);
  assert.equal((await s.cards.list(u, { state: 'queued' })).length, 2);
  assert.equal((await s.cards.list(u, {})).length, 3);
  assert.deepEqual((await s.cards.list(u, { projectId: 'p_1' })).map((c) => c.id), [cs[2]!.id]);
  assert.deepEqual(await s.cards.list(u2, {}), []);
  assert.deepEqual((await s.cards.forWorker('w_1', u)).map((c) => c.id), [cs[1]!.id, cs[0]!.id]);
  // scoped to the machine's current owner: another account's stale card on the same worker is never pushed
  const stale = await s.cards.create(u2, { title: 'stale', body: '', projectId: null, order: 0 });
  await s.cards.update(u2, stale.id, { state: 'queued', workerId: 'w_1', order: -5 });
  assert.deepEqual((await s.cards.forWorker('w_1', u)).map((c) => c.id), [cs[1]!.id, cs[0]!.id]);
  assert.deepEqual((await s.cards.forWorker('w_1', u2)).map((c) => c.id), [stale.id]);
  await s.cards.delete(u2, stale.id);
  const running = await s.cards.get(u, cs[1]!.id);
  assert.equal(running?.error, 'boom');
  assert.equal(running?.sessionId, 's_1');
  const cleared = await s.cards.update(u, cs[1]!.id, { error: null });
  assert.equal('error' in cleared!, false);
  await s.cards.update(u, cs[1]!.id, { state: 'done' });
  assert.deepEqual((await s.cards.forWorker('w_1', u)).map((c) => c.id), [cs[0]!.id]);
  assert.equal((await s.cards.byWorker('w_1')).length, 2);
  const back = await s.cards.update(u, cs[0]!.id, { state: 'inbox', workerId: null, sessionId: null });
  assert.equal(back?.workerId, null);
  const del = await s.cards.deleteByProject(u, 'p_1');
  assert.deepEqual(del.map((c) => c.id), [cs[2]!.id]);
  assert.equal(await s.cards.get(u, cs[2]!.id), null);
  assert.equal(await s.cards.delete(u2, cs[0]!.id), false);
  assert.equal(await s.cards.delete(u, cs[0]!.id), true);
  assert.equal(await s.cards.get(u, cs[0]!.id), null);
  await s.close();
});

test('memories', async () => {
  const s = await fresh();
  const u = (await s.users.upsertDev('m@x.com')).id;
  assert.equal(await s.memories.get(u, 'global', null), null);
  const g = await s.memories.put(u, 'global', null, 'hello');
  assert.equal(g.scope, 'global');
  assert.equal(g.projectId, null);
  assert.equal(g.content, 'hello');
  assert.ok(g.updatedAt);
  assert.deepEqual(await s.memories.get(u, 'global', null), g);
  const g2 = await s.memories.put(u, 'global', null, 'hello2');
  assert.equal((await s.memories.get(u, 'global', null))?.content, 'hello2');
  assert.equal(g2.content, 'hello2');
  await s.memories.put(u, 'project', 'p_1', 'P1');
  await s.memories.put(u, 'project', 'p_2', 'P2');
  assert.deepEqual(await s.memories.get(u, 'project', 'p_1'), { scope: 'project', projectId: 'p_1', content: 'P1', updatedAt: (await s.memories.get(u, 'project', 'p_1'))!.updatedAt });
  assert.equal((await s.memories.get(u, 'project', 'p_2'))?.content, 'P2');
  await s.memories.deleteProject(u, 'p_1');
  assert.equal(await s.memories.get(u, 'project', 'p_1'), null);
  assert.equal((await s.memories.get(u, 'project', 'p_2'))?.content, 'P2');
  assert.equal((await s.memories.get(u, 'global', null))?.content, 'hello2');
  // project scope requires a non-empty projectId (mirrors protocol memoryKey)
  await assert.rejects(() => s.memories.put(u, 'project', null, 'X'), /projectId/);
  await assert.rejects(() => s.memories.put(u, 'project', '', 'X'), /projectId/);
  await assert.rejects(() => s.memories.get(u, 'project', null), /projectId/);
  await s.close();
});

test('sessionIndex', async () => {
  const s = await fresh();
  const u = (await s.users.upsertDev('s@x.com')).id;
  const u2 = (await s.users.upsertDev('s2@x.com')).id;
  const e = (sessionId: string, title: string, preview: string, last: string, projectId: string | null = null, workerId = 'w_1') => ({
    workerId, sessionId, title, preview, status: 'idle' as const, projectId, cwd: '/c',
    createdAt: '2026-01-01T00:00:00.000Z', lastActivityAt: last,
  });
  const e1 = e('s1', 'has foo inside', '', '2026-01-02T00:00:00.000Z', 'p_1');
  const e2 = e('s2', 'other', 'x', '2026-01-03T00:00:00.000Z');
  await s.sessionIndex.replaceWorker(u, 'w_1', [e1, e2]);
  await s.sessionIndex.replaceWorker(u, 'w_9', [e('s9', 'nine', '', '2026-01-01T00:00:00.000Z', null, 'w_9')]);
  assert.deepEqual(await s.sessionIndex.query(u, { workerId: 'w_1', limit: 50 }), [e2, e1]);
  const e2b = { ...e2, preview: 'a Foo preview', lastActivityAt: '2026-01-04T00:00:00.000Z', status: 'running' as const };
  await s.sessionIndex.upsert(u, [e2b]);
  assert.deepEqual(await s.sessionIndex.query(u, { q: 'FOO', limit: 50 }), [e2b, e1]);
  assert.deepEqual(await s.sessionIndex.query(u, { q: 'FOO', limit: 1 }), [e2b]);
  assert.deepEqual(await s.sessionIndex.query(u, { projectId: 'p_1', limit: 50 }), [e1]);
  assert.deepEqual(await s.sessionIndex.query(u2, { limit: 50 }), []);
  assert.equal((await s.sessionIndex.query(u, { limit: 50 })).length, 3);
  await s.sessionIndex.clearProject(u, 'p_1');
  assert.equal((await s.sessionIndex.query(u, { workerId: 'w_1', q: 'has foo', limit: 50 }))[0]?.projectId, null);
  await s.sessionIndex.remove('w_1', ['s1']);
  assert.deepEqual(await s.sessionIndex.query(u, { workerId: 'w_1', limit: 50 }), [e2b]);
  // replaceWorker drops rows not in the new set.
  await s.sessionIndex.replaceWorker(u, 'w_1', [e1]);
  assert.deepEqual(await s.sessionIndex.query(u, { workerId: 'w_1', limit: 50 }), [{ ...e1 }]);
  await s.sessionIndex.deleteWorker('w_1');
  assert.deepEqual(await s.sessionIndex.query(u, { workerId: 'w_1', limit: 50 }), []);
  assert.equal((await s.sessionIndex.query(u, { workerId: 'w_9', limit: 50 })).length, 1);
  await s.close();
});

test('apiTokens', async () => {
  const s = await fresh();
  const u = (await s.users.upsertDev('a@x.com')).id;
  const u2 = (await s.users.upsertDev('a2@x.com')).id;
  const t = await s.apiTokens.create(u, 'cli', 'h1');
  assert.match(t.id, /^t_[0-9a-f]+$/);
  assert.equal(t.label, 'cli');
  assert.equal(t.tokenHash, 'h1');
  assert.equal(t.userId, u);
  assert.equal(t.lastUsedAt, null);
  assert.deepEqual(await s.apiTokens.get('h1'), t);
  assert.equal(await s.apiTokens.get('nope'), null);
  assert.deepEqual(await s.apiTokens.list(u), [t]);
  assert.deepEqual(await s.apiTokens.list(u2), []);
  await s.apiTokens.touch(t.id);
  assert.ok((await s.apiTokens.get('h1'))?.lastUsedAt);
  assert.equal(await s.apiTokens.delete(u2, t.id), false);
  assert.equal(await s.apiTokens.delete(u, t.id), true);
  assert.equal(await s.apiTokens.get('h1'), null);
  await s.close();
});

test('installCodes', async () => {
  const s = await fresh();
  const u = (await s.users.upsertDev('i@x.com')).id;
  const now = 1_000_000;
  await s.installCodes.create(u, 'hash', null, now + 1000);
  await s.installCodes.create(u, 'labeled', 'box', now + 1000);
  assert.equal((await s.installCodes.get('hash'))?.usedBy, null);
  assert.equal((await s.installCodes.get('labeled'))?.label, 'box');
  const r = await s.installCodes.consume('hash', 'w_1', now);
  assert.equal(r?.userId, u);
  assert.equal(r?.usedBy, 'w_1');
  assert.equal(r?.label, null);
  assert.equal(r?.expiresAt, now + 1000);
  assert.equal(await s.installCodes.consume('hash', 'w_2', now), null, 'used by another worker');
  assert.equal((await s.installCodes.consume('hash', 'w_1', now))?.usedBy, 'w_1', 'idempotent');
  assert.equal(await s.installCodes.consume('labeled', 'w_3', now + 1000), null, 'expired');
  assert.equal(await s.installCodes.consume('missing', 'w_1', now), null);
  assert.equal((await s.installCodes.get('hash'))?.usedBy, 'w_1');
  assert.equal(await s.installCodes.get('missing'), null);
  await s.close();
});

test('workers.registerWithInstallCode: atomic check + register + consume + claim', async () => {
  const s = await fresh();
  const u = (await s.users.upsertDev('rc@x.com')).id;
  const u2 = (await s.users.upsertDev('rc2@x.com')).id;
  const now = 1_000_000;
  await s.installCodes.create(u, 'code', 'box', now + 1000);
  await s.installCodes.create(u, 'expired', null, now - 1);

  // invalid codes → nothing registered
  assert.deepEqual(await s.workers.registerWithInstallCode('w_x', 'PX', 'SX', 'missing', now), { status: 'invalid_code' });
  assert.deepEqual(await s.workers.registerWithInstallCode('w_x', 'PX', 'SX', 'expired', now), { status: 'invalid_code' });
  assert.equal(await s.workers.get('w_x'), null);

  // ok → registered, claimed with the code's label, code marked used
  const r = await s.workers.registerWithInstallCode('w_1', 'P', 'S', 'code', now);
  assert.equal(r.status, 'ok');
  assert.equal(r.status === 'ok' && r.worker.userId, u);
  assert.equal(r.status === 'ok' && r.worker.label, 'box');
  assert.equal((await s.installCodes.get('code'))?.usedBy, 'w_1');
  // idempotent retry (same identity, code used by itself)
  assert.equal((await s.workers.registerWithInstallCode('w_1', 'P', 'S', 'code', now)).status, 'ok');
  // another worker → invalid_code, not registered
  assert.deepEqual(await s.workers.registerWithInstallCode('w_2', 'P2', 'S2', 'code', now), { status: 'invalid_code' });
  assert.equal(await s.workers.get('w_2'), null);
  // same workerId, different identity → exists
  await s.installCodes.create(u, 'code2', null, now + 1000);
  assert.deepEqual(await s.workers.registerWithInstallCode('w_1', 'OTHER', 'S', 'code2', now), { status: 'exists' });
  assert.equal((await s.installCodes.get('code2'))?.usedBy, null, 'not consumed on exists');
  // worker owned by another account → owned_elsewhere, code not consumed, owner unchanged
  await s.workers.register('w_3', 'P3', 'S3');
  await s.workers.claimDirect('w_3', u2, null);
  assert.deepEqual(await s.workers.registerWithInstallCode('w_3', 'P3', 'S3', 'code2', now), { status: 'owned_elsewhere' });
  assert.equal((await s.installCodes.get('code2'))?.usedBy, null, 'not consumed on owned_elsewhere');
  assert.equal((await s.workers.get('w_3'))?.userId, u2);
  // already-registered unowned worker (e.g. registered with the bootstrap token) → claimed by the code
  await s.workers.register('w_4', 'P4', 'S4');
  const r4 = await s.workers.registerWithInstallCode('w_4', 'P4', 'S4', 'code2', now);
  assert.equal(r4.status === 'ok' && r4.worker.userId, u);
  assert.equal(r4.status === 'ok' && r4.worker.label, '');
  await s.close();
});

test('settings', async () => {
  const s = await fresh();
  const u = (await s.users.upsertDev('st@x.com')).id;
  const ac = { enabled: true, thresholdTokens: 300_000, keepRecentTokens: 20_000 };
  assert.deepEqual(await s.settings.get(u), { e2e: false, autoCompact: ac });
  assert.deepEqual(await s.settings.put(u, { e2e: true, autoCompact: ac }), { e2e: true, autoCompact: ac });
  assert.deepEqual(await s.settings.get(u), { e2e: true, autoCompact: ac });
  assert.deepEqual(await s.settings.put(u, { e2e: false, autoCompact: ac }), { e2e: false, autoCompact: ac });
  assert.deepEqual(await s.settings.get(u), { e2e: false, autoCompact: ac });
  // out-of-range values are clamped on the way in, unknown/absent fields fall back to defaults
  const t = await s.settings.put(u, { e2e: false, autoCompact: { enabled: false, thresholdTokens: 1, keepRecentTokens: 10_000_000 } });
  assert.deepEqual(t.autoCompact, { enabled: false, thresholdTokens: 20_000, keepRecentTokens: 200_000 });
  await s.close();
});

test('workers.claimDirect', async () => {
  const s = await fresh();
  const u = (await s.users.upsertDev('cd@x.com')).id;
  const u2 = (await s.users.upsertDev('cd2@x.com')).id;
  await s.workers.register('w_1', 'P', 'S');
  await s.workers.register('w_2', 'P2', 'S2');
  await s.workers.setClaimTokenHash('w_1', 'CT', 9_999_999_999_999);
  const c = await s.workers.claimDirect('w_1', u, 'box');
  assert.equal(c?.userId, u);
  assert.equal(c?.label, 'box');
  assert.equal(c?.claimTokenHash, null);
  assert.equal((await s.workers.claimDirect('w_1', u, null))?.label, 'box', 'same user keeps label');
  assert.equal(await s.workers.claimDirect('w_1', u2, null), null, 'other owner');
  assert.equal((await s.workers.get('w_1'))?.userId, u);
  const c2 = await s.workers.claimDirect('w_2', u2, null);
  assert.equal(c2?.userId, u2);
  assert.equal(c2?.label, '');
  assert.equal(await s.workers.claimDirect('w_missing', u, null), null);
  await s.close();
});

test('migration 3 adds the allowlist table to a v3.1 (user_version 2) database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'saas-store-'));
  const path = join(dir, 'saas.db');
  const s = await openStore(`sqlite:${path}`);
  await s.close();
  // Roll back to a v3.1 database: drop the table and reset user_version.
  const db = new DatabaseSync(path);
  db.exec('DROP TABLE allowlist; PRAGMA user_version = 2;');
  // Undo migration 4 as well so it re-runs against a real v3.1 schema.
  db.exec('ALTER TABLE settings DROP COLUMN auto_compact_enabled; ALTER TABLE settings DROP COLUMN auto_compact_threshold_tokens; ALTER TABLE settings DROP COLUMN auto_compact_keep_recent_tokens;');
  // ...and migration 5.
  db.exec('ALTER TABLE users DROP COLUMN disabled_at; ALTER TABLE users DROP COLUMN last_seen_at; DROP TABLE access_requests;');
  db.close();
  const s2 = await openStore(`sqlite:${path}`);
  assert.equal(await s2.allowlist.count(), 0);
  // migration 4 ran too: the new settings columns exist with the protocol defaults
  assert.deepEqual(await s2.settings.get('nobody'), { e2e: false, autoCompact: { enabled: true, thresholdTokens: 300_000, keepRecentTokens: 20_000 } });
  await s2.close();
  const check = new DatabaseSync(path);
  assert.equal((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, MIGRATIONS_COUNT);
  check.close();
});

test('allowlist: bootstrap / put / get / list / count / delete + last-admin rule', async () => {
  const s = await fresh();
  assert.equal(await s.allowlist.count(), 0);
  assert.deepEqual(await s.allowlist.list(), []);
  assert.equal(await s.allowlist.get('a@x.com'), null);
  // bootstrap only inserts into an empty table
  assert.equal(await s.allowlist.bootstrap('a@x.com'), true);
  assert.equal(await s.allowlist.bootstrap('b@x.com'), false);
  const a = await s.allowlist.get('a@x.com');
  assert.ok(a);
  assert.equal(a.role, 'admin');
  assert.equal(a.addedBy, 'bootstrap');
  assert.equal(await s.allowlist.count(), 1);
  // demoting / deleting the only admin is refused (nothing written)
  assert.equal(await s.allowlist.put('a@x.com', 'member', 'a@x.com'), 'last_admin');
  assert.equal(await s.allowlist.delete('a@x.com'), 'last_admin');
  assert.equal((await s.allowlist.get('a@x.com'))?.role, 'admin');
  // insert a member
  const c = await s.allowlist.put('c@x.com', 'member', 'a@x.com');
  assert.ok(c !== 'last_admin');
  assert.deepEqual({ email: c.email, role: c.role, addedBy: c.addedBy }, { email: 'c@x.com', role: 'member', addedBy: 'a@x.com' });
  // changing a role keeps addedBy / createdAt
  await new Promise((r) => setTimeout(r, 5));
  const c2 = await s.allowlist.put('c@x.com', 'admin', 'someone@x.com');
  assert.ok(c2 !== 'last_admin');
  assert.equal(c2.role, 'admin');
  assert.equal(c2.addedBy, 'a@x.com');
  assert.equal(c2.createdAt, c.createdAt);
  // two admins → one may be demoted/deleted
  assert.ok((await s.allowlist.put('a@x.com', 'member', 'c@x.com')) !== 'last_admin');
  assert.equal(await s.allowlist.put('c@x.com', 'member', 'c@x.com'), 'last_admin');
  assert.equal(await s.allowlist.delete('c@x.com'), 'last_admin');
  assert.equal(await s.allowlist.delete('a@x.com'), 'ok');
  assert.equal(await s.allowlist.delete('a@x.com'), 'not_found');
  await s.allowlist.put('b@x.com', 'member', 'c@x.com');
  assert.deepEqual((await s.allowlist.list()).map((e) => e.email), ['b@x.com', 'c@x.com']);
  assert.equal(await s.allowlist.count(), 2);
  // deleting a member is always fine
  assert.equal(await s.allowlist.delete('b@x.com'), 'ok');
  await s.close();
});
