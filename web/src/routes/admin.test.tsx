// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AccessRequest, AdminMachine, AdminOverview, AdminUser, AllowlistEntry } from '@nopear/protocol';
import { engine } from '../engine';
import { AdminPage } from './admin';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const T = '2026-10-18T00:00:00Z';
const ME = { id: 'u1', email: 'boss@x.com' };
let el: HTMLDivElement;
let root: Root;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
async function render() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  await act(async () => { root.render(<QueryClientProvider client={qc}><AdminPage /></QueryClientProvider>); });
  await flush();
}
const button = (text: string, scope: ParentNode = el) => Array.from(scope.querySelectorAll('button')).find((b) => b.textContent?.includes(text));
const byAttr = (attr: string, v: string) => el.querySelector(`[${attr}="${v}"]`)!;
const tab = async (label: string) => { await act(async () => { button(label, el.querySelector('nav')!)!.click(); }); await flush(); };
function typeInto(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

const overview: AdminOverview = {
  users: 3, disabledUsers: 1, allowlist: 3, pendingRequests: 2, machines: 4, machinesOnline: 3, sessions: 120, cards: 9,
  signups: Array.from({ length: 30 }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, '0')}`, count: i === 29 ? 2 : 0 })),
};
const user = (p: Partial<AdminUser> & { id: string; email: string }): AdminUser => ({
  role: 'member', createdAt: T, lastSeenAt: T, disabled: false, machines: 1, machinesOnline: 1, sessions: 5, apiTokens: 0, ...p,
});
const entry = (email: string, role: 'admin' | 'member'): AllowlistEntry => ({ email, role, addedBy: 'boss@x.com', createdAt: T });
function mockAdmin() {
  const a = engine.admin;
  return {
    overview: vi.spyOn(a, 'overview').mockResolvedValue(overview),
    users: vi.spyOn(a, 'users').mockResolvedValue([
      user({ id: 'u1', email: 'boss@x.com', role: 'admin' }),
      user({ id: 'u2', email: 'mem@x.com' }),
      user({ id: 'u3', email: 'gone@x.com', role: null, disabled: true }),
    ]),
    allowlist: vi.spyOn(engine, 'listAllowlist').mockResolvedValue([entry('boss@x.com', 'admin'), entry('mem@x.com', 'member'), entry('invited@x.com', 'member')]),
    put: vi.spyOn(engine, 'putAllowlist').mockResolvedValue(entry('x@x.com', 'member')),
    del: vi.spyOn(engine, 'deleteAllowlist').mockResolvedValue(),
    setDisabled: vi.spyOn(a, 'setDisabled').mockResolvedValue(),
    requests: vi.spyOn(a, 'requests').mockResolvedValue([
      { email: 'new@x.com', status: 'pending', attempts: 1, requestedAt: T, updatedAt: T },
      { email: 'again@x.com', status: 'pending', attempts: 3, requestedAt: T, updatedAt: T },
      { email: 'no@x.com', status: 'rejected', attempts: 2, requestedAt: T, updatedAt: T },
    ] satisfies AccessRequest[]),
    approve: vi.spyOn(a, 'approve').mockResolvedValue(),
    reject: vi.spyOn(a, 'reject').mockResolvedValue(),
    deleteRequest: vi.spyOn(a, 'deleteRequest').mockResolvedValue(),
    machines: vi.spyOn(a, 'machines').mockResolvedValue([
      { workerId: 'w_a', label: 'mac', ownerId: 'u2', ownerEmail: 'mem@x.com', version: '3.1.0', online: true, lastSeenAt: T, createdAt: T },
      { workerId: 'w_b', label: '', ownerId: null, ownerEmail: null, version: '', online: false, lastSeenAt: null, createdAt: T },
    ] satisfies AdminMachine[]),
    removeMachine: vi.spyOn(a, 'removeMachine').mockResolvedValue({ deleted: false }),
  };
}

afterEach(async () => {
  await act(async () => { root.unmount(); });
  el.remove();
  vi.restoreAllMocks();
});

describe('AdminPage', () => {
  it('members and open mode get an explanation, and never call the admin API', async () => {
    const m = mockAdmin();
    engine.store.setState({ user: ME, access: { role: 'member', allowlistEnabled: true } });
    await render();
    expect(el.textContent).toContain('只有管理员能访问');
    await act(async () => { root.unmount(); }); el.remove();
    engine.store.setState({ user: ME, access: { role: null, allowlistEnabled: false } });
    await render();
    expect(el.textContent).toContain('登录白名单还没启用');
    expect(m.overview).not.toHaveBeenCalled();
    expect(m.users).not.toHaveBeenCalled();
  });

  it('overview: counts, pending badge on the requests tab, 30-day signup bars', async () => {
    mockAdmin();
    engine.store.setState({ user: ME, access: { role: 'admin', allowlistEnabled: true } });
    await render();
    expect(el.textContent).toContain('3 / 4'); // machines online / total
    expect(el.textContent).toContain('其中 1 个已禁用');
    expect(button('加入申请', el.querySelector('nav')!)!.textContent).toContain('2');
    expect(el.querySelectorAll('[role="img"] > div')).toHaveLength(30);
    expect(el.textContent).toContain('共 2 人');
  });

  it('users: roles, sole-admin guard, disable / re-enable, invited-only entries, add by email', async () => {
    const m = mockAdmin();
    engine.store.setState({ user: ME, access: { role: 'admin', allowlistEnabled: true } });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await render();
    await tab('用户');
    const boss = byAttr('data-user', 'boss@x.com');
    expect(boss.textContent).toContain('（你）');
    expect(button('降为成员', boss)!.disabled).toBe(true); // the only admin
    expect(button('禁用', boss)).toBeUndefined(); // never yourself, never an admin
    const mem = byAttr('data-user', 'mem@x.com');
    await act(async () => { button('禁用', mem)!.click(); });
    expect(m.setDisabled).toHaveBeenCalledWith('u2', true);
    const gone = byAttr('data-user', 'gone@x.com');
    expect(gone.textContent).toContain('已禁用');
    expect(gone.textContent).toContain('不在白名单');
    await act(async () => { button('重新启用', gone)!.click(); });
    expect(m.setDisabled).toHaveBeenCalledWith('u3', false);
    await act(async () => { button('设为管理员', mem)!.click(); });
    expect(m.put).toHaveBeenCalledWith('mem@x.com', 'admin');
    expect(el.textContent).toContain('invited@x.com'); // allowlisted, never signed in
    await act(async () => { typeInto(el.querySelector<HTMLInputElement>('input[type="text"]')!, ' friend@x.com '); });
    await act(async () => { button('添加')!.click(); });
    expect(m.put).toHaveBeenCalledWith('friend@x.com', 'member');
  });

  it('requests: approve as member / admin, reject pending, delete a rejected one', async () => {
    const m = mockAdmin();
    engine.store.setState({ user: ME, access: { role: 'admin', allowlistEnabled: true } });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await render();
    await tab('加入申请');
    expect(byAttr('data-request', 'again@x.com').textContent).toContain('尝试登录 3 次');
    expect(el.textContent).not.toContain('no@x.com'); // rejected section is collapsed
    await act(async () => { button('批准为成员', byAttr('data-request', 'new@x.com'))!.click(); });
    expect(m.approve).toHaveBeenCalledWith('new@x.com', 'member');
    await act(async () => { button('批准为管理员', byAttr('data-request', 'again@x.com'))!.click(); });
    expect(m.approve).toHaveBeenCalledWith('again@x.com', 'admin');
    await act(async () => { button('拒绝', byAttr('data-request', 'new@x.com'))!.click(); });
    expect(m.reject).toHaveBeenCalledWith('new@x.com');
    await act(async () => { button('已拒绝')!.click(); });
    await act(async () => { button('删除记录', byAttr('data-request', 'no@x.com'))!.click(); });
    expect(m.deleteRequest).toHaveBeenCalledWith('no@x.com');
  });

  it('machines: owner and status; force-unbind a claimed one, delete an unclaimed record', async () => {
    const m = mockAdmin();
    engine.store.setState({ user: ME, access: { role: 'admin', allowlistEnabled: true } });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await render();
    await tab('机器');
    const a = byAttr('data-machine', 'w_a');
    expect(a.textContent).toContain('mem@x.com');
    expect(a.textContent).toContain('在线');
    expect(byAttr('data-machine', 'w_b').textContent).toContain('未认领');
    await act(async () => { button('强制解绑', a)!.click(); });
    expect(confirm.mock.calls.at(-1)![0]).toContain('mem@x.com');
    expect(m.removeMachine).toHaveBeenCalledWith('w_a');
    await act(async () => { button('删除记录', byAttr('data-machine', 'w_b'))!.click(); });
    expect(m.removeMachine).toHaveBeenCalledWith('w_b');
  });
});
