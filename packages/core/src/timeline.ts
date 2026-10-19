// Pure reducer for one session's timeline.
import type { Attachment, BackgroundTask, Block, BtwAnswer, FileBlock, Message, Prompt, QueueItem, Session, SessionEvent } from '@nopear/protocol';

export interface PendingSend {
  clientMsgId: string;
  text: string;
  status: 'sending' | 'sent' | 'failed';
  error?: string;
  attachments?: Attachment[];
}
export interface TimelineState {
  session?: Session;
  messages: Message[];
  hasMore: boolean;
  cursor?: string;
  prompts: Prompt[];
  tasks: BackgroundTask[];
  /** Messages queued by the worker while the session runs, in delivery order. */
  queue: QueueItem[];
  /** `/btw` side answers (newest last). Never part of the session, so not restored with it. */
  btw: BtwAnswer[];
  /** Ids the user closed: later events for them (an answer still streaming) are ignored. */
  btwHidden?: string[];
  progress: Record<string, string>;
  pending: Record<string, PendingSend>;
}

const LOCAL = 'local:';
const localId = (clientMsgId: string) => `${LOCAL}${clientMsgId}`;
const isLocal = (m: Message) => m.id.startsWith(LOCAL);
const textOf = (m: Message) => m.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');

export function emptyTimeline(): TimelineState {
  return { messages: [], hasMore: true, prompts: [], tasks: [], queue: [], btw: [], progress: {}, pending: {} };
}

function withoutPending(s: TimelineState, ids: string[]): TimelineState {
  if (ids.length === 0) return s;
  const pending = { ...s.pending };
  for (const id of ids) delete pending[id];
  const drop = new Set(ids.map(localId));
  return { ...s, pending, messages: s.messages.filter((m) => !drop.has(m.id)) };
}

function upsert(s: TimelineState, message: Message, replaces?: string): TimelineState {
  let msgs = s.messages;
  let next = s;
  if (message.clientMsgId && (s.pending[message.clientMsgId] || msgs.some((m) => m.id === localId(message.clientMsgId!)))) {
    // the optimistic bubble is replaced in place by the confirmed message
    replaces = replaces ?? localId(message.clientMsgId);
    const pending = { ...s.pending };
    delete pending[message.clientMsgId];
    next = { ...s, pending };
  }
  const existing = msgs.findIndex((m) => m.id === message.id);
  const repl = replaces ? msgs.findIndex((m) => m.id === replaces) : -1;
  msgs = [...msgs];
  if (repl >= 0) {
    msgs[repl] = message;
    if (existing >= 0 && existing !== repl) msgs.splice(existing, 1);
  } else if (existing >= 0) {
    msgs[existing] = message;
  } else {
    // insert before trailing optimistic bubbles so confirmed history stays ahead of unsent ones
    let at = msgs.length;
    while (at > 0 && isLocal(msgs[at - 1]!) && message.role !== 'user') at--;
    msgs.splice(at, 0, message);
  }
  return { ...next, messages: msgs };
}

function delta(s: TimelineState, messageId: string, index: number, kind: 'text' | 'thinking', text: string): TimelineState {
  const i = s.messages.findIndex((m) => m.id === messageId);
  const base: Message = i >= 0
    ? s.messages[i]!
    : { id: messageId, sessionId: s.session?.id ?? '', role: 'assistant', blocks: [], ts: new Date().toISOString(), status: 'streaming' };
  const blocks: Block[] = [...base.blocks];
  const cur = blocks[index];
  if (cur && cur.type === kind) blocks[index] = { ...cur, text: cur.text + text };
  else {
    while (blocks.length < index) blocks.push({ type: 'text', text: '' });
    blocks[index] = { type: kind, text };
  }
  const message = { ...base, blocks };
  const msgs = [...s.messages];
  if (i >= 0) msgs[i] = message; else msgs.push(message);
  return { ...s, messages: msgs };
}

function snapshot(s: TimelineState, e: Extract<SessionEvent, { type: 'snapshot' }>): TimelineState {
  const locals = s.messages.filter(isLocal);
  const confirmed = s.messages.filter((m) => !isLocal(m));
  const first = e.messages[0];
  const at = first ? confirmed.findIndex((m) => m.id === first.id) : -1;
  const kept = at >= 0 ? confirmed.slice(0, at) : [];
  const ids = new Set(e.messages.map((m) => m.id));
  const messages = [...kept.filter((m) => !ids.has(m.id)), ...e.messages];
  // optimistic sends already reflected in the snapshot are dropped
  const done: string[] = [];
  for (const p of Object.values(s.pending)) {
    const hit = e.messages.some((m) => m.role === 'user' && (m.clientMsgId === p.clientMsgId || (p.status === 'sent' && textOf(m) === p.text)));
    if (hit) done.push(p.clientMsgId);
  }
  const next: TimelineState = {
    ...s,
    session: e.session,
    messages: [...messages, ...locals],
    hasMore: at > 0 ? s.hasMore : e.hasMore,
    prompts: e.prompts,
    tasks: e.tasks,
    progress: {},
  };
  return withQueue(withoutPending(next, done), Array.isArray(e.queue) ? e.queue : []);
}

/** Replace the queue. An id that left it was delivered (its user message follows as an upsert) or cancelled: its
 *  optimistic bubble is dropped either way. */
function withQueue(s: TimelineState, queue: QueueItem[]): TimelineState {
  const now = new Set(queue.map((q) => q.id));
  const left = (s.queue ?? []).map((q) => q.id).filter((id) => !now.has(id));
  return { ...withoutPending(s, left), queue };
}

export function upsertBtw(s: TimelineState, b: BtwAnswer): TimelineState {
  if (s.btwHidden?.includes(b.id)) return s;
  const cur = s.btw ?? [];
  return { ...s, btw: cur.some((x) => x.id === b.id) ? cur.map((x) => (x.id === b.id ? b : x)) : [...cur, b] };
}
export function dismissBtw(s: TimelineState, id: string): TimelineState {
  return { ...s, btw: (s.btw ?? []).filter((x) => x.id !== id), btwHidden: [...(s.btwHidden ?? []).slice(-50), id] };
}

export function applySessionEvent(s: TimelineState, e: SessionEvent): TimelineState {
  let n: TimelineState;
  switch (e.type) {
    case 'snapshot': n = snapshot(s, e); break;
    case 'message.upsert': n = upsert(s, e.message, e.replaces); break;
    case 'message.delta': n = delta(s, e.messageId, e.index, e.kind, e.text); break;
    case 'messages.removed': {
      const drop = new Set(e.ids);
      n = { ...s, messages: s.messages.filter((m) => !drop.has(m.id)) };
      break;
    }
    case 'session.updated': n = { ...s, session: e.session }; break;
    case 'prompt.opened': n = { ...s, prompts: [...s.prompts.filter((p) => p.id !== e.prompt.id), e.prompt] }; break;
    case 'prompt.closed': n = { ...s, prompts: s.prompts.filter((p) => p.id !== e.promptId) }; break;
    case 'tasks': n = { ...s, tasks: e.tasks }; break;
    case 'queue': n = withQueue(s, e.items); break;
    case 'tool.progress': n = { ...s, progress: { ...s.progress, [e.toolCallId]: e.text } }; break;
    case 'btw': n = upsertBtw(s, e.btw); break;
    default: n = s;
  }
  return { ...n, cursor: e.cursor };
}

export function addOptimistic(s: TimelineState, p: { clientMsgId: string; text: string; ts: string; attachments?: Attachment[] }): TimelineState {
  const blocks: Block[] = [];
  if (p.text) blocks.push({ type: 'text', text: p.text });
  for (const a of p.attachments ?? []) blocks.push({ type: 'text', text: `📎 ${a.name}` });
  const message: Message = { id: localId(p.clientMsgId), sessionId: s.session?.id ?? '', role: 'user', blocks, ts: p.ts, status: 'streaming', clientMsgId: p.clientMsgId };
  const pend: PendingSend = { clientMsgId: p.clientMsgId, text: p.text, status: 'sending' };
  if (p.attachments) pend.attachments = p.attachments;
  return {
    ...s,
    messages: [...s.messages.filter((m) => m.id !== message.id), message],
    pending: { ...s.pending, [p.clientMsgId]: pend },
  };
}

function setPending(s: TimelineState, id: string, patch: Partial<PendingSend>): TimelineState {
  const p = s.pending[id];
  if (!p) return s;
  const next: PendingSend = { ...p, ...patch };
  if (patch.status !== 'failed') delete next.error;
  return { ...s, pending: { ...s.pending, [id]: next } };
}
export function markSendFailed(s: TimelineState, clientMsgId: string, error: string): TimelineState {
  return setPending(s, clientMsgId, { status: 'failed', error });
}
export function markSent(s: TimelineState, clientMsgId: string): TimelineState {
  return setPending(s, clientMsgId, { status: 'sent' });
}
export function markSending(s: TimelineState, clientMsgId: string): TimelineState {
  return setPending(s, clientMsgId, { status: 'sending' });
}
export function dropPending(s: TimelineState, clientMsgId: string): TimelineState {
  return withoutPending(s, [clientMsgId]);
}

export function prependPage(s: TimelineState, page: Message[], hasMore: boolean): TimelineState {
  const have = new Set(s.messages.map((m) => m.id));
  return { ...s, messages: [...page.filter((m) => !have.has(m.id)), ...s.messages], hasMore };
}

export interface ViewItem {
  message: Message;
  results: Record<string, Extract<Block, { type: 'tool_result' }>>;
  /** Images a tool returned (image blocks of its tool message), keyed by toolCallId. */
  resultImages: Record<string, Extract<Block, { type: 'image' }>[]>;
  /** Files a tool delivered (`send_file` file blocks of its tool message), keyed by toolCallId. */
  resultFiles: Record<string, FileBlock[]>;
  progress: Record<string, string>;
  pending?: PendingSend;
}

/** Drop a queue item locally (after a successful messages.queue.remove) together with its optimistic bubble. */
export function dropQueued(s: TimelineState, id: string): TimelineState {
  return withQueue(s, (s.queue ?? []).filter((q) => q.id !== id));
}

export function selectMessages(s: TimelineState): ViewItem[] {
  const owner = new Map<string, ViewItem>(); // toolCallId -> item holding the tool_call
  const items: ViewItem[] = [];
  // A queued send renders as a queue card, not as an optimistic user bubble.
  const queued = new Set((s.queue ?? []).map((q) => q.id));
  for (const m of s.messages) {
    if (queued.size && m.clientMsgId && queued.has(m.clientMsgId) && m.id.startsWith(LOCAL)) continue;
    if (m.role === 'tool') {
      const results = m.blocks.filter((b): b is Extract<Block, { type: 'tool_result' }> => b.type === 'tool_result');
      const targets = results.map((r) => owner.get(r.toolCallId));
      if (results.length > 0 && targets.every(Boolean)) {
        results.forEach((r, i) => { targets[i]!.results[r.toolCallId] = r; });
        const images = m.blocks.filter((b): b is Extract<Block, { type: 'image' }> => b.type === 'image');
        if (images.length) targets[0]!.resultImages[results[0]!.toolCallId] = images;
        const files = m.blocks.filter((b): b is FileBlock => b.type === 'file');
        if (files.length) targets[0]!.resultFiles[results[0]!.toolCallId] = files;
        continue;
      }
    }
    const item: ViewItem = { message: m, results: {}, resultImages: {}, resultFiles: {}, progress: {} };
    for (const b of m.blocks) {
      if (b.type === 'tool_call') {
        owner.set(b.id, item);
        const p = s.progress[b.id];
        if (p !== undefined) item.progress[b.id] = p;
      }
    }
    if (m.clientMsgId && s.pending[m.clientMsgId] && m.id.startsWith(LOCAL)) item.pending = s.pending[m.clientMsgId];
    items.push(item);
  }
  return items;
}
