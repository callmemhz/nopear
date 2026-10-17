// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import type { Project, Session } from '@nopear/protocol';
import { engine } from '../engine';
import { Sidebar } from './Sidebar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.scrollTo = () => {};

const T = (n: number) => `2026-10-11T00:00:${String(n).padStart(2, '0')}Z`;
const sess = (id: string, title: string, at: number, over: Partial<Session> = {}): Session => ({
  id, workerId: 'w1', kind: 'chat', title, cwd: '', status: 'idle', createdAt: T(0), lastActivityAt: T(at), preview: '',
  pinned: false, starred: false, archived: false, model: 'm', thinking: 'off', promptCount: 0, taskCount: 0, ...over,
});
const proj = (id: string, name: string, paths: Record<string, string>): Project => ({ id, name, description: '', paths, createdAt: T(0), updatedAt: T(0) });

let el: HTMLDivElement;
let root: Root;

async function mount() {
  const rootRoute = createRootRoute({ component: () => <Sidebar /> });
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ['/'] }) });
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  await act(async () => { root.render(<RouterProvider router={router} />); });
  await act(async () => { await router.load(); });
}
async function unmount() {
  await act(async () => { root.unmount(); });
  el.remove();
}

beforeEach(async () => {
  localStorage.clear();
  engine.store.setState({
    user: { id: 'u', email: 'sue.max@example.com' },
    machines: {
      w1: { workerId: 'w1', label: 'box', workerPub: '', online: true, lastSeenAt: null, version: '3.1.0' },
      w2: { workerId: 'w2', label: 'lap', workerPub: '', online: false, lastSeenAt: null, version: '3.1.0' },
    },
    machineConn: {},
    projects: { p1: proj('p1', 'Alpha', { w1: '/src/alpha' }), p2: proj('p2', 'Beta', {}) },
    sessions: { w1: {
      a1: sess('a1', 'Alpha old', 1, { projectId: 'p1' }),
      a2: sess('a2', 'Alpha new', 3, { projectId: 'p1' }),
      b1: sess('b1', 'Beta work', 5, { projectId: 'p2', preview: 'deploy login page' }),
      n1: sess('n1', 'Loose chat', 9),
      pin: sess('pin', 'Pinned one', 2, { pinned: true, projectId: 'p1' }),
    } },
  });
  await mount();
});
afterEach(async () => {
  await unmount();
  vi.restoreAllMocks();
  engine.store.setState({ projects: {}, sessions: {}, machines: {}, user: null });
});

const groups = () => Array.from(el.querySelectorAll('[data-testid="session-group"]'));
const groupNames = () => groups().map((g) => g.querySelector('button[aria-expanded]')!.textContent);
const rowTitles = () => Array.from(el.querySelectorAll('a[href^="/s/"]')).map((a) => a.querySelector('span.truncate')!.textContent);
const header = (name: string) => groups().find((g) => g.getAttribute('data-group') === name)!.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
function typeInto(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('Sidebar', () => {
  it('shows 置顶, then project groups by latest activity, 未分类 last', () => {
    expect(el.textContent).toContain('置顶');
    expect(groupNames()).toEqual(['Beta1', 'Alpha2', '未分类1']);
    expect(rowTitles()).toEqual(['Pinned one', 'Beta work', 'Alpha new', 'Alpha old', 'Loose chat']);
  });

  it('nav, account and machines summary', () => {
    for (const label of ['新会话', '快速记一条', '看板', '项目', '记忆', '机器']) expect(el.querySelector('nav')!.textContent).toContain(label);
    expect(el.textContent).toContain('sue.max@example.com');
    expect(el.textContent).toContain('SM');
    expect(el.textContent).toContain('1 台在线');
    expect(el.querySelector('a[aria-label="设置"]')).not.toBeNull();
  });

  it('collapsing a group hides its rows and persists across remounts', async () => {
    await act(async () => { header('p1').click(); });
    expect(header('p1').getAttribute('aria-expanded')).toBe('false');
    expect(rowTitles()).not.toContain('Alpha new');
    expect(JSON.parse(localStorage.getItem('nopear.sidebarCollapsed')!)).toEqual(['p1']);
    await unmount();
    await mount();
    expect(header('p1').getAttribute('aria-expanded')).toBe('false');
    expect(rowTitles()).not.toContain('Alpha old');
    await act(async () => { header('p1').click(); });
    expect(rowTitles()).toContain('Alpha old');
    expect(JSON.parse(localStorage.getItem('nopear.sidebarCollapsed')!)).toEqual([]);
  });

  it('search filters sessions by title / preview', async () => {
    const input = el.querySelector<HTMLInputElement>('input[aria-label="搜索会话"]')!;
    await act(async () => { typeInto(input, 'login'); });
    expect(rowTitles()).toEqual(['Beta work']);
    expect(groupNames()).toEqual(['Beta1']);
    await act(async () => { typeInto(input, 'alpha'); });
    expect(rowTitles()).toEqual(['Alpha new', 'Alpha old']);
    await act(async () => { typeInto(input, 'nothing-like-this'); });
    expect(el.textContent).toContain('没有匹配的会话');
  });

  it('starred / archived filters live in the filter menu', async () => {
    await act(async () => { el.querySelector<HTMLButtonElement>('button[aria-label="筛选会话"]')!.click(); });
    const archived = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === '归档')!;
    await act(async () => { archived.click(); });
    expect(el.textContent).toContain('没有归档的会话');
    expect(el.querySelector('select[title="按项目筛选"]')).not.toBeNull();
  });

  it('group ＋ opens the new-session dialog prefilled with the project tag and its path on an online machine', async () => {
    const plus = el.querySelector<HTMLButtonElement>('button[aria-label="在「Alpha」新建会话"]')!;
    expect(el.querySelector('button[aria-label="在「未分类」新建会话"]')).toBeNull();
    await act(async () => { plus.click(); });
    expect(el.textContent).toContain('新建会话');
    expect(el.querySelector<HTMLSelectElement>('select[title="项目标签"]')!.value).toBe('p1');
    expect(el.querySelector<HTMLInputElement>('input[aria-label="工作目录"]')!.value).toBe('/src/alpha');
    const spy = vi.spyOn(engine, 'createSession').mockResolvedValue(sess('new', 'x', 1));
    const ta = el.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(ta, 'do it');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { Array.from(el.querySelectorAll('button')).find((b) => b.textContent === '开始')!.click(); });
    expect(spy).toHaveBeenCalledWith('w1', expect.objectContaining({ projectId: 'p1', cwd: '/src/alpha', text: 'do it' }));
  });
});
