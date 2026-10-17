// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ViewItem } from '@nopear/core';

vi.mock('./BlobImage', () => ({ BlobImage: () => <img data-testid="blob" alt="" /> }));
const { MessageItem, isLongText } = await import('./MessageItem');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const user = (text: string): ViewItem => ({
  message: { id: 'm1', sessionId: 's', role: 'user', blocks: [{ type: 'text', text }], ts: '', status: 'complete' },
  results: {}, resultImages: {}, resultFiles: {}, progress: {},
});

let el: HTMLDivElement;
let root: Root;
beforeEach(() => { el = document.createElement('div'); document.body.appendChild(el); root = createRoot(el); });
afterEach(async () => { await act(async () => { root.unmount(); }); el.remove(); });

const button = (label: string) => Array.from(el.querySelectorAll('button')).find((b) => b.textContent === label);

describe('isLongText', () => {
  it('counts newline-separated and wrapped lines', () => {
    expect(isLongText('a\nb\nc')).toBe(false);
    expect(isLongText(Array.from({ length: 13 }, (_, i) => `line ${i}`).join('\n'))).toBe(true);
    expect(isLongText('x'.repeat(70 * 13))).toBe(true);
    expect(isLongText('x'.repeat(70 * 5))).toBe(false);
  });
});

describe('user message bubble', () => {
  it('collapses long messages with 展开 / 收起', async () => {
    const text = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    await act(async () => { root.render(<MessageItem item={user(text)} workerId="w" actions={{}} />); });
    const body = el.querySelector('[data-testid="user-text"]')!;
    expect(body.getAttribute('data-collapsed')).toBe('true');
    expect(body.textContent).toContain('line 19'); // full text stays in the DOM (clipped by CSS)
    await act(async () => { button('展开')!.click(); });
    expect(body.getAttribute('data-collapsed')).toBe('false');
    expect(button('收起')).toBeTruthy();
    await act(async () => { button('收起')!.click(); });
    expect(body.getAttribute('data-collapsed')).toBe('true');
  });
  it('short messages have no toggle', async () => {
    await act(async () => { root.render(<MessageItem item={user('hello')} workerId="w" actions={{}} />); });
    expect(el.textContent).toContain('hello');
    expect(button('展开')).toBeUndefined();
    expect(el.querySelector('[data-testid="user-text"]')!.getAttribute('data-collapsed')).toBe('false');
  });
  it('keeps rewind / fork actions on confirmed messages', async () => {
    const onRewind = vi.fn(); const onFork = vi.fn();
    await act(async () => { root.render(<MessageItem item={user('hello')} workerId="w" actions={{ onRewind, onFork }} />); });
    await act(async () => { (el.querySelector('[title^="撤回"]') as HTMLButtonElement).click(); });
    await act(async () => { (el.querySelector('[title="从这里分叉出新会话"]') as HTMLButtonElement).click(); });
    expect(onRewind).toHaveBeenCalledWith('m1');
    expect(onFork).toHaveBeenCalledWith('m1');
  });
});

describe('subagent notice card', () => {
  const notice = (status: 'completed' | 'failed' | 'attention' | undefined, text: string, agent?: string): ViewItem => ({
    message: { id: 'n1', sessionId: 's', role: 'system', blocks: [{ type: 'text', text }], ts: '', status: 'complete',
      notice: { kind: 'subagent', title: text.split('\n')[0]!.replace(/\*\*/g, ''), ...(status ? { status } : {}), ...(agent ? { agent } : {}) } },
    results: {}, resultImages: {}, resultFiles: {}, progress: {},
  });
  it('renders a slim card with label + agent + summary first line; click expands the full markdown', async () => {
    const text = 'Background task completed: **worker**\n\nSummary line one\n\n- detail item';
    await act(async () => { root.render(<MessageItem item={notice('completed', text, 'worker')} workerId="w" actions={{}} />); });
    const card = el.querySelector('[data-testid="notice-card"]')!;
    expect(card).toBeTruthy();
    expect(card.textContent).toContain('后台任务完成 · worker');
    expect(card.textContent).toContain('Summary line one');
    expect(card.textContent).not.toContain('detail item');
    const toggle = card.querySelector('button')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await act(async () => { toggle.click(); });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(el.querySelector('li')?.textContent).toBe('detail item');
  });
  it('labels failed / attention / unknown notices', async () => {
    await act(async () => { root.render(<MessageItem item={notice('failed', 'Subagent failed: impl\nRun: r1', 'impl')} workerId="w" actions={{}} />); });
    expect(el.textContent).toContain('后台任务失败 · impl');
    expect(el.textContent).toContain('Run: r1');
    await act(async () => { root.render(<MessageItem item={notice('attention', 'Subagent needs attention: w2\nRun: r2', 'w2')} workerId="w" actions={{}} />); });
    expect(el.textContent).toContain('后台任务需要处理 · w2');
    await act(async () => { root.render(<MessageItem item={notice(undefined, 'Something odd\nmore')} workerId="w" actions={{}} />); });
    expect(el.textContent).toContain('后台任务通知');
    expect(el.textContent).toContain('Something odd');
  });
});
