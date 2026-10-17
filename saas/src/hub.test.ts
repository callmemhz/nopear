import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { b64url, decodeFrame, encodeFrame, fromB64url, generateSigningKey } from '@nopear/core/crypto';
import { SAAS_CLIENT_PUB, type SaasToWorker, type ToolOutcome, type WorkerToSaas } from '@nopear/protocol';
import { openStore } from './store';
import { WorkerHub, type WorkerFrameHandlers } from './hub';

const store = await openStore('sqlite::memory:');
const signing = generateSigningKey();
const user = await store.users.upsertDev('hub@x.com');

const calls: { kind: string; workerId: string; f?: unknown }[] = [];
let toolImpl: (f: Extract<WorkerToSaas, { t: 'tool' }>) => Promise<ToolOutcome> = async () => ({ ok: true, result: null });
const handlers: WorkerFrameHandlers = {
  onHello: async (workerId) => { calls.push({ kind: 'hello', workerId }); },
  onIndex: async (workerId, f) => { calls.push({ kind: 'index', workerId, f }); },
  onCardState: async (workerId, f) => { calls.push({ kind: 'card.state', workerId, f }); },
  onTool: async (_workerId, f) => toolImpl(f),
};
const hub = new WorkerHub({ store, signingSeed: signing.seed, onPresence: () => {}, handlers });

const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
await new Promise<void>((res) => wss.once('listening', () => res()));
const port = (wss.address() as AddressInfo).port;
wss.on('connection', (ws, req) => {
  const workerId = new URL(req.url ?? '/', 'http://x').searchParams.get('w') ?? '';
  hub.attach(workerId, ws);
});
after(async () => {
  hub.close();
  await new Promise<void>((res) => wss.close(() => res()));
  await store.close();
});

interface FakeWorker {
  ws: WebSocket;
  next(pred: (f: SaasToWorker) => boolean): Promise<SaasToWorker>;
  send(f: WorkerToSaas): void;
  close(): Promise<void>;
}

async function connect(workerId: string): Promise<FakeWorker> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?w=${workerId}`);
  const frames: SaasToWorker[] = [];
  const waiters: { pred: (f: SaasToWorker) => boolean; resolve: (f: SaasToWorker) => void }[] = [];
  ws.on('message', (d) => {
    const f = JSON.parse(String(d)) as SaasToWorker;
    const w = waiters.find((x) => x.pred(f));
    if (w) { waiters.splice(waiters.indexOf(w), 1); w.resolve(f); } else frames.push(f);
  });
  await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
  return {
    ws,
    next: (pred) => {
      const hit = frames.find(pred);
      if (hit) { frames.splice(frames.indexOf(hit), 1); return Promise.resolve(hit); }
      return new Promise((resolve) => waiters.push({ pred, resolve }));
    },
    send: (f) => ws.send(JSON.stringify(f)),
    close: () => new Promise<void>((res) => { ws.once('close', () => res()); ws.close(); }),
  };
}

let seq = 0;
async function worker(claimed: boolean): Promise<{ workerId: string; w: FakeWorker }> {
  const workerId = `w${++seq}`;
  assert.equal(await store.workers.register(workerId, `pub-${workerId}`, `hash-${workerId}`), 'ok');
  if (claimed) assert.ok(await store.workers.claimDirect(workerId, user.id, null));
  const w = await connect(workerId);
  return { workerId, w };
}

async function until(pred: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const isAuthz = (f: SaasToWorker) => f.t === 'authz';
const isRpc = (f: SaasToWorker) => f.t === 'rpc';

test('authz carries e2e from settings', async () => {
  const { workerId, w } = await worker(true);
  const a1 = await w.next(isAuthz) as Extract<SaasToWorker, { t: 'authz' }>;
  assert.equal(a1.claimed, true);
  assert.equal(a1.e2e, false);
  await store.settings.put(user.id, { e2e: true, autoCompact: (await store.settings.get(user.id)).autoCompact });
  await hub.pushAuthz(workerId);
  const a2 = await w.next(isAuthz) as Extract<SaasToWorker, { t: 'authz' }>;
  assert.equal(a2.e2e, true);
  await store.settings.put(user.id, { e2e: false, autoCompact: (await store.settings.get(user.id)).autoCompact });

  const un = await worker(false);
  const a3 = await un.w.next(isAuthz) as Extract<SaasToWorker, { t: 'authz' }>;
  assert.equal(a3.claimed, false);
  assert.equal(a3.e2e, false);
  await w.close(); await un.w.close();
});

test('hello calls handlers.onHello; index/card.state reach handlers; tool → tool.res', async () => {
  const { workerId, w } = await worker(true);
  await w.next(isAuthz);
  w.send({ t: 'hello', version: '1', label: 'box' });
  await until(() => calls.some((c) => c.kind === 'hello' && c.workerId === workerId));
  // hello work ran before the handler
  assert.equal((await store.workers.get(workerId))?.version, '1');

  const idx: WorkerToSaas = { t: 'index', full: true, sessions: [], removed: ['s1'] };
  w.send(idx);
  const cs: WorkerToSaas = { t: 'card.state', cardId: 'c_1', state: 'running', sessionId: 's2' };
  w.send(cs);
  await until(() => calls.some((c) => c.kind === 'card.state' && c.workerId === workerId));
  assert.deepEqual(calls.find((c) => c.kind === 'index' && c.workerId === workerId)?.f, idx);
  assert.deepEqual(calls.find((c) => c.kind === 'card.state' && c.workerId === workerId)?.f, cs);

  toolImpl = async (f) => ({ ok: true, result: { echo: f.args, name: f.name, sessionId: f.sessionId } });
  w.send({ t: 'tool', id: 't1', name: 'project_list', args: { a: 1 }, sessionId: 's9' });
  const r1 = await w.next((f) => f.t === 'tool.res' && f.id === 't1');
  assert.deepEqual(r1, { t: 'tool.res', id: 't1', result: { echo: { a: 1 }, name: 'project_list', sessionId: 's9' } });

  toolImpl = async () => ({ ok: false, error: { code: 'not_found', message: 'no such project' } });
  w.send({ t: 'tool', id: 't2', name: 'project_get', args: {} });
  const r2 = await w.next((f) => f.t === 'tool.res' && f.id === 't2');
  assert.deepEqual(r2, { t: 'tool.res', id: 't2', error: { code: 'not_found', message: 'no such project' } });

  toolImpl = async () => { throw new Error('boom'); };
  w.send({ t: 'tool', id: 't3', name: 'project_get', args: {} });
  const r3 = await w.next((f) => f.t === 'tool.res' && f.id === 't3') as Extract<SaasToWorker, { t: 'tool.res' }>;
  assert.equal(r3.error?.code, 'internal');
  assert.equal(r3.result, undefined);
  await w.close();
});

test('plainRpc sends rpc{clientPub:saas, plain:true} and maps outcomes', async () => {
  const { workerId, w } = await worker(true);
  await w.next(isAuthz);

  // success
  const p1 = hub.plainRpc(workerId, 'sessions.get', { sessionId: 's1' });
  const f1 = await w.next(isRpc) as Extract<SaasToWorker, { t: 'rpc' }>;
  assert.equal(f1.clientPub, SAAS_CLIENT_PUB);
  assert.equal(f1.plain, true);
  const h = decodeFrame(fromB64url(f1.payload)).header as { v: number; rid: string; ts: number; op: string; args: unknown };
  assert.equal(h.v, 3);
  assert.equal(h.op, 'sessions.get');
  assert.deepEqual(h.args, { sessionId: 's1' });
  assert.equal(typeof h.rid, 'string');
  assert.ok(Math.abs(h.ts - Date.now()) < 5000);
  w.send({ t: 'rpc.res', id: f1.id, plain: true, payload: b64url(encodeFrame({ ok: true, result: { a: 1 } })) });
  assert.deepEqual(await p1, { ok: true, result: { a: 1 } });

  // header ok:false
  const p2 = hub.plainRpc(workerId, 'sessions.get', { sessionId: 'nope' });
  const f2 = await w.next(isRpc);
  w.send({ t: 'rpc.res', id: (f2 as { id: string }).id, plain: true,
    payload: b64url(encodeFrame({ ok: false, error: { code: 'not_found', message: 'no session' } })) });
  const o2 = await p2;
  assert.equal(o2.ok, false);
  assert.equal(!o2.ok && o2.error.code, 'not_found');

  // NOPEAR_E2E=required
  const p3 = hub.plainRpc(workerId, 'sessions.list', {});
  const f3 = await w.next(isRpc);
  w.send({ t: 'rpc.err', id: (f3 as { id: string }).id, status: 400, code: 'bad_request', message: 'plaintext disabled on this worker' });
  const o3 = await p3;
  assert.equal(!o3.ok && o3.error.code, 'e2e_enabled');

  // 401 for the saas client in plain mode = SaaS-side bug (decode/malformed frame) → internal
  const p4 = hub.plainRpc(workerId, 'sessions.list', {});
  const f4 = await w.next(isRpc);
  w.send({ t: 'rpc.err', id: (f4 as { id: string }).id, status: 401, code: 'unauthorized', message: 'client not authorized' });
  const o4 = await p4;
  assert.equal(!o4.ok && o4.error.code, 'internal');
  assert.equal(!o4.ok && o4.error.message, 'worker rejected internal request: client not authorized');

  // any other 400 → bad_request
  const p4b = hub.plainRpc(workerId, 'sessions.list', {});
  const f4b = await w.next(isRpc);
  w.send({ t: 'rpc.err', id: (f4b as { id: string }).id, status: 400, code: 'bad_request', message: 'bad args' });
  const o4b = await p4b;
  assert.equal(!o4b.ok && o4b.error.code, 'bad_request');
  assert.equal(!o4b.ok && o4b.error.message, 'bad args');

  // timeout
  const o5 = await hub.plainRpc(workerId, 'sessions.list', {}, 50);
  assert.equal(!o5.ok && o5.error.code, 'timeout');
  await w.next(isRpc);

  await w.close();
  await until(() => !hub.isOnline(workerId));
  const o6 = await hub.plainRpc(workerId, 'sessions.list', {});
  assert.equal(!o6.ok && o6.error.code, 'machine_offline');
});

test('rpc/watch relay forwards plain:true when asked', async () => {
  const { workerId, w } = await worker(true);
  await w.next(isAuthz);
  const sink = { data: () => {}, end: () => {}, offline: () => {} };

  void hub.rpc(workerId, 'cpub', 'P1', 50);
  const r1 = await w.next(isRpc) as Extract<SaasToWorker, { t: 'rpc' }>;
  assert.equal(r1.payload, 'P1');
  assert.equal(r1.plain, undefined);
  void hub.rpc(workerId, 'cpub', 'P2', 50, undefined, true);
  const r2 = await w.next(isRpc) as Extract<SaasToWorker, { t: 'rpc' }>;
  assert.equal(r2.payload, 'P2');
  assert.equal(r2.plain, true);

  hub.watch(workerId, 'cpub', 'W1', sink);
  const w1 = await w.next((f) => f.t === 'watch') as Extract<SaasToWorker, { t: 'watch' }>;
  assert.equal(w1.payload, 'W1');
  assert.equal(w1.plain, undefined);
  hub.watch(workerId, 'cpub', 'W2', sink, true);
  const w2 = await w.next((f) => f.t === 'watch') as Extract<SaasToWorker, { t: 'watch' }>;
  assert.equal(w2.payload, 'W2');
  assert.equal(w2.plain, true);
  await w.close();
});

test('sendToWorker returns false when offline, true and delivers when online', async () => {
  assert.equal(hub.sendToWorker('nobody', { t: 'projects.changed' }), false);
  const { workerId, w } = await worker(true);
  await w.next(isAuthz);
  assert.equal(hub.sendToWorker(workerId, { t: 'cards', cards: [] }), true);
  assert.deepEqual(await w.next((f) => f.t === 'cards'), { t: 'cards', cards: [] });
  await w.close();
});

test('setHandlers replaces the handlers', async () => {
  const hub2Calls: string[] = [];
  const h2 = new WorkerHub({ store, signingSeed: signing.seed, onPresence: () => {} });
  const wss2 = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((res) => wss2.once('listening', () => res()));
  wss2.on('connection', (ws) => h2.attach('w-set', ws));
  await store.workers.register('w-set', 'pub-set', 'hash-set');
  const ws = new WebSocket(`ws://127.0.0.1:${(wss2.address() as AddressInfo).port}/`);
  await new Promise<void>((res) => ws.once('open', () => res()));
  h2.setHandlers({ ...handlers, onHello: async (id) => { hub2Calls.push(id); } });
  ws.send(JSON.stringify({ t: 'hello', version: '1', label: '' }));
  await until(() => hub2Calls.length === 1);
  assert.deepEqual(hub2Calls, ['w-set']);
  ws.close();
  h2.close();
  await new Promise<void>((res) => wss2.close(() => res()));
});
