import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FILE_READ_MAX_BYTES, SEND_FILE_TOOL } from '@nopear/protocol';
import { BlobStore } from './blobs';
import { createSendFileTool, formatSize, mediaTypeFor } from './send-file';

type Result = { content: { type: string; text: string }[]; details: { nopearFile?: Record<string, unknown> } };
type Exec = (id: string, args: unknown) => Promise<Result>;
const setup = () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sendfile-'));
  const blobs = new BlobStore(join(cwd, '.blobs'));
  const tool = createSendFileTool({ cwd, blobs });
  return { cwd, blobs, tool, exec: (args: unknown) => (tool as unknown as { execute: Exec }).execute('t1', args) };
};

test('send_file stores the bytes in the BlobStore and returns details.nopearFile', async () => {
  const { cwd, blobs, tool, exec } = setup();
  assert.equal(tool.name, SEND_FILE_TOOL);
  mkdirSync(join(cwd, 'out'));
  writeFileSync(join(cwd, 'out', 'report.html'), '<h1>hi</h1>');
  const r = await exec({ path: 'out/report.html', title: '周报', note: '本周进展' });
  const f = r.details.nopearFile!;
  assert.deepEqual({ ...f, blob: undefined }, { name: 'report.html', mediaType: 'text/html', size: 11, blob: undefined, title: '周报', note: '本周进展' });
  assert.match(String(f.blob), /^[0-9a-f]{64}$/);
  const got = await blobs.get(String(f.blob));
  assert.equal(Buffer.from(got!.bytes).toString(), '<h1>hi</h1>');
  assert.equal(got!.mediaType, 'text/html');
  assert.equal(r.content[0]!.text, '已发送文件 report.html（11 B）');
  // absolute path, no title/note → keys absent
  writeFileSync(join(cwd, 'clip.mp4'), 'vid');
  const r2 = await exec({ path: join(cwd, 'clip.mp4') });
  assert.deepEqual(Object.keys(r2.details.nopearFile!).sort(), ['blob', 'mediaType', 'name', 'size']);
  assert.equal(r2.details.nopearFile!.mediaType, 'video/mp4');
});

test('send_file errors: missing, directory, too large', async () => {
  const { cwd, exec } = setup();
  await assert.rejects(exec({ path: 'nope.txt' }), /文件不存在|not found/);
  mkdirSync(join(cwd, 'dir'));
  await assert.rejects(exec({ path: 'dir' }), /不是普通文件|not a regular file/);
  const big = join(cwd, 'big.bin');
  writeFileSync(big, '');
  truncateSync(big, FILE_READ_MAX_BYTES + 1); // sparse
  await assert.rejects(exec({ path: big }), /100MB/);
  await assert.rejects(exec({ path: '' }), /path/);
});

test('mediaTypeFor covers common deliverables; formatSize', () => {
  const cases: Record<string, string> = {
    'a.mp4': 'video/mp4', 'a.webm': 'video/webm', 'a.MOV': 'video/quicktime', 'a.mp3': 'audio/mpeg', 'a.wav': 'audio/wav', 'a.m4a': 'audio/mp4',
    'a.png': 'image/png', 'a.jpg': 'image/jpeg', 'a.jpeg': 'image/jpeg', 'a.gif': 'image/gif', 'a.webp': 'image/webp', 'a.svg': 'image/svg+xml',
    'a.html': 'text/html', 'a.htm': 'text/html', 'a.pdf': 'application/pdf', 'a.md': 'text/markdown', 'a.txt': 'text/plain',
    'a.json': 'application/json', 'a.csv': 'text/csv', 'a.log': 'text/plain', 'a.ts': 'text/plain', 'a.py': 'text/plain', 'a.go': 'text/plain',
    'a.zip': 'application/zip', 'a.bin': 'application/octet-stream', 'Makefile': 'application/octet-stream',
  };
  for (const [n, t] of Object.entries(cases)) assert.equal(mediaTypeFor(n), t, n);
  assert.equal(formatSize(11), '11 B');
  assert.equal(formatSize(2048), '2.0 KB');
  assert.equal(formatSize(5 * 1024 * 1024), '5.0 MB');
});
