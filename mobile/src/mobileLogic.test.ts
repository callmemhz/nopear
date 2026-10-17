import { describe, expect, it, vi } from 'vitest';
import { Lru } from './lru';
import { budgetInputSize, extFor, needsConversion, webpName } from './imagePolicy';
import { compressToBudget, IMAGE_BUDGET_BYTES, IMAGE_STEPS } from '@nopear/core';
import { sameViewItem } from './viewItemEq';

describe('Lru', () => {
  it('evicts least recently used beyond max', () => {
    const l = new Lru<string>(2);
    l.set('a', '1'); l.set('b', '2'); l.get('a'); l.set('c', '3');
    expect(l.get('b')).toBeUndefined();
    expect(l.get('a')).toBe('1');
    expect(l.get('c')).toBe('3');
    expect(l.size).toBe(2);
  });
});

describe('imagePolicy', () => {
  it('re-encodes non-vision image types (as WebP)', () => {
    expect(needsConversion('image/heic')).toBe(true);
    expect(needsConversion('image/bmp')).toBe(true);
    expect(needsConversion('image/png')).toBe(false);
    expect(needsConversion('image/jpeg')).toBe(false);
    expect(webpName('IMG_1.HEIC')).toBe('IMG_1.webp');
  });
  it('small non-vision images still go through the budgeted compression steps (never full-res)', async () => {
    const steps: { maxSide: number; quality: number }[] = [];
    const encode = async (st: { maxSide: number; quality: number }) => { steps.push(st); return { bytes: 1000, dataBase64: 'x' }; };
    const heic = await compressToBudget(budgetInputSize('image/heic', 500_000), encode);
    expect(heic?.mediaType).toBe('image/webp');
    expect(steps).toEqual([IMAGE_STEPS[0]]);
    // a vision type under budget is passed through untouched
    expect(budgetInputSize('image/png', 500_000)).toBe(500_000);
    expect(await compressToBudget(budgetInputSize('image/png', 500_000), encode)).toBeNull();
    // over budget sizes are preserved
    expect(budgetInputSize('image/heic', IMAGE_BUDGET_BYTES * 2)).toBe(IMAGE_BUDGET_BYTES * 2);
  });
  it('derives safe cache extensions', () => {
    expect(extFor('image/jpeg')).toBe('jpg');
    expect(extFor('image/png')).toBe('png');
    expect(extFor('image/svg+xml')).toBe('svg');
    expect(extFor('weird')).toBe('bin');
  });
});

describe('sameViewItem', () => {
  const msg = { id: 'm', sessionId: 's', role: 'assistant', blocks: [], ts: '', status: 'complete' } as const;
  const base = { message: msg, results: {}, resultImages: {}, resultFiles: {}, progress: {} };
  const im = { type: 'image', mediaType: 'image/png', blob: 'h' };
  it('treats freshly rebuilt but equal maps as equal (selectMessages rebuilds them each time)', () => {
    expect(sameViewItem(base as never, { ...base, results: {}, progress: {} } as never)).toBe(true);
    expect(sameViewItem({ ...base, resultImages: { t: [im] } } as never, { ...base, resultImages: { t: [im] } } as never)).toBe(true);
  });
  it('detects changed result files', () => {
    const f = { type: 'file', name: 'a.pdf', mediaType: 'application/pdf', size: 1, blob: 'h' };
    expect(sameViewItem(base as never, { ...base, resultFiles: { t: [f] } } as never)).toBe(false);
    expect(sameViewItem({ ...base, resultFiles: { t: [f] } } as never, { ...base, resultFiles: { t: [f] } } as never)).toBe(true);
  });
  it('detects changed result images', () => {
    expect(sameViewItem(base as never, { ...base, resultImages: { t: [im] } } as never)).toBe(false);
    expect(sameViewItem({ ...base, resultImages: { t: [im] } } as never, { ...base, resultImages: { t: [im, { ...im, blob: 'h2' }] } } as never)).toBe(false);
  });
  it('detects changed message, progress, results or pending', () => {
    const r = { type: 'tool_result', toolCallId: 't', toolName: 'bash', text: 'x', isError: false };
    expect(sameViewItem(base as never, { ...base, message: { ...msg } } as never)).toBe(false);
    expect(sameViewItem(base as never, { ...base, progress: { t: 'out' } } as never)).toBe(false);
    expect(sameViewItem({ ...base, results: { t: r } } as never, { ...base, results: { t: { ...r } } } as never)).toBe(false);
    expect(sameViewItem(base as never, { ...base, pending: { clientMsgId: 'c', text: '', status: 'failed' } } as never)).toBe(false);
  });
});

describe('sessionTitle', () => {
  it('is the session title (no PM prefix any more)', async () => {
    const { sessionTitle } = await import('./format');
    expect(sessionTitle({ title: 'hello' })).toBe('hello');
    expect(sessionTitle({ title: 'PM · x' })).toBe('PM · x');
    expect(sessionTitle({ title: '' })).toBe('未命名会话');
  });
});

describe('noticeTarget', () => {
  it('only routes session notices (to the session screen)', async () => {
    vi.doMock('expo-notifications', () => ({}));
    vi.doMock('expo-router', () => ({ router: { push: () => {} } }));
    vi.doMock('./engine', () => ({ engine: { onNotice: () => () => {} } }));
    const { noticeTarget } = await import('./notifications');
    expect(noticeTarget({ kind: 'session.idle', workerId: 'w/1', sessionId: 's 1', title: 't' })).toBe('/s/w%2F1/s%201');
    expect(noticeTarget({ kind: 'prompt', workerId: 'w', title: 't' })).toBeNull();
    expect(noticeTarget({ kind: 'session.error', workerId: 'w', projectId: 'p_1', title: 't' } as never)).toBeNull();
  });
});

describe('initials', () => {
  it('takes two letters from the email name', async () => {
    const { initials } = await import('./format');
    expect(initials('john.doe@example.com')).toBe('JD');
    expect(initials('alice@example.com')).toBe('AL');
    expect(initials('a_b-c@x')).toBe('AB');
    expect(initials('')).toBe('?');
    expect(initials(undefined)).toBe('?');
  });
});

describe('projectHref', () => {
  it('encodes the id', async () => {
    const { projectHref } = await import('./format');
    expect(projectHref('p 1')).toBe('/project/p%201');
  });
});

describe('modelLabel', () => {
  it('prefers the worker display name, else strips the provider', async () => {
    const { modelLabel } = await import('./format');
    expect(modelLabel('p/claude-x', [{ id: 'p/claude-x', name: 'Claude X' }])).toBe('Claude X');
    expect(modelLabel('provider/claude-opus', [])).toBe('claude-opus');
    expect(modelLabel('plain')).toBe('plain');
    expect(modelLabel('')).toBe('默认模型');
  });
});
