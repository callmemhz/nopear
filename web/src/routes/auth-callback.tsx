import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { engine, ready } from '../engine';
import { NOT_ALLOWED_MESSAGE, takeLoginReturn } from './login';
import { checkLoginNonce } from '../lib/loginNonce';

export function AuthCallbackPage() {
  const navigate = useNavigate();
  const [err, setErr] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  const [notAllowed, setNotAllowed] = useState(false);
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
    const token = hash.get('token');
    const nonce = new URLSearchParams(location.search).get('n');
    history.replaceState(null, '', location.pathname); // never keep the token in the URL bar/history
    // SaaS refused the login (not on the login allowlist): no token was issued, so nothing to verify or complete.
    if (hash.get('error') === 'not_allowed') { setNotAllowed(true); return; }
    // Only accept a token for a login started in this tab (blocks login-CSRF / account swap).
    if (!checkLoginNonce(nonce)) { setRefused(true); return; }
    if (!token) { setErr('回调中没有 token'); return; }
    void (async () => {
      try {
        await ready;
        await engine.completeLogin(token);
        void navigate({ href: takeLoginReturn() }); // href keeps the query (/claim?w&t)
      } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    })();
  }, [navigate]);
  return (
    <div className="flex h-full items-center justify-center text-sm">
      {notAllowed ? (
        <span className="text-red-600">
          {NOT_ALLOWED_MESSAGE}。<Link to="/login" search={{ redirect: undefined }} className="underline">重新登录</Link>
        </span>
      ) : refused ? (
        <span className="text-red-600">
          已拒绝此登录回调：它不是由本页面发起的登录（可能是伪造链接）。<Link to="/login" search={{ redirect: undefined }} className="underline">重新登录</Link>
        </span>
      ) : err ? <span className="text-red-600">登录失败：{err}</span> : <span className="muted">正在完成登录…</span>}
    </div>
  );
}
