// Parses a worker claim link `<saas>/claim?w=<workerId>&t=<claimToken>` (printed by the worker / its QR code).
// Hand-rolled instead of `URL`/`URLSearchParams`: React Native's URL polyfill does not implement searchParams.
export interface ClaimLink { workerId: string; claimToken: string; saasUrl: string }

function queryParams(query: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of query.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const k = eq < 0 ? part : part.slice(0, eq);
    const v = eq < 0 ? '' : part.slice(eq + 1);
    try {
      out.set(decodeURIComponent(k.replace(/\+/g, ' ')), decodeURIComponent(v.replace(/\+/g, ' ')));
    } catch { /* malformed escape: skip */ }
  }
  return out;
}

export function parseClaimLink(input: string): ClaimLink | null {
  const m = /^(https?:\/\/[^/?#\s]+)((?:\/[^?#\s]*)?)\?([^#\s]*)(?:#\S*)?$/i.exec(input.trim());
  if (!m) return null;
  const [, origin = '', path = '', query = ''] = m;
  if (!/\/claim\/?$/.test(path)) return null;
  const q = queryParams(query);
  const workerId = q.get('w')?.trim() ?? '';
  const claimToken = q.get('t')?.trim() ?? '';
  if (!workerId || !claimToken) return null;
  return { workerId, claimToken, saasUrl: `${origin}${path.replace(/\/claim\/?$/, '')}` };
}
