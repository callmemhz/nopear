// Outbound WS tunnel to SaaS (/worker/connect): registration (TOFU platformPub), hello + claim token,
// authz, rpc/watch relay through the Gateway (sealed or plain), ping/pong liveness, reconnect with backoff.
// Also the worker's CollabLink: native tool calls, session index / card state reports, card and
// project-change pushes. One-time install code is sent on register and then removed from worker/.env.
import { join } from 'node:path';
import WebSocket from 'ws';
import {
  CLAIM_TOKEN_TTL_MS, HEADER_WORKER, RPC_TIMEOUT_MS, TUNNEL_DEAD_MS, TUNNEL_MAX_FRAME_BYTES, TUNNEL_PING_MS,
  type Card, type SaasErrorBody, type SaasToWorker, type SessionIndexEntry, type ToolName, type ToolOutcome, type WorkerRegisterRequest,
  type WorkerRegisterResponse, type WorkerToSaas,
} from '@nopear/protocol';
import { randomId, sha256Hex } from '@nopear/core/crypto';
import type { CollabLink } from './collab/link';
import type { WorkerConfig } from './config';
import { removeEnvKey } from './envfile';
import type { Gateway } from './gateway';
import { saveIdentity, type Identity } from './identity';

/** register got a permanent 4xx (bad bootstrap token, conflict, …): retrying can't help — fail fast. */
export class RegisterRejectedError extends Error {
  /** `detail` = the SaaS error.message (sanitized to one short line). */
  constructor(readonly status: number, detail?: string) {
    const d = detail?.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 300);
    super(`worker register rejected: HTTP ${status}${d ? `: ${d}` : ''}${REGISTER_HINTS[status] ? ` (${REGISTER_HINTS[status]})` : ''}`);
    this.name = 'RegisterRejectedError';
  }
}
const REGISTER_HINTS: Record<number, string> = {
  400: 'install code invalid, expired or already used — generate a new install command in the console',
  401: 'bootstrap token missing or not accepted — check NOPEAR_SAAS_BOOTSTRAP_TOKEN',
  403: 'bootstrap token not accepted — check NOPEAR_SAAS_BOOTSTRAP_TOKEN',
  409: 'machine may be claimed by another account — unbind it there first, or identity conflict '
    + '(this workerId is already registered on the SaaS with a different key/secret; restore the original NOPEAR_HOME identity or reset it)',
};
/** Re-register (after a handshake 401) returned a platform key different from the pinned one. Never re-pin
 *  silently: a MITM / rogue endpoint could otherwise install its own signing key and authorize its own client. */
export class PlatformKeyMismatchError extends Error {
  constructor(home: string) {
    super(`platform key mismatch — the SaaS returned a different platform signing key than the one pinned for this worker; `
      + `refusing to re-trust it. Delete ${join(home, 'identity.json')} to re-trust this SaaS`);
    this.name = 'PlatformKeyMismatchError';
  }
}
function listen<T>(set: Set<T>, fn: T): () => void {
  set.add(fn);
  return () => { set.delete(fn); };
}
/** Listener errors must not break frame handling. */
function safe(fn: () => void): void {
  try { fn(); } catch (e) { console.warn(`[tunnel] listener failed: ${(e as Error)?.message ?? e}`); }
}
/** 4xx that are worth retrying (timeout / rate limit); every other 4xx is permanent. */
const isPermanent4xx = (s: number) => s >= 400 && s < 500 && s !== 408 && s !== 429;

export interface TunnelOptions {
  config: WorkerConfig;
  identity: Identity;
  gateway: Gateway;
  onClaimLink(url: string): void;
  onState?(s: 'connecting' | 'online' | 'offline'): void;
  /** Test hook: base reconnect delay (default 1000ms, capped at 30s). */
  reconnectBaseMs?: number;
  /** Test hook: claim token TTL (default CLAIM_TOKEN_TTL_MS). */
  claimTtlMs?: number;
  /** register retry delays (ms); last value repeats. Default 1s→30s doubling. Tests shorten it. */
  registerBackoffMs?: number[];
  /** Diagnostic logger (default console.warn). Never receives secrets. */
  log?(msg: string): void;
  /** Unrecoverable condition after start() (e.g. re-register → 409 identity conflict). The tunnel has stopped. */
  onFatal?(err: Error): void;
  /** Test hook: how long callTool waits for tool.res (default RPC_TIMEOUT_MS). */
  toolTimeoutMs?: number;
  /** Every `authz` frame (claimed or not), after the gateway applied it — used to push account settings (auto-compact). */
  onAuthz?(frame: Extract<SaasToWorker, { t: 'authz' }>): void;
}

/** SaaS error body `{error:{message}}` (SaasErrorBody) → message; anything else → undefined. */
async function errorMessageOf(res: Response): Promise<string | undefined> {
  try {
    const j = JSON.parse(await res.text()) as Partial<SaasErrorBody>;
    return typeof j?.error?.message === 'string' ? j.error.message : undefined;
  } catch { return undefined; }
}

const unreachable = (message: string): ToolOutcome => ({ ok: false, error: { code: 'saas_unreachable', message } });

export class TunnelClient implements CollabLink {
  private ws: WebSocket | null = null;
  private stopped = false;
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private claimTimer: NodeJS.Timeout | null = null;
  private lastFrameAt = 0;
  private claimed = false;
  private watches = new Map<string, { cancel(): void }>();
  private registerWake: (() => void) | null = null;
  /** Handshake 401 while a platform key is pinned: re-register once before the next reconnect. */
  private reregisterPending = false;
  private reregisterTried = false;
  private pendingTools = new Map<string, { resolve(o: ToolOutcome): void; timer: NodeJS.Timeout }>();
  private cardsListeners = new Set<(cards: Card[]) => void>();
  private projectsListeners = new Set<() => void>();
  private connectedListeners = new Set<() => void>();
  private claimListeners = new Set<(s: { claimed: boolean; userId?: string }) => void>();
  /** Claim state of the last authz (null before the first one); onClaimChanged fires when it changes. */
  private lastClaim: { claimed: boolean; userId?: string } | null = null;

  constructor(private readonly opts: TunnelOptions) {}

  get workerId(): string { return this.opts.identity.workerId; }

  connected(): boolean { return this.ws?.readyState === WebSocket.OPEN; }

  callTool(name: ToolName, args: Record<string, unknown>, sessionId?: string): Promise<ToolOutcome> {
    if (!this.connected()) return Promise.resolve(unreachable('SaaS tunnel is not connected'));
    const id = randomId();
    const f: WorkerToSaas = { t: 'tool', id, name, args };
    if (sessionId !== undefined) f.sessionId = sessionId;
    return new Promise<ToolOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingTools.delete(id);
        resolve({ ok: false, error: { code: 'timeout', message: `tool ${name} timed out` } });
      }, this.opts.toolTimeoutMs ?? RPC_TIMEOUT_MS);
      this.pendingTools.set(id, { resolve, timer });
      this.send(f);
    });
  }

  sendIndex(f: { full: boolean; sessions: SessionIndexEntry[]; removed: string[] }): void {
    this.send({ t: 'index', full: f.full, sessions: f.sessions, removed: f.removed });
  }

  sendCardState(f: { cardId: string; state: 'running' | 'review'; sessionId?: string; error?: string }): void {
    this.send({ t: 'card.state', ...f });
  }

  onCards(fn: (cards: Card[]) => void): () => void { return listen(this.cardsListeners, fn); }
  onProjectsChanged(fn: () => void): () => void { return listen(this.projectsListeners, fn); }
  onConnected(fn: () => void): () => void { return listen(this.connectedListeners, fn); }
  onClaimChanged(fn: (s: { claimed: boolean; userId?: string }) => void): () => void { return listen(this.claimListeners, fn); }

  private settleTool(id: string, outcome: ToolOutcome): void {
    const p = this.pendingTools.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pendingTools.delete(id);
    p.resolve(outcome);
  }

  private failPendingTools(): void {
    for (const id of [...this.pendingTools.keys()]) this.settleTool(id, unreachable('SaaS tunnel closed'));
  }

  private log(msg: string): void { (this.opts.log ?? ((m: string) => console.warn(m)))(`[tunnel] ${msg}`); }

  async start(): Promise<void> {
    this.stopped = false;
    const { config, identity } = this.opts;
    // A code already redeemed by this identity (still in the shell/systemd env, or .env cleanup failed): skip it.
    if (config.installCode && identity.redeemedInstallCodeHash === sha256Hex(config.installCode)) {
      this.log('NOPEAR_INSTALL_CODE was already redeemed by this worker — ignoring it (remove it from the environment)');
      config.installCode = null;
    }
    // First boot (nothing pinned), or an install code to redeem (e.g. installer re-run after an unbind): register.
    // Idempotent for the same identity; never replaces an existing pin (a different key is fatal).
    const pinned = !!identity.platformPub;
    if (!pinned || config.installCode) {
      try {
        await this.registerWithRetry();
      } catch (err) {
        // Pinned worker (registered before): a bad install code must not stop a worker that otherwise runs fine.
        if (!(pinned && config.installCode && err instanceof RegisterRejectedError && err.status === 400)) throw err;
        this.log('install code invalid/expired/used — ignoring it; this worker keeps its existing registration');
        config.installCode = null;
      }
    }
    if (this.stopped) return;
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.registerWake?.();
    this.clearConnTimers();
    this.cancelWatches();
    this.failPendingTools();
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((r) => { ws.once('close', () => r()); ws.terminate(); });
    }
  }

  /** Keep trying to register until SaaS answers (unreachable/5xx/408/429 → backoff 1s→30s). A permanent 4xx (bad
   *  bootstrap token, 409 conflict, bad install code) throws RegisterRejectedError; a platform key differing from the
   *  pinned one throws PlatformKeyMismatchError. */
  private async registerWithRetry(): Promise<void> {
    const delays = this.opts.registerBackoffMs ?? [1000, 2000, 4000, 8000, 16000, 30000];
    for (let i = 0; !this.stopped; i++) {
      try {
        await this.register();
        return;
      } catch (err) {
        if (err instanceof RegisterRejectedError || err instanceof PlatformKeyMismatchError) { this.log(err.message); throw err; }
        const delay = delays[Math.min(i, delays.length - 1)]!;
        this.log(`register attempt ${i + 1} failed (${(err as Error)?.message ?? err}); retrying in ${delay}ms`);
        await new Promise<void>((r) => { this.registerWake = r; this.reconnectTimer = setTimeout(r, delay); });
        this.registerWake = null;
      }
    }
  }

  /** POST /worker/register. Only pins the returned platformPub when nothing is pinned yet (TOFU); an existing
   *  pin is never replaced — a different key throws PlatformKeyMismatchError. */
  private async register(): Promise<void> {
    const { config, identity } = this.opts;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (config.bootstrapToken) headers.authorization = `Bearer ${config.bootstrapToken}`;
    const body: WorkerRegisterRequest = { workerId: identity.workerId, workerPub: identity.pub, secretHash: sha256Hex(identity.secret) };
    if (config.installCode) body.installCode = config.installCode;
    const res = await fetch(`${config.saasUrl}/worker/register`, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) {
      if (isPermanent4xx(res.status)) throw new RegisterRejectedError(res.status, await errorMessageOf(res));
      res.body?.cancel().catch(() => {});
      this.log(`register failed: HTTP ${res.status}`);
      throw new Error(`worker register failed: HTTP ${res.status}`);
    }
    const j = (await res.json()) as WorkerRegisterResponse;
    if (!j.platformPub) throw new Error('worker register: missing platformPub');
    // Registered: the install code is single-use — drop it from worker/.env.
    if (config.installCode) {
      try { removeEnvKey(config.envFile, 'NOPEAR_INSTALL_CODE'); } catch (e) {
        this.log(`could not remove NOPEAR_INSTALL_CODE from ${config.envFile}: ${(e as Error)?.message ?? e}`);
      }
    }
    let changed = false;
    if (identity.platformPub) {
      if (j.platformPub !== identity.platformPub) throw new PlatformKeyMismatchError(config.home);
      // same key (e.g. SaaS DB reset with the same signing key) → keep the pin as-is
    } else {
      identity.platformPub = j.platformPub;
      identity.saasUrl = config.saasUrl;
      changed = true;
    }
    // Redeemed: never send it again (later re-registers, or restarts while it lingers in the environment).
    if (config.installCode) {
      identity.redeemedInstallCodeHash = sha256Hex(config.installCode);
      config.installCode = null;
      changed = true;
    }
    if (changed) saveIdentity(config.home, identity);
  }

  private send(f: WorkerToSaas): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(f));
  }

  private connect(): void {
    if (this.stopped) return;
    const { config, identity } = this.opts;
    this.opts.onState?.('connecting');
    const url = config.saasUrl.replace(/^http/, 'ws') + '/worker/connect';
    const ws = new WebSocket(url, {
      headers: { authorization: `Bearer ${identity.secret}`, [HEADER_WORKER]: identity.workerId },
      maxPayload: TUNNEL_MAX_FRAME_BYTES,
    });
    this.ws = ws;
    ws.on('open', () => {
      this.attempt = 0;
      this.reregisterTried = false;
      this.lastFrameAt = Date.now();
      this.opts.onState?.('online');
      this.sendHello(false);
      for (const fn of [...this.connectedListeners]) safe(() => fn());
      this.pingTimer = setInterval(() => {
        if (Date.now() - this.lastFrameAt > TUNNEL_DEAD_MS) { ws.terminate(); return; }
        this.send({ t: 'ping' });
      }, TUNNEL_PING_MS);
    });
    ws.on('message', (data) => {
      this.lastFrameAt = Date.now();
      let f: SaasToWorker;
      try { f = JSON.parse(String(data)) as SaasToWorker; } catch { return; }
      void this.onFrame(f);
    });
    ws.on('unexpected-response', (_req, res) => {
      // Handshake rejected (e.g. 401 bad worker secret / unknown worker). Log the status; close + backoff follow.
      this.log(`handshake rejected: HTTP ${res.statusCode ?? '?'}${res.statusCode === 401 ? ' (worker secret not accepted)' : ''}`);
      if (res.statusCode === 401 && this.opts.identity.platformPub) {
        this.log(`worker identity is not registered with this SaaS (${config.saasUrl}) — delete ${config.home}/identity.json `
          + 'or re-register this worker' + (this.reregisterTried ? '' : '; attempting one re-register now'));
        if (!this.reregisterTried) this.reregisterPending = true;
      }
      res.resume();
      ws.terminate();
    });
    ws.on('error', (err) => { this.log(`connection error: ${err.message}`); /* close follows */ });
    ws.on('close', (code: number, reason: Buffer) => {
      this.log(`closed code=${code} reason=${JSON.stringify(String(reason)).slice(0, 200)}`);
      if (this.ws === ws) this.ws = null;
      this.clearConnTimers();
      this.cancelWatches();
      this.failPendingTools();
      this.opts.onState?.('offline');
      if (this.reregisterPending) { this.reregisterPending = false; void this.reregister(); return; }
      this.scheduleReconnect();
    });
  }

  /** Records the claim state of an authz frame; fires onClaimChanged on an actual change (not on the first). */
  private noteClaim(claimed: boolean, userId: string | undefined): void {
    const prev = this.lastClaim;
    const next = userId !== undefined ? { claimed, userId } : { claimed };
    this.lastClaim = next;
    if (!prev || (prev.claimed === claimed && prev.userId === userId)) return;
    for (const fn of [...this.claimListeners]) safe(() => fn({ ...next }));
  }

  /** Send hello. withClaim (only after authz{claimed:false} or TTL expiry) mints a fresh one-time claim
   *  token, attaches its hash, emits the claim link and schedules TTL rotation. */
  private sendHello(withClaim: boolean): void {
    const { config, identity } = this.opts;
    if (this.claimTimer) { clearTimeout(this.claimTimer); this.claimTimer = null; }
    const hello: WorkerToSaas = { t: 'hello', version: config.version, label: config.label };
    if (withClaim && !this.claimed) {
      const token = randomId(24);
      hello.claimTokenHash = sha256Hex(token);
      this.opts.onClaimLink(`${config.saasUrl}/claim?w=${encodeURIComponent(identity.workerId)}&t=${encodeURIComponent(token)}`);
      this.claimTimer = setTimeout(() => this.sendHello(true), this.opts.claimTtlMs ?? CLAIM_TOKEN_TTL_MS);
    }
    this.send(hello);
  }

  private async onFrame(f: SaasToWorker): Promise<void> {
    const gw = this.opts.gateway;
    switch (f.t) {
      case 'ping': this.send({ t: 'pong' }); return;
      case 'pong': return;
      case 'authz': {
        gw.setAuthz(f);
        try { this.opts.onAuthz?.(f); } catch (err) { this.opts.log?.(`[tunnel] onAuthz failed: ${(err as Error)?.message ?? err}`); }
        this.claimed = f.claimed;
        // claimed → stop rotating claim tokens; unclaimed → mint a fresh token and re-hello.
        if (f.claimed) { if (this.claimTimer) { clearTimeout(this.claimTimer); this.claimTimer = null; } }
        else this.sendHello(true);
        this.noteClaim(f.claimed, f.claimed ? f.userId : undefined);
        return;
      }
      case 'rpc': {
        const plain = f.plain === true;
        const r = await gw.handleRpc(f.clientPub, f.payload, plain);
        if ('payload' in r) this.send(plain ? { t: 'rpc.res', id: f.id, payload: r.payload, plain: true } : { t: 'rpc.res', id: f.id, payload: r.payload });
        else this.send({ t: 'rpc.err', id: f.id, status: r.status, code: r.code, message: r.message });
        return;
      }
      case 'watch': {
        const id = f.id;
        const plain = f.plain === true;
        const h = gw.handleWatch(f.clientPub, f.payload,
          (payload) => this.send(plain ? { t: 'watch.data', id, payload, plain: true } : { t: 'watch.data', id, payload }),
          (code) => { this.watches.delete(id); this.send(code ? { t: 'watch.end', id, code } : { t: 'watch.end', id }); },
          plain);
        if ('cancel' in h) this.watches.set(id, h);
        else this.send({ t: 'watch.end', id, code: h.code });
        return;
      }
      case 'watch.cancel': {
        this.watches.get(f.id)?.cancel();
        this.watches.delete(f.id);
        return;
      }
      case 'tool.res':
        this.settleTool(f.id, f.error ? { ok: false, error: f.error } : { ok: true, result: f.result });
        return;
      case 'cards':
        for (const fn of [...this.cardsListeners]) safe(() => fn(f.cards));
        return;
      case 'projects.changed':
        for (const fn of [...this.projectsListeners]) safe(() => fn());
        return;
    }
  }

  private cancelWatches(): void {
    for (const w of this.watches.values()) w.cancel();
    this.watches.clear();
  }

  private clearConnTimers(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.claimTimer) { clearTimeout(this.claimTimer); this.claimTimer = null; }
  }

  /** One re-register attempt after a handshake 401 (register is idempotent for the same pub + secret hash).
   *  The pinned platformPub is kept: a different returned key → fatal (PlatformKeyMismatchError).
   *  409 = the SaaS knows this workerId with a different identity → fatal; other failures → keep reconnecting. */
  private async reregister(): Promise<void> {
    this.reregisterTried = true;
    try {
      await this.register();
      this.log('re-registered with SaaS; reconnecting');
    } catch (err) {
      if (err instanceof PlatformKeyMismatchError || (err instanceof RegisterRejectedError && err.status === 409)) {
        this.log(`fatal: ${err.message}`);
        await this.stop();
        this.opts.onFatal?.(err);
        return;
      }
      this.log(`re-register failed (${(err as Error)?.message ?? err})`);
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const base = this.opts.reconnectBaseMs ?? 1000;
    const delay = Math.min(30_000, base * 2 ** this.attempt++);
    this.log(`disconnected; reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}
