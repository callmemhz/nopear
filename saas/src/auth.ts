import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** sha256 hex of a bearer token (only the hash is stored). */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

const b64 = (b: Buffer): string => b.toString('base64url');

/** OAuth `state`: base64url(JSON payload) + "." + base64url(HMAC-SHA256). */
export function signState(secret: string, payload: { redirect: string; exp: number }): string {
  const body = b64(Buffer.from(JSON.stringify(payload), 'utf8'));
  const mac = b64(createHmac('sha256', secret).update(body).digest());
  return `${body}.${mac}`;
}

export function verifyState(secret: string, state: string, now: number): { redirect: string } | null {
  const parts = state.split('.');
  if (parts.length !== 2) return null;
  const [body, mac] = parts as [string, string];
  const expected = createHmac('sha256', secret).update(body).digest();
  let got: Buffer;
  try { got = Buffer.from(mac, 'base64url'); } catch { return null; }
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { redirect?: unknown; exp?: unknown };
    if (typeof p.redirect !== 'string' || typeof p.exp !== 'number' || p.exp < now) return null;
    return { redirect: p.redirect };
  } catch {
    return null;
  }
}

/**
 * Allowed: same origin as publicUrl, or an allowlist entry match.
 * http(s) entries must match the URL origin exactly (and, if the entry has a path, the redirect path must
 * start with it) — never a raw string prefix (`https://a.com` must not admit `https://a.com.evil.com`).
 * Custom-scheme entries (e.g. `nopear://`) are prefix-matched.
 */
export function isAllowedRedirect(url: string, publicUrl: string, allowlist: string[]): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  try {
    if (u.origin !== 'null' && u.origin === new URL(publicUrl).origin) return true;
  } catch { /* bad publicUrl */ }
  return allowlist.some((p) => {
    if (p.length === 0) return false;
    if (/^https?:\/\//i.test(p)) {
      let e: URL;
      try { e = new URL(p); } catch { return false; }
      if (u.origin !== e.origin) return false;
      const base = e.pathname.replace(/\/+$/, '');
      return base === '' || u.pathname === base || u.pathname.startsWith(base + '/');
    }
    return url.startsWith(p);
  });
}

/** Constant-time string equality (length leak only). */
export function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
