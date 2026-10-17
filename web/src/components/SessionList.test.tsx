// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import type { Session } from '@nopear/protocol';
import { engine } from '../engine';
import { SessionList } from './SessionList';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.scrollTo = () => {}; // jsdom lacks it; the router's scroll restoration calls it

const T = '2026-10-11T00:00:00Z';
const sess = (id: string, title: string, over: Partial<Session>): Session => ({
  id, workerId: 'w1', kind: 'chat', title, cwd: '', status: 'idle', createdAt: T, lastActivityAt: T, preview: '',
  pinned: false, starred: false, archived: false, model: 'm', thinking: 'off', promptCount: 0, taskCount: 0, ...over,
});

let el: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  engine.store.setState({
    projects: { p_1: { id: 'p_1', name: 'Proj One', description: '', paths: {}, createdAt: T, updatedAt: T } },
    sessions: { w1: {
      a: sess('a', 'Tagged', { projectId: 'p_1', cwd: '/src/one' }),
      b: sess('b', 'Untagged', { cwd: '/src/other-dir/' }),
      c: sess('c', 'Home', { cwd: '/Users/me' }),
      d: sess('d', 'Pinned tagged', { projectId: 'p_1', cwd: '/src/one', pinned: true }),
    } },
  });
  const rootRoute = createRootRoute({ component: () => <SessionList filter="all" /> });
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ['/'] }) });
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  await act(async () => { root.render(<RouterProvider router={router} />); });
  await act(async () => { await router.load(); });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  el.remove();
  engine.store.setState({ projects: {}, sessions: {} });
});

const row = (title: string) => Array.from(el.querySelectorAll('a')).find((a) => a.textContent?.includes(title))!;

describe('SessionList place label', () => {
  it('tagged rows sit under their project group (chip only in 置顶); untagged show the cwd basename (full path on hover); nothing for home', () => {
    const groupOf = (title: string) => row(title).closest('[data-testid="session-group"]')?.getAttribute('data-group');
    expect(groupOf('Tagged')).toBe('p_1');
    expect(row('Tagged').querySelector('[title="项目"]')).toBeNull();
    expect(row('Pinned tagged').querySelector('[title="项目"]')?.textContent).toBe('Proj One');
    expect(groupOf('Untagged')).toBe('__none__');
    const dir = row('Untagged').querySelector('[title="/src/other-dir/"]');
    expect(dir?.textContent).toBe('other-dir');
    expect(row('Home').querySelector('[title="项目"], [title^="/"]')).toBeNull();
  });
});
