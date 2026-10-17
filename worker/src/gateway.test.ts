import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  b64url, fromB64url, deriveKey, seal, open, encodeFrame, decodeFrame, generateClientKey,
  generateSigningKey, signAuthz, randomId, utf8,
} from '@nopear/core/crypto';
import type { ResponseHeader } from '@nopear/protocol';
import { Gateway, type OpHandlers, type WatchHandlers } from './gateway';
import { OpError } from './errors';
import type { Identity } from './identity';

function setup(now = () => Date.now()) {
  const wk = generateClientKey();
  const platform = generateSigningKey();
  const identity: Identity = { workerId: 'w_aaaaaaaaaaaaaaaa', priv: wk.priv, pub: wk.pub, secret: 's', platformPub: platform.pub };
  const client = generateClientKey();
  const other = generateClientKey();
  let watchSignal: AbortSignal | undefined;
  const ops = {
    'sessions.get': async (args: { sessionId: string }) => {
      if (args.sessionId === 'busy') throw new OpError('conflict', 'busy');
      if (args.sessionId === 'boom') throw new Error('kaboom');
      return { session: { id: args.sessionId } };
    },
    'blobs.get': async () => ({ bytes: new Uint8Array([9, 8, 7]), mediaType: 'image/png', name: 'x.png' }),
  } as unknown as OpHandlers;
  const watches = {
    'machine.watch': async (_a: unknown, emit: (e: unknown) => void, signal: AbortSignal) => {
      watchSignal = signal;
      for (let i = 0; i < 3; i++) emit({ type: 'session.removed', sessionId: `s${i}` });
      await new Promise<void>((r) => signal.addEventListener('abort', () => r()));
    },
  } as unknown as WatchHandlers;
  const gw = new Gateway({ identity, ops, watches, now });
  gw.setAuthz({
    claimed: true, userId: 'u1',
    clients: [
      { clientPub: client.pub, label: 'c', sig: signAuthz(platform.seed, 'u1', client.pub) },
      { clientPub: other.pub, label: 'bad', sig: signAuthz(platform.seed, 'u2', other.pub) },
    ],
  });
  const key = deriveKey(client.priv, wk.pub, identity.workerId, client.pub);
  const req = (op: string, args: unknown, over: Record<string, unknown> = {}) =>
    b64url(seal(key, encodeFrame({ v: 3, rid: randomId(), ts: now(), op, args, ...over })));
  const res = (payload: string) => {
    const f = decodeFrame(open(key, fromB64url(payload)));
    return { header: f.header as ResponseHeader, body: f.body };
  };
  return { gw, client, other, req, res, getSignal: () => watchSignal, key };
}

test('authorized JSON op round-trips', async () => {
  const { gw, client, req, res } = setup();
  const r = await gw.handleRpc(client.pub, req('sessions.get', { sessionId: 's1' }));
  assert.ok('payload' in r);
  assert.deepEqual(res(r.payload).header, { ok: true, result: { session: { id: 's1' } } });
});

test('unauthorized, invalid-sig and tampered → 401', async () => {
  const { gw, client, other, req } = setup();
  assert.equal(gw.isAuthorized(client.pub), true);
  assert.equal(gw.isAuthorized(other.pub), false);
  const r1 = await gw.handleRpc(other.pub, req('sessions.get', { sessionId: 's' }));
  assert.ok('status' in r1 && r1.status === 401 && r1.code === 'unauthorized');
  const raw = fromB64url(req('sessions.get', { sessionId: 's' }));
  raw[raw.length - 1]! ^= 1;
  const r2 = await gw.handleRpc(client.pub, b64url(raw));
  assert.ok('status' in r2 && r2.status === 401);
});

test('replayed rid and stale ts → 400', async () => {
  const { gw, client, req } = setup();
  const p = req('sessions.get', { sessionId: 's' }, { rid: 'fixed-rid' });
  assert.ok('payload' in (await gw.handleRpc(client.pub, p)));
  const r = await gw.handleRpc(client.pub, req('sessions.get', { sessionId: 's' }, { rid: 'fixed-rid' }));
  assert.ok('status' in r && r.status === 400 && r.code === 'bad_request');
  const s = await gw.handleRpc(client.pub, req('sessions.get', { sessionId: 's' }, { ts: Date.now() - 6 * 60_000 }));
  assert.ok('status' in s && s.status === 400);
});

test('OpError → encrypted error; other errors → internal; unknown op → bad_request', async () => {
  const { gw, client, req, res } = setup();
  const r = await gw.handleRpc(client.pub, req('sessions.get', { sessionId: 'busy' }));
  assert.ok('payload' in r);
  const h = res(r.payload).header;
  assert.ok(!h.ok && h.error.code === 'conflict');
  const r2 = await gw.handleRpc(client.pub, req('sessions.get', { sessionId: 'boom' }));
  assert.ok('payload' in r2);
  const h2 = res(r2.payload).header;
  assert.ok(!h2.ok && h2.error.code === 'internal');
  const r3 = await gw.handleRpc(client.pub, req('nope.op', {}));
  assert.ok('payload' in r3);
  const h3 = res(r3.payload).header;
  assert.ok(!h3.ok && h3.error.code === 'bad_request');
});

test('binary op puts bytes in body', async () => {
  const { gw, client, req, res } = setup();
  const r = await gw.handleRpc(client.pub, req('blobs.get', { hash: 'h' }));
  assert.ok('payload' in r);
  const { header, body } = res(r.payload);
  assert.deepEqual(header, { ok: true, mediaType: 'image/png', name: 'x.png' });
  assert.deepEqual([...body], [9, 8, 7]);
});

test('watch: 3 events decryptable; cancel aborts signal', async () => {
  const { gw, client, req, key, getSignal } = setup();
  const got: unknown[] = [];
  let ended = false;
  const h = gw.handleWatch(client.pub, req('machine.watch', {}), (p) => {
    got.push(decodeFrame(open(key, fromB64url(p))).header);
  }, () => { ended = true; });
  assert.ok('cancel' in h);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(got.length, 3);
  assert.deepEqual(got[0], { type: 'session.removed', sessionId: 's0' });
  h.cancel();
  assert.equal(getSignal()!.aborted, true);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(ended, false); // cancelled watches do not send end
  const bad = gw.handleWatch('nobody', req('machine.watch', {}), () => {}, () => {});
  assert.ok('status' in bad && bad.status === 401);
  void utf8;
});

test('F5: revoking a client ends its open watches with unauthorized; others keep running', async () => {
  const { gw, client, req, getSignal } = setup();
  const ends: (string | undefined)[] = [];
  const h = gw.handleWatch(client.pub, req('machine.watch', {}), () => {}, (code) => { ends.push(code); });
  assert.ok('cancel' in h);
  await new Promise((r) => setTimeout(r, 10));
  // re-push authz without this client (revoked)
  gw.setAuthz({ claimed: true, userId: 'u1', clients: [] });
  assert.equal(getSignal()!.aborted, true, 'handler signal aborted');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(ends, ['unauthorized'], 'exactly one watch.end unauthorized');
  h.cancel(); // later cancel is a no-op
  assert.deepEqual(ends, ['unauthorized']);
});

test('F5: unclaim ends all watches; still-authorized client unaffected by unrelated revocation', async () => {
  const wk = generateClientKey();
  const platform = generateSigningKey();
  const identity: Identity = { workerId: 'w_bbbbbbbbbbbbbbbb', priv: wk.priv, pub: wk.pub, secret: 's', platformPub: platform.pub };
  const a = generateClientKey();
  const b = generateClientKey();
  const signals: AbortSignal[] = [];
  const watches = {
    'machine.watch': async (_x: unknown, _e: unknown, signal: AbortSignal) => {
      signals.push(signal);
      await new Promise<void>((r) => signal.addEventListener('abort', () => r()));
    },
  } as unknown as WatchHandlers;
  const gw = new Gateway({ identity, ops: {} as OpHandlers, watches });
  const authz = (pubs: string[]) => ({
    claimed: true, userId: 'u1',
    clients: pubs.map((p) => ({ clientPub: p, label: 'x', sig: signAuthz(platform.seed, 'u1', p) })),
  });
  gw.setAuthz(authz([a.pub, b.pub]));
  const mk = (c: { priv: Uint8Array; pub: string }) =>
    b64url(seal(deriveKey(c.priv, wk.pub, identity.workerId, c.pub), encodeFrame({ v: 3, rid: randomId(), ts: Date.now(), op: 'machine.watch', args: {} })));
  const endsA: (string | undefined)[] = [];
  const endsB: (string | undefined)[] = [];
  assert.ok('cancel' in gw.handleWatch(a.pub, mk(a), () => {}, (c) => endsA.push(c)));
  assert.ok('cancel' in gw.handleWatch(b.pub, mk(b), () => {}, (c) => endsB.push(c)));
  await new Promise((r) => setTimeout(r, 10));
  gw.setAuthz(authz([a.pub])); // revoke b only
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(endsA, []);
  assert.deepEqual(endsB, ['unauthorized']);
  gw.setAuthz({ claimed: false, clients: [] }); // unclaim
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(endsA, ['unauthorized']);
  assert.ok(signals.every((s) => s.aborted));
});

test('F4: setAuthz warns with a count (no keys) when entries fail signature verification', () => {
  const wk = generateClientKey();
  const platform = generateSigningKey();
  const identity: Identity = { workerId: 'w_aaaaaaaaaaaaaaaa', priv: wk.priv, pub: wk.pub, secret: 's', platformPub: platform.pub };
  const logs: string[] = [];
  const gw = new Gateway({ identity, ops: {} as OpHandlers, watches: {} as WatchHandlers, log: (m: string) => logs.push(m) });
  const good = generateClientKey();
  const bad1 = generateClientKey();
  const bad2 = generateClientKey();
  gw.setAuthz({ claimed: true, userId: 'u1', clients: [
    { clientPub: good.pub, label: 'g', sig: signAuthz(platform.seed, 'u1', good.pub) },
    { clientPub: bad1.pub, label: 'b', sig: signAuthz(platform.seed, 'u2', bad1.pub) },
    { clientPub: bad2.pub, label: 'b', sig: 'garbage' },
  ] });
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /2/);
  for (const k of [good.pub, bad1.pub, bad2.pub]) assert.ok(!logs[0]!.includes(k));
  assert.ok(gw.isAuthorized(good.pub));
  // all valid → no warning
  gw.setAuthz({ claimed: true, userId: 'u1', clients: [{ clientPub: good.pub, label: 'g', sig: signAuthz(platform.seed, 'u1', good.pub) }] });
  assert.equal(logs.length, 1);
});

// ---------- E2E plaintext mode ----------

function plainSetup(o: { e2e: boolean; e2eMode?: 'auto' | 'required' }) {
  const wk = generateClientKey();
  const platform = generateSigningKey();
  const identity: Identity = { workerId: 'w_cccccccccccccccc', priv: wk.priv, pub: wk.pub, secret: 's', platformPub: platform.pub };
  const client = generateClientKey();
  const stranger = generateClientKey();
  const ops = {
    'worker.info': async () => ({ workerId: identity.workerId }),
    'blobs.get': async () => ({ bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }),
  } as unknown as OpHandlers;
  const watches = {
    'machine.watch': async (_a: unknown, emit: (e: unknown) => void, signal: AbortSignal) => {
      emit({ type: 'snapshot', sessions: [] });
      await new Promise<void>((r) => signal.addEventListener('abort', () => r()));
    },
  } as unknown as WatchHandlers;
  const gw = new Gateway({ identity, ops, watches, ...(o.e2eMode ? { e2eMode: o.e2eMode } : {}) });
  gw.setAuthz({
    claimed: true, userId: 'u1', e2e: o.e2e,
    clients: [{ clientPub: client.pub, label: 'c', sig: signAuthz(platform.seed, 'u1', client.pub) }],
  });
  const key = deriveKey(client.priv, wk.pub, identity.workerId, client.pub);
  const plainReq = (op: string, args: unknown, over: Record<string, unknown> = {}) =>
    b64url(encodeFrame({ v: 3, rid: randomId(), ts: Date.now(), op, args, ...over }));
  const sealedReq = (op: string, args: unknown) =>
    b64url(seal(key, encodeFrame({ v: 3, rid: randomId(), ts: Date.now(), op, args })));
  const plainRes = (payload: string) => {
    const f = decodeFrame(fromB64url(payload));
    return { header: f.header as ResponseHeader, body: f.body };
  };
  const authz = (e2e: boolean) => ({
    claimed: true, userId: 'u1', e2e,
    clients: [{ clientPub: client.pub, label: 'c', sig: signAuthz(platform.seed, 'u1', client.pub) }],
  });
  return { gw, client, stranger, key, plainReq, sealedReq, plainRes, authz };
}

const PLAIN_DISABLED = { status: 400, code: 'bad_request', message: 'plaintext disabled on this worker' };

test('plain rpc accepted when authz.e2e=false', async () => {
  const { gw, client, plainReq, plainRes } = plainSetup({ e2e: false });
  const r = await gw.handleRpc(client.pub, plainReq('worker.info', {}), true);
  assert.ok('payload' in r);
  const { header } = plainRes(r.payload);
  assert.equal(header.ok, true);
  assert.deepEqual(header, { ok: true, result: { workerId: 'w_cccccccccccccccc' } });
  // binary ops also answer in plaintext
  const b = await gw.handleRpc(client.pub, plainReq('blobs.get', { hash: 'h' }), true);
  assert.ok('payload' in b);
  const bf = plainRes(b.payload);
  assert.deepEqual(bf.header, { ok: true, mediaType: 'image/png' });
  assert.deepEqual([...bf.body], [1, 2, 3]);
});

test('plain rejected when authz.e2e=true', async () => {
  const { gw, client, plainReq } = plainSetup({ e2e: true });
  assert.deepEqual(await gw.handleRpc(client.pub, plainReq('worker.info', {}), true), PLAIN_DISABLED);
});

test('plain rejected when e2eMode=required', async () => {
  const { gw, client, plainReq } = plainSetup({ e2e: false, e2eMode: 'required' });
  assert.deepEqual(await gw.handleRpc(client.pub, plainReq('worker.info', {}), true), PLAIN_DISABLED);
  const w = gw.handleWatch(client.pub, plainReq('machine.watch', {}), () => {}, () => {}, true);
  assert.deepEqual(w, PLAIN_DISABLED);
});

test('plain rejected before any authz frame (default not allowed)', async () => {
  const wk = generateClientKey();
  const identity: Identity = { workerId: 'w_dddddddddddddddd', priv: wk.priv, pub: wk.pub, secret: 's', platformPub: generateSigningKey().pub };
  const gw = new Gateway({ identity, ops: {} as OpHandlers, watches: {} as WatchHandlers });
  const p = b64url(encodeFrame({ v: 3, rid: randomId(), ts: Date.now(), op: 'worker.info', args: {} }));
  assert.deepEqual(await gw.handleRpc('saas', p, true), PLAIN_DISABLED);
  // authz without e2e field is not treated as plaintext-allowed
  gw.setAuthz({ claimed: false, clients: [] });
  assert.deepEqual(await gw.handleRpc('saas', p, true), PLAIN_DISABLED);
});

test('saas client accepted only in plain mode', async () => {
  const { gw, plainReq, sealedReq, plainRes } = plainSetup({ e2e: false });
  const ok = await gw.handleRpc('saas', plainReq('worker.info', {}), true);
  assert.ok('payload' in ok);
  assert.equal(plainRes(ok.payload).header.ok, true);
  const sealed = await gw.handleRpc('saas', sealedReq('worker.info', {}), false);
  assert.ok('status' in sealed && sealed.status === 401 && sealed.code === 'unauthorized');
  const req = plainSetup({ e2e: false, e2eMode: 'required' });
  assert.deepEqual(await req.gw.handleRpc('saas', req.plainReq('worker.info', {}), true), PLAIN_DISABLED);
  const on = plainSetup({ e2e: true });
  assert.deepEqual(await on.gw.handleRpc('saas', on.plainReq('worker.info', {}), true), PLAIN_DISABLED);
});

test('plain still enforces client authorization and replay', async () => {
  const { gw, client, stranger, plainReq } = plainSetup({ e2e: false });
  const u = await gw.handleRpc(stranger.pub, plainReq('worker.info', {}), true);
  assert.ok('status' in u && u.status === 401 && u.code === 'unauthorized');
  assert.ok('payload' in (await gw.handleRpc(client.pub, plainReq('worker.info', {}, { rid: 'same-rid' }), true)));
  assert.deepEqual(await gw.handleRpc(client.pub, plainReq('worker.info', {}, { rid: 'same-rid' }), true),
    { status: 400, code: 'bad_request', message: 'replayed request id' });
  const stale = await gw.handleRpc(client.pub, plainReq('worker.info', {}, { ts: Date.now() - 6 * 60_000 }), true);
  assert.ok('status' in stale && stale.status === 400);
  const garbage = await gw.handleRpc(client.pub, b64url(new Uint8Array([1, 2, 3])), true);
  assert.ok('status' in garbage && garbage.status === 401);
});

test('encrypted frames still accepted when e2e=false', async () => {
  const { gw, client, key, sealedReq } = plainSetup({ e2e: false });
  const r = await gw.handleRpc(client.pub, sealedReq('worker.info', {}));
  assert.ok('payload' in r);
  const h = decodeFrame(open(key, fromB64url(r.payload))).header as ResponseHeader;
  assert.deepEqual(h, { ok: true, result: { workerId: 'w_cccccccccccccccc' } });
});

test('plain watch emits plaintext frames', async () => {
  const { gw, client, plainReq } = plainSetup({ e2e: false });
  const got: unknown[] = [];
  const h = gw.handleWatch(client.pub, plainReq('machine.watch', {}), (p) => {
    got.push(decodeFrame(fromB64url(p)).header);
  }, () => {}, true);
  assert.ok('cancel' in h);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(got.length, 1);
  assert.equal((got[0] as { type: string }).type, 'snapshot');
  h.cancel();
});

test('F1: e2e flip to true ends open plain watches with plaintext_disabled; sealed watches unaffected', async () => {
  const { gw, client, plainReq, sealedReq, authz } = plainSetup({ e2e: false });
  const plainEnds: (string | undefined)[] = [];
  const saasEnds: (string | undefined)[] = [];
  const sealedEnds: (string | undefined)[] = [];
  assert.ok('cancel' in gw.handleWatch(client.pub, plainReq('machine.watch', {}), () => {}, (c) => plainEnds.push(c), true));
  assert.ok('cancel' in gw.handleWatch('saas', plainReq('machine.watch', {}), () => {}, (c) => saasEnds.push(c), true));
  assert.ok('cancel' in gw.handleWatch(client.pub, sealedReq('machine.watch', {}), () => {}, (c) => sealedEnds.push(c)));
  await new Promise((r) => setTimeout(r, 10));
  gw.setAuthz(authz(true));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(plainEnds, ['plaintext_disabled']);
  assert.deepEqual(saasEnds, ['plaintext_disabled']);
  assert.deepEqual(sealedEnds, []);
});

test('F1: saas plain watch survives an authz push while plaintext is allowed; revoked plain client → unauthorized', async () => {
  const { gw, client, plainReq, authz } = plainSetup({ e2e: false });
  const saasEnds: (string | undefined)[] = [];
  const clientEnds: (string | undefined)[] = [];
  assert.ok('cancel' in gw.handleWatch('saas', plainReq('machine.watch', {}), () => {}, (c) => saasEnds.push(c), true));
  assert.ok('cancel' in gw.handleWatch(client.pub, plainReq('machine.watch', {}), () => {}, (c) => clientEnds.push(c), true));
  await new Promise((r) => setTimeout(r, 10));
  gw.setAuthz(authz(false));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(saasEnds, []);
  assert.deepEqual(clientEnds, []);
  gw.setAuthz({ claimed: true, userId: 'u1', e2e: false, clients: [] }); // revoke client, plaintext still allowed
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(saasEnds, []);
  assert.deepEqual(clientEnds, ['unauthorized']);
});

test('unclaimed authz with e2e:false does not allow plaintext (nor the saas client)', async () => {
  const { gw, client, plainReq, plainRes } = plainSetup({ e2e: false });
  gw.setAuthz({ claimed: false, e2e: false, clients: [] });
  assert.deepEqual(await gw.handleRpc('saas', plainReq('worker.info', {}), true), PLAIN_DISABLED);
  assert.deepEqual(await gw.handleRpc(client.pub, plainReq('worker.info', {}), true), PLAIN_DISABLED);
  assert.deepEqual(gw.handleWatch('saas', plainReq('machine.watch', {}), () => {}, () => {}, true), PLAIN_DISABLED);
  // claimed again with e2e:false → plaintext allowed again
  gw.setAuthz({ claimed: true, userId: 'u1', e2e: false, clients: [] });
  const ok = await gw.handleRpc('saas', plainReq('worker.info', {}), true);
  assert.ok('payload' in ok);
  assert.equal(plainRes(ok.payload).header.ok, true);
});

test('unclaim ends an open saas plain watch', async () => {
  const { gw, plainReq } = plainSetup({ e2e: false });
  let ended: string | undefined | null = null;
  const h = gw.handleWatch('saas', plainReq('machine.watch', {}), () => {}, (c) => { ended = c; }, true);
  assert.ok('cancel' in h);
  gw.setAuthz({ claimed: false, e2e: false, clients: [] });
  assert.equal(ended, 'plaintext_disabled');
});
