import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MetaStore, type SessionMeta } from './meta-store';

function meta(id: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  const now = new Date().toISOString();
  return { id, kind: 'chat', title: 't-' + id, cwd: '/tmp', sessionFile: `/tmp/${id}.jsonl`, createdAt: now, lastActivityAt: now,
    preview: '', pinned: false, starred: false, archived: false, model: 'faux/echo', thinking: 'medium', ...extra };
}
const tmp = () => join(mkdtempSync(join(tmpdir(), 'meta-')), 'sub', 'sessions.json');

test('fresh store loads empty and creates parent dir', async () => {
  const s = new MetaStore(tmp());
  await s.load();
  assert.deepEqual(s.list(), []);
});

test('put/get/patch/delete persist across reload', async () => {
  const p = tmp();
  const s = new MetaStore(p);
  await s.load();
  await s.put(meta('a'));
  await s.put(meta('b', { leafId: null }));
  const patched = await s.patch('a', { title: 'renamed', pinned: true });
  assert.equal(patched?.title, 'renamed');
  assert.equal(await s.patch('missing', { title: 'x' }), undefined);
  await s.delete('b');
  const s2 = new MetaStore(p);
  await s2.load();
  assert.equal(s2.get('a')?.title, 'renamed');
  assert.equal(s2.get('a')?.pinned, true);
  assert.equal(s2.get('b'), undefined);
  assert.ok(JSON.parse(readFileSync(p, 'utf8')).sessions.a);
});

test('concurrent writes do not corrupt the file', async () => {
  const p = tmp();
  const s = new MetaStore(p);
  await s.load();
  await Promise.all(Array.from({ length: 30 }, (_, i) => s.put(meta('s' + i))));
  await Promise.all(Array.from({ length: 30 }, (_, i) => s.patch('s' + i, { preview: 'p' + i })));
  const s2 = new MetaStore(p);
  await s2.load();
  assert.equal(s2.list().length, 30);
  assert.equal(s2.get('s7')?.preview, 'p7');
});

test('load ignores kind≠chat entries', async () => {
  const p = tmp();
  mkdirSync(dirname(p), { recursive: true });
  const legacy = (id: string, kind: string) => ({ ...meta(id), kind });
  writeFileSync(p, JSON.stringify({ version: 1, sessions: { c: legacy('c', 'chat'), p: legacy('p', 'pm'), k: legacy('k', 'card') } }));
  const s = new MetaStore(p);
  await s.load();
  assert.deepEqual(s.list().map((m) => m.id), ['c']);
  assert.equal(s.get('p'), undefined);
  assert.equal(s.get('k'), undefined);
});

test('patch with unset removes keys', async () => {
  const p = tmp();
  const s = new MetaStore(p);
  await s.load();
  await s.put(meta('a', { projectId: 'p_1' }));
  const next = await s.patch('a', {}, ['projectId']);
  assert.equal(next?.projectId, undefined);
  assert.equal(s.get('a')?.projectId, undefined);
  assert.ok(!('projectId' in s.get('a')!));
  const s2 = new MetaStore(p);
  await s2.load();
  assert.equal(s2.get('a')?.projectId, undefined);
  assert.equal(s2.get('a')?.title, 't-a');
});

test('a moved home directory re-points missing session files under the new home', async () => {
  const oldHome = mkdtempSync(join(tmpdir(), 'meta-old-'));
  const newHome = mkdtempSync(join(tmpdir(), 'meta-new-'));
  const rel = join('sessions', '--Users-x-proj--', 'a.jsonl');
  mkdirSync(dirname(join(newHome, rel)), { recursive: true });
  writeFileSync(join(newHome, rel), '{}\n');
  const path = join(newHome, 'sessions.json');
  writeFileSync(path, JSON.stringify({ version: 1, sessions: {
    a: meta('a', { sessionFile: join(oldHome, rel) }),           // moved: exists under the new home
    b: meta('b', { sessionFile: join(oldHome, 'sessions', 'gone.jsonl') }), // really missing: left alone
  } }));
  const s = new MetaStore(path);
  await s.load();
  assert.equal(s.get('a')!.sessionFile, join(newHome, rel));
  assert.equal(s.get('b')!.sessionFile, join(oldHome, 'sessions', 'gone.jsonl'));
  // persisted, so the next start does not need to rebase again
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).sessions.a.sessionFile, join(newHome, rel));
});
