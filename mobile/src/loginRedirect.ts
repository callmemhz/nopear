// Login redirect parsing (Google OAuth comes back to nopear://auth#token=… or #error=…).

/** Shown when SaaS refuses a login because the email is not on the login allowlist. */
export const NOT_ALLOWED_MESSAGE = '该账号不在白名单，请联系管理员';
/** Signed in from outside the allowlist: an access request was filed for an admin to approve. */
export const ACCESS_PENDING_MESSAGE = '已提交加入申请，等管理员批准后重新登录即可';

/** Title + message for a login the server refused (`#error=` code). */
export function loginErrorAlert(code: string): [string, string] {
  if (code === 'access_pending') return ['已提交申请', ACCESS_PENDING_MESSAGE];
  return ['登录失败', code === 'not_allowed' ? NOT_ALLOWED_MESSAGE : code];
}

/** `nopear://auth#error=not_allowed` (or `?error=`) → error code; null when the redirect carries no error. */
export function loginErrorFromRedirect(url: string): string | null {
  const m = /[#?&]error=([^&#]+)/.exec(url);
  return m ? decodeURIComponent(m[1]!) : null;
}
