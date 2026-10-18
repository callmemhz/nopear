import type { SaasStore } from './store';

/** 登录白名单（allowlist）判定的唯一实现。与 OAuth 回跳白名单（`config.redirectAllowlist`）无关。 */

/** 存取、比较前统一规范化；不做 Gmail 点号/别名归一。 */
export function normalizeEmail(s: string): string {
  return s.trim().toLowerCase();
}

export function isValidEmail(s: string): boolean {
  return /^[^@\s]+@[^@\s]+$/.test(normalizeEmail(s));
}

/** 名单为空 = 未启用（开放模式）→ 一律放行；否则仅名单内邮箱。 */
export async function loginAllowed(store: SaasStore, email: string): Promise<boolean> {
  if ((await store.allowlist.count()) === 0) return true;
  return (await store.allowlist.get(normalizeEmail(email))) !== null;
}

/** The single "may this account act" check: not disabled by an admin, and allowed by the login allowlist. */
export async function accountUsable(store: SaasStore, user: { email: string; disabledAt: string | null }): Promise<boolean> {
  return !user.disabledAt && loginAllowed(store, user.email);
}
