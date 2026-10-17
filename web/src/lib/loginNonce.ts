// OAuth login CSRF guard: the Google callback only accepts a token for a login this tab started.
// Without it, an attacker could send a callback link carrying THEIR token, silently logging the
// victim into the attacker's account (any machine the victim then claims lands in that account).
const KEY = 'nopear.loginNonce';

function randomNonce(): string {
  const b = new Uint8Array(18);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Create and remember a fresh nonce for the login about to start in this tab. */
export function issueLoginNonce(): string {
  const n = randomNonce();
  sessionStorage.setItem(KEY, n);
  return n;
}

/** True iff `n` equals the nonce this tab issued. The stored nonce is consumed either way. */
export function checkLoginNonce(n: string | null | undefined): boolean {
  const stored = sessionStorage.getItem(KEY);
  sessionStorage.removeItem(KEY);
  return !!n && !!stored && n === stored;
}
