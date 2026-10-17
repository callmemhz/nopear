// Login redirect parsing (Google OAuth comes back to nopear://auth#token=… or #error=…).

/** Shown when SaaS refuses a login because the email is not on the login allowlist. */
export const NOT_ALLOWED_MESSAGE = '该账号不在白名单，请联系管理员';

/** `nopear://auth#error=not_allowed` (or `?error=`) → error code; null when the redirect carries no error. */
export function loginErrorFromRedirect(url: string): string | null {
  const m = /[#?&]error=([^&#]+)/.exec(url);
  return m ? decodeURIComponent(m[1]!) : null;
}
