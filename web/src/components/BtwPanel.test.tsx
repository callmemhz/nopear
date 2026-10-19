// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { BtwAnswer } from '@nopear/protocol';
import { engine } from '../engine';
import { BtwPanel } from './BtwPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let el: HTMLDivElement;
let root: Root;
afterEach(async () => { await act(async () => { root.unmount(); }); el.remove(); vi.restoreAllMocks(); });
const b = (id: string, p: Partial<BtwAnswer>): BtwAnswer => ({ id, question: 'q', text: '', status: 'running', ts: '', ...p });

describe('BtwPanel', () => {
  it('question, streaming / answered / failed states, close discards', async () => {
    const dismiss = vi.spyOn(engine, 'dismissBtw').mockImplementation(() => {});
    el = document.createElement('div'); document.body.appendChild(el); root = createRoot(el);
    await act(async () => { root.render(<BtwPanel workerId="w" sessionId="s" items={[
      b('a', { question: '这个函数干嘛的？' }),
      b('b', { text: '它负责 **重试**', status: 'done', model: 'p/m' }),
      b('c', { status: 'error', error: '400 quota' }),
    ]} />); });
    const card = (id: string) => el.querySelector(`[data-btw="${id}"]`)!;
    expect(card('a').textContent).toContain('这个函数干嘛的？');
    expect(card('a').textContent).toContain('正在看上下文');
    expect(card('b').querySelector('strong')?.textContent).toBe('重试');
    expect(card('b').textContent).toContain('p/m');
    expect(card('c').textContent).toContain('没答上来：400 quota');
    await act(async () => { card('b').querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!.click(); });
    expect(dismiss).toHaveBeenCalledWith('w', 's', 'b');
  });
  it('renders nothing without answers', async () => {
    el = document.createElement('div'); document.body.appendChild(el); root = createRoot(el);
    await act(async () => { root.render(<BtwPanel workerId="w" sessionId="s" items={[]} />); });
    expect(el.innerHTML).toBe('');
  });
});
