// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { engine } from '../engine';
import { Composer } from './Composer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let el: HTMLDivElement;
let root: Root;
beforeEach(() => {
  engine.store.setState({ drafts: {} });
  el = document.createElement('div'); document.body.appendChild(el); root = createRoot(el);
});
afterEach(async () => { await act(async () => { root.unmount(); }); el.remove(); vi.restoreAllMocks(); });

const btn = (label: string) => el.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

describe('Composer', () => {
  it('send is disabled until there is text; Enter / button sends and clears the draft; toolbar slot renders', async () => {
    const send = vi.spyOn(engine, 'send').mockResolvedValue();
    await act(async () => { root.render(<Composer workerId="w1" sessionId="s1" running={false} toolbar={<span data-testid="tb">tb</span>} />); });
    expect(el.querySelector('[data-testid="tb"]')).not.toBeNull();
    expect(btn('添加附件')).not.toBeNull();
    expect(btn('发送')!.disabled).toBe(true);
    expect(btn('中断')).toBeNull();
    await act(async () => { engine.setDraft('w1', 's1', ' hi '); });
    expect(btn('发送')!.disabled).toBe(false);
    await act(async () => { btn('发送')!.click(); });
    expect(send).toHaveBeenCalledWith('w1', 's1', 'hi', {});
    expect(engine.store.getState().drafts['w1/s1'] ?? '').toBe('');
  });
  it('while running: 中断 + 发送（排队） (followUp) and 插队发送 / ⌘·Ctrl+Enter (steer)', async () => {
    const send = vi.spyOn(engine, 'send').mockResolvedValue();
    await act(async () => { root.render(<Composer workerId="w1" sessionId="s1" running />); });
    expect(btn('中断')).not.toBeNull();
    expect(btn('发送（排队）')).toBeNull(); // nothing typed: only stop
    expect(btn('插队发送')).toBeNull();
    await act(async () => { engine.setDraft('w1', 's1', 'more'); });
    await act(async () => { btn('发送（排队）')!.click(); });
    expect(send).toHaveBeenLastCalledWith('w1', 's1', 'more', { delivery: 'followUp' });
    await act(async () => { engine.setDraft('w1', 's1', 'now'); });
    await act(async () => { btn('插队发送')!.click(); });
    expect(send).toHaveBeenLastCalledWith('w1', 's1', 'now', { delivery: 'steer' });
    const ta = el.querySelector('textarea')!;
    const key = (init: KeyboardEventInit) => act(async () => { ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init })); });
    await act(async () => { engine.setDraft('w1', 's1', 'enter'); });
    await key({});
    expect(send).toHaveBeenLastCalledWith('w1', 's1', 'enter', { delivery: 'followUp' });
    await act(async () => { engine.setDraft('w1', 's1', 'cmd'); });
    await key({ metaKey: true });
    expect(send).toHaveBeenLastCalledWith('w1', 's1', 'cmd', { delivery: 'steer' });
    await act(async () => { engine.setDraft('w1', 's1', 'ctrl'); });
    await key({ ctrlKey: true });
    expect(send).toHaveBeenLastCalledWith('w1', 's1', 'ctrl', { delivery: 'steer' });
  });
  it('when idle ⌘+Enter is a plain send (no delivery)', async () => {
    const send = vi.spyOn(engine, 'send').mockResolvedValue();
    await act(async () => { root.render(<Composer workerId="w1" sessionId="s1" running={false} />); });
    await act(async () => { engine.setDraft('w1', 's1', 'x'); });
    const ta = el.querySelector('textarea')!;
    await act(async () => { ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true })); });
    expect(send).toHaveBeenLastCalledWith('w1', 's1', 'x', {});
    expect(btn('插队发送')).toBeNull();
  });
});
