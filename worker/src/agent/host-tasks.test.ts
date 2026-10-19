// tasks.transcript: a background run's own pi session, read-only, scoped to the session that launched it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type WorkerConfig } from '../config';
import { OpError } from '../errors';
import { BlobStore } from './blobs';
import { MetaStore } from './meta-store';
import { createModelRuntime } from './models';
import { SessionHost } from './host';

process.env.NOPEAR_TEST_FAUX = '1';
let cfg: WorkerConfig;
let host: SessionHost;
let meta: MetaStore;
let runs: string;
let sid = '';
let other = '';

const line = (o: unknown) => JSON.stringify(o);
const msg = (id: string, message: Record<string, unknown>) => line({ type: 'message', id, parentId: null, timestamp: '2026-10-19T01:00:00.000Z', message: { timestamp: 1, ...message } });
function writeRun(runId: string, status: Record<string, unknown>) {
  mkdirSync(join(runs, runId), { recursive: true });
  writeFileSync(join(runs, runId, 'status.json'), JSON.stringify({ runId, mode: 'single', state: 'running', startedAt: 1, ...status }));
}
function childSession(sessionId: string, dir: string, lines: string[]): string {
  const root = meta.get(sessionId)!.sessionFile.replace(/\.jsonl$/, '');
  const file = join(root, dir, 'run-0', 'session.jsonl');
  mkdirSync(join(root, dir, 'run-0'), { recursive: true });
  writeFileSync(file, lines.join('\n') + '\n');
  return file;
}
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof OpError && e.code === code);
}

before(async () => {
  const home = mkdtempSync(join(tmpdir(), 'host-tasks-'));
  cfg = loadConfig({ NOPEAR_SAAS_URL: 'http://saas.test', NOPEAR_HOME: home, NOPEAR_DEFAULT_CWD: join(home, 'work'), NOPEAR_DEFAULT_MODEL: 'faux/echo',
    NOPEAR_PI_AUTH: join(home, 'auth.json'), NOPEAR_PI_MODELS: join(home, 'models.json'), NOPEAR_IDLE_DISPOSE_MS: '60000' });
  runs = join(home, 'runs');
  meta = new MetaStore(join(cfg.home, 'sessions.json'));
  await meta.load();
  host = new SessionHost({ config: cfg, meta, blobs: new BlobStore(cfg.blobsDir), models: await createModelRuntime(cfg), workerId: 'w_test', subagentRunsDir: runs });
  await host.init();
  sid = (await host.create({ text: 'hi', clientMsgId: 'c-1' })).id;
  other = (await host.create({ text: 'other', clientMsgId: 'c-2' })).id;
  await host.waitIdle(sid);
  await host.waitIdle(other);
});
after(async () => { await host?.shutdown(); });

test('returns the child conversation (user task, assistant tool call, tool result), ids namespaced by run', async () => {
  const file = childSession(sid, 'r1dir', [
    line({ type: 'session', version: 3, id: 'x', timestamp: '2026-10-19T01:00:00.000Z', cwd: '/w' }),
    msg('e1', { role: 'user', content: [{ type: 'text', text: 'Task: verify publish' }] }),
    msg('e2', { role: 'assistant', content: [{ type: 'text', text: 'Checking.' }, { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'ls' } }], provider: 'p', model: 'm', stopReason: 'toolUse' }),
    msg('e3', { role: 'toolResult', toolCallId: 't1', toolName: 'bash', content: [{ type: 'text', text: 'a.ts' }], isError: false }),
    '{"type":"message","id":"e4","mess', // being written right now
  ]);
  writeRun('r1', { steps: [{ agent: 'delegate', status: 'running', sessionFile: file }] });
  const r = await host.taskTranscript({ sessionId: sid, runId: 'r1', step: 0 });
  assert.equal(r.state, 'running');
  assert.equal(r.hasMore, false);
  assert.deepEqual(r.messages.map((m) => [m.id, m.role]), [['r1:0:e1', 'user'], ['r1:0:e2', 'assistant'], ['r1:0:e3', 'tool']]);
  assert.deepEqual(r.messages[0]!.blocks, [{ type: 'text', text: 'Task: verify publish' }]);
  assert.equal(r.messages[1]!.model, 'p/m');
  assert.ok(r.messages[1]!.blocks.some((b) => b.type === 'tool_call' && b.name === 'bash'));
  assert.ok(r.messages[2]!.blocks.some((b) => b.type === 'tool_result' && b.text === 'a.ts'));
  const last = await host.taskTranscript({ sessionId: sid, runId: 'r1', step: 0, limit: 1 });
  assert.deepEqual(last.messages.map((m) => m.id), ['r1:0:e3']);
  assert.equal(last.hasMore, true);
});

test('a failed run reports its state; no session file yet → empty', async () => {
  writeRun('r2', { state: 'failed', steps: [{ agent: 'delegate', status: 'failed' }] });
  assert.deepEqual(await host.taskTranscript({ sessionId: sid, runId: 'r2', step: 0 }), { messages: [], hasMore: false, state: 'failed' });
});

test("refuses another session's subagents, unknown runs/steps and bad args", async () => {
  const file = childSession(other, 'odir', [msg('e1', { role: 'user', content: [{ type: 'text', text: 'secret' }] })]);
  writeRun('r3', { steps: [{ agent: 'delegate', status: 'complete', sessionFile: file }] });
  await rejects(host.taskTranscript({ sessionId: sid, runId: 'r3', step: 0 }), 'not_found');
  assert.equal((await host.taskTranscript({ sessionId: other, runId: 'r3', step: 0 })).messages.length, 1);
  writeRun('r4', { steps: [{ agent: 'delegate', status: 'complete', sessionFile: join(meta.get(sid)!.sessionFile.replace(/\.jsonl$/, ''), '..', 'elsewhere.jsonl') }] });
  await rejects(host.taskTranscript({ sessionId: sid, runId: 'r4', step: 0 }), 'not_found');
  await rejects(host.taskTranscript({ sessionId: sid, runId: 'nope', step: 0 }), 'not_found');
  await rejects(host.taskTranscript({ sessionId: sid, runId: '../r1', step: 0 }), 'not_found');
  await rejects(host.taskTranscript({ sessionId: sid, runId: 'r1', step: 5 }), 'not_found');
  await rejects(host.taskTranscript({ sessionId: sid, runId: 'r1', step: -1 }), 'bad_request');
  await rejects(host.taskTranscript({ sessionId: 'missing', runId: 'r1', step: 0 }), 'not_found');
});
