import { afterEach, describe, expect, it } from 'vitest';
import type { AccountSettings, Card, Machine, MemoryDoc, Message, Project, RequestHeader, Session, SessionIndexEntry } from '@nopear/protocol';
import { b64url, decodeFrame, deriveKey, encodeFrame, generateClientKey, open, seal, utf8 } from './crypto';
import { memoryKV } from './platform';
import { createNoPearEngine, type EngineNotice, type NoPearEngine } from './engine';

const AC = { enabled: true, thresholdTokens: 300_000, keepRecentTokens: 20_000 };
const worker = generateClientKey();
const WID = 'w_one';
const machine: Machine = { workerId: WID, label: 'm', workerPub: worker.pub, online: true, lastSeenAt: null, version: '3' };
const sess = (p: Partial<Session> = {}): Session => ({ id: 's1', workerId: WID, kind: 'chat', title: 'T', cwd: '/', status: 'idle', createdAt: '', lastActivityAt: '', preview: '', pinned: false, starred: false, archived: false, model: 'm', thinking: 'medium', promptCount: 0, taskCount: 0, ...p });

class Stream {
  ctl!: ReadableStreamDefaultController<Uint8Array>;
  res = new Response(new ReadableStream<Uint8Array>({ start: (c) => { this.ctl = c; } }), { headers: { 'content-type': 'text/event-stream' } });
  send(s: string) { this.ctl.enqueue(utf8.encode(s)); }
  close() { try { this.ctl.close(); } catch { /* closed */ } }
}

function fakeSaas() {
  const st = {
    clients: [] as string[], token: 'tok1',
    events: [] as Stream[],
    watches: [] as { h: RequestHeader; stream: Stream; key: Uint8Array; aborted: boolean; plain: boolean }[],
    rpcDown: false, registers: 0, forbidAll: false,
    rpc: (_h: RequestHeader): unknown => ({ ok: true, result: {} }),
    // collab REST
    reqs: [] as { method: string; path: string; body?: unknown }[],
    plainReqs: 0,
    refusePlain: false, refused409: 0, // refusePlain: like the real SaaS, 409 e2e_enabled on plaintext data plane while settings.e2e
    settings: { e2e: false, autoCompact: AC } as AccountSettings,
    projects: [] as Project[], cards: [] as Card[], index: [] as SessionIndexEntry[],
    memory: { scope: 'global', projectId: null, content: '', updatedAt: '' } as MemoryDoc,
    restGate: null as Promise<void> | null, // when set, GET /api/cards waits on it (mid-load tests)
  };
  const rest = (method: string, u: URL, rawBody: unknown): Response | Promise<Response> | null => {
    const path = u.pathname + u.search;
    if (!/^\/api\/(settings|projects|cards|sessions|memory|tokens|machines\/install-code)/.test(u.pathname)) return null;
    const body: unknown = rawBody !== undefined && rawBody !== null ? JSON.parse(String(rawBody)) : undefined;
    st.reqs.push(body === undefined ? { method, path } : { method, path, body });
    if (u.pathname === '/api/settings') {
      if (method === 'PATCH') {
        const b = body as { e2e?: boolean; autoCompact?: Partial<typeof AC> };
        st.settings = { e2e: b.e2e ?? st.settings.e2e, autoCompact: { ...st.settings.autoCompact, ...(b.autoCompact ?? {}) } };
      }
      return Response.json({ settings: st.settings });
    }
    if (u.pathname === '/api/projects' && method === 'GET') return Response.json({ projects: st.projects });
    if (u.pathname === '/api/cards' && method === 'GET') return (async () => { if (st.restGate) await st.restGate; return Response.json({ cards: st.cards }); })();
    if (u.pathname === '/api/sessions') return Response.json({ sessions: st.index });
    if (u.pathname === '/api/memory') return Response.json({ memory: st.memory });
    const c = /^\/api\/cards\/([^/]+)$/.exec(u.pathname);
    if (c && method === 'PATCH') {
      const card = { ...st.cards.find((x) => x.id === c[1])!, ...(body as object) } as Card;
      return Response.json({ card });
    }
    return new Response(null, { status: 204 });
  };
  const f = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const auth = new Headers(init.headers).get('authorization');
    if (u.pathname === '/api/auth/dev') return Response.json({ token: st.token, user: { id: 'u', email: 'a@b' } });
    if (auth !== `Bearer ${st.token}`) return Response.json({ error: { code: 'unauthorized', message: 'no' } }, { status: 401 });
    if (u.pathname === '/api/me') return Response.json({ user: { id: 'u', email: 'a@b' } });
    if (u.pathname === '/api/clients') { st.registers++; if (st.forbidAll) return Response.json({ client: {} }, { status: 201 }); st.clients.push(JSON.parse(String(init.body)).clientPub); return Response.json({ client: {} }, { status: 201 }); }
    if (u.pathname === '/api/events') { const s = new Stream(); st.events.push(s); return s.res; }
    const r = await rest(init.method ?? 'GET', u, init.body);
    if (r) return r;
    const m = /^\/api\/w\/([^/]+)\/(rpc|watch)$/.exec(u.pathname);
    if (m) {
      const cpub = new Headers(init.headers).get('x-nopear-client')!;
      const plain = new Headers(init.headers).get('x-nopear-plain') === '1';
      if (m[2] === 'rpc' && st.rpcDown) return Response.json({ error: { code: 'offline', message: 'worker offline' } }, { status: 503 });
      if (st.forbidAll || !st.clients.includes(cpub)) return Response.json({ error: { code: 'forbidden', message: 'x' } }, { status: 403 });
      if (plain && st.refusePlain && st.settings.e2e) {
        st.refused409++;
        return Response.json({ error: { code: 'e2e_enabled', message: 'E2E is enabled for this account; plaintext requests are refused' } }, { status: 409 });
      }
      const key = deriveKey(worker.priv, cpub, WID, cpub);
      const raw = new Uint8Array(init.body as ArrayBuffer);
      if (plain && m[2] === 'rpc') st.plainReqs++;
      const h = decodeFrame(plain ? raw : open(key, raw)).header as RequestHeader;
      if (m[2] === 'watch') {
        const s = new Stream(); const w = { h, stream: s, key, aborted: false, plain }; st.watches.push(w);
        init.signal?.addEventListener('abort', () => { w.aborted = true; s.close(); });
        return s.res;
      }
      const resp = encodeFrame(st.rpc(h));
      return new Response((plain ? resp : seal(key, resp)) as BodyInit);
    }
    return new Response('nf', { status: 404 });
  }) as unknown as typeof fetch;
  const evt = (w: { key: Uint8Array; stream: Stream; plain: boolean }, e: unknown) =>
    w.stream.send(`data: ${b64url(w.plain ? encodeFrame(e) : seal(w.key, encodeFrame(e)))}\n\n`);
  const saasEvt = (e: unknown, i = st.events.length - 1) => st.events[i]!.send(`data: ${JSON.stringify(e)}\n\n`);
  return { st, fetch: f, evt, saasEvt };
}

const until = async (cond: () => unknown, ms = 3000) => {
  const t = Date.now();
  while (!cond()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 10)); }
};

let engine: NoPearEngine | undefined;
afterEach(() => engine?.dispose());

describe('NoPearEngine', () => {
  it('logs in, registers client, follows machines/sessions, resumes with cursor, tracks failed sends and notices', async () => {
    const fk = fakeSaas();
    const secure = memoryKV();
    engine = createNoPearEngine({ platform: { fetch: fk.fetch, storage: memoryKV(), secureStorage: secure }, defaultSaasUrl: 'https://saas.test', clientLabel: 'test' });
    await engine.init();
    const notices: EngineNotice[] = [];
    engine.onNotice((n) => notices.push(n));
    await engine.loginDev('a@b');
    const s0 = engine.store.getState();
    expect(s0.token).toBe('tok1');
    expect(s0.clientPub).toBeTruthy();
    expect(fk.st.clients).toEqual([s0.clientPub]);
    expect(await secure.get('nopear.clientKey')).toBeTruthy();

    await until(() => fk.st.events.length === 1);
    fk.st.events[0]!.send(`data: ${JSON.stringify({ type: 'machines', machines: [machine] })}\n\n`);
    await until(() => fk.st.watches.some((w) => w.h.op === 'machine.watch'));
    const mw = fk.st.watches.find((w) => w.h.op === 'machine.watch')!;
    fk.evt(mw, { type: 'snapshot', worker: { workerId: WID, label: 'm', version: '3', defaultCwd: '/', defaultModel: 'm', defaultThinking: 'medium', models: [] }, sessions: [sess({ status: 'running' })] });
    await until(() => engine!.store.getState().sessions[WID]?.s1);
    expect(engine.store.getState().machineConn[WID]).toBe('online');

    engine.openSession(WID, 's1');
    await until(() => fk.st.watches.some((w) => w.h.op === 'session.watch'));
    const sw = fk.st.watches.find((w) => w.h.op === 'session.watch')!;
    fk.evt(sw, { type: 'snapshot', cursor: 'ep.5', session: sess({ status: 'running' }), messages: [], hasMore: false, prompts: [], tasks: [] });
    fk.evt(sw, { type: 'tasks', cursor: 'ep.6', tasks: [] });
    await until(() => engine!.store.getState().timelines[`${WID}/s1`]?.cursor === 'ep.6');
    sw.stream.close();
    await until(() => fk.st.watches.filter((w) => w.h.op === 'session.watch').length === 2);
    const sw2 = fk.st.watches.filter((w) => w.h.op === 'session.watch')[1]!;
    expect((sw2.h.args as { cursor?: string }).cursor).toBe('ep.6');

    fk.st.rpc = (h) => h.op === 'messages.send' ? { ok: false, error: { code: 'internal', message: 'boom' } } : { ok: true, result: {} };
    await engine.send(WID, 's1', 'hello');
    const tl = engine.store.getState().timelines[`${WID}/s1`]!;
    const pend = Object.values(tl.pending)[0]!;
    expect(pend.status).toBe('failed');
    expect(tl.messages.at(-1)!.id).toBe(`local:${pend.clientMsgId}`);
    expect(engine.discardSend(WID, 's1', pend.clientMsgId)).toBe('hello');

    fk.evt(mw, { type: 'session.updated', session: sess({ status: 'idle' }) });
    await until(() => notices.length > 0);
    expect(notices[0]).toMatchObject({ kind: 'session.idle', workerId: WID, sessionId: 's1', title: 'T' });

    engine.closeSession(WID, 's1');
  });

  it('re-registers the client once on 403 and logs out when registration is unauthorized', async () => {
    const fk = fakeSaas();
    engine = createNoPearEngine({ platform: { fetch: fk.fetch, storage: memoryKV(), secureStorage: memoryKV() }, defaultSaasUrl: 'https://saas.test', clientLabel: 't' });
    await engine.init();
    await engine.loginDev('a@b');
    await until(() => fk.st.events.length === 1);
    fk.st.events[0]!.send(`data: ${JSON.stringify({ type: 'machines', machines: [machine] })}\n\n`);
    await until(() => engine!.store.getState().machines[WID]);
    fk.st.clients = [];
    fk.st.rpc = () => ({ ok: true, result: { files: [] } });
    await expect(engine.rpc(WID, 'memory.get', {} as never)).resolves.toEqual({ files: [] });
    expect(fk.st.clients).toHaveLength(1);
    fk.st.clients = [];
    fk.st.token = 'other';
    await expect(engine.rpc(WID, 'memory.get', {} as never)).rejects.toBeTruthy();
    expect(engine.store.getState().token).toBeNull();
  });

  async function boot(fk: ReturnType<typeof fakeSaas>, extra: { stallMs?: number; resumeStaleMs?: number } = {}) {
    const e = createNoPearEngine({ platform: { fetch: fk.fetch, storage: memoryKV(), secureStorage: memoryKV() }, defaultSaasUrl: 'https://saas.test', clientLabel: 't', ...extra });
    engine = e;
    await e.init();
    await e.loginDev('a@b');
    await until(() => fk.st.events.length === 1);
    fk.st.events[0]!.send(`data: ${JSON.stringify({ type: 'machines', machines: [machine] })}\n\n`);
    await until(() => fk.st.watches.some((w) => w.h.op === 'machine.watch'));
    const mw = fk.st.watches.find((w) => w.h.op === 'machine.watch')!;
    fk.evt(mw, { type: 'snapshot', worker: { workerId: WID, label: 'm', version: '3', defaultCwd: '/', defaultModel: 'm', defaultThinking: 'medium', models: [] }, sessions: [sess()] });
    await until(() => e.store.getState().machineConn[WID] === 'online');
    return { e, mw };
  }

  it('queue: tracks the session queue, removeQueued / updateQueued call the RPCs, queued sends do not double-render', async () => {
    const fk = fakeSaas();
    const { e } = await boot(fk);
    const calls: { op: string; args: unknown }[] = [];
    fk.st.rpc = (h) => { calls.push({ op: h.op, args: h.args }); return h.op === 'messages.send' ? { ok: true, result: { queued: true } } : { ok: true, result: {} }; };
    e.openSession(WID, 's1');
    await until(() => fk.st.watches.some((w) => w.h.op === 'session.watch'));
    const sw = fk.st.watches.find((w) => w.h.op === 'session.watch')!;
    const K = `${WID}/s1`;
    fk.evt(sw, { type: 'snapshot', cursor: 'ep.1', session: sess({ status: 'running' }), messages: [], hasMore: false, prompts: [], tasks: [], queue: [] });
    await until(() => e.store.getState().timelines[K]?.cursor === 'ep.1');
    await e.send(WID, 's1', 'later', { delivery: 'followUp' });
    const cid = Object.keys(e.store.getState().timelines[K]!.pending)[0]!;
    fk.evt(sw, { type: 'queue', cursor: 'ep.2', items: [{ id: cid, text: 'later', delivery: 'followUp', attachments: 0, createdAt: '' }] });
    await until(() => e.store.getState().timelines[K]?.cursor === 'ep.2');
    const { selectMessages } = await import('./timeline');
    expect(selectMessages(e.store.getState().timelines[K]!)).toHaveLength(0);
    await e.updateQueued(WID, 's1', cid, { delivery: 'steer' });
    expect(calls.at(-1)).toEqual({ op: 'messages.queue.update', args: { sessionId: 's1', id: cid, delivery: 'steer' } });
    await e.removeQueued(WID, 's1', cid);
    expect(calls.at(-1)).toEqual({ op: 'messages.queue.remove', args: { sessionId: 's1', id: cid } });
    const t = e.store.getState().timelines[K]!;
    expect(t.queue).toEqual([]);
    expect(t.pending[cid]).toBeUndefined();
    expect(t.messages).toHaveLength(0);
    // not_found (already delivered) surfaces to the caller
    fk.st.rpc = () => ({ ok: false, error: { code: 'not_found', message: 'not queued' } });
    await expect(e.removeQueued(WID, 's1', 'gone')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('F1: a one-off rpc 503 marks the machine offline and stops its machine.watch', async () => {
    const fk = fakeSaas();
    const { e, mw } = await boot(fk);
    fk.st.rpcDown = true;
    await expect(e.interrupt(WID, 's1')).rejects.toMatchObject({ status: 503 });
    expect(e.store.getState().machineConn[WID]).toBe('offline');
    await until(() => mw.aborted);
    // no new machine.watch is opened while offline
    await new Promise((r) => setTimeout(r, 100));
    expect(fk.st.watches.filter((w) => w.h.op === 'machine.watch')).toHaveLength(1);
  });

  it('F2: watch loops stop after the single re-register retry still fails with 403', async () => {
    const fk = fakeSaas();
    const { e, mw } = await boot(fk);
    e.openSession(WID, 's1');
    await until(() => fk.st.watches.some((w) => w.h.op === 'session.watch'));
    const before = fk.st.registers;
    fk.st.forbidAll = true;
    mw.stream.close();
    fk.st.watches.find((w) => w.h.op === 'session.watch')!.stream.close();
    await until(() => e.store.getState().error !== null);
    await new Promise((r) => setTimeout(r, 1500)); // > several backoff passes
    // one re-register per loop (machine + session), then stop
    expect(fk.st.registers - before).toBeLessThanOrEqual(2);
    expect(e.store.getState().error).toBeTruthy();
  });

  it('R3-F2: an e2e settings change restarts open machine + session watches in the new mode, keeping cursors', async () => {
    const fk = fakeSaas();
    const { e } = await boot(fk);
    await until(() => e.store.getState().settings !== null); // e2e:false
    const mws = () => fk.st.watches.filter((w) => w.h.op === 'machine.watch');
    const sws = () => fk.st.watches.filter((w) => w.h.op === 'session.watch');
    expect(mws()).toHaveLength(1); // null → false does not churn the (sealed) watch
    e.openSession(WID, 's1');
    await until(() => sws().length === 1);
    expect(sws()[0]!.plain).toBe(true);
    fk.evt(sws()[0]!, { type: 'snapshot', cursor: 'ep.3', session: sess(), messages: [], hasMore: false, prompts: [], tasks: [] });
    await until(() => e.store.getState().timelines[`${WID}/s1`]?.cursor === 'ep.3');
    const regs = fk.st.registers;

    // same value: no restart
    fk.saasEvt({ type: 'settings.updated', settings: { e2e: false, autoCompact: AC } });
    await new Promise((r) => setTimeout(r, 50));
    expect(mws()).toHaveLength(1);
    expect(sws()).toHaveLength(1);

    fk.saasEvt({ type: 'settings.updated', settings: { e2e: true, autoCompact: AC } });
    await until(() => mws().length === 2 && sws().length === 2);
    expect(mws()[0]!.aborted).toBe(true);
    expect(sws()[0]!.aborted).toBe(true);
    expect(mws()[1]!.plain).toBe(false);
    expect(sws()[1]!.plain).toBe(false);
    expect((sws()[1]!.h.args as { cursor?: string }).cursor).toBe('ep.3');

    await e.setE2e(false);
    await until(() => mws().length === 3 && sws().length === 3);
    expect(mws()[2]!.plain).toBe(true);
    expect(sws()[2]!.plain).toBe(true);
    expect((sws()[2]!.h.args as { cursor?: string }).cursor).toBe('ep.3');
    await new Promise((r) => setTimeout(r, 100));
    expect(mws()).toHaveLength(3);
    expect(sws()).toHaveLength(3);
    expect(fk.st.registers).toBe(regs);
    expect(e.store.getState().error).toBeNull();
  });

  it('R3-F2: a watch ending with plaintext_disabled refreshes settings and reopens without re-registering', async () => {
    const fk = fakeSaas();
    const { e } = await boot(fk);
    await until(() => e.store.getState().settings !== null); // e2e:false
    const sws = () => fk.st.watches.filter((w) => w.h.op === 'session.watch');
    const mws = () => fk.st.watches.filter((w) => w.h.op === 'machine.watch');
    e.openSession(WID, 's1');
    await until(() => sws().length === 1);
    expect(sws()[0]!.plain).toBe(true);
    const regs = fk.st.registers;
    const settingsGets = () => fk.st.reqs.filter((r) => r.method === 'GET' && r.path === '/api/settings').length;
    const g0 = settingsGets();

    // unchanged settings: the watch is simply reopened (after a settings refresh)
    sws()[0]!.stream.send('event: end\ndata: plaintext_disabled\n\n');
    await until(() => sws().length === 2, 4000);
    expect(settingsGets()).toBe(g0 + 1);

    // account flipped to e2e:true without the event reaching us: refresh picks it up, reopen sealed
    fk.st.settings = { e2e: true, autoCompact: AC };
    sws()[1]!.stream.send('event: end\ndata: plaintext_disabled\n\n');
    await until(() => sws().length === 3, 4000);
    expect(sws()[2]!.plain).toBe(false);
    expect(e.store.getState().settings).toEqual({ e2e: true, autoCompact: AC });
    await until(() => mws().length === 2); // the e2e change restarted the machine watch too
    expect(mws()[1]!.plain).toBe(false);

    // machine.watch ending plaintext_disabled is reopened too
    mws()[1]!.stream.send('event: end\ndata: plaintext_disabled\n\n');
    await until(() => mws().length === 3, 4000);
    await new Promise((r) => setTimeout(r, 100));
    expect(sws()).toHaveLength(3);
    expect(fk.st.registers).toBe(regs);
    expect(e.store.getState().error).toBeNull();
  });

  it('F8: stale settings (SaaS 409 e2e_enabled on plaintext) → request retried sealed, settings refreshed, watches go sealed', async () => {
    const fk = fakeSaas();
    const { e } = await boot(fk);
    await until(() => e.store.getState().settings !== null); // e2e:false
    const sws = () => fk.st.watches.filter((w) => w.h.op === 'session.watch');
    const mws = () => fk.st.watches.filter((w) => w.h.op === 'machine.watch');
    e.openSession(WID, 's1');
    await until(() => sws().length === 1);
    expect(sws()[0]!.plain).toBe(true);
    const regs = fk.st.registers;
    const settingsGets = () => fk.st.reqs.filter((r) => r.method === 'GET' && r.path === '/api/settings').length;
    const g0 = settingsGets();

    // account flipped to e2e:true; the settings.updated event never reached us
    fk.st.settings = { e2e: true, autoCompact: AC };
    fk.st.refusePlain = true;
    fk.st.rpc = () => ({ ok: true, result: { ok: 1 } });
    await expect(e.rpc(WID, 'worker.info', {} as never)).resolves.toEqual({ ok: 1 });
    expect(fk.st.refused409).toBe(1);
    await until(() => e.store.getState().settings?.e2e === true);
    expect(settingsGets()).toBe(g0 + 1);
    // the e2e change restarts open watches sealed
    await until(() => sws().length === 2 && mws().length === 2);
    expect(sws()[1]!.plain).toBe(false);
    expect(mws()[1]!.plain).toBe(false);
    // later requests are sealed straight away (settings now correct)
    const plainBefore = fk.st.plainReqs;
    await expect(e.rpc(WID, 'worker.info', {} as never)).resolves.toEqual({ ok: 1 });
    expect(fk.st.refused409).toBe(1);
    expect(fk.st.plainReqs).toBe(plainBefore);
    expect(fk.st.registers).toBe(regs);
    expect(e.store.getState().error).toBeNull();
  });

  it('F8: a plaintext watch open refused with 409 e2e_enabled reopens sealed and refreshes settings', async () => {
    const fk = fakeSaas();
    const { e } = await boot(fk);
    await until(() => e.store.getState().settings !== null); // e2e:false
    const sws = () => fk.st.watches.filter((w) => w.h.op === 'session.watch');
    fk.st.settings = { e2e: true, autoCompact: AC };
    fk.st.refusePlain = true;
    e.openSession(WID, 's1');
    await until(() => sws().length >= 1);
    expect(sws()[0]!.plain).toBe(false);
    expect(fk.st.refused409).toBeGreaterThanOrEqual(1);
    await until(() => e.store.getState().settings?.e2e === true);
    expect(e.store.getState().error).toBeNull();
  });

  it('R3-F3: removing a machine drops its sessionIndex entries', async () => {
    const fk = fakeSaas();
    fk.st.index = [
      { workerId: WID, sessionId: 's1', title: 's1', preview: '', status: 'idle', projectId: null, cwd: '/', createdAt: '', lastActivityAt: '' },
      { workerId: 'w_two', sessionId: 's9', title: 's9', preview: '', status: 'idle', projectId: null, cwd: '/', createdAt: '', lastActivityAt: '' },
    ];
    const { e } = await boot(fk);
    await until(() => Object.keys(e.store.getState().sessionIndex).length === 2);
    fk.saasEvt({ type: 'machine.removed', workerId: WID });
    await until(() => !e.store.getState().machines[WID]);
    expect(Object.keys(e.store.getState().sessionIndex)).toEqual(['w_two/s9']);
  });

  it('F3: prompt.opened on an open session.watch yields exactly one prompt notice', async () => {
    const fk = fakeSaas();
    const { e, mw } = await boot(fk);
    const notices: EngineNotice[] = [];
    e.onNotice((n) => notices.push(n));
    e.openSession(WID, 's1');
    await until(() => fk.st.watches.some((w) => w.h.op === 'session.watch'));
    const sw = fk.st.watches.find((w) => w.h.op === 'session.watch')!;
    fk.evt(sw, { type: 'snapshot', cursor: 'ep.1', session: sess(), messages: [], hasMore: false, prompts: [], tasks: [] });
    const prompt = { id: 'p1', sessionId: 's1', questions: [], createdAt: '' };
    fk.evt(sw, { type: 'prompt.opened', cursor: 'ep.2', prompt });
    await until(() => e.store.getState().timelines[`${WID}/s1`]?.cursor === 'ep.2');
    await new Promise((r) => setTimeout(r, 50));
    // prompt.opened alone (no promptCount change yet) must notify
    expect(notices.filter((n) => n.kind === 'prompt')).toHaveLength(1);
    fk.evt(sw, { type: 'session.updated', cursor: 'ep.3', session: sess({ promptCount: 1 }) });
    fk.evt(mw, { type: 'session.updated', session: sess({ promptCount: 1 }) });
    fk.evt(sw, { type: 'prompt.opened', cursor: 'ep.4', prompt }); // replayed duplicate
    await until(() => e.store.getState().timelines[`${WID}/s1`]?.cursor === 'ep.4');
    await new Promise((r) => setTimeout(r, 100));
    expect(notices.filter((n) => n.kind === 'prompt')).toHaveLength(1);
    expect(notices.find((n) => n.kind === 'prompt')).toMatchObject({ workerId: WID, sessionId: 's1' });
  });

  it('F18: a session watch that ended is restarted by a later openSession', async () => {
    const fk = fakeSaas();
    const { e } = await boot(fk);
    e.openSession(WID, 's1');
    await until(() => fk.st.watches.some((w) => w.h.op === 'session.watch'));
    const sw = fk.st.watches.find((w) => w.h.op === 'session.watch')!;
    sw.stream.send('event: end\ndata: not_found\n\n');
    await new Promise((r) => setTimeout(r, 100));
    expect(fk.st.watches.filter((w) => w.h.op === 'session.watch')).toHaveLength(1);
    e.openSession(WID, 's1');
    await until(() => fk.st.watches.filter((w) => w.h.op === 'session.watch').length === 2);
  });

  it('R2-F8: a watch revived after ending keeps the other views\' refs (their close does not abort it)', async () => {
    const fk = fakeSaas();
    const { e } = await boot(fk);
    const sws = () => fk.st.watches.filter((w) => w.h.op === 'session.watch');
    e.openSession(WID, 's1'); // view A
    e.openSession(WID, 's1'); // view B
    await until(() => sws().length === 1);
    sws()[0]!.stream.send('event: end\ndata: not_found\n\n');
    await new Promise((r) => setTimeout(r, 100));
    e.openSession(WID, 's1'); // view C revives the ended watch
    await until(() => sws().length === 2);
    const revived = sws()[1]!;
    e.closeSession(WID, 's1'); // A
    await new Promise((r) => setTimeout(r, 50));
    expect(revived.aborted).toBe(false);
    e.closeSession(WID, 's1'); // B
    await new Promise((r) => setTimeout(r, 50));
    expect(revived.aborted).toBe(false);
    e.closeSession(WID, 's1'); // C
    await until(() => revived.aborted);
    expect(sws()).toHaveLength(2);
  });

  it('F19: logout followed by immediate re-login reopens the machine watch', async () => {
    const fk = fakeSaas();
    const { e } = await boot(fk);
    await e.logout();
    await e.loginDev('a@b');
    await until(() => fk.st.events.length === 2);
    fk.st.events[1]!.send(`data: ${JSON.stringify({ type: 'machines', machines: [machine] })}\n\n`);
    await until(() => fk.st.watches.filter((w) => w.h.op === 'machine.watch').length === 2);
  });

  it('W-F4: a watch ending with code unauthorized re-registers once and retries, then reports and stops', async () => {
    const fk = fakeSaas();
    const { e, mw } = await boot(fk);
    e.openSession(WID, 's1');
    await until(() => fk.st.watches.some((w) => w.h.op === 'session.watch'));
    const sws = () => fk.st.watches.filter((w) => w.h.op === 'session.watch');
    const before = fk.st.registers;
    sws()[0]!.stream.send('event: end\ndata: unauthorized\n\n');
    // re-register + retry once
    await until(() => sws().length === 2);
    expect(fk.st.registers - before).toBe(1);
    expect(e.store.getState().error).toBeNull();
    // retried watch also ends unauthorized → error, no more retries
    sws()[1]!.stream.send('event: end\ndata: unauthorized\n\n');
    await until(() => e.store.getState().error !== null);
    await new Promise((r) => setTimeout(r, 1200));
    expect(sws()).toHaveLength(2);
    expect(fk.st.registers - before).toBe(1);
    // machine.watch also: unauthorized end → retry once
    const mws = () => fk.st.watches.filter((w) => w.h.op === 'machine.watch');
    mw.stream.send('event: end\ndata: unauthorized\n\n');
    await until(() => mws().length === 2);
  });

  it('W-F7: machine.watch offline while presence still says online retries instead of stopping', async () => {
    const fk = fakeSaas();
    const { e, mw } = await boot(fk);
    const mws = () => fk.st.watches.filter((w) => w.h.op === 'machine.watch');
    mw.stream.send('event: offline\ndata: \n\n');
    await until(() => mws().length === 2, 4000);
    expect(e.store.getState().machines[WID]?.online).toBe(true);
  });

  it('W-F11: logout clears drafts (memory and persisted) and prompt-notice dedupe', async () => {
    const fk = fakeSaas();
    const storage = memoryKV();
    const e = createNoPearEngine({ platform: { fetch: fk.fetch, storage, secureStorage: memoryKV() }, defaultSaasUrl: 'https://saas.test', clientLabel: 't' });
    engine = e;
    await e.init();
    await e.loginDev('a@b');
    e.setDraft(WID, 's1', 'secret draft');
    await new Promise((r) => setTimeout(r, 600));
    expect(await storage.get('nopear.drafts')).toContain('secret draft');
    await e.logout();
    expect(e.store.getState().drafts).toEqual({});
    expect(await storage.get('nopear.drafts')).toBeNull();
    await new Promise((r) => setTimeout(r, 600));
    expect(await storage.get('nopear.drafts')).toBeNull();
  });

  it('F20: dispose flushes pending drafts', async () => {
    const fk = fakeSaas();
    const storage = memoryKV();
    const e = createNoPearEngine({ platform: { fetch: fk.fetch, storage, secureStorage: memoryKV() }, defaultSaasUrl: 'https://saas.test', clientLabel: 't' });
    await e.init();
    e.setDraft(WID, 's1', 'draft!');
    e.dispose();
    await new Promise((r) => setTimeout(r, 20));
    expect(JSON.parse((await storage.get('nopear.drafts')) ?? '{}')).toEqual({ [`${WID}/s1`]: 'draft!' });
  });
});

describe('NoPearEngine collab state', () => {
  const proj = (id: string, p: Partial<Project> = {}): Project => ({ id, name: id, description: '', paths: {}, createdAt: '', updatedAt: '', ...p });
  const card = (id: string, p: Partial<Card> = {}): Card => ({ id, projectId: null, title: id, body: '', state: 'inbox', workerId: null, sessionId: null, order: 0, createdAt: '', updatedAt: '', ...p });
  const idx = (workerId: string, sessionId: string, p: Partial<SessionIndexEntry> = {}): SessionIndexEntry => ({ workerId, sessionId, title: sessionId, preview: '', status: 'idle', projectId: null, cwd: '/', createdAt: '', lastActivityAt: '', ...p });
  const LOAD = ['GET /api/settings', 'GET /api/projects', 'GET /api/cards', 'GET /api/sessions?limit=500', 'GET /api/memory?scope=global'];
  const gets = (fk: ReturnType<typeof fakeSaas>) => fk.st.reqs.filter((r) => r.method === 'GET').map((r) => `${r.method} ${r.path}`);

  async function login(fk: ReturnType<typeof fakeSaas>) {
    const e = createNoPearEngine({ platform: { fetch: fk.fetch, storage: memoryKV(), secureStorage: memoryKV() }, defaultSaasUrl: 'https://saas.test', clientLabel: 't' });
    engine = e;
    await e.init();
    await e.loginDev('a@b');
    await until(() => fk.st.events.length === 1);
    return e;
  }

  it('loads settings/projects/cards/sessionIndex/global memory after the first machines event', async () => {
    const fk = fakeSaas();
    fk.st.settings = { e2e: true, autoCompact: AC };
    fk.st.projects = [proj('p_1')];
    fk.st.cards = [card('c_1', { projectId: 'p_1' })];
    fk.st.index = [idx(WID, 's1', { projectId: 'p_1' })];
    fk.st.memory = { scope: 'global', projectId: null, content: 'remember', updatedAt: 't' };
    const e = await login(fk);
    expect(e.store.getState().settings).toBeNull();
    expect(gets(fk)).toEqual([]);
    fk.saasEvt({ type: 'machines', machines: [] });
    await until(() => e.store.getState().settings !== null && Object.keys(e.store.getState().memories).length > 0);
    expect(gets(fk).sort()).toEqual([...LOAD].sort());
    const s = e.store.getState();
    expect(s.settings).toEqual({ e2e: true, autoCompact: AC });
    expect(s.projects).toEqual({ p_1: proj('p_1') });
    expect(s.cards).toEqual({ c_1: card('c_1', { projectId: 'p_1' }) });
    expect(s.sessionIndex).toEqual({ [`${WID}/s1`]: idx(WID, 's1', { projectId: 'p_1' }) });
    expect(s.memories).toEqual({ global: fk.st.memory });
    // a later machines-type event on the same stream does not reload
    fk.saasEvt({ type: 'machine.updated', machine: { ...machine, online: false } });
    await new Promise((r) => setTimeout(r, 50));
    expect(gets(fk)).toHaveLength(LOAD.length);
  });

  it('reduces collab SaaS events incrementally', async () => {
    const fk = fakeSaas();
    fk.st.projects = [proj('p_1'), proj('p_2')];
    fk.st.cards = [card('c_1'), card('c_2', { projectId: 'p_1' })];
    fk.st.index = [idx(WID, 's1', { projectId: 'p_1' }), idx(WID, 's2', { projectId: 'p_2' }), idx('w_two', 's9')];
    const e = await login(fk);
    fk.saasEvt({ type: 'machines', machines: [] });
    await until(() => e.store.getState().settings !== null);
    const st = () => e.store.getState();

    fk.saasEvt({ type: 'card.updated', card: card('c_1', { state: 'queued', workerId: WID }) });
    fk.saasEvt({ type: 'card.updated', card: card('c_3') });
    await until(() => st().cards.c_3);
    expect(st().cards.c_1).toMatchObject({ state: 'queued', workerId: WID });
    fk.saasEvt({ type: 'card.removed', cardId: 'c_3' });
    await until(() => !st().cards.c_3);

    fk.saasEvt({ type: 'project.updated', project: proj('p_3', { name: 'New' }) });
    await until(() => st().projects.p_3?.name === 'New');
    fk.saasEvt({ type: 'project.removed', projectId: 'p_1' });
    await until(() => !st().projects.p_1);
    expect(st().sessionIndex[`${WID}/s1`]!.projectId).toBeNull();
    expect(st().sessionIndex[`${WID}/s2`]!.projectId).toBe('p_2');
    expect(st().cards.c_2).toBeUndefined(); // a removed project's cards are removed with it

    const pm: MemoryDoc = { scope: 'project', projectId: 'p_2', content: 'pm', updatedAt: 'x' };
    fk.saasEvt({ type: 'memory.updated', memory: pm });
    await until(() => st().memories['project:p_2']);
    expect(st().memories['project:p_2']).toEqual(pm);

    fk.saasEvt({ type: 'settings.updated', settings: { e2e: true, autoCompact: AC } });
    await until(() => st().settings?.e2e === true);

    // session.indexed incremental: upsert + remove
    fk.saasEvt({ type: 'session.indexed', workerId: WID, full: false, sessions: [idx(WID, 's3'), idx(WID, 's2', { title: 'renamed' })], removed: ['s1'] });
    await until(() => st().sessionIndex[`${WID}/s3`]);
    expect(Object.keys(st().sessionIndex).sort()).toEqual([`${WID}/s2`, `${WID}/s3`, 'w_two/s9']);
    expect(st().sessionIndex[`${WID}/s2`]!.title).toBe('renamed');
    // session.indexed full: replaces only that worker's entries
    fk.saasEvt({ type: 'session.indexed', workerId: WID, full: true, sessions: [idx(WID, 's7')], removed: [] });
    await until(() => st().sessionIndex[`${WID}/s7`]);
    expect(Object.keys(st().sessionIndex).sort()).toEqual([`${WID}/s7`, 'w_two/s9']);
  });

  it('an SSE reconnect triggers a fresh full load', async () => {
    const fk = fakeSaas();
    const e = await login(fk);
    fk.saasEvt({ type: 'machines', machines: [] });
    await until(() => gets(fk).length === LOAD.length);
    fk.st.cards = [card('c_new')];
    fk.st.events[0]!.close();
    await until(() => fk.st.events.length === 2, 4000);
    fk.saasEvt({ type: 'machines', machines: [] }, 1);
    await until(() => e.store.getState().cards.c_new);
    expect(gets(fk)).toHaveLength(LOAD.length * 2);
  });

  it('R3-F4: a full reload drops stale project memories', async () => {
    const fk = fakeSaas();
    const e = await login(fk);
    fk.saasEvt({ type: 'machines', machines: [] });
    await until(() => gets(fk).length === LOAD.length);
    fk.saasEvt({ type: 'memory.updated', memory: { scope: 'project', projectId: 'p_1', content: 'old', updatedAt: 'x' } });
    await until(() => e.store.getState().memories['project:p_1']);
    fk.st.events[0]!.close();
    await until(() => fk.st.events.length === 2, 4000);
    fk.saasEvt({ type: 'machines', machines: [] }, 1);
    await until(() => gets(fk).length === LOAD.length * 2);
    await until(() => !e.store.getState().memories['project:p_1']);
    expect(e.store.getState().memories).toEqual({ global: fk.st.memory });
  });

  it('R3-F5: card.updated arriving while the collab load is in flight survives the (stale) snapshot', async () => {
    const fk = fakeSaas();
    fk.st.cards = [card('c_1')];
    let release!: () => void;
    fk.st.restGate = new Promise<void>((r) => { release = r; });
    const e = await login(fk);
    fk.saasEvt({ type: 'machines', machines: [] });
    await until(() => gets(fk).includes('GET /api/cards'));
    fk.saasEvt({ type: 'card.updated', card: card('c_1', { state: 'queued' }) });
    fk.saasEvt({ type: 'card.updated', card: card('c_2') });
    await until(() => e.store.getState().cards.c_1?.state === 'queued');
    release(); // snapshot still has the stale inbox c_1 and no c_2
    await until(() => e.store.getState().settings !== null);
    expect(e.store.getState().cards.c_1).toMatchObject({ state: 'queued' });
    expect(e.store.getState().cards.c_2).toBeTruthy();
  });

  it('F2: loadMemory/saveMemory results arriving while the collab load is in flight survive the snapshot', async () => {
    const fk = fakeSaas();
    let release!: () => void;
    fk.st.restGate = new Promise<void>((r) => { release = r; });
    const e = await login(fk);
    fk.saasEvt({ type: 'machines', machines: [] });
    await until(() => gets(fk).includes('GET /api/cards') && gets(fk).includes('GET /api/memory?scope=global'));
    const p1: MemoryDoc = { scope: 'project', projectId: 'p_1', content: 'loaded', updatedAt: 'x' };
    fk.st.memory = p1;
    await e.loadMemory('project', 'p_1');
    const p2: MemoryDoc = { scope: 'project', projectId: 'p_2', content: 'saved', updatedAt: 'y' };
    fk.st.memory = p2;
    await e.saveMemory('project', 'p_2', 'saved');
    expect(e.store.getState().memories['project:p_1']).toEqual(p1);
    release(); // snapshot replaces memories with just the global doc
    await until(() => e.store.getState().settings !== null);
    expect(e.store.getState().memories['project:p_1']).toEqual(p1);
    expect(e.store.getState().memories['project:p_2']).toEqual(p2);
  });

  it('updateCard PATCHes /api/cards/:id with the CardPatch and stores the result', async () => {
    const fk = fakeSaas();
    fk.st.cards = [card('c_1')];
    const e = await login(fk);
    fk.saasEvt({ type: 'machines', machines: [] });
    await until(() => e.store.getState().cards.c_1);
    const c = await e.updateCard('c_1', { state: 'queued', workerId: WID, order: 2 });
    expect(c).toMatchObject({ id: 'c_1', state: 'queued', workerId: WID, order: 2 });
    expect(fk.st.reqs.at(-1)).toEqual({ method: 'PATCH', path: '/api/cards/c_1', body: { state: 'queued', workerId: WID, order: 2 } });
    expect(e.store.getState().cards.c_1).toMatchObject({ state: 'queued' });
    await e.setE2e(true);
    expect(fk.st.reqs.at(-1)).toEqual({ method: 'PATCH', path: '/api/settings', body: { e2e: true } });
    expect(e.store.getState().settings).toEqual({ e2e: true, autoCompact: AC });
  });

  it('channel mode follows settings: null → sealed, e2e:false → plain, e2e:true → sealed', async () => {
    const fk = fakeSaas();
    const e = await login(fk);
    fk.saasEvt({ type: 'machines', machines: [machine] });
    await until(() => e.store.getState().machines[WID]);
    fk.st.rpc = () => ({ ok: true, result: { ok: 1 } });
    // settings loaded (e2e:false by default); the null → sealed case is the next test
    await until(() => e.store.getState().settings !== null);
    const before = fk.st.plainReqs;
    await expect(e.rpc(WID, 'worker.info', {} as never)).resolves.toEqual({ ok: 1 });
    expect(fk.st.plainReqs).toBe(before + 1);
    fk.saasEvt({ type: 'settings.updated', settings: { e2e: true, autoCompact: AC } });
    await until(() => e.store.getState().settings?.e2e === true);
    await expect(e.rpc(WID, 'worker.info', {} as never)).resolves.toEqual({ ok: 1 });
    expect(fk.st.plainReqs).toBe(before + 1);
  });

  it('settings null uses the sealed channel', async () => {
    const fk = fakeSaas();
    const e = await login(fk);
    // no machines event yet → settings never loaded
    e.store.setState({ machines: { [WID]: machine } });
    fk.st.rpc = () => ({ ok: true, result: { ok: 1 } });
    await expect(e.rpc(WID, 'worker.info', {} as never)).resolves.toEqual({ ok: 1 });
    expect(fk.st.plainReqs).toBe(0);
  });
});

describe('NoPearEngine access (login allowlist)', () => {
  function fakeAllowlistSaas() {
    const st = {
      me: { user: { id: 'u', email: 'a@b' }, role: null as 'admin' | 'member' | null, allowlistEnabled: false },
      meCalls: 0, meUnauthorized: false,
      entries: [] as { email: string; role: 'admin' | 'member'; addedBy: string; createdAt: string }[],
      reqs: [] as string[],
    };
    const f = (async (url: string, init: RequestInit = {}) => {
      const u = new URL(url);
      const method = init.method ?? 'GET';
      if (u.pathname === '/api/auth/dev') return Response.json({ token: 'tok', user: st.me.user });
      if (u.pathname === '/api/me') {
        st.meCalls++;
        if (st.meUnauthorized) return Response.json({ error: { code: 'unauthorized', message: 'x' } }, { status: 401 });
        return Response.json(st.me);
      }
      if (u.pathname === '/api/clients') return Response.json({ client: {} }, { status: 201 });
      if (u.pathname === '/api/events') return new Stream().res;
      if (u.pathname.startsWith('/api/admin/allowlist')) {
        st.reqs.push(`${method} ${u.pathname}`);
        if (method === 'GET') return Response.json({ entries: st.entries });
        const email = decodeURIComponent(u.pathname.split('/').pop()!);
        if (method === 'PUT') {
          const e = { email, role: JSON.parse(String(init.body)).role, addedBy: 'a@b', createdAt: 't' };
          st.entries = [...st.entries.filter((x) => x.email !== email), e];
          return Response.json({ entry: e });
        }
        st.entries = st.entries.filter((x) => x.email !== email);
        return Response.json({ ok: true });
      }
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    return { st, fetch: f };
  }
  const mk = (f: typeof fetch) => createNoPearEngine({ platform: { fetch: f, storage: memoryKV(), secureStorage: memoryKV() }, defaultSaasUrl: 'https://saas.test', clientLabel: 't' });

  it('access is set from me() on login and cleared on logout', async () => {
    const fk = fakeAllowlistSaas();
    engine = mk(fk.fetch);
    await engine.init();
    expect(engine.store.getState().access).toBeNull();
    await engine.loginDev('a@b');
    expect(engine.store.getState().access).toEqual({ role: null, allowlistEnabled: false });
    expect(engine.store.getState().user).toEqual({ id: 'u', email: 'a@b' });
    await engine.logout();
    expect(engine.store.getState().access).toBeNull();
  });

  it('putAllowlist / deleteAllowlist refresh access via me(); listAllowlist returns entries', async () => {
    const fk = fakeAllowlistSaas();
    engine = mk(fk.fetch);
    await engine.init();
    await engine.loginDev('a@b');
    // Enabling open mode: make me admin.
    fk.st.me = { ...fk.st.me, role: 'admin', allowlistEnabled: true };
    const before = fk.st.meCalls;
    const e = await engine.putAllowlist('a@b', 'admin');
    expect(e.email).toBe('a@b');
    expect(fk.st.meCalls).toBe(before + 1);
    expect(engine.store.getState().access).toEqual({ role: 'admin', allowlistEnabled: true });
    expect((await engine.listAllowlist()).map((x) => x.email)).toEqual(['a@b']);
    // Demoting self → refreshed to member.
    fk.st.me = { ...fk.st.me, role: 'member' };
    await engine.deleteAllowlist('other@x.com');
    expect(fk.st.meCalls).toBe(before + 2);
    expect(engine.store.getState().access).toEqual({ role: 'member', allowlistEnabled: true });
    expect(fk.st.reqs).toEqual(['PUT /api/admin/allowlist/a%40b', 'GET /api/admin/allowlist', 'DELETE /api/admin/allowlist/other%40x.com']);
  });

  it('removing yourself: the refresh me() is 401 → logged out', async () => {
    const fk = fakeAllowlistSaas();
    engine = mk(fk.fetch);
    await engine.init();
    await engine.loginDev('a@b');
    fk.st.meUnauthorized = true;
    await engine.deleteAllowlist('a@b');
    const s = engine.store.getState();
    expect(s.token).toBeNull();
    expect(s.user).toBeNull();
    expect(s.access).toBeNull();
  });
});

describe('NoPearEngine snapshot cache', () => {
  const URL0 = 'https://saas.test';
  const CK = `nopear.cache.v1:${URL0}:u`;
  const PTR = 'nopear.cache.v1.current';
  const info = { workerId: WID, label: 'm', version: '3', defaultCwd: '/', defaultModel: 'm', defaultThinking: 'medium', models: [] };
  const project: Project = { id: 'p1', name: 'P', description: '', paths: {}, createdAt: '', updatedAt: '' } as Project;
  function countingKV(init: Record<string, string> = {}) {
    const kv = memoryKV(init);
    const sets: string[] = [];
    return { ...kv, sets, async set(k: string, v: string) { sets.push(k); await kv.set(k, v); } };
  }
  /** fakeSaas whose /api/me and /api/settings can be held until released. */
  function gated(fk: ReturnType<typeof fakeSaas>) {
    const g = { me: null as Promise<void> | null, settings: null as Promise<void> | null };
    const f = (async (url: string, init?: RequestInit) => {
      const p = new URL(url).pathname;
      if (p === '/api/me' && g.me) await g.me;
      if (p === '/api/settings' && g.settings) await g.settings;
      return fk.fetch(url, init);
    }) as unknown as typeof fetch;
    return { g, f };
  }
  const mk = (f: typeof fetch, storage: ReturnType<typeof countingKV>, secure = memoryKV({ 'nopear.token': 'tok1' })) =>
    createNoPearEngine({ platform: { fetch: f, storage, secureStorage: secure }, defaultSaasUrl: URL0, clientLabel: 't', cacheDelayMs: 30 });
  const seed = (p: Record<string, unknown> = {}, userId = 'u') => ({
    [PTR]: JSON.stringify({ saasUrl: URL0, userId }),
    [`nopear.cache.v1:${URL0}:${userId}`]: JSON.stringify({
      version: 1, saasUrl: URL0, user: { id: userId, email: 'a@b' }, access: { role: null, allowlistEnabled: false }, settings: { e2e: false },
      machines: { [WID]: machine, w_gone: { ...machine, workerId: 'w_gone' } },
      workerInfo: { [WID]: info },
      sessions: { [WID]: { s_old: sess({ id: 's_old', title: 'Old' }) }, w_gone: { s2: sess({ id: 's2', workerId: 'w_gone' }) } },
      projects: { p1: project }, cards: {}, sessionIndex: {}, ...p,
    }),
  });

  it('persists sidebar slices (no timelines) and a fresh engine renders them before any network data', async () => {
    const fk = fakeSaas();
    fk.st.projects = [project];
    const storage = countingKV();
    const secure = memoryKV();
    engine = mk(fk.fetch, storage, secure);
    await engine.init();
    await engine.loginDev('a@b');
    await until(() => fk.st.events.length === 1);
    fk.saasEvt({ type: 'machines', machines: [machine] });
    await until(() => fk.st.watches.some((w) => w.h.op === 'machine.watch'));
    fk.evt(fk.st.watches.find((w) => w.h.op === 'machine.watch')!, { type: 'snapshot', worker: info, sessions: [sess()] });
    await until(() => engine!.store.getState().sessions[WID]?.s1 && engine!.store.getState().projects.p1);
    let cached: Record<string, unknown> = {};
    await until(() => {
      const raw = storage.data.get(CK);
      if (!raw) return false;
      cached = JSON.parse(raw) as Record<string, unknown>;
      return (cached.projects as Record<string, unknown>).p1 && (cached.sessions as Record<string, Record<string, unknown>>)[WID]?.s1;
    });
    expect(cached.version).toBe(1);
    expect(cached).not.toHaveProperty('timelines');
    expect(cached).not.toHaveProperty('drafts');
    expect(cached.user).toEqual({ id: 'u', email: 'a@b' });
    expect(JSON.parse(storage.data.get(PTR)!)).toEqual({ saasUrl: URL0, userId: 'u' });
    engine.dispose();

    const fk2 = fakeSaas();
    const { g, f } = gated(fk2);
    g.me = new Promise(() => {}); // the network never answers
    engine = mk(f, storage, secure);
    await engine.init(); // returns without waiting for /api/me
    const s = engine.store.getState();
    expect(s.syncing).toBe(true);
    expect(s.user?.id).toBe('u');
    expect(s.sessions[WID]?.s1?.title).toBe('T');
    expect(s.projects.p1?.name).toBe('P');
    expect(s.workerInfo[WID]?.defaultCwd).toBe('/');
    expect(s.machines[WID]?.online).toBe(false); // not claimed online until presence arrives
    expect(s.machineConn[WID]).toBe('connecting');
  });

  it('live machines + machine.watch snapshot replace stale cached state; removed machines disappear', async () => {
    const fk = fakeSaas();
    const storage = countingKV(seed());
    engine = mk(fk.fetch, storage);
    await engine.init();
    expect(engine.store.getState().sessions.w_gone?.s2).toBeTruthy();
    await until(() => fk.st.events.length === 1);
    fk.saasEvt({ type: 'machines', machines: [machine] });
    await until(() => !engine!.store.getState().machines.w_gone);
    const s = engine.store.getState();
    expect(s.sessions.w_gone).toBeUndefined();
    expect(s.syncing).toBe(false);
    expect(s.machines[WID]?.online).toBe(true);
    expect(s.sessions[WID]?.s_old).toBeTruthy(); // still the cached list until the live snapshot lands
    await until(() => fk.st.watches.some((w) => w.h.op === 'machine.watch'));
    fk.evt(fk.st.watches.find((w) => w.h.op === 'machine.watch')!, { type: 'snapshot', worker: info, sessions: [sess()] });
    await until(() => engine!.store.getState().sessions[WID]?.s1);
    expect(Object.keys(engine.store.getState().sessions[WID]!)).toEqual(['s1']);
    // collab load replaced the cached projects (server has none)
    await until(() => Object.keys(engine!.store.getState().projects).length === 0);
    await until(() => {
      const c = JSON.parse(storage.data.get(CK)!) as { sessions: Record<string, Record<string, unknown>>; machines: Record<string, unknown> };
      return !c.machines.w_gone && c.sessions[WID]?.s1 && !c.sessions[WID]?.s_old;
    });
  });

  it('a cached e2e:false never makes the data plane plaintext before live settings arrive', async () => {
    const fk = fakeSaas();
    const { g, f } = gated(fk);
    let release!: () => void;
    g.settings = new Promise<void>((r) => { release = r; });
    engine = mk(f, countingKV(seed()));
    await engine.init();
    await until(() => fk.st.events.length === 1);
    fk.saasEvt({ type: 'machines', machines: [machine] });
    await until(() => fk.st.watches.some((w) => w.h.op === 'machine.watch'));
    expect(fk.st.watches[0]!.plain).toBe(false);
    release();
    await until(() => fk.st.reqs.some((r) => r.path === '/api/settings'));
    await new Promise((r) => setTimeout(r, 50));
    expect(fk.st.watches.filter((w) => w.h.op === 'machine.watch')).toHaveLength(1); // no churn: cached → live is not a mode change
  });

  it('logout clears the cache and pointer', async () => {
    const fk = fakeSaas();
    const storage = countingKV(seed());
    engine = mk(fk.fetch, storage);
    await engine.init();
    await until(() => engine!.store.getState().clientPub && fk.st.clients.length === 1);
    await engine.logout();
    expect(storage.data.has(CK)).toBe(false);
    expect(storage.data.has(PTR)).toBe(false);
    const s = engine.store.getState();
    expect(s.sessions).toEqual({});
    expect(s.machines).toEqual({});
    expect(s.syncing).toBe(false);
    await new Promise((r) => setTimeout(r, 80));
    expect(storage.data.has(CK)).toBe(false);
  });

  it('a version mismatch or corrupt cache is ignored and discarded', async () => {
    for (const raw of [JSON.stringify({ ...JSON.parse(seed()[CK]!), version: 999 }), '{not json']) {
      const fk = fakeSaas();
      const storage = countingKV({ ...seed(), [CK]: raw });
      engine = mk(fk.fetch, storage);
      await engine.init();
      const s = engine.store.getState();
      expect(s.sessions).toEqual({});
      expect(s.machines).toEqual({});
      expect(s.syncing).toBe(false);
      expect(storage.data.get(CK)).not.toBe(raw);
      engine.dispose();
    }
  });

  it('a token for another account drops the cached account state', async () => {
    const fk = fakeSaas();
    const storage = countingKV(seed({}, 'other'));
    engine = mk(fk.fetch, storage);
    await engine.init();
    expect(engine.store.getState().user?.id).toBe('other');
    await until(() => engine!.store.getState().user?.id === 'u');
    const s = engine.store.getState();
    expect(s.sessions).toEqual({});
    expect(s.projects).toEqual({});
    expect(storage.data.has(`nopear.cache.v1:${URL0}:other`)).toBe(false);
  });

  it('streaming message deltas do not rewrite the cache', async () => {
    const fk = fakeSaas();
    const storage = countingKV();
    engine = mk(fk.fetch, storage, memoryKV());
    await engine.init();
    await engine.loginDev('a@b');
    await until(() => fk.st.events.length === 1);
    fk.saasEvt({ type: 'machines', machines: [machine] });
    await until(() => fk.st.watches.some((w) => w.h.op === 'machine.watch'));
    fk.evt(fk.st.watches.find((w) => w.h.op === 'machine.watch')!, { type: 'snapshot', worker: info, sessions: [sess()] });
    engine.openSession(WID, 's1');
    await until(() => fk.st.watches.some((w) => w.h.op === 'session.watch'));
    const sw = fk.st.watches.find((w) => w.h.op === 'session.watch')!;
    fk.evt(sw, { type: 'snapshot', cursor: 'e.0', session: sess(), messages: [], hasMore: false, prompts: [], tasks: [] });
    fk.evt(sw, { type: 'message.upsert', cursor: 'e.1', message: { id: 'live:1', sessionId: 's1', role: 'assistant', blocks: [], ts: '', status: 'streaming' } });
    await until(() => engine!.store.getState().timelines[`${WID}/s1`]?.cursor === 'e.1');
    await until(() => engine!.store.getState().settings !== null);
    await new Promise((r) => setTimeout(r, 150)); // let the debounced writes settle
    const writes = () => storage.sets.filter((k) => k === CK).length;
    const before = writes();
    expect(before).toBeGreaterThan(0);
    for (let i = 0; i < 50; i++) fk.evt(sw, { type: 'message.delta', cursor: `e.${i + 2}`, messageId: 'live:1', index: 0, kind: 'text', text: 'x' });
    await until(() => engine!.store.getState().timelines[`${WID}/s1`]?.cursor === 'e.51');
    await new Promise((r) => setTimeout(r, 150));
    expect(writes()).toBe(before);
  });
});

describe('NoPearEngine timeline cache', () => {
  const URL0 = 'https://saas.test';
  const K = `${WID}/s1`;
  const TK = (sid = 's1') => `nopear.tl.v1:${URL0}:u:${WID}/${sid}`;
  const IDX = 'nopear.tl.v1.index';
  const msg = (id: string, p: Partial<Message> = {}): Message => ({ id, sessionId: 's1', role: 'assistant', blocks: [{ type: 'text', text: id }], ts: '', status: 'complete', ...p });
  function countingKV() {
    const kv = memoryKV();
    const sets: string[] = [];
    return { ...kv, sets, async set(k: string, v: string) { sets.push(k); await kv.set(k, v); } };
  }
  type Parts = { storage: ReturnType<typeof countingKV>; secure: ReturnType<typeof memoryKV>; big: ReturnType<typeof countingKV> };
  const parts = (): Parts => ({ storage: countingKV(), secure: memoryKV(), big: countingKV() });
  const mk = (f: typeof fetch, p: Parts, o: { timelineDelayMs?: number; timelineMaxSessions?: number } = {}) =>
    createNoPearEngine({ platform: { fetch: f, storage: p.storage, secureStorage: p.secure, bigStorage: p.big }, defaultSaasUrl: URL0, clientLabel: 't', cacheDelayMs: 30, ...o });
  const sws = (fk: ReturnType<typeof fakeSaas>) => fk.st.watches.filter((w) => w.h.op === 'session.watch' && !w.aborted);
  const ids = (e: NoPearEngine, key = K) => e.store.getState().timelines[key]?.messages.map((m) => m.id);
  const record = (p: Parts, sid = 's1') => JSON.parse(p.big.data.get(TK(sid)) ?? 'null') as { cursor: string; messages: Message[]; hasMore: boolean; version: number; savedAt: string } | null;

  async function login(fk: ReturnType<typeof fakeSaas>, p: Parts, o?: Parameters<typeof mk>[2]) {
    const e = mk(fk.fetch, p, o);
    engine = e;
    await e.init();
    await e.loginDev('a@b');
    await until(() => fk.st.events.length === 1);
    fk.saasEvt({ type: 'machines', machines: [machine] });
    await until(() => e.store.getState().machines[WID]?.online);
    return e;
  }
  async function openWith(e: NoPearEngine, fk: ReturnType<typeof fakeSaas>, sid: string, snap: { cursor: string; messages: Message[]; hasMore: boolean }) {
    const before = fk.st.watches.length;
    e.openSession(WID, sid);
    await until(() => fk.st.watches.slice(before).some((w) => w.h.op === 'session.watch'));
    const w = fk.st.watches.slice(before).find((x) => x.h.op === 'session.watch')!;
    fk.evt(w, { type: 'snapshot', session: sess({ id: sid }), prompts: [], tasks: [], ...snap });
    await until(() => e.store.getState().timelines[`${WID}/${sid}`]?.cursor === snap.cursor);
    return w;
  }
  /** First run: open s1, receive a snapshot, flush the cache, quit. */
  async function seed(p: Parts, snap: { cursor: string; messages: Message[]; hasMore: boolean }) {
    const fk = fakeSaas();
    const e = await login(fk, p);
    await openWith(e, fk, 's1', snap);
    e.flushCache();
    await until(() => record(p)?.cursor === snap.cursor);
    e.dispose();
  }
  /** "Refresh": a new engine over the same storages. */
  async function reopen(p: Parts) {
    const fk = fakeSaas();
    const e = mk(fk.fetch, p);
    engine = e;
    await e.init();
    return { fk, e };
  }

  it('a refreshed engine renders cached messages before the network and watches from the cached cursor', async () => {
    const p = parts();
    await seed(p, { cursor: 'ep.3', messages: [msg('m1'), msg('m2'), msg('m3')], hasMore: false });
    const r = record(p)!;
    expect(r.version).toBe(1);
    expect(typeof r.savedAt).toBe('string');
    expect(r.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    const { fk, e } = await reopen(p);
    e.openSession(WID, 's1');
    await until(() => ids(e)?.length === 3);
    expect(ids(e)).toEqual(['m1', 'm2', 'm3']);
    expect(e.store.getState().timelines[K]!.hasMore).toBe(false);
    expect(sws(fk)).toHaveLength(0); // no presence yet: nothing from the network
    await until(() => fk.st.events.length === 1);
    fk.saasEvt({ type: 'machines', machines: [machine] });
    await until(() => sws(fk).length === 1);
    expect((sws(fk)[0]!.h.args as { cursor?: string }).cursor).toBe('ep.3');
  });

  it('opening a session before /api/me resolves (no sidebar cache) still hydrates once the account is known', async () => {
    const p = parts();
    await seed(p, { cursor: 'ep.3', messages: [msg('m1')], hasMore: false });
    for (const k of [...p.storage.data.keys()]) if (k.startsWith('nopear.cache.v1')) p.storage.data.delete(k);
    const fk = fakeSaas();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const f = (async (url: string, init?: RequestInit) => {
      if (new URL(url).pathname === '/api/me') await gate;
      return fk.fetch(url, init);
    }) as unknown as typeof fetch;
    const e = mk(f, p);
    engine = e;
    const booting = e.init();
    await until(() => e.store.getState().token);
    e.openSession(WID, 's1');
    await new Promise((r) => setTimeout(r, 30));
    expect(e.store.getState().user).toBeNull();
    expect(ids(e)).toBeUndefined();
    release();
    await booting;
    await until(() => ids(e)?.length === 1);
    await until(() => fk.st.events.length === 1);
    fk.saasEvt({ type: 'machines', machines: [machine] });
    await until(() => sws(fk).length === 1);
    expect((sws(fk)[0]!.h.args as { cursor?: string }).cursor).toBe('ep.3');
  });

  it('a replay from the cached cursor yields the same timeline a fresh snapshot would (no duplicates, live replaced)', async () => {
    const p = parts();
    await seed(p, { cursor: 'ep.3', messages: [msg('m1'), msg('m2', { role: 'user' }), msg('m3')], hasMore: false });
    const { fk, e } = await reopen(p);
    e.openSession(WID, 's1');
    await until(() => fk.st.events.length === 1);
    fk.saasEvt({ type: 'machines', machines: [machine] });
    await until(() => sws(fk).length === 1);
    const w = sws(fk)[0]!;
    fk.evt(w, { type: 'message.upsert', cursor: 'ep.4', message: msg('m4', { role: 'user' }) });
    fk.evt(w, { type: 'message.upsert', cursor: 'ep.5', message: msg('live:1', { status: 'streaming', blocks: [] }) });
    fk.evt(w, { type: 'message.delta', cursor: 'ep.6', messageId: 'live:1', index: 0, kind: 'text', text: 'hel' });
    fk.evt(w, { type: 'message.delta', cursor: 'ep.7', messageId: 'live:1', index: 0, kind: 'text', text: 'lo' });
    fk.evt(w, { type: 'message.upsert', cursor: 'ep.8', message: msg('m5', { blocks: [{ type: 'text', text: 'hello' }] }), replaces: 'live:1' });
    fk.evt(w, { type: 'message.upsert', cursor: 'ep.9', message: msg('m3', { blocks: [{ type: 'text', text: 'm3 edited' }] }) });
    await until(() => e.store.getState().timelines[K]?.cursor === 'ep.9');
    const t = e.store.getState().timelines[K]!;
    expect(t.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
    expect(t.messages[2]!.blocks).toEqual([{ type: 'text', text: 'm3 edited' }]);
    expect(t.messages[4]!.blocks).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('a snapshot answer (epoch changed / too old) fully replaces the stale cached messages', async () => {
    const p = parts();
    await seed(p, { cursor: 'ep.3', messages: [msg('m1'), msg('m2'), msg('m3')], hasMore: false });
    const { fk, e } = await reopen(p);
    e.openSession(WID, 's1');
    await until(() => ids(e)?.length === 3);
    await until(() => fk.st.events.length === 1);
    fk.saasEvt({ type: 'machines', machines: [machine] });
    await until(() => sws(fk).length === 1);
    // m2 is in the cache: the ordinary reconnect merge would keep m1 in front of it
    fk.evt(sws(fk)[0]!, { type: 'snapshot', cursor: 'ep2.1', session: sess(), messages: [msg('m2'), msg('mX')], hasMore: true, prompts: [], tasks: [] });
    await until(() => e.store.getState().timelines[K]?.cursor === 'ep2.1');
    expect(ids(e)).toEqual(['m2', 'mX']);
    expect(e.store.getState().timelines[K]!.hasMore).toBe(true);
  });

  it('keeps only the most recently opened sessions (LRU index) and evicts the rest', async () => {
    const p = parts();
    const fk = fakeSaas();
    const e = await login(fk, p, { timelineDelayMs: 20, timelineMaxSessions: 3 });
    for (const sid of ['s1', 's2', 's3', 's4', 's5']) {
      await openWith(e, fk, sid, { cursor: `ep.${sid}`, messages: [msg(`${sid}m`)], hasMore: false });
      await until(() => record(p, sid)?.cursor === `ep.${sid}`);
    }
    await until(() => !p.big.data.has(TK('s1')) && !p.big.data.has(TK('s2')));
    expect(['s3', 's4', 's5'].every((s) => p.big.data.has(TK(s)))).toBe(true);
    expect((JSON.parse(p.big.data.get(IDX)!) as { keys: string[] }).keys).toEqual([TK('s3'), TK('s4'), TK('s5')]);
  });

  it('streaming deltas do not write the timeline cache; the completed message does', async () => {
    const p = parts();
    const fk = fakeSaas();
    const e = await login(fk, p, { timelineDelayMs: 20 });
    const w = await openWith(e, fk, 's1', { cursor: 'e.0', messages: [msg('m1')], hasMore: false });
    await until(() => record(p)?.cursor === 'e.0');
    const writes = () => p.big.sets.filter((k) => k === TK()).length;
    const before = writes();
    fk.evt(w, { type: 'message.upsert', cursor: 'e.1', message: msg('live:1', { status: 'streaming', blocks: [] }) });
    for (let i = 0; i < 50; i++) fk.evt(w, { type: 'message.delta', cursor: `e.${i + 2}`, messageId: 'live:1', index: 0, kind: 'text', text: 'x' });
    await until(() => e.store.getState().timelines[K]?.cursor === 'e.51');
    await new Promise((r) => setTimeout(r, 120));
    expect(writes()).toBe(before);
    expect(record(p)!.cursor).toBe('e.0'); // the last state without a live message
    fk.evt(w, { type: 'message.upsert', cursor: 'e.52', message: msg('m2'), replaces: 'live:1' });
    await until(() => record(p)?.cursor === 'e.52');
    expect(writes()).toBe(before + 1);
    expect(record(p)!.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('pending sends and capped history: only confirmed messages are cached, older ones flagged hasMore', async () => {
    const p = parts();
    const fk = fakeSaas();
    const e = await login(fk, p, { timelineDelayMs: 20 });
    const many = Array.from({ length: 320 }, (_, i) => msg(`m${i}`));
    const w = await openWith(e, fk, 's1', { cursor: 'e.1', messages: many, hasMore: false });
    fk.st.rpc = () => ({ ok: false, error: { code: 'internal', message: 'boom' } });
    await e.send(WID, 's1', 'unsent'); // stays as a failed optimistic bubble
    expect(e.store.getState().timelines[K]!.messages.at(-1)!.id.startsWith('local:')).toBe(true);
    fk.evt(w, { type: 'tasks', cursor: 'e.2', tasks: [] });
    await until(() => record(p)?.cursor === 'e.2');
    const r = record(p)!;
    expect(r.messages).toHaveLength(300);
    expect(r.messages[0]!.id).toBe('m20');
    expect(r.messages.some((m) => m.id.startsWith('local:'))).toBe(false);
    expect(r.hasMore).toBe(true);
  });

  it('logout and a SaaS URL change clear the account\'s timeline cache', async () => {
    const p = parts();
    const fk = fakeSaas();
    const e = await login(fk, p, { timelineDelayMs: 20 });
    await openWith(e, fk, 's1', { cursor: 'e.1', messages: [msg('m1')], hasMore: false });
    await openWith(e, fk, 's2', { cursor: 'e.2', messages: [msg('m2')], hasMore: false });
    await until(() => record(p, 's1') && record(p, 's2'));
    await e.logout();
    expect([...p.big.data.keys()].filter((k) => k.startsWith('nopear.tl.v1'))).toEqual([]);
    await new Promise((r) => setTimeout(r, 80));
    expect([...p.big.data.keys()].filter((k) => k.startsWith('nopear.tl.v1'))).toEqual([]);

    await e.loginDev('a@b');
    await until(() => fk.st.events.length === 2);
    fk.saasEvt({ type: 'machines', machines: [machine] });
    await until(() => e.store.getState().machines[WID]?.online);
    await openWith(e, fk, 's1', { cursor: 'e.3', messages: [msg('m1')], hasMore: false });
    await until(() => record(p, 's1')?.cursor === 'e.3');
    await e.setSaasUrl('https://other.test');
    expect([...p.big.data.keys()].filter((k) => k.startsWith('nopear.tl.v1'))).toEqual([]);
  });

  it('loadEarlier pages older messages after hydration', async () => {
    const p = parts();
    await seed(p, { cursor: 'ep.5', messages: [msg('m3'), msg('m4'), msg('m5')], hasMore: true });
    const { fk, e } = await reopen(p);
    e.openSession(WID, 's1');
    await until(() => ids(e)?.length === 3);
    await until(() => fk.st.clients.length === 1);
    const pages: unknown[] = [];
    fk.st.rpc = (h) => {
      if (h.op !== 'messages.page') return { ok: true, result: {} };
      pages.push(h.args);
      return { ok: true, result: { messages: [msg('m1'), msg('m2')], hasMore: false } };
    };
    await e.loadEarlier(WID, 's1');
    expect(pages).toEqual([{ sessionId: 's1', limit: 100, before: 'm3' }]);
    expect(ids(e)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
    expect(e.store.getState().timelines[K]!.hasMore).toBe(false);
  });
});

describe('NoPearEngine stream liveness (watchdog + resume)', () => {
  const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function bootLive(fk: ReturnType<typeof fakeSaas>, extra: { stallMs?: number; resumeStaleMs?: number }) {
    const e = createNoPearEngine({ platform: { fetch: fk.fetch, storage: memoryKV(), secureStorage: memoryKV() }, defaultSaasUrl: 'https://saas.test', clientLabel: 't', ...extra });
    engine = e;
    await e.init();
    await e.loginDev('a@b');
    await until(() => fk.st.events.length === 1);
    fk.saasEvt({ type: 'machines', machines: [machine] });
    await until(() => fk.st.watches.some((w) => w.h.op === 'machine.watch'));
    const mw = fk.st.watches.find((w) => w.h.op === 'machine.watch')!;
    fk.evt(mw, { type: 'snapshot', worker: { workerId: WID, label: 'm', version: '3', defaultCwd: '/', defaultModel: 'm', defaultThinking: 'medium', models: [] }, sessions: [sess()] });
    await until(() => e.store.getState().machineConn[WID] === 'online');
    return { e, mw };
  }
  const ofOp = (fk: ReturnType<typeof fakeSaas>, op: string) => fk.st.watches.filter((w) => w.h.op === op);
  const snap = (cursor: string) => ({ type: 'snapshot', cursor, session: sess(), messages: [], hasMore: false, prompts: [], tasks: [], queue: [] });

  it('pings keep a stream alive; without them it is aborted after stallMs and reopened (machine.watch + /api/events)', async () => {
    const fk = fakeSaas();
    const { mw } = await bootLive(fk, { stallMs: 200 });
    for (let i = 0; i < 8; i++) { mw.stream.send(': ping\n\n'); fk.st.events[0]!.send(': ping\n\n'); await sleepMs(60); }
    expect(mw.aborted).toBe(false);
    expect(ofOp(fk, 'machine.watch')).toHaveLength(1);
    expect(fk.st.events).toHaveLength(1);
    // silence: the watchdog aborts both streams and the reconnect loops reopen them
    await until(() => mw.aborted && ofOp(fk, 'machine.watch').length === 2 && fk.st.events.length >= 2, 3000);
  });

  it('a stalled session.watch is reopened from its cursor', async () => {
    const fk = fakeSaas();
    const { e } = await bootLive(fk, { stallMs: 200 });
    e.openSession(WID, 's1');
    await until(() => ofOp(fk, 'session.watch').length === 1);
    const sw = ofOp(fk, 'session.watch')[0]!;
    fk.evt(sw, snap('ep.3'));
    await until(() => e.store.getState().timelines[`${WID}/s1`]?.cursor === 'ep.3');
    await until(() => sw.aborted && ofOp(fk, 'session.watch').length === 2, 3000);
    expect((ofOp(fk, 'session.watch')[1]!.h.args as { cursor?: string }).cursor).toBe('ep.3');
  });

  it('resume() reopens silent streams at once (session with cursor) and leaves fresh ones alone', async () => {
    const fk = fakeSaas();
    const { e, mw } = await bootLive(fk, { stallMs: 60_000, resumeStaleMs: 150 });
    e.openSession(WID, 's1');
    await until(() => ofOp(fk, 'session.watch').length === 1);
    const sw = ofOp(fk, 'session.watch')[0]!;
    fk.evt(sw, snap('ep.7'));
    await until(() => e.store.getState().timelines[`${WID}/s1`]?.cursor === 'ep.7');
    // fresh: activity just now → nothing restarts
    mw.stream.send(': ping\n\n'); sw.stream.send(': ping\n\n'); fk.st.events[0]!.send(': ping\n\n');
    await sleepMs(20);
    e.resume();
    await sleepMs(50);
    expect([mw.aborted, sw.aborted]).toEqual([false, false]);
    // silent for longer than the threshold (e.g. the laptop slept) → resume restarts them immediately
    await sleepMs(200);
    const t0 = Date.now();
    e.resume();
    await until(() => mw.aborted && sw.aborted && ofOp(fk, 'machine.watch').length === 2 && ofOp(fk, 'session.watch').length === 2 && fk.st.events.length === 2);
    expect(Date.now() - t0).toBeLessThan(300); // no 400–600ms reconnect backoff
    expect((ofOp(fk, 'session.watch')[1]!.h.args as { cursor?: string }).cursor).toBe('ep.7');
  });

  it('resume() cuts a sleeping reconnect backoff short and revives a session watch that ended while hidden', async () => {
    const fk = fakeSaas();
    const { e } = await bootLive(fk, { stallMs: 60_000, resumeStaleMs: 60_000 });
    e.openSession(WID, 's1');
    await until(() => ofOp(fk, 'session.watch').length === 1);
    const sw = ofOp(fk, 'session.watch')[0]!;
    fk.evt(sw, snap('ep.2'));
    await until(() => e.store.getState().timelines[`${WID}/s1`]?.cursor === 'ep.2');
    const t0 = Date.now();
    sw.stream.close(); // stream dropped → the loop sleeps in backoff (≥ 400ms)
    await sleepMs(50);
    e.resume();
    await until(() => ofOp(fk, 'session.watch').length === 2);
    expect(Date.now() - t0).toBeLessThan(350);
    expect((ofOp(fk, 'session.watch')[1]!.h.args as { cursor?: string }).cursor).toBe('ep.2');
    // the worker ends the watch (no auto-reconnect) → resume() restarts it since the view still holds it
    const sw2 = ofOp(fk, 'session.watch')[1]!;
    sw2.stream.send('event: end\ndata:\n\n');
    await sleepMs(100);
    expect(ofOp(fk, 'session.watch')).toHaveLength(2);
    e.resume();
    await until(() => ofOp(fk, 'session.watch').length === 3);
  });
});
