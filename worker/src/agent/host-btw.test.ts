// /btw: a side question answered from the session's context, streamed as `btw` events, never written to the session.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BtwAnswer, SessionEvent } from '@nopear/protocol';
import type { Context } from '@earendil-works/pi-ai';
import { loadConfig, type WorkerConfig } from '../config';
import { OpError } from '../errors';
import { BlobStore } from './blobs';
import { MetaStore } from './meta-store';
import { createModelRuntime } from './models';
import { SessionHost, btwPrompt } from './host';

process.env.NOPEAR_TEST_FAUX = '1';
let cfg: WorkerConfig;
let host: SessionHost;
let rt: Awaited<ReturnType<typeof createModelRuntime>>;

before(async () => {
  const home = mkdtempSync(join(tmpdir(), 'host-btw-'));
  cfg = loadConfig({ NOPEAR_SAAS_URL: 'http://saas.test', NOPEAR_HOME: home, NOPEAR_DEFAULT_CWD: join(home, 'work'), NOPEAR_DEFAULT_MODEL: 'faux/echo',
    NOPEAR_PI_AUTH: join(home, 'auth.json'), NOPEAR_PI_MODELS: join(home, 'models.json'), NOPEAR_IDLE_DISPOSE_MS: '60000', NOPEAR_AUTO_TITLE: '0' });
  const meta = new MetaStore(join(cfg.home, 'sessions.json'));
  await meta.load();
  rt = await createModelRuntime(cfg);
  host = new SessionHost({ config: cfg, meta, blobs: new BlobStore(cfg.blobsDir), models: rt, workerId: 'w_test' });
  await host.init();
});
after(async () => { await host?.shutdown(); });

function watch(sid: string) {
  const events: SessionEvent[] = [];
  const ac = new AbortController();
  const done = host.watch(sid, undefined, (e) => events.push(e), ac.signal);
  const btw = (id: string) => events.filter((e): e is Extract<SessionEvent, { type: 'btw' }> => e.type === 'btw' && e.btw.id === id).map((e) => e.btw);
  const until = async (pred: () => boolean, ms = 8000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 10)); } };
  return { events, btw, until, stop: () => { ac.abort(); return done; } };
}
async function spyStream() {
  const calls: Array<{ ctx: Context; opts: Record<string, unknown> }> = [];
  const real = rt.streamSimple.bind(rt);
  (rt as { streamSimple: unknown }).streamSimple = (model: never, ctx: Context, opts: Record<string, unknown>) => { calls.push({ ctx, opts }); return real(model, ctx, opts as never); };
  return { calls, restore: () => { (rt as { streamSimple: unknown }).streamSimple = real; } };
}

test('answers from the session context with the same prompt/tools/history, streams, and leaves the session untouched', async () => {
  const s = await host.create({ text: 'remember the word pineapple', clientMsgId: 'c1' });
  await host.waitIdle(s.id);
  const before = (await host.page({ sessionId: s.id })).messages.map((m) => m.id);
  const w = watch(s.id);
  await w.until(() => w.events.length > 0);
  const spy = await spyStream();
  try {
    await host.btw({ sessionId: s.id, id: 'q1', text: '  what word?  ' });
    await w.until(() => w.btw('q1').some((b) => b.status !== 'running'));
  } finally { spy.restore(); }
  const seq = w.btw('q1');
  assert.equal(seq[0]!.status, 'running');
  assert.equal(seq[0]!.question, 'what word?');
  assert.equal(seq[0]!.model, 'faux/echo');
  const last = seq.at(-1)!;
  assert.equal(last.status, 'done');
  assert.match(last.text, /what word\?/); // faux echoes the last user text
  // the request: session prompt + tools + full history, then the reminder-wrapped question
  assert.equal(spy.calls.length, 1);
  const { ctx, opts } = spy.calls[0]!;
  const live = (host as unknown as { live: Map<string, { session: { agent: { state: { systemPrompt: string; tools: unknown[] } } } }> }).live.get(s.id)!;
  assert.equal(ctx.systemPrompt, live.session.agent.state.systemPrompt);
  assert.equal(ctx.tools!.length, live.session.agent.state.tools.length);
  assert.ok(ctx.tools!.length > 0);
  const roles = ctx.messages.map((m) => m.role);
  assert.deepEqual(roles.slice(0, 2), ['user', 'assistant']); // the earlier exchange
  const q = ctx.messages.at(-1)!;
  assert.deepEqual(q.content, [{ type: 'text', text: btwPrompt('what word?') }]);
  assert.equal(opts.reasoning, 'medium'); // the session's thinking level: same request shape as the main loop → cache hit
  assert.equal(opts.toolChoice, undefined);
  // nothing was added to the session
  assert.deepEqual((await host.page({ sessionId: s.id })).messages.map((m) => m.id), before);
  assert.equal(host.get(s.id).status, 'idle');
  await w.stop();
});

test('works while the session is running; errors are reported on the answer', async () => {
  const s = await host.create({ text: 'slow: busy', clientMsgId: 'c2' });
  const w = watch(s.id);
  await w.until(() => host.get(s.id).status === 'running');
  await host.btw({ sessionId: s.id, id: 'q2', text: 'quick one' });
  await w.until(() => w.btw('q2').some((b) => b.status === 'done'));
  await host.waitIdle(s.id);
  // provider failure
  const real = rt.streamSimple.bind(rt);
  (rt as { streamSimple: unknown }).streamSimple = () => ({
    async *[Symbol.asyncIterator]() { yield { type: 'error', reason: 'error', error: { errorMessage: '400 Third-party apps now draw from extra usage' } }; },
  });
  try {
    await host.btw({ sessionId: s.id, id: 'q3', text: 'will fail' });
    await w.until(() => w.btw('q3').some((b) => b.status === 'error'));
  } finally { (rt as { streamSimple: unknown }).streamSimple = real; }
  const err = w.btw('q3').at(-1) as BtwAnswer;
  assert.match(err.error!, /Third-party apps/);
  await w.stop();
});

test('validation: empty / too long / bad id / unknown session; a repeated id is a no-op', async () => {
  const s = await host.create({ text: 'hi', clientMsgId: 'c4' });
  await host.waitIdle(s.id);
  const code = async (p: Promise<unknown>, c: string) => assert.rejects(p, (e: unknown) => e instanceof OpError && e.code === c);
  await code(host.btw({ sessionId: s.id, id: 'x', text: '   ' }), 'bad_request');
  await code(host.btw({ sessionId: s.id, id: 'x', text: 'a'.repeat(4001) }), 'too_large');
  await code(host.btw({ sessionId: s.id, id: 'bad id!', text: 'q' }), 'bad_request');
  await code(host.btw({ sessionId: 'nope', id: 'x', text: 'q' }), 'not_found');
});
