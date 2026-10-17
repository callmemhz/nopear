// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { emptyTimeline } from '@nopear/core';
import type { Message, Session } from '@nopear/protocol';
import { engine } from '../engine';
import { SessionPage } from './session';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.scrollTo = () => {};

const T = '2026-10-11T00:00:00Z';
const session = (over: Partial<Session> = {}): Session => ({
  id: 's1', workerId: 'w1', kind: 'chat', title: 'Fix the bug', cwd: '/src/app', status: 'idle', createdAt: T, lastActivityAt: T, preview: '',
  pinned: false, starred: false, archived: false, model: 'm1', thinking: 'medium', promptCount: 0, taskCount: 0, projectId: 'p1', ...over,
});
const msg = (id: string, role: Message['role'], blocks: Message['blocks']): Message => ({ id, sessionId: 's1', role, blocks, ts: T, status: 'complete' });

let el: HTMLDivElement;
let root: Root;

async function mount(s: Session, messages: Message[] = []) {
  engine.store.setState({
    machines: { w1: { workerId: 'w1', label: 'box', workerPub: '', online: true, lastSeenAt: null, version: '3.1.0' } },
    machineConn: {},
    projects: { p1: { id: 'p1', name: 'Alpha', description: '', paths: {}, createdAt: T, updatedAt: T } },
    sessions: { w1: { s1: s } },
    timelines: { 'w1/s1': { ...emptyTimeline(), session: s, messages, cursor: 'c1' } },
  });
  const rootRoute = createRootRoute();
  const sessionRoute = createRoute({ getParentRoute: () => rootRoute, path: '/s/$workerId/$sessionId', component: SessionPage });
  const router = createRouter({ routeTree: rootRoute.addChildren([sessionRoute]), history: createMemoryHistory({ initialEntries: ['/s/w1/s1'] }) });
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  await act(async () => {
    root.render(<QueryClientProvider client={new QueryClient()}><RouterProvider router={router} /></QueryClientProvider>);
  });
  await act(async () => { await router.load(); });
}

beforeEach(() => {
  vi.spyOn(engine, 'openSession').mockImplementation(() => {});
  vi.spyOn(engine, 'closeSession').mockImplementation(() => {});
  vi.spyOn(engine, 'rpc').mockImplementation((async () => ({ path: '/src/app', entries: [], truncated: false })) as never);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  el.remove();
  vi.restoreAllMocks();
  engine.store.setState({ machines: {}, sessions: {}, timelines: {}, projects: {} });
});

const q = <T extends Element = HTMLElement>(sel: string) => el.querySelector<T & HTMLElement>(sel);

describe('SessionPage', () => {
  it('top bar: title, project chip, machine, 文件 / 后台任务 / 更多', async () => {
    await mount(session());
    expect(q('header button[title="点击改名"]')!.textContent).toBe('Fix the bug');
    expect(q<HTMLSelectElement>('select[title="项目标签"]')!.value).toBe('p1');
    expect(q('header')!.textContent).toContain('box');
    expect(q('button[aria-label="文件"]')).not.toBeNull();
    expect(q('button[aria-label="后台任务"]')).not.toBeNull();
    expect(q('button[aria-label="更多"]')).not.toBeNull();
  });

  it('rename inline', async () => {
    const spy = vi.spyOn(engine, 'updateSession').mockResolvedValue();
    await mount(session());
    await act(async () => { q('header button[title="点击改名"]')!.click(); });
    const input = q<HTMLInputElement>('input[aria-label="会话标题"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'New name');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(spy).toHaveBeenCalledWith('w1', 's1', { title: 'New name' });
  });

  it('文件 toggles the side panel on the files tab; 后台任务 switches tab', async () => {
    await mount(session());
    expect(q('[role="tablist"]')).toBeNull();
    await act(async () => { q('button[aria-label="文件"]')!.click(); });
    expect(q('[role="tab"][aria-selected="true"]')!.textContent).toBe('文件');
    await act(async () => { q('button[aria-label="后台任务"]')!.click(); });
    expect(q('[role="tab"][aria-selected="true"]')!.textContent).toContain('后台任务');
    expect(el.textContent).toContain('没有后台任务');
    await act(async () => { q('button[aria-label="后台任务"]')!.click(); });
    expect(q('[role="tablist"]')).toBeNull();
  });

  it('更多 menu holds pin / star / archive / fork', async () => {
    const spy = vi.spyOn(engine, 'updateSession').mockResolvedValue();
    await mount(session());
    await act(async () => { q('button[aria-label="更多"]')!.click(); });
    const item = (label: string) => Array.from(el.querySelectorAll('[role="menuitem"]')).find((b) => b.textContent === label) as HTMLElement;
    expect(item('分叉')).toBeTruthy();
    expect(item('机器记忆')).toBeTruthy();
    expect(el.textContent).toContain('/src/app');
    await act(async () => { item('星标').click(); });
    expect(spy).toHaveBeenCalledWith('w1', 's1', { starred: true });
  });

  it('renders grouped tool calls and the composer with model pickers; running shows 中断', async () => {
    const interrupt = vi.spyOn(engine, 'interrupt').mockResolvedValue();
    await mount(session({ status: 'running' }), [
      msg('u1', 'user', [{ type: 'text', text: 'go' }]),
      msg('a1', 'assistant', [{ type: 'tool_call', id: 'c1', name: 'bash', input: { command: 'ls' } }, { type: 'tool_call', id: 'c2', name: 'bash', input: { command: 'pwd' } }]),
      msg('t1', 'tool', [{ type: 'tool_result', toolCallId: 'c1', toolName: 'bash', text: 'ok', isError: false }, { type: 'tool_result', toolCallId: 'c2', toolName: 'bash', text: 'bad', isError: true }]),
      msg('a2', 'assistant', [{ type: 'text', text: 'All done' }]),
    ]);
    const group = q('[data-testid="tool-group"]')!;
    expect(group.querySelector('button')!.textContent).toBe('运行了 2 条命令（1 条失败）');
    expect(el.textContent).toContain('All done');
    expect(q('select[title="模型"]')).not.toBeNull();
    expect(q('select[title="思考强度"]')).not.toBeNull();
    await act(async () => { q('button[aria-label="中断"]')!.click(); });
    expect(interrupt).toHaveBeenCalledWith('w1', 's1');
  });
});
