// pi SessionEntry → protocol Message.
import { PREVIEW_MAX_CHARS, VISION_MEDIA_TYPES, type Block, type FileBlock, type Message, type MessageNotice } from '@nopear/protocol';
import type { BlobStore } from './blobs';

type Content = { type: string; text?: string; thinking?: string; data?: string; mimeType?: string; id?: string; name?: string; arguments?: unknown };
interface Entry { type: string; id: string; timestamp?: string; message?: Record<string, unknown>; [k: string]: unknown }

const iso = (entry: Entry, fallback?: unknown): string => {
  if (typeof entry.timestamp === 'string') return entry.timestamp;
  if (typeof fallback === 'number') return new Date(fallback).toISOString();
  return new Date().toISOString();
};

async function contentBlocks(content: unknown, blobs: BlobStore): Promise<Block[]> {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out: Block[] = [];
  for (const c of content as Content[]) {
    if (c.type === 'text') out.push({ type: 'text', text: c.text ?? '' });
    else if (c.type === 'thinking') out.push({ type: 'thinking', text: c.thinking ?? '' });
    else if (c.type === 'toolCall') out.push({ type: 'tool_call', id: c.id ?? '', name: c.name ?? '', input: c.arguments ?? {} });
    else if (c.type === 'image' && typeof c.data === 'string') {
      // Only vision types are reported as images; anything else (svg, heic, missing) is opaque bytes.
      const mediaType = c.mimeType && (VISION_MEDIA_TYPES as readonly string[]).includes(c.mimeType) ? c.mimeType : 'application/octet-stream';
      out.push({ type: 'image', mediaType, blob: await blobs.put(Buffer.from(c.data, 'base64'), mediaType) });
    }
  }
  return out;
}

/** Map an assistant AgentMessage's content synchronously (no images in assistant content) — used for live upserts. */
export function assistantBlocks(content: unknown): Block[] {
  if (!Array.isArray(content)) return [];
  const out: Block[] = [];
  for (const c of content as Content[]) {
    if (c.type === 'text') out.push({ type: 'text', text: c.text ?? '' });
    else if (c.type === 'thinking') out.push({ type: 'thinking', text: c.thinking ?? '' });
    else if (c.type === 'toolCall') out.push({ type: 'tool_call', id: c.id ?? '', name: c.name ?? '', input: c.arguments ?? {} });
  }
  return out;
}

/** send_file's `details.nopearFile` → file block; anything malformed is ignored. Sessions recorded before the rename
 *  carry the same record under `details.fleetFile`, so both keys are read. */
function fileBlockOf(details: unknown): FileBlock | null {
  const d = details as { nopearFile?: Record<string, unknown>; fleetFile?: Record<string, unknown> } | undefined;
  const f = d?.nopearFile ?? d?.fleetFile;
  if (!f || typeof f !== 'object') return null;
  const { name, mediaType, size, blob, title, note } = f;
  if (typeof name !== 'string' || typeof mediaType !== 'string' || typeof size !== 'number' || typeof blob !== 'string' || !/^[0-9a-f]{64}$/.test(blob)) return null;
  const b: FileBlock = { type: 'file', name, mediaType, size, blob };
  if (typeof title === 'string' && title) b.title = title;
  if (typeof note === 'string' && note) b.note = note;
  return b;
}

const textOf = (content: unknown): string =>
  typeof content === 'string' ? content
    : Array.isArray(content) ? (content as Content[]).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n') : '';

/** pi-subagents custom messages shown as notices even when display=false; compaction-resume stays hidden. */
const isSubagentNotice = (customType: unknown): boolean =>
  typeof customType === 'string' && customType.startsWith('subagent') && customType !== 'subagent-compaction-resume';

/** Derive the notice marker from the notification's first line (formats of pi-subagents notify / control notices). */
export function subagentNotice(text: string): MessageNotice {
  const first = (text.split('\n').find((l) => l.trim()) ?? '').trim();
  const title = first.replace(/\*\*/g, '');
  let m = /^(?:Background task|Detached foreground task) (completed|failed|paused|stopped): \*\*(.+?)\*\*/.exec(first);
  if (m) return { kind: 'subagent', title, status: m[1] as MessageNotice['status'], agent: m[2]! };
  m = /^Background tasks completed \(\d+\): (.+)$/.exec(first);
  if (m) return { kind: 'subagent', title, status: 'completed', agent: m[1]!.replace(/\*\*/g, '') };
  m = /^Subagent (failed|needs attention|active but long-running): (.+)$/.exec(first);
  if (m) return { kind: 'subagent', title, status: m[1] === 'failed' ? 'failed' : 'attention', agent: m[2]!.trim() };
  return { kind: 'subagent', title };
}

export async function entryToMessage(sessionId: string, entry: unknown, blobs: BlobStore, clientMsgIds: Map<string, string>): Promise<Message | null> {
  const e = entry as Entry;
  if (!e || typeof e !== 'object' || typeof e.id !== 'string') return null;
  const base = { id: e.id, sessionId };
  if (e.type === 'message' && e.message) {
    const m = e.message;
    const ts = iso(e, m.timestamp);
    if (m.role === 'user') {
      const msg: Message = { ...base, role: 'user', blocks: await contentBlocks(m.content, blobs), ts, status: 'complete' };
      const cid = clientMsgIds.get(e.id);
      if (cid) msg.clientMsgId = cid;
      return msg;
    }
    if (m.role === 'assistant') {
      const stop = m.stopReason as string | undefined;
      const msg: Message = { ...base, role: 'assistant', blocks: await contentBlocks(m.content, blobs), ts,
        status: stop === 'error' || stop === 'aborted' ? 'error' : 'complete' };
      if (msg.status === 'error') msg.errorText = (m.errorMessage as string | undefined) || stop;
      if (typeof m.provider === 'string' && typeof m.model === 'string') msg.model = `${m.provider}/${m.model}`;
      const u = m.usage as { input?: number; output?: number; cost?: { total?: number } } | undefined;
      if (u) msg.usage = { input: u.input ?? 0, output: u.output ?? 0, costUsd: u.cost?.total ?? 0 };
      return msg;
    }
    if (m.role === 'toolResult') {
      // Images a tool returned (e.g. `read` on a png) follow the tool_result block as image blocks; a file sent with
      // send_file follows as a file block.
      const images = Array.isArray(m.content) ? (await contentBlocks((m.content as Content[]).filter((c) => c.type === 'image'), blobs)) : [];
      const file = m.isError ? null : fileBlockOf(m.details);
      return { ...base, role: 'tool', ts, status: 'complete', blocks: [{ type: 'tool_result', toolCallId: String(m.toolCallId ?? ''),
        toolName: String(m.toolName ?? ''), text: textOf(m.content), isError: Boolean(m.isError) }, ...images, ...(file ? [file] : [])] };
    }
    return null;
  }
  if (e.type === 'custom_message') {
    const notice = isSubagentNotice(e.customType);
    if (!e.display && !notice) return null;
    const text = textOf(e.content);
    const msg: Message = { ...base, role: 'system', ts: iso(e), status: 'complete', blocks: [{ type: 'text', text }] };
    if (notice) msg.notice = subagentNotice(text);
    return msg;
  }
  if (e.type === 'compaction') {
    return { ...base, role: 'system', ts: iso(e), status: 'complete', blocks: [{ type: 'text', text: `（上下文已压缩）\n${String(e.summary ?? '')}` }] };
  }
  if (e.type === 'branch_summary') {
    return { ...base, role: 'system', ts: iso(e), status: 'complete', blocks: [{ type: 'text', text: `（分支摘要）\n${String(e.summary ?? '')}` }] };
  }
  return null;
}

export function previewOf(m: Message): string {
  const text = m.blocks.filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text').map((b) => b.text).join(' ');
  return text.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_MAX_CHARS);
}
