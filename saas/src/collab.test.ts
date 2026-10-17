import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MEMORY_MAX_BYTES,
  type Card, type RpcOp, type SaasEvent, type SaasToWorker, type SessionIndexEntry, type ToolOutcome,
} from '@nopear/protocol';
import { Collab, CollabError, type CollabHub } from './collab';
import { openStore, type SaasStore } from './store';

class FakeHub implements CollabHub {
  online = new Set<string>();
  frames: { workerId: string; f: SaasToWorker }[] = [];
  rpcs: { workerId: string; op: RpcOp; args: unknown }[] = [];
  outcomes = new Map<string, ToolOutcome>();
  authz: string[] = [];
  isOnline(workerId: string): boolean { return this.online.has(workerId); }
  sendToWorker(workerId: string, f: SaasToWorker): boolean {
    if (!this.online.has(workerId)) return false;
    this.frames.push({ workerId, f });
    return true;
  }
  async plainRpc(workerId: string, op: RpcOp, args: unknown): Promise<ToolOutcome> {
    this.rpcs.push({ workerId, op, args });
    return this.outcomes.get(op) ?? { ok: false, error: { code: 'internal', message: `no scripted outcome for ${op}` } };
  }
  async pushAuthz(workerId: string): Promise<void> { this.authz.push(workerId); }
  cardsTo(workerId: string): Card[][] {
    return this.frames.filter((x) => x.workerId === workerId && x.f.t === 'cards').map((x) => (x.f as { cards: Card[] }).cards);
  }
}

class RecEvents {
  list: { userId: string; e: SaasEvent }[] = [];
  emit(userId: string, e: SaasEvent): void { this.list.push({ userId, e }); }
  types(): string[] { return this.list.map((x) => x.e.type); }
  clear(): void { this.list = []; }
}

async function setup() {
  const store: SaasStore = await openStore('sqlite::memory:');
  const hub = new FakeHub();
  const events = new RecEvents();
  const collab = new Collab({ store, hub, events });
  const u = (await store.users.upsertDev('u@x.com')).id;
  const other = (await store.users.upsertDev('o@x.com')).id;
  for (const [w, owner] of [['w_a', u], ['w_b', u], ['w_o', other]] as const) {
    await store.workers.register(w, `${w}-pub`, `${w}-hash`);
    await store.workers.claimDirect(w, owner, w.toUpperCase());
  }
  await store.workers.register('w_free', 'free-pub', 'free-hash');
  return { store, hub, events, collab, u, other };
}

async function rejectsCode(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof CollabError && e.code === code);
}

test('createCard lands in inbox at the end', async () => {
  const { collab, events, u } = await setup();
  const a = await collab.createCard(u, { title: 'a' });
  const b = await collab.createCard(u, { title: 'b', body: 'x' });
  assert.equal(a.state, 'inbox'); assert.equal(a.order, 0);
  assert.equal(b.state, 'inbox'); assert.equal(b.order, 1);
  assert.equal(a.workerId, null); assert.equal(a.projectId, null);
  assert.deepEqual(events.types(), ['card.updated', 'card.updated']);
  await rejectsCode(collab.createCard(u, { title: 'c', projectId: 'p_nope' }), 'not_found');
});

test('createCard / patchCard / listCards reject non-string ids', async () => {
  const { collab, u } = await setup();
  const c = await collab.createCard(u, { title: 'a' });
  for (const projectId of ['', 5, ['p'], { a: 1 }, true]) {
    await rejectsCode(collab.createCard(u, { title: 'x', projectId: projectId as never }), 'bad_request');
    await rejectsCode(collab.patchCard(u, c.id, { projectId: projectId as never }), 'bad_request');
  }
  for (const workerId of [5, ['w_a'], { a: 1 }, null]) {
    await rejectsCode(collab.patchCard(u, c.id, { state: 'queued', workerId: workerId as never }), 'bad_request');
  }
  await rejectsCode(collab.listCards(u, { projectId: ['a'] as never }), 'bad_request');
  await rejectsCode(collab.listCards(u, { workerId: 5 as never }), 'bad_request');
  await rejectsCode(collab.querySessions(u, { workerId: ['a'] as never }), 'bad_request');
  await rejectsCode(collab.querySessions(u, { projectId: 5 as never }), 'bad_request');
  await rejectsCode(collab.querySessions(u, { q: {} as never }), 'bad_request');
  await rejectsCode(collab.getMemory(u, 'project', ['p'] as never), 'bad_request');
  assert.equal((await collab.patchCard(u, c.id, { projectId: null })).projectId, null);
  assert.equal((await collab.createCard(u, { title: 'y', projectId: null })).projectId, null);
});

test('move rules', async () => {
  const { collab, hub, events, u } = await setup();
  hub.online.add('w_a'); hub.online.add('w_b');
  const c = await collab.createCard(u, { title: 'a' });
  await rejectsCode(collab.patchCard(u, c.id, { state: 'running' as never }), 'bad_request');
  await rejectsCode(collab.patchCard(u, c.id, { state: 'review' as never }), 'bad_request');
  await rejectsCode(collab.patchCard(u, c.id, { state: 'queued' }), 'bad_request');
  await rejectsCode(collab.patchCard(u, c.id, { workerId: 'w_a' }), 'bad_request');
  await rejectsCode(collab.patchCard(u, c.id, { state: 'queued', workerId: 'w_o' }), 'forbidden');
  await rejectsCode(collab.patchCard(u, c.id, { state: 'queued', workerId: 'w_unknown' }), 'forbidden');
  await rejectsCode(collab.patchCard(u, 'c_nope', { title: 'x' }), 'not_found');

  // queued column of w_a already has one card at order 0
  const first = await collab.createCard(u, { title: 'first' });
  await collab.patchCard(u, first.id, { state: 'queued', workerId: 'w_a' });
  hub.frames = []; events.clear();
  const q = await collab.patchCard(u, c.id, { state: 'queued', workerId: 'w_a' });
  assert.equal(q.state, 'queued'); assert.equal(q.workerId, 'w_a'); assert.equal(q.order, 1);
  assert.deepEqual(hub.cardsTo('w_a').at(-1)!.map((x) => x.id), [first.id, c.id]);
  assert.deepEqual(events.types(), ['card.updated']);

  // worker reports running, then the user moves it to the inbox
  await collab.onCardState('w_a', { t: 'card.state', cardId: c.id, state: 'running', sessionId: 's1' });
  hub.frames = [];
  const back = await collab.patchCard(u, c.id, { state: 'inbox' });
  assert.equal(back.state, 'inbox'); assert.equal(back.workerId, null); assert.equal(back.sessionId, null);
  assert.deepEqual(hub.cardsTo('w_a').at(-1)!.map((x) => x.id), [first.id]);

  // moving to done keeps workerId
  await collab.onCardState('w_a', { t: 'card.state', cardId: first.id, state: 'running', sessionId: 's2' });
  const done = await collab.patchCard(u, first.id, { state: 'done' });
  assert.equal(done.state, 'done'); assert.equal(done.workerId, 'w_a'); assert.equal(done.sessionId, 's2');
  assert.deepEqual(hub.cardsTo('w_a').at(-1), []);

  // move between workers: both get a fresh set
  await collab.patchCard(u, c.id, { state: 'queued', workerId: 'w_a' });
  hub.frames = [];
  const moved = await collab.patchCard(u, c.id, { state: 'queued', workerId: 'w_b', order: 7 });
  assert.equal(moved.order, 7);
  assert.deepEqual(hub.cardsTo('w_a').at(-1), []);
  assert.deepEqual(hub.cardsTo('w_b').at(-1)!.map((x) => x.id), [c.id]);
});

test('card.state stale reports ignored', async () => {
  const { collab, events, u } = await setup();
  const c = await collab.createCard(u, { title: 'a' });
  // inbox card: running ignored
  await collab.onCardState('w_a', { t: 'card.state', cardId: c.id, state: 'running', sessionId: 's1' });
  assert.equal((await collab.listCards(u, {}))[0]!.state, 'inbox');
  await collab.patchCard(u, c.id, { state: 'queued', workerId: 'w_a' });
  events.clear();
  // wrong worker / review from queued without error / unknown card: ignored
  await collab.onCardState('w_b', { t: 'card.state', cardId: c.id, state: 'running', sessionId: 's1' });
  await collab.onCardState('w_a', { t: 'card.state', cardId: c.id, state: 'review' });
  await collab.onCardState('w_a', { t: 'card.state', cardId: 'c_nope', state: 'running' });
  await collab.onCardState('w_o', { t: 'card.state', cardId: c.id, state: 'running' });
  assert.equal((await collab.listCards(u, {}))[0]!.state, 'queued');
  assert.deepEqual(events.types(), []);
  // review with error from queued (missing path) is accepted
  await collab.onCardState('w_a', { t: 'card.state', cardId: c.id, state: 'review', error: 'no path' });
  let got = (await collab.listCards(u, {}))[0]!;
  assert.equal(got.state, 'review'); assert.equal(got.error, 'no path');
  assert.deepEqual(events.types(), ['card.updated']);
  // back to queued; running clears error and sets sessionId
  await collab.patchCard(u, c.id, { state: 'queued', workerId: 'w_a' });
  await collab.onCardState('w_a', { t: 'card.state', cardId: c.id, state: 'running', sessionId: 's9' });
  got = (await collab.listCards(u, {}))[0]!;
  assert.equal(got.state, 'running'); assert.equal(got.sessionId, 's9'); assert.equal(got.error, undefined);
  // running from running ignored; review from another worker ignored
  events.clear();
  await collab.onCardState('w_a', { t: 'card.state', cardId: c.id, state: 'running', sessionId: 'sX' });
  await collab.onCardState('w_b', { t: 'card.state', cardId: c.id, state: 'review' });
  assert.deepEqual(events.types(), []);
  // review from running on the same worker accepted
  await collab.onCardState('w_a', { t: 'card.state', cardId: c.id, state: 'review' });
  got = (await collab.listCards(u, {}))[0]!;
  assert.equal(got.state, 'review'); assert.equal(got.sessionId, 's9'); assert.equal(got.workerId, 'w_a');
  // review from review ignored
  events.clear();
  await collab.onCardState('w_a', { t: 'card.state', cardId: c.id, state: 'review', error: 'late' });
  assert.deepEqual(events.types(), []);
});

test('deleteCard running → worker receives cards without it', async () => {
  const { collab, hub, events, u } = await setup();
  hub.online.add('w_a');
  const c = await collab.createCard(u, { title: 'a' });
  await collab.patchCard(u, c.id, { state: 'queued', workerId: 'w_a' });
  await collab.onCardState('w_a', { t: 'card.state', cardId: c.id, state: 'running', sessionId: 's1' });
  hub.frames = []; events.clear();
  await collab.deleteCard(u, c.id);
  assert.deepEqual(hub.cardsTo('w_a'), [[]]);
  assert.deepEqual(events.list.map((x) => x.e), [{ type: 'card.removed', cardId: c.id }]);
  await rejectsCode(collab.deleteCard(u, c.id), 'not_found');
});

test('deleteProject cascades', async () => {
  const { store, collab, hub, events, u } = await setup();
  hub.online.add('w_a'); hub.online.add('w_o');
  const p = await collab.createProject(u, { name: 'P', paths: { w_a: '/src/p' } });
  const keep = await collab.createCard(u, { title: 'other' });
  const c1 = await collab.createCard(u, { title: 'a', projectId: p.id });
  const c2 = await collab.createCard(u, { title: 'b', projectId: p.id });
  await collab.patchCard(u, c1.id, { state: 'queued', workerId: 'w_a' });
  await collab.onCardState('w_a', { t: 'card.state', cardId: c1.id, state: 'running', sessionId: 's1' });
  await collab.putMemory(u, 'project', p.id, 'notes');
  const entry: SessionIndexEntry = {
    workerId: 'w_a', sessionId: 's1', title: 't', preview: '', status: 'running', projectId: p.id, cwd: '/src/p',
    createdAt: '2026-01-01T00:00:00.000Z', lastActivityAt: '2026-01-01T00:00:00.000Z',
  };
  await collab.onIndex('w_a', { t: 'index', full: true, sessions: [entry], removed: [] });
  hub.frames = []; events.clear();

  await collab.deleteProject(u, p.id);
  assert.deepEqual((await collab.listCards(u, {})).map((c) => c.id), [keep.id]);
  const removed = events.list.filter((x) => x.e.type === 'card.removed').map((x) => (x.e as { cardId: string }).cardId).sort();
  assert.deepEqual(removed, [c1.id, c2.id].sort());
  assert.ok(events.list.some((x) => x.e.type === 'project.removed' && x.e.projectId === p.id));
  assert.deepEqual(hub.cardsTo('w_a'), [[]]);
  assert.equal(await store.memories.get(u, 'project', p.id), null);
  assert.equal((await store.sessionIndex.query(u, { limit: 10 }))[0]!.projectId, null);
  assert.deepEqual(hub.frames.filter((x) => x.f.t === 'projects.changed').map((x) => x.workerId), ['w_a']);
  assert.equal(await store.projects.get(u, p.id), null);
  await rejectsCode(collab.deleteProject(u, p.id), 'not_found');
});

test('project paths validation and change notifications', async () => {
  const { collab, hub, events, u } = await setup();
  hub.online.add('w_a'); hub.online.add('w_b'); hub.online.add('w_o');
  await rejectsCode(collab.createProject(u, { name: 'P', paths: { w_o: '/x' } }), 'forbidden');
  await rejectsCode(collab.createProject(u, { name: 'P', paths: { w_free: '/x' } }), 'forbidden');
  await rejectsCode(collab.createProject(u, { name: 'P', paths: { w_a: '' } }), 'bad_request');
  for (const rel of ['relative/x', '~/x', 'C:\\x', './x', ' /x']) {
    await rejectsCode(collab.createProject(u, { name: 'P', paths: { w_a: rel } }), 'bad_request');
  }
  await rejectsCode(collab.createProject(u, { name: '' }), 'bad_request');
  const p = await collab.createProject(u, { name: 'P', description: 'd', paths: { w_a: '/a' } });
  assert.deepEqual(p.paths, { w_a: '/a' });
  assert.equal(p.description, 'd');
  assert.deepEqual(events.types(), ['project.updated']);
  assert.deepEqual(hub.frames.filter((x) => x.f.t === 'projects.changed').map((x) => x.workerId).sort(), ['w_a', 'w_b']);
  hub.frames = [];
  await rejectsCode(collab.updateProject(u, p.id, { paths: { w_o: '/x' } }), 'forbidden');
  await rejectsCode(collab.updateProject(u, p.id, { paths: { w_b: 'b' } }), 'bad_request');
  const up = await collab.updateProject(u, p.id, { paths: { w_b: '/b' }, name: 'Q' });
  assert.deepEqual(up.paths, { w_b: '/b' });
  assert.equal(up.name, 'Q');
  assert.equal(hub.frames.filter((x) => x.f.t === 'projects.changed').length, 2);
  await rejectsCode(collab.updateProject(u, 'p_nope', { name: 'x' }), 'not_found');
  await rejectsCode(collab.getProject(u, 'p_nope'), 'not_found');
  assert.equal((await collab.getProject(u, p.id)).name, 'Q');
  assert.equal((await collab.listProjects(u)).length, 1);
});

test('memory', async () => {
  const { collab, events, u, other } = await setup();
  assert.deepEqual(await collab.getMemory(u, 'global', null), { scope: 'global', projectId: null, content: '', updatedAt: '' });
  const m = await collab.putMemory(u, 'global', null, 'hello');
  assert.equal(m.content, 'hello');
  assert.deepEqual(events.list.map((x) => x.e), [{ type: 'memory.updated', memory: m }]);
  await rejectsCode(collab.putMemory(u, 'global', null, 'x'.repeat(MEMORY_MAX_BYTES + 1)), 'too_large');
  await collab.putMemory(u, 'global', null, 'x'.repeat(MEMORY_MAX_BYTES));
  await rejectsCode(collab.getMemory(u, 'project', 'p_nope'), 'not_found');
  await rejectsCode(collab.putMemory(u, 'project', 'p_nope', 'x'), 'not_found');
  await rejectsCode(collab.getMemory(u, 'project', null), 'bad_request');
  const p = await collab.createProject(u, { name: 'P' });
  await rejectsCode(collab.getMemory(other, 'project', p.id), 'not_found');
  assert.equal((await collab.getMemory(u, 'project', p.id)).content, '');
  assert.equal((await collab.putMemory(u, 'project', p.id, 'pm')).projectId, p.id);
});

const AC = { enabled: true, thresholdTokens: 300_000, keepRecentTokens: 20_000 };

test('settings', async () => {
  const { collab, hub, events, u } = await setup();
  assert.deepEqual(await collab.getSettings(u), { e2e: false, autoCompact: AC });
  const s = await collab.setSettings(u, { e2e: true });
  assert.deepEqual(s, { e2e: true, autoCompact: AC });
  assert.deepEqual(await collab.getSettings(u), { e2e: true, autoCompact: AC });
  assert.deepEqual(events.list.map((x) => x.e), [{ type: 'settings.updated', settings: { e2e: true, autoCompact: AC } }]);
  assert.deepEqual(hub.authz.sort(), ['w_a', 'w_b']);
  // PATCH semantics: autoCompact alone keeps e2e; partial objects merge; bad values are rejected.
  assert.deepEqual((await collab.setSettings(u, { autoCompact: { thresholdTokens: 500_000 } })).autoCompact,
    { enabled: true, thresholdTokens: 500_000, keepRecentTokens: 20_000 });
  assert.equal((await collab.getSettings(u)).e2e, true);
  assert.equal((await collab.setSettings(u, { autoCompact: { enabled: false } })).autoCompact.enabled, false);
  await assert.rejects(collab.setSettings(u, { autoCompact: { thresholdTokens: 'big' as unknown as number } }), /thresholdTokens/);
  await assert.rejects(collab.setSettings(u, { autoCompact: null as unknown as object }), /autoCompact/);
});

test('onIndex full replaces, incremental upserts/removes, emits session.indexed', async () => {
  const { store, collab, events, u } = await setup();
  const mk = (id: string, ts: string, workerId = 'w_a'): SessionIndexEntry => ({
    workerId, sessionId: id, title: `T ${id}`, preview: 'p', status: 'idle', projectId: null, cwd: '/',
    createdAt: ts, lastActivityAt: ts,
  });
  await collab.onIndex('w_a', { t: 'index', full: true, sessions: [mk('s1', '2026-01-01T00:00:01Z'), mk('s2', '2026-01-01T00:00:02Z')], removed: [] });
  await collab.onIndex('w_a', { t: 'index', full: true, sessions: [mk('s3', '2026-01-01T00:00:03Z')], removed: [] });
  assert.deepEqual((await store.sessionIndex.query(u, { limit: 10 })).map((e) => e.sessionId), ['s3']);
  // incremental; a forged workerId in an entry is forced to the sending worker
  await collab.onIndex('w_a', { t: 'index', full: false, sessions: [mk('s4', '2026-01-01T00:00:04Z', 'w_b')], removed: ['s3'] });
  const rows = await store.sessionIndex.query(u, { limit: 10 });
  assert.deepEqual(rows.map((e) => [e.workerId, e.sessionId]), [['w_a', 's4']]);
  assert.deepEqual(events.types(), ['session.indexed', 'session.indexed', 'session.indexed']);
  const last = events.list.at(-1)!.e;
  assert.deepEqual(last, { type: 'session.indexed', workerId: 'w_a', full: false, sessions: [mk('s4', '2026-01-01T00:00:04Z')], removed: ['s3'] });
  // unclaimed / unknown worker frames ignored
  events.clear();
  await collab.onIndex('w_free', { t: 'index', full: true, sessions: [mk('x', '2026-01-01T00:00:05Z', 'w_free')], removed: [] });
  await collab.onIndex('w_ghost', { t: 'index', full: true, sessions: [], removed: [] });
  assert.deepEqual(events.types(), []);
  // querySessions defaults + clamp
  assert.equal((await collab.querySessions(u, {})).length, 1);
  assert.equal((await collab.querySessions(u, { limit: 10_000 })).length, 1);
});

test('onHello pushes the worker cards set', async () => {
  const { collab, hub, u } = await setup();
  const c = await collab.createCard(u, { title: 'a' });
  await collab.patchCard(u, c.id, { state: 'queued', workerId: 'w_a' }); // offline: nothing sent
  assert.deepEqual(hub.frames, []);
  hub.online.add('w_a');
  await collab.onHello('w_a');
  assert.deepEqual(hub.cardsTo('w_a').map((cs) => cs.map((x) => x.id)), [[c.id]]);
});

test('dispatch is scoped to the machine\'s current owner', async () => {
  const { store, collab, hub, u, other } = await setup();
  hub.online.add('w_a');
  const c = await collab.createCard(u, { title: 'a' });
  await collab.patchCard(u, c.id, { state: 'queued', workerId: 'w_a' });
  assert.deepEqual(hub.cardsTo('w_a').map((cs) => cs.map((x) => x.id)), [[c.id]]);
  hub.frames = [];
  // unbind cascade failed (card still queued on w_a) and the machine is now unclaimed → empty set, never the old cards
  await store.workers.unclaim('w_a');
  await collab.dispatch('w_a');
  assert.deepEqual(hub.cardsTo('w_a'), [[]]);
  // offline + unclaimed → nothing sent
  hub.online.delete('w_a'); hub.frames = [];
  await collab.dispatch('w_a');
  assert.deepEqual(hub.frames, []);
  // claimed by another account → only that account's cards (none), not the previous owner's stale card
  hub.online.add('w_a');
  await store.workers.claimDirect('w_a', other, 'W_A');
  await collab.onHello('w_a');
  assert.deepEqual(hub.cardsTo('w_a'), [[]]);
  assert.equal((await store.cards.get(u, c.id))!.workerId, 'w_a');
});

test('onMachineRemoved', async () => {
  const { store, collab, hub, events, u } = await setup();
  hub.online.add('w_a');
  const p = await collab.createProject(u, { name: 'P', paths: { w_a: '/a', w_b: '/b' } });
  const pre = await collab.createCard(u, { title: 'already in inbox' });
  const q = await collab.createCard(u, { title: 'q' });
  const r = await collab.createCard(u, { title: 'r' });
  const v = await collab.createCard(u, { title: 'v' });
  const d = await collab.createCard(u, { title: 'd' });
  for (const c of [q, r, v, d]) await collab.patchCard(u, c.id, { state: 'queued', workerId: 'w_a' });
  await collab.onCardState('w_a', { t: 'card.state', cardId: r.id, state: 'running', sessionId: 's-r' });
  await collab.onCardState('w_a', { t: 'card.state', cardId: v.id, state: 'running', sessionId: 's-v' });
  await collab.onCardState('w_a', { t: 'card.state', cardId: v.id, state: 'review' });
  await collab.patchCard(u, d.id, { state: 'done' });
  await collab.onIndex('w_a', {
    t: 'index', full: true, removed: [],
    sessions: [{ workerId: 'w_a', sessionId: 's-r', title: '', preview: '', status: 'running', projectId: null, cwd: '/a', createdAt: '2026-01-01T00:00:00Z', lastActivityAt: '2026-01-01T00:00:00Z' }],
  });
  hub.frames = []; events.clear();

  await collab.onMachineRemoved(u, 'w_a');
  const cards = await collab.listCards(u, { state: 'inbox' });
  assert.deepEqual(cards.map((c) => c.id), [pre.id, q.id, r.id, v.id]);
  assert.deepEqual(cards.map((c) => c.order), [0, 1, 2, 3]);
  for (const c of cards) { assert.equal(c.workerId, null); assert.equal(c.sessionId, null); }
  assert.equal((await store.cards.get(u, d.id))!.workerId, 'w_a'); // done keeps its last worker
  assert.deepEqual(await store.sessionIndex.query(u, { limit: 10 }), []);
  assert.deepEqual((await store.projects.get(u, p.id))!.paths, { w_b: '/b' });
  const pu = events.list.filter((x) => x.e.type === 'project.updated');
  assert.equal(pu.length, 1);
  assert.equal(events.list.filter((x) => x.e.type === 'card.updated').length, 3);
  assert.deepEqual(hub.cardsTo('w_a'), [[]]);
});

test('listMachines reports online state and running cards', async () => {
  const { collab, hub, u } = await setup();
  hub.online.add('w_b');
  const c = await collab.createCard(u, { title: 'a' });
  await collab.patchCard(u, c.id, { state: 'queued', workerId: 'w_b' });
  await collab.onCardState('w_b', { t: 'card.state', cardId: c.id, state: 'running', sessionId: 's' });
  const ms = (await collab.listMachines(u)).sort((a, b) => a.workerId.localeCompare(b.workerId));
  assert.deepEqual(ms.map((m) => [m.workerId, m.label, m.online, m.runningCards.map((x) => x.id)]), [
    ['w_a', 'W_A', false, []], ['w_b', 'W_B', true, [c.id]],
  ]);
});
