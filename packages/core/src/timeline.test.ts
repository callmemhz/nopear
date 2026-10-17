import { describe, expect, it } from 'vitest';
import type { Message, QueueItem, SessionEvent, Session } from '@nopear/protocol';
import { addOptimistic, applySessionEvent, dropQueued, emptyTimeline, markSendFailed, markSent, prependPage, selectMessages, type TimelineState } from './timeline';

const sess = (p: Partial<Session> = {}): Session => ({ id: 's', workerId: 'w', kind: 'chat', title: 't', cwd: '/', status: 'idle', createdAt: '', lastActivityAt: '', preview: '', pinned: false, starred: false, archived: false, model: 'm', thinking: 'medium', promptCount: 0, taskCount: 0, ...p });
const msg = (id: string, p: Partial<Message> = {}): Message => ({ id, sessionId: 's', role: 'assistant', blocks: [{ type: 'text', text: id }], ts: '', status: 'complete', ...p });
const apply = (s: TimelineState, ...es: SessionEvent[]) => es.reduce(applySessionEvent, s);
let n = 0; const c = () => `e.${++n}`;

describe('timeline', () => {
  it('(a) streams live then replaces with persisted id in place', () => {
    let s = apply(emptyTimeline(), { type: 'message.upsert', cursor: c(), message: msg('u0', { role: 'user' }) });
    s = apply(s,
      { type: 'message.upsert', cursor: c(), message: msg('live:1', { status: 'streaming', blocks: [] }) },
      { type: 'message.delta', cursor: c(), messageId: 'live:1', index: 0, kind: 'thinking', text: 'hm' },
      { type: 'message.delta', cursor: c(), messageId: 'live:1', index: 1, kind: 'text', text: 'he' },
      { type: 'message.delta', cursor: c(), messageId: 'live:1', index: 1, kind: 'text', text: 'llo' },
      { type: 'message.delta', cursor: c(), messageId: 'live:1', index: 0, kind: 'thinking', text: '!' });
    expect(s.messages[1]!.blocks).toEqual([{ type: 'thinking', text: 'hm!' }, { type: 'text', text: 'hello' }]);
    s = apply(s, { type: 'message.upsert', cursor: c(), message: msg('a1'), replaces: 'live:1' });
    expect(s.messages.map((m) => m.id)).toEqual(['u0', 'a1']);
  });
  it('(b) optimistic replaced by upsert with clientMsgId', () => {
    let s = addOptimistic(emptyTimeline(), { clientMsgId: 'c1', text: 'hi', ts: 't' });
    expect(s.messages[0]!.id).toBe('local:c1');
    expect(s.pending.c1!.status).toBe('sending');
    s = apply(s, { type: 'message.upsert', cursor: c(), message: msg('u1', { role: 'user', clientMsgId: 'c1' }) });
    expect(s.messages.map((m) => m.id)).toEqual(['u1']);
    expect(s.pending.c1).toBeUndefined();
  });
  it('(c) snapshot replaces from overlap, else entirely; keeps optimistic', () => {
    let s = prependPage(emptyTimeline(), [msg('a'), msg('b'), msg('c')], true);
    s = addOptimistic(s, { clientMsgId: 'z', text: 'zz', ts: '' });
    s = apply(s, { type: 'snapshot', cursor: c(), session: sess({ title: 'X' }), messages: [msg('b'), msg('d')], hasMore: true, prompts: [{ id: 'p', sessionId: 's', questions: [], createdAt: '' }], tasks: [], queue: [] });
    expect(s.messages.map((m) => m.id)).toEqual(['a', 'b', 'd', 'local:z']);
    expect(s.session!.title).toBe('X');
    expect(s.prompts).toHaveLength(1);
    s = apply(s, { type: 'snapshot', cursor: c(), session: sess(), messages: [msg('q')], hasMore: false, prompts: [], tasks: [], queue: [] });
    expect(s.messages.map((m) => m.id)).toEqual(['q', 'local:z']);
    expect(s.hasMore).toBe(false);
    expect(s.prompts).toEqual([]);
  });
  it('(d) messages.removed / (e) prependPage dedupe / (f) cursor', () => {
    let s = prependPage(emptyTimeline(), [msg('b'), msg('c')], true);
    s = prependPage(s, [msg('a'), msg('b')], false);
    expect(s.messages.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(s.hasMore).toBe(false);
    s = apply(s, { type: 'messages.removed', cursor: 'ep.42', ids: ['b', 'c'] });
    expect(s.messages.map((m) => m.id)).toEqual(['a']);
    expect(s.cursor).toBe('ep.42');
  });
  it('(g) selectMessages merges tool results into tool_call item', () => {
    let s = prependPage(emptyTimeline(), [
      msg('a', { blocks: [{ type: 'tool_call', id: 't1', name: 'bash', input: {} }] }),
      msg('r', { role: 'tool', blocks: [{ type: 'tool_result', toolCallId: 't1', toolName: 'bash', text: 'ok', isError: false }] }),
      msg('orphan', { role: 'tool', blocks: [{ type: 'tool_result', toolCallId: 'zz', toolName: 'bash', text: 'x', isError: false }] }),
    ], false);
    s = apply(s, { type: 'tool.progress', cursor: c(), toolCallId: 't1', text: 'run' });
    const v = selectMessages(s);
    expect(v.map((x) => x.message.id)).toEqual(['a', 'orphan']);
    expect(v[0]!.results.t1!.text).toBe('ok');
    expect(v[0]!.progress.t1).toBe('run');
  });
  it('(g2) selectMessages attaches images of a tool message to its tool_call (resultImages); orphans keep theirs', () => {
    const img = { type: 'image' as const, mediaType: 'image/png', blob: 'h1' };
    const s = prependPage(emptyTimeline(), [
      msg('a', { blocks: [{ type: 'tool_call', id: 't1', name: 'read', input: {} }, { type: 'tool_call', id: 't2', name: 'bash', input: {} }] }),
      msg('r1', { role: 'tool', blocks: [{ type: 'tool_result', toolCallId: 't1', toolName: 'read', text: 'Read image', isError: false }, img] }),
      msg('r2', { role: 'tool', blocks: [{ type: 'tool_result', toolCallId: 't2', toolName: 'bash', text: 'ok', isError: false }] }),
      msg('orphan', { role: 'tool', blocks: [{ type: 'tool_result', toolCallId: 'zz', toolName: 'read', text: 'x', isError: false }, img] }),
    ], false);
    const v = selectMessages(s);
    expect(v.map((x) => x.message.id)).toEqual(['a', 'orphan']);
    expect(v[0]!.resultImages).toEqual({ t1: [img] });
    expect(v[0]!.results.t1!.text).toBe('Read image');
    expect(v[1]!.resultImages).toEqual({});
    expect(v[1]!.message.blocks).toContainEqual(img);
  });
  it('(g3) selectMessages attaches file blocks (send_file) of a tool message to its tool_call (resultFiles)', () => {
    const file = { type: 'file' as const, name: 'v.mp4', mediaType: 'video/mp4', size: 3, blob: 'h2' };
    const s = prependPage(emptyTimeline(), [
      msg('a', { blocks: [{ type: 'tool_call', id: 't1', name: 'send_file', input: { path: 'v.mp4' } }] }),
      msg('r1', { role: 'tool', blocks: [{ type: 'tool_result', toolCallId: 't1', toolName: 'send_file', text: '已发送文件', isError: false }, file] }),
    ], false);
    const v = selectMessages(s);
    expect(v.map((x) => x.message.id)).toEqual(['a']);
    expect(v[0]!.resultFiles).toEqual({ t1: [file] });
    expect(v[0]!.resultImages).toEqual({});
  });
  it('(h) prompts, tasks, failed send', () => {
    let s = apply(emptyTimeline(), { type: 'prompt.opened', cursor: c(), prompt: { id: 'p1', sessionId: 's', questions: [], createdAt: '' } });
    expect(s.prompts).toHaveLength(1);
    s = apply(s, { type: 'prompt.closed', cursor: c(), promptId: 'p1', reason: 'answered' },
      { type: 'tasks', cursor: c(), tasks: [{ id: 't', agent: 'a', goal: 'g', state: 'running', startedAt: '' }] },
      { type: 'session.updated', cursor: c(), session: sess({ status: 'running' }) });
    expect(s.prompts).toEqual([]);
    expect(s.tasks).toHaveLength(1);
    expect(s.session!.status).toBe('running');
    s = markSendFailed(addOptimistic(s, { clientMsgId: 'k', text: 'x', ts: '' }), 'k', 'boom');
    expect(s.pending.k).toMatchObject({ status: 'failed', error: 'boom' });
  });
  it('F16: snapshot hasMore keeps local state only when overlap is past the first local message', () => {
    // overlap at index 0 → nothing older kept locally → snapshot's hasMore wins
    let s = prependPage(emptyTimeline(), [msg('b'), msg('c')], false);
    s = apply(s, { type: 'snapshot', cursor: c(), session: sess(), messages: [msg('b'), msg('d')], hasMore: true, prompts: [], tasks: [], queue: [] });
    expect(s.hasMore).toBe(true);
    // overlap at index > 0 → older local pages kept → local hasMore kept
    let t = prependPage(emptyTimeline(), [msg('a'), msg('b')], false);
    t = apply(t, { type: 'snapshot', cursor: c(), session: sess(), messages: [msg('b')], hasMore: true, prompts: [], tasks: [], queue: [] });
    expect(t.hasMore).toBe(false);
  });
  it('F17: delta of a different kind does not append into the wrong block type', () => {
    let s = apply(emptyTimeline(),
      { type: 'message.upsert', cursor: c(), message: msg('live:9', { status: 'streaming', blocks: [] }) },
      { type: 'message.delta', cursor: c(), messageId: 'live:9', index: 0, kind: 'thinking', text: 'think' },
      { type: 'message.delta', cursor: c(), messageId: 'live:9', index: 0, kind: 'text', text: 'ans' });
    expect(s.messages[0]!.blocks).toEqual([{ type: 'text', text: 'ans' }]);
    s = apply(s, { type: 'message.delta', cursor: c(), messageId: 'live:9', index: 0, kind: 'text', text: 'wer' });
    expect(s.messages[0]!.blocks).toEqual([{ type: 'text', text: 'answer' }]);
  });
  it('queue: snapshot + queue events replace it; a queued send is a queue card, not a pending bubble', () => {
    const q = (id: string, delivery: QueueItem['delivery'] = 'followUp'): QueueItem => ({ id, text: id, delivery, attachments: 0, createdAt: '' });
    const bubbles = (t: TimelineState) => selectMessages(t).map((v) => v.message.id);
    let s = apply(emptyTimeline(), { type: 'snapshot', cursor: c(), session: sess({ status: 'running' }), messages: [msg('u0', { role: 'user' })], hasMore: false, prompts: [], tasks: [], queue: [q('old')] });
    expect(s.queue.map((x) => x.id)).toEqual(['old']);
    s = addOptimistic(s, { clientMsgId: 'k1', text: 'k1', ts: '' });
    s = markSent(s, 'k1');
    s = addOptimistic(s, { clientMsgId: 'k2', text: 'k2', ts: '' });
    expect(bubbles(s)).toEqual(['u0', 'local:k1', 'local:k2']);
    s = apply(s, { type: 'queue', cursor: c(), items: [q('old'), q('k1'), q('k2')] });
    expect(bubbles(s)).toEqual(['u0']); // deduped by clientMsgId: shown as queue cards only
    expect(s.pending.k1).toBeDefined();
    // k1 delivered: it leaves the queue (bubble dropped), then arrives as the persisted user message
    s = apply(s, { type: 'queue', cursor: c(), items: [q('old'), q('k2')] });
    expect(s.pending.k1).toBeUndefined();
    expect(s.messages.some((m) => m.id === 'local:k1')).toBe(false);
    s = apply(s, { type: 'message.upsert', cursor: c(), message: msg('u1', { role: 'user', clientMsgId: 'k1' }) });
    expect(bubbles(s)).toEqual(['u0', 'u1']);
    // cancelled locally (after messages.queue.remove succeeded)
    s = dropQueued(s, 'k2');
    expect(s.queue.map((x) => x.id)).toEqual(['old']);
    expect(s.pending.k2).toBeUndefined();
    expect(bubbles(s)).toEqual(['u0', 'u1']);
    // a snapshot without the queue field (older worker) clears it
    s = apply(s, { type: 'snapshot', cursor: c(), session: sess(), messages: [msg('u0', { role: 'user' }), msg('u1', { role: 'user' })], hasMore: false, prompts: [], tasks: [] } as unknown as SessionEvent);
    expect(s.queue).toEqual([]);
  });
});
