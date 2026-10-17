// Real pi AgentSession driven by the faux provider (NOPEAR_TEST_FAUX=1).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message, SessionEvent } from '@nopear/protocol';
import { loadConfig, type WorkerConfig } from '../config';
import { OpError } from '../errors';
import { BlobStore } from './blobs';
import { MetaStore } from './meta-store';
import { createModelRuntime } from './models';
import { fauxProvider } from '@earendil-works/pi-ai';
import { SessionHost, type HostDeps } from './host';

process.env.NOPEAR_TEST_FAUX = '1';
let cfg: WorkerConfig;
let rt: Awaited<ReturnType<typeof createModelRuntime>>;

before(async () => {
  const home = mkdtempSync(join(tmpdir(), 'host-'));
  cfg = loadConfig({ NOPEAR_SAAS_URL: 'http://saas.test', NOPEAR_HOME: home, NOPEAR_DEFAULT_CWD: join(home, 'work'), NOPEAR_DEFAULT_MODEL: 'faux/echo',
    NOPEAR_PI_AUTH: join(home, 'auth.json'), NOPEAR_PI_MODELS: join(home, 'models.json'), NOPEAR_IDLE_DISPOSE_MS: '60000' });
  rt = await createModelRuntime(cfg);
});

async function makeHost(): Promise<SessionHost> {
  const meta = new MetaStore(join(cfg.home, 'sessions.json'));
  await meta.load();
  const host = new SessionHost({ config: cfg, meta, blobs: new BlobStore(cfg.blobsDir), models: rt, workerId: 'w_test' });
  await host.init();
  return host;
}

class Watcher {
  events: SessionEvent[] = [];
  private ac = new AbortController();
  done: Promise<void>;
  constructor(host: SessionHost, id: string, cursor?: string) {
    this.done = host.watch(id, cursor, (e) => this.events.push(e), this.ac.signal);
  }
  async until(pred: (evs: SessionEvent[]) => boolean, ms = 8000): Promise<void> {
    const t0 = Date.now();
    while (!pred(this.events)) {
      if (Date.now() - t0 > ms) throw new Error('timeout; got ' + this.events.map((e) => e.type).join(','));
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  stop(): Promise<void> { this.ac.abort(); return this.done; }
  get cursor(): string { return this.events[this.events.length - 1]!.cursor; }
}
const upserts = (evs: SessionEvent[]) => evs.filter((e): e is Extract<SessionEvent, { type: 'message.upsert' }> => e.type === 'message.upsert');
const isRunning = (e: SessionEvent) => (e.type === 'session.updated' || e.type === 'snapshot') && e.session.status === 'running';
const idleAfterRun = (evs: SessionEvent[]) =>
  evs.some((e, i) => e.type === 'session.updated' && e.session.status === 'idle' && evs.slice(0, i).some(isRunning));
const textOf = (m: Message) => m.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');

let host: SessionHost;
let sid = '';
let firstPage: Message[] = [];
let oldCursor = '';

after(async () => { await host?.shutdown(); });

test('create → snapshot, live streaming upsert, deltas, complete with replaces, clientMsgId, running→idle', async () => {
  host = await makeHost();
  const s = await host.create({ text: 'hi', clientMsgId: 'c-1' });
  sid = s.id;
  assert.equal(s.kind, 'chat');
  assert.equal(s.model, 'faux/echo');
  assert.equal(s.workerId, 'w_test');
  const w = new Watcher(host, sid);
  await w.until((evs) => idleAfterRun(evs) && upserts(evs).some((u) => u.message.role === 'assistant' && u.message.status === 'complete'));
  assert.equal(w.events[0]!.type, 'snapshot');
  const ups = upserts(w.events);
  const snap0 = w.events[0] as Extract<SessionEvent, { type: 'snapshot' }>;
  const user = ups.find((u) => u.message.role === 'user') ?? { message: snap0.messages.find((m) => m.role === 'user')! };
  assert.equal(user?.message.clientMsgId, 'c-1');
  assert.match(user!.message.id, /^[0-9a-f]{8}$/);
  const live = ups.find((u) => u.message.id.startsWith('live:'));
  const done = ups.find((u) => u.message.role === 'assistant' && u.message.status === 'complete');
  const seenLive = live !== undefined || w.events[0]!.type === 'snapshot' && (w.events[0] as Extract<SessionEvent, { type: 'snapshot' }>).messages.some((m) => m.id.startsWith('live:'));
  assert.ok(seenLive, 'saw a live:* message');
  assert.ok(w.events.some((e) => e.type === 'message.delta'), 'saw deltas');
  const delta = w.events.find((e): e is Extract<SessionEvent, { type: 'message.delta' }> => e.type === 'message.delta' && e.kind === 'text')!;
  assert.equal(delta.index, 1);
  assert.match(done!.replaces ?? '', /^live:\d+$/);
  assert.match(done!.message.id, /^[0-9a-f]{8}$/);
  assert.equal(textOf(done!.message), 'echo: hi');
  assert.deepEqual(done!.message.blocks[0], { type: 'thinking', text: 'thinking about it' });
  // cursors strictly increase
  const ns = w.events.slice(1).map((e) => Number(e.cursor.split('.')[1]));
  assert.deepEqual(ns, [...ns].sort((a, b) => a - b));
  oldCursor = w.cursor;
  await w.stop();
  const page = await host.page({ sessionId: sid });
  assert.deepEqual(page.messages.map((m) => m.id), [user!.message.id, done!.message.id]);
  assert.equal(page.messages[0]!.clientMsgId, 'c-1');
  assert.equal(page.hasMore, false);
  firstPage = page.messages;
  assert.equal(host.get(sid).preview, 'echo: hi');
  assert.equal(host.get(sid).status, 'idle');
});

test('watch with a current cursor replays only newer events', async () => {
  const w = new Watcher(host, sid, oldCursor);
  await host.send({ sessionId: sid, text: 'second', clientMsgId: 'c-2' });
  await w.until((evs) => upserts(evs).some((u) => textOf(u.message) === 'echo: second' && u.message.status === 'complete'));
  assert.notEqual(w.events[0]!.type, 'snapshot');
  assert.equal(Number(w.events[0]!.cursor.split('.')[1]), Number(oldCursor.split('.')[1]) + 1);
  // watcher attached before the send: full live lifecycle is observable on the stream
  const ups = upserts(w.events);
  assert.equal(ups.find((u) => u.message.role === 'user')?.message.clientMsgId, 'c-2');
  const live = ups.find((u) => u.message.id.startsWith('live:') && u.message.status === 'streaming');
  assert.ok(live, 'live:* streaming upsert');
  assert.deepEqual(live!.message.blocks, []);
  assert.ok(w.events.some((e) => e.type === 'message.delta' && e.messageId === live!.message.id));
  const done = ups.find((u) => u.message.status === 'complete' && u.message.role === 'assistant')!;
  assert.equal(done.replaces, live!.message.id);
  assert.ok(w.events.some(isRunning));
  await w.stop();
});

test('new host (new epoch): old cursor → snapshot with stable ids', async () => {
  await host.shutdown();
  host = await makeHost();
  const w = new Watcher(host, sid, oldCursor);
  await w.until((evs) => evs.length > 0);
  const snap = w.events[0] as Extract<SessionEvent, { type: 'snapshot' }>;
  assert.equal(snap.type, 'snapshot');
  assert.deepEqual(snap.messages.slice(0, 2).map((m) => m.id), firstPage.map((m) => m.id));
  assert.equal(snap.messages.length, 4);
  await w.stop();
});

test('rewind second user message → undone text, messages.removed, persists across restart', async () => {
  const before = (await host.page({ sessionId: sid })).messages;
  const second = before.filter((m) => m.role === 'user')[1]!;
  const w = new Watcher(host, sid);
  await w.until((evs) => evs.length > 0);
  assert.equal(host.get(sid).preview, 'echo: second');
  const undone = await host.rewind(sid, second.id);
  assert.equal(undone, 'second');
  assert.equal(host.get(sid).preview, 'echo: hi', 'preview follows the rewound tip');
  await w.until((evs) => evs.some((e) => e.type === 'session.updated' && e.session.preview === 'echo: hi'));
  await w.until((evs) => evs.some((e) => e.type === 'messages.removed'));
  const removed = w.events.find((e): e is Extract<SessionEvent, { type: 'messages.removed' }> => e.type === 'messages.removed')!;
  assert.deepEqual(new Set(removed.ids), new Set(before.slice(2).map((m) => m.id)));
  await w.stop();
  assert.deepEqual((await host.page({ sessionId: sid })).messages.map((m) => m.id), firstPage.map((m) => m.id));
  await host.shutdown();
  host = await makeHost();
  assert.deepEqual((await host.page({ sessionId: sid })).messages.map((m) => m.id), firstPage.map((m) => m.id));
  assert.equal(host.get(sid).preview, 'echo: hi');
  await assert.rejects(host.rewind(sid, firstPage[1]!.id), (e: unknown) => e instanceof OpError && e.code === 'bad_request');
});

test('fork → new chat session with identical history', async () => {
  const f = await host.fork(sid);
  assert.notEqual(f.id, sid);
  assert.match(f.title, /（fork）$/);
  assert.equal(f.model, 'faux/echo');
  const page = await host.page({ sessionId: f.id });
  assert.deepEqual(page.messages.map((m) => [m.role, textOf(m)]), firstPage.map((m) => [m.role, textOf(m)]));
  assert.ok(host.list({}).some((s) => s.id === f.id));
});

test('fork at an earlier message → preview of the fork point, not the source tip', async () => {
  const s = await host.create({ text: 'one', clientMsgId: 'fp-1' });
  await host.waitIdle(s.id);
  await host.send({ sessionId: s.id, text: 'two', clientMsgId: 'fp-2' });
  await host.waitIdle(s.id);
  assert.equal(host.get(s.id).preview, 'echo: two');
  const msgs = (await host.page({ sessionId: s.id })).messages;
  const f = await host.fork(s.id, msgs[1]!.id);
  assert.equal(f.preview, 'echo: one');
  assert.equal(host.get(f.id).preview, 'echo: one');
});

test('ask round-trip: prompt.opened → answer → prompt.closed(answered) → "answered"', async () => {
  const w = new Watcher(host, sid);
  await w.until((evs) => evs.length > 0);
  await host.send({ sessionId: sid, text: 'ask: please', clientMsgId: 'c-3' });
  await w.until((evs) => evs.some((e) => e.type === 'prompt.opened'));
  const opened = w.events.find((e): e is Extract<SessionEvent, { type: 'prompt.opened' }> => e.type === 'prompt.opened')!;
  assert.equal(opened.prompt.questions[0]!.question, 'Pick one?');
  assert.equal(host.get(sid).promptCount, 1);
  await assert.rejects(host.answerPrompt({ sessionId: sid, promptId: 'nope', answers: {} }), (e: unknown) => e instanceof OpError && e.code === 'not_found');
  await host.answerPrompt({ sessionId: sid, promptId: opened.prompt.id, answers: { 'Pick one?': 'B' } });
  await w.until((evs) => upserts(evs).some((u) => u.message.role === 'assistant' && textOf(u.message) === 'answered' && u.message.status === 'complete'));
  const closed = w.events.find((e) => e.type === 'prompt.closed') as Extract<SessionEvent, { type: 'prompt.closed' }>;
  assert.equal(closed.reason, 'answered');
  const tool = upserts(w.events).find((u) => u.message.role === 'tool')!;
  assert.match((tool.message.blocks[0] as { text: string }).text, /"Pick one\?" → "B"/);
  await host.waitIdle(sid);
  assert.equal(host.get(sid).promptCount, 0);
  await w.stop();
});

test('running send is queued; interrupt when idle → conflict; unknown model → bad_request', async () => {
  await host.send({ sessionId: sid, text: 'slow: one', clientMsgId: 'c-4' });
  const r = await host.send({ sessionId: sid, text: 'after', clientMsgId: 'c-5' });
  assert.deepEqual(r, { queued: true });
  await host.waitIdle(sid);
  const texts = (await host.page({ sessionId: sid })).messages.map(textOf);
  assert.ok(texts.includes('echo: slow: one') && texts.includes('after'));
  await assert.rejects(host.interrupt(sid), (e: unknown) => e instanceof OpError && e.code === 'conflict');
  await assert.rejects(host.create({ text: 'x', clientMsgId: 'c', model: 'nope/none' }), (e: unknown) => e instanceof OpError && e.code === 'bad_request');
  await assert.rejects(host.update({ sessionId: sid, model: 'nope/none' }), (e: unknown) => e instanceof OpError && e.code === 'bad_request');
  assert.throws(() => host.get('missing'), (e: unknown) => e instanceof OpError && e.code === 'not_found');
});

test('update, list filters, page paging, workerInfo, delete', async () => {
  const s = await host.update({ sessionId: sid, title: 'renamed', pinned: true, archived: true });
  assert.equal(s.title, 'renamed');
  assert.ok(!host.list({ archived: false }).some((x) => x.id === sid));
  assert.ok(host.list({ archived: true }).some((x) => x.id === sid));
  const all = (await host.page({ sessionId: sid })).messages;
  const p1 = await host.page({ sessionId: sid, limit: 2 });
  assert.deepEqual(p1.messages.map((m) => m.id), all.slice(-2).map((m) => m.id));
  assert.equal(p1.hasMore, true);
  const p2 = await host.page({ sessionId: sid, before: p1.messages[0]!.id, limit: 500 });
  assert.deepEqual(p2.messages.map((m) => m.id), all.slice(0, -2).map((m) => m.id));
  assert.equal(p2.hasMore, false);
  const info = await host.workerInfo();
  assert.ok(info.models.some((m) => m.id === 'faux/echo'));
  assert.equal(info.defaultModel, 'faux/echo');
  assert.ok((await host.costUsd(sid)) >= 0);
  const removed: string[] = [];
  const off = host.onSessionChange((x, rm) => { if (rm) removed.push(x.id); });
  await host.delete(sid);
  off();
  assert.deepEqual(removed, [sid]);
  assert.throws(() => host.get(sid));
});

// ---------------- project tags (D6) / lastError ----------------

const hosts2: SessionHost[] = [];
after(async () => { for (const h of hosts2) await h.shutdown().catch(() => {}); });

/** A host on its own NOPEAR_HOME (same model runtime) with optional tag hooks. */
async function tagHost(extra: Partial<Pick<HostDeps, 'autoProject' | 'onTagged' | 'taggedTimeoutMs'>> = {}, seed?: (meta: MetaStore) => Promise<void>): Promise<SessionHost> {
  const home = mkdtempSync(join(tmpdir(), 'host-tag-'));
  const c = loadConfig({ NOPEAR_SAAS_URL: 'http://saas.test', NOPEAR_HOME: home, NOPEAR_DEFAULT_CWD: join(home, 'work'), NOPEAR_DEFAULT_MODEL: 'faux/echo',
    NOPEAR_PI_AUTH: join(home, 'auth.json'), NOPEAR_PI_MODELS: join(home, 'models.json'), NOPEAR_IDLE_DISPOSE_MS: '60000' });
  const meta = new MetaStore(join(c.home, 'sessions.json'));
  await meta.load();
  await seed?.(meta);
  const h = new SessionHost({ config: c, meta, blobs: new BlobStore(c.blobsDir), models: rt, workerId: 'w_tag', ...extra });
  await h.init();
  hosts2.push(h);
  return h;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('create uses args.projectId', async () => {
  const tagged: string[] = [];
  const h = await tagHost({ onTagged: async (p) => { tagged.push(p); } });
  const s = await h.create({ text: '', clientMsgId: 't-1', projectId: 'p_1' });
  assert.equal(s.projectId, 'p_1');
  assert.equal(h.get(s.id).projectId, 'p_1');
  assert.deepEqual(tagged, ['p_1']);
});

test('create rejects a non-string / empty args.projectId with bad_request', async () => {
  const h = await tagHost({ autoProject: () => 'p_auto' });
  const n0 = h.list({}).length;
  for (const bad of [123, true, '', {}, null] as unknown[]) {
    await assert.rejects(h.create({ text: '', clientMsgId: 't-bad', projectId: bad as string }),
      (e: unknown) => e instanceof OpError && e.code === 'bad_request', `projectId=${JSON.stringify(bad)}`);
  }
  assert.equal(h.list({}).length, n0, 'no session created for an invalid projectId');
  const s = await h.create({ text: '', clientMsgId: 't-undef', projectId: undefined });
  assert.equal(s.projectId, 'p_auto', 'undefined projectId falls back to autoProject');
});

test('a hanging onTagged is capped at taggedTimeoutMs and does not hold the op', async () => {
  const h = await tagHost({ onTagged: () => new Promise<void>(() => {}), taggedTimeoutMs: 50 });
  const t0 = Date.now();
  const s = await h.create({ text: '', clientMsgId: 't-hang', projectId: 'p_h' });
  const dt = Date.now() - t0;
  assert.equal(s.projectId, 'p_h');
  assert.ok(dt >= 40 && dt < 3000, `create returned after ${dt}ms`);
});

test('create auto-tags via autoProject and awaits onTagged before the first prompt', async () => {
  const order: string[] = [];
  const cwds: string[] = [];
  const h = await tagHost({
    autoProject: (cwd) => { cwds.push(cwd); return 'p_auto'; },
    onTagged: async (p) => { await sleep(50); order.push(`tagged:${p}`); },
  });
  h.onSessionChange((x) => { if (x.status === 'running' && !order.includes('running')) order.push('running'); });
  const cwd = join(mkdtempSync(join(tmpdir(), 'host-cwd-')), 'repo');
  const s = await h.create({ text: 'hi', clientMsgId: 't-2', cwd });
  assert.equal(s.projectId, 'p_auto');
  assert.deepEqual(cwds, [cwd]);
  await h.waitIdle(s.id);
  assert.deepEqual(order, ['tagged:p_auto', 'running']);
});

test('explicit projectId skips autoProject', async () => {
  let asked = 0;
  const h = await tagHost({ autoProject: () => { asked++; return 'p_auto'; } });
  const s = await h.create({ text: '', clientMsgId: 't-3', projectId: 'p_explicit' });
  assert.equal(s.projectId, 'p_explicit');
  assert.equal(asked, 0);
  const viaOpts = await h.create({ text: '', clientMsgId: 't-3b' }, { projectId: 'p_opts' });
  assert.equal(viaOpts.projectId, 'p_opts');
  assert.equal(asked, 0);
  const untagged = await (await tagHost({ autoProject: () => undefined })).create({ text: '', clientMsgId: 't-3c' });
  assert.equal(untagged.projectId, undefined);
});

test('update projectId:null clears the tag', async () => {
  const h = await tagHost();
  const s = await h.create({ text: '', clientMsgId: 't-4', projectId: 'p_1' });
  const changes: Array<string | undefined> = [];
  h.onSessionChange((x) => { if (x.id === s.id) changes.push(x.projectId); });
  const u = await h.update({ sessionId: s.id, projectId: null });
  assert.equal(u.projectId, undefined);
  assert.equal(h.get(s.id).projectId, undefined);
  await h.waitIdle(s.id); // session.updated is published through the session's chain
  assert.ok(changes.includes(undefined), 'session change emitted for the cleared tag');
});

test("update projectId:'p_2' sets it and awaits onTagged", async () => {
  const tagged: string[] = [];
  const h = await tagHost({ onTagged: async (p) => { await sleep(50); tagged.push(p); } });
  const s = await h.create({ text: '', clientMsgId: 't-5' });
  assert.equal(s.projectId, undefined);
  const changes: Array<string | undefined> = [];
  h.onSessionChange((x) => { if (x.id === s.id) changes.push(x.projectId); });
  const u = await h.update({ sessionId: s.id, projectId: 'p_2' });
  assert.deepEqual(tagged, ['p_2'], 'onTagged awaited before update returns');
  assert.equal(u.projectId, 'p_2');
  await h.waitIdle(s.id);
  assert.ok(changes.includes('p_2'));
  // onTagged failures are swallowed
  const h2 = await tagHost({ onTagged: async () => { throw new Error('prefetch failed'); } });
  const s2 = await h2.create({ text: '', clientMsgId: 't-5b', projectId: 'p_x' });
  assert.equal((await h2.update({ sessionId: s2.id, projectId: 'p_y' })).projectId, 'p_y');
});

test('list defaults to chat only', async () => {
  const now = new Date().toISOString();
  // A legacy non-chat entry that bypassed load()'s filter must still not be listed by default.
  const h = await tagHost({}, (m) => m.put({ id: 'legacy-pm', kind: 'pm' as never, title: 'old brain', cwd: '/tmp', sessionFile: '', createdAt: now,
    lastActivityAt: now, preview: '', pinned: false, starred: false, archived: false, model: 'faux/echo', thinking: 'medium' }));
  const s = await h.create({ text: '', clientMsgId: 't-6' });
  const listed = h.list({});
  assert.deepEqual(listed.map((x) => x.id), [s.id]);
  assert.ok(listed.every((x) => x.kind === 'chat'));
});

test('lastError returns the last run error text', async () => {
  const boom = fauxProvider({ provider: 'faux-err', models: [{ id: 'boom', name: 'Faux Boom' }] });
  const fail = async () => { boom.appendResponses([fail]); throw new Error('kaboom from faux'); };
  boom.setResponses([fail]);
  rt.registerNativeProvider(boom.provider);
  const h = await tagHost();
  const s = await h.create({ text: 'go', clientMsgId: 't-7', model: 'faux-err/boom' });
  await h.waitIdle(s.id);
  assert.equal(h.get(s.id).status, 'error');
  assert.match(h.lastError(s.id) ?? '', /kaboom from faux/);
  const ok = await h.create({ text: 'fine', clientMsgId: 't-7b' });
  await h.waitIdle(ok.id);
  assert.equal(h.lastError(ok.id), undefined);
  assert.equal(h.lastError('missing'), undefined);
});

test('faux: tool:<name> <json> calls the tool and answers with its result; sys: echoes the system prompt', async () => {
  const h = await tagHost();
  const cwd = mkdtempSync(join(tmpdir(), 'host-faux-'));
  writeFileSync(join(cwd, 'marker.txt'), 'marker-content-42');
  const s = await h.create({ text: 'tool:read {"path":"marker.txt"}', clientMsgId: 'f-1', cwd });
  await h.waitIdle(s.id);
  const lastReply = async () => textOf((await h.page({ sessionId: s.id })).messages.filter((m) => m.role === 'assistant').at(-1)!);
  const reply = await lastReply();
  assert.match(reply, /^answered: /);
  assert.match(reply, /marker-content-42/);
  await h.send({ sessionId: s.id, text: 'sys: show', clientMsgId: 'f-2' });
  await h.waitIdle(s.id);
  const sys = await lastReply();
  assert.match(sys, /^system: /);
  assert.match(sys, /Claude Code/);
});
