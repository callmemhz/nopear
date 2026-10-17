import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSseParser, readSse, stallWatchdog, type SseMessage } from './sse';

describe('sse parser', () => {
  it('handles chunk splits, comments, events, multiline data and CRLF', () => {
    const got: SseMessage[] = [];
    const p = createSseParser((m) => got.push(m));
    p.push('da');
    p.push('ta: hel');
    p.push('lo\n\n: ping\n\n');
    p.push('event: offline\ndata:\n\n');
    p.push('data: a\r\ndata: b\r\n\r\n');
    p.push('id: 7\ndata: x');
    p.end();
    expect(got).toEqual([
      { data: 'hello' },
      { event: 'offline', data: '' },
      { data: 'a\nb' },
      { id: '7', data: 'x' },
    ]);
  });
  it('reads from a streaming Response', async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(enc.encode('data: 1\n')); c.enqueue(enc.encode('\ndata: 2\n\n')); c.close(); },
    });
    const got: string[] = [];
    await readSse(new Response(body), (m) => got.push(m.data));
    expect(got).toEqual(['1', '2']);
  });
});

describe('readSse activity', () => {
  it('reports every chunk (including `: ping` comments) as activity', async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(enc.encode(': ping\n\n')); c.enqueue(enc.encode(': ping\n\n')); c.enqueue(enc.encode('data: x\n\n')); c.close(); },
    });
    const got: string[] = [];
    let activity = 0;
    await readSse(new Response(body), (m) => got.push(m.data), undefined, () => { activity++; });
    expect(got).toEqual(['x']);
    expect(activity).toBe(3);
  });
});

describe('stallWatchdog', () => {
  afterEach(() => { vi.useRealTimers(); });
  it('aborts after `ms` without a kick and marks the stream stalled', () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const w = stallWatchdog(parent.signal, 1000);
    vi.advanceTimersByTime(999);
    expect(w.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(w.signal.aborted).toBe(true);
    expect(w.stalled).toBe(true);
    w.dispose();
  });
  it('kicks keep it alive; a parent abort is not a stall', () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const w = stallWatchdog(parent.signal, 1000);
    for (let i = 0; i < 10; i++) { vi.advanceTimersByTime(900); w.kick(); }
    expect(w.signal.aborted).toBe(false);
    parent.abort();
    expect(w.signal.aborted).toBe(true);
    expect(w.stalled).toBe(false);
    w.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('dispose stops the timer', () => {
    vi.useFakeTimers();
    const w = stallWatchdog(new AbortController().signal, 1000);
    w.dispose();
    vi.advanceTimersByTime(5000);
    expect(w.signal.aborted).toBe(false);
  });
});
