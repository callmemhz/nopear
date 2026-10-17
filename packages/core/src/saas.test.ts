import { describe, expect, it } from 'vitest';
import { memoryKV } from './platform';
import { SaasClient, SaasError } from './saas';

function client(handler: (method: string, path: string, body: unknown) => Response) {
  const calls: { method: string; path: string; body?: unknown; auth: string | null }[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const body = init.body !== undefined ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: u.pathname + u.search, ...(body !== undefined ? { body } : {}), auth: new Headers(init.headers).get('authorization') });
    return handler(method, u.pathname, body);
  }) as unknown as typeof fetch;
  const saas = new SaasClient({ baseUrl: 'https://saas.test/', platform: { fetch: f, storage: memoryKV(), secureStorage: memoryKV() }, getToken: () => 'tok' });
  return { saas, calls };
}

const entry = { email: 'a+b@x.com', role: 'member' as const, addedBy: 'boss@x.com', createdAt: '2026-10-11T00:00:00.000Z' };

describe('SaasClient allowlist + me', () => {
  it('me() returns MeResult (role, allowlistEnabled)', async () => {
    const me = { user: { id: 'u', email: 'a@b' }, role: 'admin', allowlistEnabled: true };
    const { saas, calls } = client(() => Response.json(me));
    expect(await saas.me()).toEqual(me);
    expect(calls).toEqual([{ method: 'GET', path: '/api/me', auth: 'Bearer tok' }]);
  });

  it('allowlist / putAllowlist / deleteAllowlist hit /api/admin/allowlist with an encoded email', async () => {
    const { saas, calls } = client((method) => {
      if (method === 'GET') return Response.json({ entries: [entry] });
      if (method === 'PUT') return Response.json({ entry });
      return Response.json({ ok: true });
    });
    expect(await saas.allowlist()).toEqual({ entries: [entry] });
    expect(await saas.putAllowlist('a+b@x.com', 'member')).toEqual({ entry });
    expect(await saas.deleteAllowlist('a+b@x.com')).toBeUndefined();
    expect(calls.map(({ auth: _a, ...c }) => c)).toEqual([
      { method: 'GET', path: '/api/admin/allowlist' },
      { method: 'PUT', path: '/api/admin/allowlist/a%2Bb%40x.com', body: { role: 'member' } },
      { method: 'DELETE', path: '/api/admin/allowlist/a%2Bb%40x.com' },
    ]);
  });

  it('errors surface as SaasError with status + code (e.g. 409 conflict, 403 forbidden)', async () => {
    const { saas } = client(() => Response.json({ error: { code: 'conflict', message: 'last admin' } }, { status: 409 }));
    const err = await saas.deleteAllowlist('boss@x.com').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SaasError);
    expect((err as SaasError).status).toBe(409);
    expect((err as SaasError).code).toBe('conflict');
  });
});
