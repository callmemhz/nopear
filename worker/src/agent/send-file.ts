// send_file: worker-native pi tool that delivers a file to the user. The bytes go into the BlobStore and
// the tool result's `details.nopearFile` becomes a `file` block in the timeline (mapping.ts), rendered as a preview card.
import { readFile, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { FILE_READ_MAX_BYTES, SEND_FILE_TOOL, type FileBlock } from '@nopear/protocol';
import type { BlobStore } from './blobs';

export type NoPearFile = Omit<FileBlock, 'type'>;

const CODE_EXTS = [
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs',
  'php', 'sh', 'bash', 'zsh', 'sql', 'yaml', 'yml', 'toml', 'ini', 'xml', 'css', 'scss', 'vue', 'svelte', 'lua', 'r', 'diff', 'patch',
];
const TYPES: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  html: 'text/html', htm: 'text/html', pdf: 'application/pdf', md: 'text/markdown', markdown: 'text/markdown',
  txt: 'text/plain', log: 'text/plain', json: 'application/json', csv: 'text/csv',
  zip: 'application/zip', gz: 'application/gzip', tgz: 'application/gzip', tar: 'application/x-tar',
  ...Object.fromEntries(CODE_EXTS.map((e) => [e, 'text/plain'])),
};

/** Media type by file extension (case-insensitive); unknown → application/octet-stream. */
export function mediaTypeFor(name: string): string {
  return TYPES[extname(name).slice(1).toLowerCase()] ?? 'application/octet-stream';
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const Params = Type.Object({
  path: Type.String({ description: 'File to send: absolute, or relative to the session cwd' }),
  title: Type.Optional(Type.String({ description: 'Short title shown on the card (default: file name)' })),
  note: Type.Optional(Type.String({ description: 'One-line note for the user (what it is / how to use it)' })),
});

export function createSendFileTool(o: { cwd: string; blobs: BlobStore }): ToolDefinition {
  return defineTool({
    name: SEND_FILE_TOOL,
    label: 'Send file',
    description: '把文件发给用户，在对话里显示为可预览/下载的文件卡片。Send a file to the user as a previewable card '
      + '(video, audio, image, html page, pdf, markdown, text/code, archive; ≤100MB). Use it to deliver deliverables '
      + '(videos, html pages, reports, images, archives) instead of pasting large content into the reply.',
    parameters: Params,
    async execute(_toolCallId, params) {
      const p = params as { path: string; title?: string; note?: string };
      if (typeof p.path !== 'string' || !p.path.trim()) throw new Error('path is required');
      const abs = resolve(o.cwd, p.path);
      let st: Stats;
      try { st = await stat(abs); } catch { throw new Error(`文件不存在 (not found): ${abs}`); }
      if (!st.isFile()) throw new Error(`不是普通文件 (not a regular file): ${abs}`);
      if (st.size > FILE_READ_MAX_BYTES) {
        throw new Error(`文件过大 (${formatSize(st.size)})，超过 100MB 上限 (file exceeds the 100MB limit): ${abs}`);
      }
      const bytes = new Uint8Array(await readFile(abs));
      const name = basename(abs);
      const mediaType = mediaTypeFor(name);
      const blob = await o.blobs.put(bytes, mediaType);
      const nopearFile: NoPearFile = { name, mediaType, size: bytes.byteLength, blob };
      if (p.title) nopearFile.title = p.title;
      if (p.note) nopearFile.note = p.note;
      return { content: [{ type: 'text', text: `已发送文件 ${name}（${formatSize(bytes.byteLength)}）` }], details: { nopearFile } };
    },
  }) as unknown as ToolDefinition;
}
