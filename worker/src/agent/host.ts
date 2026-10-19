// SessionHost — one pi AgentSession per nopear session. Owns the per-session sync log,
// maps pi events to protocol SessionEvents, and serializes every publish through a per-session chain
// so cursors, replays and snapshots stay consistent.
import { existsSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { ensurePrivateDir } from '../fsutil';
import { ensureAgentDirCredentials } from './agent-dir';
import { delimiter, join, resolve as resolvePath, sep } from 'node:path';
import { createRequire } from 'node:module';
import {
  createAgentSession, createEventBus, DefaultResourceLoader, SessionManager,
  type AgentSession, type EventBusController, type ExtensionUIContext, type InlineExtension, type ModelRuntime, type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { Api, ImageContent, Model } from '@earendil-works/pi-ai';
import {
  PAGE_DEFAULT, PAGE_MAX, SNAPSHOT_PAGE, TOOL_PROGRESS_MAX_CHARS,
  DEFAULT_AUTO_COMPACT, normalizeAutoCompact,
  type AutoCompactSettings, type Block, type Message, type Prompt, type QueueDelivery, type QueueItem, type RpcArgs, type RpcResult, type Session, type SessionEvent,
  type SessionKind, type WorkerInfo,
} from '@nopear/protocol';
import type { WorkerConfig } from '../config';
import { OpError } from '../errors';
import { createAskTool } from './ask';
import { prepareAttachments } from './attachments';
import type { BlobStore } from './blobs';
import { assistantBlocks, entryToMessage, previewOf } from './mapping';
import type { MetaStore, SessionMeta } from './meta-store';
import { listModels, modelKey, resolveModel } from './models';
import { appendOnce, IN_PROCESS_FLAG, installPersonaExtension, rewriteSystemPrompt } from './persona';
import { compactionOverrides } from './compaction';
import { normalizeImageBlocks } from './image-normalize';
import { SESSION_RENAME_TOOL, AUTO_TITLE_SYSTEM, autoTitlePrompt, canRetitle, cleanTitle, createSessionRenameTool, wantsAutoTitle, type TitleSource } from './titles';
import { newEpoch, SyncLog, type Uncursored } from './synclog';
import { readRunStatus, subagentRunsDir, TaskTracker, taskState } from './tasks';

/** Auto title: output budget (room for a reasoning model's thinking) and attempts per loaded session. */
export const AUTO_TITLE_MAX_TOKENS = 1024;
export const AUTO_TITLE_TRIES = 3;
/** Background only, so be patient: a slow provider took over a minute for these few tokens. */
export const AUTO_TITLE_TIMEOUT_MS = 120_000;
/** tasks.transcript: newest messages returned by default / at most. */
const TRANSCRIPT_PAGE = 200;
const TRANSCRIPT_MAX = 1000;

export interface HostDeps {
  config: WorkerConfig; meta: MetaStore; blobs: BlobStore; models: ModelRuntime; workerId: string;
  extraTools?: (meta: SessionMeta) => ToolDefinition[]; systemPromptAppend?: (meta: SessionMeta) => string | undefined;
  /** pi tool allowlist for a session (createAgentSession `tools`); undefined = pi default tools. */
  toolsFor?: (meta: SessionMeta) => string[] | undefined;
  /** pi-subagents' async run state dir (tests); default = where pi-subagents puts it. */
  subagentRunsDir?: string;
  /** Additional inline pi extensions loaded into every session (tests / embedders). */
  extraExtensions?: InlineExtension[];
  /** D6 auto-tag: cwd → projectId; consulted by create() only when neither opts.projectId nor args.projectId is set. */
  autoProject?: (cwd: string) => string | undefined;
  /** Awaited (errors swallowed) whenever a session gets a project tag (create/update/auto/card), before the first prompt. */
  onTagged?: (projectId: string) => Promise<void>;
  /** Cap on onTagged (ms); default TAGGED_TIMEOUT_MS. */
  taggedTimeoutMs?: number;
}
type Entry = { type: string; id: string; message?: { role?: string; content?: unknown; usage?: { cost?: { total?: number } } } };

interface PendingAsk { prompt: Prompt; answer(v: { answers: Record<string, string>; note?: string }): void; cancel(): void }

/** A send pi queued (steer / followUp), mirrored so clients can see, cancel and edit it. */
interface QueueEntry {
  id: string;            // clientMsgId
  text: string;          // as sent by the client
  note: string;          // attachment annotations prepareAttachments appended to `text`
  piText: string;        // the text exactly as it sits in pi's queue (what the persisted user message will hold)
  images: ImageContent[];
  delivery: QueueDelivery;
  attachments: number;
  createdAt: string;
}

interface Live {
  meta: SessionMeta;
  sm: SessionManager;
  session: AgentSession;
  bus: EventBusController;
  tracker: TaskTracker;
  watchers: Set<(e: SessionEvent) => void>;
  asks: Map<string, PendingAsk>;
  /** inPreflight: pi has not yet accepted/rejected the prompt (it may still start a run of its own).
   *  abandoned: still in preflight when the run was explicitly finished (interrupt); it neither blocks settling
   *  nor matches any persisted user message until pi actually accepts it (preflightResult(true) clears both).
   *  queued: pi queued it as steer/followUp; text was then replaced by pi's final (transformed) queued text. */
  pendingSends: Array<{ clientMsgId: string; text: string; inPreflight: boolean; abandoned?: boolean; queued?: boolean }>;
  /** Mirror of pi's steer/followUp queues (insertion order; published steer-first). */
  queue: QueueEntry[];
  /** True while a queue edit rebuilds pi's queue (its queue_update events are not mirrored meanwhile). */
  queueRebuilding: boolean;
  /** In-flight assistant message as mutated by pi events (may be ahead of the publish chain). */
  liveMsg: Message | null;
  /** The in-flight message exactly as published so far (updated inside chain producers) — snapshots read this. */
  pubMsg: Message | null;
  log: SyncLog;
  /** Serializes messages.send per session: each send waits for the previous one's preflight. */
  sendChain: Promise<void>;
  /** Mapped messages by entry id (entries are immutable); clientMsgId is attached at read time. */
  cache: Map<string, Message | null>;
  /** Watch terminators (delete() ends them with not_found). */
  enders: Set<(err: Error) => void>;
  disposed: boolean;
  lastUse: number;
  liveSeq: number;
  running: boolean;
  /** Error text of the last run when it ended with stopReason 'error'; undefined otherwise. */
  lastError: string | undefined;
  /** An automatic title was already attempted for this Live (success or failure): never retried in a loop. */
  /** Auto-title attempts so far in this Live (a failed one is retried after a later run, up to AUTO_TITLE_TRIES). */
  titleTries?: number;
  titleBusy?: boolean;
  chain: Promise<void>;
  idleWaiters: Array<() => void>;
  progressAt: Map<string, number>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  unsub: () => void;
}

const DISPOSED = Symbol('disposed');
/** Default cap on the onTagged hook (project-memory prefetch) so it never holds a session op near the RPC timeout. */
const TAGGED_TIMEOUT_MS = 5000;
const nowIso = () => new Date().toISOString();
const userText = (content: unknown): string =>
  typeof content === 'string' ? content
    : Array.isArray(content) ? (content as Array<{ type: string; text?: string }>).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('') : '';

const PI_SUBAGENTS_ENTRY = (() => {
  try { return createRequire(import.meta.url).resolve('pi-subagents'); } catch { return undefined; }
})();

/** List preview of a branch: the last non-tool message with text (same rule as the live upsert path). */
function previewOfBranch(msgs: Message[]): string {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.role === 'tool') continue;
    const p = previewOf(m);
    if (p) return p;
  }
  return '';
}

/**
 * A headless UI context that pi does not recognise as its no-op one (so extensions see `ctx.hasUI === true`), with the
 * same no-op behaviour: dialogs resolve empty (select/input → undefined, confirm → false), widgets/status are dropped,
 * notifications go to the worker log. Built by copying the runner's current (no-op) context's property descriptors so
 * the `theme` getter is preserved.
 */
export function headlessUiContext(base: ExtensionUIContext): ExtensionUIContext {
  const ui = Object.defineProperties({}, Object.getOwnPropertyDescriptors(base)) as ExtensionUIContext;
  ui.select = async () => undefined;
  ui.confirm = async () => false;
  ui.input = async () => undefined;
  ui.notify = (message, type) => { console.log(`[nopear] extension notify${type ? ` (${type})` : ''}: ${message}`); };
  return ui;
}

export class SessionHost {
  private readonly live = new Map<string, Live>();
  private readonly loading = new Map<string, Promise<Live>>();
  private readonly clientMsgIds = new Map<string, Map<string, string>>();
  private readonly listeners = new Set<(s: Session, removed?: boolean) => void>();
  private closed = false;

  /**
   * Account-level context auto-compaction, refreshed by every `authz` push. `null` = nothing from the
   * SaaS yet, which means an unclaimed worker: the protocol defaults apply.
   */
  private autoCompact: AutoCompactSettings | null = null;

  constructor(private readonly deps: HostDeps) {}

  /** Apply the account's auto-compaction settings to live sessions (existing ones pick it up without a restart). */
  setAutoCompact(v: AutoCompactSettings | undefined): void {
    this.autoCompact = v ? normalizeAutoCompact(v) : null;
    const ac = this.autoCompact ?? DEFAULT_AUTO_COMPACT;
    for (const live of this.live.values()) {
      try { live.session.settingsManager.applyOverrides(compactionOverrides(ac, SessionHost.contextWindowOf(live.session))); } catch { /* session gone */ }
    }
  }

  /** Window of the model a session is actually using (pi compaction settings are per session, not per account). */
  private static contextWindowOf(session: AgentSession): number {
    const w = (session.model as { contextWindow?: number } | undefined)?.contextWindow;
    return typeof w === 'number' ? w : 0;
  }

  private get cfg(): WorkerConfig { return this.deps.config; }

  async init(): Promise<void> {
    process.env.PI_CODING_AGENT_DIR = this.cfg.agentDir;
    // The worker is always a top-level pi host. If it was launched from inside a pi subagent, inherited
    // PI_SUBAGENT_* markers would make pi-subagents treat every nopear session as a child and stay inert.
    for (const k of Object.keys(process.env)) if (k.startsWith('PI_SUBAGENT_')) delete process.env[k];
    for (const d of [this.cfg.home, this.cfg.agentDir, this.cfg.sessionsDir, this.cfg.blobsDir]) ensurePrivateDir(d);
    ensureAgentDirCredentials(this.cfg);
    // Our own sessions are rewritten below (build); the extension is for the separate `pi` processes subagents run in.
    (globalThis as Record<string, unknown>)[IN_PROCESS_FLAG] = true;
    installPersonaExtension(this.cfg.agentDir, this.cfg.persona);
    const onPath = (process.env.PATH ?? '').split(delimiter).some((d) => d && existsSync(join(d, 'pi')));
    if (!onPath) console.warn('[nopear] `pi` CLI not found on PATH — background subagent tasks will be unavailable');
    if (!PI_SUBAGENTS_ENTRY) console.warn('[nopear] pi-subagents not resolvable — background tasks disabled');
  }

  // ---------------- queries ----------------

  list(args: RpcArgs<'sessions.list'>): Session[] {
    const kinds = new Set<SessionKind>(args.kinds ?? ['chat']);
    return this.deps.meta.list()
      .filter((m) => kinds.has(m.kind) && (args.archived === undefined || m.archived === args.archived))
      .map((m) => this.toSession(m))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastActivityAt.localeCompare(a.lastActivityAt));
  }

  get(id: string): Session {
    return this.toSession(this.metaOf(id));
  }

  async page(args: RpcArgs<'messages.page'>): Promise<RpcResult<'messages.page'>> {
    const live = await this.ensureLive(args.sessionId);
    const all = await this.branchMessages(live);
    const limit = Math.min(Math.max(1, args.limit ?? PAGE_DEFAULT), PAGE_MAX);
    let end = all.length;
    if (args.before) {
      const i = all.findIndex((m) => m.id === args.before);
      if (i < 0) throw new OpError('not_found', `message ${args.before} not on the active path`);
      end = i;
    }
    const start = Math.max(0, end - limit);
    return { messages: all.slice(start, end), hasMore: start > 0 };
  }

  async workerInfo(): Promise<WorkerInfo> {
    // Report the model a new session would actually get (NOPEAR_DEFAULT_MODEL, else the first available one).
    let defaultModel = this.cfg.defaultModel;
    try { defaultModel = modelKey(this.pickModel(undefined)); } catch { /* no model configured: keep the raw setting */ }
    return { workerId: this.deps.workerId, label: this.cfg.label, version: this.cfg.version, defaultCwd: this.cfg.defaultCwd,
      defaultModel, defaultThinking: this.cfg.defaultThinking, models: await listModels(this.deps.models) };
  }

  /** Error text of the session's last run if it failed (undefined when it succeeded or the session is not live). */
  lastError(id: string): string | undefined {
    return this.live.get(id)?.lastError;
  }

  /** Active pi tool names for a session (loads it if needed). */
  async activeTools(id: string): Promise<string[]> {
    return (await this.ensureLive(id)).session.getActiveToolNames();
  }

  private toolsAllowlist(meta: SessionMeta, askName: string): { tools?: string[] } {
    const list = this.deps.toolsFor?.(meta);
    return list ? { tools: [...new Set([...list, askName, SESSION_RENAME_TOOL])] } : {};
  }

  async costUsd(id: string): Promise<number> {
    const live = await this.ensureLive(id);
    let total = 0;
    for (const e of live.sm.getEntries() as Entry[]) {
      if (e.type === 'message' && e.message?.role === 'assistant') total += e.message.usage?.cost?.total ?? 0;
    }
    return total;
  }

  onSessionChange(listener: (s: Session, removed?: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  // ---------------- lifecycle commands ----------------

  async create(args: RpcArgs<'sessions.create'>, opts: { projectId?: string; cwd?: string; title?: string; autoStart?: boolean } = {}): Promise<Session> {
    const argTag: unknown = args.projectId;
    if (argTag !== undefined && (typeof argTag !== 'string' || !argTag)) throw new OpError('bad_request', 'projectId must be a non-empty string');
    const model = this.pickModel(args.model);
    const cwd = opts.cwd ?? args.cwd ?? this.cfg.defaultCwd;
    mkdirSync(cwd, { recursive: true });
    const sm = SessionManager.create(cwd, this.cfg.sessionsDir);
    const now = nowIso();
    const text = args.text ?? '';
    const meta: SessionMeta = {
      id: sm.getSessionId(), kind: 'chat', title: opts.title ?? args.title ?? (text.trim().slice(0, 40) || '新会话'),
      cwd, sessionFile: sm.getSessionFile() ?? '', createdAt: now, lastActivityAt: now, preview: '',
      pinned: false, starred: false, archived: false, model: modelKey(model), thinking: args.thinking ?? this.cfg.defaultThinking,
      titleSource: opts.title !== undefined || args.title !== undefined ? 'user' : 'prompt',
    };
    const projectId = opts.projectId ?? args.projectId ?? this.deps.autoProject?.(cwd);
    if (projectId) meta.projectId = projectId;
    await this.deps.meta.put(meta);
    await this.load(meta, sm);
    this.notify(meta.id);
    if (projectId) await this.tagged(projectId);
    if (opts.autoStart !== false && (text.trim() || args.attachments?.length)) {
      await this.send({ sessionId: meta.id, text, clientMsgId: args.clientMsgId, attachments: args.attachments });
    }
    return this.get(meta.id);
  }

  async update(args: RpcArgs<'sessions.update'>): Promise<Session> {
    const cur = this.metaOf(args.sessionId);
    const patch: Partial<SessionMeta> = {};
    let model: Model<Api> | undefined;
    if (args.model !== undefined) {
      model = resolveModel(this.deps.models, args.model);
      if (!model) throw new OpError('bad_request', `unknown model ${args.model}`);
      patch.model = args.model;
    }
    for (const k of ['title', 'pinned', 'starred', 'archived', 'thinking'] as const) {
      if (args[k] !== undefined) (patch as Record<string, unknown>)[k] = args[k];
    }
    if (args.title !== undefined) patch.titleSource = 'user';
    const tag = args.projectId;
    if (tag !== undefined && tag !== null && (typeof tag !== 'string' || !tag)) throw new OpError('bad_request', 'projectId must be a non-empty string or null');
    if (tag) patch.projectId = tag;
    await this.deps.meta.patch(cur.id, patch, tag === null ? ['projectId'] : []);
    if (tag) await this.tagged(tag);
    const live = this.live.get(cur.id);
    if (live) {
      live.meta = this.metaOf(cur.id);
      if (model) await live.session.setModel(model);
      if (args.thinking) live.session.setThinkingLevel(args.thinking);
    }
    this.sessionChanged(cur.id);
    return this.get(cur.id);
  }

  async delete(id: string): Promise<void> {
    const s = this.get(id);
    const live = this.live.get(id);
    if (live) {
      for (const end of [...live.enders]) end(new OpError('not_found', `session ${id} was deleted`));
      void this.disposeLive(live);
    }
    await this.deps.meta.delete(id);
    this.clientMsgIds.delete(id);
    for (const l of this.listeners) l(s, true);
  }

  async send(args: RpcArgs<'messages.send'>): Promise<RpcResult<'messages.send'>> {
    const live = await this.ensureLive(args.sessionId);
    // Serialize per session: a send only starts once the previous one has passed pi's preflight, so the
    // second of two concurrent sends sees isStreaming=true and is queued as a followUp/steer.
    const r = await this.sendLocked(live, () => this.sendNow(live, args));
    return r === DISPOSED ? this.send(args) : r;
  }

  /** Run `fn` in the per-session send chain (sends and queue edits never interleave with a send's preflight). */
  private async sendLocked<T>(live: Live, fn: () => Promise<T>): Promise<T | typeof DISPOSED> {
    const prev = live.sendChain;
    let release!: () => void;
    live.sendChain = new Promise<void>((r) => { release = r; });
    try {
      await prev;
      if (live.disposed) return DISPOSED;
      return await fn();
    } finally {
      release();
    }
  }

  /** messages.queue.remove: cancel a queued send. */
  async queueRemove(args: RpcArgs<'messages.queue.remove'>): Promise<void> {
    const live = this.live.get(args.sessionId);
    if (!live) { this.metaOf(args.sessionId); throw new OpError('not_found', `message ${args.id} is not queued`); }
    const r = await this.sendLocked(live, async () => {
      const entry = live.queue.find((q) => q.id === args.id);
      if (!entry) throw new OpError('not_found', `message ${args.id} is not queued`);
      live.queue = live.queue.filter((q) => q !== entry);
      live.pendingSends = live.pendingSends.filter((p) => p.clientMsgId !== entry.id);
      await this.rebuildQueue(live);
    });
    if (r === DISPOSED) throw new OpError('not_found', `message ${args.id} is not queued`);
  }

  /** messages.queue.update: edit a queued send's text and/or switch its delivery. */
  async queueUpdate(args: RpcArgs<'messages.queue.update'>): Promise<void> {
    if (args.text !== undefined && typeof args.text !== 'string') throw new OpError('bad_request', 'text must be a string');
    if (args.delivery !== undefined && args.delivery !== 'steer' && args.delivery !== 'followUp') throw new OpError('bad_request', 'delivery must be steer|followUp');
    const live = this.live.get(args.sessionId);
    if (!live) { this.metaOf(args.sessionId); throw new OpError('not_found', `message ${args.id} is not queued`); }
    const r = await this.sendLocked(live, async () => {
      const entry = live.queue.find((q) => q.id === args.id);
      if (!entry) throw new OpError('not_found', `message ${args.id} is not queued`);
      const textChanged = args.text !== undefined && args.text !== entry.text;
      const moved = args.delivery !== undefined && args.delivery !== entry.delivery;
      if (!textChanged && !moved) return;
      if (textChanged) {
        const text = args.text!;
        const paths = entry.note.replace(/^\n\n/, '');
        const piText = paths ? `${text}${text ? '\n\n' : ''}${paths}` : text;
        if (!piText.trim() && entry.images.length === 0) throw new OpError('bad_request', 'empty message');
        entry.text = text;
        entry.note = piText.slice(text.length);
        entry.piText = piText;
      }
      if (moved) {
        entry.delivery = args.delivery!;
        live.queue = [...live.queue.filter((q) => q !== entry), entry]; // to the end of its new queue
      }
      await this.rebuildQueue(live);
    });
    if (r === DISPOSED) throw new OpError('not_found', `message ${args.id} is not queued`);
  }

  /** pi has no per-item removal: clear its queues and re-add the mirrored entries in order (with their images).
   *  Entries keep their clientMsgId; their pending sends are re-pointed at pi's resulting queued text. */
  private async rebuildQueue(live: Live): Promise<void> {
    const order = [...live.queue.filter((q) => q.delivery === 'steer'), ...live.queue.filter((q) => q.delivery === 'followUp')];
    live.queueRebuilding = true;
    let results: Array<Error | null>;
    try {
      live.session.clearQueue();
      // No await between clearQueue and the re-adds: pi pushes synchronously inside steer()/followUp(), so the
      // agent loop cannot drain a half-rebuilt queue.
      const calls = order.map((q) => {
        const imgs = q.images.length ? q.images : undefined;
        const p = q.delivery === 'steer' ? live.session.steer(q.piText, imgs) : live.session.followUp(q.piText, imgs);
        return p.then(() => null, (err: unknown) => (err instanceof Error ? err : new Error(String(err))));
      });
      results = await Promise.all(calls);
    } finally {
      live.queueRebuilding = false;
    }
    const failed = new Set(order.filter((_, i) => results[i]).map((q) => q.id));
    for (const [i, q] of order.entries()) if (results[i]) console.warn(`[nopear] re-queue failed (${live.meta.id}/${q.id}): ${results[i]!.message}`);
    if (failed.size) {
      live.queue = live.queue.filter((q) => !failed.has(q.id));
      live.pendingSends = live.pendingSends.filter((p) => !failed.has(p.clientMsgId));
    }
    for (const d of ['steer', 'followUp'] as const) {
      const pi = d === 'steer' ? live.session.getSteeringMessages() : live.session.getFollowUpMessages();
      live.queue.filter((q) => q.delivery === d).forEach((q, i) => { if (pi[i] !== undefined) q.piText = pi[i]!; });
    }
    for (const q of live.queue) {
      const p = live.pendingSends.find((x) => x.clientMsgId === q.id);
      if (p) { p.text = q.piText; p.queued = true; }
      else live.pendingSends.push({ clientMsgId: q.id, text: q.piText, inPreflight: false, queued: true });
    }
    this.syncQueue(live);
    this.queueChanged(live);
  }

  /** Drop mirrored entries pi no longer holds (delivered: pi removes the first matching text at message_start).
   *  Returns true when something was dropped. */
  private syncQueue(live: Live): boolean {
    if (live.queueRebuilding) return false;
    const drop = new Set<QueueEntry>();
    for (const d of ['steer', 'followUp'] as const) {
      const left = new Map<string, number>();
      for (const t of d === 'steer' ? live.session.getSteeringMessages() : live.session.getFollowUpMessages()) left.set(t, (left.get(t) ?? 0) + 1);
      // Of several entries with the same text, pi delivered the earliest ones: keep the latest `left` of them.
      const mine = live.queue.filter((q) => q.delivery === d);
      for (let i = mine.length - 1; i >= 0; i--) {
        const q = mine[i]!;
        const n = left.get(q.piText) ?? 0;
        if (n > 0) left.set(q.piText, n - 1); else drop.add(q);
      }
    }
    if (drop.size === 0) return false;
    live.queue = live.queue.filter((q) => !drop.has(q));
    return true;
  }

  private queueItems(live: Live): QueueItem[] {
    const item = (q: QueueEntry): QueueItem => ({ id: q.id, text: q.text, delivery: q.delivery, attachments: q.attachments, createdAt: q.createdAt });
    return [...live.queue.filter((q) => q.delivery === 'steer'), ...live.queue.filter((q) => q.delivery === 'followUp')].map(item);
  }

  /** Publish the queue (read when the event is produced, so it never regresses behind a snapshot). */
  private queueChanged(live: Live): void {
    this.enqueue(live, async () => ({ type: 'queue', items: this.queueItems(live) }), 'queue');
  }

  private async sendNow(live: Live, args: RpcArgs<'messages.send'>): Promise<RpcResult<'messages.send'>> {
    const cid = args.clientMsgId;
    const busy = () => live.session.isStreaming || live.running;
    // Idempotent retries: an already-pending or already-persisted clientMsgId is not prompted again.
    if (live.pendingSends.some((p) => p.clientMsgId === cid) || [...this.idsOf(live.meta.id).values()].includes(cid)) {
      return { queued: busy() };
    }
    const rawText = args.text ?? '';
    const { text, images } = await prepareAttachments(live.meta.cwd, rawText, args.attachments);
    if (!text.trim() && images.length === 0) throw new OpError('bad_request', 'empty message');
    const queued = busy();
    // No await between registering the pending send and calling prompt (events cannot interleave).
    const pending: Live['pendingSends'][number] = { clientMsgId: cid, text, inPreflight: true };
    const delivery = args.delivery ?? 'followUp';
    live.pendingSends.push(pending);
    if (!queued) live.running = true;
    let accepted!: (ok: boolean) => void;
    const preflight = new Promise<boolean>((r) => { accepted = r; });
    // Queue state before prompt(): only a queue that grew (or got a new tail) was pushed by this send — an input
    // handled mid-run (or an extension command) also reports preflightResult(true) but queues nothing.
    const queueOf = () => (delivery === 'steer' ? live.session.getSteeringMessages() : live.session.getFollowUpMessages());
    const qBefore = [...queueOf()]; // copy: pi returns its live (mutated) queue array
    const countIn = (q: readonly string[], t: string) => q.reduce((n, x) => n + (x === t ? 1 : 0), 0);
    const run = live.session.prompt(text, {
      images: images.length ? images : undefined,
      // Always set: pi only consults it while streaming; omitting it races with a run that starts concurrently.
      streamingBehavior: delivery,
      preflightResult: (ok) => {
        pending.inPreflight = false;
        pending.abandoned = false;
        // pi (agent-session.js prompt()) pushes the post-input-transform/post-template text onto its steer or
        // followUp queue (_queueSteer/_queueFollowUp) right before preflightResult(true) while streaming. Capture
        // it so the later persisted entry matches by exact text. Re-check this ordering on pi upgrades.
        if (ok && live.session.isStreaming) {
          const q = queueOf();
          const last = q.at(-1);
          // Grew, or (items consumed by the run meanwhile) has a different tail, or holds more copies of the tail
          // text than before (a resend of an already-queued text) → the tail is ours. Known limit: if the run consumed
          // exactly as many copies of that same text as this send added, the queue looks unchanged and it is missed.
          if (last !== undefined && (q.length > qBefore.length || last !== qBefore.at(-1) || countIn(q, last) > countIn(qBefore, last))) {
            pending.text = last; pending.queued = true;
            live.queue.push({ id: cid, text: rawText, note: text.startsWith(rawText) ? text.slice(rawText.length) : '', piText: last, images,
              delivery, attachments: args.attachments?.length ?? 0, createdAt: nowIso() });
            this.queueChanged(live);
          }
        }
        accepted(ok);
      },
    });
    const outcome = await Promise.race([preflight, run.then(() => true, (err: unknown) => { throw err; })]).catch((err: unknown) => err as Error);
    void run.then(
      () => this.afterPrompt(live, cid),
      (err: unknown) => { console.warn(`[nopear] prompt failed (${live.meta.id}): ${(err as Error)?.message ?? err}`); this.afterPrompt(live, cid); },
    );
    if (outcome !== true) {
      live.pendingSends = live.pendingSends.filter((p) => p.clientMsgId !== cid);
      if (!queued) this.settleIfIdle(live);
      throw new OpError('conflict', outcome instanceof Error ? outcome.message : 'message rejected');
    }
    await this.deps.meta.patch(live.meta.id, { lastActivityAt: nowIso() });
    live.meta = this.metaOf(live.meta.id);
    if (!queued) this.sessionChanged(live.meta.id);
    return { queued };
  }

  /** pi's prompt() resolved. If no run is active any more and we still think we are running, the input was
   *  consumed without an agent run (extension command / handled input): settle the session. */
  private afterPrompt(live: Live, clientMsgId: string): void {
    if (live.disposed) return;
    if (live.session.isStreaming) {
      // Resolved mid-run without being queued (input handled / extension command): nothing will ever be
      // persisted for it, so it must not linger as a fallback match for some other user message.
      const j = live.pendingSends.findIndex((p) => p.clientMsgId === clientMsgId && !p.inPreflight && !p.queued);
      if (j >= 0) live.pendingSends.splice(j, 1);
      return;
    }
    const i = live.pendingSends.findIndex((p) => p.clientMsgId === clientMsgId);
    if (i >= 0) live.pendingSends.splice(i, 1);
    if (live.running) this.settleIfIdle(live);
  }

  /** Finish the run unless pi is still streaming or a send is still in pi's preflight: that send was queued
   *  against the ending run but may start the next one itself (pi's settle window). Its own afterPrompt
   *  (or the next agent_settled) settles the session instead, so status does not flicker idle→running. */
  private settleIfIdle(live: Live): void {
    if (live.session.isStreaming || live.pendingSends.some((p) => p.inPreflight && !p.abandoned)) return;
    this.finishRun(live);
  }

  async interrupt(id: string): Promise<void> {
    const live = this.live.get(id);
    if (!live || !(live.session.isStreaming || live.running)) throw new OpError('conflict', 'session is not running');
    for (const a of [...live.asks.values()]) a.cancel();
    await live.session.abort();
    // Explicit stop: a send stuck in pi's preflight (e.g. a never-resolving input handler) has no run to
    // abort, so no agent_settled will come — finish here instead of staying running forever.
    if (!live.disposed && !live.session.isStreaming && live.running) this.finishRun(live);
  }

  async rewind(id: string, messageId: string): Promise<string> {
    const live = await this.ensureLive(id);
    if (live.session.isStreaming || live.running) throw new OpError('conflict', 'session is running');
    const branch = live.sm.getBranch() as Entry[];
    const target = branch.find((e) => e.id === messageId);
    if (!target || target.type !== 'message' || target.message?.role !== 'user') {
      throw new OpError('bad_request', 'rewind target must be a user message on the active path');
    }
    const before = (await this.branchMessages(live)).map((m) => m.id);
    const r = await live.session.navigateTree(messageId, { summarize: false });
    if (r.cancelled) throw new OpError('conflict', 'rewind cancelled');
    const afterMsgs = await this.branchMessages(live);
    const after = new Set(afterMsgs.map((m) => m.id));
    const leafId = live.sm.getLeafId() ?? null;
    const preview = previewOfBranch(afterMsgs);
    const ids = before.filter((x) => !after.has(x));
    // Patch inside the chain: an upsert producer still queued from the last run must not overwrite the rewound preview.
    // A failed meta write must not swallow the event: clients still need to drop the rewound messages.
    this.enqueue(live, async () => {
      try {
        await this.deps.meta.patch(id, { leafId, preview });
        live.meta = this.metaOf(id);
      } catch (err) {
        console.warn(`[nopear] rewind meta patch failed (${id}): ${(err as Error)?.message ?? err}`);
      }
      return { type: 'messages.removed', ids };
    }, 'messages.removed(rewind)');
    this.sessionChanged(id); // the list preview follows the rewound tip
    await live.chain;
    return r.editorText ?? userText(target.message?.content);
  }

  async fork(id: string, messageId?: string): Promise<Session> {
    const live = await this.ensureLive(id);
    const leaf = messageId ?? live.sm.getLeafId();
    if (!leaf || !live.sm.getEntry(leaf)) throw new OpError('bad_request', 'nothing to fork');
    const scratch = SessionManager.open(live.meta.sessionFile, this.cfg.sessionsDir);
    const file = scratch.createBranchedSession(leaf);
    if (!file || !existsSync(file)) throw new OpError('bad_request', 'fork point has no assistant reply yet');
    const sm = SessionManager.open(file, this.cfg.sessionsDir);
    const now = nowIso();
    const forked: Message[] = [];
    for (const e of live.sm.getBranch(leaf)) { const m = await this.mapEntry(live, e); if (m) forked.push(m); }
    const meta: SessionMeta = { ...live.meta, id: sm.getSessionId(), kind: 'chat', title: `${live.meta.title}（fork）`, sessionFile: file,
      createdAt: now, lastActivityAt: now, preview: previewOfBranch(forked), pinned: false, starred: false, archived: false };
    delete meta.projectId;
    delete meta.leafId;
    const ids = this.clientMsgIds.get(id);
    if (ids) this.clientMsgIds.set(meta.id, new Map(ids));
    await this.deps.meta.put(meta);
    this.notify(meta.id);
    return this.get(meta.id);
  }

  async answerPrompt(args: RpcArgs<'prompts.answer'>): Promise<void> {
    const live = this.live.get(args.sessionId);
    const ask = live?.asks.get(args.promptId);
    if (!ask) throw new OpError('not_found', `no pending prompt ${args.promptId}`);
    ask.answer({ answers: args.answers, ...(args.note ? { note: args.note } : {}) });
  }

  async stopTask(id: string, taskId: string): Promise<void> {
    const live = await this.ensureLive(id);
    if (!live.tracker.active().some((t) => t.id === taskId)) throw new OpError('not_found', `no running task ${taskId}`);
    await live.tracker.stop(taskId);
  }

  /**
   * Read-only conversation of a background run (or one step of it): the child's own pi session file, which
   * pi-subagents keeps under this session's directory. Anything outside that directory is refused, so a client
   * can only read the subagents of a session it can already read.
   */
  async taskTranscript(args: RpcArgs<'tasks.transcript'>): Promise<RpcResult<'tasks.transcript'>> {
    const meta = this.metaOf(args.sessionId);
    if (typeof args.runId !== 'string' || !Number.isInteger(args.step) || args.step < 0) throw new OpError('bad_request', 'runId and step are required');
    const st = readRunStatus(args.runId, this.runsDir());
    if (!st) throw new OpError('not_found', `no background run ${args.runId}`);
    const step = st.steps?.[args.step];
    if (!step) throw new OpError('not_found', `run ${args.runId} has no step ${args.step}`);
    const state = taskState(step.status ?? st.state);
    const root = meta.sessionFile.replace(/\.jsonl$/, '') + sep;
    if (!step.sessionFile) return { messages: [], hasMore: false, state };
    const file = resolvePath(step.sessionFile);
    if (!meta.sessionFile || !file.startsWith(root)) throw new OpError('not_found', `run ${args.runId} does not belong to this session`);
    let text: string;
    try { text = await readFile(file, 'utf8'); } catch { return { messages: [], hasMore: false, state }; }
    const all: Message[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let entry: unknown;
      try { entry = JSON.parse(line); } catch { continue; } // a line being written right now
      const m = await entryToMessage(meta.id, entry, this.deps.blobs, new Map());
      if (m) all.push({ ...m, id: `${args.runId}:${args.step}:${m.id}` });
    }
    const limit = Math.min(Math.max(Math.trunc(args.limit ?? TRANSCRIPT_PAGE), 1), TRANSCRIPT_MAX);
    return { messages: all.slice(-limit), hasMore: all.length > limit, state };
  }

  private runsDir(): string { return this.deps.subagentRunsDir ?? subagentRunsDir(); }

  async waitIdle(id: string): Promise<void> {
    const live = this.live.get(id);
    if (!live) return;
    if (live.running || live.session.isStreaming) await new Promise<void>((r) => live.idleWaiters.push(r));
    await live.chain;
  }

  async watch(id: string, cursor: string | undefined, emit: (e: SessionEvent) => void, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const live = await this.ensureLive(id);
    const send = (e: SessionEvent) => { try { emit(e); } catch { /* sink errors must not break the session */ } };
    let attached = false;
    await this.runExclusive(live, async () => {
      if (live.disposed) return; // disposed while we waited on the chain → retry on a fresh Live below
      const replay = live.log.since(cursor);
      if (replay) for (const e of replay) send(e);
      else send(await this.snapshot(live));
      live.watchers.add(send);
      attached = true;
      this.scheduleIdle(live);
    });
    if (!attached) return this.watch(id, cursor, emit, signal);
    let ender!: (err: Error) => void;
    try {
      await new Promise<void>((resolve, reject) => {
        ender = reject;
        live.enders.add(ender);
        if (signal.aborted) return resolve();
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    } finally {
      live.enders.delete(ender);
      live.watchers.delete(send);
      this.scheduleIdle(live);
    }
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const l of [...this.live.values()]) {
      for (const a of [...l.asks.values()]) a.cancel();
      if (l.session.isStreaming) await l.session.abort().catch(() => {});
      await l.chain;
      await this.disposeLive(l);
    }
  }

  // ---------------- internals ----------------

  /**
   * Run the onTagged hook (e.g. project-memory prefetch); its failures never fail the session op, and it is
   * capped at deps.taggedTimeoutMs (default TAGGED_TIMEOUT_MS) so a slow prefetch can't hold sessions.create/update up to the client's RPC timeout.
   */
  private async tagged(projectId: string): Promise<void> {
    if (!this.deps.onTagged) return;
    const ms = this.deps.taggedTimeoutMs ?? TAGGED_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timedOut = await Promise.race([
        Promise.resolve(this.deps.onTagged(projectId)).then(() => false),
        new Promise<true>((r) => { timer = setTimeout(() => r(true), ms); }),
      ]);
      if (timedOut) console.warn(`[nopear] onTagged(${projectId}) timed out after ${ms}ms; continuing`);
    } catch (err) {
      console.warn(`[nopear] onTagged(${projectId}) failed: ${(err as Error)?.message ?? err}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private metaOf(id: string): SessionMeta {
    const m = this.deps.meta.get(id);
    if (!m) throw new OpError('not_found', `session ${id} not found`);
    return m;
  }

  private pickModel(id: string | undefined): Model<Api> {
    if (id !== undefined) {
      const m = resolveModel(this.deps.models, id);
      if (!m) throw new OpError('bad_request', `unknown model ${id}`);
      return m;
    }
    const m = resolveModel(this.deps.models, this.cfg.defaultModel) ?? this.deps.models.getAvailableSnapshot()[0];
    if (!m) throw new OpError('internal', 'no model available');
    return m;
  }

  private toSession(m: SessionMeta): Session {
    const live = this.live.get(m.id);
    const status = live && (live.running || live.session.isStreaming) ? 'running' : live?.lastError ? 'error' : 'idle';
    const s: Session = { id: m.id, workerId: this.deps.workerId, kind: m.kind, title: m.title, cwd: m.cwd, status,
      createdAt: m.createdAt, lastActivityAt: m.lastActivityAt, preview: m.preview, pinned: m.pinned, starred: m.starred, archived: m.archived,
      model: m.model, thinking: m.thinking, promptCount: live?.asks.size ?? 0, taskCount: live?.tracker.active().length ?? 0 };
    if (m.projectId) s.projectId = m.projectId;
    return s;
  }

  private idsOf(id: string): Map<string, string> {
    let m = this.clientMsgIds.get(id);
    if (!m) { m = new Map(); this.clientMsgIds.set(id, m); }
    return m;
  }

  /**
   * Set a session's title from `source`, unless a higher-ranked source set the current one (titles.ts).
   * Returns null when applied, otherwise the reason (shown to the agent by session_rename).
   */
  private async retitle(id: string, title: string, source: TitleSource): Promise<string | null> {
    const cur = this.deps.meta.get(id);
    if (!cur) return '会话不存在';
    if (!canRetitle(cur.titleSource, source)) return '用户手动设置过标题，保持不变';
    if (cur.title === title && cur.titleSource === source) return null;
    await this.deps.meta.patch(id, { title, titleSource: source });
    const live = this.live.get(id);
    if (live) live.meta = this.metaOf(id);
    this.sessionChanged(id);
    return null;
  }

  /** After a completed run: give a session still titled by its first prompt a short model-written title (once per Live). */
  private async maybeAutoTitle(live: Live): Promise<void> {
    if (!this.cfg.autoTitle || live.titleBusy || (live.titleTries ?? 0) >= AUTO_TITLE_TRIES || live.disposed || live.lastError) return;
    if (!wantsAutoTitle(this.deps.meta.get(live.meta.id)?.titleSource)) return;
    const msgs = (live.sm.getBranch() as Entry[]).filter((e) => e.type === 'message').map((e) => e.message!);
    const firstUser = userText(msgs.find((m) => m.role === 'user')?.content);
    const firstReply = msgs.filter((m) => m.role === 'assistant').map((m) => userText(m.content)).find((t) => t.trim()) ?? '';
    if (!firstUser.trim() || !firstReply.trim()) return; // nothing to name yet (e.g. only tool calls so far)
    const model = live.session.model as Model<Api> | undefined;
    if (!model) return;
    live.titleTries = (live.titleTries ?? 0) + 1;
    live.titleBusy = true;
    try {
      // Reasoning models may think before answering (some always do); the lowest level keeps that short, and the
      // token cap leaves room for it — with a tight cap the thinking used it all and no title came back.
      const res = await this.deps.models.completeSimple(model, {
        systemPrompt: AUTO_TITLE_SYSTEM,
        messages: [{ role: 'user', content: autoTitlePrompt(firstUser, firstReply), timestamp: Date.now() }],
      }, { maxTokens: AUTO_TITLE_MAX_TOKENS, ...(model.reasoning ? { reasoning: 'minimal' as const } : {}), signal: AbortSignal.timeout(AUTO_TITLE_TIMEOUT_MS) });
      const title = res.stopReason === 'error' ? '' : cleanTitle(userText(res.content));
      if (!title) {
        console.warn(`[nopear] auto title: no title from ${model.provider}/${model.id} (${live.meta.id}, try ${live.titleTries}/${AUTO_TITLE_TRIES}): ${res.stopReason}${res.errorMessage ? ` ${res.errorMessage.slice(0, 200)}` : ''}`);
        return;
      }
      live.titleTries = AUTO_TITLE_TRIES; // done
      // Re-check: the user (or the agent) may have renamed it while the title was being generated.
      if (wantsAutoTitle(this.deps.meta.get(live.meta.id)?.titleSource)) await this.retitle(live.meta.id, title, 'auto');
    } catch (err) {
      console.warn(`[nopear] auto title failed (${live.meta.id}, try ${live.titleTries}/${AUTO_TITLE_TRIES}): ${(err as Error)?.message ?? err}`);
    } finally {
      live.titleBusy = false;
    }
  }

  private notify(id: string): void {
    const m = this.deps.meta.get(id);
    if (!m) return;
    const s = this.toSession(m);
    for (const l of this.listeners) l(s);
  }

  /** Publish session.updated on the session timeline and to machine listeners. */
  private sessionChanged(id: string): void {
    const live = this.live.get(id);
    if (live) this.enqueue(live, async () => ({ type: 'session.updated', session: this.get(id) }));
    else this.notify(id);
  }

  private enqueue(live: Live, produce: () => Promise<Uncursored | null>, label = 'event'): void {
    live.chain = live.chain.then(async () => {
      const ev = await produce();
      if (!ev) return;
      const out = live.log.append(ev);
      for (const w of live.watchers) w(out);
      if (ev.type === 'session.updated') this.notify(live.meta.id);
    }).catch((err: unknown) => console.warn(`[nopear] publish failed (${live.meta.id}): lost ${label}: ${(err as Error)?.message ?? err}`));
  }

  private runExclusive(live: Live, fn: () => Promise<void>): Promise<void> {
    const p = live.chain.then(fn);
    live.chain = p.catch(() => {});
    return p;
  }

  private async branchMessages(live: Live): Promise<Message[]> {
    const out: Message[] = [];
    for (const e of live.sm.getBranch()) {
      const m = await this.mapEntry(live, e);
      if (m) out.push(m);
    }
    return out;
  }

  /** Map one immutable entry, memoized per Live (avoids re-decoding/hashing images on every snapshot/page). */
  private async mapEntry(live: Live, entry: unknown): Promise<Message | null> {
    const eid = (entry as { id?: unknown } | undefined)?.id;
    if (typeof eid !== 'string') return null;
    let m = live.cache.get(eid);
    if (m === undefined) {
      m = await entryToMessage(live.meta.id, entry, this.deps.blobs, new Map());
      live.cache.set(eid, m);
    }
    if (!m) return null;
    const cid = this.idsOf(live.meta.id).get(eid);
    return cid ? { ...m, clientMsgId: cid } : m;
  }

  private async snapshot(live: Live): Promise<SessionEvent> {
    const all = await this.branchMessages(live);
    const start = Math.max(0, all.length - SNAPSHOT_PAGE);
    const messages = all.slice(start);
    // pubMsg, not liveMsg: it reflects exactly the deltas published before this point in the chain, so the
    // deltas that follow the snapshot are not applied twice by the client.
    if (live.pubMsg) messages.push(structuredClone(live.pubMsg));
    return { type: 'snapshot', cursor: live.log.current(), session: this.get(live.meta.id), messages,
      hasMore: start > 0, prompts: [...live.asks.values()].map((a) => a.prompt), tasks: live.tracker.current(), queue: this.queueItems(live) };
  }

  private ensureLive(id: string): Promise<Live> {
    const l = this.live.get(id);
    if (l && !l.disposed) { l.lastUse = Date.now(); return Promise.resolve(l); }
    const pending = this.loading.get(id);
    if (pending) return pending;
    const meta = this.metaOf(id);
    if (meta.sessionFile && existsSync(meta.sessionFile)) {
      const sm = SessionManager.open(meta.sessionFile, this.cfg.sessionsDir);
      if (meta.leafId === null) sm.resetLeaf();
      else if (meta.leafId) {
        // A pinned leaf that is not in the file must never hide entries: keep the file's last leaf (open() default).
        try { sm.branch(meta.leafId); } catch {
          console.warn(`[nopear] ${id}: stored leafId ${meta.leafId} not in ${meta.sessionFile}; using the file's last leaf ${sm.getLeafId() ?? '(root)'}`);
        }
      }
      return this.load(meta, sm);
    }
    // pi only writes a session file once it has an assistant reply; nothing persisted yet. Recreate with the
    // same pi session id (= nopear id) and record wherever pi will write it, so identity and history survive.
    const sm = SessionManager.create(meta.cwd, this.cfg.sessionsDir, { id: meta.id });
    const file = sm.getSessionFile() ?? '';
    const p = (file !== meta.sessionFile ? this.deps.meta.patch(meta.id, { sessionFile: file }) : Promise.resolve(undefined))
      .then(() => this.build(this.metaOf(meta.id), sm))
      .finally(() => this.loading.delete(meta.id));
    this.loading.set(meta.id, p);
    return p;
  }

  private load(meta: SessionMeta, sm: SessionManager): Promise<Live> {
    const p = this.build(meta, sm).finally(() => this.loading.delete(meta.id));
    this.loading.set(meta.id, p);
    return p;
  }

  private async build(meta: SessionMeta, sm: SessionManager): Promise<Live> {
    if (this.closed) throw new OpError('internal', 'host is shut down');
    const bus = createEventBus();
    const persona = this.cfg.persona;
    const append = () => this.deps.systemPromptAppend?.(this.deps.meta.get(meta.id) ?? meta);
    // Both steps are idempotent: a custom SYSTEM.md passes through systemPromptOverride AND the hook.
    const rewrite = (base: string | undefined) => appendOnce(rewriteSystemPrompt(base, persona), append());
    const loader = new DefaultResourceLoader({
      cwd: meta.cwd, agentDir: this.cfg.agentDir, eventBus: bus,
      additionalExtensionPaths: PI_SUBAGENTS_ENTRY ? [PI_SUBAGENTS_ENTRY] : [],
      // pi's built-in default prompt is assembled after resource loading, so systemPromptOverride only sees
      // a custom SYSTEM.md (usually undefined); the before_agent_start hook rewrites the assembled prompt.
      systemPromptOverride: (base) => rewrite(base),
      extensionFactories: [
        {
          name: 'nopear',
          factory: (pi) => {
            pi.on('before_agent_start', (e) => ({ systemPrompt: rewrite(e.systemPrompt) }));
            // Images enter history through tool results (screenshots, `send_file`, MCP bridges): re-encode them to WebP
            // with a capped long side before they are persisted and replayed on every later request.
            pi.on('tool_result', async (e) => {
              if (!Array.isArray(e.content) || !e.content.some((b) => b?.type === 'image')) return;
              const content = await normalizeImageBlocks(e.content);
              return content === e.content ? undefined : { content };
            });
          },
        },
        ...(this.deps.extraExtensions ?? []),
      ],
    });
    await loader.reload();

    let live!: Live;
    const ask = createAskTool({
      sessionId: meta.id,
      open: (p) => this.openPrompt(live, p),
      wait: (_sid, pid, signal) => this.waitPrompt(live, pid, signal),
    });
    const model = resolveModel(this.deps.models, meta.model) ?? this.pickModel(undefined);
    const { session } = await createAgentSession({
      cwd: meta.cwd, agentDir: this.cfg.agentDir, model, thinkingLevel: meta.thinking, modelRuntime: this.deps.models,
      sessionManager: sm, resourceLoader: loader,
      customTools: [ask, createSessionRenameTool({ rename: (t) => this.retitle(meta.id, t, 'agent') }), ...(this.deps.extraTools?.(meta) ?? [])],
      ...(this.toolsAllowlist(meta, ask.name)),
    });
    // Account auto-compaction: pi's defaults never fire before the provider rejects an image-heavy session.
    session.settingsManager.applyOverrides(compactionOverrides(this.autoCompact ?? DEFAULT_AUTO_COMPACT, SessionHost.contextWindowOf(session)));
    // Emits session_start to extensions (pi-subagents registers its tools/context there).
    // A distinct (non-noop) UI context makes ctx.hasUI true: pi-subagents otherwise drains every background run at
    // agent_end in headless sessions, keeping the turn "running" until the subagent finishes.
    await session.bindExtensions({ mode: 'rpc', uiContext: headlessUiContext(session.extensionRunner.getUIContext()), onError: (err) => console.warn(`[nopear] extension error (${meta.id}): ${JSON.stringify(err).slice(0, 300)}`) });
    let lastRunning = 0;
    const tracker = new TaskTracker({
      eventBus: bus,
      readStatus: (runId) => readRunStatus(runId, this.runsDir()),
      onChange: (tasks) => {
        this.enqueue(live, async () => ({ type: 'tasks', tasks }));
        // Activity (turns, current tool) changes every poll; the session row only shows how many are running.
        const running = live.tracker.active().length;
        if (running !== lastRunning) { lastRunning = running; this.sessionChanged(meta.id); }
        this.scheduleIdle(live);
      },
      log: (m) => console.warn(`[nopear] ${meta.id}: ${m}`),
    });
    live = { meta, sm, session, bus, tracker, watchers: new Set(), asks: new Map(), pendingSends: [], queue: [], queueRebuilding: false,
      liveMsg: null, pubMsg: null, liveSeq: 0,
      log: new SyncLog(newEpoch()), sendChain: Promise.resolve(), cache: new Map(), enders: new Set(), disposed: false, lastUse: Date.now(),
      running: false, lastError: undefined, chain: Promise.resolve(), idleWaiters: [], progressAt: new Map(), idleTimer: null, unsub: () => {} };
    this.hookPersistence(live);
    live.unsub = session.subscribe((e) => this.onEvent(live, e as unknown as { type: string; [k: string]: unknown }));
    this.live.set(meta.id, live);
    this.scheduleIdle(live);
    void tracker.refresh(); // runs started before this session was (re)loaded in this process
    return live;
  }

  /** Wrap appendMessage: pi persists after notifying listeners, so the entry id is only known here. */
  private hookPersistence(live: Live): void {
    const sm = live.sm;
    const orig = sm.appendMessage.bind(sm);
    sm.appendMessage = ((message: Parameters<SessionManager['appendMessage']>[0]) => {
      const entryId = orig(message);
      const role = (message as { role?: string }).role;
      let replaces: string | undefined;
      if (role === 'user') {
        const text = userText((message as { content?: unknown }).content);
        // pi persists a send's user message only after preflightResult(true): a send still in preflight (including
        // one abandoned by an interrupt) can never own this entry (it may be extension-injected meanwhile).
        let i = live.pendingSends.findIndex((p) => !p.inPreflight && p.text === text);
        // Fallback for text transformed by pi/extensions (templates, input transforms) of a send that started its
        // own run: FIFO among accepted, non-queued sends. Queued sends carry pi's final text and match exactly
        // only, so an extension-injected steer/followUp cannot steal them.
        if (i < 0) i = live.pendingSends.findIndex((p) => !p.inPreflight && !p.queued);
        if (i >= 0) { this.idsOf(live.meta.id).set(entryId, live.pendingSends[i]!.clientMsgId); live.pendingSends.splice(i, 1); }
      } else if (role === 'assistant') {
        replaces = live.liveMsg?.id;
        live.liveMsg = null;
      }
      publish(entryId, role, replaces);
      return entryId;
    }) as SessionManager['appendMessage'];
    // Extension custom messages (e.g. pi-subagents completion notices) are persisted through their own entry type.
    const origCustom = sm.appendCustomMessageEntry.bind(sm);
    sm.appendCustomMessageEntry = ((...args: Parameters<SessionManager['appendCustomMessageEntry']>) => {
      const entryId = origCustom(...args);
      publish(entryId, 'custom');
      return entryId;
    }) as SessionManager['appendCustomMessageEntry'];
    const publish = (entryId: string, role: string | undefined, replaces?: string) => {
      const entry = sm.getEntry(entryId);
      const id = live.meta.id;
      this.enqueue(live, async () => {
        if (role === 'assistant' && (!replaces || live.pubMsg?.id === replaces)) live.pubMsg = null;
        const msg = await this.mapEntry(live, entry);
        if (!msg) return null;
        const preview = previewOf(msg);
        const patch: Partial<SessionMeta> = {};
        if (preview && msg.role !== 'tool') patch.preview = preview;
        if (this.deps.meta.get(id)?.leafId !== undefined) patch.leafId = sm.getLeafId() ?? null; // keep a rewound leaf pinned to the tip
        if (Object.keys(patch).length) { await this.deps.meta.patch(id, patch); live.meta = this.metaOf(id); }
        return replaces ? { type: 'message.upsert', message: msg, replaces } : { type: 'message.upsert', message: msg };
      }, `message.upsert(${role})`);
    };
  }

  private onEvent(live: Live, e: { type: string; [k: string]: unknown }): void {
    const id = live.meta.id;
    switch (e.type) {
      case 'agent_start':
        live.running = true;
        live.lastError = undefined;
        this.sessionChanged(id);
        break;
      case 'agent_end': {
        const msgs = (e.messages as Array<{ role?: string; stopReason?: string; errorMessage?: string }> | undefined) ?? [];
        const lastA = [...msgs].reverse().find((m) => m.role === 'assistant');
        live.lastError = lastA?.stopReason === 'error' ? lastA.errorMessage || 'error' : undefined;
        break;
      }
      case 'queue_update':
        // pi delivered (or cleared) queued messages: mirror it
        if (this.syncQueue(live)) this.queueChanged(live);
        break;
      case 'agent_settled':
        // A send that landed in pi's settle window may already have started (or be about to start) the next run.
        this.settleIfIdle(live);
        break;
      case 'message_start': {
        const m = e.message as { role?: string } | undefined;
        if (m?.role !== 'assistant') break;
        live.liveMsg = { id: `live:${++live.liveSeq}`, sessionId: id, role: 'assistant', blocks: [], ts: nowIso(), status: 'streaming' };
        const snap = structuredClone(live.liveMsg);
        this.enqueue(live, async () => { live.pubMsg = structuredClone(snap); return { type: 'message.upsert', message: snap }; }, 'message.upsert(live)');
        break;
      }
      case 'message_update': {
        const lm = live.liveMsg;
        const ame = e.assistantMessageEvent as { type: string; contentIndex?: number; delta?: string } | undefined;
        if (!lm || !ame) break;
        if ((ame.type === 'text_delta' || ame.type === 'thinking_delta') && typeof ame.delta === 'string') {
          const kind = ame.type === 'text_delta' ? 'text' : 'thinking';
          const index = ame.contentIndex ?? lm.blocks.length;
          applyDelta(lm, index, kind, ame.delta);
          const messageId = lm.id;
          const text = ame.delta;
          this.enqueue(live, async () => {
            if (live.pubMsg?.id === messageId) applyDelta(live.pubMsg, index, kind, text);
            return { type: 'message.delta', messageId, index, kind, text };
          }, 'message.delta');
        } else if (ame.type === 'toolcall_end') {
          lm.blocks = assistantBlocks((e.message as { content?: unknown } | undefined)?.content);
          const snap = structuredClone(lm);
          this.enqueue(live, async () => { live.pubMsg = structuredClone(snap); return { type: 'message.upsert', message: snap }; }, 'message.upsert(toolcall)');
        }
        break;
      }
      case 'tool_execution_update': {
        const toolCallId = String(e.toolCallId ?? '');
        const now = Date.now();
        if (now - (live.progressAt.get(toolCallId) ?? 0) < 250) break;
        live.progressAt.set(toolCallId, now);
        const pr = e.partialResult as { content?: unknown } | undefined;
        const text = userText(pr?.content).slice(-TOOL_PROGRESS_MAX_CHARS);
        if (text) this.enqueue(live, async () => ({ type: 'tool.progress', toolCallId, text }), 'tool.progress');
        break;
      }
      case 'tool_execution_end':
        live.progressAt.delete(String(e.toolCallId ?? ''));
        // pi-subagents announces detached single/chain runs on its bus, but not async workflows: look after any
        // subagent call (launch, status, steer…) so a workflow shows up in the task list too.
        if (String(e.toolName ?? '').toLowerCase() === 'subagent') void live.tracker.refresh();
        break;
      default:
        break;
    }
  }

  private finishRun(live: Live): void {
    live.running = false;
    const orphan = live.liveMsg?.id;
    live.liveMsg = null;
    // The run is over: sends that never produced a persisted user message are dead (fallback matching must
    // not reuse them). Normal settles never get here with a send in preflight; an explicit interrupt can: keep
    // such a send (pi may still start a run for it once its preflight passes, and that user entry must carry
    // its clientMsgId) but mark it abandoned: it no longer blocks settling, and stays in preflight so it matches
    // nothing until pi accepts it. A rejected/failed preflight removes it (sendNow); a never-resolving one lingers
    // inert (it also keeps an identical clientMsgId retry idempotent).
    // Queued sends pi still holds (an interrupt keeps pi's queue; the next run delivers them) stay matchable.
    if (this.syncQueue(live)) this.queueChanged(live);
    const stillQueued = new Set(live.queue.map((q) => q.id));
    live.pendingSends = live.pendingSends.filter((p) => p.inPreflight || stillQueued.has(p.clientMsgId));
    for (const p of live.pendingSends) if (p.inPreflight) p.abandoned = true;
    // A live bubble that never got its persisted message: drop it from snapshots and existing watchers.
    if (orphan) {
      this.enqueue(live, async () => {
        if (live.pubMsg?.id === orphan) live.pubMsg = null;
        return { type: 'messages.removed', ids: [orphan] };
      }, 'messages.removed(orphan)');
    }
    // Invariant: a pinned leaf (set by rewind) is persisted as the actual sm leaf once the run's upserts are
    // through. Read both at execution time from the MetaStore (live.meta may be stale), so a restart restores
    // exactly the active path.
    if (this.deps.meta.get(live.meta.id)?.leafId !== undefined) {
      this.enqueue(live, async () => {
        const id = live.meta.id;
        const stored = this.deps.meta.get(id)?.leafId;
        const leafId = live.sm.getLeafId() ?? null;
        if (stored !== undefined && stored !== leafId) { await this.deps.meta.patch(id, { leafId }); live.meta = this.metaOf(id); }
        return null;
      }, 'leafId');
    }
    this.sessionChanged(live.meta.id);
    void this.maybeAutoTitle(live);
    const waiters = live.idleWaiters.splice(0);
    for (const w of waiters) w();
    this.scheduleIdle(live);
  }

  private openPrompt(live: Live, prompt: Prompt): void {
    // Registered synchronously so prompts.answer can never race the opened event.
    live.asks.set(prompt.id, { prompt, answer: () => {}, cancel: () => {} });
    this.enqueue(live, async () => ({ type: 'prompt.opened', prompt }));
    this.sessionChanged(live.meta.id);
  }

  private waitPrompt(live: Live, promptId: string, signal: AbortSignal): Promise<{ answers: Record<string, string>; note?: string } | 'timeout'> {
    return new Promise((resolve, reject) => {
      const entry = live.asks.get(promptId);
      if (!entry) return reject(new Error('prompt not open'));
      let timer: ReturnType<typeof setTimeout> | null = null;
      const close = (reason: 'answered' | 'cancelled' | 'timeout') => {
        if (!live.asks.has(promptId)) return false;
        live.asks.delete(promptId);
        if (timer) clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.enqueue(live, async () => ({ type: 'prompt.closed', promptId, reason }));
        this.sessionChanged(live.meta.id);
        this.scheduleIdle(live);
        return true;
      };
      const onAbort = () => { if (close('cancelled')) reject(new Error('cancelled')); };
      entry.answer = (v) => { if (close('answered')) resolve(v); };
      entry.cancel = onAbort;
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      if (this.cfg.askTimeoutMs > 0) timer = setTimeout(() => { if (close('timeout')) resolve('timeout'); }, this.cfg.askTimeoutMs);
    });
  }

  private isIdle(live: Live): boolean {
    return !this.closed && !live.disposed && live.watchers.size === 0 && !live.running && !live.session.isStreaming
      && live.asks.size === 0 && live.tracker.active().length === 0;
  }

  private scheduleIdle(live: Live, delay = this.cfg.idleDisposeMs): void {
    if (live.idleTimer) { clearTimeout(live.idleTimer); live.idleTimer = null; }
    if (!this.isIdle(live)) return;
    live.idleTimer = setTimeout(() => {
      live.idleTimer = null;
      // Re-check at fire time: the session may have been touched (ensureLive) or become active meanwhile.
      if (this.live.get(live.meta.id) !== live || !this.isIdle(live)) return;
      const since = Date.now() - live.lastUse;
      if (since < this.cfg.idleDisposeMs) return this.scheduleIdle(live, this.cfg.idleDisposeMs - since);
      // Detach synchronously so any later ensureLive builds a fresh Live; release resources once the chain drains.
      live.disposed = true;
      this.live.delete(live.meta.id);
      void live.chain.then(() => this.disposeLive(live));
    }, delay);
    live.idleTimer.unref?.();
  }

  /**
   * Detach synchronously, then tear the pi session down. Extensions must get `session_shutdown` before
   * dispose(): pi's dispose() does not emit it, and pi-subagents only releases its per-session runtime
   * (a process-global registry entry holding timers, watchers and the whole AgentSession + SessionManager)
   * from that handler — skipping it leaked every disposed session.
   */
  private disposeLive(live: Live): Promise<void> {
    live.disposed = true;
    if (live.idleTimer) clearTimeout(live.idleTimer);
    live.unsub();
    live.tracker.dispose();
    if (this.live.get(live.meta.id) === live) this.live.delete(live.meta.id);
    live.cache.clear();
    for (const w of live.idleWaiters.splice(0)) w();
    const session = live.session;
    return (async () => {
      try {
        const runner = session.extensionRunner;
        if (runner?.hasHandlers('session_shutdown')) await runner.emit({ type: 'session_shutdown', reason: 'quit' });
      } catch (err) {
        console.warn(`[nopear] session_shutdown failed (${live.meta.id}): ${(err as Error)?.message ?? err}`);
      }
      try { session.dispose(); } catch { /* already disposed */ }
    })();
  }
}

/** Write a streamed delta into blocks[index]; fills skipped indices so snapshots never contain holes. */
function applyDelta(msg: Message, index: number, kind: 'text' | 'thinking', text: string): void {
  for (let i = msg.blocks.length; i < index; i++) msg.blocks[i] = { type: 'text', text: '' };
  const cur = msg.blocks[index];
  if (cur && cur.type === kind) cur.text += text;
  else msg.blocks[index] = { type: kind, text } as Block;
}
