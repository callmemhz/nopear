// nopear v3 protocol — the single source of truth shared by saas, worker, core, web, mobile.
// JSON fields camelCase; timestamps ISO-8601 UTC.

export const PROTOCOL_VERSION = 3 as const;

// ---------- constants ----------
export const HKDF_SALT = 'nopear/v3';
export const AUTHZ_PREFIX = 'nopear-authz:v3';
export const REPLAY_WINDOW_MS = 5 * 60 * 1000;
export const SYNC_LOG_LIMIT = 2000;
export const SNAPSHOT_PAGE = 100;
export const PAGE_DEFAULT = 100;
export const PAGE_MAX = 500;
export const FILES_MAX_ENTRIES = 500;
export const FILE_READ_MAX_BYTES = 100 * 1024 * 1024;
export const TOOL_PROGRESS_MAX_CHARS = 4096;
export const PREVIEW_MAX_CHARS = 160;
export const RPC_TIMEOUT_MS = 60_000;
export const BINARY_RPC_TIMEOUT_MS = 300_000;
export const SSE_PING_MS = 15_000;
/** Client SSE watchdog: a long-lived stream with no bytes (event or `: ping`) for this long is treated as stalled,
 *  aborted and reopened (2.5 × SSE_PING_MS). */
export const SSE_STALL_MS = 40_000;
export const TUNNEL_PING_MS = 30_000;
export const TUNNEL_DEAD_MS = 90_000;
export const TUNNEL_MAX_FRAME_BYTES = 160 * 1024 * 1024;
export const CLAIM_TOKEN_TTL_MS = 10 * 60 * 1000;
export const SAAS_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const HEADER_CLIENT = 'x-nopear-client';
export const HEADER_WORKER = 'x-nopear-worker';
export const HEADER_PLAIN = 'x-nopear-plain';
export const INSTALL_CODE_TTL_MS = 30 * 60 * 1000;
export const MEMORY_MAX_BYTES = 64 * 1024;
/** SaaS internal client identity for plaintext `rpc` frames (session-class tools); accepted only in plaintext mode. */
export const SAAS_CLIENT_PUB = 'saas';
/** Wire message of the worker's `rpc.err 400 bad_request` for a plaintext frame it refuses (NOPEAR_E2E=required / e2e on). */
export const PLAINTEXT_DISABLED_MESSAGE = 'plaintext disabled on this worker';
export const VISION_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

export function authzMessage(userId: string, clientPub: string): string {
  return `${AUTHZ_PREFIX}:${userId}:${clientPub}`;
}
export function sessionKey(workerId: string, sessionId: string): string {
  return `${workerId}/${sessionId}`;
}
export function formatCursor(epoch: string, n: number): string {
  return `${epoch}.${n}`;
}
export function parseCursor(cursor: string): { epoch: string; n: number } | null {
  const m = /^([A-Za-z0-9]+)\.(\d+)$/.exec(cursor);
  if (!m) return null;
  const n = Number(m[2]);
  if (!Number.isSafeInteger(n)) return null;
  return { epoch: m[1]!, n };
}

// ---------- core model ----------
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export type SessionKind = 'chat';
export type SessionStatus = 'idle' | 'running' | 'error';

export interface Session {
  id: string;
  workerId: string;
  kind: SessionKind;
  /** Project tag (SaaS collaboration hub project id). */
  projectId?: string;
  title: string;
  cwd: string;
  status: SessionStatus;
  createdAt: string;
  lastActivityAt: string;
  preview: string;
  pinned: boolean;
  starred: boolean;
  archived: boolean;
  model: string;
  thinking: ThinkingLevel;
  promptCount: number;
  taskCount: number;
}

export type Role = 'user' | 'assistant' | 'tool' | 'system';
/** role=tool messages: one tool_result block, followed by any image blocks the tool returned (e.g. `read` on a png)
 *  and, for the worker-native `send_file` tool, one `file` block. */
export type Block =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolCallId: string; toolName: string; text: string; isError: boolean }
  | { type: 'image'; mediaType: string; blob: string }
  | FileBlock;
/** A file the agent delivered to the user (`send_file`); `blob` = BlobStore sha256 hex, fetched via `blobs.get`. */
export interface FileBlock { type: 'file'; name: string; mediaType: string; size: number; blob: string; title?: string; note?: string }
/** Name of the worker-native tool that delivers a file to the user as a `file` block. */
export const SEND_FILE_TOOL = 'send_file';

export type NoticeStatus = 'completed' | 'failed' | 'paused' | 'stopped' | 'attention';
/** Structured marker on role=system messages for background-subagent notifications (full text stays in the text block). */
export interface MessageNotice { kind: 'subagent'; title: string; status?: NoticeStatus; agent?: string }

export type MessageStatus = 'streaming' | 'complete' | 'error';
export interface Message {
  id: string;
  sessionId: string;
  role: Role;
  blocks: Block[];
  ts: string;
  status: MessageStatus;
  clientMsgId?: string;
  model?: string;
  errorText?: string;
  usage?: { input: number; output: number; costUsd: number };
  /** role=system only: background-subagent notification marker (clients render a compact card). */
  notice?: MessageNotice;
}

export interface AskOption { label: string; description?: string }
export interface AskQuestion { question: string; header: string; multiSelect: boolean; options: AskOption[] }
export interface Prompt { id: string; sessionId: string; questions: AskQuestion[]; createdAt: string }

export type TaskState = 'queued' | 'running' | 'paused';
export interface BackgroundTask { id: string; agent: string; goal: string; state: TaskState; startedAt: string; model?: string }

/** A `messages.send` queued by pi while the session runs (not yet delivered to the model). */
export type QueueDelivery = 'followUp' | 'steer';
export interface QueueItem {
  /** = the send's clientMsgId. */
  id: string;
  /** The text as sent (without the worker's attachment annotations). */
  text: string;
  delivery: QueueDelivery;
  /** Number of attachments sent with it. */
  attachments: number;
  createdAt: string;
}

export interface ModelInfo { id: string; name: string; reasoning: boolean }
export interface WorkerInfo {
  workerId: string;
  label: string;
  version: string;
  defaultCwd: string;
  defaultModel: string;
  defaultThinking: ThinkingLevel;
  models: ModelInfo[];
}
export interface FileEntry { name: string; type: 'file' | 'dir'; size: number; mtime: string }
export interface FileListing { path: string; entries: FileEntry[]; truncated: boolean }
export type MemoryScope = 'global' | 'project';
export interface MemoryFile { scope: MemoryScope; path: string; content: string; exists: boolean }
export interface Attachment { kind: 'image' | 'file'; name: string; mediaType: string; dataBase64: string }
export interface ClientAuthz { clientPub: string; label: string; sig: string }

// ---------- SaaS collaboration hub (plaintext on SaaS) ----------
export interface Project {
  id: string;                 // p_<随机>
  name: string;
  description: string;
  paths: Record<string, string>;   // workerId → 该机器上的绝对路径（可空对象；workerId 必须属于本账号）
  createdAt: string; updatedAt: string;
}
export type CardState = 'inbox' | 'queued' | 'running' | 'review' | 'done';
export const CARD_STATES: readonly CardState[] = ['inbox', 'queued', 'running', 'review', 'done'];
/** Target states a user / tool may set; `running`/`review` are set only by the executing worker (`card.state`). */
export type CardMoveState = 'inbox' | 'queued' | 'done';
export const CARD_MOVE_STATES: readonly CardMoveState[] = ['inbox', 'queued', 'done'];
export interface Card {
  id: string;                 // c_<随机>
  projectId: string | null;   // 卡可以没有项目
  title: string;
  body: string;               // 需求描述（markdown）
  state: CardState;
  workerId: string | null;    // inbox: null；queued/running/review: 执行机器；done: 保留最后执行机器（从未执行为 null）
  sessionId: string | null;   // 最近一次执行会话（与 workerId 同生命周期：进 inbox 时一并清空）
  order: number;              // 列内排序（小在前）；列 = state（queued 再按 workerId 分列）
  createdAt: string; updatedAt: string;
  error?: string;             // 最近一次执行失败原因；收到新的 running 上报时清除
}
export interface CardPatch {
  title?: string; body?: string; projectId?: string | null;
  state?: CardMoveState; workerId?: string; order?: number;
}
export interface MemoryDoc { scope: MemoryScope; projectId: string | null; content: string; updatedAt: string }  // global 时 projectId=null
export interface SessionIndexEntry {        // SaaS 维护的跨机器会话索引（来自 worker 推送）
  workerId: string; sessionId: string; title: string; preview: string;
  status: SessionStatus; projectId: string | null; cwd: string;
  createdAt: string; lastActivityAt: string;
}
/**
 * Account-level context auto-compaction. The worker turns this into pi's
 * `compaction` settings; `thresholdTokens` is an absolute context size (not a ratio) because
 * what overflows is a token count, and providers disagree about how many tokens a window holds.
 */
export interface AutoCompactSettings {
  enabled: boolean;
  /** Start compacting once the context estimate reaches this many tokens. */
  thresholdTokens: number;
  /** Keep roughly this many of the most recent tokens verbatim; older ones become a summary. */
  keepRecentTokens: number;
}
/** Defaults are what a new account gets and what a missing field falls back to. 300k is far below any
 *  modern window, so compaction runs while there is still room to summarize. */
export const DEFAULT_AUTO_COMPACT: AutoCompactSettings = { enabled: true, thresholdTokens: 300_000, keepRecentTokens: 20_000 };
export const AUTO_COMPACT_THRESHOLD_MIN = 20_000;
export const AUTO_COMPACT_THRESHOLD_MAX = 900_000;
export const AUTO_COMPACT_KEEP_MIN = 1_000;
export const AUTO_COMPACT_KEEP_MAX = 200_000;
/** Fill a partial/absent AutoCompactSettings with defaults and drop out-of-range numbers. */
export function normalizeAutoCompact(v: Partial<AutoCompactSettings> | null | undefined): AutoCompactSettings {
  const num = (n: unknown, d: number, min: number, max: number) =>
    (typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : d);
  return {
    enabled: typeof v?.enabled === 'boolean' ? v.enabled : DEFAULT_AUTO_COMPACT.enabled,
    thresholdTokens: num(v?.thresholdTokens, DEFAULT_AUTO_COMPACT.thresholdTokens, AUTO_COMPACT_THRESHOLD_MIN, AUTO_COMPACT_THRESHOLD_MAX),
    keepRecentTokens: num(v?.keepRecentTokens, DEFAULT_AUTO_COMPACT.keepRecentTokens, AUTO_COMPACT_KEEP_MIN, AUTO_COMPACT_KEEP_MAX),
  };
}
export interface AccountSettings { e2e: boolean; autoCompact: AutoCompactSettings }   // e2e 默认 false
export type ToolErrorCode = 'bad_request' | 'forbidden' | 'not_found' | 'too_large' | 'e2e_enabled' | 'machine_offline' | 'saas_unreachable' | 'timeout' | 'internal';
export interface ApiTokenInfo { id: string; label: string; createdAt: string; lastUsedAt: string | null }
export interface InstallCodeResult { code: string; command: string; expiresAt: string }
export type ToolOutcome = { ok: true; result: unknown } | { ok: false; error: { code: ToolErrorCode; message: string } };

export function memoryKey(scope: MemoryScope, projectId: string | null): string {
  if (scope === 'global') return 'global';
  if (!projectId) throw new Error('memoryKey: projectId is required for project scope');
  return `project:${projectId}`;
}
export function sessionIndexEntry(s: Session): SessionIndexEntry {
  return {
    workerId: s.workerId, sessionId: s.id, title: s.title, preview: s.preview, status: s.status,
    projectId: s.projectId ?? null, cwd: s.cwd, createdAt: s.createdAt, lastActivityAt: s.lastActivityAt,
  };
}

// ---------- tool catalog (MCP + worker-native tools; one executor on SaaS) ----------
export type ToolName =
  | 'project_list' | 'project_get' | 'project_create' | 'project_update'
  | 'card_list' | 'card_create' | 'card_update' | 'card_move'
  | 'memory_get' | 'memory_update' | 'machine_list'
  | 'session_list' | 'session_history' | 'session_start' | 'session_tag';
/** Tools that need SaaS to read/write worker session data; unavailable while E2E is on. */
export const SESSION_CLASS_TOOLS: readonly ToolName[] = ['session_history', 'session_start', 'session_tag'];
export interface JsonObjectSchema {
  type: 'object'; properties: Record<string, JsonSchema>; required?: readonly string[]; additionalProperties?: false; description?: string;
}
export type JsonSchema =
  | JsonObjectSchema
  | { type: 'string' | 'number' | 'integer' | 'boolean'; enum?: readonly string[]; minimum?: number; maximum?: number; description?: string }
  | { type: readonly ['string', 'null']; description?: string };
export interface ToolDef { name: ToolName; description: string; parameters: JsonObjectSchema }

const str = (description?: string): JsonSchema => (description ? { type: 'string', description } : { type: 'string' });
const nullableStr = (description?: string): JsonSchema =>
  description ? { type: ['string', 'null'], description } : { type: ['string', 'null'] };
const obj = (properties: Record<string, JsonSchema>, required: readonly string[] = []): JsonObjectSchema =>
  ({ type: 'object', properties, required, additionalProperties: false });
const MEMORY_SCOPES: readonly MemoryScope[] = ['global', 'project'];
const PATH_DESC = '调用方机器上的项目绝对路径';

export const TOOL_CATALOG: readonly ToolDef[] = [
  { name: 'project_list', description: '列项目（含 paths、项目记忆前 200 字）', parameters: obj({}) },
  { name: 'project_get', description: '项目详情 + 项目记忆全文 + 各状态卡片计数', parameters: obj({ projectId: str() }, ['projectId']) },
  {
    name: 'project_create',
    description: '新建项目；path 记为调用方机器的路径（调用方机器为 null 时给 path → bad_request）',
    parameters: obj({ name: str(), description: str(), path: str(PATH_DESC) }, ['name']),
  },
  {
    name: 'project_update',
    description: '修改项目；path 只改调用方机器那一项（调用方机器为 null 时给 path → bad_request）',
    parameters: obj({ projectId: str(), name: str(), description: str(), path: str(PATH_DESC) }, ['projectId']),
  },
  {
    name: 'card_list',
    description: '列卡片（可按项目、状态、机器筛选）',
    parameters: obj({ projectId: str(), state: { type: 'string', enum: CARD_STATES }, workerId: str() }),
  },
  {
    name: 'card_create',
    description: '新建卡片，一律进收件箱',
    parameters: obj({ title: str(), body: str('需求描述（markdown）'), projectId: nullableStr() }, ['title']),
  },
  {
    name: 'card_update',
    description: '修改卡片标题/描述/项目，不改状态',
    parameters: obj({ cardId: str(), title: str(), body: str(), projectId: nullableStr() }, ['cardId']),
  },
  {
    name: 'card_move',
    description: '移动卡片到 inbox / queued / done；移到 queued 必须带 workerId（=派给该机器）；未给 order 时排到该列末尾',
    parameters: obj(
      { cardId: str(), state: { type: 'string', enum: CARD_MOVE_STATES }, workerId: str('移到 queued 时的执行机器'), order: { type: 'number' } },
      ['cardId', 'state'],
    ),
  },
  {
    name: 'memory_get',
    description: '读协作记忆（全局或项目）',
    parameters: obj({ scope: { type: 'string', enum: MEMORY_SCOPES }, projectId: nullableStr() }, ['scope']),
  },
  {
    name: 'memory_update',
    description: '写协作记忆；replace = 整体替换，append = 原内容末尾加换行后追加',
    parameters: obj(
      { scope: { type: 'string', enum: MEMORY_SCOPES }, projectId: nullableStr(), content: str(), mode: { type: 'string', enum: ['replace', 'append'] } },
      ['scope', 'content', 'mode'],
    ),
  },
  { name: 'machine_list', description: '机器 + 在线状态 + 各机器 running 状态的卡', parameters: obj({}) },
  {
    name: 'session_list',
    description: '跨机器会话索引（同 GET /api/sessions）；E2E 开关下都可用',
    parameters: obj({
      projectId: str(), workerId: str(), q: str('标题/预览不区分大小写子串匹配'), limit: { type: 'integer', minimum: 1, maximum: 500 },
    }),
  },
  {
    name: 'session_history',
    description: '读某台机器某个会话的历史消息（代理 messages.page），返回 {messages:[{role, ts, text}]}；E2E 开启时不可用',
    parameters: obj({ workerId: str(), sessionId: str(), limit: { type: 'integer', minimum: 1, maximum: PAGE_MAX } }, ['workerId', 'sessionId']),
  },
  {
    name: 'session_start',
    description: '在某台机器上开新会话（代理 sessions.create）；cwd 缺省 = 项目在该机器的路径，否则该机器缺省 cwd；返回 {sessionId}；E2E 开启时不可用',
    parameters: obj({ workerId: str(), prompt: str(), projectId: str(), cwd: str() }, ['workerId', 'prompt']),
  },
  {
    name: 'session_tag',
    description: '给会话打/清项目标签（代理 sessions.update；projectId 为 null 清除）；E2E 开启时不可用',
    parameters: obj({ workerId: str(), sessionId: str(), projectId: nullableStr() }, ['workerId', 'sessionId', 'projectId']),
  },
];

function checkValue(key: string, schema: JsonSchema, v: unknown): string | null {
  if (Array.isArray(schema.type)) {
    return v === null || typeof v === 'string' ? null : `argument ${key} must be string or null`;
  }
  const s = schema as Extract<JsonSchema, { type: 'string' | 'number' | 'integer' | 'boolean' }>;
  const ok =
    s.type === 'integer' ? Number.isInteger(v)
      : s.type === 'number' ? typeof v === 'number' && Number.isFinite(v)
        : typeof v === s.type;
  if (!ok) return `argument ${key} must be ${s.type}`;
  if (s.enum && !s.enum.includes(v as string)) return `argument ${key} must be one of ${s.enum.join('|')}`;
  if (typeof v === 'number' && ((s.minimum !== undefined && v < s.minimum) || (s.maximum !== undefined && v > s.maximum))) {
    return `argument ${key} out of range`;
  }
  return null;
}
function checkObject(schema: JsonObjectSchema, args: Record<string, unknown>): string | null {
  for (const k of schema.required ?? []) if (args[k] === undefined) return `missing required argument: ${k}`;
  for (const [k, v] of Object.entries(args)) {
    const sub = Object.hasOwn(schema.properties, k) ? schema.properties[k] : undefined;
    if (!sub) {
      if (schema.additionalProperties === false) return `unknown argument: ${k}`;
      continue;
    }
    if (v === undefined) continue;
    const err = checkValue(k, sub, v);
    if (err) return err;
  }
  return null;
}
/** Validates tool arguments against TOOL_CATALOG's JSON Schema. null = valid, else a message. */
export function validateToolArgs(name: string, args: unknown): string | null {
  const def = TOOL_CATALOG.find((t) => t.name === name);
  if (!def) return `unknown tool: ${name}`;
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return 'arguments must be an object';
  return checkObject(def.parameters, args as Record<string, unknown>);
}

// ---------- errors ----------
export type ErrorCode = 'bad_request' | 'unauthorized' | 'not_found' | 'conflict' | 'too_large' | 'internal';
export interface RpcError { code: ErrorCode; message: string }

// ---------- RPC catalog ----------
export type Empty = Record<string, never>;
interface SessionRef { sessionId: string }
export interface BinaryResult { bytes: Uint8Array; mediaType: string; name?: string }

export interface RpcCatalog {
  'worker.info': { args: Empty; result: WorkerInfo };
  'sessions.list': { args: { archived?: boolean; kinds?: SessionKind[] }; result: { sessions: Session[] } };
  'sessions.get': { args: SessionRef; result: { session: Session } };
  'sessions.create': {
    args: {
      text: string; clientMsgId: string; cwd?: string; title?: string; model?: string; thinking?: ThinkingLevel; attachments?: Attachment[];
      projectId?: string;
    };
    result: { session: Session };
  };
  'sessions.update': {
    args: SessionRef & {
      title?: string; pinned?: boolean; starred?: boolean; archived?: boolean; model?: string; thinking?: ThinkingLevel;
      projectId?: string | null;
    };
    result: { session: Session };
  };
  'sessions.interrupt': { args: SessionRef; result: Empty };
  'sessions.rewind': { args: SessionRef & { messageId: string }; result: { undoneText: string } };
  'sessions.fork': { args: SessionRef & { messageId?: string }; result: { session: Session } };
  'messages.page': { args: SessionRef & { before?: string; limit?: number }; result: { messages: Message[]; hasMore: boolean } };
  'messages.send': {
    args: SessionRef & { text: string; clientMsgId: string; attachments?: Attachment[]; delivery?: QueueDelivery };
    result: { queued: boolean };
  };
  /** Cancel a queued message (`id` = its clientMsgId); no longer queued (already delivered) → not_found. */
  'messages.queue.remove': { args: SessionRef & { id: string }; result: Empty };
  /** Edit a queued message's text and/or switch followUp ↔ steer (a switched item moves to the end of its new queue). */
  'messages.queue.update': { args: SessionRef & { id: string; text?: string; delivery?: QueueDelivery }; result: Empty };
  'prompts.answer': { args: SessionRef & { promptId: string; answers: Record<string, string>; note?: string }; result: Empty };
  'tasks.stop': { args: SessionRef & { taskId: string }; result: Empty };
  'files.list': { args: SessionRef & { path?: string }; result: FileListing };
  'files.read': { args: SessionRef & { path: string }; result: BinaryResult };
  /** Machine-level directory picker: sub-directories only of an absolute path (or `~`, `~/x`); default = defaultCwd. */
  'dirs.list': { args: { path?: string; showHidden?: boolean }; result: FileListing };
  'blobs.get': { args: { hash: string }; result: BinaryResult };
  'memory.get': { args: Empty; result: { files: MemoryFile[] } };
  'memory.put': { args: { scope: MemoryScope; content: string }; result: { file: MemoryFile } };
}
export type RpcOp = keyof RpcCatalog;
export type RpcArgs<O extends RpcOp> = RpcCatalog[O]['args'];
export type RpcResult<O extends RpcOp> = RpcCatalog[O]['result'];
export const BINARY_OPS = ['files.read', 'blobs.get'] as const satisfies readonly RpcOp[];
export type BinaryOp = (typeof BINARY_OPS)[number];
// Compile-time guard: BINARY_OPS must list exactly the ops whose result is a BinaryResult.
type OpsWithBinaryResult = { [O in RpcOp]: RpcResult<O> extends BinaryResult ? O : never }[RpcOp];
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type AssertTrue<T extends true> = T;
export type __BinaryOpsMatchCatalog = AssertTrue<Equals<BinaryOp, OpsWithBinaryResult>>;
export function isBinaryOp(op: string): op is BinaryOp {
  return (BINARY_OPS as readonly string[]).includes(op);
}

// ---------- watch streams ----------
export type SessionEvent =
  | { type: 'snapshot'; cursor: string; session: Session; messages: Message[]; hasMore: boolean; prompts: Prompt[]; tasks: BackgroundTask[]; queue: QueueItem[] }
  | { type: 'message.upsert'; cursor: string; message: Message; replaces?: string }
  | { type: 'message.delta'; cursor: string; messageId: string; index: number; kind: 'text' | 'thinking'; text: string }
  | { type: 'messages.removed'; cursor: string; ids: string[] }
  | { type: 'session.updated'; cursor: string; session: Session }
  | { type: 'prompt.opened'; cursor: string; prompt: Prompt }
  | { type: 'prompt.closed'; cursor: string; promptId: string; reason: 'answered' | 'cancelled' | 'timeout' }
  | { type: 'tasks'; cursor: string; tasks: BackgroundTask[] }
  | { type: 'queue'; cursor: string; items: QueueItem[] }
  | { type: 'tool.progress'; cursor: string; toolCallId: string; text: string };

export type MachineEvent =
  | { type: 'snapshot'; worker: WorkerInfo; sessions: Session[] }
  | { type: 'session.updated'; session: Session }
  | { type: 'session.removed'; sessionId: string };

export interface WatchCatalog {
  'session.watch': { args: { sessionId: string; cursor?: string }; event: SessionEvent };
  'machine.watch': { args: Empty; event: MachineEvent };
}
export type WatchOp = keyof WatchCatalog;
export type WatchArgs<W extends WatchOp> = WatchCatalog[W]['args'];
export type WatchEvent<W extends WatchOp> = WatchCatalog[W]['event'];

// ---------- E2E plaintext frame headers ----------
type OpArgs<O extends RpcOp | WatchOp> = O extends RpcOp ? RpcArgs<O> : O extends WatchOp ? WatchArgs<O> : never;
/** Discriminated by `op`: `args` is the args type of that RPC/watch op. */
export type RequestHeader = { [O in RpcOp | WatchOp]: { v: 3; rid: string; ts: number; op: O; args: OpArgs<O> } }[RpcOp | WatchOp];
export type ResponseHeader =
  | { ok: true; result?: unknown; mediaType?: string; name?: string }
  | { ok: false; error: RpcError };

// ---------- SaaS control plane ----------
export interface User { id: string; email: string }
export interface Client { clientPub: string; label: string; createdAt: string }
export interface Machine { workerId: string; label: string; workerPub: string; online: boolean; lastSeenAt: string | null; version: string }
export interface SaasConfig { googleEnabled: boolean; devLogin: boolean; publicUrl: string }
/** Login allowlist (stored on SaaS; empty = disabled / open mode). Unrelated to the OAuth redirect allowlist. */
export type AllowlistRole = 'admin' | 'member';
export interface AllowlistEntry { email: string; role: AllowlistRole; addedBy: string; createdAt: string }
/** `GET /api/me`. Open mode: `role: null, allowlistEnabled: false`. */
export interface MeResult { user: User; role: AllowlistRole | null; allowlistEnabled: boolean }
export type SaasEvent =
  | { type: 'machines'; machines: Machine[] }
  | { type: 'machine.updated'; machine: Machine }
  | { type: 'machine.removed'; workerId: string }
  | { type: 'project.updated'; project: Project } | { type: 'project.removed'; projectId: string }
  | { type: 'card.updated'; card: Card }          | { type: 'card.removed'; cardId: string }
  | { type: 'memory.updated'; memory: MemoryDoc }
  | { type: 'session.indexed'; workerId: string; full: boolean; sessions: SessionIndexEntry[]; removed: string[] }
  | { type: 'settings.updated'; settings: AccountSettings };
export interface SaasErrorBody { error: { code: string; message: string } }

// ---------- worker <-> SaaS tunnel frames (JSON text frames) ----------
// payload = b64url ciphertext, or b64url plaintext frame when `plain: true` (E2E off).
export type WorkerToSaas =
  | { t: 'hello'; version: string; label: string; claimTokenHash?: string }
  | { t: 'rpc.res'; id: string; payload: string; plain?: true }
  | { t: 'rpc.err'; id: string; status: 400 | 401; code: 'bad_request' | 'unauthorized'; message: string }
  | { t: 'watch.data'; id: string; payload: string; plain?: true }
  | { t: 'watch.end'; id: string; code?: string }
  | { t: 'index'; full: boolean; sessions: SessionIndexEntry[]; removed: string[] }
  | { t: 'card.state'; cardId: string; state: 'running' | 'review'; sessionId?: string; error?: string }
  | { t: 'tool'; id: string; name: ToolName; args: Record<string, unknown>; sessionId?: string }
  | { t: 'ping' }
  | { t: 'pong' };
export type SaasToWorker =
  | { t: 'authz'; claimed: boolean; userId?: string; clients: ClientAuthz[]; e2e: boolean; autoCompact?: AutoCompactSettings }
  | { t: 'rpc'; id: string; clientPub: string; payload: string; plain?: true }
  | { t: 'watch'; id: string; clientPub: string; payload: string; plain?: true }
  | { t: 'watch.cancel'; id: string }
  | { t: 'tool.res'; id: string; result?: unknown; error?: { code: ToolErrorCode; message: string } }
  | { t: 'cards'; cards: Card[] }
  | { t: 'projects.changed' }
  | { t: 'ping' }
  | { t: 'pong' };
export interface WorkerRegisterRequest { workerId: string; workerPub: string; secretHash: string; installCode?: string }
export interface WorkerRegisterResponse { platformPub: string }
