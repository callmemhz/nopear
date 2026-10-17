// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Card } from '@nopear/protocol';
import { engine } from '../engine';
import { QuickAdd } from './QuickAdd';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const T = '2026-10-11T00:00:00Z';
let el: HTMLDivElement;
let root: Root;

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(async () => {
  engine.store.setState({
    projects: { p_1: { id: 'p_1', name: 'Proj One', description: '', paths: {}, createdAt: T, updatedAt: T } },
  });
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  await act(async () => { root.render(<QuickAdd />); });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  el.remove();
  vi.restoreAllMocks();
});

const created = { id: 'c_1' } as Card;

describe('QuickAdd', () => {
  it('Enter creates an inbox card with the selected project, then clears', async () => {
    const spy = vi.spyOn(engine, 'createCard').mockResolvedValue(created);
    const sel = el.querySelector('select')!;
    await act(async () => {
      sel.value = 'p_1';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const input = el.querySelector('input')!;
    await act(async () => { typeInto(input, '  Buy milk '); });
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(spy).toHaveBeenCalledWith({ title: 'Buy milk', projectId: 'p_1' });
    expect(input.value).toBe('');
  });

  it('without a project sends projectId null; empty input does nothing', async () => {
    const spy = vi.spyOn(engine, 'createCard').mockResolvedValue(created);
    const input = el.querySelector('input')!;
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(spy).not.toHaveBeenCalled();
    await act(async () => { typeInto(input, 'Note'); });
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(spy).toHaveBeenCalledWith({ title: 'Note', projectId: null });
    expect(input.value).toBe('');
  });
});
