// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import type { Project } from '@nopear/protocol';
import { engine } from '../engine';
import { ProjectsPage } from './projects';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.scrollTo = () => {}; // jsdom lacks it; the router's scroll restoration calls it

const T = '2026-10-11T00:00:00Z';
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
function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
const button = (text: string) => Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes(text))!;

beforeEach(() => {
  engine.store.setState({
    projects: {
      p_1: { id: 'p_1', name: 'Proj One', description: 'first', paths: {}, createdAt: T, updatedAt: T },
      p_2: { id: 'p_2', name: 'Proj Two', description: '', paths: {}, createdAt: T, updatedAt: T },
    },
  });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  el.remove();
  vi.restoreAllMocks();
});

describe('ProjectsPage', () => {
  it('lists the account projects with links to their detail pages', async () => {
    await render(<ProjectsPage />);
    const links = Array.from(el.querySelectorAll('a')).map((a) => [a.textContent, a.getAttribute('href')]);
    expect(links).toEqual([['Proj One', '/projects/p_1'], ['Proj Two', '/projects/p_2']]);
    expect(el.textContent).toContain('first');
  });

  it('create form calls createProject', async () => {
    const spy = vi.spyOn(engine, 'createProject').mockResolvedValue({ id: 'p_3' } as Project);
    await render(<ProjectsPage />);
    await act(async () => { button('新项目').click(); });
    await act(async () => {
      typeInto(el.querySelector<HTMLInputElement>('input[name="name"]')!, ' New ');
      typeInto(el.querySelector<HTMLTextAreaElement>('textarea[name="description"]')!, 'desc');
    });
    await act(async () => { button('创建').click(); });
    expect(spy).toHaveBeenCalledWith({ name: 'New', description: 'desc' });
  });
});
