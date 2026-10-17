import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlobStore } from './blobs';
import { entryToMessage, previewOf } from './mapping';

const blobs = new BlobStore(mkdtempSync(join(tmpdir(), 'blobs-')));
const ts = '2026-01-01T00:00:00.000Z';
const PNG = Buffer.from('fake-png-bytes').toString('base64');
const msg = (id: string, message: unknown) => ({ type: 'message', id, parentId: null, timestamp: ts, message });

test('user message with text + inline image → image blob ref, clientMsgId attached', async () => {
  const ids = new Map([['u1', 'c-1']]);
  const m = await entryToMessage('s', msg('u1', { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', data: PNG, mimeType: 'image/png' }], timestamp: 1 }), blobs, ids);
  assert.equal(m?.id, 'u1');
  assert.equal(m?.role, 'user');
  assert.equal(m?.status, 'complete');
  assert.equal(m?.clientMsgId, 'c-1');
  assert.equal(m?.ts, ts);
  assert.deepEqual(m?.blocks[0], { type: 'text', text: 'look' });
  const img = m?.blocks[1] as { type: string; blob: string; mediaType: string };
  assert.equal(img.type, 'image');
  assert.equal(img.mediaType, 'image/png');
  assert.match(img.blob, /^[0-9a-f]{64}$/);
  assert.ok(existsSync(join((blobs as unknown as { dir: string }).dir, img.blob)));
  const got = await blobs.get(img.blob);
  assert.equal(Buffer.from(got!.bytes).toString(), 'fake-png-bytes');
  assert.equal(got!.mediaType, 'image/png');
});

test('string user content', async () => {
  const m = await entryToMessage('s', msg('u2', { role: 'user', content: 'plain', timestamp: 1 }), blobs, new Map());
  assert.deepEqual(m?.blocks, [{ type: 'text', text: 'plain' }]);
  assert.equal(m?.clientMsgId, undefined);
});

test('assistant with thinking + text + toolCall, usage and model', async () => {
  const m = await entryToMessage('s', msg('a1', { role: 'assistant', provider: 'faux', model: 'echo', stopReason: 'toolUse', timestamp: 1,
    usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 7, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 } },
    content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'hi' }, { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'ls' } }] }), blobs, new Map());
  assert.equal(m?.role, 'assistant');
  assert.equal(m?.status, 'complete');
  assert.equal(m?.model, 'faux/echo');
  assert.deepEqual(m?.usage, { input: 3, output: 4, costUsd: 0.25 });
  assert.deepEqual(m?.blocks, [{ type: 'thinking', text: 'hmm' }, { type: 'text', text: 'hi' }, { type: 'tool_call', id: 't1', name: 'bash', input: { command: 'ls' } }]);
});

test('assistant error / aborted → status error + errorText', async () => {
  const m = await entryToMessage('s', msg('a2', { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'boom', timestamp: 1 }), blobs, new Map());
  assert.equal(m?.status, 'error');
  assert.equal(m?.errorText, 'boom');
  const m2 = await entryToMessage('s', msg('a3', { role: 'assistant', content: [{ type: 'text', text: 'part' }], stopReason: 'aborted', timestamp: 1 }), blobs, new Map());
  assert.equal(m2?.status, 'error');
  assert.equal(m2?.errorText, 'aborted');
});

test('toolResult → role tool with tool_result block', async () => {
  const m = await entryToMessage('s', msg('r1', { role: 'toolResult', toolCallId: 't1', toolName: 'bash', isError: true, content: [{ type: 'text', text: 'out' }, { type: 'text', text: '2' }], timestamp: 1 }), blobs, new Map());
  assert.equal(m?.role, 'tool');
  assert.deepEqual(m?.blocks, [{ type: 'tool_result', toolCallId: 't1', toolName: 'bash', text: 'out\n2', isError: true }]);
});

test('toolResult with text + image (e.g. read on a png) → tool_result block + image block with blob written', async () => {
  const m = await entryToMessage('s', msg('r2', { role: 'toolResult', toolCallId: 't2', toolName: 'read', isError: false,
    content: [{ type: 'text', text: 'Read image file [image/png]' }, { type: 'image', data: PNG, mimeType: 'image/png' }, { type: 'image', data: PNG, mimeType: 'image/svg+xml' }], timestamp: 1 }), blobs, new Map());
  assert.equal(m?.role, 'tool');
  assert.equal(m?.blocks.length, 3);
  assert.deepEqual(m?.blocks[0], { type: 'tool_result', toolCallId: 't2', toolName: 'read', text: 'Read image file [image/png]', isError: false });
  const img = m?.blocks[1] as { type: string; blob: string; mediaType: string };
  assert.equal(img.type, 'image');
  assert.equal(img.mediaType, 'image/png');
  assert.match(img.blob, /^[0-9a-f]{64}$/);
  const got = await blobs.get(img.blob);
  assert.equal(Buffer.from(got!.bytes).toString(), 'fake-png-bytes');
  assert.equal((m?.blocks[2] as { mediaType: string }).mediaType, 'application/octet-stream'); // VISION_MEDIA_TYPES policy kept
});

test('custom_message(display) / compaction / branch_summary → system; hidden custom and others ignored', async () => {
  const c = await entryToMessage('s', { type: 'custom_message', id: 'c1', parentId: null, timestamp: ts, customType: 'x', content: 'note', display: true }, blobs, new Map());
  assert.deepEqual([c?.role, c?.blocks], ['system', [{ type: 'text', text: 'note' }]]);
  assert.equal(await entryToMessage('s', { type: 'custom_message', id: 'c2', parentId: null, timestamp: ts, customType: 'x', content: 'n', display: false }, blobs, new Map()), null);
  const k = await entryToMessage('s', { type: 'compaction', id: 'k1', parentId: null, timestamp: ts, summary: 'sum', tokensBefore: 9 }, blobs, new Map());
  assert.equal(k?.role, 'system');
  assert.match((k?.blocks[0] as { text: string }).text, /sum/);
  const b = await entryToMessage('s', { type: 'branch_summary', id: 'b1', parentId: null, timestamp: ts, fromId: 'x', summary: 'bs' }, blobs, new Map());
  assert.equal(b?.role, 'system');
  assert.equal(await entryToMessage('s', { type: 'model_change', id: 'm1', parentId: null, timestamp: ts, provider: 'p', modelId: 'm' }, blobs, new Map()), null);
  assert.equal(await entryToMessage('s', msg('x', { role: 'bashExecution', command: 'ls', output: '', timestamp: 1 }), blobs, new Map()), null);
});

test('previewOf takes text, collapses whitespace, caps at 160', () => {
  const base = { id: 'x', sessionId: 's', role: 'assistant' as const, ts, status: 'complete' as const };
  assert.equal(previewOf({ ...base, blocks: [{ type: 'thinking', text: 'no' }, { type: 'text', text: ' a\n\nb ' }] }), 'a b');
  assert.equal(previewOf({ ...base, blocks: [{ type: 'text', text: 'x'.repeat(500) }] }).length, 160);
  assert.equal(previewOf({ ...base, blocks: [{ type: 'tool_call', id: 't', name: 'bash', input: {} }] }), '');
});

test('F5: non-vision image mimeType is stored/reported as application/octet-stream', async () => {
  const SVG = Buffer.from('<svg>distinct-bytes</svg>').toString('base64'); // content-addressed: avoid sharing the PNG blob
  const m = await entryToMessage('s', msg('u9', { role: 'user', content: [{ type: 'image', data: SVG, mimeType: 'image/svg+xml' }], timestamp: 1 }), blobs, new Map());
  const img = m?.blocks[0] as { type: string; blob: string; mediaType: string };
  assert.equal(img.type, 'image');
  assert.equal(img.mediaType, 'application/octet-stream');
  assert.equal((await blobs.get(img.blob))!.mediaType, 'application/octet-stream');
  const missing = await entryToMessage('s', msg('u10', { role: 'user', content: [{ type: 'image', data: SVG }], timestamp: 1 }), blobs, new Map());
  assert.equal((missing?.blocks[0] as { mediaType: string }).mediaType, 'application/octet-stream');
});

const custom = (id: string, customType: string, content: string, display: boolean) =>
  ({ type: 'custom_message', id, parentId: null, timestamp: ts, customType, content, display });

test('subagent-notify (display:false) → system message with notice; full text kept', async () => {
  const text = 'Background task completed: **worker** (step 1)\n\nAll done.\nSecond line';
  const m = await entryToMessage('s', custom('n1', 'subagent-notify', text, false), blobs, new Map());
  assert.equal(m?.role, 'system');
  assert.deepEqual(m?.blocks, [{ type: 'text', text }]);
  assert.deepEqual(m?.notice, { kind: 'subagent', title: 'Background task completed: worker (step 1)', status: 'completed', agent: 'worker' });
  const f = await entryToMessage('s', custom('n2', 'subagent-notify', 'Detached foreground task failed: **reviewer**\n\nboom', true), blobs, new Map());
  assert.deepEqual(f?.notice, { kind: 'subagent', title: 'Detached foreground task failed: reviewer', status: 'failed', agent: 'reviewer' });
  const g = await entryToMessage('s', custom('n3', 'subagent-notify', 'Background tasks completed (2): **a**, **b** (x)\n\n1. a', false), blobs, new Map());
  assert.deepEqual(g?.notice, { kind: 'subagent', title: 'Background tasks completed (2): a, b (x)', status: 'completed', agent: 'a, b (x)' });
});

test('subagent_control_notice → attention / failed notice; unknown first line → title only', async () => {
  const a = await entryToMessage('s', custom('n4', 'subagent_control_notice', 'Subagent needs attention: worker\nRun: r1', true), blobs, new Map());
  assert.deepEqual(a?.notice, { kind: 'subagent', title: 'Subagent needs attention: worker', status: 'attention', agent: 'worker' });
  const f = await entryToMessage('s', custom('n5', 'subagent_control_notice', 'Subagent failed: impl\nRun: r2', false), blobs, new Map());
  assert.deepEqual(f?.notice, { kind: 'subagent', title: 'Subagent failed: impl', status: 'failed', agent: 'impl' });
  const l = await entryToMessage('s', custom('n6', 'subagent_control_notice', 'Subagent active but long-running: w2\nRun: r3', false), blobs, new Map());
  assert.equal(l?.notice?.status, 'attention');
  const u = await entryToMessage('s', custom('n7', 'subagent-x', 'Something else', false), blobs, new Map());
  assert.deepEqual(u?.notice, { kind: 'subagent', title: 'Something else' });
});

test('subagent-compaction-resume and non-subagent hidden customs stay hidden; plain display customs carry no notice', async () => {
  assert.equal(await entryToMessage('s', custom('n8', 'subagent-compaction-resume', 'resume', false), blobs, new Map()), null);
  assert.equal(await entryToMessage('s', custom('n9', 'other', 'x', false), blobs, new Map()), null);
  const d = await entryToMessage('s', custom('n10', 'other', 'shown', true), blobs, new Map());
  assert.equal(d?.notice, undefined);
});

test('toolResult with details.nopearFile (send_file) → tool_result block + file block', async () => {
  const blob = 'a'.repeat(64);
  const m = await entryToMessage('s', msg('r3', { role: 'toolResult', toolCallId: 't3', toolName: 'send_file', isError: false,
    content: [{ type: 'text', text: '已发送文件 v.mp4（3 B）' }],
    details: { nopearFile: { name: 'v.mp4', mediaType: 'video/mp4', size: 3, blob, title: 'Demo', note: 'n' } }, timestamp: 1 }), blobs, new Map());
  assert.deepEqual(m?.blocks, [
    { type: 'tool_result', toolCallId: 't3', toolName: 'send_file', text: '已发送文件 v.mp4（3 B）', isError: false },
    { type: 'file', name: 'v.mp4', mediaType: 'video/mp4', size: 3, blob, title: 'Demo', note: 'n' },
  ]);
  // malformed details (bad hash / missing fields) or an error result → no file block
  const bad = await entryToMessage('s', msg('r4', { role: 'toolResult', toolCallId: 't4', toolName: 'send_file', isError: false, content: [],
    details: { nopearFile: { name: 'x', mediaType: 'text/plain', size: 1, blob: '../etc' } }, timestamp: 1 }), blobs, new Map());
  assert.equal(bad?.blocks.length, 1);
  const err = await entryToMessage('s', msg('r5', { role: 'toolResult', toolCallId: 't5', toolName: 'send_file', isError: true, content: [],
    details: { nopearFile: { name: 'v.mp4', mediaType: 'video/mp4', size: 3, blob } }, timestamp: 1 }), blobs, new Map());
  assert.equal(err?.blocks.length, 1);
  // sessions recorded before the rename store the record under `fleetFile`
  const legacy = await entryToMessage('s', msg('r6', { role: 'toolResult', toolCallId: 't6', toolName: 'send_file', isError: false, content: [],
    details: { fleetFile: { name: 'v.mp4', mediaType: 'video/mp4', size: 3, blob } }, timestamp: 1 }), blobs, new Map());
  assert.deepEqual(legacy?.blocks.at(-1), { type: 'file', name: 'v.mp4', mediaType: 'video/mp4', size: 3, blob });
});
