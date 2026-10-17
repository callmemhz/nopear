import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { InstallCodeResult } from '@nopear/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { engine, saasClient, useEngine } from '../engine';
import { relativeTime } from '../lib/format';
import { reportError } from './root';
import { isForeignSaas, parseClaimLink } from '../lib/claimLink';

/** 「添加机器」: one-time install code + `curl … | bash` command (installs the worker and auto-claims it to this account). */
function AddMachine({ onClose }: { onClose: () => void }) {
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<InstallCodeResult | null>(null);
  const [copied, setCopied] = useState(false);
  const generate = async () => {
    setBusy(true);
    try { setResult(await engine.createInstallCode(label.trim() || undefined)); setCopied(false); } catch (e) { reportError(e); } finally { setBusy(false); }
  };
  const copy = (text: string) => { navigator.clipboard.writeText(text).then(() => setCopied(true), reportError); };
  return (
    <div className="card mt-4 space-y-2 p-3 text-xs">
      <div className="flex gap-2">
        <input className="input text-xs" placeholder="机器名称（可选）" value={label} onChange={(e) => setLabel(e.target.value)} />
        <button className="btn-primary shrink-0 text-xs" disabled={busy} onClick={() => void generate()}>{result ? '重新生成' : '生成安装命令'}</button>
        <button className="btn-ghost shrink-0 text-xs" onClick={onClose}>关闭</button>
      </div>
      {result && (
        <>
          <p className="muted">在新机器（WSL2 / Linux）的终端执行下面的命令：安装依赖与 worker、注册为 systemd 用户服务，并自动认领到你的账号。</p>
          <div className="flex items-center gap-2">
            <code className="surface min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded p-2 font-mono">{result.command}</code>
            <button className="btn-ghost shrink-0 text-xs" onClick={() => copy(result.command)}>{copied ? '已复制' : '复制'}</button>
          </div>
          <p className="muted">安装码一次性有效，{new Date(result.expiresAt).toLocaleString('zh-CN')} 前可用。</p>
        </>
      )}
    </div>
  );
}

export function MachinesPage() {
  const machines = useEngine((s) => s.machines);
  const conn = useEngine((s) => s.machineConn);
  const myPub = useEngine((s) => s.clientPub);
  const qc = useQueryClient();
  const clients = useQuery({ queryKey: ['clients'], queryFn: () => saasClient().listClients() });
  const [link, setLink] = useState('');
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);

  const claim = async () => {
    const p = parseClaimLink(link);
    if (!p) { reportError(new Error('无效的认领链接')); return; }
    if (isForeignSaas(p, engine.store.getState().saasUrl)
      && !confirm(`该链接指向另一个 SaaS（${p.saasUrl}），而当前登录的是 ${engine.store.getState().saasUrl}。仍要在当前 SaaS 上认领吗？`)) return;
    try { await engine.claim(p.workerId, p.claimToken); setLink(''); } catch (e) { reportError(e); }
  };
  const list = Object.values(machines).sort((a, b) => a.label.localeCompare(b.label));
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-8 px-6 py-10">
        <section>
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <h1 className="text-xl font-semibold tracking-tight">机器</h1>
              <p className="muted mt-1 text-sm">每台机器运行一个 worker，经 SaaS 中转（可在设置里开启端到端加密）。</p>
            </div>
            <button className="btn-primary shrink-0" onClick={() => setAdding(!adding)}>＋ 添加机器</button>
          </div>
          {adding && <AddMachine onClose={() => setAdding(false)} />}
          <div className="card mt-4 flex gap-2 p-3">
            <input className="input font-mono text-xs" placeholder="粘贴 worker 终端打印的认领链接（…/claim?w=…&t=…）" value={link} onChange={(e) => setLink(e.target.value)} />
            <button className="btn-primary shrink-0" disabled={!link.trim()} onClick={() => void claim()}>认领</button>
          </div>
          <div className="mt-4 space-y-2">
            {list.length === 0 && <p className="muted text-sm">还没有认领任何机器。</p>}
            {list.map((m) => {
              const online = m.online && conn[m.workerId] !== 'offline';
              const edit = editing[m.workerId];
              return (
                <div key={m.workerId} className="card flex items-center gap-3 p-3 text-sm">
                  <span className={`h-2 w-2 rounded-full ${online ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-600'}`} />
                  <div className="min-w-0 flex-1">
                    {edit !== undefined ? (
                      <input className="input h-7 max-w-xs py-0" autoFocus value={edit}
                        onChange={(e) => setEditing({ ...editing, [m.workerId]: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') setEditing({});
                          if (e.key === 'Enter') { engine.renameMachine(m.workerId, edit.trim()).catch(reportError); setEditing({}); }
                        }} />
                    ) : <div className="font-medium">{m.label || m.workerId}</div>}
                    <div className="muted font-mono text-[11px]">{m.workerId} · v{m.version || '?'} · {online ? '在线' : m.lastSeenAt ? `离线（${relativeTime(m.lastSeenAt)}）` : '离线'}</div>
                  </div>
                  <Link to="/memory/$workerId" params={{ workerId: m.workerId }} className="btn-ghost text-xs" title="编辑这台机器的 AGENTS.md 记忆">机器记忆</Link>
                  <button className="btn-ghost text-xs" onClick={() => setEditing({ [m.workerId]: m.label })}>重命名</button>
                  <button className="btn-danger text-xs" onClick={() => { if (confirm(`解绑「${m.label || m.workerId}」？worker 会回到未认领状态。`)) engine.removeMachine(m.workerId).catch(reportError); }}>解绑</button>
                </div>
              );
            })}
          </div>
        </section>
        <section>
          <h2 className="text-sm font-semibold">已登记客户端</h2>
          <p className="muted mt-1 text-xs">每个浏览器 / 手机一把密钥。吊销后它将无法再解密或控制你的机器。</p>
          <div className="mt-3 space-y-1.5">
            {clients.isLoading && <p className="muted text-xs">加载中…</p>}
            {clients.data?.clients.map((c) => (
              <div key={c.clientPub} className="card flex items-center gap-3 px-3 py-2 text-xs">
                <span className="font-medium">{c.label}</span>
                {c.clientPub === myPub && <span className="chip">当前</span>}
                <span className="muted min-w-0 flex-1 truncate font-mono">{c.clientPub}</span>
                <span className="muted">{relativeTime(c.createdAt)}</span>
                <button className="btn-danger px-2 py-0.5 text-xs" onClick={async () => {
                  if (!confirm(c.clientPub === myPub ? '吊销当前浏览器？之后需要重新登录。' : `吊销「${c.label}」？`)) return;
                  try { await saasClient().deleteClient(c.clientPub); await qc.invalidateQueries({ queryKey: ['clients'] }); } catch (e) { reportError(e); }
                }}>吊销</button>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
