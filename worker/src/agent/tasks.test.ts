import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEventBus } from '@earendil-works/pi-coding-agent';
import type { BackgroundTask } from '@nopear/protocol';
import { TaskTracker } from './tasks';

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

test('maps only active runs; ISO startedAt from epoch ms', async () => {
  const runs = [{ id: 'r1', kind: 'subagent', label: 'review diff', state: 'running', startedAt: 1700000000000 }, { id: 'r2', state: 'complete', kind: 'x', label: 'y' }];
  const { bus, requests } = fakeSubagents(() => runs);
  const changes: BackgroundTask[][] = [];
  const t = new TaskTracker({ eventBus: bus, onChange: (x) => changes.push(x), pollMs: 10_000 });
  await t.refresh();
  assert.deepEqual(t.current(), [{ id: 'r1', agent: 'subagent', goal: 'review diff', state: 'running', startedAt: '2023-11-14T22:13:20.000Z' }]);
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
  const t = new TaskTracker({ eventBus: bus, onChange: (x) => changes.push(x), pollMs: 10_000 });
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
  const t = new TaskTracker({ eventBus: bus, onChange: () => {}, pollMs: 10_000, rpcTimeoutMs: 30, log: (m) => logs.push(m) });
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
  const t = new TaskTracker({ eventBus: bus, onChange: () => {}, pollMs: 15 });
  await t.refresh();
  const n = requests.length;
  await tick(60);
  assert.ok(requests.length > n);
  t.dispose();
  const m = requests.length;
  await tick(40);
  assert.equal(requests.length, m);
});
