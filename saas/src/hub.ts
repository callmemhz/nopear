import type { WebSocket } from 'ws';
import { b64url, decodeFrame, encodeFrame, fromB64url, randomId, signAuthz } from '@nopear/core/crypto';
import {
  CLAIM_TOKEN_TTL_MS, DEFAULT_AUTO_COMPACT, PLAINTEXT_DISABLED_MESSAGE, RPC_TIMEOUT_MS, SAAS_CLIENT_PUB, TUNNEL_DEAD_MS, TUNNEL_PING_MS,
  type ClientAuthz, type ResponseHeader, type RpcOp, type SaasToWorker, type ToolErrorCode, type ToolOutcome,
  type WorkerToSaas,
  type AutoCompactSettings,
} from '@nopear/protocol';
import type { SaasStore } from './store';

type RpcOutcome = { payload: string } | { status: number; code: string; message: string };
interface WatchSink { data(p: string): void; end(code?: string): void; offline(): void }
interface Conn {
  socket: WebSocket;
  lastFrameAt: number;
  rpcs: Map<string, { resolve(o: RpcOutcome): void; timer: ReturnType<typeof setTimeout> }>;
  watches: Map<string, WatchSink>;
  /** hello / index / card.state are applied in arrival order (a full index must land before later deltas). */
  chain: Promise<void>;
}

/** Collaboration handlers for the worker → SaaS frames the hub does not handle itself (wired to the Collab service). */
export interface WorkerFrameHandlers {
  onHello(workerId: string): Promise<void>;
  onIndex(workerId: string, f: Extract<WorkerToSaas, { t: 'index' }>): Promise<void>;
  onCardState(workerId: string, f: Extract<WorkerToSaas, { t: 'card.state' }>): Promise<void>;
  onTool(workerId: string, f: Extract<WorkerToSaas, { t: 'tool' }>): Promise<ToolOutcome>;
}

const TOOL_ERROR_CODES: readonly ToolErrorCode[] = [
  'bad_request', 'forbidden', 'not_found', 'too_large', 'e2e_enabled', 'machine_offline', 'saas_unreachable', 'timeout', 'internal',
];
const fail = (code: ToolErrorCode, message: string): ToolOutcome => ({ ok: false, error: { code, message } });

/**
 * Plaintext data-plane frames (`x-nopear-plain`, SaaS-internal session tools) were introduced in worker v3.1; a v3.0
 * worker cannot read them (it would 401 and the client would re-register forever). Compares the hello `version`
 * major.minor numerically; an empty / unparsable version counts as old.
 */
export function workerAcceptsPlaintext(version: string): boolean {
  const m = /^(\d+)\.(\d+)(?:\D|$)/.exec(version);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 3 || (major === 3 && minor >= 1);
}

/** Tunnel hub: workerId → live WS connection; relays opaque ciphertext both ways. */
export class WorkerHub {
  private conns = new Map<string, Conn>();
  private timer: ReturnType<typeof setInterval>;
  private store: SaasStore;
  private signingSeed: Uint8Array;
  private onPresence: (workerId: string) => void;
  private handlers: WorkerFrameHandlers | undefined;

  constructor(opts: {
    store: SaasStore; signingSeed: Uint8Array; onPresence(workerId: string): void; handlers?: WorkerFrameHandlers;
  }) {
    this.store = opts.store;
    this.signingSeed = opts.signingSeed;
    this.onPresence = opts.onPresence;
    this.handlers = opts.handlers;
    this.timer = setInterval(() => this.heartbeat(), TUNNEL_PING_MS);
    this.timer.unref?.();
  }

  setHandlers(h: WorkerFrameHandlers): void {
    this.handlers = h;
  }

  /** Sign an authz record (used when a client is registered). */
  signClient(userId: string, clientPub: string): string {
    return signAuthz(this.signingSeed, userId, clientPub);
  }

  isOnline(workerId: string): boolean {
    return this.conns.has(workerId);
  }

  attach(workerId: string, socket: WebSocket): void {
    const prev = this.conns.get(workerId);
    if (prev) this.drop(workerId, prev, true);
    const conn: Conn = { socket, lastFrameAt: Date.now(), rpcs: new Map(), watches: new Map(), chain: Promise.resolve() };
    this.conns.set(workerId, conn);
    void this.store.workers.update(workerId, { lastSeenAt: new Date().toISOString() });
    socket.on('message', (data) => {
      conn.lastFrameAt = Date.now();
      let f: WorkerToSaas;
      try { f = JSON.parse(String(data)) as WorkerToSaas; } catch { return; }
      this.onFrame(workerId, conn, f).catch(() => { /* handler errors must not kill the tunnel */ });
    });
    socket.on('close', () => {
      if (this.conns.get(workerId) === conn) this.drop(workerId, conn, false);
    });
    socket.on('error', () => { /* close follows */ });
    this.onPresence(workerId);
    // authz is pushed once when the connection is established and afterwards only on
    // changes (claim/unclaim/client add/delete) — never in reply to hello (the worker re-mints its
    // claim token on authz{claimed:false}, so replying to hello would loop forever).
    void this.pushAuthz(workerId);
  }

  private send(conn: Conn, f: SaasToWorker): boolean {
    try { conn.socket.send(JSON.stringify(f)); return true; } catch { return false; /* socket gone */ }
  }

  /** Send a frame to a live worker; false when it is offline. */
  sendToWorker(workerId: string, f: SaasToWorker): boolean {
    const conn = this.conns.get(workerId);
    return conn ? this.send(conn, f) : false;
  }

  /** Queue in-order work for a connection; errors are swallowed so the chain keeps going. */
  private serial(conn: Conn, fn: () => Promise<void>): Promise<void> {
    conn.chain = conn.chain.then(fn).catch(() => { /* swallowed: one bad frame must not stall the rest */ });
    return conn.chain;
  }

  private async onHello(workerId: string, f: Extract<WorkerToSaas, { t: 'hello' }>): Promise<void> {
    await this.store.workers.update(workerId, {
      version: String(f.version ?? ''), lastSeenAt: new Date().toISOString(),
    });
    const w = await this.store.workers.get(workerId);
    if (w && !w.label && f.label) await this.store.workers.update(workerId, { label: String(f.label) });
    if (f.claimTokenHash && w && !w.userId) {
      await this.store.workers.setClaimTokenHash(workerId, f.claimTokenHash, Date.now() + CLAIM_TOKEN_TTL_MS);
    }
    this.onPresence(workerId);
    // Never authz here (see attach): the collab service only pushes the worker's `cards` set.
    await this.handlers?.onHello(workerId);
  }

  private async onFrame(workerId: string, conn: Conn, f: WorkerToSaas): Promise<void> {
    switch (f.t) {
      case 'hello':
        return this.serial(conn, () => this.onHello(workerId, f));
      case 'index':
        return this.serial(conn, async () => { await this.handlers?.onIndex(workerId, f); });
      case 'card.state':
        return this.serial(conn, async () => { await this.handlers?.onCardState(workerId, f); });
      case 'tool': {
        let out: ToolOutcome;
        try {
          out = this.handlers ? await this.handlers.onTool(workerId, f) : fail('internal', 'collaboration service unavailable');
        } catch (e) {
          out = fail('internal', e instanceof Error ? e.message : String(e));
        }
        this.send(conn, out.ok ? { t: 'tool.res', id: f.id, result: out.result } : { t: 'tool.res', id: f.id, error: out.error });
        return;
      }
      case 'rpc.res': {
        const p = conn.rpcs.get(f.id);
        if (!p) return;
        conn.rpcs.delete(f.id); clearTimeout(p.timer);
        p.resolve({ payload: f.payload });
        return;
      }
      case 'rpc.err': {
        const p = conn.rpcs.get(f.id);
        if (!p) return;
        conn.rpcs.delete(f.id); clearTimeout(p.timer);
        p.resolve({ status: f.status, code: f.code, message: f.message });
        return;
      }
      case 'watch.data':
        conn.watches.get(f.id)?.data(f.payload);
        return;
      case 'watch.end': {
        const s = conn.watches.get(f.id);
        if (!s) return;
        conn.watches.delete(f.id);
        s.end(f.code);
        return;
      }
      case 'ping':
        this.send(conn, { t: 'pong' });
        return;
      default:
        return;
    }
  }

  /**
   * Relay one RPC. If `signal` aborts (the client went away) the pending entry is dropped and a
   * late rpc.res/rpc.err for this id is ignored. `plain` marks a plaintext frame (E2E off).
   */
  rpc(
    workerId: string, clientPub: string, payload: string, timeoutMs: number, signal?: AbortSignal, plain = false,
  ): Promise<RpcOutcome> {
    const conn = this.conns.get(workerId);
    if (!conn) return Promise.resolve({ status: 503, code: 'offline', message: 'machine offline' });
    const id = randomId(12);
    return new Promise((resolve) => {
      const drop = () => {
        const p = conn.rpcs.get(id);
        if (!p) return;
        conn.rpcs.delete(id); clearTimeout(p.timer);
        resolve({ status: 499, code: 'cancelled', message: 'client disconnected' });
      };
      const timer = setTimeout(() => {
        conn.rpcs.delete(id);
        signal?.removeEventListener('abort', drop);
        resolve({ status: 504, code: 'timeout', message: 'worker did not respond in time' });
      }, timeoutMs);
      conn.rpcs.set(id, {
        resolve: (o) => { signal?.removeEventListener('abort', drop); resolve(o); },
        timer,
      });
      if (signal?.aborted) { drop(); return; }
      signal?.addEventListener('abort', drop, { once: true });
      this.send(conn, plain ? { t: 'rpc', id, clientPub, payload, plain: true } : { t: 'rpc', id, clientPub, payload });
    });
  }

  /**
   * SaaS-internal plaintext RPC (session-class tools) as client `SAAS_CLIENT_PUB`. Only works while the
   * worker accepts plaintext; a worker that refuses it (NOPEAR_E2E=required / e2e on) → `e2e_enabled`;
   * a 401 (worker could not decode our frame) → `internal`.
   */
  async plainRpc(workerId: string, op: RpcOp, args: unknown, timeoutMs: number = RPC_TIMEOUT_MS): Promise<ToolOutcome> {
    if (!this.conns.has(workerId)) return fail('machine_offline', 'machine offline');
    const payload = b64url(encodeFrame({ v: 3, rid: randomId(16), ts: Date.now(), op, args }));
    const out = await this.rpc(workerId, SAAS_CLIENT_PUB, payload, timeoutMs, undefined, true);
    if ('payload' in out) {
      let header: ResponseHeader;
      try { header = decodeFrame(fromB64url(out.payload)).header as ResponseHeader; } catch {
        return fail('internal', 'cannot decode worker response');
      }
      if (header && header.ok === true) return { ok: true, result: header.result };
      if (header && header.ok === false && header.error) {
        const c = header.error.code as string;
        const code: ToolErrorCode = (TOOL_ERROR_CODES as readonly string[]).includes(c) ? c as ToolErrorCode
          : c === 'unauthorized' ? 'forbidden' : c === 'conflict' ? 'bad_request' : 'internal';
        return fail(code, String(header.error.message ?? c));
      }
      return fail('internal', 'malformed worker response');
    }
    if (out.status === 503) return fail('machine_offline', out.message);
    if (out.status === 504) return fail('timeout', out.message);
    // The worker refuses plaintext (NOPEAR_E2E=required, or e2e switched on): spec L158 `rpc.err 400 bad_request`.
    if (out.status === 400 && out.message === PLAINTEXT_DISABLED_MESSAGE) return fail('e2e_enabled', out.message);
    // In plain mode the worker only 401s the saas client on decode/malformed-frame failures — a SaaS bug.
    if (out.status === 401) return fail('internal', `worker rejected internal request: ${out.message}`);
    if (out.status === 400) return fail('bad_request', out.message);
    return fail('internal', out.message);
  }

  /** In-flight relayed RPCs for a worker (observability / tests). */
  pendingRpcCount(workerId: string): number {
    return this.conns.get(workerId)?.rpcs.size ?? 0;
  }

  watch(workerId: string, clientPub: string, payload: string, sink: WatchSink, plain = false): () => void {
    const conn = this.conns.get(workerId);
    if (!conn) { sink.offline(); return () => {}; }
    const id = randomId(12);
    conn.watches.set(id, sink);
    this.send(conn, plain ? { t: 'watch', id, clientPub, payload, plain: true } : { t: 'watch', id, clientPub, payload });
    return () => {
      if (conn.watches.delete(id)) this.send(conn, { t: 'watch.cancel', id });
    };
  }

  async pushAuthz(workerId: string): Promise<void> {
    const conn = this.conns.get(workerId);
    if (!conn) return;
    const w = await this.store.workers.get(workerId);
    if (!w) return;
    let clients: ClientAuthz[] = [];
    let e2e = false;
    let autoCompact: AutoCompactSettings = DEFAULT_AUTO_COMPACT;
    if (w.userId) {
      clients = (await this.store.clients.list(w.userId)).map((c) => ({ clientPub: c.clientPub, label: c.label, sig: c.sig }));
      const st = await this.store.settings.get(w.userId);
      e2e = st.e2e;
      autoCompact = st.autoCompact;
    }
    this.send(conn, w.userId
      ? { t: 'authz', claimed: true, userId: w.userId, clients, e2e, autoCompact }
      : { t: 'authz', claimed: false, clients: [], e2e: false });
  }

  /** Disconnect a worker's tunnel (e.g. close on shutdown). */
  close(): void {
    clearInterval(this.timer);
    for (const [id, c] of this.conns) { this.drop(id, c, true); }
  }

  private drop(workerId: string, conn: Conn, closeSocket: boolean): void {
    this.conns.delete(workerId);
    for (const [, p] of conn.rpcs) { clearTimeout(p.timer); p.resolve({ status: 503, code: 'offline', message: 'machine went offline' }); }
    conn.rpcs.clear();
    for (const [, s] of conn.watches) s.offline();
    conn.watches.clear();
    if (closeSocket) { try { conn.socket.terminate(); } catch { /* ignore */ } }
    void this.store.workers.update(workerId, { lastSeenAt: new Date().toISOString() });
    this.onPresence(workerId);
  }

  private heartbeat(): void {
    const now = Date.now();
    for (const [id, c] of this.conns) {
      if (now - c.lastFrameAt > TUNNEL_DEAD_MS) { this.drop(id, c, true); continue; }
      this.send(c, { t: 'ping' });
    }
  }
}
