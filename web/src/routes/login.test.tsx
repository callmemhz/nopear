// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { SaasClient, SaasError } from '@nopear/core';
import { engine } from '../engine';
import { LoginPage } from './login';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.scrollTo = () => {};

let el: HTMLDivElement;
let root: Root;
afterEach(async () => {
  await act(async () => { root.unmount(); });
  el.remove();
  vi.restoreAllMocks();
});

async function render() {
  const rootRoute = createRootRoute();
  const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/login',
    validateSearch: (s: Record<string, unknown>) => ({ redirect: typeof s.redirect === 'string' ? s.redirect : undefined }),
    component: LoginPage,
  });
  const router = createRouter({ routeTree: rootRoute.addChildren([loginRoute]), history: createMemoryHistory({ initialEntries: ['/login'] }) });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  await act(async () => { root.render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>); });
  await act(async () => { await router.load(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
function typeInto(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('LoginPage', () => {
  it('dev login 403 forbidden → allowlist message', async () => {
    vi.spyOn(SaasClient.prototype, 'config').mockResolvedValue({ googleEnabled: false, devLogin: true, publicUrl: 'http://x' });
    vi.spyOn(engine, 'loginDev').mockRejectedValue(new SaasError(403, 'forbidden', 'email not allowed'));
    await render();
    await act(async () => { typeInto(el.querySelector<HTMLInputElement>('input[type="email"]')!, 'x@y.com'); });
    await act(async () => { el.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(el.textContent).toContain('该账号不在白名单，请联系管理员');
  });
});
