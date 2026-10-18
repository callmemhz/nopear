// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AllowlistEntry } from '@nopear/protocol';
import { engine } from '../engine';
import { Members } from './settings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ME = { id: 'u1', email: 'boss@x.com' };
let el: HTMLDivElement;
let root: Root;
async function render() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  await act(async () => { root.render(<QueryClientProvider client={qc}><Members /></QueryClientProvider>); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const button = (text: string, scope: ParentNode = el) => Array.from(scope.querySelectorAll('button')).find((b) => b.textContent?.includes(text));

const entry = (email: string, role: 'admin' | 'member'): AllowlistEntry => ({ email, role, addedBy: 'bootstrap', createdAt: '2026-10-11T00:00:00Z' });

afterEach(async () => {
  await act(async () => { root.unmount(); });
  el.remove();
  vi.restoreAllMocks();
});

describe('Settings → 成员 (login allowlist)', () => {
  it('access null → renders nothing', async () => {
    engine.store.setState({ user: ME, access: null });
    const list = vi.spyOn(engine, 'listAllowlist');
    await render();
    expect(el.textContent).toBe('');
    expect(list).not.toHaveBeenCalled();
  });

  it('member → renders nothing', async () => {
    engine.store.setState({ user: ME, access: { role: 'member', allowlistEnabled: true } });
    const list = vi.spyOn(engine, 'listAllowlist');
    await render();
    expect(el.textContent).toBe('');
    expect(list).not.toHaveBeenCalled();
  });

  it('open mode → notice + enable button that makes me admin', async () => {
    engine.store.setState({ user: ME, access: { role: null, allowlistEnabled: false } });
    const put = vi.spyOn(engine, 'putAllowlist').mockResolvedValue(entry(ME.email, 'admin'));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await render();
    expect(el.textContent).toContain('白名单未启用：任何人都能登录');
    await act(async () => { button('启用白名单（把我设为管理员）')!.click(); });
    expect(put).toHaveBeenCalledWith('boss@x.com', 'admin');
  });

  it('admin → points to the admin console (members are managed there)', async () => {
    engine.store.setState({ user: ME, access: { role: 'admin', allowlistEnabled: true } });
    const list = vi.spyOn(engine, 'listAllowlist');
    await render();
    expect(el.querySelector('a[href="/admin"]')?.textContent).toContain('管理后台');
    expect(list).not.toHaveBeenCalled();
  });
});
