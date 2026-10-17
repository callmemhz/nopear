// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import type { Card } from '@nopear/protocol';
import { engine } from '../engine';
import { BoardPage } from './board';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.scrollTo = () => {}; // jsdom lacks it; the router's scroll restoration calls it

const T = '2026-10-11T00:00:00Z';
function card(id: string, over: Partial<Card>): Card {
  return { id, projectId: null, title: id, body: '', state: 'inbox', workerId: null, sessionId: null, order: 0, createdAt: T, updatedAt: T, ...over };
}

let el: HTMLDivElement;
let root: Root;
async function render(node: ReactElement) {
  const rootRoute = createRootRoute({ component: () => node });
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ['/'] }) });
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  await act(async () => { root.render(<RouterProvider router={router} />); });
  await act(async () => { await router.load(); });
}

function dataTransfer() {
  const data: Record<string, string> = {};
  return {
    data, dropEffect: 'none', effectAllowed: 'all',
    setData: (k: string, v: string) => { data[k] = v; },
    getData: (k: string) => data[k] ?? '',
  };
}
function fire(target: Element, type: string, dt: ReturnType<typeof dataTransfer>) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: dt });
  target.dispatchEvent(ev);
}
async function drag(cardId: string, target: Element) {
  const dt = dataTransfer();
  const src = el.querySelector(`[data-card="${cardId}"]`)!;
  await act(async () => {
    fire(src, 'dragstart', dt);
    fire(target, 'dragover', dt);
    fire(target, 'drop', dt);
    fire(src, 'dragend', dt);
  });
}
const col = (k: string) => el.querySelector(`[data-column="${k}"]`)!;

beforeEach(() => {
  engine.store.setState({
    machines: {
      w_a: { workerId: 'w_a', label: 'Alpha', workerPub: 'x', online: true, lastSeenAt: null, version: '3' },
      w_b: { workerId: 'w_b', label: 'Beta', workerPub: 'y', online: false, lastSeenAt: null, version: '3' },
    },
    machineConn: {},
    projects: {
      p_1: { id: 'p_1', name: 'Proj One', description: '', paths: {}, createdAt: T, updatedAt: T },
      p_2: { id: 'p_2', name: 'Proj Two', description: '', paths: {}, createdAt: T, updatedAt: T },
    },
    cards: {
      c_in: card('c_in', { projectId: 'p_1', order: 1 }),
      c_in2: card('c_in2', { order: 2 }),
      c_in3: card('c_in3', { order: 5 }),
      c_q: card('c_q', { state: 'queued', workerId: 'w_b', projectId: 'p_2', order: 3 }),
      c_rev: card('c_rev', { state: 'review', workerId: 'w_a', sessionId: 's_2', projectId: 'p_1', error: 'boom' }),
    },
  });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  el.remove();
  vi.restoreAllMocks();
});

describe('BoardPage', () => {
  it('renders inbox, one queued column per machine, running, review, done', async () => {
    await render(<BoardPage />);
    const titles = Array.from(el.querySelectorAll('[data-column] h2')).map((h) => h.textContent);
    expect(titles).toEqual(['收件箱', '待开始 · Alpha', '待开始 · Beta', '进行中', '待验收', '完成']);
    expect(col('queued:w_b').className).toMatch(/\boffline\b/);
    expect(col('queued:w_a').className).not.toMatch(/\boffline\b/);
    expect(col('queued:w_b').querySelector('[data-card="c_q"]')).not.toBeNull();
  });

  it('dropping on a machine column (even offline) dispatches the card there at the end', async () => {
    const spy = vi.spyOn(engine, 'updateCard').mockResolvedValue(card('c_in', {}));
    await render(<BoardPage />);
    await drag('c_in', col('queued:w_b'));
    expect(spy).toHaveBeenCalledWith('c_in', { state: 'queued', workerId: 'w_b', order: 4 });
  });

  it('dropping on 完成 moves the card to done', async () => {
    const spy = vi.spyOn(engine, 'updateCard').mockResolvedValue(card('c_in', {}));
    await render(<BoardPage />);
    await drag('c_in', col('done'));
    expect(spy).toHaveBeenCalledWith('c_in', { state: 'done' });
  });

  it('进行中 / 待验收 do not accept drops', async () => {
    const spy = vi.spyOn(engine, 'updateCard').mockResolvedValue(card('c_in', {}));
    await render(<BoardPage />);
    await drag('c_in', col('running'));
    await drag('c_in', col('review'));
    expect(spy).not.toHaveBeenCalled();
  });

  it('dropping on a card in the same column reorders between neighbours', async () => {
    const spy = vi.spyOn(engine, 'updateCard').mockResolvedValue(card('c_in', {}));
    await render(<BoardPage />);
    await drag('c_in3', el.querySelector('[data-card="c_in2"]')!);
    expect(spy).toHaveBeenLastCalledWith('c_in3', { state: 'inbox', order: 1.5 });
    await drag('c_in2', el.querySelector('[data-card="c_in"]')!);
    expect(spy).toHaveBeenLastCalledWith('c_in2', { state: 'inbox', order: 0 });
  });

  it('cards show project, machine, error and a session link', async () => {
    await render(<BoardPage />);
    const c = el.querySelector('[data-card="c_rev"]')!;
    expect(c.textContent).toContain('Proj One');
    expect(c.textContent).toContain('Alpha');
    expect(c.textContent).toContain('boom');
    expect(c.querySelector('a')?.getAttribute('href')).toBe('/s/w_a/s_2');
  });

  it('删除 asks for confirmation, then deletes the card', async () => {
    const spy = vi.spyOn(engine, 'deleteCard').mockResolvedValue(undefined);
    const ask = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    await render(<BoardPage />);
    const btn = el.querySelector<HTMLButtonElement>('[data-card="c_in"] button[data-action="delete"]')!;
    expect(btn).not.toBeNull();
    await act(async () => { btn.click(); });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(spy).not.toHaveBeenCalled();
    await act(async () => { btn.click(); });
    expect(ask).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenCalledWith('c_in');
  });

  it('删除 is only hidden on hover-capable devices (always visible on touch)', async () => {
    await render(<BoardPage />);
    const btn = el.querySelector<HTMLButtonElement>('[data-card="c_in"] button[data-action="delete"]')!;
    const cls = btn.className.split(/\s+/);
    expect(cls).not.toContain('opacity-0');
    expect(cls).toContain('[@media(hover:hover)]:opacity-0');
    expect(cls).toContain('group-hover:opacity-100');
    expect(cls).toContain('focus-visible:opacity-100');
  });

  it('project filter limits cards', async () => {
    await render(<BoardPage />);
    const sel = el.querySelector<HTMLSelectElement>('select[data-filter="project"]')!;
    await act(async () => {
      sel.value = 'p_1';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(el.querySelector('[data-card="c_in"]')).not.toBeNull();
    expect(el.querySelector('[data-card="c_rev"]')).not.toBeNull();
    expect(el.querySelector('[data-card="c_q"]')).toBeNull();
    expect(el.querySelector('[data-card="c_in2"]')).toBeNull();
  });
});
