import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEventBus } from '@earendil-works/pi-coding-agent';
import type { BackgroundTask } from '@nopear/protocol';
import { TaskTracker, describeRun, type RunStatus } from './tasks';

interface Req { version: number; requestId: string; method: string; params: unknown }

function fakeSubagents(runs: () => unknown[], opts: { silent?: () => boolean } = {}) {
  const bus = createEventBus();
  const requests: Req[] = [];
  bus.on('subagents:rpc:v1:request', (d) => {
    const r = d as Req;
    requests.push(r);
    if (opts.silent?.()) return;
    queueMicrotask(() => bus.emit(`subagents:rpc:v1:reply:${r.requestId}`,
      r.method === 'status'
        ? { version: 1, requestId: r.requestId, success: true, data: { asyncSnapshot: { runs: runs() } } }
        : { version: 1, requestId: r.requestId, success: true, data: {} }));
  });
  return { bus, requests };
}
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test('without status files: active + finished runs from the snapshot; ISO startedAt from epoch ms', async () => {
  const runs = [{ id: 'r1', kind: 'subagent', label: 'review diff', state: 'running', startedAt: 1700000000000 }, { id: 'r2', state: 'complete', kind: 'x', label: 'y' }];
  const { bus, requests } = fakeSubagents(() => runs);
  const changes: BackgroundTask[][] = [];
  const t = new TaskTracker({ eventBus: bus, onChange: (x) => changes.push(x), pollMs: 10_000, readStatus: () => null });
  await t.refresh();
  assert.deepEqual(t.current()[0], { id: 'r1', agent: 'subagent', goal: 'review diff', state: 'running', startedAt: '2023-11-14T22:13:20.000Z' });
  assert.equal(t.current()[1]!.state, 'complete');
  assert.deepEqual(t.active().map((x) => x.id), ['r1']);
  assert.equal(changes.length, 1);
  assert.deepEqual(requests[0], { version: 1, requestId: requests[0]!.requestId, method: 'status', params: {} });
  await t.refresh(); // unchanged → no extra onChange
  assert.equal(changes.length, 1);
  t.dispose();
});

test('async-complete triggers refresh; stop sends stop RPC', async () => {
  let runs: unknown[] = [{ id: 'r1', kind: 'subagent', label: 'g', state: 'queued' }];
  const { bus, requests } = fakeSubagents(() => runs);
  const changes: BackgroundTask[][] = [];
  const t = new TaskTracker({ eventBus: bus, onChange: (x) => changes.push(x), pollMs: 10_000, readStatus: () => null });
  bus.emit('subagent:async-started', {});
  await tick();
  assert.equal(t.current().length, 1);
  assert.match(t.current()[0]!.startedAt, /^\d{4}-\d\d-\d\dT/); // first-seen time when no startedAt
  runs = [];
  bus.emit('subagent:async-complete', {});
  await tick();
  assert.deepEqual(t.current(), []);
  assert.equal(changes.length, 2);
  await t.stop('r1');
  assert.deepEqual(requests.find((r) => r.method === 'stop')?.params, { id: 'r1' });
  t.dispose();
});

test('RPC timeout keeps the previous snapshot', async () => {
  let silent = false;
  const { bus } = fakeSubagents(() => [{ id: 'r1', kind: 'k', label: 'l', state: 'paused', startedAt: 1 }], { silent: () => silent });
  const logs: string[] = [];
  const t = new TaskTracker({ eventBus: bus, onChange: () => {}, pollMs: 10_000, rpcTimeoutMs: 30, log: (m) => logs.push(m), readStatus: () => null });
  await t.refresh();
  assert.equal(t.current().length, 1);
  silent = true;
  await t.refresh();
  assert.equal(t.current().length, 1);
  assert.ok(logs.some((l) => /timeout/i.test(l)));
  t.dispose();
});

test('polls while tasks are active', async () => {
  const { bus, requests } = fakeSubagents(() => [{ id: 'r1', kind: 'k', label: 'l', state: 'running', startedAt: 1 }]);
  const t = new TaskTracker({ eventBus: bus, onChange: () => {}, pollMs: 15, readStatus: () => null });
  await t.refresh();
  const n = requests.length;
  await tick(60);
  assert.ok(requests.length > n);
  t.dispose();
  const m = requests.length;
  await tick(40);
  assert.equal(requests.length, m);
});

test('a workflow is described by its steps, not by its agent list', async () => {
  const wf = { id: 'w1', kind: 'workflow', label: 'delegate, delegate, delegate', state: 'running', startedAt: 1700000000000, children: [
    { id: 'media', label: 'media', state: 'running' }, { id: 'publish', label: 'publish', state: 'running' },
    { id: 'web', label: 'web', state: 'complete' }, { id: 'x', label: 'x', state: 'failed' },
  ] };
  assert.equal(describeRun(wf), 'media、publish 进行中 · 1/4 完成');
  assert.equal(describeRun({ ...wf, children: [{ id: 'a', label: 'a', state: 'complete' }, { id: 'b', label: 'b', state: 'complete' }] }), '2/2 完成');
  assert.equal(describeRun({ label: 'delegate', children: [{ id: 'delegate', label: 'delegate', state: 'running' }] }), 'delegate');
  assert.equal(describeRun({ label: 'review diff' }), 'review diff');
  const { bus } = fakeSubagents(() => [wf]);
  const t = new TaskTracker({ eventBus: bus, onChange: () => {}, pollMs: 10_000 });
  await t.refresh();
  assert.equal(t.current()[0]!.goal, 'media、publish 进行中 · 1/4 完成');
  t.dispose();
});

// ---- enriched from pi-subagents' status.json ----

const T0 = 1792348971000;
function statusReader(map: Record<string, RunStatus>) { return (id: string) => map[id] ?? null; }

test('single run: goal from the prompt preview, model, current tool, turns; failure reason kept', async () => {
  const st: Record<string, RunStatus> = {
    a1: { runId: 'a1', mode: 'single', state: 'running', startedAt: T0, steps: [{
      agent: 'delegate', sessionName: 'delegate: Verify the publish flow on staging', description: '[prompt redacted]', status: 'running',
      model: 'p/m', currentTool: 'bash', currentToolArgs: 'kubectl get pods', recentTools: [{ tool: 'read', args: 'a.ts' }],
      recentOutput: ['', 'Now write the tests.'], turnCount: 12, toolCount: 30, lastActivityAt: T0 + 5000, sessionFile: '/s/a1/run-0/session.jsonl' }] },
    f1: { runId: 'f1', mode: 'single', state: 'failed', startedAt: T0, endedAt: T0 + 60_000, error: '400 quota', steps: [{
      agent: 'delegate', sessionName: 'delegate: Answer the ask', status: 'failed', error: '400 {"message":"Third-party apps now draw from extra usage"}',
      recentTools: [{ tool: 'edit', args: 'x.ts' }], turnCount: 69 }] },
  };
  const { bus } = fakeSubagents(() => [{ id: 'a1', kind: 'subagent', label: 'delegate', state: 'running', startedAt: T0 }, { id: 'f1', kind: 'subagent', label: 'delegate', state: 'failed', startedAt: T0 }]);
  const t = new TaskTracker({ eventBus: bus, onChange: () => {}, pollMs: 10_000, readStatus: statusReader(st) });
  await t.refresh();
  const [a, f] = t.current();
  assert.deepEqual(a, { id: 'a1', state: 'running', startedAt: new Date(T0).toISOString(), agent: 'delegate', goal: 'Verify the publish flow on staging',
    transcript: { runId: 'a1', step: 0 }, model: 'p/m',
    activity: { tool: 'bash', toolArgs: 'kubectl get pods', turns: 12, tools: 30, output: 'Now write the tests.', lastActivityAt: new Date(T0 + 5000).toISOString() } });
  assert.equal(f!.state, 'failed');
  assert.equal(f!.endedAt, new Date(T0 + 60_000).toISOString());
  assert.match(f!.error!, /Third-party apps/);
  assert.deepEqual(f!.activity, { tool: 'edit', toolArgs: 'x.ts', turns: 69 }); // last tool when nothing runs now
  t.dispose();
});

test('workflow: steps from their own runs, listed once (child runs are not repeated at top level)', async () => {
  const st: Record<string, RunStatus> = {
    wf: { runId: 'wf', mode: 'workflow', state: 'running', startedAt: T0, steps: [
      { agent: 'delegate', label: 'media', workflowKey: 'media', status: 'running', runId: 'c1' },
      { agent: 'delegate', label: 'web', workflowKey: 'web', status: 'completed', runId: 'c2' },
      { agent: 'delegate', label: 'later', workflowKey: 'later', status: 'pending' },
    ] },
    c1: { runId: 'c1', mode: 'single', state: 'running', parentWorkflowRunId: 'wf', startedAt: T0 + 1, steps: [{ agent: 'delegate', status: 'running', model: 'p/m', currentTool: 'bash', turnCount: 3 }] },
    c2: { runId: 'c2', mode: 'single', state: 'complete', parentWorkflowRunId: 'wf', startedAt: T0 + 2, endedAt: T0 + 9, steps: [{ agent: 'delegate', status: 'complete', turnCount: 9 }] },
  };
  const { bus } = fakeSubagents(() => [
    { id: 'wf', kind: 'workflow', label: 'delegate, delegate, delegate', state: 'running', startedAt: T0 },
    { id: 'c1', kind: 'subagent', label: 'delegate', state: 'running', startedAt: T0 + 1 },
    { id: 'c2', kind: 'subagent', label: 'delegate', state: 'complete', startedAt: T0 + 2 },
  ]);
  const t = new TaskTracker({ eventBus: bus, onChange: () => {}, pollMs: 10_000, readStatus: statusReader(st) });
  await t.refresh();
  assert.deepEqual(t.current().map((x) => x.id), ['wf']);
  const wf = t.current()[0]!;
  assert.equal(wf.agent, 'workflow');
  assert.equal(wf.goal, 'media 进行中 · 1/3 完成');
  assert.equal(wf.transcript, undefined);
  assert.deepEqual(wf.steps!.map((s) => [s.label, s.state, s.transcript]), [
    ['media', 'running', { runId: 'c1', step: 0 }], ['web', 'complete', { runId: 'c2', step: 0 }], ['later', 'queued', { runId: 'wf', step: 2 }]]);
  assert.deepEqual(wf.steps![0]!.activity, { tool: 'bash', turns: 3 });
  assert.equal(wf.steps![0]!.model, 'p/m');
  assert.equal(wf.steps![1]!.endedAt, new Date(T0 + 9).toISOString());
  t.dispose();
});

test('finished runs stay listed after pi-subagents forgets them (newest first, capped); a vanished active run settles from its file', async () => {
  let runs: Array<Record<string, unknown>> = Array.from({ length: 10 }, (_, i) => ({ id: `d${i}`, kind: 'subagent', label: `job ${i}`, state: 'complete', startedAt: T0 }));
  const st: Record<string, RunStatus> = Object.fromEntries(runs.map((r, i) => [String(r.id), { runId: String(r.id), mode: 'single', state: 'complete', startedAt: T0, endedAt: T0 + i * 1000, steps: [{ agent: 'a', sessionName: `a: job ${i}`, status: 'complete' }] }]));
  runs.push({ id: 'live', kind: 'subagent', label: 'live', state: 'running', startedAt: T0 });
  st.live = { runId: 'live', mode: 'single', state: 'running', startedAt: T0, steps: [{ agent: 'a', sessionName: 'a: live one', status: 'running' }] };
  const { bus } = fakeSubagents(() => runs);
  const t = new TaskTracker({ eventBus: bus, onChange: () => {}, pollMs: 10_000, readStatus: statusReader(st) });
  await t.refresh();
  assert.equal(t.current()[0]!.id, 'live');
  assert.deepEqual(t.current().slice(1).map((x) => x.id), ['d9', 'd8', 'd7', 'd6', 'd5', 'd4', 'd3', 'd2']); // 8 newest
  // pi-subagents drops everything; the live run ended in between
  runs = [];
  st.live = { ...st.live, state: 'failed', endedAt: T0 + 99_000, error: 'boom' };
  await t.refresh();
  assert.deepEqual(t.active(), []);
  assert.deepEqual(t.current().slice(0, 2).map((x) => [x.id, x.state]), [['live', 'failed'], ['d9', 'complete']]);
  assert.equal(t.current()[0]!.error, 'boom');
  assert.equal(t.current().length, 8);
  t.dispose();
});

test('stops polling once nothing is active', async () => {
  let runs: unknown[] = [{ id: 'r1', kind: 'k', label: 'l', state: 'running', startedAt: 1 }];
  const { bus, requests } = fakeSubagents(() => runs);
  const t = new TaskTracker({ eventBus: bus, onChange: () => {}, pollMs: 15, readStatus: () => null });
  await t.refresh();
  runs = [{ id: 'r1', kind: 'k', label: 'l', state: 'complete', startedAt: 1 }];
  await tick(60);
  assert.equal(t.current()[0]!.state, 'complete');
  const n = requests.length;
  await tick(50);
  assert.equal(requests.length, n);
  t.dispose();
});
