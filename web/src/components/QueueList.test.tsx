// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { emptyTimeline, RpcCallError } from '@nopear/core';
import type { QueueItem } from '@nopear/protocol';
import { engine } from '../engine';
import { QueueList } from './QueueList';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let el: HTMLDivElement;
let root: Root;
const K = 'w1/s1';
const item = (id: string, text: string, delivery: QueueItem['delivery'], attachments = 0): QueueItem => ({ id, text, delivery, attachments, createdAt: '' });
const setQueue = (queue: QueueItem[]) => act(async () => { engine.store.setState({ timelines: { [K]: { ...emptyTimeline(), queue } } }); });
beforeEach(() => {
  engine.store.setState({ drafts: {}, timelines: {}, error: null });
  el = document.createElement('div'); document.body.appendChild(el); root = createRoot(el);
});
afterEach(async () => { await act(async () => { root.unmount(); }); el.remove(); vi.restoreAllMocks(); });

const cards = () => Array.from(el.querySelectorAll<HTMLElement>('[data-testid="queue-card"]'));
const btnIn = (card: HTMLElement, label: string) => card.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

describe('QueueList', () => {
  it('renders nothing without queued messages; cards show preview, badge and attachment count', async () => {
    await act(async () => { root.render(<QueueList workerId="w1" sessionId="s1" />); });
    expect(el.innerHTML).toBe('');
    await setQueue([item('s', 'urgent fix', 'steer'), item('f', 'later\nplease', 'followUp', 2)]);
    const [a, b] = cards();
    expect(a!.textContent).toContain('插队');
    expect(a!.textContent).toContain('urgent fix');
    expect(btnIn(a!, '插队')).toBeNull(); // already steer
    expect(b!.textContent).toContain('排队');
    expect(b!.textContent).toContain('later please');
    expect(b!.textContent).toContain('📎 2');
    expect(btnIn(b!, '插队')).not.toBeNull();
  });
  it('取消 removes it; 插队 converts followUp → steer; not_found shows a friendly error', async () => {
    const remove = vi.spyOn(engine, 'removeQueued').mockResolvedValue();
    const update = vi.spyOn(engine, 'updateQueued').mockResolvedValue();
    await act(async () => { root.render(<QueueList workerId="w1" sessionId="s1" />); });
    await setQueue([item('f', 'later', 'followUp')]);
    await act(async () => { btnIn(cards()[0]!, '取消')!.click(); });
    expect(remove).toHaveBeenCalledWith('w1', 's1', 'f');
    await act(async () => { btnIn(cards()[0]!, '插队')!.click(); });
    expect(update).toHaveBeenCalledWith('w1', 's1', 'f', { delivery: 'steer' });
    remove.mockRejectedValueOnce(new RpcCallError('not_found', 'gone'));
    await act(async () => { btnIn(cards()[0]!, '取消')!.click(); });
    expect(engine.store.getState().error).toBe('这条消息已送达，无法再修改');
  });
  it('编辑 moves the text into the composer (removing it from the queue); confirms before replacing a draft', async () => {
    const remove = vi.spyOn(engine, 'removeQueued').mockResolvedValue();
    const confirm = vi.fn(() => false);
    await act(async () => { root.render(<QueueList workerId="w1" sessionId="s1" confirm={confirm} />); });
    await setQueue([item('f', 'fix the typo', 'followUp')]);
    await act(async () => { btnIn(cards()[0]!, '编辑')!.click(); });
    expect(confirm).not.toHaveBeenCalled(); // empty composer: no confirmation
    expect(remove).toHaveBeenCalledWith('w1', 's1', 'f');
    expect(engine.store.getState().drafts[K]).toBe('fix the typo');
    // non-empty draft: declined → nothing happens
    remove.mockClear();
    await act(async () => { engine.setDraft('w1', 's1', 'my draft'); });
    await act(async () => { btnIn(cards()[0]!, '编辑')!.click(); });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
    expect(engine.store.getState().drafts[K]).toBe('my draft');
    // accepted → replaced
    confirm.mockReturnValue(true);
    await act(async () => { btnIn(cards()[0]!, '编辑')!.click(); });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(engine.store.getState().drafts[K]).toBe('fix the typo');
  });
});
