import { useState } from 'react';
import { Link, useSearch } from '@tanstack/react-router';
import { engine, useEngine } from '../engine';

/** Claim landing page. Never auto-claims: the user sees which machine and which SaaS, then confirms with one click. */
export function ClaimPage() {
  const { w, t } = useSearch({ from: '/app/claim' });
  const saasUrl = useEngine((s) => s.saasUrl);
  const email = useEngine((s) => s.user?.email ?? null);
  const [state, setState] = useState<'confirm' | 'working' | 'ok' | 'error'>(w && t ? 'confirm' : 'error');
  const [err, setErr] = useState(w && t ? '' : '认领链接缺少参数');
  const claim = () => {
    if (!w || !t) return;
    setState('working');
    engine.claim(w, t).then(() => setState('ok'), (e) => { setState('error'); setErr(e instanceof Error ? e.message : String(e)); });
  };
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="card w-full max-w-md space-y-3 p-6 text-sm">
        <h1 className="text-base font-semibold">认领机器</h1>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="muted">机器</dt><dd className="break-all font-mono">{w || '—'}</dd>
          <dt className="muted">SaaS</dt><dd className="break-all font-mono">{saasUrl}</dd>
          <dt className="muted">账号</dt><dd className="break-all">{email ?? '…'}</dd>
        </dl>
        {state === 'confirm' && (
          <>
            <p className="muted">确认后，这台机器将归属你当前登录的账号，并能执行你派发的任务。只认领你自己的机器。</p>
            <button className="btn-primary w-full justify-center" onClick={claim}>认领</button>
          </>
        )}
        {state === 'working' && <p className="muted">正在认领…</p>}
        {state === 'ok' && <p className="text-emerald-600">认领成功，这台机器已归属你的账号。</p>}
        {state === 'error' && <p className="text-red-600">认领失败：{err}（链接可能已过期，请在 worker 终端获取新链接）</p>}
        <div className="flex gap-2 pt-2">
          <Link to="/machines" className="btn-ghost border panel">机器列表</Link>
          <Link to="/" className="btn-ghost border panel">进入控制台</Link>
        </div>
      </div>
    </div>
  );
}
