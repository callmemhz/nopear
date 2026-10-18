import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AccessRequest, AdminMachine, AdminUser, AllowlistEntry, AllowlistRole } from '@nopear/protocol';
import { engine, useEngine } from '../engine';
import { relativeTime } from '../lib/format';
import { reportError } from './root';

const ROLE_LABEL: Record<AllowlistRole, string> = { admin: '管理员', member: '成员' };
type Tab = 'overview' | 'users' | 'requests' | 'machines';
const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: '概览' },
  { id: 'users', label: '用户' },
  { id: 'requests', label: '加入申请' },
  { id: 'machines', label: '机器' },
];

/** Admin queries share one key prefix so any mutation refreshes the whole console (counts move together). */
const KEY = ['admin'] as const;
export function useAdminOverview(enabled = true) {
  return useQuery({ queryKey: [...KEY, 'overview'], queryFn: () => engine.admin.overview(), enabled, refetchInterval: 60_000 });
}

function useRun() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); } catch (e) { reportError(e); } finally {
      setBusy(false);
      await qc.invalidateQueries({ queryKey: KEY });
      await qc.invalidateQueries({ queryKey: ['allowlist'] });
    }
  };
  return { busy, run };
}

function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: 'warn' }) {
  return (
    <div className="card p-4">
      <div className="muted text-xs">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : ''}`}>{value}</div>
      {hint && <div className="muted mt-0.5 text-[11px]">{hint}</div>}
    </div>
  );
}

function Overview({ go }: { go: (t: Tab) => void }) {
  const q = useAdminOverview();
  if (q.isLoading) return <p className="muted text-xs">加载中…</p>;
  if (q.isError || !q.data) return <p className="text-xs text-red-500">{String(q.error)}</p>;
  const o = q.data;
  const max = Math.max(1, ...o.signups.map((d) => d.count));
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="用户" value={o.users} hint={o.disabledUsers ? `其中 ${o.disabledUsers} 个已禁用` : '没有被禁用的账号'} />
        <Stat label="白名单" value={o.allowlist} hint="可以登录的邮箱" />
        <button className="text-left" onClick={() => go('requests')} title="查看加入申请">
          <Stat label="待审批申请" value={o.pendingRequests} tone={o.pendingRequests ? 'warn' : undefined} hint={o.pendingRequests ? '点这里处理' : '暂无'} />
        </button>
        <Stat label="在线机器" value={`${o.machinesOnline} / ${o.machines}`} hint="已认领的机器" />
        <Stat label="会话" value={o.sessions} hint="所有账号合计" />
        <Stat label="卡片" value={o.cards} hint="所有账号合计" />
      </div>
      <section className="card p-4">
        <div className="mb-3 flex items-baseline justify-between">
          <h3 className="text-sm font-medium">最近 30 天新注册</h3>
          <span className="muted text-xs">共 {o.signups.reduce((n, d) => n + d.count, 0)} 人</span>
        </div>
        <div className="flex h-24 items-end gap-1" role="img" aria-label="最近 30 天每天新注册人数">
          {o.signups.map((d) => (
            <div key={d.date} title={`${d.date}：${d.count} 人`} className="flex-1 rounded-t bg-accent/70"
              style={{ height: `${d.count ? Math.max(8, (d.count / max) * 100) : 2}%`, opacity: d.count ? 1 : 0.25 }} />
          ))}
        </div>
        <div className="muted mt-1 flex justify-between text-[11px]"><span>{o.signups[0]?.date}</span><span>今天</span></div>
      </section>
    </div>
  );
}

/** Registered users merged with allowlist entries that never signed in ("已邀请"). */
function Users() {
  const me = useEngine((s) => s.user?.id ?? null);
  const users = useQuery({ queryKey: [...KEY, 'users'], queryFn: () => engine.admin.users() });
  const allow = useQuery({ queryKey: ['allowlist'], queryFn: () => engine.listAllowlist() });
  const { busy, run } = useRun();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<AllowlistRole>('member');
  if (users.isLoading || allow.isLoading) return <p className="muted text-xs">加载中…</p>;
  if (users.isError) return <p className="text-xs text-red-500">{String(users.error)}</p>;
  const list = users.data ?? [];
  const entries = allow.data ?? [];
  const registered = new Set(list.map((u) => u.email.toLowerCase()));
  const invited = entries.filter((e) => !registered.has(e.email));
  const admins = entries.filter((e) => e.role === 'admin').length;
  const add = () => { const e = email.trim(); if (e) void run(async () => { await engine.putAllowlist(e, role); setEmail(''); }); };
  const setRoleOf = (e: string, r: AllowlistRole) => run(() => engine.putAllowlist(e, r));
  const unlist = (e: string) => {
    if (!confirm(`把 ${e} 移出白名单？他将无法再登录，已登录的设备和 MCP token 会立即失效。`)) return;
    void run(() => engine.deleteAllowlist(e));
  };
  const toggle = (u: AdminUser) => {
    if (!u.disabled && !confirm(`禁用 ${u.email}？他会被立即登出、MCP token 失效，他的机器也会断开连接，直到你重新启用。`)) return;
    void run(() => engine.admin.setDisabled(u.id, !u.disabled));
  };
  return (
    <div className="space-y-4">
      <form className="card flex gap-2 p-3" onSubmit={(ev) => { ev.preventDefault(); add(); }}>
        <input className="input text-xs" type="text" placeholder="直接加入白名单：someone@example.com" value={email} onChange={(ev) => setEmail(ev.target.value)} />
        <select className="input w-28 shrink-0 text-xs" value={role} onChange={(ev) => setRole(ev.target.value as AllowlistRole)}>
          <option value="member">{ROLE_LABEL.member}</option>
          <option value="admin">{ROLE_LABEL.admin}</option>
        </select>
        <button type="submit" className="btn-primary shrink-0 text-xs" disabled={busy || !email.trim()}>添加</button>
      </form>
      <div className="card overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="muted border-b border-line">
            <tr>{['用户', '角色', '机器', '会话', 'MCP token', '注册', '最近活跃', ''].map((h) => <th key={h} className="px-3 py-2 font-normal">{h}</th>)}</tr>
          </thead>
          <tbody>
            {list.map((u) => {
              const sole = u.role === 'admin' && admins <= 1;
              return (
                <tr key={u.id} data-user={u.email} className="border-b border-line last:border-0">
                  <td className="px-3 py-2">
                    <span className={`font-medium ${u.disabled ? 'line-through opacity-60' : ''}`}>{u.email}</span>
                    {u.id === me && <span className="muted ml-1">（你）</span>}
                    {u.disabled && <span className="ml-2 rounded bg-red-500/10 px-1.5 py-0.5 text-[11px] text-red-600 dark:text-red-400">已禁用</span>}
                  </td>
                  <td className="px-3 py-2">{u.role ? ROLE_LABEL[u.role] : <span className="muted">不在白名单</span>}</td>
                  <td className="px-3 py-2 tabular-nums">{u.machinesOnline} / {u.machines}</td>
                  <td className="px-3 py-2 tabular-nums">{u.sessions}</td>
                  <td className="px-3 py-2 tabular-nums">{u.apiTokens}</td>
                  <td className="muted px-3 py-2">{relativeTime(u.createdAt)}</td>
                  <td className="muted px-3 py-2">{u.lastSeenAt ? relativeTime(u.lastSeenAt) : '—'}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    {u.role === 'admin' && <button className="btn-ghost px-2 py-0.5 text-xs" disabled={busy || sole} title={sole ? '至少保留一名管理员' : undefined} onClick={() => void setRoleOf(u.email, 'member')}>降为成员</button>}
                    {u.role === 'member' && <button className="btn-ghost px-2 py-0.5 text-xs" disabled={busy} onClick={() => void setRoleOf(u.email, 'admin')}>设为管理员</button>}
                    {!u.role && <button className="btn-ghost px-2 py-0.5 text-xs" disabled={busy} onClick={() => void setRoleOf(u.email, 'member')}>加入白名单</button>}
                    {u.role && u.id !== me && <button className="btn-ghost px-2 py-0.5 text-xs" disabled={busy || sole} onClick={() => unlist(u.email)}>移出白名单</button>}
                    {u.id !== me && u.role !== 'admin' && (
                      <button className={`${u.disabled ? 'btn-ghost' : 'btn-danger'} px-2 py-0.5 text-xs`} disabled={busy} onClick={() => toggle(u)}>{u.disabled ? '重新启用' : '禁用'}</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {invited.length > 0 && (
        <section className="space-y-1.5">
          <h3 className="muted text-xs">已在白名单、还没登录过</h3>
          {invited.map((e: AllowlistEntry) => (
            <div key={e.email} className="card flex items-center gap-3 px-3 py-2 text-xs">
              <span className="min-w-0 flex-1 truncate font-medium">{e.email}</span>
              <span className="muted">{ROLE_LABEL[e.role]}</span>
              <span className="muted">{e.addedBy} 添加于 {relativeTime(e.createdAt)}</span>
              <button className="btn-ghost px-2 py-0.5 text-xs" disabled={busy || (e.role === 'admin' && admins <= 1)} onClick={() => unlist(e.email)}>移出</button>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

function Requests() {
  const q = useQuery({ queryKey: [...KEY, 'requests'], queryFn: () => engine.admin.requests(), refetchInterval: 30_000 });
  const { busy, run } = useRun();
  const [showRejected, setShowRejected] = useState(false);
  if (q.isLoading) return <p className="muted text-xs">加载中…</p>;
  if (q.isError) return <p className="text-xs text-red-500">{String(q.error)}</p>;
  const pending = (q.data ?? []).filter((r) => r.status === 'pending');
  const rejected = (q.data ?? []).filter((r) => r.status === 'rejected');
  const row = (r: AccessRequest) => (
    <div key={r.email} data-request={r.email} className="card flex flex-wrap items-center gap-3 px-3 py-2 text-xs">
      <span className="min-w-0 flex-1 truncate font-medium">{r.email}</span>
      <span className="muted">首次 {relativeTime(r.requestedAt)}</span>
      <span className="muted">{r.attempts > 1 ? `尝试登录 ${r.attempts} 次，最近 ${relativeTime(r.updatedAt)}` : ''}</span>
      <button className="btn-primary px-2 py-0.5 text-xs" disabled={busy} onClick={() => void run(() => engine.admin.approve(r.email, 'member'))}>批准为成员</button>
      <button className="btn-ghost px-2 py-0.5 text-xs" disabled={busy}
        onClick={() => { if (confirm(`批准 ${r.email} 为管理员？管理员可以管理所有用户和机器。`)) void run(() => engine.admin.approve(r.email, 'admin')); }}>批准为管理员</button>
      {r.status === 'pending'
        ? <button className="btn-danger px-2 py-0.5 text-xs" disabled={busy} onClick={() => void run(() => engine.admin.reject(r.email))}>拒绝</button>
        : <button className="btn-ghost px-2 py-0.5 text-xs" disabled={busy} onClick={() => void run(() => engine.admin.deleteRequest(r.email))}>删除记录</button>}
    </div>
  );
  return (
    <div className="space-y-4">
      <p className="muted text-xs">不在白名单里的人用 Google 登录时，会自动提交加入申请。批准后对方重新登录即可；拒绝后他再登录也不会再出现在这里。</p>
      {pending.length === 0 ? <div className="card muted p-6 text-center text-xs">没有待处理的申请</div> : <div className="space-y-1.5">{pending.map(row)}</div>}
      {rejected.length > 0 && (
        <section className="space-y-1.5">
          <button className="muted text-xs hover:text-ink" onClick={() => setShowRejected(!showRejected)}>{showRejected ? '▾' : '▸'} 已拒绝（{rejected.length}）</button>
          {showRejected && rejected.map(row)}
        </section>
      )}
    </div>
  );
}

function Machines() {
  const q = useQuery({ queryKey: [...KEY, 'machines'], queryFn: () => engine.admin.machines(), refetchInterval: 30_000 });
  const { busy, run } = useRun();
  if (q.isLoading) return <p className="muted text-xs">加载中…</p>;
  if (q.isError) return <p className="text-xs text-red-500">{String(q.error)}</p>;
  const list = q.data ?? [];
  const remove = (m: AdminMachine) => {
    const msg = m.ownerId
      ? `把「${m.label}」从 ${m.ownerEmail} 的账号强制解绑？它进行中的卡片会退回收件箱，机器需要重新认领才能再用。`
      : `删除未认领的机器记录「${m.label || m.workerId}」？`;
    if (confirm(msg)) void run(() => engine.admin.removeMachine(m.workerId));
  };
  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead className="muted border-b border-line">
          <tr>{['机器', '归属', '版本', '状态', '最后在线', '注册', ''].map((h) => <th key={h} className="px-3 py-2 font-normal">{h}</th>)}</tr>
        </thead>
        <tbody>
          {list.length === 0 && <tr><td colSpan={7} className="muted px-3 py-6 text-center">还没有机器</td></tr>}
          {list.map((m) => (
            <tr key={m.workerId} data-machine={m.workerId} className="border-b border-line last:border-0">
              <td className="px-3 py-2"><div className="font-medium">{m.label || '（未命名）'}</div><div className="muted font-mono text-[11px]">{m.workerId}</div></td>
              <td className="px-3 py-2">{m.ownerEmail ?? <span className="muted">未认领</span>}</td>
              <td className="muted px-3 py-2">{m.version || '—'}</td>
              <td className="px-3 py-2"><span className={`mr-1.5 inline-block h-2 w-2 rounded-full ${m.online ? 'bg-emerald-500' : 'bg-zinc-400'}`} />{m.online ? '在线' : '离线'}</td>
              <td className="muted px-3 py-2">{m.lastSeenAt ? relativeTime(m.lastSeenAt) : '—'}</td>
              <td className="muted px-3 py-2">{relativeTime(m.createdAt)}</td>
              <td className="px-3 py-2 text-right">
                <button className="btn-danger px-2 py-0.5 text-xs" disabled={busy} onClick={() => remove(m)}>{m.ownerId ? '强制解绑' : '删除记录'}</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AdminPage() {
  const access = useEngine((s) => s.access);
  const [tab, setTab] = useState<Tab>('overview');
  const isAdmin = !!access?.allowlistEnabled && access.role === 'admin';
  const ov = useAdminOverview(isAdmin);
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-6 px-6 py-10">
        <h1 className="text-xl font-semibold tracking-tight">管理后台</h1>
        {!access ? <p className="muted text-xs">加载中…</p> : !access.allowlistEnabled ? (
          <div className="card p-4 text-xs">登录白名单还没启用，所以没有管理员。到「设置」里启用白名单（会把你设为管理员）后再来。</div>
        ) : !isAdmin ? (
          <div className="card p-4 text-xs">只有管理员能访问管理后台。</div>
        ) : (
          <>
            <nav className="flex gap-1 border-b border-line" aria-label="管理后台">
              {TABS.map((t) => (
                <button key={t.id} onClick={() => setTab(t.id)} aria-current={tab === t.id ? 'page' : undefined}
                  className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === t.id ? 'border-ink font-medium text-ink' : 'border-transparent text-subtle hover:text-ink'}`}>
                  {t.label}
                  {t.id === 'requests' && !!ov.data?.pendingRequests && (
                    <span className="ml-1.5 rounded-full bg-amber-500 px-1.5 text-[11px] font-semibold text-white">{ov.data.pendingRequests}</span>
                  )}
                </button>
              ))}
            </nav>
            {tab === 'overview' && <Overview go={setTab} />}
            {tab === 'users' && <Users />}
            {tab === 'requests' && <Requests />}
            {tab === 'machines' && <Machines />}
          </>
        )}
      </div>
    </div>
  );
}
