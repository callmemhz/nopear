// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { engine } from '../engine';
import { AuthCallbackPage } from './auth-callback';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.scrollTo = () => {};

let el: HTMLDivElement;
let root: Root;
afterEach(async () => {
  await act(async () => { root.unmount(); });
  el.remove();
  vi.restoreAllMocks();
});

describe('AuthCallbackPage', () => {
  it('#error=not_allowed → allowlist message + re-login link; no nonce check, no completeLogin', async () => {
    const complete = vi.spyOn(engine, 'completeLogin').mockResolvedValue();
    history.replaceState(null, '', '/auth/callback?n=whatever#error=not_allowed');
    const rootRoute = createRootRoute({ component: AuthCallbackPage });
    const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ['/'] }) });
    el = document.createElement('div');
    document.body.appendChild(el);
    root = createRoot(el);
    await act(async () => { root.render(<RouterProvider router={router} />); });
    await act(async () => { await router.load(); });
    expect(el.textContent).toContain('该账号不在白名单，请联系管理员');
    expect(el.textContent).not.toContain('已拒绝此登录回调');
    expect(Array.from(el.querySelectorAll('a')).some((a) => a.textContent === '重新登录')).toBe(true);
    expect(complete).not.toHaveBeenCalled();
    expect(location.hash).toBe('');
  });
});
