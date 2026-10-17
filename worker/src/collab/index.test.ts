import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionIndexEntry, type Card, type MemoryDoc, type Project, type RpcArgs, type Session, type SessionIndexEntry, type SessionKind, type ToolName, type ToolOutcome } from '@nopear/protocol';
import type { WorkerConfig } from '../config';
import type { SessionMeta } from '../agent/meta-store';
import type { CollabLink } from './link';
import { createCollab, PROJECT_RETRY_DELAYS_MS } from './index';

type IndexFrame = { full: boolean; sessions: SessionIndexEntry[]; removed: string[] };
type CardStateFrame = { cardId: string; state: 'running' | 'review'; sessionId?: string; error?: string };
type Call = { name: ToolName; args: Record<string, unknown>; sessionId?: string };

const T = '2026-10-11T00:00:00.000Z';
const project = (id: string, path?: string): Project => ({
  id, name: `name-${id}`, description: '', paths: path ? { w1: path } : {}, createdAt: T, updatedAt: T,
});
const mem = (scope: 'global' | 'project', projectId: string | null, content: string): MemoryDoc =>
  ({ scope, projectId, content, updatedAt: T }) as MemoryDoc;

class FakeLink implements CollabLink {
  readonly workerId = 'w1';
  isConnected = false;
  calls: Call[] = [];
  index: IndexFrame[] = [];
  states: CardStateFrame[] = [];
  projects: Project[] = [project('p1', '/proj'), project('p_gone', '/gone')];
  memories: Record<string, string> = { global: 'G-MEM', 'project:p1': 'P1-MEM' };
  failProjectList = false;
  /** SaaS-side claim state: unclaimed → collaboration tools answer forbidden. */
  claimed = true;
  /** Set → project_list replies wait until released by hand (oldest first in `pending`). */
  deferProjectList = false;
  pending: ((o: ToolOutcome) => void)[] = [];
  conn = new Set<() => void>();
  cardsFns = new Set<(c: Card[]) => void>();
  projFns = new Set<() => void>();
  claimFns = new Set<(s: { claimed: boolean; userId?: string }) => void>();
  connected(): boolean { return this.isConnected; }
  async callTool(name: ToolName, args: Record<string, unknown>, sessionId?: string): Promise<ToolOutcome> {
    this.calls.push({ name, args, ...(sessionId ? { sessionId } : {}) });
    if (!this.claimed) return { ok: false, error: { code: 'forbidden', message: 'worker not claimed' } };
    if (name === 'project_list') {
      if (this.deferProjectList) return new Promise<ToolOutcome>((r) => this.pending.push(r));
      if (this.failProjectList) return { ok: false, error: { code: 'saas_unreachable', message: 'down' } };
      return { ok: true, result: { projects: this.projects } };
    }
    if (name === 'memory_get') {
      const key = args.scope === 'global' ? 'global' : `project:${String(args.projectId)}`;
      return { ok: true, result: { memory: mem(args.scope as 'global' | 'project', (args.projectId as string) ?? null, this.memories[key] ?? '') } };
    }
    return { ok: true, result: { echoed: name } };
  }
  sendIndex(f: IndexFrame): void { this.index.push(f); }
  sendCardState(f: CardStateFrame): void { this.states.push(f); }
  onCards(fn: (cards: Card[]) => void): () => void { this.cardsFns.add(fn); return () => { this.cardsFns.delete(fn); }; }
  onProjectsChanged(fn: () => void): () => void { this.projFns.add(fn); return () => { this.projFns.delete(fn); }; }
  onConnected(fn: () => void): () => void { this.conn.add(fn); return () => { this.conn.delete(fn); }; }
  onClaimChanged(fn: (s: { claimed: boolean; userId?: string }) => void): () => void { this.claimFns.add(fn); return () => { this.claimFns.delete(fn); }; }
  claimChange(claimed: boolean, userId?: string): void {
    this.claimed = claimed;
    for (const fn of this.claimFns) fn(claimed ? { claimed, ...(userId ? { userId } : {}) } : { claimed });
  }
  connect(): void { this.isConnected = true; for (const fn of this.conn) fn(); }
  pushCards(cards: Card[]): void { for (const fn of this.cardsFns) fn(cards); }
  projectsChanged(): void { for (const fn of this.projFns) fn(); }
}

const session = (id: string, extra: Partial<Session> = {}): Session => ({
  id, workerId: 'w1', kind: 'chat', title: id, cwd: '/x', status: 'idle', createdAt: T, lastActivityAt: T, preview: '',
  pinned: false, starred: false, archived: false, model: 'faux/echo', thinking: 'medium', promptCount: 0, taskCount: 0, ...extra,
});

class FakeHost {
  sessions = new Map<string, Session>([
    ['a', session('a', { projectId: 'p1' })],
    ['b', session('b', { projectId: 'p_gone' })],
    ['c', session('c')],
  ]);
  updates: RpcArgs<'sessions.update'>[] = [];
  created: { args: RpcArgs<'sessions.create'>; opts: { projectId?: string; cwd?: string; title?: string } }[] = [];
  listeners = new Set<(s: Session, removed?: boolean) => void>();
  private n = 0;
  list(_a: { kinds?: SessionKind[] }): Session[] { return [...this.sessions.values()]; }
  onSessionChange(l: (s: Session, removed?: boolean) => void): () => void { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
  async update(args: RpcArgs<'sessions.update'>): Promise<Session> {
    this.updates.push(args);
    const cur = this.sessions.get(args.sessionId)!;
    const next = { ...cur };
    if (args.projectId === null) delete next.projectId;
    this.sessions.set(next.id, next);
    for (const l of this.listeners) l(next);
    return next;
  }
  async create(args: RpcArgs<'sessions.create'>, opts: { projectId?: string; cwd?: string; title?: string }): Promise<Session> {
    this.created.push({ args, opts });
    const s = session(`new${++this.n}`, { status: 'running', cwd: opts.cwd ?? '/' });
    this.sessions.set(s.id, s);
    return s;
  }
  get(id: string): Session { const s = this.sessions.get(id); if (!s) throw new Error('not found'); return s; }
  /** sessionId → resolves that session's pending waitIdle (the session "finishes"). */
  idle = new Map<string, () => void>();
  waitIdle(id: string): Promise<void> { return new Promise((r) => { this.idle.set(id, r); }); }
  async interrupt(_id: string): Promise<void> {}
  lastError(_id: string): string | undefined { return undefined; }
}

const config = { cardWip: 1, defaultCwd: '/home/def' } as WorkerConfig;
const meta = (id: string, projectId?: string): SessionMeta => ({
  id, kind: 'chat', ...(projectId ? { projectId } : {}), title: id, cwd: '/x', sessionFile: '', createdAt: T, lastActivityAt: T,
  preview: '', pinned: false, starred: false, archived: false, model: 'faux/echo', thinking: 'medium',
});
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
const card = (id: string, extra: Partial<Card> = {}): Card => ({
  id, projectId: 'p1', title: 'T', body: 'B', state: 'queued', workerId: 'w1', sessionId: null, order: 1,
  createdAt: T, updatedAt: T, ...extra,
});

/** Fake retry scheduler: timers are fired by hand; `cancelled` counts cancel() calls on still-pending timers. */
class FakeTimers {
  pending: { fn: () => void; ms: number; live: boolean }[] = [];
  cancelled = 0;
  schedule = (fn: () => void, ms: number): (() => void) => {
    const t = { fn, ms, live: true };
    this.pending.push(t);
    return () => { if (t.live) { t.live = false; this.cancelled++; } };
  };
  live(): { fn: () => void; ms: number; live: boolean }[] { return this.pending.filter((t) => t.live); }
  delays(): number[] { return this.pending.map((t) => t.ms); }
  /** Fires the single live timer. */
  fire(): void {
    const l = this.live();
    assert.equal(l.length, 1, 'exactly one retry timer pending');
    l[0]!.live = false;
    l[0]!.fn();
  }
}

function setup() {
  const link = new FakeLink();
  const host = new FakeHost();
  const timers = new FakeTimers();
  const collab = createCollab({ config, workerId: 'w1', scheduleRetry: timers.schedule });
  return { link, host, collab, timers };
}
const projectLists = (link: FakeLink) => link.calls.filter((c) => c.name === 'project_list').length;

test('hooks are usable before attach: tools report saas_unreachable, no project match, no memory', async () => {
  const { collab } = setup();
  assert.equal(collab.hooks.autoProject('/proj'), undefined);
  assert.equal(collab.hooks.systemPromptAppend(meta('s1')), undefined);
  await collab.hooks.onTagged('p1'); // must not throw
  const tools = collab.hooks.extraTools(meta('s1'));
  assert.equal(tools.length, 15);
  const r = await tools[0]!.execute('t1', {} as never, undefined, undefined, undefined as never);
  assert.match((r.content[0] as { text: string }).text, /saas_unreachable/);
});

test('onConnected: project_list + global memory fetched, full index sent; autoProject uses the cache', async () => {
  const { link, host, collab } = setup();
  collab.attach(link, host);
  link.connect();
  await flush();
  assert.ok(link.calls.some((c) => c.name === 'project_list'));
  assert.ok(link.calls.some((c) => c.name === 'memory_get' && c.args.scope === 'global'));
  assert.equal(link.index.filter((f) => f.full).length, 1);
  assert.equal(collab.hooks.autoProject('/proj/sub'), 'p1');
  assert.equal(collab.hooks.autoProject('/projx'), undefined);
});

test('onTagged prefetches project memory; systemPromptAppend returns the memory sections', async () => {
  const { link, host, collab } = setup();
  collab.attach(link, host);
  link.connect();
  await flush();
  await collab.hooks.onTagged('p1');
  assert.ok(link.calls.some((c) => c.name === 'memory_get' && c.args.scope === 'project' && c.args.projectId === 'p1'));
  const out = collab.hooks.systemPromptAppend(meta('s1', 'p1'))!;
  assert.match(out, /# 用户全局记忆\n\nG-MEM/);
  assert.match(out, /# 项目记忆（name-p1）\n\nP1-MEM/);
  assert.equal(collab.hooks.systemPromptAppend(meta('s2')), '# 用户全局记忆\n\nG-MEM');
});

test('extraTools(meta) returns 15 tools bound to meta.id', async () => {
  const { link, host, collab } = setup();
  collab.attach(link, host);
  link.connect();
  await flush();
  const tools = collab.hooks.extraTools(meta('sess-42'));
  assert.equal(tools.length, 15);
  const t = tools.find((x) => x.name === 'card_list')!;
  await t.execute('t1', {} as never, undefined, undefined, undefined as never);
  assert.deepEqual(link.calls.at(-1), { name: 'card_list', args: {}, sessionId: 'sess-42' });
});

test('onProjectsChanged: projects refetched and stale tags cleared', async () => {
  const { link, host, collab } = setup();
  collab.attach(link, host);
  link.connect();
  await flush();
  assert.deepEqual(host.updates, [], 'all tags valid on connect');
  link.projects = [project('p1', '/proj')];
  const before = link.calls.filter((c) => c.name === 'project_list').length;
  link.projectsChanged();
  await flush();
  assert.equal(link.calls.filter((c) => c.name === 'project_list').length, before + 1);
  assert.deepEqual(host.updates, [{ sessionId: 'b', projectId: null }]);
  assert.ok(link.index.some((f) => !f.full && f.sessions.some((s) => s.sessionId === 'b' && s.projectId === null)), 'index delta sent');
});

test('a failed project_list never clears tags', async () => {
  const { link, host, collab } = setup();
  link.failProjectList = true;
  collab.attach(link, host);
  link.connect();
  await flush();
  link.projectsChanged();
  await flush();
  assert.deepEqual(host.updates, []);
});

test('onCards reaches the executor: a queued card creates a session in the project path', async () => {
  const { link, host, collab } = setup();
  collab.attach(link, host);
  link.connect();
  link.pushCards([card('c1')]); // arrives before project_list answers: must wait for the refresh
  await flush();
  assert.equal(host.created.length, 1);
  assert.deepEqual(host.created[0]!.opts, { projectId: 'p1', cwd: '/proj', title: 'T' });
  assert.deepEqual(link.states.at(-1), { cardId: 'c1', state: 'running', sessionId: 'new1' });
});

test('detach unsubscribes everything (all link + host listeners, incl. the card executor\'s)', async () => {
  const { link, host, collab } = setup();
  const detach = collab.attach(link, host);
  assert.ok(link.conn.size > 0 && link.claimFns.size > 0 && host.listeners.size > 0);
  detach();
  assert.equal(link.conn.size, 0, 'onConnected listeners');
  assert.equal(link.cardsFns.size, 0, 'onCards listeners');
  assert.equal(link.projFns.size, 0, 'onProjectsChanged listeners');
  assert.equal(link.claimFns.size, 0, 'onClaimChanged listeners');
  assert.equal(host.listeners.size, 0, 'session change listeners');
  link.connect();
  link.pushCards([card('c1')]);
  await flush();
  assert.equal(link.calls.length, 0);
  assert.equal(link.index.length, 0);
  assert.equal(host.created.length, 0);
});

test('claimed after connecting (QR): cache rebuilt — projects, global memory and a full index', async () => {
  const { link, host, collab } = setup();
  link.claimed = false;
  collab.attach(link, host);
  link.connect();
  await flush();
  assert.equal(collab.hooks.autoProject('/proj'), undefined, 'unclaimed at connect: tools forbidden, nothing cached');
  assert.equal(collab.hooks.systemPromptAppend(meta('s1')), undefined);
  const fullBefore = link.index.filter((f) => f.full).length;
  link.calls = [];
  link.claimChange(true, 'u1');
  await flush();
  assert.ok(link.calls.some((c) => c.name === 'project_list'));
  assert.ok(link.calls.some((c) => c.name === 'memory_get' && c.args.scope === 'global'));
  assert.equal(link.index.filter((f) => f.full).length, fullBefore + 1, 'pre-claim sessions indexed');
  assert.deepEqual(link.index.at(-1), { full: true, sessions: host.list({}).map((s) => sessionIndexEntry(s)), removed: [] });
  assert.equal(collab.hooks.autoProject('/proj/sub'), 'p1');
  assert.equal(collab.hooks.systemPromptAppend(meta('s1')), '# 用户全局记忆\n\nG-MEM');
});

test('unbind: the old owner\'s projects and memories are dropped; nothing refetched, tags untouched', async () => {
  const { link, host, collab } = setup();
  collab.attach(link, host);
  link.connect();
  await flush();
  await collab.hooks.onTagged('p1');
  assert.equal(collab.hooks.autoProject('/proj'), 'p1');
  link.calls = [];
  const indexBefore = link.index.length;
  link.claimChange(false);
  await flush();
  assert.equal(collab.hooks.autoProject('/proj'), undefined, 'no auto-tagging with the old owner\'s paths');
  assert.equal(collab.hooks.systemPromptAppend(meta('s1', 'p1')), undefined);
  assert.equal(link.calls.filter((c) => c.name === 'project_list').length, 0);
  assert.equal(link.index.length, indexBefore, 'no full index while unclaimed');
  assert.deepEqual(host.updates, []);
});

test('unbind while a refresh is in flight: its late reply neither repopulates the cache nor clears tags', async () => {
  const { link, host, collab } = setup();
  collab.attach(link, host);
  link.deferProjectList = true;
  link.connect();
  await flush();
  assert.equal(link.pending.length, 1);
  link.claimChange(false);
  link.pending[0]!({ ok: true, result: { projects: [project('p_gone', '/gone')] } });
  await flush();
  assert.equal(collab.hooks.autoProject('/gone'), undefined);
  assert.deepEqual(host.updates, []);
});

test('overlapping refreshes: an older project_list reply arriving last neither clears valid tags nor wins the cache', async () => {
  const { link, host, collab } = setup();
  collab.attach(link, host);
  link.deferProjectList = true;
  link.connect(); // refresh #1
  await flush();
  link.projectsChanged(); // refresh #2
  await flush();
  assert.equal(link.pending.length, 2);
  link.pending[1]!({ ok: true, result: { projects: [project('p1', '/proj'), project('p_gone', '/gone')] } });
  await flush();
  link.pending[0]!({ ok: true, result: { projects: [project('p_gone', '/gone')] } }); // stale: lacks p1
  await flush();
  assert.deepEqual(host.updates, [], 'session a keeps its valid p1 tag');
  assert.equal(collab.hooks.autoProject('/proj'), 'p1');
});

test('unbound while offline: on reconnect unclaimed, the old owner\'s queued cards are dropped and none starts later', async () => {
  const { link, host, collab } = setup();
  collab.attach(link, host);
  link.connect();
  // c2 has no project: it would start in defaultCwd even with the (reset) project cache empty.
  link.pushCards([card('c1', { order: 1 }), card('c2', { order: 2, projectId: null })]);
  await flush();
  assert.equal(host.created.length, 1, 'wip 1: only c1 runs');
  // Tunnel drops; SaaS unbinds meanwhile (its cards:[] dispatch reaches nobody). Reconnect: hello says unclaimed.
  link.isConnected = false;
  link.connect();
  link.claimChange(false);
  await flush();
  const statesBefore = link.states.length;
  host.idle.get('new1')!(); // c1's session finishes
  await flush();
  assert.equal(host.created.length, 1, 'stale c2 must not start');
  assert.deepEqual(link.states.slice(statesBefore), [], 'nothing reported for the old owner\'s cards');
});

test('unbind while a cards frame waits for the refresh: the old owner\'s frame is dropped', async () => {
  const { link, host, collab } = setup();
  collab.attach(link, host);
  link.deferProjectList = true;
  link.connect();
  link.pushCards([card('c1', { projectId: null })]); // waits for the in-flight project_list
  await flush();
  link.claimChange(false);
  link.pending[0]!({ ok: true, result: { projects: [] } });
  await flush();
  assert.equal(host.created.length, 0);
  assert.deepEqual(link.states, []);
});

test('project_list fails at connect: queued project cards stay queued (no review), start after the next good refresh', async () => {
  const { link, host, collab } = setup();
  link.failProjectList = true;
  collab.attach(link, host);
  link.connect();
  link.pushCards([card('c1')]);
  await flush();
  assert.equal(host.created.length, 0);
  assert.deepEqual(link.states, [], 'no "no local path" review while projects are unknown');
  link.failProjectList = false;
  link.projectsChanged();
  await flush();
  assert.equal(host.created.length, 1);
  assert.deepEqual(host.created[0]!.opts, { projectId: 'p1', cwd: '/proj', title: 'T' });
  assert.deepEqual(link.states, [{ cardId: 'c1', state: 'running', sessionId: 'new1' }]);
});

test('after unbind + reclaim, project cards wait for the new owner\'s project list', async () => {
  const { link, host, collab } = setup();
  collab.attach(link, host);
  link.connect();
  await flush();
  link.claimChange(false);
  link.failProjectList = true;
  link.claimChange(true, 'u2');
  link.pushCards([card('c1')]);
  await flush();
  assert.equal(host.created.length, 0);
  assert.deepEqual(link.states, []);
  link.failProjectList = false;
  link.connect();
  await flush();
  assert.equal(host.created.length, 1);
});

test('default project_list retry backoff is 5s → 10s → 20s → 60s cap', () => {
  assert.deepEqual(PROJECT_RETRY_DELAYS_MS, [5_000, 10_000, 20_000, 60_000]);
});

test('failed first project_list is retried with backoff until it succeeds; held project cards then start; one warning', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const { link, host, collab, timers } = setup();
  link.failProjectList = true;
  collab.attach(link, host);
  link.connect();
  link.pushCards([card('c1')]);
  await flush();
  assert.equal(projectLists(link), 1);
  for (let i = 0; i < 4; i++) { timers.fire(); await flush(); }
  assert.equal(projectLists(link), 5);
  link.pushCards([card('c1')]); // same held card pushed again: no second warning
  await flush();
  assert.deepEqual(timers.delays(), [5_000, 10_000, 20_000, 60_000, 60_000]);
  assert.equal(host.created.length, 0);
  const held = warn.mock.calls.filter((c) => /held/.test(String(c.arguments[0])));
  assert.equal(held.length, 1, 'one "project cards held" warning');
  link.failProjectList = false;
  timers.fire();
  await flush();
  assert.equal(projectLists(link), 6);
  assert.equal(host.created.length, 1, 'held card started after the retry succeeded');
  assert.equal(timers.live().length, 0, 'no further retry after success');
});

test('retry stops while disconnected; the next connect restarts the backoff', async () => {
  const { link, host, collab, timers } = setup();
  link.failProjectList = true;
  collab.attach(link, host);
  link.connect();
  await flush();
  timers.fire(); await flush(); // 5s retry fails → 10s scheduled
  link.isConnected = false;
  timers.fire(); await flush();
  assert.equal(projectLists(link), 2, 'no project_list while disconnected');
  assert.equal(timers.live().length, 0, 'no reschedule while disconnected');
  link.connect();
  await flush();
  assert.equal(projectLists(link), 3);
  assert.deepEqual(timers.live().map((x) => x.ms), [5_000], 'backoff restarts at 5s');
});

test('unbind cancels the pending retry; a reclaim restarts it at 5s', async () => {
  const { link, host, collab, timers } = setup();
  link.failProjectList = true;
  collab.attach(link, host);
  link.connect();
  await flush();
  timers.fire(); await flush();
  assert.equal(timers.live().length, 1);
  link.claimChange(false);
  await flush();
  assert.equal(timers.live().length, 0, 'retry cancelled on unbind');
  assert.equal(timers.cancelled, 1);
  link.claimChange(true, 'u2'); // FakeLink: still failing
  await flush();
  assert.deepEqual(timers.live().map((x) => x.ms), [5_000]);
});

test('detach cancels the pending retry', async () => {
  const { link, host, collab, timers } = setup();
  link.failProjectList = true;
  const detach = collab.attach(link, host);
  link.connect();
  await flush();
  assert.equal(timers.live().length, 1);
  detach();
  assert.equal(timers.live().length, 0);
  assert.equal(timers.cancelled, 1);
});

test('no retry once project_list succeeded', async () => {
  const { link, host, collab, timers } = setup();
  collab.attach(link, host);
  link.connect();
  await flush();
  assert.equal(timers.pending.length, 0);
});
