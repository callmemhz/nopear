// NoPearEngine: client-side controller shared by web + mobile. Owns login, client key, SaaS presence
// stream, one machine.watch per online machine, ref-counted session.watch, and all session actions.
import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  memoryKey, sessionKey,
  type AccessRequest, type AccountSettings, type AdminMachine, type AdminOverview, type AdminUser, type AutoCompactSettings, type AllowlistEntry, type AllowlistRole, type ApiTokenInfo, type Attachment, type Card, type CardPatch, type InstallCodeResult, type Machine,
  type MachineEvent, type MemoryDoc, type MemoryScope, type Message, type Project, type RpcArgs, type RpcOp, type RpcResult, type SaasEvent,
  type Session, type SessionEvent, type SessionIndexEntry, type TaskTranscriptRef, type User, type WatchArgs, type WorkerInfo,
  SSE_PING_MS, SSE_STALL_MS,
} from '@nopear/protocol';
import { b64url, fromB64url, generateClientKey, publicKeyOf, randomId, type KeyPair } from './crypto';
import type { KV, Platform } from './platform';
import { SaasClient, SaasError } from './saas';
import { RpcCallError, WorkerChannel } from './channel';
import {
  addOptimistic, applySessionEvent, dismissBtw, dropPending, dropQueued, emptyTimeline, markSendFailed, markSending, markSent, prependPage, upsertBtw,
  type TimelineState,
} from './timeline';

export type MachineConn = 'connecting' | 'online' | 'offline';
export interface EngineNotice {
  kind: 'session.idle' | 'session.error' | 'prompt';
  workerId: string; sessionId?: string; title: string;
}
export interface EngineState {
  saasUrl: string; token: string | null; user: User | null; clientPub: string | null;
  /** Login allowlist view of the current user (from `/api/me`); null when logged out / not loaded. */
  access: { role: AllowlistRole | null; allowlistEnabled: boolean } | null;
  machines: Record<string, Machine>; machineConn: Record<string, MachineConn>; workerInfo: Record<string, WorkerInfo>;
  sessions: Record<string, Record<string, Session>>;
  timelines: Record<string, TimelineState>;
  projects: Record<string, Project>;                 // by project id
  cards: Record<string, Card>;                       // by card id
  memories: Record<string, MemoryDoc>;               // by memoryKey(scope, projectId)
  sessionIndex: Record<string, SessionIndexEntry>;   // by sessionKey(workerId, sessionId)
  settings: AccountSettings | null;                  // null until loaded
  drafts: Record<string, string>;
  error: string | null;
  /** True while the sidebar shows state hydrated from the local snapshot cache and the live machine list
   *  has not arrived yet (machines are shown as not-yet-online until their presence lands). */
  syncing: boolean;
}
export interface NoPearEngine {
  store: StoreApi<EngineState>;
  init(): Promise<void>;
  setSaasUrl(url: string): Promise<void>;
  loginDev(email: string): Promise<void>;
  completeLogin(token: string): Promise<void>;
  logout(): Promise<void>;
  openSession(workerId: string, sessionId: string): void;
  closeSession(workerId: string, sessionId: string): void;
  loadEarlier(workerId: string, sessionId: string): Promise<void>;
  createSession(workerId: string, args: Omit<RpcArgs<'sessions.create'>, 'clientMsgId'>): Promise<Session>;
  send(workerId: string, sessionId: string, text: string, opts?: { attachments?: Attachment[]; delivery?: 'followUp' | 'steer' }): Promise<void>;
  /** `/btw`: ask a side question; the answer appears in `timeline.btw` (never in the session). Errors land on the entry. */
  btw(workerId: string, sessionId: string, question: string): Promise<void>;
  dismissBtw(workerId: string, sessionId: string, id: string): void;
  retrySend(workerId: string, sessionId: string, clientMsgId: string): Promise<void>;
  discardSend(workerId: string, sessionId: string, clientMsgId: string): string;
  /** Cancel a queued message; rejects with not_found once it was delivered. */
  removeQueued(workerId: string, sessionId: string, id: string): Promise<void>;
  /** Edit a queued message's text and/or switch followUp ↔ steer; the worker's queue event updates the view. */
  updateQueued(workerId: string, sessionId: string, id: string, patch: { text?: string; delivery?: 'followUp' | 'steer' }): Promise<void>;
  interrupt(workerId: string, sessionId: string): Promise<void>;
  rewind(workerId: string, sessionId: string, messageId: string): Promise<string>;
  fork(workerId: string, sessionId: string, messageId?: string): Promise<Session>;
  updateSession(workerId: string, sessionId: string, patch: Omit<RpcArgs<'sessions.update'>, 'sessionId'>): Promise<void>;
  answerPrompt(workerId: string, sessionId: string, promptId: string, answers: Record<string, string>, note?: string): Promise<void>;
  stopTask(workerId: string, sessionId: string, taskId: string): Promise<void>;
  /** Read-only conversation of a background run / workflow step (`BackgroundTask.transcript`, `TaskStep.transcript`). */
  taskTranscript(workerId: string, sessionId: string, ref: TaskTranscriptRef): Promise<RpcResult<'tasks.transcript'>>;
  rpc<O extends RpcOp>(workerId: string, op: O, args: RpcArgs<O>): Promise<RpcResult<O>>;
  claim(workerId: string, claimToken: string, label?: string): Promise<void>;
  renameMachine(workerId: string, label: string): Promise<void>;
  removeMachine(workerId: string): Promise<void>;
  setDraft(workerId: string, sessionId: string, text: string): void;
  createProject(input: { name: string; description?: string; paths?: Record<string, string> }): Promise<Project>;
  updateProject(id: string, patch: { name?: string; description?: string; paths?: Record<string, string> }): Promise<Project>;
  deleteProject(id: string): Promise<void>;
  createCard(input: { title: string; body?: string; projectId?: string | null }): Promise<Card>;
  updateCard(id: string, patch: CardPatch): Promise<Card>;
  deleteCard(id: string): Promise<void>;
  loadMemory(scope: MemoryScope, projectId: string | null): Promise<MemoryDoc>;
  saveMemory(scope: MemoryScope, projectId: string | null, content: string): Promise<MemoryDoc>;
  setE2e(on: boolean): Promise<void>;
  /** Account auto-compaction; partial updates keep the fields that are not given. */
  setAutoCompact(patch: Partial<AutoCompactSettings>): Promise<AccountSettings>;
  createApiToken(label: string): Promise<string>;
  listApiTokens(): Promise<ApiTokenInfo[]>;
  deleteApiToken(id: string): Promise<void>;
  createInstallCode(label?: string): Promise<InstallCodeResult>;
  listAllowlist(): Promise<AllowlistEntry[]>;
  /** Refreshes `access` afterwards (enabling open mode / demoting yourself). */
  putAllowlist(email: string, role: AllowlistRole): Promise<AllowlistEntry>;
  /** Refreshes `access` afterwards (a 401 — you removed yourself — logs out). */
  deleteAllowlist(email: string): Promise<void>;
  /** Admin console (allowlist admins only; the server answers 403 to everyone else). */
  admin: {
    overview(): Promise<AdminOverview>;
    users(): Promise<AdminUser[]>;
    setDisabled(userId: string, disabled: boolean): Promise<void>;
    requests(): Promise<AccessRequest[]>;
    approve(email: string, role: AllowlistRole): Promise<void>;
    reject(email: string): Promise<void>;
    deleteRequest(email: string): Promise<void>;
    machines(): Promise<AdminMachine[]>;
    removeMachine(workerId: string): Promise<{ deleted: boolean }>;
  };
  onNotice(listener: (n: EngineNotice) => void): () => void;
  /** Write pending snapshot- and timeline-cache updates now (hosts call it on page hide / app background). */
  flushCache(): void;
  /** Health-check every long-lived stream now (hosts call it when the page becomes visible / the network comes back /
   *  the app returns to the foreground): a stream silent for longer than a ping interval is reopened at once (session
   *  watches resume from their cursor), a loop waiting in reconnect backoff retries immediately, and session watches
   *  that ended while views still hold them are restarted. */
  resume(): void;
  dispose(): void;
}

const K_URL = 'nopear.saasUrl';
const K_DRAFTS = 'nopear.drafts';
const K_TOKEN = 'nopear.token';
const K_CLIENT = 'nopear.clientKey';
/** Persistent sidebar snapshot (stale-while-revalidate): `nopear.cache.v1:<saasUrl>:<userId>` + a pointer to it. */
const CACHE_VERSION = 1;
const K_CACHE_PTR = 'nopear.cache.v1.current';
const cacheKey = (saasUrl: string, userId: string) => `nopear.cache.v1:${saasUrl}:${userId}`;
const CACHE_MAX_CHARS = 2_000_000;
const CACHE_DELAY = 1_000;
const CACHE_MAX_WAIT = 5_000;
/** State slices persisted in the snapshot cache (compared by reference to decide whether to rewrite it). */
const CACHED_SLICES = ['user', 'access', 'settings', 'machines', 'workerInfo', 'sessions', 'projects', 'cards', 'sessionIndex'] as const;
type CacheSnapshot = { version: number; saasUrl: string } & Pick<EngineState, (typeof CACHED_SLICES)[number]>;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Persistent per-session timeline cache (platform.bigStorage): `nopear.tl.v1:<saasUrl>:<userId>:<workerId>/<sessionId>`,
 *  plus an LRU index of the stored keys (most recent last) so eviction and logout clearing are cheap. */
const TL_VERSION = 1;
const TL_PREFIX = 'nopear.tl.v1:';
const K_TL_INDEX = 'nopear.tl.v1.index';
const TL_MAX_MESSAGES = 300;
const TL_MAX_SESSIONS = 30;
const TL_MAX_CHARS = 4_000_000;
const TL_DELAY = 1_500;
const TL_MAX_WAIT = 5_000;
type TimelineRecord = Required<Pick<TimelineState, 'cursor' | 'messages' | 'hasMore' | 'prompts' | 'tasks' | 'queue'>>
  & { version: number; session?: Session; savedAt: string };
const isLocalMsg = (m: Message) => m.id.startsWith('local:');
/** A message the worker may still change through deltas (live bubble) — a timeline holding one is not cached. */
const isUnsettled = (m: Message) => m.id.startsWith('live:') || m.status === 'streaming';
/** resume(): a stream with no bytes for this long (one ping interval + slack) is presumed dead and reopened. */
const RESUME_STALE_MS = SSE_PING_MS + 5_000;
const BACKOFF_MIN = 500;
const BACKOFF_MAX = 15_000;
const PAGE = 100;
const INDEX_LIMIT = 500;
const COLLAB_EMPTY = { projects: {}, cards: {}, memories: {}, sessionIndex: {}, settings: null } satisfies Partial<EngineState>;

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) return resolve();
  const t = setTimeout(done, ms);
  function done() { clearTimeout(t); signal.removeEventListener('abort', done); resolve(); }
  signal.addEventListener('abort', done, { once: true });
});
const jitter = (ms: number) => Math.round(ms * (0.8 + Math.random() * 0.4));
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const authStatus = (e: unknown) => e instanceof RpcCallError && (e.status === 401 || e.status === 403);

export function createNoPearEngine(opts: {
  platform: Platform; defaultSaasUrl: string; clientLabel: string;
  /** Snapshot-cache write debounce (ms); tests shorten it. */
  cacheDelayMs?: number;
  /** Timeline-cache write debounce (ms, default 1500) and number of sessions kept (default 30); tests shorten them. */
  timelineDelayMs?: number;
  timelineMaxSessions?: number;
  /** Stream watchdog (ms without any bytes before a stream is aborted and reopened; default SSE_STALL_MS) and the
   *  resume() staleness threshold (default SSE_PING_MS + 5s); tests shorten them. */
  stallMs?: number;
  resumeStaleMs?: number;
}): NoPearEngine {
  const { platform } = opts;
  const store = createStore<EngineState>(() => ({
    saasUrl: opts.defaultSaasUrl, token: null, user: null, access: null, clientPub: null,
    machines: {}, machineConn: {}, workerInfo: {}, sessions: {}, timelines: {}, ...COLLAB_EMPTY, drafts: {}, error: null, syncing: false,
  }));
  const get = store.getState;
  const set = store.setState;

  let saas = new SaasClient({ baseUrl: opts.defaultSaasUrl, platform, getToken: () => get().token });
  let clientKey: KeyPair | null = null;
  let life = new AbortController();               // aborted on logout/dispose
  const channels = new Map<string, WorkerChannel>();
  const machineWatch = new Map<string, AbortController>();
  /** dead: the watch loop exited (end / auth failure) but views still hold refs; openSession revives it. */
  const sessionWatch = new Map<string, { refs: number; abort: AbortController; dead: boolean }>();
  const listeners = new Set<(n: EngineNotice) => void>();
  const notifiedPrompts = new Set<string>();       // `${sessionKey}/${promptId}` — one notice per prompt
  let draftTimer: ReturnType<typeof setTimeout> | null = null;

  // ---------- stream health (watchdog + resume) ----------
  const stallMs = opts.stallMs ?? SSE_STALL_MS;
  const resumeStaleMs = opts.resumeStaleMs ?? RESUME_STALE_MS;
  const nowMs = () => Date.now();
  /** One reconnect loop's handle: the current attempt (aborted by resume() when stale) and its backoff sleep. */
  class StreamCtl {
    last = nowMs();
    private attempt: AbortController | null = null;
    private wake: (() => void) | null = null;
    private fast = false;
    constructor(private readonly loop: AbortSignal) {}
    /** Signal for one connection attempt (aborted with the loop, or by resume()). */
    private unlink: (() => void) | null = null;
    begin(): AbortSignal {
      this.end();
      const a = new AbortController();
      this.attempt = a;
      this.last = nowMs();
      if (this.loop.aborted) a.abort();
      else {
        const onLoop = () => a.abort();
        this.loop.addEventListener('abort', onLoop, { once: true });
        this.unlink = () => this.loop.removeEventListener('abort', onLoop);
      }
      return a.signal;
    }
    end() { this.unlink?.(); this.unlink = null; this.attempt = null; }
    readonly activity = () => { this.last = nowMs(); };
    /** Reconnect backoff; returns at once after resume() asked for a fast retry. */
    async backoff(ms: number): Promise<void> {
      if (this.fast) { this.fast = false; return; }
      const w = new AbortController();
      this.wake = () => w.abort();
      const onLoop = () => w.abort();
      this.loop.addEventListener('abort', onLoop, { once: true });
      try { await sleep(ms, w.signal); } finally { this.wake = null; this.loop.removeEventListener('abort', onLoop); }
      this.fast = false;
    }
    resume() {
      if (this.loop.aborted) return;
      if (this.attempt && !this.attempt.signal.aborted) {
        if (nowMs() - this.last <= resumeStaleMs) return; // healthy
        this.fast = true;
        this.attempt.abort();
      } else {
        this.fast = true;
        this.wake?.();
      }
    }
  }
  const streams = new Set<StreamCtl>();
  /** Opts for one watch/events attempt of `ctl`. */
  const streamOpts = (ctl: StreamCtl) => ({ stallMs, onActivity: ctl.activity });

  const notify = (n: EngineNotice) => { for (const l of listeners) { try { l(n); } catch { /* listener error */ } } };
  const setError = (e: unknown) => set({ error: errMsg(e) });

  // ---------- state helpers ----------
  function upsertSession(workerId: string, s: Session) {
    const prev = get().sessions[workerId]?.[s.id];
    if (prev) {
      if (prev.status === 'running' && s.status === 'idle') notify({ kind: 'session.idle', workerId, sessionId: s.id, title: s.title });
      if (prev.status === 'running' && s.status === 'error') notify({ kind: 'session.error', workerId, sessionId: s.id, title: s.title });
      // While a session.watch is open, prompt.opened drives the notice (deduped by prompt id).
      const sw = sessionWatch.get(sessionKey(workerId, s.id));
      if (s.promptCount > prev.promptCount && (!sw || sw.dead)) notify({ kind: 'prompt', workerId, sessionId: s.id, title: s.title });
    }
    set((st) => ({ sessions: { ...st.sessions, [workerId]: { ...st.sessions[workerId], [s.id]: s } } }));
  }
  function updateTimeline(key: string, f: (t: TimelineState) => TimelineState) {
    set((st) => ({ timelines: { ...st.timelines, [key]: f(st.timelines[key] ?? emptyTimeline()) } }));
  }
  const setConn = (workerId: string, c: MachineConn) => set((st) => ({ machineConn: { ...st.machineConn, [workerId]: c } }));

  // ---------- channels / auth retry ----------
  function channel(workerId: string): WorkerChannel {
    const m = get().machines[workerId];
    if (!m) throw new RpcCallError('not_found', `unknown machine ${workerId}`, 404);
    if (!clientKey) throw new RpcCallError('unauthorized', 'not logged in', 401);
    const cacheKey = `${workerId}|${m.workerPub}|${clientKey.pub}`;
    let ch = channels.get(cacheKey);
    if (!ch) {
      ch = new WorkerChannel({
        // Plaintext only once settings came from the SaaS this run — never on the strength of a cached copy.
        saas, workerId, workerPub: m.workerPub, clientKey, plain: () => settingsLive && get().settings?.e2e === false,
        // SaaS refused a plaintext request with 409 e2e_enabled: our settings are stale (the channel retried sealed).
        onStaleSettings: () => { void refreshSettings(); },
      });
      channels.set(cacheKey, ch);
    }
    return ch;
  }
  async function registerClient(): Promise<void> {
    if (!clientKey) return;
    try {
      await saas.registerClient(clientKey.pub, opts.clientLabel);
    } catch (e) {
      if (e instanceof SaasError && e.status === 401) await doLogout(false);
      throw e;
    }
  }
  /** A watch the worker ended with code `unauthorized` (revoked / unknown client key) is a data-plane 401. */
  async function watchChecked<T extends { ended: string; code?: string }>(fn: () => Promise<T>): Promise<T> {
    const r = await fn();
    if (r.ended === 'end' && r.code === 'unauthorized') throw new RpcCallError('unauthorized', 'watch ended: unauthorized', 401);
    return r;
  }
  /** Re-fetch account settings (an e2e change restarts every open watch in the new mode). Concurrent callers
   *  share one in-flight GET /api/settings. */
  let settingsRefresh: Promise<void> | null = null;
  function refreshSettings(): Promise<void> {
    if (!settingsRefresh) {
      settingsRefresh = (async () => {
        try { applySettings((await saas.settings()).settings); } catch { /* keep current settings; the reopen backs off */ } finally { settingsRefresh = null; }
      })();
    }
    return settingsRefresh;
  }
  /** Worker ended a plaintext watch because plaintext is no longer allowed: refresh settings; the caller then
   *  reopens — no client re-registration. */
  const onPlaintextDisabled = (): Promise<void> => refreshSettings();
  async function withAuthRetry<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn(); } catch (e) {
      if (!authStatus(e)) throw e;
      await registerClient();
      return fn();
    }
  }
  const rpc = async <O extends RpcOp>(workerId: string, op: O, args: RpcArgs<O>): Promise<RpcResult<O>> => {
    try {
      return await withAuthRetry(() => channel(workerId).rpc(op, args));
    } catch (e) {
      if (e instanceof RpcCallError && e.status === 503) markOffline(workerId); // 数据面 503 → offline
      throw e;
    }
  };
  /** Machine is unreachable: mark offline and stop its machine.watch until /api/events reports it online again. */
  function markOffline(workerId: string) {
    stopMachineWatch(workerId);
    setConn(workerId, 'offline');
  }

  function waitOnline(workerId: string, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const ok = () => get().machines[workerId]?.online === true && get().machineConn[workerId] !== 'offline';
      if (ok() || signal.aborted) return resolve();
      const unsub = store.subscribe(() => { if (ok() || signal.aborted) finish(); });
      const finish = () => { unsub(); signal.removeEventListener('abort', finish); resolve(); };
      signal.addEventListener('abort', finish, { once: true });
    });
  }

  // ---------- machine.watch ----------
  function onMachineEvent(workerId: string, e: MachineEvent) {
    switch (e.type) {
      case 'snapshot':
        set((st) => ({
          workerInfo: { ...st.workerInfo, [workerId]: e.worker },
          sessions: { ...st.sessions, [workerId]: Object.fromEntries(e.sessions.map((s) => [s.id, s])) },
        }));
        break;
      case 'session.updated': upsertSession(workerId, e.session); break;
      case 'session.removed':
        set((st) => { const m = { ...st.sessions[workerId] }; delete m[e.sessionId]; return { sessions: { ...st.sessions, [workerId]: m } }; });
        break;
    }
  }
  function startMachineWatch(workerId: string) {
    const existing = machineWatch.get(workerId);
    if (existing && !existing.signal.aborted) return;
    const abort = new AbortController();
    const lifeSignal = life.signal;
    const onLifeAbort = () => abort.abort();
    lifeSignal.addEventListener('abort', onLifeAbort, { once: true });
    machineWatch.set(workerId, abort);
    setConn(workerId, 'connecting');
    const ctl = new StreamCtl(abort.signal);
    streams.add(ctl);
    void (async () => {
      let delay = BACKOFF_MIN;
      while (!abort.signal.aborted) {
        try {
          const attempt = ctl.begin();
          const r = await withAuthRetry(() => watchChecked(() => channel(workerId).watch('machine.watch', {} as WatchArgs<'machine.watch'>, (e) => {
            delay = BACKOFF_MIN;
            if (get().machineConn[workerId] !== 'online') setConn(workerId, 'online');
            onMachineEvent(workerId, e);
          }, attempt, streamOpts(ctl))));
          if (abort.signal.aborted) break;
          if (r.ended === 'offline') {
            // Race: /api/events may already report the machine back online (presence won't re-fire), so retry.
            if (get().machines[workerId]?.online !== true) { setConn(workerId, 'offline'); break; }
          }
          if (r.ended === 'end' && r.code === 'plaintext_disabled') await onPlaintextDisabled();
          else if (r.ended === 'end') break;
          if (abort.signal.aborted) break;
        } catch (e) {
          if (abort.signal.aborted) break;
          if (e instanceof RpcCallError && e.status === 503) { setConn(workerId, 'offline'); break; }
          if (!get().token) break;
          if (authStatus(e)) { setError(e); break; } // re-register + retry already failed → report, no more retries
        } finally { ctl.end(); }
        setConn(workerId, 'connecting');
        await ctl.backoff(jitter(delay));
        delay = Math.min(delay * 2, BACKOFF_MAX);
      }
      streams.delete(ctl);
      lifeSignal.removeEventListener('abort', onLifeAbort);
      if (machineWatch.get(workerId) === abort) machineWatch.delete(workerId);
    })();
  }
  function stopMachineWatch(workerId: string) {
    machineWatch.get(workerId)?.abort();
    machineWatch.delete(workerId);
  }
  function applyMachine(m: Machine) {
    set((st) => ({ machines: { ...st.machines, [m.workerId]: m } }));
    if (m.online) {
      if (get().machineConn[m.workerId] === 'offline') setConn(m.workerId, 'connecting');
      startMachineWatch(m.workerId);
    } else {
      stopMachineWatch(m.workerId);
      setConn(m.workerId, 'offline');
    }
  }
  function forgetMachine(workerId: string) {
    stopMachineWatch(workerId);
    set((st) => {
      const drop = <T,>(r: Record<string, T>) => { const n = { ...r }; delete n[workerId]; return n; };
      const sessionIndex = Object.fromEntries(Object.entries(st.sessionIndex).filter(([, s]) => s.workerId !== workerId));
      return { machines: drop(st.machines), machineConn: drop(st.machineConn), workerInfo: drop(st.workerInfo), sessions: drop(st.sessions), sessionIndex };
    });
  }

  // ---------- e2e mode switches ----------
  /** Abort + reopen every open machine/session watch so it uses the current channel mode (session cursors are
   *  kept in the timelines, so session watches resume where they were). */
  function restartWatches() {
    for (const workerId of [...machineWatch.keys()]) { stopMachineWatch(workerId); startMachineWatch(workerId); }
    for (const [key, w] of sessionWatch) {
      if (w.dead) continue;
      const i = key.indexOf('/');
      w.abort.abort();
      w.abort = new AbortController();
      startSessionWatch(key.slice(0, i), key.slice(i + 1), w.abort);
    }
  }
  /** True while loadCollab applies its snapshot + replay (it compares settings before/after itself). */
  let settingsHold = false;
  /** Settings were loaded from the SaaS this run (false while only a cache-hydrated copy is in the store). */
  let settingsLive = false;
  function applySettings(next: AccountSettings) {
    const prev = settingsLive ? get().settings : null;
    settingsLive = true;
    set({ settings: next });
    if (!settingsHold && prev && prev.e2e !== next.e2e) restartWatches();
  }

  // ---------- collab state (SaaS REST + /api/events) ----------
  type CollabEvent = Exclude<SaasEvent, { type: 'machines' | 'machine.updated' | 'machine.removed' }>;
  /** Non-null while a full load is in flight: collab events seen meanwhile, replayed over the snapshot. */
  let collabBuffer: CollabEvent[] | null = null;
  let collabGen = 0;
  const upsert = <K extends 'projects' | 'cards'>(k: K, id: string, v: EngineState[K][string]) =>
    set((st) => ({ [k]: { ...st[k], [id]: v } }) as Partial<EngineState>);
  function applyCollab(e: CollabEvent) {
    switch (e.type) {
      case 'project.updated': upsert('projects', e.project.id, e.project); break;
      case 'project.removed':
        set((st) => {
          const projects = { ...st.projects }; delete projects[e.projectId];
          // the project's cards go with it; its tag is cleared in the session index
          const cards = Object.fromEntries(Object.entries(st.cards).filter(([, c]) => c.projectId !== e.projectId));
          const sessionIndex = Object.fromEntries(Object.entries(st.sessionIndex).map(([k, s]) =>
            [k, s.projectId === e.projectId ? { ...s, projectId: null } : s]));
          return { projects, cards, sessionIndex };
        });
        break;
      case 'card.updated': upsert('cards', e.card.id, e.card); break;
      case 'card.removed': set((st) => { const cards = { ...st.cards }; delete cards[e.cardId]; return { cards }; }); break;
      case 'memory.updated':
        set((st) => ({ memories: { ...st.memories, [memoryKey(e.memory.scope, e.memory.projectId)]: e.memory } }));
        break;
      case 'settings.updated': applySettings(e.settings); break;
      case 'session.indexed':
        set((st) => {
          const next: Record<string, SessionIndexEntry> = {};
          for (const [k, s] of Object.entries(st.sessionIndex)) {
            if (s.workerId === e.workerId && (e.full || e.removed.includes(s.sessionId))) continue;
            next[k] = s;
          }
          for (const s of e.sessions) next[sessionKey(s.workerId, s.sessionId)] = s;
          return { sessionIndex: next };
        });
        break;
    }
  }
  function onCollabEvent(e: CollabEvent) {
    if (collabBuffer) collabBuffer.push(e);
    applyCollab(e);
  }
  /** Full REST load (first `machines` frame of every /api/events connection). Events that arrive while it is in
   *  flight are replayed over the snapshot in arrival order, so a stale snapshot cannot undo a live change. */
  async function loadCollab(signal: AbortSignal): Promise<void> {
    const gen = ++collabGen;
    const buffer: CollabEvent[] = [];
    collabBuffer = buffer;
    try {
      const [{ settings }, { projects }, { cards }, { sessions }, { memory }] = await Promise.all([
        saas.settings(), saas.projects(), saas.cards(), saas.sessionIndex({ limit: INDEX_LIMIT }), saas.memory('global', null),
      ]);
      if (signal.aborted || gen !== collabGen) return;
      const prev = settingsLive ? get().settings : null;
      settingsLive = true;
      settingsHold = true;
      try {
        set({
          settings,
          projects: Object.fromEntries(projects.map((p) => [p.id, p])),
          cards: Object.fromEntries(cards.map((c) => [c.id, c])),
          sessionIndex: Object.fromEntries(sessions.map((s) => [sessionKey(s.workerId, s.sessionId), s])),
          memories: { [memoryKey('global', null)]: memory }, // project memories are reloaded on demand
        });
        for (const e of buffer) applyCollab(e);
      } finally { settingsHold = false; }
      const now = get().settings;
      if (prev && now && prev.e2e !== now.e2e) restartWatches();
    } catch (e) {
      if (!signal.aborted && gen === collabGen) setError(e);
    } finally {
      if (collabBuffer === buffer) collabBuffer = null;
    }
  }

  function onSaasEvent(e: SaasEvent) {
    if (e.type === 'machines') {
      const keep = new Set(e.machines.map((m) => m.workerId));
      for (const id of Object.keys(get().machines)) if (!keep.has(id)) forgetMachine(id); // incl. cache-hydrated ones
      for (const m of e.machines) applyMachine(m);
      if (get().syncing) set({ syncing: false });
    } else if (e.type === 'machine.updated') applyMachine(e.machine);
    else if (e.type === 'machine.removed') forgetMachine(e.workerId);
    else onCollabEvent(e);
  }
  function startEvents() {
    const signal = life.signal;
    const ctl = new StreamCtl(signal);
    streams.add(ctl);
    void (async () => {
      let delay = BACKOFF_MIN;
      while (!signal.aborted) {
        let fresh = true; // the first `machines` frame of each (re)connected stream triggers a full collab load
        try {
          await saas.events((e) => {
            delay = BACKOFF_MIN;
            onSaasEvent(e);
            if (e.type === 'machines' && fresh) { fresh = false; void loadCollab(signal); }
          }, ctl.begin(), streamOpts(ctl));
        } catch (e) {
          if (e instanceof SaasError && e.status === 401) { streams.delete(ctl); await doLogout(false); return; }
        } finally { ctl.end(); }
        if (signal.aborted) break;
        await ctl.backoff(jitter(delay));
        delay = Math.min(delay * 2, BACKOFF_MAX);
      }
      streams.delete(ctl);
    })();
  }

  // ---------- session.watch ----------
  function startSessionWatch(workerId: string, sessionId: string, abort: AbortController) {
    const key = sessionKey(workerId, sessionId);
    const ctl = new StreamCtl(abort.signal);
    streams.add(ctl);
    void (async () => {
      let delay = BACKOFF_MIN;
      while (!abort.signal.aborted) {
        await waitOnline(workerId, abort.signal);
        if (abort.signal.aborted) break;
        try {
          const attempt = ctl.begin();
          const cursor = get().timelines[key]?.cursor;
          const r = await withAuthRetry(() => watchChecked(() => channel(workerId).watch('session.watch', cursor ? { sessionId, cursor } : { sessionId }, (e: SessionEvent) => {
            delay = BACKOFF_MIN;
            // First event over a cache-hydrated timeline: a snapshot means the cursor was not resumable (worker
            // restarted / too old) — drop the cached messages entirely instead of merging them in front of it.
            const stale = tlHydrated.delete(key) && e.type === 'snapshot';
            updateTimeline(key, (t) => applySessionEvent(stale ? { ...t, messages: t.messages.filter(isLocalMsg) } : t, e));
            if (e.type !== 'message.delta' && e.type !== 'tool.progress') noteTimeline(key);
            if (e.type === 'snapshot' || e.type === 'session.updated') upsertSession(workerId, e.session);
            if (e.type === 'prompt.opened') {
              const pk = `${key}/${e.prompt.id}`;
              if (!notifiedPrompts.has(pk)) {
                notifiedPrompts.add(pk);
                const title = get().sessions[workerId]?.[sessionId]?.title ?? get().timelines[key]?.session?.title ?? sessionId;
                notify({ kind: 'prompt', workerId, sessionId, title });
              }
            }
          }, attempt, streamOpts(ctl))));
          if (abort.signal.aborted) break;
          if (r.ended === 'end' && r.code === 'plaintext_disabled') {
            await onPlaintextDisabled();
            if (abort.signal.aborted) break;
          } else if (r.ended === 'end') break;
          if (r.ended === 'offline') { setConn(workerId, 'offline'); continue; }
        } catch (e) {
          if (abort.signal.aborted) break;
          if (e instanceof RpcCallError && e.status === 503) { setConn(workerId, 'offline'); continue; }
          if (!get().token) break;
          if (authStatus(e)) { setError(e); break; } // re-register + retry already failed → report, no more retries
        } finally { ctl.end(); }
        await ctl.backoff(jitter(delay));
        delay = Math.min(delay * 2, BACKOFF_MAX);
      }
      streams.delete(ctl);
      // loop exited (end / auth failure / closed): keep the refs but mark it dead so a later openSession
      // restarts the watch without resetting the count (other views' closeSession must not abort it).
      const w = sessionWatch.get(key);
      if (w?.abort === abort) w.dead = true;
    })();
  }

  // ---------- lifecycle ----------
  async function ensureClientKey(): Promise<KeyPair> {
    if (clientKey) return clientKey;
    clientKey = generateClientKey();
    await platform.secureStorage.set(K_CLIENT, b64url(clientKey.priv));
    return clientKey;
  }
  async function start(): Promise<void> {
    life.abort();
    life = new AbortController();
    const key = await ensureClientKey();
    set({ clientPub: key.pub });
    try {
      const { user, role, allowlistEnabled } = await saas.me();
      const prev = get().user;
      if (prev && prev.id !== user.id) await resetAccountState(); // cached / previous account ≠ this token's account
      set({ user, access: { role, allowlistEnabled } });
      cacheOn = true;
      await registerClient();
    } catch (e) {
      if (e instanceof SaasError && e.status === 401) { await doLogout(false); throw e; }
      setError(e);
    }
    if (get().token) startEvents();
  }
  function stopAll() {
    life.abort();
    for (const a of machineWatch.values()) a.abort();
    machineWatch.clear();
    for (const w of sessionWatch.values()) w.abort.abort();
    sessionWatch.clear();
    channels.clear();
  }
  async function doLogout(callServer: boolean) {
    cacheOn = false;
    cancelCacheWrite();
    if (callServer && get().token) { try { await saas.logout(); } catch { /* ignore */ } }
    stopAll();
    await clearCache();
    await clearTimelineCache();
    await platform.secureStorage.remove(K_TOKEN);
    if (draftTimer) { clearTimeout(draftTimer); draftTimer = null; }
    notifiedPrompts.clear();
    await platform.storage.remove(K_DRAFTS).catch(() => {});
    collabGen++;
    collabBuffer = null;
    settingsLive = false;
    set({ drafts: {}, token: null, user: null, access: null, machines: {}, machineConn: {}, workerInfo: {}, sessions: {}, timelines: {}, ...COLLAB_EMPTY, syncing: false });
  }
  /** The token belongs to a different account than the state on screen: drop that account's state + cache. */
  async function resetAccountState() {
    cacheOn = false;
    cancelCacheWrite();
    await clearCache();
    await clearTimelineCache();
    for (const id of Object.keys(get().machines)) stopMachineWatch(id);
    collabGen++;
    collabBuffer = null;
    settingsLive = false;
    set({ user: null, access: null, machines: {}, machineConn: {}, workerInfo: {}, sessions: {}, timelines: {}, ...COLLAB_EMPTY, syncing: false });
  }

  // ---------- snapshot cache (stale-while-revalidate) ----------
  /** Writes allowed: a verified (or cache-hydrated) user is on screen. Off during logout / account reset. */
  let cacheOn = false;
  let cacheTimer: ReturnType<typeof setTimeout> | null = null;
  let cacheDirtySince: number | null = null;
  let cachePtr: string | null = null;              // pointer value last written (skip rewriting it)
  let cacheSizeWarned = false;
  const cacheDelay = opts.cacheDelayMs ?? CACHE_DELAY;
  function cancelCacheWrite() {
    if (cacheTimer) clearTimeout(cacheTimer);
    cacheTimer = null;
    cacheDirtySince = null;
  }
  /** Debounced: `cacheDelay` after the last relevant change, but at most CACHE_MAX_WAIT behind the first one. */
  function scheduleCacheWrite() {
    const now = Date.now();
    cacheDirtySince ??= now;
    if (cacheTimer) clearTimeout(cacheTimer);
    const wait = Math.max(0, Math.min(cacheDelay, cacheDirtySince + Math.max(CACHE_MAX_WAIT, cacheDelay) - now));
    cacheTimer = setTimeout(writeCache, wait);
  }
  function writeCache() {
    cancelCacheWrite();
    const st = get();
    if (!cacheOn || !st.token || !st.user) return;
    const snap: CacheSnapshot = { version: CACHE_VERSION, saasUrl: st.saasUrl, ...Object.fromEntries(CACHED_SLICES.map((k) => [k, st[k]])) } as CacheSnapshot;
    const json = JSON.stringify(snap);
    if (json.length > CACHE_MAX_CHARS) {
      if (!cacheSizeWarned) { cacheSizeWarned = true; console.warn(`[nopear] snapshot cache skipped: ${json.length} chars > ${CACHE_MAX_CHARS}`); }
      return;
    }
    void platform.storage.set(cacheKey(st.saasUrl, st.user.id), json).catch(() => {});
    const ptr = JSON.stringify({ saasUrl: st.saasUrl, userId: st.user.id });
    if (ptr !== cachePtr) { cachePtr = ptr; void platform.storage.set(K_CACHE_PTR, ptr).catch(() => {}); }
  }
  async function clearCache() {
    cachePtr = null;
    const keys = new Set<string>();
    const st = get();
    if (st.user) keys.add(cacheKey(st.saasUrl, st.user.id));
    try {
      const p = JSON.parse((await platform.storage.get(K_CACHE_PTR)) ?? 'null') as unknown;
      if (isRecord(p) && typeof p.saasUrl === 'string' && typeof p.userId === 'string') keys.add(cacheKey(p.saasUrl, p.userId));
    } catch { /* corrupt pointer */ }
    await Promise.all([...keys, K_CACHE_PTR].map((k) => platform.storage.remove(k).catch(() => {})));
  }
  /** Load the cached snapshot for `url` into the store. Machines are shown as not online (conn `connecting`)
   *  until /api/events reports presence; every slice is replaced by live data as it arrives. */
  async function hydrateCache(url: string): Promise<boolean> {
    let ptr: unknown = null;
    try { ptr = JSON.parse((await platform.storage.get(K_CACHE_PTR)) ?? 'null'); } catch { /* corrupt */ }
    if (!isRecord(ptr) || ptr.saasUrl !== url || typeof ptr.userId !== 'string') return false;
    const key = cacheKey(url, ptr.userId);
    let snap: unknown = null;
    try {
      const raw = await platform.storage.get(key);
      if (raw === null) return false;
      snap = JSON.parse(raw);
    } catch { /* corrupt: discarded below */ }
    const ok = isRecord(snap) && snap.version === CACHE_VERSION && snap.saasUrl === url
      && isRecord(snap.user) && snap.user.id === ptr.userId
      && (['machines', 'workerInfo', 'sessions', 'projects', 'cards', 'sessionIndex'] as const).every((k) => isRecord(snap[k]));
    if (!ok) { await platform.storage.remove(key).catch(() => {}); return false; }
    const c = snap as unknown as CacheSnapshot;
    const machines = Object.fromEntries(Object.entries(c.machines).map(([id, m]) => [id, { ...m, online: false }]));
    const known = <T,>(r: Record<string, T>) => Object.fromEntries(Object.entries(r).filter(([id]) => id in machines));
    cachePtr = JSON.stringify({ saasUrl: url, userId: ptr.userId });
    set({
      user: c.user, access: c.access ?? null, settings: c.settings ?? null,
      machines, machineConn: Object.fromEntries(Object.keys(machines).map((id) => [id, 'connecting' as const])),
      workerInfo: known(c.workerInfo), sessions: known(c.sessions),
      projects: c.projects, cards: c.cards, sessionIndex: c.sessionIndex, syncing: true,
    });
    return true;
  }
  store.subscribe((st, prev) => {
    if (!cacheOn || !st.token || !st.user) return;
    if (CACHED_SLICES.some((k) => st[k] !== prev[k])) scheduleCacheWrite();
  });

  // ---------- timeline cache (platform.bigStorage) ----------
  // Only a timeline state with no live/streaming message is cached, together with the cursor of the event that
  // produced it, so a later watch from that cursor replays exactly what came after it. Deltas never write.
  const tlDelay = opts.timelineDelayMs ?? TL_DELAY;
  const tlMaxSessions = Math.max(1, opts.timelineMaxSessions ?? TL_MAX_SESSIONS);
  /** Bumped when the cache is cleared: queued work from before is dropped. */
  let tlGen = 0;
  /** Serializes bigStorage writes / index updates / clears. */
  let tlChain: Promise<void> = Promise.resolve();
  let tlIndex: { owner: string; keys: string[] } | null = null;
  /** Timelines rendered from the cache whose watch has not delivered an event yet. */
  const tlHydrated = new Set<string>();
  /** Last cached (or hydrated) state per session: cursor | hasMore | confirmed count. */
  const tlSaved = new Map<string, string>();
  const tlPending = new Map<string, { t: TimelineState; gen: number; timer: ReturnType<typeof setTimeout>; since: number }>();
  const tlOwner = (): string | null => { const st = get(); return st.token && st.user ? `${st.saasUrl}:${st.user.id}` : null; };
  const tlStorageKey = (owner: string, key: string) => `${TL_PREFIX}${owner}:${key}`;
  function tlQueue(fn: () => Promise<void>): Promise<void> {
    const p = tlChain.then(fn).catch(() => {});
    tlChain = p;
    return p;
  }
  async function tlLoadIndex(big: KV): Promise<{ owner: string; keys: string[] }> {
    if (tlIndex) return tlIndex;
    let v: unknown = null;
    try { v = JSON.parse((await big.get(K_TL_INDEX)) ?? 'null'); } catch { /* corrupt */ }
    tlIndex = isRecord(v) && typeof v.owner === 'string' && Array.isArray(v.keys)
      ? { owner: v.owner, keys: v.keys.filter((k): k is string => typeof k === 'string') }
      : { owner: '', keys: [] };
    return tlIndex;
  }
  /** Mark `sk` most recently used (`add`: insert it if missing), evicting beyond the limit; another owner's
   *  entries are dropped first. */
  async function tlTouch(big: KV, owner: string, sk: string, add: boolean): Promise<void> {
    const idx = await tlLoadIndex(big);
    const drop: string[] = [];
    if (idx.owner !== owner) { drop.push(...idx.keys); idx.owner = owner; idx.keys = []; }
    const had = idx.keys.includes(sk);
    if (!had && !add && drop.length === 0) return;
    if (had || add) { idx.keys = idx.keys.filter((k) => k !== sk); idx.keys.push(sk); }
    while (idx.keys.length > tlMaxSessions) drop.push(idx.keys.shift()!);
    await Promise.all(drop.map((k) => big.remove(k).catch(() => {})));
    await big.set(K_TL_INDEX, JSON.stringify(idx));
  }
  const tlSig = (t: TimelineState) => `${t.cursor}|${t.hasMore}|${t.messages.filter((m) => !isLocalMsg(m)).length}`;
  /** The timeline changed (cursor-bearing event / older page): remember it for a debounced write if cacheable. */
  function noteTimeline(key: string) {
    if (!platform.bigStorage || !tlOwner()) return;
    const t = get().timelines[key];
    if (!t?.cursor || t.messages.some((m) => !isLocalMsg(m) && isUnsettled(m))) return;
    if (tlSaved.get(key) === tlSig(t)) return;
    const now = Date.now();
    const prev = tlPending.get(key);
    if (prev) clearTimeout(prev.timer);
    const since = prev?.since ?? now;
    const wait = Math.max(0, Math.min(tlDelay, since + Math.max(TL_MAX_WAIT, tlDelay) - now));
    tlPending.set(key, { t, gen: tlGen, since, timer: setTimeout(() => writeTimeline(key), wait) });
  }
  function writeTimeline(key: string) {
    const p = tlPending.get(key);
    if (!p) return;
    clearTimeout(p.timer);
    tlPending.delete(key);
    const big = platform.bigStorage;
    const owner = tlOwner();
    if (!big || !owner || p.gen !== tlGen) return;
    const { t } = p;
    const confirmed = t.messages.filter((m) => !isLocalMsg(m));
    let messages = confirmed.slice(-TL_MAX_MESSAGES);
    const rec: TimelineRecord = { version: TL_VERSION, cursor: t.cursor!, messages, hasMore: t.hasMore, prompts: t.prompts, tasks: t.tasks, queue: t.queue, savedAt: new Date(platform.now?.() ?? Date.now()).toISOString() };
    if (t.session) rec.session = t.session;
    let json = JSON.stringify({ ...rec, hasMore: t.hasMore || messages.length < confirmed.length });
    while (json.length > TL_MAX_CHARS && messages.length > 1) {
      messages = messages.slice(Math.ceil(messages.length / 2));
      json = JSON.stringify({ ...rec, messages, hasMore: true });
    }
    if (json.length > TL_MAX_CHARS) return;
    tlSaved.set(key, tlSig(t));
    const sk = tlStorageKey(owner, key);
    const gen = p.gen;
    void tlQueue(async () => {
      if (gen !== tlGen) return;
      await big.set(sk, json);
      await tlTouch(big, owner, sk, true);
    });
  }
  function flushTimelines() { for (const key of [...tlPending.keys()]) writeTimeline(key); }
  /** Resolves once the account is known (`user` set), logged out, or `signal` aborts. The session watch waits for
   *  the machine to come online anyway, which needs `/api/me` first, so this does not delay it. */
  function waitUser(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const ok = () => get().user !== null || !get().token || signal.aborted;
      if (ok()) return resolve();
      const unsub = store.subscribe(() => { if (ok()) finish(); });
      const finish = () => { unsub(); signal.removeEventListener('abort', finish); resolve(); };
      signal.addEventListener('abort', finish, { once: true });
    });
  }
  /** Restore a session's cached timeline into the store (if the store has none yet). */
  async function hydrateTimeline(key: string): Promise<void> {
    const big = platform.bigStorage;
    const owner = tlOwner();
    if (!big || !owner) return;
    const gen = tlGen;
    const sk = tlStorageKey(owner, key);
    let rec: unknown = null;
    try {
      const raw = await big.get(sk);
      if (raw === null) return;
      rec = JSON.parse(raw);
    } catch { /* corrupt: discarded below */ }
    if (gen !== tlGen || tlOwner() !== owner) return;
    const ok = isRecord(rec) && rec.version === TL_VERSION && typeof rec.cursor === 'string' && Array.isArray(rec.messages)
      && typeof rec.hasMore === 'boolean' && (rec.session === undefined || isRecord(rec.session));
    if (!ok) { void tlQueue(async () => { if (gen === tlGen) await big.remove(sk); }); return; }
    void tlQueue(async () => { if (gen === tlGen) await tlTouch(big, owner, sk, false); });
    const r = rec as unknown as TimelineRecord;
    const cur = get().timelines[key];
    if (cur && (cur.cursor || cur.messages.some((m) => !isLocalMsg(m)))) return; // live data got here first
    const base = cur ?? emptyTimeline();
    const prompts = Array.isArray(r.prompts) ? r.prompts : [];
    for (const pr of prompts) notifiedPrompts.add(`${key}/${pr.id}`); // already seen before the restart
    const t: TimelineState = {
      ...base, cursor: r.cursor, hasMore: r.hasMore, prompts, tasks: Array.isArray(r.tasks) ? r.tasks : [], queue: Array.isArray(r.queue) ? r.queue : [],
      messages: [...r.messages, ...base.messages], // base holds only optimistic sends here
    };
    if (r.session) t.session = r.session;
    set((st) => ({ timelines: { ...st.timelines, [key]: t } }));
    tlHydrated.add(key);
    tlSaved.set(key, tlSig(t));
  }
  /** Drop every cached timeline (logout / account switch / SaaS URL change). */
  async function clearTimelineCache(): Promise<void> {
    tlGen++;
    for (const p of tlPending.values()) clearTimeout(p.timer);
    tlPending.clear();
    tlSaved.clear();
    tlHydrated.clear();
    const big = platform.bigStorage;
    if (!big) return;
    await tlQueue(async () => {
      const idx = await tlLoadIndex(big);
      await Promise.all([...idx.keys, K_TL_INDEX].map((k) => big.remove(k).catch(() => {})));
      tlIndex = { owner: '', keys: [] };
    });
  }
  /** Re-read `/api/me` after an allowlist change; 401 (removed yourself) → logout. */
  async function refreshAccess(): Promise<void> {
    try {
      const { user, role, allowlistEnabled } = await saas.me();
      set({ user, access: { role, allowlistEnabled } });
    } catch (e) {
      if (e instanceof SaasError && e.status === 401) await doLogout(false);
      else setError(e);
    }
  }
  function persistDrafts() {
    if (draftTimer) return;
    draftTimer = setTimeout(() => {
      draftTimer = null;
      void platform.storage.set(K_DRAFTS, JSON.stringify(get().drafts)).catch(() => {});
    }, 500);
  }

  async function sendWith(workerId: string, sessionId: string, clientMsgId: string, text: string, o: { attachments?: Attachment[]; delivery?: 'followUp' | 'steer' }) {
    const key = sessionKey(workerId, sessionId);
    const args: RpcArgs<'messages.send'> = { sessionId, text, clientMsgId };
    if (o.attachments) args.attachments = o.attachments;
    if (o.delivery) args.delivery = o.delivery;
    try {
      await rpc(workerId, 'messages.send', args);
      updateTimeline(key, (t) => markSent(t, clientMsgId));
    } catch (e) {
      updateTimeline(key, (t) => markSendFailed(t, clientMsgId, errMsg(e)));
    }
  }

  const engine: NoPearEngine = {
    store,
    async init() {
      const url = (await platform.storage.get(K_URL)) ?? opts.defaultSaasUrl;
      saas = new SaasClient({ baseUrl: url, platform, getToken: () => get().token });
      const token = await platform.secureStorage.get(K_TOKEN);
      let drafts: Record<string, string> = {};
      try { drafts = JSON.parse((await platform.storage.get(K_DRAFTS)) ?? '{}') as Record<string, string>; } catch { /* corrupt */ }
      const priv = await platform.secureStorage.get(K_CLIENT);
      if (priv) {
        try { const p = fromB64url(priv); clientKey = { priv: p, pub: publicKeyOf(p) }; } catch { clientKey = null; }
      }
      set({ saasUrl: url, token, drafts, clientPub: clientKey?.pub ?? null });
      if (!token) return;
      // Cached snapshot → render the sidebar now and revalidate in the background; otherwise wait as before.
      if (await hydrateCache(url)) { cacheOn = true; void start().catch(() => {}); }
      else await start().catch(() => {});
    },
    async setSaasUrl(url) {
      const u = url.trim().replace(/\/+$/, '');
      await doLogout(false);
      await platform.storage.set(K_URL, u);
      saas = new SaasClient({ baseUrl: u, platform, getToken: () => get().token });
      set({ saasUrl: u });
    },
    async loginDev(email) {
      const { token } = await saas.devLogin(email);
      await engine.completeLogin(token);
    },
    async completeLogin(token) {
      await platform.secureStorage.set(K_TOKEN, token);
      set({ token, error: null });
      await start();
    },
    logout: () => doLogout(true),
    openSession(workerId, sessionId) {
      const key = sessionKey(workerId, sessionId);
      const w = sessionWatch.get(key);
      if (w) {
        w.refs++;
        if (w.dead) { w.dead = false; w.abort = new AbortController(); startSessionWatch(workerId, sessionId, w.abort); }
        return;
      }
      const abort = new AbortController();
      sessionWatch.set(key, { refs: 1, abort, dead: false });
      if (!platform.bigStorage || !get().token || get().timelines[key]) { startSessionWatch(workerId, sessionId, abort); return; }
      // No timeline in memory: render the cached one first (once the account is known), then watch from its cursor.
      void waitUser(abort.signal).then(() => hydrateTimeline(key)).catch(() => {}).finally(() => {
        if (sessionWatch.get(key)?.abort === abort && !abort.signal.aborted) startSessionWatch(workerId, sessionId, abort);
      });
    },
    closeSession(workerId, sessionId) {
      const key = sessionKey(workerId, sessionId);
      const w = sessionWatch.get(key);
      if (!w) return;
      if (--w.refs <= 0) { w.abort.abort(); sessionWatch.delete(key); }
    },
    async loadEarlier(workerId, sessionId) {
      const key = sessionKey(workerId, sessionId);
      const first = get().timelines[key]?.messages.find((m) => !m.id.startsWith('local:') && !m.id.startsWith('live:'));
      const args: RpcArgs<'messages.page'> = { sessionId, limit: PAGE };
      if (first) args.before = first.id;
      const r = await rpc(workerId, 'messages.page', args);
      updateTimeline(key, (t) => prependPage(t, r.messages, r.hasMore));
      noteTimeline(key);
    },
    async createSession(workerId, args) {
      const { session } = await rpc(workerId, 'sessions.create', { ...args, clientMsgId: randomId() });
      upsertSession(workerId, session);
      return session;
    },
    async btw(workerId, sessionId, question) {
      const key = sessionKey(workerId, sessionId);
      const id = randomId();
      const ts = new Date(platform.now?.() ?? Date.now()).toISOString();
      updateTimeline(key, (t) => upsertBtw(t, { id, question, text: '', status: 'running', ts }));
      try {
        await rpc(workerId, 'messages.btw', { sessionId, id, text: question });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        updateTimeline(key, (t) => {
          const cur = (t.btw ?? []).find((b) => b.id === id);
          return cur && cur.status === 'running' && !cur.text ? upsertBtw(t, { ...cur, status: 'error', error }) : t;
        });
      }
    },
    dismissBtw(workerId, sessionId, id) { updateTimeline(sessionKey(workerId, sessionId), (t) => dismissBtw(t, id)); },
    async send(workerId, sessionId, text, o = {}) {
      const clientMsgId = randomId();
      const p: { clientMsgId: string; text: string; ts: string; attachments?: Attachment[] } = { clientMsgId, text, ts: new Date(platform.now?.() ?? Date.now()).toISOString() };
      if (o.attachments) p.attachments = o.attachments;
      updateTimeline(sessionKey(workerId, sessionId), (t) => addOptimistic(t, p));
      await sendWith(workerId, sessionId, clientMsgId, text, o);
    },
    async retrySend(workerId, sessionId, clientMsgId) {
      const key = sessionKey(workerId, sessionId);
      const p = get().timelines[key]?.pending[clientMsgId];
      if (!p) return;
      updateTimeline(key, (t) => markSending(t, clientMsgId));
      await sendWith(workerId, sessionId, clientMsgId, p.text, p.attachments ? { attachments: p.attachments } : {});
    },
    discardSend(workerId, sessionId, clientMsgId) {
      const key = sessionKey(workerId, sessionId);
      const text = get().timelines[key]?.pending[clientMsgId]?.text ?? '';
      updateTimeline(key, (t) => dropPending(t, clientMsgId));
      return text;
    },
    async removeQueued(workerId, sessionId, id) {
      await rpc(workerId, 'messages.queue.remove', { sessionId, id });
      updateTimeline(sessionKey(workerId, sessionId), (t) => dropQueued(t, id));
    },
    async updateQueued(workerId, sessionId, id, patch) {
      const args: RpcArgs<'messages.queue.update'> = { sessionId, id };
      if (patch.text !== undefined) args.text = patch.text;
      if (patch.delivery !== undefined) args.delivery = patch.delivery;
      await rpc(workerId, 'messages.queue.update', args);
    },
    async interrupt(workerId, sessionId) { await rpc(workerId, 'sessions.interrupt', { sessionId }); },
    async rewind(workerId, sessionId, messageId) {
      const { undoneText } = await rpc(workerId, 'sessions.rewind', { sessionId, messageId });
      return undoneText;
    },
    async fork(workerId, sessionId, messageId) {
      const { session } = await rpc(workerId, 'sessions.fork', messageId ? { sessionId, messageId } : { sessionId });
      upsertSession(workerId, session);
      return session;
    },
    async updateSession(workerId, sessionId, patch) {
      const { session } = await rpc(workerId, 'sessions.update', { ...patch, sessionId });
      upsertSession(workerId, session);
    },
    async answerPrompt(workerId, sessionId, promptId, answers, note) {
      await rpc(workerId, 'prompts.answer', note !== undefined ? { sessionId, promptId, answers, note } : { sessionId, promptId, answers });
      updateTimeline(sessionKey(workerId, sessionId), (t) => ({ ...t, prompts: t.prompts.filter((p) => p.id !== promptId) }));
    },
    async stopTask(workerId, sessionId, taskId) { await rpc(workerId, 'tasks.stop', { sessionId, taskId }); },
    taskTranscript(workerId, sessionId, ref) { return rpc(workerId, 'tasks.transcript', { sessionId, runId: ref.runId, step: ref.step }); },
    rpc,
    async claim(workerId, claimToken, label) {
      const { machine } = await saas.claim(workerId, claimToken, label);
      applyMachine(machine);
    },
    async renameMachine(workerId, label) {
      await saas.renameMachine(workerId, label);
      const m = get().machines[workerId];
      if (m) set((st) => ({ machines: { ...st.machines, [workerId]: { ...m, label } } }));
    },
    async removeMachine(workerId) {
      await saas.removeMachine(workerId);
      forgetMachine(workerId);
    },
    setDraft(workerId, sessionId, text) {
      const key = sessionKey(workerId, sessionId);
      set((st) => {
        const drafts = { ...st.drafts };
        if (text) drafts[key] = text; else delete drafts[key];
        return { drafts };
      });
      persistDrafts();
    },
    async createProject(input) {
      const { project } = await saas.createProject(input);
      upsert('projects', project.id, project);
      return project;
    },
    async updateProject(id, patch) {
      const { project } = await saas.updateProject(id, patch);
      upsert('projects', project.id, project);
      return project;
    },
    async deleteProject(id) {
      await saas.deleteProject(id);
      applyCollab({ type: 'project.removed', projectId: id });
    },
    async createCard(input) {
      const { card } = await saas.createCard(input);
      upsert('cards', card.id, card);
      return card;
    },
    async updateCard(id, patch) {
      const { card } = await saas.updateCard(id, patch);
      upsert('cards', card.id, card);
      return card;
    },
    async deleteCard(id) {
      await saas.deleteCard(id);
      applyCollab({ type: 'card.removed', cardId: id });
    },
    async loadMemory(scope, projectId) {
      const { memory } = await saas.memory(scope, projectId);
      onCollabEvent({ type: 'memory.updated', memory }); // buffered so a mid-load snapshot cannot wipe it
      return memory;
    },
    async saveMemory(scope, projectId, content) {
      const { memory } = await saas.putMemory(scope, projectId, content);
      onCollabEvent({ type: 'memory.updated', memory });
      return memory;
    },
    async setE2e(on) {
      const { settings } = await saas.patchSettings({ e2e: on });
      applySettings(settings);
    },
    async setAutoCompact(patch) {
      const { settings } = await saas.patchSettings({ autoCompact: patch });
      applySettings(settings);
      return settings;
    },
    async createApiToken(label) { return (await saas.createApiToken(label)).token; },
    async listApiTokens() { return (await saas.apiTokens()).tokens; },
    async deleteApiToken(id) { await saas.deleteApiToken(id); },
    createInstallCode(label) { return saas.createInstallCode(label); },
    async listAllowlist() { return (await saas.allowlist()).entries; },
    async putAllowlist(email, role) {
      const { entry } = await saas.putAllowlist(email, role);
      await refreshAccess();
      return entry;
    },
    async deleteAllowlist(email) {
      await saas.deleteAllowlist(email);
      await refreshAccess();
    },
    admin: {
      overview: () => saas.adminOverview(),
      users: async () => (await saas.adminUsers()).users,
      setDisabled: async (userId, disabled) => { await saas.adminSetDisabled(userId, disabled); },
      requests: async () => (await saas.adminRequests()).requests,
      approve: async (email, role) => { await saas.adminApproveRequest(email, role); },
      reject: (email) => saas.adminRejectRequest(email),
      deleteRequest: (email) => saas.adminDeleteRequest(email),
      machines: async () => (await saas.adminMachines()).machines,
      removeMachine: async (workerId) => ({ deleted: (await saas.adminRemoveMachine(workerId)).deleted }),
    },
    onNotice(l) { listeners.add(l); return () => { listeners.delete(l); }; },
    flushCache() { if (cacheTimer) writeCache(); flushTimelines(); },
    resume() {
      if (!get().token) return;
      for (const ctl of [...streams]) ctl.resume();
      // session watches whose loop exited while views still hold them (ended / failed while hidden)
      for (const [key, w] of sessionWatch) {
        if (!w.dead || w.refs <= 0) continue;
        const i = key.indexOf('/');
        w.dead = false;
        w.abort = new AbortController();
        startSessionWatch(key.slice(0, i), key.slice(i + 1), w.abort);
      }
    },
    dispose() {
      if (cacheTimer) writeCache();
      flushTimelines();
      cacheOn = false;
      stopAll();
      if (draftTimer) {
        clearTimeout(draftTimer);
        draftTimer = null;
        void platform.storage.set(K_DRAFTS, JSON.stringify(get().drafts)).catch(() => {});
      }
      listeners.clear();
    },
  };
  return engine;
}
