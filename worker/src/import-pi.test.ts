import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PREVIEW_MAX_CHARS } from '@nopear/protocol';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { MetaStore } from './agent/meta-store';
import { loadLocalConfig } from './config';
import { importPiSessions } from './import-pi';

const line = (o: unknown): string => JSON.stringify(o) + '\n';
const header = (id: string, cwd: string, timestamp = '2026-02-20T06:47:06.295Z') =>
  line({ type: 'session', version: 3, id, timestamp, cwd });
const userMsg = (id: string, text: string, timestamp: string) =>
  line({ type: 'message', id, parentId: null, timestamp, message: { role: 'user', content: [{ type: 'text', text }], timestamp: 1 } });
const assistantMsg = (id: string, text: string, timestamp: string) =>
  line({ type: 'message', id, parentId: null, timestamp, message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text }],
    provider: 'p', model: 'm', stopReason: 'stop', timestamp: 2 } });

const NORMAL_ID = '11111111-1111-1111-1111-111111111111';
const longUser = '  帮我看一下这个仓库的结构，然后告诉我怎么把它部署到服务器上去，越详细越好，谢谢  ';
const longAssistant = '好的。\n\n' + 'x'.repeat(PREVIEW_MAX_CHARS + 50);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'import-pi-'));
  const source = join(root, 'pi-sessions');
  const proj = join(source, '--Users-me-proj--');
  const tmpProj = join(source, '--private-tmp-x--');
  mkdirSync(join(proj, 'subagent-artifacts'), { recursive: true });
  mkdirSync(tmpProj, { recursive: true });
  const normalName = `2026-02-20T06-47-06-295Z_${NORMAL_ID}.jsonl`;
  writeFileSync(join(proj, normalName),
    header(NORMAL_ID, '/Users/me/proj')
    + line({ type: 'model_change', id: 'mc1', parentId: null, timestamp: '2026-02-20T06:47:06.296Z', provider: 'old', modelId: 'm0' })
    + line({ type: 'thinking_level_change', id: 'tl1', parentId: 'mc1', timestamp: '2026-02-20T06:47:06.296Z', thinkingLevel: 'off' })
    + userMsg('u1', longUser, '2026-02-20T06:48:00.000Z')
    + assistantMsg('a1', '第一条回复', '2026-02-20T06:48:10.000Z')
    + line({ type: 'model_change', id: 'mc2', parentId: 'a1', timestamp: '2026-02-20T06:49:00.000Z', provider: 'example-provider', modelId: 'claude-opus-4-5' })
    + line({ type: 'thinking_level_change', id: 'tl2', parentId: 'mc2', timestamp: '2026-02-20T06:49:00.000Z', thinkingLevel: 'high' })
    + userMsg('u2', '继续', '2026-02-20T06:50:00.000Z')
    + assistantMsg('a2', longAssistant, '2026-02-20T06:51:00.000Z')
    + line({ type: 'message', id: 't1', parentId: 'a2', timestamp: '2026-02-20T06:52:00.000Z',
      message: { role: 'toolResult', toolCallId: 'c', toolName: 'bash', content: [{ type: 'text', text: 'tool out' }], isError: false, timestamp: 3 } }));
  // temp cwd
  writeFileSync(join(tmpProj, '2026-02-21T00-00-00-000Z_tmp.jsonl'),
    header('22222222-2222-2222-2222-222222222222', '/private/tmp/x') + userMsg('u1', 'hi', '2026-02-21T00:00:01.000Z'));
  // empty: header + model change, no user message
  writeFileSync(join(proj, '2026-02-22T00-00-00-000Z_empty.jsonl'),
    header('33333333-3333-3333-3333-333333333333', '/Users/me/proj')
    + line({ type: 'model_change', id: 'mc1', parentId: null, timestamp: '2026-02-22T00:00:00.001Z', provider: 'p', modelId: 'm' })
    + assistantMsg('a1', 'orphan reply', '2026-02-22T00:00:02.000Z'));
  // invalid header
  writeFileSync(join(proj, '2026-02-23T00-00-00-000Z_invalid.jsonl'), 'not json\n' + userMsg('u1', 'hi', '2026-02-23T00:00:01.000Z'));
  // nested subagent artifact (must be ignored entirely)
  writeFileSync(join(proj, 'subagent-artifacts', 'abc_scout_0_transcript.jsonl'),
    header('44444444-4444-4444-4444-444444444444', '/Users/me/proj') + userMsg('u1', 'scout', '2026-02-24T00:00:01.000Z'));
  // non-jsonl file at the top level is ignored too
  writeFileSync(join(proj, 'notes.txt'), 'hello');
  const cfg = loadLocalConfig({ NOPEAR_HOME: join(root, 'nopear-home'), NOPEAR_DEFAULT_MODEL: 'def/model', NOPEAR_DEFAULT_THINKING: 'medium' });
  return { root, source, cfg, normalSrc: join(proj, normalName), normalName };
}

const quiet = () => {};

test('imports a normal session (copy + meta) and skips temp / empty / invalid / nested files', async () => {
  const { source, cfg, normalSrc, normalName } = fixture();
  const before = readFileSync(normalSrc);
  const r = await importPiSessions({ source, cfg, log: quiet });
  assert.equal(r.found, 4);
  assert.equal(r.imported, 1);
  assert.deepEqual(r.skipped, { temp: 1, empty: 1, invalid: 1, alreadyImported: 0 });
  const dest = join(cfg.sessionsDir, '--Users-me-proj--', normalName);
  assert.equal(r.bytes, before.length);
  assert.deepEqual(readFileSync(dest), before, 'copy is byte-identical');
  assert.deepEqual(readFileSync(normalSrc), before, 'source untouched');
  assert.deepEqual(readdirSync(cfg.sessionsDir), ['--Users-me-proj--']);
  assert.deepEqual(readdirSync(join(cfg.sessionsDir, '--Users-me-proj--')), [normalName]);

  const store = new MetaStore(join(cfg.home, 'sessions.json'));
  await store.load();
  assert.equal(store.list().length, 1);
  const m = store.get(NORMAL_ID)!;
  assert.deepEqual(m, {
    id: NORMAL_ID, kind: 'chat', title: longUser.trim().slice(0, 40), cwd: '/Users/me/proj', sessionFile: dest,
    createdAt: '2026-02-20T06:47:06.295Z', lastActivityAt: '2026-02-20T06:52:00.000Z',
    preview: ('好的。 ' + 'x'.repeat(PREVIEW_MAX_CHARS)).slice(0, PREVIEW_MAX_CHARS),
    pinned: false, starred: false, archived: false, model: 'example-provider/claude-opus-4-5', thinking: 'high',
  });
  assert.equal(m.projectId, undefined);
  assert.equal(m.leafId, undefined);
  // The host reopens it exactly like this (host.ts ensureLive).
  const sm = SessionManager.open(m.sessionFile, cfg.sessionsDir);
  assert.equal(sm.getSessionId(), NORMAL_ID);
  assert.equal(sm.getLeafId(), 't1');
  assert.deepEqual(readFileSync(dest), before, 'open() leaves the copy as is');
});

test('second run is idempotent', async () => {
  const { source, cfg } = fixture();
  await importPiSessions({ source, cfg, log: quiet });
  const metaFile = join(cfg.home, 'sessions.json');
  const snapshot = readFileSync(metaFile, 'utf8');
  const r = await importPiSessions({ source, cfg, log: quiet });
  assert.equal(r.imported, 0);
  assert.equal(r.bytes, 0);
  assert.deepEqual(r.skipped, { temp: 1, empty: 1, invalid: 1, alreadyImported: 1 });
  assert.equal(readFileSync(metaFile, 'utf8'), snapshot);
});

test('existing destination file counts as already imported and is not overwritten', async () => {
  const { source, cfg, normalName } = fixture();
  const destDir = join(cfg.sessionsDir, '--Users-me-proj--');
  mkdirSync(destDir, { recursive: true });
  writeFileSync(join(destDir, normalName), 'keep me');
  const r = await importPiSessions({ source, cfg, log: quiet });
  assert.equal(r.imported, 0);
  assert.equal(r.skipped.alreadyImported, 1);
  assert.equal(readFileSync(join(destDir, normalName), 'utf8'), 'keep me');
});

test('dry run writes nothing', async () => {
  const { source, cfg } = fixture();
  const lines: string[] = [];
  const r = await importPiSessions({ source, cfg, dryRun: true, log: (s) => lines.push(s) });
  assert.equal(r.imported, 1, 'reports what would be imported');
  assert.deepEqual(r.skipped, { temp: 1, empty: 1, invalid: 1, alreadyImported: 0 });
  assert.equal(existsSync(cfg.home), false, 'NOPEAR_HOME not created');
  assert.ok(lines.some((l) => l.includes(NORMAL_ID)), 'lists the session it would import');
});

test('falls back to config defaults, file mtime and placeholder title', async () => {
  const root = mkdtempSync(join(tmpdir(), 'import-pi-'));
  const dir = join(root, 'src', '--Users-me-x--');
  mkdirSync(dir, { recursive: true });
  // user message with only an image (no text), no model/thinking entries, no entry timestamps after the header
  writeFileSync(join(dir, 'a.jsonl'),
    header('55555555-5555-5555-5555-555555555555', '/Users/me/x')
    + line({ type: 'thinking_level_change', id: 't', parentId: null, thinkingLevel: 'bogus' })
    + line({ type: 'message', id: 'u1', parentId: 't', message: { role: 'user', content: [{ type: 'image', data: 'AA==', mimeType: 'image/png' }] } }));
  const cfg = loadLocalConfig({ NOPEAR_HOME: join(root, 'home'), NOPEAR_DEFAULT_MODEL: 'def/model', NOPEAR_DEFAULT_THINKING: 'low' });
  const r = await importPiSessions({ source: join(root, 'src'), cfg, log: quiet });
  assert.equal(r.imported, 1);
  const store = new MetaStore(join(cfg.home, 'sessions.json'));
  await store.load();
  const m = store.get('55555555-5555-5555-5555-555555555555')!;
  assert.equal(m.title, '导入的会话');
  assert.equal(m.model, 'def/model');
  assert.equal(m.thinking, 'low');
  assert.equal(m.preview, '');
  assert.equal(m.lastActivityAt, statSync(join(dir, 'a.jsonl')).mtime.toISOString());
});
