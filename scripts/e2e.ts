// Full-chain end-to-end check: real saas (temp sqlite, dev login) + real worker (faux model), driven
// from Node through @nopear/core exactly like a client: dev login → register client → claim → sessions.create →
// session.watch (snapshot, deltas, complete with replaces, idle) → disconnect + resume by cursor (replay, not
// snapshot) → rewind / fork / ask → tampered ciphertext rejected (401) → unregistered clientPub rejected (403).
// All of that runs with account E2E off (the default: plaintext frames + x-nopear-plain). Then the v3.1 collab flow
//: project (path = worker temp dir) + memories → card queued on the worker → auto-run → review; cwd
// auto-tag + memory injection; session_list / session_history from inside a session; MCP tools/call card_create;
// E2E on → session tools refused (e2e_enabled) while the sealed v3 flow still works; install-code auto-claim.
// Usage: npm run e2e  (or: npx tsx scripts/e2e.ts). Prints "E2E OK" and exits 0, or the failure and exits 1.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SaasClient, WorkerChannel, RpcCallError, createNoPearEngine, decodeFrame, deriveKey, encodeFrame, fromB64url, generateClientKey, memoryKV, open,
  randomId, readSse, seal,
  type KeyPair, type Platform,
} from '@nopear/core';
import { HEADER_CLIENT, HEADER_PLAIN, type Card, type Message, type SaasEvent, type SessionEvent } from '@nopear/protocol';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OVERALL_TIMEOUT_MS = 300_000;
/** faux `sys:` streams the whole (~28KB) system prompt at 400 tok/s: ~20s. */
const SYS_TIMEOUT_MS = 90_000;
/** Absolute tsx loader, so children can run from a cwd outside the repo (the install-code worker). */
const TSX = import.meta.resolve('tsx');
const STEP_TIMEOUT_MS = 20_000;

// ---------- process / temp-dir bookkeeping (always cleaned up) ----------
const children: { name: string; proc: ChildProcess; log: string[] }[] = [];
const tempDirs: string[] = [];
let cleaning: Promise<void> | null = null;
let interrupted = false;

/** Idempotent: every caller (success, failure, signal) awaits the same teardown. */
function cleanup(): Promise<void> {
  cleaning ??= teardown();
  return cleaning;
}
async function teardown(): Promise<void> {
  await Promise.all(children.map(({ proc }) => new Promise<void>((res) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return res();
    const kill = (sig: NodeJS.Signals) => { try { process.kill(-proc.pid!, sig); } catch { try { proc.kill(sig); } catch { /* gone */ } } };
    const hard = setTimeout(() => kill('SIGKILL'), 5000);
    proc.once('exit', () => { clearTimeout(hard); res(); });
    kill('SIGTERM');
  })));
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
}
const onSignal = (code: number) => () => { interrupted = true; console.error('E2E interrupted, cleaning up'); void cleanup().finally(() => process.exit(code)); };
process.on('SIGINT', onSignal(130));
process.on('SIGTERM', onSignal(143));

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => res(port));
    });
  });
}

// Child env = a small allowlist of the parent's environment + the explicit SAAS_* / NOPEAR_* values, so personal
// config (NOPEAR_* / SAAS_* / GOOGLE_* secrets, PI_* agent dirs, proxies…) never leaks into the hermetic run.
const INHERITED_ENV = /^(PATH|HOME|TMPDIR|LANG|TERM|NODE_.+)$/;
function childEnv(explicit: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && INHERITED_ENV.test(k)) out[k] = v;
  return { ...out, ...explicit };
}

/** Spawn `node --import tsx <entry>` in its own process group; resolves once a stdout line matches `ready`. */
function start(name: string, cwd: string, entry: string, env: Record<string, string>, ready: RegExp): Promise<{ proc: ChildProcess; match: RegExpMatchArray }> {
  const proc = spawn(process.execPath, ['--import', TSX, entry], {
    cwd, env: childEnv(env), stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  const rec: { name: string; proc: ChildProcess; log: string[] } = { name, proc, log: [] };
  children.push(rec);
  return new Promise((res, rej) => {
    let buf = '';
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; rej(new Error(`${name} not ready within ${STEP_TIMEOUT_MS}ms`)); } }, STEP_TIMEOUT_MS);
    const onLine = (line: string) => {
      rec.log.push(line);
      if (rec.log.length > 400) rec.log.shift();
      const m = line.match(ready);
      if (m && !done) { done = true; clearTimeout(timer); res({ proc, match: m }); }
    };
    proc.stdout!.setEncoding('utf8').on('data', (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    proc.stderr!.setEncoding('utf8').on('data', (d: string) => { for (const l of d.split('\n')) if (l) rec.log.push(`[stderr] ${l}`); });
    proc.once('exit', (code, sig) => {
      if (!done) { done = true; clearTimeout(timer); rej(new Error(`${name} exited early (code ${code}, signal ${sig})`)); }
    });
  });
}

// ---------- small assertion / wait helpers ----------
function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Maybe<T> = T | undefined | false;
async function waitFor<T>(what: string, f: () => Maybe<T> | Promise<Maybe<T>>, ms = STEP_TIMEOUT_MS): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await f();
    if (v !== undefined && v !== false) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}
const step = (s: string) => console.log(`✓ ${s}`);
const textOf = (m: Message) => m.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
type Ev<K extends SessionEvent['type']> = Extract<SessionEvent, { type: K }>;
/** First event of the given type (optionally matching `pred`), typed without casts. */
function findEv<K extends SessionEvent['type']>(evs: SessionEvent[], type: K, pred: (e: Ev<K>) => boolean = () => true): Ev<K> | undefined {
  for (const e of evs) if (isEv(e, type) && pred(e)) return e;
  return undefined;
}
const isEv = <K extends SessionEvent['type']>(e: SessionEvent, type: K): e is Ev<K> => e.type === type;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** One live session.watch collecting events into an array. */
class Watch {
  events: SessionEvent[] = [];
  private ac = new AbortController();
  result: Promise<{ ended: string; code?: string }>;
  constructor(ch: WorkerChannel, sessionId: string, cursor?: string) {
    this.result = ch.watch('session.watch', cursor ? { sessionId, cursor } : { sessionId }, (e) => this.events.push(e), this.ac.signal);
    this.result.catch(() => { /* surfaced via until() */ });
  }
  async until<T>(what: string, pred: (evs: SessionEvent[]) => Maybe<T>, ms = STEP_TIMEOUT_MS): Promise<T> {
    return waitFor(`${what} (got: ${this.events.map((e) => e.type).join(',') || 'nothing'})`, async () => {
      const v = pred(this.events);
      if (v === undefined || v === false) {
        const settled = await Promise.race([this.result.then((r) => r, (e: unknown) => ({ ended: `error: ${errMsg(e)}` })), sleep(0).then(() => null)]);
        if (settled) throw new Error(`watch ended (${settled.ended}) while waiting for ${what}`);
      }
      return v;
    }, ms);
  }
  get cursor(): string | undefined { return this.events.at(-1)?.cursor; }
  async stop() { this.ac.abort(); await this.result.catch(() => {}); }
}
const idleAfter = (from: number) => (evs: SessionEvent[]) =>
  evs.slice(from).some((e) => e.type === 'session.updated' && e.session.status === 'idle') || undefined;

// ---------- the scenario ----------
async function main(): Promise<void> {
  // 1. saas (temp sqlite, dev login, no web dir)
  const saasDir = tmp('nopear-e2e-saas-');
  const port = await freePort();
  const saasUrl = `http://127.0.0.1:${port}`;
  await start('saas', join(ROOT, 'saas'), 'src/main.ts', {
    SAAS_PORT: String(port), SAAS_DATA_DIR: join(saasDir, 'data'), SAAS_DB: `sqlite:${join(saasDir, 'saas.db')}`,
    SAAS_DEV_LOGIN: '1', SAAS_PUBLIC_URL: saasUrl,
    SAAS_WEB_DIR: join(saasDir, 'no-web'), SAAS_BOOTSTRAP_TOKEN: '', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '',
  }, /nopear saas listening on/);
  step(`saas up on ${saasUrl}`);

  // 2. worker (faux model; pi auth/models pointed into the temp dir so no personal config is read)
  const workerDir = tmp('nopear-e2e-worker-');
  const work = join(workerDir, 'work');
  mkdirSync(work, { recursive: true });
  const { match } = await start('worker', join(ROOT, 'worker'), 'src/main.ts', {
    NOPEAR_SAAS_URL: saasUrl, NOPEAR_HOME: join(workerDir, 'home'), NOPEAR_TEST_FAUX: '1', NOPEAR_DEFAULT_MODEL: 'faux/echo',
    NOPEAR_DEFAULT_CWD: work, NOPEAR_LABEL: 'e2e-worker', NOPEAR_PI_AUTH: join(workerDir, 'auth.json'),
    NOPEAR_PI_MODELS: join(workerDir, 'models.json'), NOPEAR_SAAS_BOOTSTRAP_TOKEN: '',
  }, /(https?:\/\/\S+\/claim\?w=([^&\s]+)&t=(\S+))/);
  const workerId = decodeURIComponent(match[2]!);
  const claimToken = decodeURIComponent(match[3]!);
  step(`worker up, claim link for ${workerId}`);

  // 3. client: dev login → client key → register → claim → machine online
  let token: string | null = null;
  const platform: Platform = { fetch: globalThis.fetch.bind(globalThis), storage: memoryKV(), secureStorage: memoryKV() };
  const saas = new SaasClient({ baseUrl: saasUrl, platform, getToken: () => token });
  const cfg = await saas.config();
  check(cfg.devLogin === true, 'dev login enabled');
  const login = await saas.devLogin('e2e@example.com');
  token = login.token;
  check((await saas.me()).user.email === 'e2e@example.com', '/api/me returns the dev user');
  // Account E2E defaults to off: the data plane below runs in plaintext until step 14 switches it on.
  let e2eOn = (await saas.settings()).settings.e2e;
  check(e2eOn === false, 'account E2E defaults to off');
  // Global memory goes in before the claim: the worker prefetches it on claim and caches it for 30s,
  // so writing it later would leave the memory-injection check below racing the cache TTL.
  await saas.putMemory('global', null, 'E2E-GLOBAL-MEMORY');
  const clientKey: KeyPair = generateClientKey();
  await saas.registerClient(clientKey.pub, 'e2e');
  const claimed = await saas.claim(workerId, claimToken, 'e2e-box');
  check(claimed.machine.workerId === workerId && claimed.machine.label === 'e2e-box', 'claim returns the machine');
  const machine = await waitFor('machine online', async () => (await saas.machines()).machines.find((m) => m.workerId === workerId && m.online));
  const ch = new WorkerChannel({ saas, workerId, workerPub: machine.workerPub, clientKey, plain: () => !e2eOn });
  const info = await ch.rpc('worker.info', {});
  check(info.workerId === workerId, 'worker.info workerId');
  check(info.models.some((m) => m.id === 'faux/echo'), 'faux/echo model available');
  step('dev login, E2E off by default, client registered, machine claimed and online, worker.info (plaintext)');

  // 4. sessions.create → session.watch: snapshot, deltas, complete with replaces, idle
  const createCid = randomId();
  const { session } = await ch.rpc('sessions.create', { text: 'slow: hi', clientMsgId: createCid, cwd: work });
  const sid = session.id;
  const w1 = new Watch(ch, sid);
  await w1.until('snapshot', (evs) => evs.length > 0);
  check(w1.events[0]!.type === 'snapshot', `first watch event is snapshot (got ${w1.events[0]!.type})`);
  const done1 = await w1.until('assistant complete', (evs) => findEv(evs, 'message.upsert', (e) =>
    e.message.role === 'assistant' && e.message.status === 'complete'));
  check(done1.replaces?.startsWith('live:'), `complete upsert replaces a live id (got ${done1.replaces})`);
  check(textOf(done1.message) === 'echo: slow: hi', `assistant text (got ${JSON.stringify(textOf(done1.message))})`);
  const deltas = w1.events.filter((e) => e.type === 'message.delta' && e.messageId === done1.replaces);
  check(deltas.length > 0, 'received message.delta for the live message');
  const snap = findEv(w1.events.slice(0, 1), 'snapshot');
  check(snap, 'snapshot event');
  const firstUser = [...snap.messages, ...w1.events.flatMap((e) => (e.type === 'message.upsert' ? [e.message] : []))]
    .find((m) => m.role === 'user' && textOf(m) === 'slow: hi');
  check(firstUser?.clientMsgId === createCid, 'created user message carries its clientMsgId');
  await w1.until('session idle', idleAfter(0));
  const cursor = w1.cursor;
  check(typeof cursor === 'string' && cursor.includes('.'), `cursor recorded (${cursor})`);
  step(`sessions.create + watch: snapshot, ${deltas.length} deltas, complete replaces ${done1.replaces}, idle`);

  // 5. drop the watch → send while disconnected → resume with the old cursor → replay (not snapshot)
  await w1.stop();
  const againCid = randomId();
  const sent = await ch.rpc('messages.send', { sessionId: sid, text: 'again', clientMsgId: againCid });
  check(sent.queued === false, 'send on an idle session is not queued');
  const w2 = new Watch(ch, sid, cursor);
  await w2.until('replayed events', (evs) => evs.length > 0);
  check(w2.events[0]!.type !== 'snapshot', `resume with cursor replays instead of snapshot (got ${w2.events[0]!.type})`);
  const againUp = await w2.until('replayed user upsert "again"', (evs) => findEv(evs, 'message.upsert', (e) =>
    e.message.role === 'user' && textOf(e.message) === 'again'));
  check(againUp.message.clientMsgId === againCid, 'replayed user upsert carries clientMsgId');
  await w2.until('session idle after "again"', idleAfter(0));
  check(w2.events.every((e) => e.type !== 'snapshot'), 'no snapshot in the resumed stream');
  step('watch resumed from cursor: replay (no snapshot) includes the "again" user upsert');

  // 5b. /btw: a side question on a running session streams back as `btw` events and leaves the session as it was
  {
    const { session: bs } = await ch.rpc('sessions.create', { text: 'slow: main task', clientMsgId: randomId(), cwd: work });
    const wb = new Watch(ch, bs.id);
    await wb.until('btw snapshot', (evs) => evs.length > 0);
    await ch.rpc('messages.btw', { sessionId: bs.id, id: 'e2e-btw-1', text: 'what is going on?' });
    const answered = await wb.until('btw answer', (evs) => findEv(evs, 'btw', (e) => e.btw.id === 'e2e-btw-1' && e.btw.status !== 'running'));
    check(answered.btw.status === 'done' && answered.btw.text.includes('what is going on?'), `btw answered (got ${JSON.stringify(answered.btw)})`);
    check(wb.events.some((e) => e.type === 'btw' && e.btw.status === 'running'), 'btw announced as running first');
    await wb.until('btw session idle', idleAfter(0));
    const page = await ch.rpc('messages.page', { sessionId: bs.id });
    check(!page.messages.some((m) => textOf(m).includes('what is going on?')), 'the /btw exchange is not in the session');
    await wb.stop();
    step('/btw on a running session: running → done over the watch stream, nothing written to the session');
  }

  // 5a. message queue: sends while running are queued and visible; switch one to steer, cancel the other
  {
    const { session: qs } = await ch.rpc('sessions.create', { text: 'slow: queue run', clientMsgId: randomId(), cwd: work });
    const wq = new Watch(ch, qs.id);
    await wq.until('queue snapshot', (evs) => evs.length > 0);
    const lastQueue = (evs: SessionEvent[]) => {
      for (let i = evs.length - 1; i >= 0; i--) {
        const e = evs[i]!;
        if (e.type === 'queue') return e.items;
        if (e.type === 'snapshot') return e.queue;
      }
      return [];
    };
    const [one, two] = [randomId(), randomId()];
    await ch.rpc('messages.send', { sessionId: qs.id, text: 'queued one', clientMsgId: one });
    await ch.rpc('messages.send', { sessionId: qs.id, text: 'queued two', clientMsgId: two });
    await wq.until('two queued', (evs) => lastQueue(evs).length === 2 || undefined);
    await ch.rpc('messages.queue.update', { sessionId: qs.id, id: two, delivery: 'steer' });
    await wq.until('two switched to steer', (evs) => lastQueue(evs)[0]?.id === two && lastQueue(evs)[0]?.delivery === 'steer' || undefined);
    await ch.rpc('messages.queue.remove', { sessionId: qs.id, id: one });
    await wq.until('one cancelled', (evs) => (lastQueue(evs).length === 1 && lastQueue(evs)[0]!.id === two) || undefined);
    const delivered = await wq.until('steered message delivered', (evs) => findEv(evs, 'message.upsert', (e) => e.message.role === 'user' && e.message.clientMsgId === two));
    check(textOf(delivered.message) === 'queued two', 'steered message text');
    await wq.until('queue drained + idle', (evs) => (lastQueue(evs).length === 0 && idleAfter(0)(evs)) || undefined);
    check(!wq.events.some((e) => e.type === 'message.upsert' && textOf(e.message) === 'queued one'), 'cancelled message never delivered');
    let gone = '';
    try { await ch.rpc('messages.queue.remove', { sessionId: qs.id, id: one }); } catch (e) { gone = (e as { code?: string }).code ?? ''; }
    check(gone === 'not_found', `removing a no-longer-queued message → not_found (got ${gone})`);
    await wq.stop();
    step('message queue: queued sends visible, followUp → steer, cancel, delivered by clientMsgId, not_found after');
  }

  // 5b. engine timeline cache: a "refreshed" engine (new instance, same storages) renders the cached timeline and
  // resumes session.watch from the cached cursor — the worker replays instead of sending a snapshot. (w2 is still
  // attached, so the worker keeps this session's sync log / epoch.)
  {
    const storage = memoryKV();
    const secureStorage = memoryKV({ 'nopear.token': token! });
    const bigStorage = memoryKV();
    /** First event type of every session.watch the engines open (requests/events decoded plain or sealed). */
    const firstEvents: { engine: number; type: string | null }[] = [];
    let current = 1;
    const firstOf = (engine: number) => firstEvents.find((f) => f.engine === engine)?.type ?? undefined;
    const tap = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await fetch(input, init);
      if (!String(input).endsWith('/watch') || !res.ok || !res.body || !(init?.body instanceof Uint8Array)) return res;
      const plain = new Headers(init.headers).get(HEADER_PLAIN) === '1';
      const cpub = new Headers(init.headers).get(HEADER_CLIENT)!;
      const wkey = deriveKey(fromB64url(cpubPriv.get(cpub)!), machine.workerPub, workerId, cpub);
      const req = decodeFrame(plain ? init.body : open(wkey, init.body)).header as { op?: string };
      if (req.op !== 'session.watch') return res;
      const slot = firstEvents.push({ engine: current, type: null }) - 1;
      const [mine, theirs] = res.body.tee();
      const stop = new AbortController();
      void readSse(new Response(mine), (m) => {
        if (!m.data || stop.signal.aborted) return;
        const bytes = fromB64url(m.data);
        firstEvents[slot]!.type = (decodeFrame(plain ? bytes : open(wkey, bytes)).header as SessionEvent).type;
        stop.abort();
      }, stop.signal).catch(() => {});
      return new Response(theirs, { status: res.status, headers: res.headers });
    }) as typeof fetch;
    // the tap decrypts sealed watches with the engine's client key (read back from its secure storage)
    const cpubPriv = new Map<string, string>();
    const mkEngine = async () => {
      const e = createNoPearEngine({ platform: { fetch: tap, storage, secureStorage, bigStorage }, defaultSaasUrl: saasUrl, clientLabel: 'e2e-engine' });
      await e.init();
      const priv = await waitFor('engine client key', async () => (await secureStorage.get('nopear.clientKey')) ?? undefined);
      cpubPriv.set(e.store.getState().clientPub!, priv);
      return e;
    };
    const tlKey = `${workerId}/${sid}`;
    const e1 = await mkEngine();
    e1.openSession(workerId, sid);
    await waitFor('engine 1 timeline', () => (e1.store.getState().timelines[tlKey]?.messages.length ?? 0) > 0 || undefined);
    const cached = e1.store.getState().timelines[tlKey]!.messages.map((m) => m.id);
    e1.flushCache();
    await waitFor('timeline cached', () => [...bigStorage.data.keys()].some((k) => k.startsWith('nopear.tl.v1:') && k.endsWith(tlKey)) || undefined);
    e1.dispose();
    const first1 = await waitFor('engine 1 first watch event', () => firstOf(1));
    check(first1 === 'snapshot', `engine 1 first session.watch event is a snapshot (got ${first1})`);
    // an event after the cached cursor, so the resumed watch has something to replay
    await ch.rpc('sessions.update', { sessionId: sid, pinned: true });
    current = 2;
    const e2 = await mkEngine();
    try {
      e2.openSession(workerId, sid);
      await waitFor('engine 2 hydrated timeline', () => (e2.store.getState().timelines[tlKey]?.messages.length ?? 0) > 0 || undefined);
      check(JSON.stringify(e2.store.getState().timelines[tlKey]!.messages.map((m) => m.id)) === JSON.stringify(cached), 'engine 2 renders the cached messages');
      const first2 = await waitFor('engine 2 first watch event', () => firstOf(2));
      check(first2 !== 'snapshot', `engine 2 resumes from the cached cursor: replay, not snapshot (got ${first2})`);
      await waitFor('engine 2 sees the replayed pin', () => e2.store.getState().timelines[tlKey]?.session?.pinned === true || undefined);
      check(JSON.stringify(e2.store.getState().timelines[tlKey]!.messages.map((m) => m.id)) === JSON.stringify(cached), 'replay adds no duplicate messages');
    } finally {
      e2.dispose();
    }
    await ch.rpc('sessions.update', { sessionId: sid, pinned: false });
  }
  step('engine timeline cache: refreshed engine renders cached messages, resumes by cursor (replay, not snapshot)');

  // 6. rewind the second user message → "again"; fork → same history
  const page = await ch.rpc('messages.page', { sessionId: sid });
  const users = page.messages.filter((m) => m.role === 'user');
  check(users.length === 2 && users[1]!.id === againUp.message.id, `two user messages, second is "again" (${users.map(textOf).join('|')})`);
  const rw = await ch.rpc('sessions.rewind', { sessionId: sid, messageId: users[1]!.id });
  check(rw.undoneText === 'again', `rewind returns "again" (got ${JSON.stringify(rw.undoneText)})`);
  const removed = await w2.until('messages.removed', (evs) => findEv(evs, 'messages.removed'));
  check(removed.ids.includes(users[1]!.id), 'messages.removed includes the rewound user message');
  const afterRewind = (await ch.rpc('messages.page', { sessionId: sid })).messages;
  check(!afterRewind.some((m) => m.id === users[1]!.id), 'rewound message gone from the page');
  const { session: forked } = await ch.rpc('sessions.fork', { sessionId: sid });
  check(forked.id !== sid && forked.kind === 'chat', 'fork returns a new chat session');
  const forkPage = (await ch.rpc('messages.page', { sessionId: forked.id })).messages;
  const shape = (ms: Message[]) => ms.map((m) => `${m.role}:${textOf(m)}`).join('\n');
  check(forkPage.length > 0 && shape(forkPage) === shape(afterRewind), `fork history matches\n--- orig\n${shape(afterRewind)}\n--- fork\n${shape(forkPage)}`);
  step(`rewind → "again" (+messages.removed); fork ${forked.id} has identical history (${forkPage.length} messages)`);

  // 7. ask round-trip
  const mark = w2.events.length;
  await ch.rpc('messages.send', { sessionId: sid, text: 'ask: q', clientMsgId: randomId() });
  const opened = await w2.until('prompt.opened', (evs) => findEv(evs.slice(mark), 'prompt.opened'));
  const q = opened.prompt.questions[0]!;
  check(q.options.length >= 2, 'ask has options');
  await ch.rpc('prompts.answer', { sessionId: sid, promptId: opened.prompt.id, answers: { [q.question]: q.options[0]!.label } });
  const closed = await w2.until('prompt.closed', (evs) => findEv(evs.slice(mark), 'prompt.closed'));
  check(closed.promptId === opened.prompt.id && closed.reason === 'answered', `prompt closed as answered (got ${closed.reason})`);
  await w2.until('assistant "answered"', (evs) => evs.slice(mark).some((e) =>
    e.type === 'message.upsert' && e.message.role === 'assistant' && e.message.status === 'complete' && textOf(e.message) === 'answered') || undefined);
  await w2.until('idle after ask', idleAfter(mark));
  const toolMsg = (await ch.rpc('messages.page', { sessionId: sid })).messages.find((m) => m.role === 'tool');
  const result = toolMsg?.blocks.find((b) => b.type === 'tool_result');
  check(result?.type === 'tool_result' && result.text.includes(q.options[0]!.label), 'tool result carries the answer');
  await w2.stop();
  step('ask: prompt.opened → prompts.answer → prompt.closed(answered) → tool result + reply');

  // 7b. send_file (worker-native tool): file block in the tool message, bytes via blobs.get
  writeFileSync(join(work, 'deliver.html'), '<h1>e2e deliverable</h1>');
  const wf = new Watch(ch, sid);
  await wf.until('snapshot', (evs) => evs.length > 0);
  await ch.rpc('messages.send', { sessionId: sid, text: `tool:send_file ${JSON.stringify({ path: 'deliver.html', title: 'E2E 交付' })}`, clientMsgId: randomId() });
  const fileUp = await wf.until('send_file tool message', (evs) => findEv(evs, 'message.upsert', (e) =>
    e.message.role === 'tool' && e.message.blocks.some((b) => b.type === 'file')));
  const fb = fileUp.message.blocks.find((b) => b.type === 'file');
  check(fb?.type === 'file' && fb.name === 'deliver.html' && fb.mediaType === 'text/html' && fb.title === 'E2E 交付' && fb.size === 24,
    `file block (got ${JSON.stringify(fb)})`);
  const fileBytes = await ch.rpc('blobs.get', { hash: fb.blob });
  check(new TextDecoder().decode(fileBytes.bytes) === '<h1>e2e deliverable</h1>', 'blobs.get returns the sent file bytes');
  await wf.until('idle after send_file', idleAfter(wf.events.indexOf(fileUp)));
  await wf.stop();
  step('send_file: tool message carries a file block; blobs.get returns its bytes');

  // 8. tampered ciphertext → 401; unregistered clientPub → 403
  const key = deriveKey(clientKey.priv, machine.workerPub, workerId, clientKey.pub);
  const sealed = () => seal(key, encodeFrame({ v: 3, rid: randomId(16), ts: Date.now(), op: 'worker.info', args: {} }));
  const rpcPath = `/api/w/${encodeURIComponent(workerId)}/rpc`;
  const okRes = await saas.rawPost(rpcPath, sealed(), { [HEADER_CLIENT]: clientKey.pub });
  check(okRes.status === 200, `untampered raw request accepted (got ${okRes.status})`);
  await okRes.arrayBuffer();
  const bad = sealed();
  const at = bad.length - 5; // inside the GCM ciphertext/tag
  bad[at] = (bad[at] ?? 0) ^ 0x01;
  const tampered = await saas.rawPost(rpcPath, bad, { [HEADER_CLIENT]: clientKey.pub });
  check(tampered.status === 401, `tampered ciphertext → 401 (got ${tampered.status} ${await tampered.text()})`);
  const stranger = generateClientKey();
  const strangerCh = new WorkerChannel({ saas, workerId, workerPub: machine.workerPub, clientKey: stranger });
  const denied = await strangerCh.rpc('worker.info', {}).then(() => null, (e: unknown) => e);
  check(denied instanceof RpcCallError && denied.status === 403, `unregistered clientPub → 403 (got ${denied instanceof RpcCallError ? denied.status : String(denied)})`);
  step('tampered ciphertext → 401, unregistered clientPub → 403');

  // ---------- v3.1 collab flow, account E2E still off ----------
  /** Authenticated JSON call to SaaS that returns the status instead of throwing (for error-status checks). */
  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
    const res = await fetch(`${saasUrl}${path}`, {
      method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, json };
  };
  // Plaintext account event stream (card.updated etc.), so a short-lived `running` state can't be missed by polling.
  const saasEvents: SaasEvent[] = [];
  const evAc = new AbortController();
  let evErr: unknown = null;
  void saas.events((e) => saasEvents.push(e), evAc.signal).catch((e: unknown) => { if (!evAc.signal.aborted) evErr = e; });
  // SaaS sends the `machines` snapshot right before it subscribes, so seeing it means card events will arrive.
  await waitFor('events stream up', () => {
    if (evErr) throw new Error(`events stream failed: ${errMsg(evErr)}`);
    return saasEvents.some((e) => e.type === 'machines');
  });
  try {
    await collabFlow();
  } finally {
    evAc.abort();
  }

  async function collabFlow(): Promise<void> {
    // 9. project whose path on this worker is a temp dir + project memory (global memory was written before the claim)
    const proj = join(realpathSync(workerDir), 'proj');
    mkdirSync(proj, { recursive: true });
    const { project } = await saas.createProject({ name: 'e2e', paths: { [workerId]: proj } });
    check(project.paths[workerId] === proj, 'project path for this worker');
    const pm = await saas.putMemory('project', project.id, 'E2E-PROJECT-MEMORY');
    check(pm.memory.content === 'E2E-PROJECT-MEMORY' && pm.memory.projectId === project.id, 'project memory stored');
    check((await saas.memory('global', null)).memory.content === 'E2E-GLOBAL-MEMORY', 'global memory stored');
    step(`project ${project.id} (path ${proj}) + project/global memory`);

    // 10. card → inbox → queued on this worker → auto-run (running + sessionId) → review
    const { card } = await saas.createCard({ title: 'card one', body: 'hello', projectId: project.id });
    check(card.state === 'inbox' && card.workerId === null, `new card lands in inbox (got ${card.state})`);
    const queued = await saas.updateCard(card.id, { state: 'queued', workerId });
    check(queued.card.state === 'queued' && queued.card.workerId === workerId, 'card queued on this worker');
    const running = await waitFor(`card running with a sessionId${evErr ? ` (events stream failed: ${errMsg(evErr)})` : ''}`, async () =>
      saasEvents.flatMap((e) => (e.type === 'card.updated' && e.card.id === card.id ? [e.card] : []))
        .find((c) => c.state === 'running' && c.sessionId)
      ?? (await saas.cards()).cards.find((c) => c.id === card.id && c.state === 'running' && c.sessionId));
    const cardSid = running.sessionId!;
    const reviewed: Card = await waitFor('card in review', async () =>
      (await saas.cards()).cards.find((c) => c.id === card.id && c.state === 'review'));
    check(reviewed.sessionId === cardSid && reviewed.workerId === workerId, 'review card keeps its session and worker');
    check(!reviewed.error, `card ran without error (got ${reviewed.error})`);
    const cardSession = (await ch.rpc('sessions.get', { sessionId: cardSid })).session;
    check(cardSession.projectId === project.id && cardSession.cwd === proj, `card session tagged + runs in the project path (${cardSession.projectId} ${cardSession.cwd})`);
    step(`card ${card.id}: inbox → queued → running (session ${cardSid}) → review`);

    // 11. session in the project dir: auto-tagged by cwd; system prompt carries global + project memory.
    // Order-dependent: project memory is injected from the worker's cache, which step 10 already warmed (the card
    // session got tagged to the project → onTagged → prefetch). Run this before any project-tagged session and the
    // first system prompt may race the prefetch.
    const { session: sysSession } = await ch.rpc('sessions.create', { text: 'sys:', clientMsgId: randomId(), cwd: proj });
    check(sysSession.projectId === project.id, `cwd auto-tag → project (got ${sysSession.projectId})`);
    const ws = new Watch(ch, sysSession.id);
    const sysDone = await ws.until('sys: reply', (evs) => findEv(evs, 'message.upsert', (e) =>
      e.message.role === 'assistant' && e.message.status === 'complete'), SYS_TIMEOUT_MS);
    const sysText = textOf(sysDone.message);
    check(sysText.startsWith('system: '), 'faux sys: reply');
    for (const s of ['# 用户全局记忆', 'E2E-GLOBAL-MEMORY', '# 项目记忆（e2e）', 'E2E-PROJECT-MEMORY']) {
      check(sysText.includes(s), `system prompt contains ${JSON.stringify(s)}`);
    }
    await ws.until('sys session idle', idleAfter(0));
    await ws.stop();
    step('session in the project dir: auto-tagged; system prompt has global + project memory');

    // 12. from another session: session_list finds the card session; session_history reads it
    await waitFor('card session in the SaaS index', async () =>
      (await saas.sessionIndex({ projectId: project.id })).sessions.some((s) => s.sessionId === cardSid && s.workerId === workerId));
    const listCmd = `tool:session_list ${JSON.stringify({ projectId: project.id })}`;
    const { session: toolSession } = await ch.rpc('sessions.create', { text: listCmd, clientMsgId: randomId(), cwd: work });
    const wt = new Watch(ch, toolSession.id);
    const answered = (from: number) => (evs: SessionEvent[]) => findEv(evs.slice(from), 'message.upsert', (e) =>
      e.message.role === 'assistant' && e.message.status === 'complete' && textOf(e.message).startsWith('answered:'));
    const listReply = textOf((await wt.until('session_list answer', answered(0))).message);
    check(listReply.includes(cardSid), `session_list answer contains the card session (got ${listReply.slice(0, 300)})`);
    await wt.until('idle after session_list', idleAfter(0));
    const mark2 = wt.events.length;
    const histCmd = `tool:session_history ${JSON.stringify({ workerId, sessionId: cardSid })}`;
    await ch.rpc('messages.send', { sessionId: toolSession.id, text: histCmd, clientMsgId: randomId() });
    const histReply = textOf((await wt.until('session_history answer', answered(mark2))).message);
    check(histReply.includes('hello') && !histReply.includes('"error"'), `session_history answer has the card text (got ${histReply.slice(0, 300)})`);
    await wt.until('idle after session_history', idleAfter(mark2));
    await wt.stop();
    step('in-session tools: session_list sees the card session, session_history reads it');

    // 13. MCP: API token → raw stateless JSON-RPC initialize + tools/call card_create → card in inbox
    const { token: apiToken } = await saas.createApiToken('e2e-mcp');
    const mcp = async (id: number, method: string, params: unknown, protocolVersion?: string) => {
      const res = await fetch(`${saasUrl}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
          ...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      });
      const text = await res.text();
      check(res.status === 200, `MCP ${method} → 200 (got ${res.status} ${text})`);
      const msg = JSON.parse(text) as { id: number; result?: any; error?: unknown };
      check(msg.id === id && msg.result && !msg.error, `MCP ${method} result (got ${text})`);
      return msg.result;
    };
    const init = await mcp(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'nopear-e2e', version: '1' } });
    check(init.serverInfo?.name === 'nopear' && init.capabilities?.tools, `MCP initialize (got ${JSON.stringify(init)})`);
    const call = await mcp(2, 'tools/call', { name: 'card_create', arguments: { title: 'from mcp' } }, init.protocolVersion);
    check(!call.isError, `MCP card_create ok (got ${JSON.stringify(call)})`);
    const inbox = (await saas.cards({ state: 'inbox' })).cards;
    check(inbox.some((c) => c.title === 'from mcp' && c.projectId === null), `card from MCP is in the inbox (${inbox.map((c) => c.title).join('|')})`);
    step('MCP: initialize + tools/call card_create → "from mcp" in the inbox');

    // 14. E2E on: session tools refused, plaintext refused (channel falls back sealed), the sealed v3 flow still works; then back off
    e2eOn = (await saas.patchSettings({ e2e: true })).settings.e2e;
    check(e2eOn === true, 'E2E switched on');
    const refused = await api('POST', '/api/tools/session_history', { args: { workerId, sessionId: cardSid } });
    check(refused.status === 409 && refused.json?.error?.code === 'e2e_enabled', `session_history with E2E on → 409 e2e_enabled (got ${refused.status} ${JSON.stringify(refused.json)})`);
    const plainFrame = encodeFrame({ v: 3, rid: randomId(16), ts: Date.now(), op: 'worker.info', args: {} });
    const plainRes = await saas.rawPost(rpcPath, plainFrame, { [HEADER_CLIENT]: clientKey.pub, [HEADER_PLAIN]: '1' });
    const plainText = await plainRes.text();
    const plainCode = (() => { try { return (JSON.parse(plainText) as { error?: { code?: string } }).error?.code; } catch { return undefined; } })();
    check(plainRes.status === 409 && plainCode === 'e2e_enabled', `raw plaintext rpc with E2E on → 409 e2e_enabled (got ${plainRes.status} ${plainText})`);
    // a channel still in (stale) plain mode transparently retries sealed after the 409
    const plainCh = new WorkerChannel({ saas, workerId, workerPub: machine.workerPub, clientKey, plain: () => true });
    const fallback = await plainCh.rpc('worker.info', {}).then((r) => r, (e: unknown) => new Error(errMsg(e)));
    check(!(fallback instanceof Error) && fallback.workerId === workerId, `stale-plain channel falls back to sealed with E2E on (got ${fallback instanceof Error ? fallback.message : JSON.stringify(fallback)})`);
    const { session: enc } = await ch.rpc('sessions.create', { text: 'slow: sealed', clientMsgId: randomId(), cwd: work });
    const we = new Watch(ch, enc.id);
    await we.until('snapshot (sealed)', (evs) => evs[0]?.type === 'snapshot');
    const encDone = await we.until('sealed assistant complete', (evs) => findEv(evs, 'message.upsert', (e) =>
      e.message.role === 'assistant' && e.message.status === 'complete'));
    check(textOf(encDone.message) === 'echo: slow: sealed', `sealed reply (got ${JSON.stringify(textOf(encDone.message))})`);
    check(we.events.some((e) => e.type === 'message.delta'), 'sealed stream carries deltas');
    await we.until('sealed idle', idleAfter(0));
    const encCursor = we.cursor;
    check(typeof encCursor === 'string', `sealed cursor recorded (${encCursor})`);
    await we.stop();
    await ch.rpc('messages.send', { sessionId: enc.id, text: 'sealed again', clientMsgId: randomId() });
    const wr = new Watch(ch, enc.id, encCursor);
    await wr.until('sealed replayed events', (evs) => evs.length > 0);
    check(wr.events[0]!.type !== 'snapshot', `sealed resume with cursor replays instead of snapshot (got ${wr.events[0]!.type})`);
    await wr.until('sealed second reply', (evs) => evs.some((e) => e.type === 'message.upsert'
      && e.message.role === 'assistant' && e.message.status === 'complete' && textOf(e.message) === 'echo: sealed again') || undefined);
    await wr.until('sealed idle again', idleAfter(0));
    check(wr.events.every((e) => e.type !== 'snapshot'), 'no snapshot in the sealed resumed stream');
    await wr.stop();
    e2eOn = (await saas.patchSettings({ e2e: false })).settings.e2e;
    check(e2eOn === false, 'E2E switched back off');
    check((await ch.rpc('worker.info', {})).workerId === workerId, 'plaintext rpc works again');
    step('E2E on: session_history → 409 e2e_enabled, raw plaintext → 409 + channel falls back sealed, sealed create/send/stream + cursor resume OK; switched back off');

    // 15. install code: a fresh worker registers with NOPEAR_INSTALL_CODE → auto-claimed, labelled, online, no claim link
    const ic = await saas.createInstallCode('e2e-wsl');
    check(ic.code && ic.command.includes(ic.code), 'install code + command');
    const w2Dir = tmp('nopear-e2e-worker2-');
    const w2Cwd = join(w2Dir, 'cwd'); // no .env here: nothing in the repo can be touched by the post-register cleanup
    const w2Work = join(w2Dir, 'work');
    mkdirSync(w2Cwd, { recursive: true });
    mkdirSync(w2Work, { recursive: true });
    const { match: m2 } = await start('worker2', w2Cwd, join(ROOT, 'worker', 'src', 'main.ts'), {
      NOPEAR_SAAS_URL: saasUrl, NOPEAR_HOME: join(w2Dir, 'home'), NOPEAR_TEST_FAUX: '1', NOPEAR_DEFAULT_MODEL: 'faux/echo',
      NOPEAR_DEFAULT_CWD: w2Work, NOPEAR_PI_AUTH: join(w2Dir, 'auth.json'), NOPEAR_PI_MODELS: join(w2Dir, 'models.json'),
      NOPEAR_SAAS_BOOTSTRAP_TOKEN: '', NOPEAR_INSTALL_CODE: ic.code,
    }, /\[nopear\] worker (w_[a-z0-9]+) /);
    const worker2Id = m2[1]!;
    check(worker2Id !== workerId, 'second worker has its own identity');
    const m2Machine = await waitFor('install-code worker claimed + online', async () =>
      (await saas.machines()).machines.find((m) => m.workerId === worker2Id && m.online));
    check(m2Machine.label === 'e2e-wsl', `machine label from the install code (got ${m2Machine.label})`);
    // A successful rpc proves worker2 has applied the account authz (an unclaimed worker prints its link right
    // after the first authz), so the log check below isn't racing a fixed sleep.
    const ch2 = new WorkerChannel({ saas, workerId: worker2Id, workerPub: m2Machine.workerPub, clientKey, plain: () => !e2eOn });
    const info2 = await waitFor('worker.info on the install-code worker', () =>
      ch2.rpc('worker.info', {}).then((r) => r, () => undefined));
    check(info2.workerId === worker2Id, 'worker2 worker.info workerId');
    const w2Log = children.find((c) => c.name === 'worker2')!.log;
    check(!w2Log.some((l) => l.includes('/claim?w=')), 'no claim link printed by the install-code worker');
    step(`install code: worker ${worker2Id} auto-claimed as "e2e-wsl", online, no claim link`);
  }
}

const overall = setTimeout(() => {
  console.error(`E2E FAILED: overall timeout ${OVERALL_TIMEOUT_MS}ms`);
  void cleanup().finally(() => process.exit(1));
}, OVERALL_TIMEOUT_MS);

main().then(
  async () => {
    clearTimeout(overall);
    await cleanup();
    console.log('E2E OK');
    process.exit(0);
  },
  async (err: unknown) => {
    clearTimeout(overall);
    if (interrupted) { await cleanup(); process.exit(130); }
    console.error(`\nE2E FAILED: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    for (const c of children) {
      console.error(`\n----- ${c.name} log (last 60 lines) -----`);
      console.error(c.log.slice(-60).join('\n'));
    }
    await cleanup();
    process.exit(1);
  },
);
