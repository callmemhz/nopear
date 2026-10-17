// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { clampWidth, loadWidth, saveWidth, useResizable } from './useResizable';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = 'nopear.sidebarWidth';
const opts = { storageKey: KEY, min: 200, max: 480, defaultWidth: 288 };

describe('clamp / load / save', () => {
  it('clamps to [min, max] and rounds', () => {
    expect(clampWidth(100, 200, 480)).toBe(200);
    expect(clampWidth(900, 200, 480)).toBe(480);
    expect(clampWidth(300.6, 200, 480)).toBe(301);
  });
  it('loads a persisted width, clamped; falls back to the default on missing/garbage/throwing storage', () => {
    const store = (v: string | null) => ({ getItem: () => v });
    expect(loadWidth(store('350'), opts)).toBe(350);
    expect(loadWidth(store('9999'), opts)).toBe(480);
    expect(loadWidth(store('10'), opts)).toBe(200);
    expect(loadWidth(store(null), opts)).toBe(288);
    expect(loadWidth(store('abc'), opts)).toBe(288);
    expect(loadWidth(undefined, opts)).toBe(288);
    expect(loadWidth({ getItem: () => { throw new Error('denied'); } }, opts)).toBe(288);
  });
  it('saves as a string and swallows storage errors', () => {
    const m = new Map<string, string>();
    saveWidth({ setItem: (k, v) => void m.set(k, v) }, KEY, 321);
    expect(m.get(KEY)).toBe('321');
    expect(() => saveWidth({ setItem: () => { throw new Error('full'); } }, KEY, 1)).not.toThrow();
  });
});

describe('useResizable', () => {
  let el: HTMLDivElement;
  let root: Root;
  function Harness() {
    const { width, handleProps } = useResizable(opts);
    return <div data-testid="panel" style={{ width }}><div data-testid="handle" {...handleProps} /></div>;
  }
  const handle = () => el.querySelector('[data-testid="handle"]')!;
  const panelWidth = () => (el.querySelector('[data-testid="panel"]') as HTMLElement).style.width;
  // jsdom may lack PointerEvent; React only keys on the event type, so a MouseEvent carrying pointerId works.
  const pointer = (type: string, clientX: number) => act(async () => {
    const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0 });
    Object.defineProperty(ev, 'pointerId', { value: 1 });
    handle().dispatchEvent(ev);
  });
  const render = () => act(async () => { root.render(<Harness />); });

  beforeEach(() => {
    localStorage.clear();
    el = document.createElement('div');
    document.body.appendChild(el);
    root = createRoot(el);
  });
  afterEach(async () => {
    await act(async () => { root.unmount(); });
    el.remove();
  });

  it('starts at the default, drags within the clamp, and persists on release', async () => {
    await render();
    expect(panelWidth()).toBe('288px');
    await pointer('pointerdown', 288);
    await pointer('pointermove', 338);
    expect(panelWidth()).toBe('338px');
    expect(localStorage.getItem(KEY)).toBeNull(); // only persisted on drag end
    await pointer('pointermove', 2000);
    expect(panelWidth()).toBe('480px');
    await pointer('pointermove', -500);
    expect(panelWidth()).toBe('200px');
    await pointer('pointermove', 400);
    await pointer('pointerup', 400);
    expect(panelWidth()).toBe('400px');
    expect(localStorage.getItem(KEY)).toBe('400');
    // moves after release don't resize
    await pointer('pointermove', 250);
    expect(panelWidth()).toBe('400px');
  });

  it('restores the persisted width and resets to the default on double-click', async () => {
    localStorage.setItem(KEY, '420');
    await render();
    expect(panelWidth()).toBe('420px');
    await act(async () => { handle().dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    expect(panelWidth()).toBe('288px');
    expect(localStorage.getItem(KEY)).toBe('288');
  });
});
