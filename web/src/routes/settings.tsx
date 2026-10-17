import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AllowlistEntry, AllowlistRole } from '@nopear/protocol';
import { engine, useEngine } from '../engine';
import { relativeTime } from '../lib/format';
import { reportError } from './root';

/** MCP client config example for a personal API token (Claude Code / Cursor …). */
export function mcpConfig(saasUrl: string, token: string): string {
  const url = `${saasUrl.replace(/\/+$/, '')}/mcp`;
  return JSON.stringify({ mcpServers: { nopear: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
}

function copy(text: string) {
  navigator.clipboard.writeText(text).catch(reportError);
}

function E2eToggle() {
  const settings = useEngine((s) => s.settings);
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    if (!settings) return;
    const on = !settings.e2e;
    if (on && !confirm('开启端到端加密后，SaaS 将无法读写机器数据：跨机器会话工具（session_history / session_start / session_tag）不可用。继续？')) return;
    setBusy(true);
    try { await engine.setE2e(on); } catch (e) { reportError(e); } finally { setBusy(false); }
  };
  return (
    <section className="card flex items-center gap-4 p-4">
      <div className="flex-1">
        <div className="text-sm font-medium">端到端加密（E2E）</div>
        <p className="muted mt-1 text-xs">开启后客户端与机器之间的数据面帧全部加密，诚实的 SaaS 只见密文；跨机器会话类工具仅在关闭时可用。注意此开关由 SaaS 下发，被攻破的 SaaS 可将机器切回明文；需要硬保证请在该机器的 worker 设 NOPEAR_E2E=required。</p>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={settings?.e2e ?? false} disabled={!settings || busy} onChange={() => void toggle()} />
        {settings ? (settings.e2e ? '已开启' : '已关闭') : '加载中…'}
      </label>
    </section>
  );
}

/** Account auto-compaction: start summarizing old context once it reaches `thresholdTokens`. */
function AutoCompact() {
  const settings = useEngine((s) => s.settings);
  const ac = settings?.autoCompact;
  const [threshold, setThreshold] = useState('');
  const [keep, setKeep] = useState('');
  const [busy, setBusy] = useState(false);
  const k = (n: number) => String(Math.round(n / 1000));
  const shownThreshold = threshold || (ac ? k(ac.thresholdTokens) : '');
  const shownKeep = keep || (ac ? k(ac.keepRecentTokens) : '');
  const save = async (patch: Parameters<typeof engine.setAutoCompact>[0]) => {
    setBusy(true);
    try { await engine.setAutoCompact(patch); setThreshold(''); setKeep(''); } catch (e) { reportError(e); } finally { setBusy(false); }
  };
  const dirty = !!ac && ((threshold !== '' && threshold !== k(ac.thresholdTokens)) || (keep !== '' && keep !== k(ac.keepRecentTokens)));
  const kTokens = (v: string) => Number(v) * 1000;
  return (
    <section className="card space-y-3 p-4">
      <div className="flex items-center gap-4">
        <div className="flex-1">
          <div className="text-sm font-medium">自动压缩上下文</div>
          <p className="muted mt-1 text-xs">会话上下文涨到阈值时，把较早的内容压成摘要，避免超过模型上限导致整轮请求被拒。压缩有损，完整历史仍保留在会话里。</p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={ac?.enabled ?? true} disabled={!ac || busy} onChange={() => void save({ enabled: !ac?.enabled })} />
          {ac ? (ac.enabled ? '已开启' : '已关闭') : '加载中…'}
        </label>
      </div>
      <div className="flex flex-wrap items-end gap-4 text-sm">
        <label className="flex flex-col gap-1">
          <span className="muted text-xs">压缩阈值（千 tokens，20–900）</span>
          <input type="number" min={20} max={900} className="input w-32" value={shownThreshold} disabled={!ac || busy}
            onChange={(e) => setThreshold(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="muted text-xs">保留最近（千 tokens，1–200）</span>
          <input type="number" min={1} max={200} className="input w-32" value={shownKeep} disabled={!ac || busy}
            onChange={(e) => setKeep(e.target.value)} />
        </label>
        <button className="btn-primary" disabled={!dirty || busy}
          onClick={() => void save({ thresholdTokens: kTokens(shownThreshold), keepRecentTokens: kTokens(shownKeep) })}>保存</button>
      </div>
    </section>
  );
}

function ApiTokens() {
  const saasUrl = useEngine((s) => s.saasUrl);
  const qc = useQueryClient();
  const tokens = useQuery({ queryKey: ['apiTokens'], queryFn: () => engine.listApiTokens() });
  const [label, setLabel] = useState('');
  const [fresh, setFresh] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      setFresh(await engine.createApiToken(label.trim() || 'MCP'));
      setLabel('');
      await qc.invalidateQueries({ queryKey: ['apiTokens'] });
    } catch (e) { reportError(e); } finally { setBusy(false); }
  };
  const remove = async (id: string, l: string) => {
    if (!confirm(`删除 token「${l}」？使用它的 MCP 客户端将无法再访问。`)) return;
    try { await engine.deleteApiToken(id); await qc.invalidateQueries({ queryKey: ['apiTokens'] }); } catch (e) { reportError(e); }
  };
  const config = fresh ? mcpConfig(saasUrl, fresh) : '';
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold">个人 API token</h2>
        <p className="muted mt-1 text-xs">给 Claude Code / Cursor 等 MCP 客户端访问 SaaS 工具（项目、卡片、记忆、机器、会话）。</p>
      </div>
      <div className="card flex gap-2 p-3">
        <input className="input text-xs" placeholder="名称（如 laptop claude code）" value={label} onChange={(e) => setLabel(e.target.value)} />
        <button className="btn-primary shrink-0 text-xs" disabled={busy} onClick={() => void create()}>生成 token</button>
      </div>
      {fresh && (
        <div className="card space-y-2 border-amber-300 p-3 text-xs dark:border-amber-800">
          <div className="font-medium text-amber-700 dark:text-amber-300">token 只显示这一次，请立即复制保存。</div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate font-mono">{fresh}</code>
            <button className="btn-ghost text-xs" onClick={() => copy(fresh)}>复制</button>
          </div>
          <div className="muted">MCP 配置示例：</div>
          <pre className="surface overflow-x-auto rounded p-2 font-mono text-[11px]">{config}</pre>
          <div className="flex justify-end gap-2">
            <button className="btn-ghost text-xs" onClick={() => copy(config)}>复制配置</button>
            <button className="btn-ghost text-xs" onClick={() => setFresh(null)}>我已保存</button>
          </div>
        </div>
      )}
      <div className="space-y-1.5">
        {tokens.isLoading && <p className="muted text-xs">加载中…</p>}
        {tokens.isError && <p className="text-xs text-red-500">{String(tokens.error)}</p>}
        {tokens.data?.length === 0 && <p className="muted text-xs">还没有 token。</p>}
        {tokens.data?.map((t) => (
          <div key={t.id} className="card flex items-center gap-3 px-3 py-2 text-xs">
            <span className="min-w-0 flex-1 truncate font-medium">{t.label}</span>
            <span className="muted">创建于 {relativeTime(t.createdAt)}</span>
            <span className="muted">{t.lastUsedAt ? `最近使用 ${relativeTime(t.lastUsedAt)}` : '从未使用'}</span>
            <button className="btn-danger px-2 py-0.5 text-xs" onClick={() => void remove(t.id, t.label)}>删除</button>
          </div>
        ))}
      </div>
    </section>
  );
}

const ROLE_LABEL: Record<AllowlistRole, string> = { admin: '管理员', member: '成员' };

/** Login allowlist (成员). Hidden when logged out / `access` not loaded, and for members of an enabled list. */
export function Members() {
  const access = useEngine((s) => s.access);
  if (!access) return null;
  if (!access.allowlistEnabled) return <MembersOpenMode />;
  if (access.role !== 'admin') return null;
  return <MembersAdmin />;
}

function MembersOpenMode() {
  const email = useEngine((s) => s.user?.email ?? null);
  const [busy, setBusy] = useState(false);
  const enable = async () => {
    if (!email) return;
    if (!confirm(`启用登录白名单并把 ${email} 设为管理员？启用后只有名单内的邮箱能登录。`)) return;
    setBusy(true);
    try { await engine.putAllowlist(email, 'admin'); } catch (e) { reportError(e); } finally { setBusy(false); }
  };
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold">成员</h2>
      <div className="card flex items-center gap-4 p-4">
        <p className="flex-1 text-xs text-amber-700 dark:text-amber-300">白名单未启用：任何人都能登录。</p>
        <button className="btn-primary shrink-0 text-xs" disabled={busy || !email} onClick={() => void enable()}>启用白名单（把我设为管理员）</button>
      </div>
    </section>
  );
}

function MembersAdmin() {
  const qc = useQueryClient();
  const entries = useQuery({ queryKey: ['allowlist'], queryFn: () => engine.listAllowlist() });
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<AllowlistRole>('member');
  const [busy, setBusy] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['allowlist'] });
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); await refresh(); } catch (e) { reportError(e); } finally { setBusy(false); }
  };
  const add = () => {
    const e = email.trim();
    if (!e) return;
    void run(async () => { await engine.putAllowlist(e, role); setEmail(''); });
  };
  const remove = (e: AllowlistEntry) => {
    if (!confirm(`把 ${e.email} 移出白名单？其已登录的设备与 MCP token 将立即失效。`)) return;
    void run(() => engine.deleteAllowlist(e.email));
  };
  const admins = entries.data?.filter((e) => e.role === 'admin').length ?? 0;
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold">成员</h2>
        <p className="muted mt-1 text-xs">登录白名单：只有名单内的邮箱能登录；管理员可管理名单。移出后其已签发的登录与 MCP token 在下一次请求即失效。</p>
      </div>
      <form className="card flex gap-2 p-3" onSubmit={(ev) => { ev.preventDefault(); add(); }}>
        <input className="input text-xs" name="allowlist-email" type="text" placeholder="邮箱（如 someone@example.com）" value={email} onChange={(ev) => setEmail(ev.target.value)} />
        <select className="input w-28 shrink-0 text-xs" value={role} onChange={(ev) => setRole(ev.target.value as AllowlistRole)}>
          <option value="member">{ROLE_LABEL.member}</option>
          <option value="admin">{ROLE_LABEL.admin}</option>
        </select>
        <button type="submit" className="btn-primary shrink-0 text-xs" disabled={busy || !email.trim()}>添加</button>
      </form>
      <div className="space-y-1.5">
        {entries.isLoading && <p className="muted text-xs">加载中…</p>}
        {entries.isError && <p className="text-xs text-red-500">{String(entries.error)}</p>}
        {entries.data?.map((e) => {
          const sole = e.role === 'admin' && admins <= 1;
          return (
            <div key={e.email} data-email={e.email} className="card flex items-center gap-3 px-3 py-2 text-xs">
              <span className="min-w-0 flex-1 truncate font-medium">{e.email}</span>
              <span className="muted">{ROLE_LABEL[e.role]}</span>
              <span className="muted">添加人 {e.addedBy}</span>
              <span className="muted">{relativeTime(e.createdAt)}</span>
              {sole && <span className="muted">至少保留一名管理员</span>}
              {e.role === 'admin' ? (
                <button className="btn-ghost px-2 py-0.5 text-xs" disabled={busy || sole} onClick={() => void run(() => engine.putAllowlist(e.email, 'member'))}>降为成员</button>
              ) : (
                <button className="btn-ghost px-2 py-0.5 text-xs" disabled={busy} onClick={() => void run(() => engine.putAllowlist(e.email, 'admin'))}>设为管理员</button>
              )}
              <button className="btn-danger px-2 py-0.5 text-xs" disabled={busy || sole} onClick={() => remove(e)}>移除</button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function SettingsPage() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-8 px-6 py-10">
        <h1 className="text-xl font-semibold tracking-tight">设置</h1>
        <E2eToggle />
        <AutoCompact />
        <Members />
        <ApiTokens />
      </div>
    </div>
  );
}
