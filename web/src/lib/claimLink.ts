// Parses a worker claim link `<saas>/claim?w=<workerId>&t=<claimToken>` — same rules as mobile/src/claimLink.ts:
// http(s) only, path must end in /claim, both w and t non-empty.
export interface ClaimLink { workerId: string; claimToken: string; saasUrl: string }

export function parseClaimLink(input: string): ClaimLink | null {
  let u: URL;
  try { u = new URL(input.trim()); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!/\/claim\/?$/.test(u.pathname)) return null;
  const workerId = u.searchParams.get('w')?.trim() ?? '';
  const claimToken = u.searchParams.get('t')?.trim() ?? '';
  if (!workerId || !claimToken) return null;
  return { workerId, claimToken, saasUrl: u.origin + u.pathname.replace(/\/claim\/?$/, '') };
}

/** True when the link targets a different SaaS than the one this console is logged into. */
export function isForeignSaas(link: ClaimLink, currentSaasUrl: string): boolean {
  const norm = (s: string) => s.replace(/\/+$/, '');
  return norm(link.saasUrl) !== norm(currentSaasUrl);
}
