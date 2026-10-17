import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Card, RpcArgs, Session, SessionIndexEntry, SessionStatus, ToolName, ToolOutcome } from '@nopear/protocol';
import type { CollabLink } from './link';
import { CardExecutor, type ExecutorHost } from './executor';

type CardStateFrame = { cardId: string; state: 'running' | 'review'; sessionId?: string; error?: string };
class FakeLink implements CollabLink {
  readonly workerId = 'w1';
  states: CardStateFrame[] = [];
  /** Tunnel down: card.state frames are silently dropped (like TunnelClient.send). */
  down = false;
  private connectedFns = new Set<() => void>();
  connected(): boolean { return !this.down; }
  async callTool(_n: ToolName, _a: Record<string, unknown>, _s?: string): Promise<ToolOutcome> {
    return { ok: false, error: { code: 'internal', message: 'unused' } };
  }
  sendIndex(_f: { full: boolean; sessions: SessionIndexEntry[]; removed: string[] }): void {}
  sendCardState(f: CardStateFrame): void { if (!this.down) this.states.push(f); }
  onCards(_fn: (cards: Card[]) => void): () => void { return () => {}; }
  onProjectsChanged(_fn: () => void): () => void { return () => {}; }
  onConnected(fn: () => void): () => void { this.connectedFns.add(fn); return () => this.connectedFns.delete(fn); }
  onClaimChanged(_fn: (s: { claimed: boolean; userId?: string }) => void): () => void { return () => {}; }
  listenerCount(): number { return this.connectedFns.size; }
  /** Tunnel comes back: fires the onConnected listeners (right after hello, before SaaS's first cards frame). */
  reconnect(): void { this.down = false; for (const fn of this.connectedFns) fn(); }
}

const T = '2026-10-11T00:00:00.000Z';
function session(id: string, status: SessionStatus, cwd = '/'): Session {
  return { id, workerId: 'w1', kind: 'chat', title: id, cwd, status, createdAt: T, lastActivityAt: T, preview: '',
    pinned: false, starred: false, archived: false, model: 'faux/echo', thinking: 'medium', promptCount: 0, taskCount: 0 };
}

class FakeHost implements ExecutorHost {
  created: { args: RpcArgs<'sessions.create'>; opts: { projectId?: string; cwd?: string; title?: string } }[] = [];
  interrupted: string[] = [];
  status = new Map<string, SessionStatus>();
  errors = new Map<string, string>();
  private idle = new Map<string, () => void>();
  private n = 0;
  async create(args: RpcArgs<'sessions.create'>, opts: { projectId?: string; cwd?: string; title?: string }): Promise<Session> {
    const id = `s${++this.n}`;
    this.created.push({ args, opts });
    this.status.set(id, 'running');
    return session(id, 'running', opts.cwd);
  }
  get(id: string): Session {
    const st = this.status.get(id);
    if (!st) throw Object.assign(new Error(`no session ${id}`), { code: 'not_found' });
    return session(id, st);
  }
  waitIdle(id: string): Promise<void> {
    if (this.status.get(id) !== 'running') return Promise.resolve();
    return new Promise((r) => this.idle.set(id, r));
  }
  async interrupt(id: string): Promise<void> { this.interrupted.push(id); this.finish(id, 'idle'); }
  lastError(id: string): string | undefined { return this.errors.get(id); }
  /** Ends a running session with the given final status. */
  finish(id: string, status: SessionStatus, error?: string): void {
    this.status.set(id, status);
    if (error) this.errors.set(id, error);
    const r = this.idle.get(id);
    this.idle.delete(id);
    r?.();
  }
}

const card = (id: string, extra: Partial<Card> = {}): Card => ({
  id, projectId: 'p1', title: 'T', body: 'B', state: 'queued', workerId: 'w1', sessionId: null, order: 1,
  createdAt: T, updatedAt: T, ...extra,
});
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

function setup(wip = 1, paths: Record<string, string> = { p1: '/proj' }) {
  const host = new FakeHost();
  const link = new FakeLink();
  const ex = new CardExecutor({ host, link, wip, defaultCwd: '/home/def', projectPath: (id) => paths[id] });
  return { host, link, ex };
}

test('queued card → create session in project path, report running, then review on idle', async () => {
  const { host, link, ex } = setup();
  ex.onCards([card('c1')]);
  await flush();
  assert.equal(host.created.length, 1);
  const { args, opts } = host.created[0]!;
  assert.equal(args.text, '# T\n\nB');
  assert.equal(typeof args.clientMsgId, 'string');
  assert.ok(args.clientMsgId.length > 0);
  assert.deepEqual(opts, { projectId: 'p1', cwd: '/proj', title: 'T' });
  assert.deepEqual(link.states, [{ cardId: 'c1', state: 'running', sessionId: 's1' }]);
  ex.onCards([card('c1', { state: 'running', sessionId: 's1' })]); // SaaS echoes the running state
  await flush();
  assert.equal(host.created.length, 1);
  host.finish('s1', 'idle');
  await flush();
  assert.deepEqual(link.states.slice(1), [{ cardId: 'c1', state: 'review' }]);
});

test('session ending in error → review with lastError', async () => {
  const { host, link, ex } = setup();
  ex.onCards([card('c1')]);
  await flush();
  host.finish('s1', 'error', 'model exploded');
  await flush();
  assert.deepEqual(link.states.at(-1), { cardId: 'c1', state: 'review', error: 'model exploded' });
});

test('card without project → default cwd and no projectId', async () => {
  const { host, ex } = setup();
  ex.onCards([card('c1', { projectId: null })]);
  await flush();
  assert.deepEqual(host.created[0]!.opts, { cwd: '/home/def', title: 'T' });
});

test('project without a local path → review with error and no session (reported once)', async () => {
  const { host, link, ex } = setup(1, {});
  ex.onCards([card('c1')]);
  await flush();
  ex.onCards([card('c1')]); // stale frame before SaaS applied the review
  await flush();
  assert.equal(host.created.length, 0);
  assert.deepEqual(link.states, [{ cardId: 'c1', state: 'review', error: '该项目在本机没有路径' }]);
});

test('missing-path card does not block the wip slot', async () => {
  const { host, link, ex } = setup(1, { p2: '/two' });
  ex.onCards([card('c1', { order: 1 }), card('c2', { projectId: 'p2', order: 2 })]);
  await flush();
  assert.deepEqual(link.states, [
    { cardId: 'c1', state: 'review', error: '该项目在本机没有路径' },
    { cardId: 'c2', state: 'running', sessionId: 's1' },
  ]);
  assert.equal(host.created.length, 1);
});

test('wip 1: second queued card waits until the first finishes', async () => {
  const { host, link, ex } = setup();
  ex.onCards([card('c2', { order: 2, title: 'Second' }), card('c1', { order: 1, title: 'First' })]);
  await flush();
  assert.equal(host.created.length, 1);
  assert.equal(host.created[0]!.opts.title, 'First');
  ex.onCards([card('c1', { state: 'running', sessionId: 's1' }), card('c2', { order: 2, title: 'Second' })]);
  await flush();
  assert.equal(host.created.length, 1);
  host.finish('s1', 'idle');
  await flush();
  assert.equal(host.created.length, 2);
  assert.equal(host.created[1]!.opts.title, 'Second');
  assert.deepEqual(link.states, [
    { cardId: 'c1', state: 'running', sessionId: 's1' },
    { cardId: 'c1', state: 'review' },
    { cardId: 'c2', state: 'running', sessionId: 's2' },
  ]);
});

test('running card leaving the set → interrupt and no review', async () => {
  const { host, link, ex } = setup();
  ex.onCards([card('c1')]);
  await flush();
  ex.onCards([]);
  await flush();
  assert.deepEqual(host.interrupted, ['s1']);
  assert.deepEqual(link.states, [{ cardId: 'c1', state: 'running', sessionId: 's1' }]);
});

test('card moved to another worker is treated as leaving the set', async () => {
  const { host, link, ex } = setup();
  ex.onCards([card('c1')]);
  await flush();
  ex.onCards([card('c1', { workerId: 'w2' })]);
  await flush();
  assert.deepEqual(host.interrupted, ['s1']);
  assert.equal(link.states.length, 1);
});

test('interrupt errors are swallowed and the slot frees up', async () => {
  const { host, link, ex } = setup();
  host.interrupt = async () => { throw new Error('boom'); };
  ex.onCards([card('c1')]);
  await flush();
  ex.onCards([card('c2', { title: 'Next' })]);
  await flush();
  assert.equal(host.created.length, 2);
  assert.deepEqual(link.states.at(-1), { cardId: 'c2', state: 'running', sessionId: 's2' });
});

test('wip 2 runs two at once ordered by order', async () => {
  const { host, ex } = setup(2);
  ex.onCards([card('c3', { order: 3, title: 'C' }), card('c1', { order: 1, title: 'A' }), card('c2', { order: 2, title: 'B' })]);
  await flush();
  assert.deepEqual(host.created.map((c) => c.opts.title), ['A', 'B']);
  host.finish('s1', 'idle');
  await flush();
  assert.deepEqual(host.created.map((c) => c.opts.title), ['A', 'B', 'C']);
});

test('reconcile: untracked running card whose session is idle or missing → review', async () => {
  const { host, link, ex } = setup();
  host.status.set('old', 'idle');
  ex.onCards([card('c1', { state: 'running', sessionId: 'old' }), card('c2', { state: 'running', sessionId: 'gone' })]);
  await flush();
  assert.deepEqual(link.states, [{ cardId: 'c1', state: 'review' }, { cardId: 'c2', state: 'review' }]);
  assert.equal(host.created.length, 0);
});

test('reconcile: untracked running card whose session still runs → nothing', async () => {
  const { host, link, ex } = setup();
  host.status.set('live', 'running');
  ex.onCards([card('c1', { state: 'running', sessionId: 'live' })]);
  await flush();
  assert.deepEqual(link.states, []);
  assert.deepEqual(host.interrupted, []);
});

test('stale queued frame after the run finished does not start the card again', async () => {
  const { host, ex } = setup();
  ex.onCards([card('c1')]);
  await flush();
  host.finish('s1', 'idle');
  await flush();
  ex.onCards([card('c1')]); // frame sent by SaaS before it applied our running/review reports
  await flush();
  assert.equal(host.created.length, 1);
  ex.onCards([]);
  ex.onCards([card('c1', { updatedAt: '2026-10-11T01:00:00.000Z' })]); // re-queued by the user
  await flush();
  assert.equal(host.created.length, 2);
});

test('create failure → review with the error message', async () => {
  const { host, link, ex } = setup();
  host.create = async () => { throw new Error('no model available'); };
  ex.onCards([card('c1')]);
  await flush();
  assert.deepEqual(link.states, [{ cardId: 'c1', state: 'review', error: 'no model available' }]);
});

const T2 = '2026-10-11T02:00:00.000Z';

test('running card moved to queued on the same worker → interrupt, no review, new session', async () => {
  const { host, link, ex } = setup();
  ex.onCards([card('c1')]);
  await flush();
  ex.onCards([card('c1', { state: 'running', sessionId: 's1' })]);
  await flush();
  ex.onCards([card('c1', { sessionId: 's1', updatedAt: T2 })]); // user re-queued it to this machine
  await flush();
  assert.deepEqual(host.interrupted, ['s1']);
  assert.equal(host.created.length, 2);
  assert.deepEqual(link.states, [
    { cardId: 'c1', state: 'running', sessionId: 's1' },
    { cardId: 'c1', state: 'running', sessionId: 's2' },
  ]);
  ex.onCards([card('c1', { state: 'running', sessionId: 's2', updatedAt: '2026-10-11T03:00:00.000Z' })]);
  host.finish('s2', 'idle');
  await flush();
  assert.equal(host.created.length, 2);
  assert.deepEqual(link.states.at(-1), { cardId: 'c1', state: 'review' });
});

test('lost running report → re-sent after reconnect, card is not started twice', async () => {
  const { host, link, ex } = setup();
  link.down = true;
  ex.onCards([card('c1')]);
  await flush();
  assert.deepEqual(link.states, []); // running dropped while the tunnel was down
  link.reconnect();
  ex.onCards([card('c1')]); // SaaS still shows it queued with the same updatedAt
  await flush();
  assert.deepEqual(link.states, [{ cardId: 'c1', state: 'running', sessionId: 's1' }]);
  assert.equal(host.created.length, 1);
  assert.deepEqual(host.interrupted, []);
  ex.onCards([card('c1', { state: 'running', sessionId: 's1', updatedAt: T2 })]);
  host.finish('s1', 'idle');
  await flush();
  assert.deepEqual(link.states.at(-1), { cardId: 'c1', state: 'review' });
});

test('run finished while the tunnel was down with nothing delivered → running + review re-sent', async () => {
  const { host, link, ex } = setup();
  link.down = true;
  ex.onCards([card('c1')]);
  await flush();
  host.finish('s1', 'error', 'boom');
  await flush();
  link.reconnect();
  ex.onCards([card('c1')]);
  await flush();
  assert.deepEqual(link.states, [
    { cardId: 'c1', state: 'running', sessionId: 's1' },
    { cardId: 'c1', state: 'review', error: 'boom' },
  ]);
  assert.equal(host.created.length, 1);
});

test('lost missing-path review → re-reported after reconnect', async () => {
  const { host, link, ex } = setup(1, {});
  link.down = true;
  ex.onCards([card('c1')]);
  await flush();
  assert.deepEqual(link.states, []);
  link.reconnect();
  ex.onCards([card('c1')]);
  await flush();
  assert.equal(host.created.length, 0);
  assert.deepEqual(link.states, [{ cardId: 'c1', state: 'review', error: '该项目在本机没有路径' }]);
});

test('running delivered, then re-queued during an outage (echo never seen) → interrupt and restart', async () => {
  const { host, link, ex } = setup();
  ex.onCards([card('c1')]);
  await flush();
  link.down = true; // running reached SaaS, but its echo is lost
  link.reconnect();
  ex.onCards([card('c1', { sessionId: 's1', updatedAt: T2 })]);
  await flush();
  assert.deepEqual(host.interrupted, ['s1']);
  assert.equal(host.created.length, 2);
  assert.deepEqual(link.states, [
    { cardId: 'c1', state: 'running', sessionId: 's1' },
    { cardId: 'c1', state: 'running', sessionId: 's2' },
  ]);
});

test('reconnect where SaaS already applied running → nothing re-sent', async () => {
  const { host, link, ex } = setup();
  ex.onCards([card('c1')]);
  await flush();
  link.reconnect();
  ex.onCards([card('c1', { state: 'running', sessionId: 's1', updatedAt: T2 })]);
  await flush();
  assert.equal(link.states.length, 1);
  assert.deepEqual(host.interrupted, []);
  assert.equal(host.created.length, 1);
});

test('order edit before the running echo → no interrupt, no second session', async () => {
  const { host, link, ex } = setup();
  ex.onCards([card('c1')]);
  await flush();
  ex.onCards([card('c1', { order: 5, updatedAt: T2 })]); // reordered while SaaS has not applied our running yet
  await flush();
  assert.deepEqual(host.interrupted, []);
  assert.equal(host.created.length, 1);
  assert.deepEqual(link.states, [{ cardId: 'c1', state: 'running', sessionId: 's1' }]);
  ex.onCards([card('c1', { state: 'running', sessionId: 's1', order: 5, updatedAt: '2026-10-11T03:00:00.000Z' })]);
  host.finish('s1', 'idle');
  await flush();
  assert.equal(host.created.length, 1);
  assert.deepEqual(link.states.at(-1), { cardId: 'c1', state: 'review' });
});

test('title edit after the run finished but before any echo → no second session', async () => {
  const { host, link, ex } = setup();
  ex.onCards([card('c1')]);
  await flush();
  host.finish('s1', 'idle');
  await flush();
  ex.onCards([card('c1', { title: 'Renamed', updatedAt: T2 })]);
  await flush();
  assert.deepEqual(host.interrupted, []);
  assert.equal(host.created.length, 1);
  assert.deepEqual(link.states, [{ cardId: 'c1', state: 'running', sessionId: 's1' }, { cardId: 'c1', state: 'review' }]);
});

test('card edited during an outage that swallowed running → running re-sent, not stuck queued, not restarted', async () => {
  const { host, link, ex } = setup();
  link.down = true;
  ex.onCards([card('c1')]);
  await flush();
  link.reconnect();
  ex.onCards([card('c1', { title: 'Renamed', updatedAt: T2 })]);
  await flush();
  assert.deepEqual(host.interrupted, []);
  assert.equal(host.created.length, 1);
  assert.deepEqual(link.states, [{ cardId: 'c1', state: 'running', sessionId: 's1' }]);
});

test('run finished during an outage, card edited meanwhile → running + review re-sent, not restarted', async () => {
  const { host, link, ex } = setup();
  link.down = true;
  ex.onCards([card('c1')]);
  await flush();
  host.finish('s1', 'idle');
  await flush();
  link.reconnect();
  ex.onCards([card('c1', { order: 9, updatedAt: T2 })]);
  await flush();
  assert.equal(host.created.length, 1);
  assert.deepEqual(link.states, [{ cardId: 'c1', state: 'running', sessionId: 's1' }, { cardId: 'c1', state: 'review' }]);
});

test('finished card re-queued to the same machine before we saw it leave → new session', async () => {
  const { host, link, ex } = setup();
  ex.onCards([card('c1')]);
  await flush();
  host.finish('s1', 'idle');
  await flush();
  ex.onCards([card('c1', { sessionId: 's1', updatedAt: T2 })]); // review → queued again, coalesced into one frame
  await flush();
  assert.equal(host.created.length, 2);
  assert.deepEqual(link.states.at(-1), { cardId: 'c1', state: 'running', sessionId: 's2' });
});

test('dispose: unsubscribes onConnected; in-flight runs no longer report and nothing new starts', async () => {
  const { host, link, ex } = setup(1);
  assert.equal(link.listenerCount(), 1);
  ex.onCards([card('c1'), card('c2', { order: 2 })]);
  await flush();
  assert.deepEqual(link.states, [{ cardId: 'c1', state: 'running', sessionId: 's1' }]);
  ex.dispose();
  assert.equal(link.listenerCount(), 0);
  host.finish('s1', 'idle');
  await flush();
  assert.deepEqual(link.states, [{ cardId: 'c1', state: 'running', sessionId: 's1' }], 'no review after dispose');
  assert.equal(host.created.length, 1, 'c2 not started by the freed slot');
  ex.onCards([card('c3')]);
  await flush();
  assert.equal(host.created.length, 1, 'cards after dispose are ignored');
});

test('projects not loaded yet: project cards stay queued (no report, no session), no-project cards still run; resume() starts them', async () => {
  const host = new FakeHost();
  const link = new FakeLink();
  let loaded = false;
  const paths: Record<string, string> = {};
  const ex = new CardExecutor({
    host, link, wip: 2, defaultCwd: '/home/def', projectPath: (id) => paths[id], projectsReady: () => loaded,
  });
  ex.onCards([card('c1'), card('c2', { projectId: null, order: 2 })]);
  await flush();
  assert.deepEqual(host.created.map((c) => c.opts.cwd), ['/home/def'], 'only the no-project card runs');
  assert.deepEqual(link.states.map((s) => s.cardId), ['c2']);
  // A stale frame while still unloaded: c1 still waits.
  ex.onCards([card('c1'), card('c2', { projectId: null, order: 2, state: 'running', sessionId: 's1' })]);
  await flush();
  assert.equal(host.created.length, 1);
  // First good refresh arrives.
  paths.p1 = '/proj';
  loaded = true;
  ex.resume();
  await flush();
  assert.equal(host.created.length, 2);
  assert.deepEqual(host.created[1]!.opts, { projectId: 'p1', cwd: '/proj', title: 'T' });
  assert.deepEqual(link.states.filter((s) => s.cardId === 'c1'), [{ cardId: 'c1', state: 'running', sessionId: 's2' }]);
});

test('projects loaded but card project has no local path → still review + NO_LOCAL_PATH', async () => {
  const host = new FakeHost();
  const link = new FakeLink();
  const ex = new CardExecutor({ host, link, wip: 1, defaultCwd: '/home/def', projectPath: () => undefined, projectsReady: () => true });
  ex.onCards([card('c1')]);
  await flush();
  assert.equal(host.created.length, 0);
  assert.equal(link.states.length, 1);
  assert.equal(link.states[0]!.state, 'review');
});
