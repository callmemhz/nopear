import { describe, expect, it } from 'vitest';
import type { ViewItem } from '@nopear/core';
import { sameItem } from './MessageItem';

const msg = { id: 'a', sessionId: 's', role: 'assistant', blocks: [], ts: '', status: 'complete' } as ViewItem['message'];
const actions = {};
describe('MessageItem memo comparator', () => {
  it('treats rebuilt items with the same parts as equal', () => {
    const r = { toolCallId: 't', toolName: 'bash', text: 'x', isError: false, type: 'tool_result' as const };
    const im = { type: 'image' as const, mediaType: 'image/png', blob: 'h' };
    const a: ViewItem = { message: msg, results: { t: r }, resultImages: { t: [im] }, resultFiles: {}, progress: {} };
    const b: ViewItem = { message: msg, results: { t: r }, resultImages: { t: [im] }, resultFiles: {}, progress: {} };
    expect(sameItem({ item: a, workerId: 'w', actions }, { item: b, workerId: 'w', actions })).toBe(true);
  });
  it('detects changed message, progress, result images or actions', () => {
    const a: ViewItem = { message: msg, results: {}, resultImages: {}, resultFiles: {}, progress: {} };
    expect(sameItem({ item: a, workerId: 'w', actions }, { item: { ...a, message: { ...msg } }, workerId: 'w', actions })).toBe(false);
    expect(sameItem({ item: a, workerId: 'w', actions }, { item: { ...a, resultImages: { t: [{ type: 'image', mediaType: 'image/png', blob: 'h' }] } }, workerId: 'w', actions })).toBe(false);
    expect(sameItem({ item: a, workerId: 'w', actions }, { item: { ...a, progress: { t: 'more' } }, workerId: 'w', actions })).toBe(false);
    const f = { type: 'file' as const, name: 'a.pdf', mediaType: 'application/pdf', size: 1, blob: 'h' };
    expect(sameItem({ item: a, workerId: 'w', actions }, { item: { ...a, resultFiles: { t: [f] } }, workerId: 'w', actions })).toBe(false);
    expect(sameItem({ item: { ...a, resultFiles: { t: [f] } }, workerId: 'w', actions }, { item: { ...a, resultFiles: { t: [f] } }, workerId: 'w', actions })).toBe(true);
    expect(sameItem({ item: a, workerId: 'w', actions }, { item: a, workerId: 'w', actions: {} })).toBe(false);
  });
});
