import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { SaasError } from '@nopear/core';
import { engine, saasClient, useEngine } from '../engine';
import { issueLoginNonce } from '../lib/loginNonce';

const RETURN_KEY = 'nopear.loginReturn';
/** Shown when SaaS refuses a login because the email is not on the login allowlist. */
export const NOT_ALLOWED_MESSAGE = '该账号不在白名单，请联系管理员';
/** Signed in from outside the allowlist: an access request was filed for an admin to approve. */
export const ACCESS_PENDING_MESSAGE = '已提交加入申请，等管理员批准后重新登录即可';

function loginError(e: unknown): string {
  if (e instanceof SaasError && e.status === 403 && e.code === 'forbidden') return NOT_ALLOWED_MESSAGE;
  return e instanceof Error ? e.message : String(e);
}

export function LoginPage() {
  const search = useSearch({ from: '/login' });
  const navigate = useNavigate();
  const saasUrl = useEngine((s) => s.saasUrl);
  const config = useQuery({ queryKey: ['saas-config', saasUrl], queryFn: () => saasClient().config() });
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const after = () => {
    // href (not `to`) so the query string of e.g. /claim?w=..&t=.. survives login.
    void navigate({ href: safeReturnPath(search.redirect) });
  };
  const google = () => {
    const back = safeReturnPath(search.redirect);
    if (back !== '/') sessionStorage.setItem(RETURN_KEY, back);
    const n = issueLoginNonce(); // CSRF guard: callback only accepts a token for a login this tab started
    location.href = saasClient().googleStartUrl(`${location.origin}/auth/callback?n=${encodeURIComponent(n)}`);
  };
  const dev = async () => {
    setBusy(true); setErr(null);
    try { await engine.loginDev(email.trim()); after(); } catch (e) { setErr(loginError(e)); } finally { setBusy(false); }
  };

  return (
    <div className="flex h-full items-center justify-center bg-zinc-50 p-6 dark:bg-zinc-950">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-2.5">
          <img src="/favicon.svg" alt="" className="h-9 w-9 shrink-0" />
          <div>
            <div className="text-[15px] font-semibold">NoPear</div>
            <div className="muted text-xs">远程派活给你的每一台机器</div>
          </div>
        </div>
        <div className="card space-y-4 p-6 shadow-sm">
          <h1 className="text-base font-semibold">登录</h1>
          {config.isError && <p className="text-sm text-red-600">无法连接 SaaS：{String(config.error)}</p>}
          {config.data?.googleEnabled && (
            <button className="btn-primary w-full justify-center py-2" onClick={google}>使用 Google 登录</button>
          )}
          {config.data?.devLogin && (
            <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void dev(); }}>
              <label className="muted block text-xs">开发登录（SAAS_DEV_LOGIN）</label>
              <input className="input" type="email" required placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
              <button className="btn-ghost w-full justify-center border panel" disabled={busy || !email}>{busy ? '登录中…' : '开发登录'}</button>
            </form>
          )}
          {config.data && !config.data.googleEnabled && !config.data.devLogin && <p className="muted text-sm">SaaS 未启用任何登录方式。</p>}
          {err && <p className="text-sm text-red-600">{err}</p>}
        </div>
        <p className="muted mt-4 text-center text-xs">SaaS：{saasUrl}</p>
      </div>
    </div>
  );
}

/** Only same-origin relative paths ("/x", not "//host" or "/\\host"), never back to /login. Fallback "/". */
export function safeReturnPath(back: string | null | undefined): string {
  if (!back || !back.startsWith('/') || back.startsWith('//') || back.startsWith('/\\')) return '/';
  try {
    const u = new URL(back, location.origin);
    if (u.origin !== location.origin || u.pathname.startsWith('/login')) return '/';
    return u.pathname + u.search + u.hash;
  } catch {
    return '/';
  }
}

export function takeLoginReturn(): string {
  const v = sessionStorage.getItem(RETURN_KEY);
  sessionStorage.removeItem(RETURN_KEY);
  return safeReturnPath(v);
}
