import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { listDir, listDirs, readFileForDownload } from './files';
import { OpError } from './errors';

function makeWorkspace(): string {
  const parent = mkdtempSync(join(tmpdir(), 'nopear-files-'));
  const root = join(parent, 'workspace');
  mkdirSync(join(root, 'sub'), { recursive: true });
  writeFileSync(join(root, 'a.txt'), 'hello');
  writeFileSync(join(root, 'sub', 'b.bin'), Buffer.from([1, 2, 3]));
  return root;
}
const code = (c: string) => (e: unknown) => e instanceof OpError && e.code === c;

test('listDir: dirs first then files, sizes, ISO mtime', async () => {
  const root = makeWorkspace();
  const l = await listDir(root);
  assert.equal(l.path, root);
  assert.equal(l.truncated, false);
  assert.deepEqual(l.entries.map((e) => [e.name, e.type]), [['sub', 'dir'], ['a.txt', 'file']]);
  assert.equal(l.entries[1]!.size, 5);
  assert.equal(l.entries[0]!.size, 0);
  assert.ok(!Number.isNaN(Date.parse(l.entries[1]!.mtime)));
});

test('listDir: subdir path echoes resolved absolute dir', async () => {
  const root = makeWorkspace();
  const l = await listDir(root, 'sub');
  assert.equal(l.path, join(root, 'sub'));
  assert.deepEqual(l.entries.map((e) => e.name), ['b.bin']);
});

test('listDir: escaping allowed; missing → not_found; >500 truncated', async () => {
  const root = makeWorkspace();
  assert.ok((await listDir(root, '../')).entries.some((e) => e.name === 'workspace'));
  assert.ok((await listDir(root, '/')).entries.length > 0);
  await assert.rejects(listDir(root, 'nope'), code('not_found'));
  const big = join(root, 'big');
  mkdirSync(big);
  for (let i = 0; i < 510; i++) writeFileSync(join(big, `f${i}`), '');
  const l = await listDir(root, 'big');
  assert.equal(l.truncated, true);
  assert.equal(l.entries.length, 500);
});

test('readFileForDownload: bytes + basename + octet-stream; rejects dirs and missing', async () => {
  const root = makeWorkspace();
  const f = await readFileForDownload(root, 'sub/b.bin');
  assert.equal(f.name, 'b.bin');
  assert.equal(f.mediaType, 'application/octet-stream');
  assert.deepEqual([...f.bytes], [1, 2, 3]);
  assert.deepEqual([...(await readFileForDownload(root, join(root, 'a.txt'))).bytes], [...Buffer.from('hello')]);
  assert.deepEqual([...(await readFileForDownload(root, '../workspace/a.txt')).bytes], [...Buffer.from('hello')]);
  await assert.rejects(readFileForDownload(root, 'sub'), code('bad_request'));
  await assert.rejects(readFileForDownload(root, 'missing.txt'), code('not_found'));
});

test('listDirs: only sub-directories, sorted, hidden excluded unless showHidden; path echoed absolute', async () => {
  const root = makeWorkspace();
  mkdirSync(join(root, 'b-dir'));
  mkdirSync(join(root, '.hidden'));
  const l = await listDirs('/unused-default', root);
  assert.equal(l.path, root);
  assert.equal(l.truncated, false);
  assert.deepEqual(l.entries.map((e) => [e.name, e.type]), [['b-dir', 'dir'], ['sub', 'dir']]);
  const h = await listDirs('/unused-default', root, true);
  assert.deepEqual(h.entries.map((e) => e.name), ['.hidden', 'b-dir', 'sub']);
});

test('listDirs: default = defaultCwd; relative resolves against it; ~ expands to home', async () => {
  const root = makeWorkspace();
  assert.equal((await listDirs(root)).path, root);
  assert.equal((await listDirs(root, 'sub')).path, join(root, 'sub'));
  assert.equal((await listDirs(root, '~')).path, homedir());
  const parent = join(root, '..');
  assert.ok((await listDirs(root, parent)).entries.some((e) => e.name === 'workspace'));
});

test('listDirs: missing or a file → not_found; >500 dirs truncated', async () => {
  const root = makeWorkspace();
  await assert.rejects(listDirs(root, join(root, 'nope')), code('not_found'));
  await assert.rejects(listDirs(root, join(root, 'a.txt')), code('not_found'));
  const big = join(root, 'big');
  mkdirSync(big);
  for (let i = 0; i < 510; i++) mkdirSync(join(big, `d${i}`));
  const l = await listDirs(root, big);
  assert.equal(l.truncated, true);
  assert.equal(l.entries.length, 500);
});
