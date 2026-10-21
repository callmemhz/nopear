// Robustness regressions for SessionHost (code-review findings F1–F14). Real pi + faux provider.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSession, ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent';
import type { Message, SessionEvent } from '@nopear/protocol';
import { loadConfig, type WorkerConfig } from '../config';
import { OpError } from '../errors';
import { BlobStore } from './blobs';
import { MetaStore, type SessionMeta } from './meta-store';
import { createModelRuntime } from './models';
import { SessionHost } from './host';

process.env.NOPEAR_TEST_FAUX = '1';

class SlowMeta extends MetaStore {
  slowMs = 0;
  failLeafPatch = false;
  override async patch(id: string, p: Partial<SessionMeta>): Promise<SessionMeta | undefined> {
    if (this.failLeafPatch && p.leafId !== undefined) throw new Error('disk full (meta)');
    if (this.slowMs && p.preview !== undefined) await new Promise((r) => setTimeout(r, this.slowMs));
    return super.patch(id, p);
  }
}
class CountingBlobs extends BlobStore { puts = 0; override async put(b: Uint8Array, t: string) { this.puts++; return super.put(b, t); } }

interface Env { cfg: WorkerConfig; meta: SlowMeta; blobs: CountingBlobs; host: SessionHost }
const hosts: SessionHost[] = [];
after(async () => { for (const h of hosts) await h.shutdown().catch(() => {}); });
const rtP = (async () => {
  const home = mkdtempSync(join(tmpdir(), 'hostr-rt-'));
  return createModelRuntime(loadConfig({ NOPEAR_SAAS_URL: 'http://s', NOPEAR_HOME: home, NOPEAR_PI_AUTH: join(home, 'a.json'), NOPEAR_PI_MODELS: join(home, 'm.json') }));
})();

async function env(opts: { home?: string; idleMs?: number; extensions?: InlineExtension[]; autoTitle?: boolean } = {}): Promise<Env> {
  const home = opts.home ?? mkdtempSync(join(tmpdir(), 'hostr-'));
  const cfg = loadConfig({ NOPEAR_SAAS_URL: 'http://saas.test', NOPEAR_HOME: home, NOPEAR_DEFAULT_CWD: join(home, 'work'), NOPEAR_DEFAULT_MODEL: 'faux/echo',
    NOPEAR_PI_AUTH: join(home, 'auth.json'), NOPEAR_PI_MODELS: join(home, 'models.json'), NOPEAR_IDLE_DISPOSE_MS: String(opts.idleMs ?? 60000), NOPEAR_AUTO_TITLE: opts.autoTitle === false ? '0' : '1' });
  const meta = new SlowMeta(join(home, 'sessions.json'));
  await meta.load();
  const blobs = new CountingBlobs(cfg.blobsDir);
  const host = new SessionHost({ config: cfg, meta, blobs, models: await rtP, workerId: 'w_test', extraExtensions: opts.extensions });
  await host.init();
  hosts.push(host);
  return { cfg, meta, blobs, host };
}

class Watcher {
  events: SessionEvent[] = [];
  private ac = new AbortController();
  done: Promise<void>;
  error: unknown;
  constructor(host: SessionHost, id: string, cursor?: string) {
    this.done = host.watch(id, cursor, (e) => this.events.push(e), this.ac.signal).catch((e) => { this.error = e; });
  }
  async until(pred: (evs: SessionEvent[]) => boolean, ms = 10000): Promise<void> {
    const t0 = Date.now();
    while (!pred(this.events)) {
      if (Date.now() - t0 > ms) throw new Error('timeout; got ' + this.events.map((e) => e.type).join(','));
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  stop(): Promise<void> { this.ac.abort(); return this.done; }
}
const textOf = (m: Message) => m.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isRunning = (e: SessionEvent) => (e.type === 'session.updated' || e.type === 'snapshot') && e.session.status === 'running';
const idleTransitions = (evs: SessionEvent[]) => {
  let n = 0; let running = false;
  for (const e of evs) {
    if (e.type !== 'session.updated' && e.type !== 'snapshot') continue;
    if (e.session.status === 'running') running = true;
    else if (running && e.session.status === 'idle') { n++; running = false; }
  }
  return n;
};
async function idleSession(h: SessionHost, text = 'hi'): Promise<string> {
  const s = await h.create({ text, clientMsgId: `c-${Math.random()}` });
  await h.waitIdle(s.id);
  return s.id;
}

test('F1: concurrent sends on an idle session are serialized into one coherent run', async () => {
  const { host } = await env();
  const sid = await idleSession(host);
  const w = new Watcher(host, sid);
  await w.until((e) => e.length > 0);
  const [a, b] = await Promise.all([
    host.send({ sessionId: sid, text: 'slow: a', clientMsgId: 'a' }),
    host.send({ sessionId: sid, text: 'slow: b', clientMsgId: 'b' }),
  ]);
  assert.equal(a.queued, false);
  assert.equal(b.queued, true);
  await host.waitIdle(sid);
  await sleep(100);
  const msgs = (await host.page({ sessionId: sid })).messages;
  assert.deepEqual(msgs.filter((m) => m.role === 'user').map(textOf), ['hi', 'slow: a', 'slow: b']);
  const echoes = msgs.filter((m) => m.role === 'assistant').map(textOf);
  assert.ok(echoes.includes('echo: slow: a') && echoes.includes('echo: slow: b'), echoes.join('|'));
  assert.equal(idleTransitions(w.events), 1, 'exactly one running→idle');
  // every live bubble is eventually replaced by a complete message
  const liveIds = new Set(w.events.flatMap((e) => (e.type === 'message.upsert' && e.message.id.startsWith('live:') ? [e.message.id] : [])));
  const replaced = new Set(w.events.flatMap((e) => (e.type === 'message.upsert' && e.replaces ? [e.replaces] : [])));
  for (const id of liveIds) assert.ok(replaced.has(id), `orphaned ${id}`);
  await w.stop();
});

test('F2: snapshot taken while the publish chain lags does not duplicate streamed text', async () => {
  const { host, meta } = await env();
  const sid = await idleSession(host);
  const long = 'z'.repeat(1600);
  meta.slowMs = 400; // the user-entry producer (preview patch) blocks the chain while deltas pile up
  await host.send({ sessionId: sid, text: long, clientMsgId: 'L' });
  await sleep(200);
  const w = new Watcher(host, sid);
  await w.until((evs) => evs.some((e) => e.type === 'message.upsert' && e.message.role === 'assistant' && e.message.status === 'complete' && textOf(e.message).startsWith('echo: z')));
  meta.slowMs = 0;
  const snap = w.events[0] as Extract<SessionEvent, { type: 'snapshot' }>;
  assert.equal(snap.type, 'snapshot');
  const live = snap.messages.find((m) => m.id.startsWith('live:'));
  assert.ok(live, 'snapshot carried the in-flight message');
  // replay deltas on top of the snapshot copy with client (core) semantics
  const blocks = structuredClone(live!.blocks) as Array<{ type: string; text: string }>;
  for (const e of w.events) {
    if (e.type === 'message.delta' && e.messageId === live!.id) {
      const cur = blocks[e.index];
      if (cur && cur.type === e.kind) cur.text += e.text; else blocks[e.index] = { type: e.kind, text: e.text };
    }
    if (e.type === 'message.upsert' && e.message.id === live!.id) blocks.splice(0, blocks.length, ...(structuredClone(e.message.blocks) as typeof blocks));
  }
  assert.equal(blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''), `echo: ${long}`);
  assert.ok(!snap.messages.some((m) => m.blocks.some((b) => b == null)), 'no holes');
  await w.stop();
});

test('F3: an input handled by an extension (no agent run) does not leave the session running', async () => {
  const ext: InlineExtension = { name: 'swallow', factory: (pi) => { pi.on('input', (e) => (e.text === 'swallow me' ? { action: 'handled' } : { action: 'continue' })); } };
  const { host } = await env({ extensions: [ext] });
  const sid = await idleSession(host);
  await host.send({ sessionId: sid, text: 'swallow me', clientMsgId: 'h' });
  await sleep(100);
  assert.equal(host.get(sid).status, 'idle');
  await Promise.race([host.waitIdle(sid), sleep(2000).then(() => { throw new Error('waitIdle hung'); })]);
});

test('F4: re-sending the same clientMsgId is idempotent', async () => {
  const { host } = await env();
  const sid = await idleSession(host);
  await host.send({ sessionId: sid, text: 'once', clientMsgId: 'dup' });
  await host.send({ sessionId: sid, text: 'once', clientMsgId: 'dup' }); // retry while still pending/running
  await host.waitIdle(sid);
  await host.send({ sessionId: sid, text: 'once', clientMsgId: 'dup' }); // retry after it landed
  await host.waitIdle(sid);
  await sleep(50);
  const users = (await host.page({ sessionId: sid })).messages.filter((m) => m.role === 'user' && textOf(m) === 'once');
  assert.equal(users.length, 1);
});

test('F6+F8: idle dispose frees the sync log, and a watch arriving while dispose is pending still works', async () => {
  const { host, meta } = await env({ idleMs: 50 });
  const sid = await idleSession(host);
  const w0 = new Watcher(host, sid);
  await w0.until((e) => e.length > 0);
  await w0.stop();
  const oldCursor = w0.events[w0.events.length - 1]!.cursor;
  meta.slowMs = 300; // assistant-complete producer blocks the chain when the idle timer fires
  await host.send({ sessionId: sid, text: 'go', clientMsgId: 'g' });
  await host.waitIdle(sid).catch(() => {});
  await sleep(100);
  const w = new Watcher(host, sid, oldCursor);
  await w.until((e) => e.length > 0);
  meta.slowMs = 0;
  await host.send({ sessionId: sid, text: 'after dispose', clientMsgId: 'g2' });
  await w.until((evs) => evs.some((e) => e.type === 'message.upsert' && e.message.status === 'complete' && textOf(e.message) === 'echo: after dispose'));
  await w.stop();
  // fully idle again → disposed → old cursor yields a snapshot (log was freed)
  await sleep(200);
  const w2 = new Watcher(host, sid, w.events[w.events.length - 1]!.cursor);
  await w2.until((e) => e.length > 0);
  assert.equal(w2.events[0]!.type, 'snapshot');
  await w2.stop();
});

test('F7: a session restarted before its first reply keeps its identity and history', async () => {
  const home = mkdtempSync(join(tmpdir(), 'hostr-f7-'));
  let e = await env({ home });
  const s = await e.host.create({ text: 'later', clientMsgId: 'x', }, { autoStart: false });
  await e.host.shutdown();
  e = await env({ home });
  await e.host.send({ sessionId: s.id, text: 'first', clientMsgId: 'f' });
  await e.host.waitIdle(s.id);
  await sleep(100);
  const m = e.meta.get(s.id)!;
  assert.ok(existsSync(m.sessionFile), 'meta.sessionFile points at the written file');
  await e.host.shutdown();
  e = await env({ home });
  const page = await e.host.page({ sessionId: s.id });
  assert.deepEqual(page.messages.map(textOf), ['first', 'echo: first']);
  assert.equal(e.host.get(s.id).id, s.id);
});

test('F10: repeated snapshots/pages do not re-hash images', async () => {
  const { host, blobs } = await env();
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const s = await host.create({ text: 'look', clientMsgId: 'i', attachments: [{ kind: 'image', name: 'p.png', mediaType: 'image/png', dataBase64: png }] });
  await host.waitIdle(s.id);
  await sleep(100);
  const p1 = await host.page({ sessionId: s.id });
  assert.ok(p1.messages[0]!.blocks.some((b) => b.type === 'image'));
  const before = blobs.puts;
  await host.page({ sessionId: s.id });
  const w = new Watcher(host, s.id);
  await w.until((e) => e.length > 0);
  await w.stop();
  assert.equal(blobs.puts, before);
});

test('F14: deleting a session ends its watchers with not_found', async () => {
  const { host } = await env();
  const sid = await idleSession(host);
  const w = new Watcher(host, sid);
  await w.until((e) => e.length > 0);
  await host.delete(sid);
  await Promise.race([w.done, sleep(2000).then(() => { throw new Error('watch did not end'); })]);
  assert.ok(w.error instanceof OpError && w.error.code === 'not_found');
});

// ---- wave 3 review 2 ----
type LiveInternals = { live: Map<string, { sm: { appendMessage: (m: unknown) => string }; session: AgentSession }> };
const sessionOf = (h: SessionHost, sid: string): AgentSession => (h as unknown as LiveInternals).live.get(sid)!.session;
async function waitFor(what: string, pred: () => boolean, ms = 10000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await sleep(5);
  }
}

test('R2-F1: a send still in pi preflight when the previous run settles keeps its clientMsgId and the status does not flicker', async () => {
  const ext: InlineExtension = { name: 'slow-input', factory: (pi) => { pi.on('input', async (e) => { if (e.text === 'late') await sleep(900); return { action: 'continue' }; }); } };
  const { host } = await env({ extensions: [ext] });
  const sid = await idleSession(host);
  const w = new Watcher(host, sid);
  await w.until((e) => e.length > 0);
  await host.send({ sessionId: sid, text: 'slow: a', clientMsgId: 'A' });
  await host.send({ sessionId: sid, text: 'late', clientMsgId: 'L' }); // preflight outlives run A
  await host.waitIdle(sid);
  await sleep(100);
  await host.waitIdle(sid);
  await sleep(100);
  const msgs = (await host.page({ sessionId: sid })).messages;
  const late = msgs.find((m) => m.role === 'user' && textOf(m) === 'late');
  assert.ok(late, 'late message persisted');
  assert.equal(late!.clientMsgId, 'L');
  assert.equal(idleTransitions(w.events), 1, 'exactly one running→idle');
  await w.stop();
});

test('R2-F2: an extension-injected user message never steals a pending send clientMsgId', async () => {
  const ext: InlineExtension = { name: 'inject', factory: (pi) => {
    pi.on('input', (e) => { if (e.text === 'q1') pi.sendUserMessage('injected', { deliverAs: 'steer' }); return { action: 'continue' }; });
  } };
  const { host } = await env({ extensions: [ext] });
  const sid = await idleSession(host);
  await host.send({ sessionId: sid, text: 'slow: a', clientMsgId: 'A' });
  await Promise.all([
    host.send({ sessionId: sid, text: 'q1', clientMsgId: 'q1' }),
    host.send({ sessionId: sid, text: 'q2', clientMsgId: 'q2' }),
  ]);
  await host.waitIdle(sid);
  await sleep(100);
  await host.waitIdle(sid);
  const users = (await host.page({ sessionId: sid })).messages.filter((m) => m.role === 'user');
  const cidOf = (t: string) => users.find((m) => textOf(m) === t)?.clientMsgId;
  assert.ok(users.some((m) => textOf(m) === 'injected'), users.map(textOf).join('|'));
  assert.equal(cidOf('injected'), undefined);
  assert.equal(cidOf('q1'), 'q1');
  assert.equal(cidOf('q2'), 'q2');
});

test('R2-F3: an orphaned live bubble is removed for existing watchers', async () => {
  const { host } = await env();
  const sid = await idleSession(host);
  const sm = (host as unknown as LiveInternals).live.get(sid)!.sm;
  const inner = sm.appendMessage;
  let drop = true;
  sm.appendMessage = (m: unknown) => ((m as { role?: string }).role === 'assistant' && drop ? 'dropped' : inner(m));
  const w = new Watcher(host, sid);
  await w.until((e) => e.length > 0);
  await host.send({ sessionId: sid, text: 'orphan', clientMsgId: 'o' });
  await host.waitIdle(sid);
  drop = false;
  const liveIds = [...new Set(w.events.flatMap((e) => (e.type === 'message.upsert' && e.message.id.startsWith('live:') ? [e.message.id] : [])))];
  assert.ok(liveIds.length > 0, 'a live bubble was published');
  const removed = new Set(w.events.flatMap((e) => (e.type === 'messages.removed' ? e.ids : [])));
  for (const id of liveIds) assert.ok(removed.has(id), `orphan ${id} not removed`);
  await w.stop();
});

// ---- wave 3 review 3 ----
test('R3-F2a: a user message injected while a send is still in preflight does not take its clientMsgId', async () => {
  const ext: InlineExtension = { name: 'inject-in-preflight', factory: (pi) => {
    pi.on('input', async (e) => {
      if (e.text === 'real') { pi.sendUserMessage('injected'); await sleep(300); }
      return { action: 'continue' };
    });
  } };
  const { host } = await env({ extensions: [ext] });
  const sid = await idleSession(host);
  await host.send({ sessionId: sid, text: 'real', clientMsgId: 'R' });
  await host.waitIdle(sid);
  await sleep(100);
  await host.waitIdle(sid);
  const users = (await host.page({ sessionId: sid })).messages.filter((m) => m.role === 'user');
  const cidOf = (t: string) => users.find((m) => textOf(m) === t)?.clientMsgId;
  assert.ok(users.some((m) => textOf(m) === 'injected'), users.map(textOf).join('|'));
  assert.equal(cidOf('injected'), undefined);
  assert.equal(cidOf('real'), 'R');
});

test('R3-F2b: two queued sends transformed by an input extension both keep their clientMsgIds in order', async () => {
  const ext: InlineExtension = { name: 'transform', factory: (pi) => {
    pi.on('input', (e) => (e.text === 'q1' || e.text === 'q2' ? { action: 'transform', text: `T(${e.text})` } : { action: 'continue' }));
  } };
  const { host } = await env({ extensions: [ext] });
  const sid = await idleSession(host);
  await host.send({ sessionId: sid, text: 'slow: a', clientMsgId: 'A' });
  const r1 = await host.send({ sessionId: sid, text: 'q1', clientMsgId: 'q1' });
  const r2 = await host.send({ sessionId: sid, text: 'q2', clientMsgId: 'q2' });
  assert.equal(r1.queued, true);
  assert.equal(r2.queued, true);
  await host.waitIdle(sid);
  await sleep(100);
  await host.waitIdle(sid);
  const users = (await host.page({ sessionId: sid })).messages.filter((m) => m.role === 'user');
  const cidOf = (t: string) => users.find((m) => textOf(m) === t)?.clientMsgId;
  assert.deepEqual(users.map(textOf).slice(-2), ['T(q1)', 'T(q2)']);
  assert.equal(cidOf('slow: a'), 'A');
  assert.equal(cidOf('T(q1)'), 'q1');
  assert.equal(cidOf('T(q2)'), 'q2');
});

test('R3-F4: interrupting a send stuck in a never-resolving preflight returns the session to idle', async () => {
  const ext: InlineExtension = { name: 'hang', factory: (pi) => {
    pi.on('input', (e) => (e.text === 'hang' ? new Promise<never>(() => {}) : { action: 'continue' as const }));
  } };
  const { host } = await env({ extensions: [ext] });
  const sid = await idleSession(host);
  void host.send({ sessionId: sid, text: 'hang', clientMsgId: 'H' }).catch(() => {});
  await sleep(100);
  assert.equal(host.get(sid).status, 'running');
  await host.interrupt(sid);
  assert.equal(host.get(sid).status, 'idle');
  await Promise.race([host.waitIdle(sid), sleep(2000).then(() => { throw new Error('waitIdle hung'); })]);
});

// ---- task 11 (carried-over review findings) ----
test('T11-a: a send interrupted while still in preflight keeps its clientMsgId when its run starts late', async () => {
  const ext: InlineExtension = { name: 'slow-preflight', factory: (pi) => {
    pi.on('input', async (e) => { if (e.text === 'late') await sleep(500); return { action: 'continue' as const }; });
  } };
  const { host } = await env({ extensions: [ext] });
  const sid = await idleSession(host);
  const sent = host.send({ sessionId: sid, text: 'late', clientMsgId: 'L' });
  await sleep(100);
  assert.equal(host.get(sid).status, 'running');
  await host.interrupt(sid);
  assert.equal(host.get(sid).status, 'idle');
  await sent; // preflight passes after the interrupt and pi starts the run itself
  await sleep(100);
  await host.waitIdle(sid);
  const late = (await host.page({ sessionId: sid })).messages.find((m) => m.role === 'user' && textOf(m) === 'late');
  assert.ok(late, 'late message persisted');
  assert.equal(late!.clientMsgId, 'L');
});

test('T11-b: an input handled mid-run (nothing queued) does not take over the queue tail clientMsgId', async () => {
  const ext: InlineExtension = { name: 'handled-mid-run', factory: (pi) => {
    pi.on('input', (e) => {
      // Queue an extension follow-up on a later tick, so it is already in pi's queue when "h" is sent.
      if (e.text === 'inj') { setTimeout(() => void pi.sendUserMessage('injected', { deliverAs: 'followUp' }), 0); return { action: 'handled' as const }; }
      if (e.text === 'h') return { action: 'handled' as const };
      return { action: 'continue' as const };
    });
  } };
  const { host } = await env({ extensions: [ext] });
  const sid = await idleSession(host);
  await host.send({ sessionId: sid, text: 'slow: a', clientMsgId: 'A' });
  await host.send({ sessionId: sid, text: 'inj', clientMsgId: 'I' });
  // The extension follow-up must already be queued (and run A still streaming) before "h" is sent.
  const session = sessionOf(host, sid);
  await waitFor('injected follow-up queued during run A', () => session.isStreaming && session.getFollowUpMessages().includes('injected'));
  await host.send({ sessionId: sid, text: 'h', clientMsgId: 'H' });
  await host.waitIdle(sid);
  await sleep(100);
  await host.waitIdle(sid);
  const users = (await host.page({ sessionId: sid })).messages.filter((m) => m.role === 'user');
  const injected = users.find((m) => textOf(m) === 'injected');
  assert.ok(injected, users.map(textOf).join('|'));
  assert.equal(injected!.clientMsgId, undefined);
  assert.equal(users.find((m) => textOf(m) === 'slow: a')?.clientMsgId, 'A');
});

// ---- task 11 review fixes ----
test('T11-F1a: a send abandoned in a never-resolving preflight never lends its clientMsgId to other user messages', async () => {
  let api!: ExtensionAPI;
  const ext: InlineExtension = { name: 'hang-and-inject', factory: (pi) => {
    api = pi;
    pi.on('input', (e) => (e.text === 'hang' ? new Promise<never>(() => {}) : { action: 'continue' as const }));
  } };
  const { host } = await env({ extensions: [ext] });
  const sid = await idleSession(host);
  void host.send({ sessionId: sid, text: 'hang', clientMsgId: 'H' }).catch(() => {});
  await waitFor('send registered', () => host.get(sid).status === 'running');
  await host.interrupt(sid);
  assert.equal(host.get(sid).status, 'idle');
  void api.sendUserMessage('injected');
  await waitFor('injected run starts', () => sessionOf(host, sid).isStreaming);
  await host.waitIdle(sid);
  await host.waitIdle(sid);
  const users = (await host.page({ sessionId: sid })).messages.filter((m) => m.role === 'user');
  const injected = users.find((m) => textOf(m) === 'injected');
  assert.ok(injected, users.map(textOf).join('|'));
  assert.equal(injected!.clientMsgId, undefined);
  assert.equal(host.get(sid).status, 'idle');
});

test('T11-F1b: an abandoned send accepted after an unrelated injected run still gets its own clientMsgId', async () => {
  let api!: ExtensionAPI;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const ext: InlineExtension = { name: 'gate-and-inject', factory: (pi) => {
    api = pi;
    pi.on('input', async (e) => { if (e.text === 'late') await gate; return { action: 'continue' as const }; });
  } };
  const { host } = await env({ extensions: [ext] });
  const sid = await idleSession(host);
  const sent = host.send({ sessionId: sid, text: 'late', clientMsgId: 'L' });
  await waitFor('send registered', () => host.get(sid).status === 'running');
  await host.interrupt(sid);
  void api.sendUserMessage('injected');
  await waitFor('injected run starts', () => sessionOf(host, sid).isStreaming);
  await host.waitIdle(sid);
  release();
  await sent;
  await host.waitIdle(sid);
  await host.waitIdle(sid);
  const users = (await host.page({ sessionId: sid })).messages.filter((m) => m.role === 'user');
  const cidOf = (t: string) => users.find((m) => textOf(m) === t)?.clientMsgId;
  assert.ok(users.some((m) => textOf(m) === 'late'), users.map(textOf).join('|'));
  assert.equal(cidOf('injected'), undefined);
  assert.equal(cidOf('late'), 'L');
});

test('T11-F4: a resend of an already-queued text is detected as queued even when the run consumed the queue front', async () => {
  let dupSeen = 0;
  const ext: InlineExtension = { name: 'delay-second-dup', factory: (pi) => {
    // Delay the second "slow: dup" past the end of run A, into the run of "slow: x" (which consumed the queue front).
    pi.on('input', async (e) => { if (e.text === 'slow: dup' && ++dupSeen === 2) await sleep(700); return { action: 'continue' as const }; });
  } };
  const { host } = await env({ extensions: [ext] });
  const sid = await idleSession(host);
  await host.send({ sessionId: sid, text: 'slow: a', clientMsgId: 'A' });
  await host.send({ sessionId: sid, text: 'slow: x', clientMsgId: 'X' });
  await host.send({ sessionId: sid, text: 'slow: dup', clientMsgId: 'D1' });
  const session = sessionOf(host, sid);
  assert.deepEqual([...session.getFollowUpMessages()], ['slow: x', 'slow: dup']);
  const r = await host.send({ sessionId: sid, text: 'slow: dup', clientMsgId: 'D2' });
  assert.equal(r.queued, true);
  assert.deepEqual([...session.getFollowUpMessages()], ['slow: dup', 'slow: dup'], 'scenario: queue front was consumed during the preflight');
  await host.waitIdle(sid);
  await host.waitIdle(sid);
  const dups = (await host.page({ sessionId: sid })).messages.filter((m) => m.role === 'user' && textOf(m) === 'slow: dup');
  assert.deepEqual(dups.map((m) => m.clientMsgId), ['D1', 'D2']);
});

test('T12-F1: a send after idle dispose persists preview/leafId, and the turn survives a restart', async () => {
  const home = mkdtempSync(join(tmpdir(), 'hostr-t12-'));
  const e = await env({ home, idleMs: 50 });
  const sid = await idleSession(e.host, 'first');
  await e.host.send({ sessionId: sid, text: 'second', clientMsgId: 's2' });
  await e.host.waitIdle(sid);
  // rewind pins meta.leafId (as in the acceptance run), then continue on the rewound branch
  const second = (await e.host.page({ sessionId: sid })).messages.find((m) => m.role === 'user' && textOf(m) === 'second')!;
  await e.host.rewind(sid, second.id);
  await e.host.send({ sessionId: sid, text: 'branch', clientMsgId: 'b' });
  await e.host.waitIdle(sid);
  await sleep(300); // idle dispose (idleMs=50)
  assert.equal(e.host.get(sid).status, 'idle');
  await e.host.send({ sessionId: sid, text: 'after idle', clientMsgId: 'ai' });
  await e.host.waitIdle(sid);
  await sleep(300); // and dispose again
  assert.equal(e.meta.get(sid)!.preview, 'echo: after idle', 'preview reflects the post-dispose turn');
  const e2 = await env({ home });
  const msgs = (await e2.host.page({ sessionId: sid })).messages;
  assert.deepEqual(msgs.map(textOf), ['first', 'echo: first', 'branch', 'echo: branch', 'after idle', 'echo: after idle']);
  assert.equal(e2.host.get(sid).preview, 'echo: after idle');
  assert.equal(e2.meta.get(sid)!.leafId, msgs.at(-1)!.id, 'persisted leafId is the actual tip after the run');
});

test('T12-F1b: a stored leafId missing from the session file falls back to the file leaf (with a warning)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'hostr-t12b-'));
  let e = await env({ home });
  const sid = await idleSession(e.host, 'one');
  await e.host.send({ sessionId: sid, text: 'two', clientMsgId: 't' });
  await e.host.waitIdle(sid);
  await e.host.shutdown();
  await e.meta.patch(sid, { leafId: 'nope-gone' });
  e = await env({ home });
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(' ')); };
  let msgs: Message[];
  try { msgs = (await e.host.page({ sessionId: sid })).messages; } finally { console.warn = orig; }
  assert.deepEqual(msgs.map(textOf), ['one', 'echo: one', 'two', 'echo: two'], 'no entries hidden');
  assert.ok(warns.some((w) => w.includes('nope-gone')), `warned: ${warns.join(' | ')}`);
});

test('T12-F5: rewind while the publish chain still holds the last run upserts keeps the rewound preview', async () => {
  const { host, meta } = await env();
  const sid = await idleSession(host, 'one');
  meta.slowMs = 250; // every preview patch (upsert producers) lags behind the run
  await host.send({ sessionId: sid, text: 'two', clientMsgId: 't' });
  const t0 = Date.now();
  while (host.get(sid).status !== 'idle' || (await host.page({ sessionId: sid })).messages.length < 4) {
    if (Date.now() - t0 > 5000) throw new Error('run did not finish');
    await sleep(5);
  }
  const two = (await host.page({ sessionId: sid })).messages.find((m) => m.role === 'user' && textOf(m) === 'two')!;
  await host.rewind(sid, two.id);
  await host.waitIdle(sid);
  meta.slowMs = 0;
  assert.equal(meta.get(sid)!.preview, 'echo: one');
  assert.equal(host.get(sid).preview, 'echo: one');
});

test('W6-F2: rewind still publishes messages.removed when the meta patch fails', async () => {
  const { host, meta } = await env();
  const sid = await idleSession(host, 'one');
  await host.send({ sessionId: sid, text: 'two', clientMsgId: 't' });
  await host.waitIdle(sid);
  const two = (await host.page({ sessionId: sid })).messages.find((m) => m.role === 'user' && textOf(m) === 'two')!;
  const w = new Watcher(host, sid);
  await w.until((e) => e.length > 0);
  meta.failLeafPatch = true;
  const orig = console.warn;
  const warns: string[] = [];
  console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(' ')); };
  try {
    await host.rewind(sid, two.id);
    await w.until((evs) => evs.some((e) => e.type === 'messages.removed'), 3000);
  } finally {
    console.warn = orig;
    meta.failLeafPatch = false;
    await w.stop();
  }
  const removed = w.events.find((e): e is Extract<SessionEvent, { type: 'messages.removed' }> => e.type === 'messages.removed')!;
  assert.ok(removed.ids.length >= 2, `removed ${removed.ids.join(',')}`);
  assert.ok(warns.some((x) => x.includes('disk full (meta)')), `warned: ${warns.join(' | ')}`);
});

test('BG-1: a headless-only agent_end drain (pi-subagents) does not keep the session running; extensions see hasUI', async () => {
  // pi-subagents awaits all background runs at agent_end when !ctx.hasUI, which delays agent_settled for the whole run.
  let release!: () => void;
  const drain = new Promise<void>((r) => { release = r; });
  const seen: boolean[] = [];
  const ext: InlineExtension = { name: 'drain', factory: (pi) => {
    pi.on('session_start', (_e, ctx) => { seen.push(ctx.hasUI); });
    pi.on('agent_end', async (_e, ctx) => { seen.push(ctx.hasUI); if (!ctx.hasUI) await drain; });
  } };
  const { host } = await env({ extensions: [ext] });
  try {
    const s = await host.create({ text: 'hi', clientMsgId: 'bg' });
    await Promise.race([host.waitIdle(s.id), sleep(3000).then(() => { throw new Error('waitIdle hung behind agent_end drain'); })]);
    assert.equal(host.get(s.id).status, 'idle');
    assert.ok(seen.length >= 2 && seen.every((x) => x === true), `hasUI seen: ${seen.join(',')}`);
  } finally { release(); }
});

test('a hidden subagent-notify custom message is published live as a system notice (and persisted)', async () => {
  let api: ExtensionAPI | undefined;
  const ext: InlineExtension = { name: 'capture', factory: (pi) => { api = pi; } };
  const { host } = await env({ extensions: [ext] });
  const sid = await idleSession(host);
  const w = new Watcher(host, sid);
  await w.until((e) => e.length > 0);
  api!.sendMessage({ customType: 'subagent-notify', content: 'Background task completed: **worker**\n\nall good', display: false }, { triggerTurn: false });
  const isNotice = (e: SessionEvent) => e.type === 'message.upsert' && e.message.role === 'system' && e.message.notice?.status === 'completed';
  await w.until((evs) => evs.some(isNotice));
  const up = w.events.find(isNotice) as Extract<SessionEvent, { type: 'message.upsert' }>;
  assert.deepEqual(up.message.notice, { kind: 'subagent', title: 'Background task completed: worker', status: 'completed', agent: 'worker' });
  const persisted = (await host.page({ sessionId: sid })).messages.find((m) => m.role === 'system');
  assert.equal(persisted?.id, up.message.id);
  assert.match(textOf(persisted!), /all good/);
  await w.stop();
});

test('idle dispose emits session_shutdown to extensions before disposing (pi-subagents leaked every disposed session otherwise)', async () => {
  const events: string[] = [];
  const probe: InlineExtension = {
    name: 'shutdown-probe',
    factory: (pi: ExtensionAPI) => {
      pi.on('session_start', () => { events.push('start'); });
      pi.on('session_shutdown', (e) => { events.push(`shutdown:${e.reason}`); });
    },
  };
  const registry = () => (globalThis as { __piSubagentRuntimeRegistry?: { activeEntries: Set<unknown> } })
    .__piSubagentRuntimeRegistry?.activeEntries.size ?? 0;
  const { host } = await env({ idleMs: 50, extensions: [probe] });
  const before = registry();
  const sid = await idleSession(host);
  assert.deepEqual(events, ['start']);
  assert.equal(registry(), before + 1, 'pi-subagents registers one runtime per live session');
  await sleep(300); // idle → disposed
  assert.deepEqual(events, ['start', 'shutdown:quit']);
  assert.equal(registry(), before, 'the disposed session is released from the pi-subagents registry');
  // A later touch rebuilds a fresh live (new session_start); shutdown() tears it down the same way.
  await host.send({ sessionId: sid, text: 'again', clientMsgId: 'again' });
  await host.waitIdle(sid);
  await host.shutdown();
  assert.deepEqual(events, ['start', 'shutdown:quit', 'start', 'shutdown:quit']);
});

test('auto title after the first reply; a client rename wins and is never overwritten', async () => {
  const { host, meta } = await env();
  const sid = await idleSession(host, 'please name me');
  const until = async (pred: () => boolean) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > 5000) throw new Error('timeout'); await sleep(20); } };
  await until(() => meta.get(sid)?.titleSource === 'auto');
  const auto = meta.get(sid)!.title;
  assert.notEqual(auto, 'please name me', 'the faux model answered, so the title came from the model');
  assert.ok(auto.length > 0 && [...auto].length <= 40);
  // client rename → user; a later run does not re-title
  await host.update({ sessionId: sid, title: '我的标题' });
  assert.equal(meta.get(sid)!.titleSource, 'user');
  await host.send({ sessionId: sid, text: 'again', clientMsgId: 'again' });
  await host.waitIdle(sid);
  await sleep(100);
  assert.equal(meta.get(sid)!.title, '我的标题');
  // an explicit title at creation is the user's too: no auto title
  const s2 = await host.create({ text: 'x', title: '手动', clientMsgId: 'c2' });
  await host.waitIdle(s2.id);
  await sleep(100);
  assert.deepEqual([meta.get(s2.id)!.title, meta.get(s2.id)!.titleSource], ['手动', 'user']);
});

test('auto title: a reply with no title (thinking used the budget, provider error) is retried after later runs, up to 3 tries', async () => {
  const { host, meta } = await env();
  const rt = await rtP;
  const real = rt.completeSimple.bind(rt);
  const calls: Array<Record<string, unknown>> = [];
  const replies: Array<'thinking' | 'error' | 'ok'> = ['thinking', 'error', 'ok'];
  const warn = console.warn; const warns: string[] = [];
  console.warn = (...a: unknown[]) => { warns.push(a.join(' ')); };
  (rt as { completeSimple: unknown }).completeSimple = async (model: never, ctx: never, opts: Record<string, unknown>) => {
    calls.push(opts);
    const r = { role: 'assistant', api: 'faux', provider: 'faux', model: 'echo', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now(), content: [] };
    const kind = replies.shift() ?? 'ok';
    if (kind === 'thinking') return { ...r, stopReason: 'length', content: [{ type: 'thinking', thinking: 'hmm…' }] };
    if (kind === 'error') return { ...r, stopReason: 'error', errorMessage: '400 quota', content: [] };
    return { ...r, content: [{ type: 'text', text: '「整理发布流程」' }] };
  };
  try {
    const sid = await idleSession(host, 'tidy the publish flow');
    const until = async (n: number) => { const t0 = Date.now(); while (calls.length < n) { if (Date.now() - t0 > 5000) throw new Error(`timeout at ${calls.length}`); await sleep(20); } await sleep(50); };
    await until(1);
    assert.equal(meta.get(sid)!.titleSource, 'prompt');
    assert.ok(warns.some((w) => /no title .*try 1\/3.*length/.test(w)), warns.join('\n'));
    assert.ok((calls[0]!.maxTokens as number) >= 512, 'room for thinking');
    for (const n of [2, 3]) { await host.send({ sessionId: sid, text: `run ${n}`, clientMsgId: `r${n}` }); await host.waitIdle(sid); await until(n); }
    assert.ok(warns.some((w) => /try 2\/3\): error 400 quota/.test(w)), warns.join('\n'));
    assert.deepEqual([meta.get(sid)!.title, meta.get(sid)!.titleSource], ['整理发布流程', 'auto']);
    await host.send({ sessionId: sid, text: 'run 4', clientMsgId: 'r4' }); await host.waitIdle(sid); await sleep(100);
    assert.equal(calls.length, 3, 'titled: no more attempts');
  } finally {
    (rt as { completeSimple: unknown }).completeSimple = real;
    console.warn = warn;
  }
});

test('auto title: a first run that fails (provider error, no reply) still names the session from the request', async () => {
  const { host, meta } = await env();
  const rt = await rtP;
  const realStream = rt.streamSimple.bind(rt);
  const realComplete = rt.completeSimple.bind(rt);
  const prompts: string[] = [];
  let failed = false;
  (rt as { streamSimple: unknown }).streamSimple = (m: never, c: never, o: never) => {
    if (failed) return realStream(m, c, o);
    failed = true; // the session's first model call: a provider error
    const error = { role: 'assistant', api: 'faux', provider: 'faux', model: 'echo', content: [], stopReason: 'error', errorMessage: '400 Third-party apps now draw from extra usage',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() };
    return { async *[Symbol.asyncIterator]() { yield { type: 'error', reason: 'error', error }; }, result: async () => error };
  };
  (rt as { completeSimple: unknown }).completeSimple = async (m: never, ctx: { messages: Array<{ content: string }> }, o: never) => {
    prompts.push(String(ctx.messages[0]!.content));
    return realComplete(m, ctx as never, o);
  };
  try {
    const sid = await idleSession(host, '修复登录页的验证码');
    const t0 = Date.now();
    while (meta.get(sid)?.titleSource !== 'auto') { if (Date.now() - t0 > 5000) throw new Error(`no title; prompts=${JSON.stringify(prompts)}`); await sleep(20); }
    assert.equal(prompts.length, 1);
    assert.ok(prompts[0]!.startsWith('User:\n修复登录页的验证码') && !prompts[0]!.includes('Assistant:'), prompts[0]);
  } finally {
    (rt as { streamSimple: unknown }).streamSimple = realStream;
    (rt as { completeSimple: unknown }).completeSimple = realComplete;
  }
});

test('NOPEAR_AUTO_TITLE=0 keeps the first-prompt title', async () => {
  const { host, meta } = await env({ autoTitle: false });
  const sid = await idleSession(host, 'keep me');
  await sleep(150);
  assert.deepEqual([meta.get(sid)!.title, meta.get(sid)!.titleSource], ['keep me', 'prompt']);
});

test('session_rename: the agent can rename its session, but never over a user-set title', async () => {
  const { host, meta } = await env({ autoTitle: false });
  const sid = await idleSession(host, 'hello');
  await host.send({ sessionId: sid, text: 'tool:session_rename {"title":"「爬山游戏改画风」。"}', clientMsgId: 'r1' });
  await host.waitIdle(sid);
  assert.deepEqual([meta.get(sid)!.title, meta.get(sid)!.titleSource], ['爬山游戏改画风', 'agent']);
  await host.update({ sessionId: sid, title: '我定的' });
  await host.send({ sessionId: sid, text: 'tool:session_rename {"title":"agent 想改"}', clientMsgId: 'r2' });
  await host.waitIdle(sid);
  assert.deepEqual([meta.get(sid)!.title, meta.get(sid)!.titleSource], ['我定的', 'user']);
  const page = await host.page({ sessionId: sid });
  const results = page.messages.flatMap((m) => m.blocks).filter((b) => b.type === 'tool_result').map((b) => (b as { text?: string }).text);
  assert.ok(results.some((t) => t?.includes('会话标题已改为')), JSON.stringify(results));
  assert.ok(results.some((t) => t?.includes('用户手动设置过标题')), JSON.stringify(results));
});
