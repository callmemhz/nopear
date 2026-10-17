import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CARD_STATES, validateToolArgs,
  type Message, type RpcOp, type SaasEvent, type SaasToWorker, type Session, type SessionIndexEntry, type ToolOutcome,
} from '@nopear/protocol';
import { Collab, type CollabHub } from './collab';
import { openStore } from './store';
import { executeTool, TOOL_HTTP_STATUS } from './tools';

class FakeHub implements CollabHub {
  online = new Set<string>();
  frames: { workerId: string; f: SaasToWorker }[] = [];
  rpcs: { workerId: string; op: RpcOp; args: unknown }[] = [];
  outcomes = new Map<string, ToolOutcome>();
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
  async pushAuthz(): Promise<void> {}
}

async function setup() {
  const store = await openStore('sqlite::memory:');
  const hub = new FakeHub();
  const events: SaasEvent[] = [];
  const collab = new Collab({ store, hub, events: { emit: (_u, e) => { events.push(e); } } });
  const u = (await store.users.upsertDev('u@x.com')).id;
  const other = (await store.users.upsertDev('o@x.com')).id;
  for (const [w, owner] of [['w_a', u], ['w_b', u], ['w_o', other]] as const) {
    await store.workers.register(w, `${w}-pub`, `${w}-hash`);
    await store.workers.claimDirect(w, owner, w.toUpperCase());
    await store.workers.update(w, { version: '3.1.0' }); // hello'd as a v3.1 worker (plaintext-capable)
  }
  await store.workers.register('w_free', 'free-pub', 'free-hash');
  const asUser = { userId: u, workerId: null };
  const asWorker = { userId: u, workerId: 'w_a' };
  const ok = async (caller: { userId: string; workerId: string | null }, name: string, args: unknown) => {
    const o = await executeTool(collab, caller, name, args);
    assert.ok(o.ok, `${name} failed: ${JSON.stringify(o)}`);
    return o.result as Record<string, any>;
  };
  const errCode = async (caller: { userId: string; workerId: string | null }, name: string, args: unknown) => {
    const o = await executeTool(collab, caller, name, args);
    assert.equal(o.ok, false, `${name} unexpectedly ok`);
    return (o as Extract<ToolOutcome, { ok: false }>).error;
  };
  return { store, hub, events, collab, u, other, asUser, asWorker, ok, errCode };
}

const session = (id: string, over: Partial<Session> = {}): Session => ({
  id, workerId: 'w_b', kind: 'chat', title: 't', cwd: '/', status: 'idle', createdAt: '', lastActivityAt: '', preview: '',
  pinned: false, starred: false, archived: false, model: 'm', thinking: 'off', promptCount: 0, taskCount: 0, ...over,
});

test('project tools', async () => {
  const { ok, errCode, asUser, asWorker, collab, u } = await setup();
  assert.deepEqual(await errCode(asUser, 'project_create', { name: 'P', path: '/x' }), {
    code: 'bad_request', message: 'path requires a calling machine',
  });
  const { project } = await ok(asWorker, 'project_create', { name: 'P', description: 'd', path: '/src/p' });
  assert.equal(project.name, 'P'); assert.equal(project.description, 'd');
  assert.deepEqual(project.paths, { w_a: '/src/p' });
  const plain = (await ok(asUser, 'project_create', { name: 'Q' })).project;
  assert.deepEqual(plain.paths, {});
  assert.equal((await errCode(asWorker, 'project_create', { name: 'R', path: 'rel/p' })).code, 'bad_request');
  assert.equal((await errCode(asWorker, 'project_update', { projectId: plain.id, path: 'rel/p' })).code, 'bad_request');

  await collab.putMemory(u, 'project', project.id, 'm'.repeat(300));
  const list = (await ok(asWorker, 'project_list', {})).projects as any[];
  assert.equal(list.length, 2);
  assert.equal(list[0].id, project.id);
  assert.equal(list[0].memoryPreview, 'm'.repeat(200));
  assert.equal(list[1].memoryPreview, '');
  assert.deepEqual(list[0].paths, { w_a: '/src/p' });

  const c = await collab.createCard(u, { title: 'c', projectId: project.id });
  await collab.createCard(u, { title: 'c2', projectId: project.id });
  await collab.patchCard(u, c.id, { state: 'done' });
  const got = await ok(asUser, 'project_get', { projectId: project.id });
  assert.equal(got.project.id, project.id);
  assert.equal(got.memory.content, 'm'.repeat(300));
  assert.deepEqual(Object.keys(got.cardCounts).sort(), [...CARD_STATES].sort());
  assert.deepEqual(got.cardCounts, { inbox: 1, queued: 0, running: 0, review: 0, done: 1 });
  assert.equal((await errCode(asUser, 'project_get', { projectId: 'p_nope' })).code, 'not_found');

  // project_update: only the calling machine's path changes
  await collab.updateProject(u, project.id, { paths: { w_a: '/src/p', w_b: '/b/p' } });
  const up = (await ok(asWorker, 'project_update', { projectId: project.id, name: 'P2', path: '/new' })).project;
  assert.equal(up.name, 'P2');
  assert.deepEqual(up.paths, { w_a: '/new', w_b: '/b/p' });
  assert.equal((await errCode(asUser, 'project_update', { projectId: project.id, path: '/x' })).code, 'bad_request');
  const up2 = (await ok(asUser, 'project_update', { projectId: project.id, description: 'dd' })).project;
  assert.equal(up2.description, 'dd');
});

test('card tools', async () => {
  const { ok, errCode, asUser, asWorker, hub } = await setup();
  hub.online.add('w_b');
  const p = (await ok(asUser, 'project_create', { name: 'P' })).project;
  const a = (await ok(asWorker, 'card_create', { title: 'a', body: 'b', projectId: p.id })).card;
  assert.equal(a.state, 'inbox'); assert.equal(a.projectId, p.id); assert.equal(a.body, 'b');
  const b = (await ok(asWorker, 'card_create', { title: 'b', projectId: null })).card;
  assert.equal(b.order, 1); assert.equal(b.projectId, null);

  const upd = (await ok(asUser, 'card_update', { cardId: b.id, title: 'B', projectId: p.id })).card;
  assert.equal(upd.title, 'B'); assert.equal(upd.projectId, p.id); assert.equal(upd.state, 'inbox');

  const moved = (await ok(asUser, 'card_move', { cardId: a.id, state: 'queued', workerId: 'w_b' })).card;
  assert.equal(moved.state, 'queued'); assert.equal(moved.workerId, 'w_b');
  assert.equal(hub.frames.filter((x) => x.f.t === 'cards').length, 1);
  assert.equal((await errCode(asUser, 'card_move', { cardId: a.id, state: 'queued' })).code, 'bad_request');
  assert.equal((await errCode(asUser, 'card_move', { cardId: a.id, state: 'queued', workerId: 'w_o' })).code, 'forbidden');
  assert.equal((await errCode(asUser, 'card_move', { cardId: a.id, state: 'running' })).code, 'bad_request');

  assert.deepEqual(((await ok(asUser, 'card_list', {})).cards as any[]).map((c) => c.id), [a.id, b.id]);
  assert.deepEqual(((await ok(asUser, 'card_list', { state: 'queued', workerId: 'w_b' })).cards as any[]).map((c) => c.id), [a.id]);
  assert.deepEqual(((await ok(asUser, 'card_list', { projectId: p.id, state: 'inbox' })).cards as any[]).map((c) => c.id), [b.id]);
});

test('memory tools', async () => {
  const { ok, errCode, asUser } = await setup();
  const m0 = (await ok(asUser, 'memory_get', { scope: 'global' })).memory;
  assert.deepEqual(m0, { scope: 'global', projectId: null, content: '', updatedAt: '' });
  const m1 = (await ok(asUser, 'memory_update', { scope: 'global', content: 'one', mode: 'append' })).memory;
  assert.equal(m1.content, 'one');
  const m2 = (await ok(asUser, 'memory_update', { scope: 'global', projectId: null, content: 'two', mode: 'append' })).memory;
  assert.equal(m2.content, 'one\ntwo');
  const m3 = (await ok(asUser, 'memory_update', { scope: 'global', content: 'three', mode: 'replace' })).memory;
  assert.equal(m3.content, 'three');
  const p = (await ok(asUser, 'project_create', { name: 'P' })).project;
  const pm = (await ok(asUser, 'memory_update', { scope: 'project', projectId: p.id, content: 'pm', mode: 'replace' })).memory;
  assert.equal(pm.projectId, p.id);
  assert.equal((await ok(asUser, 'memory_get', { scope: 'project', projectId: p.id })).memory.content, 'pm');
  assert.equal((await errCode(asUser, 'memory_get', { scope: 'project', projectId: 'p_nope' })).code, 'not_found');
  assert.equal((await errCode(asUser, 'memory_update', { scope: 'global', content: 'x'.repeat(64 * 1024), mode: 'append' })).code, 'too_large');
});

test('machine_list and session_list', async () => {
  const { ok, asUser, hub, collab, u } = await setup();
  hub.online.add('w_a');
  const c = await collab.createCard(u, { title: 'run' });
  await collab.patchCard(u, c.id, { state: 'queued', workerId: 'w_a' });
  await collab.onCardState('w_a', { t: 'card.state', cardId: c.id, state: 'running', sessionId: 's' });
  const machines = ((await ok(asUser, 'machine_list', {})).machines as any[]).sort((x, y) => x.workerId.localeCompare(y.workerId));
  assert.deepEqual(machines.map((m) => Object.keys(m).sort()), [
    ['label', 'online', 'runningCards', 'workerId'], ['label', 'online', 'runningCards', 'workerId'],
  ]);
  assert.deepEqual(machines.map((m) => [m.workerId, m.label, m.online, m.runningCards.map((x: any) => x.id)]), [
    ['w_a', 'W_A', true, [c.id]], ['w_b', 'W_B', false, []],
  ]);

  const entries: SessionIndexEntry[] = Array.from({ length: 60 }, (_, i) => ({
    workerId: 'w_a', sessionId: `s${i}`, title: i === 3 ? 'Needle here' : `t${i}`, preview: '', status: 'idle',
    projectId: null, cwd: '/', createdAt: '2026-01-01T00:00:00Z', lastActivityAt: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`,
  }));
  await collab.onIndex('w_a', { t: 'index', full: true, sessions: entries, removed: [] });
  assert.equal(((await ok(asUser, 'session_list', {})).sessions as any[]).length, 50);
  assert.equal(((await ok(asUser, 'session_list', { limit: 500 })).sessions as any[]).length, 60);
  assert.deepEqual(((await ok(asUser, 'session_list', { q: 'needle' })).sessions as any[]).map((s) => s.sessionId), ['s3']);
  assert.equal(((await ok(asUser, 'session_list', { workerId: 'w_b' })).sessions as any[]).length, 0);
});

test('session_history maps blocks to text', async () => {
  const { ok, asWorker, hub } = await setup();
  hub.online.add('w_b');
  const msgs: Message[] = [
    { id: 'm1', sessionId: 's1', role: 'user', ts: '2026-01-01T00:00:00Z', status: 'complete', blocks: [
      { type: 'text', text: 'look' }, { type: 'image', mediaType: 'image/png', blob: 'h' },
    ] },
    { id: 'm2', sessionId: 's1', role: 'assistant', ts: '2026-01-01T00:00:01Z', status: 'complete', blocks: [
      { type: 'thinking', text: 'hmm' }, { type: 'text', text: 'ok' }, { type: 'tool_call', id: 't1', name: 'bash', input: {} },
    ] },
  ];
  hub.outcomes.set('messages.page', { ok: true, result: { messages: msgs, hasMore: false } });
  const r = await ok(asWorker, 'session_history', { workerId: 'w_b', sessionId: 's1' });
  assert.deepEqual(r, { messages: [
    { role: 'user', ts: '2026-01-01T00:00:00Z', text: 'look\n[image]' },
    { role: 'assistant', ts: '2026-01-01T00:00:01Z', text: 'ok\n[tool bash]' },
  ] });
  assert.deepEqual(hub.rpcs, [{ workerId: 'w_b', op: 'messages.page', args: { sessionId: 's1', limit: 50 } }]);
  await ok(asWorker, 'session_history', { workerId: 'w_b', sessionId: 's1', limit: 5 });
  assert.deepEqual(hub.rpcs[1]!.args, { sessionId: 's1', limit: 5 });
});

test('session_start and session_tag', async () => {
  const { ok, errCode, asUser, hub, collab, u } = await setup();
  hub.online.add('w_b');
  const p = await collab.createProject(u, { name: 'P', paths: { w_b: '/b/p' } });
  hub.outcomes.set('sessions.create', { ok: true, result: { session: session('s-new') } });
  assert.deepEqual(await ok(asUser, 'session_start', { workerId: 'w_b', prompt: 'hi', projectId: p.id }), { sessionId: 's-new' });
  const a0 = hub.rpcs[0]!.args as Record<string, unknown>;
  assert.equal(hub.rpcs[0]!.op, 'sessions.create');
  assert.match(String(a0.clientMsgId), /^tool-.+/);
  assert.deepEqual({ ...a0, clientMsgId: undefined }, { text: 'hi', clientMsgId: undefined, cwd: '/b/p', projectId: p.id });
  // explicit cwd wins; no project → no cwd/projectId
  await ok(asUser, 'session_start', { workerId: 'w_b', prompt: 'x', projectId: p.id, cwd: '/other' });
  assert.equal((hub.rpcs[1]!.args as any).cwd, '/other');
  await ok(asUser, 'session_start', { workerId: 'w_b', prompt: 'y' });
  const a2 = hub.rpcs[2]!.args as Record<string, unknown>;
  assert.equal('cwd' in a2, false); assert.equal('projectId' in a2, false);
  assert.equal((await errCode(asUser, 'session_start', { workerId: 'w_b', prompt: 'z', projectId: 'p_nope' })).code, 'not_found');

  hub.outcomes.set('sessions.update', { ok: true, result: { session: session('s-new', { projectId: p.id }) } });
  assert.deepEqual(await ok(asUser, 'session_tag', { workerId: 'w_b', sessionId: 's-new', projectId: p.id }), { ok: true });
  assert.deepEqual(hub.rpcs.at(-1), { workerId: 'w_b', op: 'sessions.update', args: { sessionId: 's-new', projectId: p.id } });
  assert.deepEqual(await ok(asUser, 'session_tag', { workerId: 'w_b', sessionId: 's-new', projectId: null }), { ok: true });
  assert.deepEqual(hub.rpcs.at(-1)!.args, { sessionId: 's-new', projectId: null });
  assert.equal((await errCode(asUser, 'session_tag', { workerId: 'w_b', sessionId: 's', projectId: 'p_nope' })).code, 'not_found');
});

test('session-class tool gates', async () => {
  const { errCode, asUser, hub, collab, u } = await setup();
  const hist = { workerId: 'w_b', sessionId: 's1' };
  // target offline
  assert.equal((await errCode(asUser, 'session_history', hist)).code, 'machine_offline');
  hub.online.add('w_b'); hub.online.add('w_o');
  // not owned / unknown
  assert.equal((await errCode(asUser, 'session_history', { workerId: 'w_o', sessionId: 's1' })).code, 'forbidden');
  assert.equal((await errCode(asUser, 'session_start', { workerId: 'w_ghost', prompt: 'x' })).code, 'forbidden');
  // plainRpc outcomes pass through
  hub.outcomes.set('messages.page', { ok: false, error: { code: 'timeout', message: 'worker did not respond in time' } });
  assert.deepEqual(await errCode(asUser, 'session_history', hist), { code: 'timeout', message: 'worker did not respond in time' });
  hub.outcomes.set('messages.page', { ok: false, error: { code: 'e2e_enabled', message: 'plaintext disabled on this worker' } });
  assert.equal((await errCode(asUser, 'session_history', hist)).code, 'e2e_enabled');
  // account E2E on → e2e_enabled before touching the worker
  await collab.setSettings(u, { e2e: true });
  const before = hub.rpcs.length;
  assert.equal((await errCode(asUser, 'session_history', hist)).code, 'e2e_enabled');
  assert.equal((await errCode(asUser, 'session_start', { workerId: 'w_b', prompt: 'x' })).code, 'e2e_enabled');
  assert.equal((await errCode(asUser, 'session_tag', { workerId: 'w_b', sessionId: 's', projectId: null })).code, 'e2e_enabled');
  assert.equal(hub.rpcs.length, before);
  // session_list (not session-class) still works with E2E on
  const o = await executeTool(collab, asUser, 'session_list', {});
  assert.equal(o.ok, true);
});

test('session-class tools to a pre-3.1 worker (cannot read plaintext) → e2e_enabled without an rpc', async () => {
  const { errCode, ok, asUser, hub, store } = await setup();
  hub.online.add('w_b');
  hub.outcomes.set('messages.page', { ok: true, result: { messages: [], hasMore: false } });
  hub.outcomes.set('sessions.create', { ok: true, result: { session: session('s') } });
  hub.outcomes.set('sessions.update', { ok: true, result: { session: session('s') } });
  for (const version of ['3.0.0', '3.0', '3', '', 'garbage', '2.9.9']) {
    await store.workers.update('w_b', { version });
    for (const [name, args] of [
      ['session_history', { workerId: 'w_b', sessionId: 's1' }],
      ['session_start', { workerId: 'w_b', prompt: 'x' }],
      ['session_tag', { workerId: 'w_b', sessionId: 's', projectId: null }],
    ] as const) {
      const e = await errCode(asUser, name, args);
      assert.equal(e.code, 'e2e_enabled', `${name} @ ${JSON.stringify(version)}`);
    }
  }
  assert.equal(hub.rpcs.length, 0);
  for (const version of ['3.1.0', '3.1', '3.10.2', '4.0.0']) {
    await store.workers.update('w_b', { version });
    await ok(asUser, 'session_history', { workerId: 'w_b', sessionId: 's1' });
  }
  assert.equal(hub.rpcs.length, 4);
});

test('schema violations → bad_request with the validateToolArgs message', async () => {
  const { errCode, asUser } = await setup();
  const cases: [string, unknown][] = [
    ['card_create', {}],
    ['card_move', { cardId: 'c', state: 'running' }],
    ['project_list', { extra: 1 }],
    ['session_list', { limit: 501 }],
    ['nope_tool', {}],
    ['project_list', null],
  ];
  for (const [name, args] of cases) {
    const msg = validateToolArgs(name, args);
    assert.ok(msg);
    assert.deepEqual(await errCode(asUser, name, args), { code: 'bad_request', message: msg });
  }
});

test('onTool from an unclaimed worker → forbidden; claimed → caller workerId', async () => {
  const { collab } = await setup();
  const denied = await collab.onTool('w_free', { t: 'tool', id: '1', name: 'project_list', args: {} });
  assert.equal(denied.ok, false);
  assert.equal((denied as Extract<ToolOutcome, { ok: false }>).error.code, 'forbidden');
  const ghost = await collab.onTool('w_ghost', { t: 'tool', id: '2', name: 'project_list', args: {} });
  assert.equal((ghost as Extract<ToolOutcome, { ok: false }>).error.code, 'forbidden');
  const made = await collab.onTool('w_a', { t: 'tool', id: '3', name: 'project_create', args: { name: 'P', path: '/w/a' } });
  assert.ok(made.ok);
  assert.deepEqual((made.result as any).project.paths, { w_a: '/w/a' });
});

test('TOOL_HTTP_STATUS mapping', () => {
  assert.deepEqual(TOOL_HTTP_STATUS, {
    bad_request: 400, forbidden: 403, not_found: 404, too_large: 413, e2e_enabled: 409,
    machine_offline: 503, timeout: 504, internal: 500, saas_unreachable: 502,
  });
});
