// E2E gateway: decrypt → authorize clientPub → anti-replay → dispatch to op/watch handlers → encrypt.
// Plaintext mode : `plain` frames skip seal/open only — authorization + replay unchanged.
// Pure (no pi, no network) so it is unit-testable.
import {
  b64url, decodeFrame, deriveKey, encodeFrame, fromB64url, open, seal, verifyAuthz,
} from '@nopear/core/crypto';
import {
  isBinaryOp, PLAINTEXT_DISABLED_MESSAGE, SAAS_CLIENT_PUB, type BinaryResult, type ClientAuthz, type ErrorCode, type RpcArgs, type RpcOp, type RpcResult,
  type WatchArgs, type WatchEvent, type WatchOp,
} from '@nopear/protocol';
import { OpError } from './errors';
import type { Identity } from './identity';
import { ReplayGuard } from './replay';

export interface OpContext { clientPub: string }
export type OpHandlers = { [O in RpcOp]: (args: RpcArgs<O>, ctx: OpContext) => Promise<RpcResult<O>> };
export type WatchHandlers = {
  [W in WatchOp]: (args: WatchArgs<W>, emit: (e: WatchEvent<W>) => void, signal: AbortSignal, ctx: OpContext) => Promise<void>;
};
export type PlainError = { status: 400 | 401; code: 'bad_request' | 'unauthorized'; message: string };

const unauthorized = (message: string): PlainError => ({ status: 401, code: 'unauthorized', message });
const badRequest = (message: string): PlainError => ({ status: 400, code: 'bad_request', message });
const WATCH_OPS = new Set<string>(['session.watch', 'machine.watch']);

export class Gateway {
  private readonly identity: Identity;
  private readonly ops: OpHandlers;
  private readonly watches: WatchHandlers;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly replay = new ReplayGuard();
  /** `required` (NOPEAR_E2E) rejects every plaintext frame and the `saas` internal client. */
  private readonly e2eMode: 'auto' | 'required';
  /** Plaintext frames accepted only when claimed, authz.e2e === false and e2eMode !== 'required'. */
  private plainAllowed = false;
  private authorized = new Set<string>();
  private keys = new Map<string, Uint8Array>();
  /** Open watches, so a revoked/unclaimed client's streams (watch.end unauthorized) and plaintext streams after
   *  e2e is switched on (watch.end plaintext_disabled) can be torn down. */
  private active = new Set<{ clientPub: string; plain: boolean; ac: AbortController; end: (code?: string) => void }>();

  constructor(opts: {
    identity: Identity; ops: OpHandlers; watches: WatchHandlers; now?: () => number; log?: (msg: string) => void;
    e2eMode?: 'auto' | 'required';
  }) {
    this.identity = opts.identity;
    this.ops = opts.ops;
    this.watches = opts.watches;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.warn(m));
    this.e2eMode = opts.e2eMode ?? 'auto';
  }

  setAuthz(frame: { claimed: boolean; userId?: string; clients: ClientAuthz[]; e2e?: boolean }): void {
    // Unclaimed: no account switch applies (the unclaimed authz carries e2e:false) — no plaintext, no saas client.
    this.plainAllowed = this.e2eMode !== 'required' && frame.claimed && frame.e2e === false;
    const next = new Set<string>();
    const pp = this.identity.platformPub;
    let invalid = 0;
    if (frame.claimed && frame.userId && pp) {
      for (const c of frame.clients) {
        let ok = false;
        try { ok = verifyAuthz(pp, frame.userId, c.clientPub, c.sig); } catch { /* invalid entry */ }
        if (ok) next.add(c.clientPub); else invalid++;
      }
    }
    // Count only — never log keys. Persistent invalid entries usually mean the pinned platform key belongs
    // to another SaaS (see identity.json saasUrl).
    if (invalid > 0) this.log(`[gateway] ignored ${invalid} client authorization(s) with an invalid platform signature`);
    this.authorized = next;
    for (const k of this.keys.keys()) if (!next.has(k)) this.keys.delete(k);
    for (const w of [...this.active]) {
      // Revoked/unclaimed client → unauthorized (client re-registers its key); the `saas` client is never in `next`
      // and is always plain. Plaintext switched off → plaintext_disabled.
      let code: string | undefined;
      if (w.clientPub !== SAAS_CLIENT_PUB && !next.has(w.clientPub)) code = 'unauthorized';
      else if (w.plain && !this.plainAllowed) code = 'plaintext_disabled';
      if (!code) continue;
      this.active.delete(w);
      w.ac.abort();
      w.end(code);
    }
  }

  isAuthorized(clientPub: string): boolean { return this.authorized.has(clientPub); }

  private key(clientPub: string): Uint8Array {
    let k = this.keys.get(clientPub);
    if (!k) { k = deriveKey(this.identity.priv, clientPub, this.identity.workerId, clientPub); this.keys.set(clientPub, k); }
    return k;
  }

  /** Decrypt (or, for `plain`, just decode) + validate a request. Returns header or a plaintext error.
   *  key = null → plaintext request; responses go back unsealed. */
  private openRequest(clientPub: string, payload: string, plain: boolean): { key: Uint8Array | null; op: string; args: unknown } | PlainError {
    let key: Uint8Array | null;
    let header: { v?: unknown; rid?: unknown; ts?: unknown; op?: unknown; args?: unknown };
    if (plain) {
      if (!this.plainAllowed) return badRequest(PLAINTEXT_DISABLED_MESSAGE);
      if (clientPub !== SAAS_CLIENT_PUB && !this.isAuthorized(clientPub)) return unauthorized('client not authorized');
      key = null;
      try {
        header = decodeFrame(fromB64url(payload)).header as typeof header;
      } catch { return unauthorized('cannot decode request'); }
    } else {
      // The SaaS internal client has no key pair: it is only ever valid for plaintext frames.
      if (clientPub === SAAS_CLIENT_PUB || !this.isAuthorized(clientPub)) return unauthorized('client not authorized');
      try {
        key = this.key(clientPub);
        header = decodeFrame(open(key, fromB64url(payload))).header as typeof header;
      } catch { return unauthorized('cannot decrypt request'); }
    }
    if (!header || header.v !== 3 || typeof header.rid !== 'string' || typeof header.ts !== 'number' || typeof header.op !== 'string') {
      return unauthorized('malformed request frame');
    }
    const r = this.replay.check(header.rid, header.ts, this.now());
    if (r === 'stale') return badRequest('request timestamp outside window');
    if (r === 'replay') return badRequest('replayed request id');
    return { key, op: header.op, args: header.args ?? {} };
  }

  /** Response encoder: sealed for E2E requests, raw frame bytes for plaintext ones. */
  private frameOut(key: Uint8Array | null, header: unknown, body?: Uint8Array): string {
    const frame = encodeFrame(header, body);
    return b64url(key ? seal(key, frame) : frame);
  }

  async handleRpc(clientPub: string, payload: string, plain = false): Promise<{ payload: string } | PlainError> {
    const req = this.openRequest(clientPub, payload, plain);
    if ('status' in req) return req;
    const { key, op, args } = req;
    const handler = Object.prototype.hasOwnProperty.call(this.ops, op)
      ? (this.ops as unknown as Record<string, (a: unknown, c: OpContext) => Promise<unknown>>)[op]
      : undefined;
    if (!handler) return { payload: this.frameOut(key, { ok: false, error: { code: 'bad_request', message: `unknown op: ${op}` } }) };
    try {
      const result = await handler(args, { clientPub });
      if (isBinaryOp(op)) {
        const b = result as BinaryResult;
        const h: { ok: true; mediaType: string; name?: string } = { ok: true, mediaType: b.mediaType };
        if (b.name !== undefined) h.name = b.name;
        return { payload: this.frameOut(key, h, b.bytes) };
      }
      return { payload: this.frameOut(key, { ok: true, result }) };
    } catch (e) {
      const code: ErrorCode = e instanceof OpError ? e.code : 'internal';
      const message = e instanceof Error ? e.message : String(e);
      return { payload: this.frameOut(key, { ok: false, error: { code, message } }) };
    }
  }

  handleWatch(
    clientPub: string, payload: string, send: (payload: string) => void, end: (code?: string) => void, plain = false,
  ): { cancel(): void } | PlainError {
    const req = this.openRequest(clientPub, payload, plain);
    if ('status' in req) return req;
    const { key, op, args } = req;
    const ac = new AbortController();
    if (!WATCH_OPS.has(op)) {
      queueMicrotask(() => end('bad_request'));
      return { cancel: () => ac.abort() };
    }
    const handler = (this.watches as unknown as Record<string, (a: unknown, emit: (e: unknown) => void, s: AbortSignal, c: OpContext) => Promise<void>>)[op]!;
    const entry = { clientPub, plain: key === null, ac, end };
    this.active.add(entry);
    const emit = (e: unknown) => { if (!ac.signal.aborted) send(this.frameOut(key, e)); };
    void handler(args, emit, ac.signal, { clientPub }).then(
      () => { this.active.delete(entry); if (!ac.signal.aborted) end(); },
      (e) => { this.active.delete(entry); if (!ac.signal.aborted) end(e instanceof OpError ? e.code : 'internal'); },
    );
    return { cancel: () => { this.active.delete(entry); ac.abort(); } };
  }
}
