import { describe, expect, it } from 'vitest';
import type { RequestHeader } from '@nopear/protocol';
import { b64url, decodeFrame, deriveKey, encodeFrame, fromB64url, generateClientKey, open, seal, utf8 } from './crypto';
import { memoryKV } from './platform';
import { SaasClient } from './saas';
import { RpcCallError, WorkerChannel } from './channel';

const worker = generateClientKey();
const client = generateClientKey();
const WID = 'w_test';
const key = deriveKey(worker.priv, client.pub, WID, client.pub);

type Handler = (h: RequestHeader, url: string, init: RequestInit) => Response | Promise<Response>;
function makeFetch(handler: Handler): { fetch: typeof fetch; seen: RequestHeader[]; heads: Headers[] } {
  const seen: RequestHeader[] = [];
  const heads: Headers[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const body = new Uint8Array(init.body as ArrayBuffer);
    const h = decodeFrame(open(key, body)).header as RequestHeader;
    seen.push(h);
    heads.push(new Headers(init.headers));
    return handler(h, url, init);
  }) as unknown as typeof fetch;
  return { fetch: f, seen, heads };
}
const sealed = (header: unknown, body?: Uint8Array) => seal(key, encodeFrame(header, body)) as BodyInit & Uint8Array;
const sse = (lines: string) => new Response(new ReadableStream({ start(c) { c.enqueue(utf8.encode(lines)); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
const evt = (e: unknown) => `data: ${b64url(sealed(e))}\n\n`;

function channel(f: typeof fetch, plain?: () => boolean) {
  const saas = new SaasClient({ baseUrl: 'https://saas.test', platform: { fetch: f, storage: memoryKV(), secureStorage: memoryKV() }, getToken: () => 'tok' });
  return new WorkerChannel(plain ? { saas, workerId: WID, workerPub: worker.pub, clientKey: client, plain } : { saas, workerId: WID, workerPub: worker.pub, clientKey: client });
}
type PlainHandler = (h: RequestHeader, init: RequestInit) => Response | Promise<Response>;
function makePlainFetch(handler: PlainHandler): { fetch: typeof fetch; seen: RequestHeader[]; heads: Headers[] } {
  const seen: RequestHeader[] = [];
  const heads: Headers[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    const h = decodeFrame(new Uint8Array(init.body as ArrayBuffer)).header as RequestHeader; // not sealed
    seen.push(h);
    heads.push(new Headers(init.headers));
    return handler(h, init);
  }) as unknown as typeof fetch;
  return { fetch: f, seen, heads };
}

describe('WorkerChannel', () => {
  it('sends a sealed v3 request and decodes a JSON result', async () => {
    const fk = makeFetch(() => new Response(sealed({ ok: true, result: { sessions: [] } })));
    const r = await channel(fk.fetch).rpc('sessions.list', { archived: true });
    expect(r).toEqual({ sessions: [] });
    const h = fk.seen[0]!;
    expect(h).toMatchObject({ v: 3, op: 'sessions.list', args: { archived: true } });
    expect(typeof h.rid).toBe('string');
    expect(Math.abs(h.ts - Date.now())).toBeLessThan(5000);
    expect(fk.heads[0]!.get('authorization')).toBe('Bearer tok');
    expect(fk.heads[0]!.get('x-nopear-client')).toBe(client.pub);
  });
  it('maps encrypted errors and plain SaaS errors to RpcCallError', async () => {
    const e1 = await channel(makeFetch(() => new Response(sealed({ ok: false, error: { code: 'conflict', message: 'busy' } }))).fetch)
      .rpc('sessions.interrupt', { sessionId: 's' }).catch((e) => e);
    expect(e1).toBeInstanceOf(RpcCallError);
    expect(e1.code).toBe('conflict');
    const e2 = await channel(makeFetch(() => new Response(JSON.stringify({ error: { code: 'offline', message: 'x' } }), { status: 503 })).fetch)
      .rpc('worker.info', {} as never).catch((e) => e);
    expect(e2).toBeInstanceOf(RpcCallError);
    expect(e2.status).toBe(503);
  });
  it('returns binary results', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const r = await channel(makeFetch(() => new Response(sealed({ ok: true, mediaType: 'image/png', name: 'a.png' }, bytes))).fetch)
      .rpc('blobs.get', { hash: 'h' });
    expect(Array.from(r.bytes)).toEqual([1, 2, 3]);
    expect(r.mediaType).toBe('image/png');
    expect(r.name).toBe('a.png');
  });
  it('watch decodes events and reports end / offline', async () => {
    const got: unknown[] = [];
    const fk = makeFetch(() => sse(': ping\n\n' + evt({ type: 'tasks', cursor: 'e.1', tasks: [] }) + evt({ type: 'tasks', cursor: 'e.2', tasks: [] }) + 'event: end\ndata: gone\n\n'));
    const r = await channel(fk.fetch).watch('session.watch', { sessionId: 's', cursor: 'e.0' }, (e) => got.push(e), new AbortController().signal);
    expect(r).toEqual({ ended: 'end', code: 'gone' });
    expect(got).toHaveLength(2);
    expect(fk.seen[0]).toMatchObject({ op: 'session.watch', args: { sessionId: 's', cursor: 'e.0' } });
    const r2 = await channel(makeFetch(() => sse('event: offline\ndata:\n\n')).fetch).watch('machine.watch', {} as never, () => {}, new AbortController().signal);
    expect(r2.ended).toBe('offline');
    const r3 = await channel(makeFetch(() => sse(evt({ type: 'tasks', cursor: 'e.1', tasks: [] }))).fetch).watch('machine.watch', {} as never, () => {}, new AbortController().signal);
    expect(r3.ended).toBe('closed');
  });
  it('F21: errors while reading the response body map to RpcCallError network / timeout', async () => {
    const broken = () => new Response(new ReadableStream({ start(c) { c.error(new Error('reset')); } }));
    const e1 = await channel(makeFetch(broken).fetch).rpc('worker.info', {} as never).catch((e) => e);
    expect(e1).toBeInstanceOf(RpcCallError);
    expect(e1.code).toBe('network');
    const hanging = (_h: RequestHeader, _u: string, init: RequestInit) => new Response(new ReadableStream({
      start(c) { init.signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError'))); },
    }));
    const e2 = await channel(makeFetch(hanging).fetch).rpc('worker.info', {} as never, { timeoutMs: 50 }).catch((e) => e);
    expect(e2).toBeInstanceOf(RpcCallError);
    expect(e2.code).toBe('timeout');
  });

  it('plain mode posts encodeFrame bytes with x-nopear-plain: 1 and decodes plaintext response', async () => {
    const fk = makePlainFetch(() => new Response(encodeFrame({ ok: true, result: { x: 1 } }) as BodyInit));
    const r = await channel(fk.fetch, () => true).rpc('worker.info', {} as never);
    expect(r).toEqual({ x: 1 });
    expect(fk.seen[0]).toMatchObject({ v: 3, op: 'worker.info' });
    expect(fk.heads[0]!.get('x-nopear-plain')).toBe('1');
    expect(fk.heads[0]!.get('x-nopear-client')).toBe(client.pub);
    const e = await channel(makePlainFetch(() => new Response(encodeFrame({ ok: false, error: { code: 'conflict', message: 'busy' } }) as BodyInit)).fetch, () => true)
      .rpc('sessions.interrupt', { sessionId: 's' }).catch((x) => x);
    expect(e).toBeInstanceOf(RpcCallError);
    expect(e.code).toBe('conflict');
  });
  it('plain watch decodes b64url(plaintext frame)', async () => {
    const got: unknown[] = [];
    const pevt = (e: unknown) => `data: ${b64url(encodeFrame(e))}\n\n`;
    const fk = makePlainFetch(() => sse(pevt({ type: 'tasks', cursor: 'e.1', tasks: [] }) + 'event: end\ndata: gone\n\n'));
    const r = await channel(fk.fetch, () => true).watch('session.watch', { sessionId: 's' }, (e) => got.push(e), new AbortController().signal);
    expect(r).toEqual({ ended: 'end', code: 'gone' });
    expect(got).toEqual([{ type: 'tasks', cursor: 'e.1', tasks: [] }]);
    expect(fk.heads[0]!.get('x-nopear-plain')).toBe('1');
    expect(fk.seen[0]).toMatchObject({ op: 'session.watch', args: { sessionId: 's' } });
  });
  it('sealed mode unchanged when plain() returns false', async () => {
    let plain = false;
    const fk = makeFetch(() => new Response(sealed({ ok: true, result: { y: 2 } })));
    const ch = channel(fk.fetch, () => plain);
    expect(await ch.rpc('worker.info', {} as never)).toEqual({ y: 2 });
    expect(fk.heads[0]!.get('x-nopear-plain')).toBeNull();
    // the mode is read per request
    plain = true;
    const pk = makePlainFetch(() => new Response(encodeFrame({ ok: true, result: { z: 3 } }) as BodyInit));
    const ch2 = channel(pk.fetch, () => plain);
    expect(await ch2.rpc('worker.info', {} as never)).toEqual({ z: 3 });
  });
  // F1: account e2e:false but the worker runs NOPEAR_E2E=required → fall back to sealed, sticky per channel.
  const plainDisabled = () => new Response(JSON.stringify({ error: { code: 'bad_request', message: 'plaintext disabled on this worker' } }), { status: 400 });
  type MixedHandler = (h: RequestHeader, plain: boolean) => Response | Promise<Response>;
  function makeMixedFetch(handler: MixedHandler): { fetch: typeof fetch; seen: { h: RequestHeader; plain: boolean }[] } {
    const seen: { h: RequestHeader; plain: boolean }[] = [];
    const f = (async (_url: string, init: RequestInit) => {
      const plain = new Headers(init.headers).get('x-nopear-plain') === '1';
      const body = new Uint8Array(init.body as ArrayBuffer);
      const h = decodeFrame(plain ? body : open(key, body)).header as RequestHeader;
      seen.push({ h, plain });
      return handler(h, plain);
    }) as unknown as typeof fetch;
    return { fetch: f, seen };
  }
  it('F1: plaintext rpc refused with "plaintext disabled" retries once sealed and stays sealed', async () => {
    const fk = makeMixedFetch((_h, plain) => plain ? plainDisabled() : new Response(sealed({ ok: true, result: { ok: 1 } })));
    const ch = channel(fk.fetch, () => true);
    expect(await ch.rpc('worker.info', {} as never)).toEqual({ ok: 1 });
    expect(fk.seen.map((s) => s.plain)).toEqual([true, false]);
    expect(fk.seen[0]!.h.rid).not.toBe(fk.seen[1]!.h.rid);
    // sticky: next request goes sealed directly
    expect(await ch.rpc('worker.info', {} as never)).toEqual({ ok: 1 });
    expect(fk.seen.map((s) => s.plain)).toEqual([true, false, false]);
    // a fresh channel starts plain again (sticky is per channel instance)
    const fk2 = makeMixedFetch((_h, plain) => plain ? plainDisabled() : new Response(sealed({ ok: true, result: { ok: 2 } })));
    expect(await channel(fk2.fetch, () => true).rpc('worker.info', {} as never)).toEqual({ ok: 2 });
    expect(fk2.seen.map((s) => s.plain)).toEqual([true, false]);
  });
  it('F1: other 400s in plain mode are not retried sealed', async () => {
    const fk = makeMixedFetch(() => new Response(JSON.stringify({ error: { code: 'bad_request', message: 'replayed request id' } }), { status: 400 }));
    const e = await channel(fk.fetch, () => true).rpc('worker.info', {} as never).catch((x) => x);
    expect(e).toBeInstanceOf(RpcCallError);
    expect(e.status).toBe(400);
    expect(fk.seen.map((s) => s.plain)).toEqual([true]);
  });
  it('F1: sealed rpc refused is not retried', async () => {
    const fk = makeMixedFetch(() => plainDisabled());
    const e = await channel(fk.fetch, () => true).rpc('worker.info', {} as never).catch((x) => x);
    expect(e).toBeInstanceOf(RpcCallError);
    expect(e.message).toBe('plaintext disabled on this worker');
    expect(fk.seen.map((s) => s.plain)).toEqual([true, false]);
  });
  it('F1: plaintext watch open refused retries sealed and stays sealed', async () => {
    const got: unknown[] = [];
    const fk = makeMixedFetch((_h, plain) => plain ? plainDisabled() : sse(evt({ type: 'tasks', cursor: 'e.1', tasks: [] }) + 'event: end\ndata: gone\n\n'));
    const ch = channel(fk.fetch, () => true);
    const r = await ch.watch('session.watch', { sessionId: 's' }, (e) => got.push(e), new AbortController().signal);
    expect(r).toEqual({ ended: 'end', code: 'gone' });
    expect(got).toEqual([{ type: 'tasks', cursor: 'e.1', tasks: [] }]);
    expect(fk.seen.map((s) => s.plain)).toEqual([true, false]);
    expect(fk.seen[1]!.h).toMatchObject({ op: 'session.watch', args: { sessionId: 's' } });
    await ch.rpc('worker.info', {} as never).catch(() => {});
    expect(fk.seen.map((s) => s.plain)).toEqual([true, false, false]);
  });
  // F8: account settings are stale (e2e turned on, client still thinks off) → SaaS 409 e2e_enabled on plaintext.
  const e2eEnabled = () => new Response(JSON.stringify({ error: { code: 'e2e_enabled', message: 'E2E is enabled for this account; plaintext requests are refused' } }), { status: 409 });
  function staleChannel(f: typeof fetch, plain: () => boolean, onStaleSettings: () => void) {
    const saas = new SaasClient({ baseUrl: 'https://saas.test', platform: { fetch: f, storage: memoryKV(), secureStorage: memoryKV() }, getToken: () => 'tok' });
    return new WorkerChannel({ saas, workerId: WID, workerPub: worker.pub, clientKey: client, plain, onStaleSettings });
  }
  it('F8: plaintext rpc refused with 409 e2e_enabled retries once sealed, reports stale settings, not sticky', async () => {
    let stale = 0;
    const fk = makeMixedFetch((_h, plain) => plain ? e2eEnabled() : new Response(sealed({ ok: true, result: { ok: 1 } })));
    const ch = staleChannel(fk.fetch, () => true, () => { stale++; });
    expect(await ch.rpc('worker.info', {} as never)).toEqual({ ok: 1 });
    expect(fk.seen.map((s) => s.plain)).toEqual([true, false]);
    expect(fk.seen[0]!.h.rid).not.toBe(fk.seen[1]!.h.rid);
    expect(stale).toBe(1);
    // not sticky: the next request follows plain() again
    expect(await ch.rpc('worker.info', {} as never)).toEqual({ ok: 1 });
    expect(fk.seen.map((s) => s.plain)).toEqual([true, false, true, false]);
    expect(stale).toBe(2);
  });
  it('F8: sealed retry after 409 e2e_enabled that still fails surfaces the sealed error', async () => {
    let stale = 0;
    const fk = makeMixedFetch((_h, plain) => plain ? e2eEnabled() : new Response(JSON.stringify({ error: { code: 'offline', message: 'worker offline' } }), { status: 503 }));
    const e = await staleChannel(fk.fetch, () => true, () => { stale++; }).rpc('worker.info', {} as never).catch((x) => x);
    expect(e).toBeInstanceOf(RpcCallError);
    expect(e.status).toBe(503);
    expect(fk.seen.map((s) => s.plain)).toEqual([true, false]);
    expect(stale).toBe(1);
  });
  it('F8: other 409s in plain mode are not retried sealed', async () => {
    let stale = 0;
    const fk = makeMixedFetch(() => new Response(JSON.stringify({ error: { code: 'conflict', message: 'x' } }), { status: 409 }));
    const e = await staleChannel(fk.fetch, () => true, () => { stale++; }).rpc('worker.info', {} as never).catch((x) => x);
    expect(e.status).toBe(409);
    expect(fk.seen.map((s) => s.plain)).toEqual([true]);
    expect(stale).toBe(0);
  });
  it('F8: plaintext watch open refused with 409 e2e_enabled retries sealed once, not sticky', async () => {
    let stale = 0;
    const got: unknown[] = [];
    const fk = makeMixedFetch((_h, plain) => plain ? e2eEnabled() : sse(evt({ type: 'tasks', cursor: 'e.1', tasks: [] }) + 'event: end\ndata: gone\n\n'));
    const ch = staleChannel(fk.fetch, () => true, () => { stale++; });
    const r = await ch.watch('session.watch', { sessionId: 's' }, (e) => got.push(e), new AbortController().signal);
    expect(r).toEqual({ ended: 'end', code: 'gone' });
    expect(got).toEqual([{ type: 'tasks', cursor: 'e.1', tasks: [] }]);
    expect(fk.seen.map((s) => s.plain)).toEqual([true, false]);
    expect(stale).toBe(1);
    await ch.rpc('worker.info', {} as never).catch(() => {});
    expect(fk.seen.map((s) => s.plain)).toEqual([true, false, true, false]);
  });
  it('F8: 409 e2e_enabled without an onStaleSettings callback still retries sealed', async () => {
    const fk = makeMixedFetch((_h, plain) => plain ? e2eEnabled() : new Response(sealed({ ok: true, result: { ok: 3 } })));
    expect(await channel(fk.fetch, () => true).rpc('worker.info', {} as never)).toEqual({ ok: 3 });
    expect(fk.seen.map((s) => s.plain)).toEqual([true, false]);
  });
  it('F1: plaintext watch ending plaintext_disabled while plain() is true → next open is sealed', async () => {
    const fk = makeMixedFetch((_h, plain) => plain ? sse('event: end\ndata: plaintext_disabled\n\n') : sse('event: end\ndata: gone\n\n'));
    const ch = channel(fk.fetch, () => true);
    const sig = new AbortController().signal;
    expect(await ch.watch('machine.watch', {} as never, () => {}, sig)).toEqual({ ended: 'end', code: 'plaintext_disabled' });
    expect(await ch.watch('machine.watch', {} as never, () => {}, sig)).toEqual({ ended: 'end', code: 'gone' });
    expect(fk.seen.map((s) => s.plain)).toEqual([true, false]);
  });
});
