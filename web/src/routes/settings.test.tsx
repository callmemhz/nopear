// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AllowlistEntry } from '@nopear/protocol';
import { engine } from '../engine';
import { Members } from './settings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const T = '2026-10-11T00:00:00Z';
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
const row = (email: string) => Array.from(el.querySelectorAll('[data-email]')).find((r) => r.getAttribute('data-email') === email)!;
function typeInto(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
const entry = (email: string, role: 'admin' | 'member'): AllowlistEntry => ({ email, role, addedBy: 'bootstrap', createdAt: T });

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

  it('admin → list, add, change role, remove; the only admin cannot be removed or demoted', async () => {
    engine.store.setState({ user: ME, access: { role: 'admin', allowlistEnabled: true } });
    const list = vi.spyOn(engine, 'listAllowlist').mockResolvedValue([entry('boss@x.com', 'admin'), { ...entry('m@x.com', 'member'), addedBy: 'boss@x.com' }]);
    const put = vi.spyOn(engine, 'putAllowlist').mockResolvedValue(entry('new@x.com', 'member'));
    const del = vi.spyOn(engine, 'deleteAllowlist').mockResolvedValue();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await render();
    expect(list).toHaveBeenCalled();
    expect(el.textContent).toContain('m@x.com');
    expect(row('m@x.com').textContent).toContain('boss@x.com'); // addedBy
    // sole admin: remove + demote disabled with a hint
    expect(button('移除', row('boss@x.com'))!.disabled).toBe(true);
    expect(button('降为成员', row('boss@x.com'))!.disabled).toBe(true);
    expect(row('boss@x.com').textContent).toContain('至少保留一名管理员');
    expect(button('移除', row('m@x.com'))!.disabled).toBe(false);
    // add
    await act(async () => { typeInto(el.querySelector<HTMLInputElement>('input[name="allowlist-email"]')!, ' new@x.com '); });
    await act(async () => { button('添加')!.click(); });
    expect(put).toHaveBeenCalledWith('new@x.com', 'member');
    // change role
    await act(async () => { button('设为管理员', row('m@x.com'))!.click(); });
    expect(put).toHaveBeenCalledWith('m@x.com', 'admin');
    // remove
    await act(async () => { button('移除', row('m@x.com'))!.click(); });
    expect(del).toHaveBeenCalledWith('m@x.com');
  });

  it('admin with two admins → both rows can be removed / demoted', async () => {
    engine.store.setState({ user: ME, access: { role: 'admin', allowlistEnabled: true } });
    vi.spyOn(engine, 'listAllowlist').mockResolvedValue([entry('a2@x.com', 'admin'), entry('boss@x.com', 'admin')]);
    await render();
    expect(button('移除', row('boss@x.com'))!.disabled).toBe(false);
    expect(button('降为成员', row('a2@x.com'))!.disabled).toBe(false);
    expect(el.textContent).not.toContain('至少保留一名管理员');
  });
});
