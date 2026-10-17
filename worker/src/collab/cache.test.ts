import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Card, MemoryDoc, Project, SessionIndexEntry, ToolName, ToolOutcome } from '@nopear/protocol';
import type { CollabLink } from './link';
import { CollabCache } from './cache';

type Call = { name: ToolName; args: Record<string, unknown>; sessionId?: string };
class FakeLink implements CollabLink {
  readonly workerId = 'w1';
  calls: Call[] = [];
  constructor(public answer: (name: ToolName, args: Record<string, unknown>) => ToolOutcome | Promise<ToolOutcome>) {}
  connected(): boolean { return true; }
  async callTool(name: ToolName, args: Record<string, unknown>, sessionId?: string): Promise<ToolOutcome> {
    this.calls.push(sessionId === undefined ? { name, args } : { name, args, sessionId });
    return this.answer(name, args);
  }
  sendIndex(_f: { full: boolean; sessions: SessionIndexEntry[]; removed: string[] }): void {}
  sendCardState(_f: { cardId: string; state: 'running' | 'review'; sessionId?: string; error?: string }): void {}
  onCards(_fn: (cards: Card[]) => void): () => void { return () => {}; }
  onProjectsChanged(_fn: () => void): () => void { return () => {}; }
  onConnected(_fn: () => void): () => void { return () => {}; }
  onClaimChanged(_fn: (s: { claimed: boolean; userId?: string }) => void): () => void { return () => {}; }
}

const T = '2026-10-11T00:00:00.000Z';
const proj = (id: string, name: string, paths: Record<string, string>): Project & { memoryPreview: string } =>
  ({ id, name, description: '', paths, createdAt: T, updatedAt: T, memoryPreview: '' });
const mem = (scope: 'global' | 'project', projectId: string | null, content: string): MemoryDoc =>
  ({ scope, projectId, content, updatedAt: T });

function setup(projects: Project[], memories: Record<string, string> = {}) {
  let clock = 1_000_000;
  const link = new FakeLink((name, args) => {
    if (name === 'project_list') return { ok: true, result: { projects } };
    if (name === 'memory_get') {
      const key = args.scope === 'global' ? 'global' : `project:${String(args.projectId)}`;
      return { ok: true, result: { memory: mem(args.scope as 'global' | 'project', (args.projectId as string) ?? null, memories[key] ?? '') } };
    }
    return { ok: false, error: { code: 'internal', message: 'unexpected' } };
  });
  const cache = new CollabCache({ link: () => link, workerId: 'w1', now: () => clock });
  return { link, cache, memories, advance: (ms: number) => { clock += ms; } };
}
const tick = () => new Promise((r) => setImmediate(r));

test('refreshProjects stores project_list and returns the project id set', async () => {
  const { link, cache } = setup([proj('p1', 'One', { w1: '/a/b' }), proj('p2', 'Two', { w2: '/x' })]);
  const ids = await cache.refreshProjects();
  assert.deepEqual([...ids!].sort(), ['p1', 'p2']);
  assert.deepEqual([...cache.projectIds()].sort(), ['p1', 'p2']);
  assert.deepEqual(link.calls, [{ name: 'project_list', args: {} }]);
  assert.equal(cache.projectPath('p1'), '/a/b');
  assert.equal(cache.projectPath('p2'), undefined);
  assert.equal(cache.projectPath('nope'), undefined);
  assert.equal(cache.projectName('p2'), 'Two');
});

test('refreshProjects returns null and keeps the old cache on error or malformed result', async () => {
  const { link, cache } = setup([proj('p1', 'One', { w1: '/a/b' })]);
  await cache.refreshProjects();
  link.answer = () => ({ ok: false, error: { code: 'saas_unreachable', message: 'down' } });
  assert.equal(await cache.refreshProjects(), null);
  link.answer = () => ({ ok: true, result: [{ id: 'p9' }] });
  assert.equal(await cache.refreshProjects(), null);
  link.answer = () => ({ ok: true, result: { projects: [{ id: 'p9' }] } });
  assert.equal(await cache.refreshProjects(), null);
  assert.deepEqual([...cache.projectIds()], ['p1']);
  assert.equal(cache.projectPath('p1'), '/a/b');
});

test('overlapping refreshProjects: a superseded (older) reply is not applied and returns null', async () => {
  const { link, cache } = setup([]);
  const replies: ((o: ToolOutcome) => void)[] = [];
  link.answer = () => new Promise<ToolOutcome>((r) => replies.push(r));
  const older = cache.refreshProjects();
  const newer = cache.refreshProjects();
  replies[1]!({ ok: true, result: { projects: [proj('p1', 'One', { w1: '/a' })] } });
  assert.deepEqual([...(await newer)!], ['p1']);
  replies[0]!({ ok: true, result: { projects: [proj('p0', 'Old', { w1: '/a' })] } });
  assert.equal(await older, null);
  assert.deepEqual([...cache.projectIds()], ['p1']);
  assert.equal(cache.matchProject('/a'), 'p1');
});

test('reset clears projects + memories and drops replies of requests started before it', async () => {
  const { link, cache } = setup([proj('p1', 'One', { w1: '/a' })], { global: 'G' });
  await cache.refreshProjects();
  await cache.prefetchMemory('global', null);
  assert.equal(cache.matchProject('/a'), 'p1');
  assert.equal(cache.systemPromptAppend({}), '# 用户全局记忆\n\nG');
  const replies: ((o: ToolOutcome) => void)[] = [];
  link.answer = () => new Promise<ToolOutcome>((r) => replies.push(r));
  const pendingList = cache.refreshProjects();
  const pendingMem = cache.prefetchMemory('global', null);
  cache.reset();
  assert.deepEqual([...cache.projectIds()], []);
  assert.equal(cache.matchProject('/a'), undefined);
  assert.equal(cache.projectName('p1'), undefined);
  // In-flight requests of the previous owner answer after the reset: discarded.
  replies[0]!({ ok: true, result: { projects: [proj('p1', 'One', { w1: '/a' })] } });
  replies[1]!({ ok: true, result: { memory: mem('global', null, 'OLD-OWNER') } });
  assert.equal(await pendingList, null);
  await pendingMem;
  assert.equal(cache.matchProject('/a'), undefined);
  // A fresh prefetch after the reset is not deduplicated into the dropped one.
  link.answer = () => ({ ok: true, result: { memory: mem('global', null, 'NEW') } });
  await cache.prefetchMemory('global', null);
  assert.equal(cache.systemPromptAppend({}), '# 用户全局记忆\n\nNEW');
});

test('matchProject: path-separator boundary, longest match wins', async () => {
  const { cache } = setup([
    proj('p1', 'B', { w1: '/a/b' }), proj('p0', 'A', { w1: '/a' }), proj('p3', 'Other', { w2: '/a/b/c' }), proj('p4', 'Slash', { w1: '/s/t/' }),
  ]);
  assert.equal(cache.matchProject('/a/b'), undefined, 'nothing before refresh');
  await cache.refreshProjects();
  assert.equal(cache.matchProject('/a/b'), 'p1');
  assert.equal(cache.matchProject('/a/b/c'), 'p1');
  assert.equal(cache.matchProject('/a/bc'), 'p0');
  assert.equal(cache.matchProject('/a'), 'p0');
  assert.equal(cache.matchProject('/ab'), undefined);
  assert.equal(cache.matchProject('/z'), undefined);
  assert.equal(cache.matchProject('/s/t'), 'p4');
  assert.equal(cache.matchProject('/s/t/u'), 'p4');
});

test('matchProject: /a/bc not matched by /a/b alone', async () => {
  const { cache } = setup([proj('p1', 'B', { w1: '/a/b' })]);
  await cache.refreshProjects();
  assert.equal(cache.matchProject('/a/bc'), undefined);
});

test('systemPromptAppend: global + project sections, empty ones omitted, untagged → global only', async () => {
  const { cache, link } = setup([proj('p1', 'Proj One', { w1: '/a' })], { global: 'G', 'project:p1': 'P' });
  assert.equal(cache.systemPromptAppend({}), undefined, 'nothing cached');
  await cache.refreshProjects();
  await cache.prefetchMemory('global', null);
  await cache.prefetchMemory('project', 'p1');
  assert.deepEqual(link.calls.filter((c) => c.name === 'memory_get').map((c) => c.args).slice(-2),
    [{ scope: 'global' }, { scope: 'project', projectId: 'p1' }]);
  assert.equal(cache.systemPromptAppend({ projectId: 'p1' }), '# 用户全局记忆\n\nG\n\n# 项目记忆（Proj One）\n\nP');
  assert.equal(cache.systemPromptAppend({}), '# 用户全局记忆\n\nG');
});

test('systemPromptAppend: empty global → only the project section; all empty → undefined', async () => {
  const { cache } = setup([proj('p1', 'Proj One', { w1: '/a' })], { 'project:p1': 'P' });
  await cache.refreshProjects();
  await cache.prefetchMemory('global', null);
  await cache.prefetchMemory('project', 'p1');
  assert.equal(cache.systemPromptAppend({ projectId: 'p1' }), '# 项目记忆（Proj One）\n\nP');
  assert.equal(cache.systemPromptAppend({}), undefined);
});

test('stale entry returns the old value and triggers exactly one background refresh', async () => {
  const { cache, link, memories, advance } = setup([], { global: 'old' });
  await cache.prefetchMemory('global', null);
  const memCalls = () => link.calls.filter((c) => c.name === 'memory_get').length;
  assert.equal(memCalls(), 1);
  advance(29_000);
  assert.equal(cache.systemPromptAppend({}), '# 用户全局记忆\n\nold');
  assert.equal(memCalls(), 1, 'fresh entry: no refresh');
  memories.global = 'new';
  advance(2_000); // 31s after fetch
  assert.equal(cache.systemPromptAppend({}), '# 用户全局记忆\n\nold');
  assert.equal(cache.systemPromptAppend({}), '# 用户全局记忆\n\nold');
  assert.equal(memCalls(), 2, 'one background refresh');
  await tick();
  assert.equal(cache.systemPromptAppend({}), '# 用户全局记忆\n\nnew');
  assert.equal(memCalls(), 2);
});

test('prefetchMemory failure keeps the previous value', async () => {
  const { cache, link } = setup([], { global: 'G' });
  await cache.prefetchMemory('global', null);
  link.answer = () => ({ ok: false, error: { code: 'timeout', message: 'slow' } });
  await cache.prefetchMemory('global', null);
  assert.equal(cache.systemPromptAppend({}), '# 用户全局记忆\n\nG');
});

test('projectsLoaded: false until the first good project_list; failures keep it false; reset clears it', async () => {
  const { link, cache } = setup([proj('p1', 'One', { w1: '/a' })]);
  assert.equal(cache.projectsLoaded(), false);
  const good = link.answer;
  link.answer = () => ({ ok: false, error: { code: 'saas_unreachable', message: 'down' } });
  await cache.refreshProjects();
  assert.equal(cache.projectsLoaded(), false, 'failed refresh');
  link.answer = () => ({ ok: true, result: { projects: [{ id: 'bad' }] } });
  await cache.refreshProjects();
  assert.equal(cache.projectsLoaded(), false, 'malformed refresh');
  link.answer = good;
  await cache.refreshProjects();
  assert.equal(cache.projectsLoaded(), true);
  link.answer = () => ({ ok: false, error: { code: 'saas_unreachable', message: 'down' } });
  await cache.refreshProjects();
  assert.equal(cache.projectsLoaded(), true, 'a later failure keeps the loaded list');
  cache.reset();
  assert.equal(cache.projectsLoaded(), false);
  // A reply to a request started before the reset does not mark the new owner's projects as loaded.
  const replies: ((o: ToolOutcome) => void)[] = [];
  link.answer = () => new Promise<ToolOutcome>((r) => replies.push(r));
  const pending = cache.refreshProjects();
  cache.reset();
  replies[0]!({ ok: true, result: { projects: [] } });
  await pending;
  assert.equal(cache.projectsLoaded(), false);
});
