// Pure view-model for the message column: splits ViewItems into turns (user / system messages, or one assistant turn)
// and folds consecutive tool calls of an assistant turn into a single collapsible group.
// Files sent with send_file break the group and render as standalone cards.
import type { Block } from '@nopear/protocol';
import type { ViewItem } from './timeline';

type ToolResult = Extract<Block, { type: 'tool_result' }>;
type ImageBlock = Extract<Block, { type: 'image' }>;
type FileBlock = Extract<Block, { type: 'file' }>;

export interface ToolEntry {
  kind: 'tool';
  key: string;
  name: string;
  input?: unknown;
  result?: ToolResult;
  progress?: string;
  images?: ImageBlock[];
  /** The owning assistant message is still streaming. */
  streaming: boolean;
}
export interface ThinkingEntry { kind: 'thinking'; key: string; text: string; streaming: boolean }
export type GroupEntry = ToolEntry | ThinkingEntry;

export type Segment =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'thinking'; key: string; text: string; streaming: boolean }
  | { kind: 'image'; key: string; block: ImageBlock }
  /** A file the agent sent (send_file): always standalone, never folded into a tool group. */
  | { kind: 'file'; key: string; block: FileBlock }
  | { kind: 'tools'; key: string; entries: GroupEntry[] }
  | { kind: 'error'; key: string; text: string }
  | { kind: 'typing'; key: string };

export type Turn =
  | { kind: 'message'; key: string; item: ViewItem }
  | { kind: 'assistant'; key: string; segments: Segment[] };

export type ToolCategory = 'command' | 'read' | 'edit' | 'search' | 'subagent' | 'other';

export function toolCategory(name: string): ToolCategory {
  switch (name) {
    case 'bash': case 'powershell': return 'command';
    case 'read': return 'read';
    case 'write': case 'edit': return 'edit';
    case 'grep': case 'find': case 'ls': return 'search';
    case 'subagent': return 'subagent';
    default: return 'other';
  }
}

export type EntryState = 'ok' | 'error' | 'running' | 'pending';
/** Same rules as ToolCard; `live` (session running) turns a result-less call into running. */
export function entryState(e: ToolEntry, live = false): EntryState {
  if (e.result) return e.result.isError ? 'error' : 'ok';
  return e.progress !== undefined || e.streaming || live ? 'running' : 'pending';
}

const PHRASE: Record<ToolCategory, { verb: string; unit: string; noun: string }> = {
  command: { verb: '运行了', unit: '条', noun: '命令' },
  read: { verb: '读取了', unit: '个', noun: '文件' },
  edit: { verb: '修改了', unit: '个', noun: '文件' },
  search: { verb: '搜索了', unit: '次', noun: '' },
  subagent: { verb: '启动了', unit: '个', noun: '子任务' },
  other: { verb: '调用了', unit: '个', noun: '工具' },
};

export interface ToolSummary { text: string; running: boolean; failed: number; count: number }

/** 「运行了 4 条命令（1 条失败），读取了 1 个文件」 — categories in order of first appearance; thinking entries ignored. */
export function summarizeTools(entries: GroupEntry[], live = false): ToolSummary {
  const order: ToolCategory[] = [];
  const counts = new Map<ToolCategory, { n: number; failed: number }>();
  let running = false;
  let failed = 0;
  let count = 0;
  for (const e of entries) {
    if (e.kind !== 'tool') continue;
    const c = toolCategory(e.name);
    let k = counts.get(c);
    if (!k) { k = { n: 0, failed: 0 }; counts.set(c, k); order.push(c); }
    k.n++; count++;
    const st = entryState(e, live);
    if (st === 'error') { k.failed++; failed++; }
    if (st === 'running') running = true;
  }
  const text = order.map((c) => {
    const { n, failed: f } = counts.get(c)!;
    const p = PHRASE[c];
    return `${p.verb} ${n} ${p.unit}${p.noun}${f ? `（${f} ${p.unit}失败）` : ''}`;
  }).join('，');
  return { text, running, failed, count };
}

/** Group turns: user/system messages stand alone; everything else between them forms one assistant turn. */
export function buildTurns(items: ViewItem[]): Turn[] {
  const turns: Turn[] = [];
  let turn: Extract<Turn, { kind: 'assistant' }> | null = null;
  let group: Extract<Segment, { kind: 'tools' }> | null = null;
  let held: ThinkingEntry[] = []; // thinking seen after a tool call: folded into the group if another tool call follows

  const close = () => {
    if (turn) for (const t of held) turn.segments.push({ kind: 'thinking', key: t.key, text: t.text, streaming: t.streaming });
    held = [];
    group = null;
  };
  const push = (s: Segment) => { close(); turn!.segments.push(s); };
  const addTool = (e: ToolEntry) => {
    if (group) { group.entries.push(...held, e); held = []; return; }
    close();
    group = { kind: 'tools', key: e.key, entries: [e] };
    turn!.segments.push(group);
  };

  for (const it of items) {
    const m = it.message;
    if (m.role === 'user' || m.role === 'system') {
      close();
      turn = null;
      turns.push({ kind: 'message', key: m.id, item: it });
      continue;
    }
    if (!turn) { turn = { kind: 'assistant', key: m.id, segments: [] }; turns.push(turn); }
    const streaming = m.status === 'streaming';
    m.blocks.forEach((b, i) => {
      const key = `${m.id}:${i}`;
      switch (b.type) {
        case 'text':
          if (b.text.trim()) push({ kind: 'text', key, text: b.text });
          break;
        case 'thinking': {
          const th: ThinkingEntry = { kind: 'thinking', key, text: b.text, streaming: streaming && i === m.blocks.length - 1 };
          if (group) held.push(th);
          else turn!.segments.push({ kind: 'thinking', key, text: th.text, streaming: th.streaming });
          break;
        }
        case 'tool_call': {
          const e: ToolEntry = { kind: 'tool', key, name: b.name, input: b.input, streaming };
          const r = it.results[b.id]; if (r) e.result = r;
          const p = it.progress[b.id]; if (p !== undefined) e.progress = p;
          const im = it.resultImages[b.id]; if (im?.length) e.images = im;
          addTool(e);
          it.resultFiles[b.id]?.forEach((f, j) => push({ kind: 'file', key: `${key}:file${j}`, block: f }));
          break;
        }
        case 'tool_result':
          addTool({ kind: 'tool', key, name: b.toolName, result: b, streaming: false });
          break;
        case 'image':
          push({ kind: 'image', key, block: b });
          break;
        case 'file':
          push({ kind: 'file', key, block: b });
          break;
      }
    });
    if (m.status === 'error') push({ kind: 'error', key: `${m.id}:error`, text: m.errorText || '本轮出错' });
    else if (streaming && m.blocks.length === 0) push({ kind: 'typing', key: `${m.id}:typing` });
  }
  close();
  return turns;
}

/** Rebuilt entry lists compare equal when their parts are the same references (memo comparator for tool groups). */
export function sameEntries(a: GroupEntry[], b: GroupEntry[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i]!;
    if (x.kind !== y.kind || x.key !== y.key) return false;
    if (x.kind === 'thinking') return x.text === (y as ThinkingEntry).text && x.streaming === y.streaming;
    const t = y as ToolEntry;
    return x.name === t.name && x.input === t.input && x.result === t.result && x.progress === t.progress
      && x.streaming === t.streaming && sameList(x.images, t.images);
  });
}
function sameList<T>(a: T[] | undefined, b: T[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/** Segments rebuilt by buildTurns() compare equal when every segment holds the same parts (memo comparator for a turn). */
export function sameSegments(a: Segment[], b: Segment[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i]!;
    if (x.kind !== y.kind || x.key !== y.key) return false;
    switch (x.kind) {
      case 'text': case 'error': return x.text === (y as typeof x).text;
      case 'thinking': return x.text === (y as typeof x).text && x.streaming === (y as typeof x).streaming;
      case 'image': case 'file': return x.block === (y as typeof x).block;
      case 'tools': return sameEntries(x.entries, (y as typeof x).entries);
      case 'typing': return true;
    }
  });
}

/** Visual line estimate (hard newlines + wrapping at ~`wrap` chars) above which a user bubble starts collapsed. */
export function isLongText(text: string, maxLines = 12, wrap = 70): boolean {
  let lines = 0;
  for (const l of text.split('\n')) {
    lines += Math.max(1, Math.ceil(l.length / wrap));
    if (lines > maxLines) return true;
  }
  return false;
}
