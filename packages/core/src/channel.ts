// Data plane to one worker through the SaaS relay: sealed (E2E) or plaintext (account E2E off) RPC + SSE watch.
import {
  BINARY_RPC_TIMEOUT_MS, HEADER_CLIENT, HEADER_PLAIN, PLAINTEXT_DISABLED_MESSAGE, RPC_TIMEOUT_MS, SSE_STALL_MS, isBinaryOp,
  type ResponseHeader, type RpcArgs, type RpcOp, type RpcResult, type WatchArgs, type WatchEvent, type WatchOp,
} from '@nopear/protocol';
import { decodeFrame, deriveKey, encodeFrame, fromB64url, open, randomId, seal, type KeyPair } from './crypto';
import { errorFromResponse, type SaasClient, type StreamOpts } from './saas';
import { readSse, stallWatchdog } from './sse';

export class RpcCallError extends Error {
  constructor(public code: string, message: string, public status?: number) {
    super(message);
    this.name = 'RpcCallError';
  }
}

export class WorkerChannel {
  readonly workerId: string;
  private saas: SaasClient;
  private clientPub: string;
  private key: Uint8Array;
  private plain: () => boolean;
  private onStaleSettings: (() => void) | undefined;
  /** Sticky: this worker refused plaintext (NOPEAR_E2E=required) → always seal, whatever `plain()` says. */
  private forceSealed = false;

  /** `plain()` is read per request: true → plaintext frames + `x-nopear-plain: 1` (account `settings.e2e === false`).
   *  `onStaleSettings` fires when the SaaS refuses a plaintext request with 409 `e2e_enabled` (account E2E is on but
   *  `plain()` still said off) so the owner can re-fetch settings. */
  constructor(opts: {
    saas: SaasClient; workerId: string; workerPub: string; clientKey: KeyPair; plain?: () => boolean; onStaleSettings?: () => void;
  }) {
    this.saas = opts.saas;
    this.workerId = opts.workerId;
    this.clientPub = opts.clientKey.pub;
    this.key = deriveKey(opts.clientKey.priv, opts.workerPub, opts.workerId, opts.clientKey.pub);
    this.plain = opts.plain ?? (() => false);
    this.onStaleSettings = opts.onStaleSettings;
  }

  private usePlain(): boolean { return !this.forceSealed && this.plain(); }
  /** A failed plaintext request that was never executed and should be retried once sealed:
   *  - worker requires E2E (400 plaintext disabled) → sticky: this channel seals from now on;
   *  - SaaS says account E2E is on (409 `e2e_enabled`, stale settings) → this request only; owner re-fetches settings. */
  private async plainRefused(res: Response): Promise<{ refused: boolean; code: string; message: string }> {
    const e = await errorFromResponse(res);
    if (res.status === 400 && e.message === PLAINTEXT_DISABLED_MESSAGE) {
      this.forceSealed = true;
      return { refused: true, ...e };
    }
    if (res.status === 409 && e.code === 'e2e_enabled') {
      try { this.onStaleSettings?.(); } catch { /* owner callback error */ }
      return { refused: true, ...e };
    }
    return { refused: false, ...e };
  }

  private request(op: string, args: unknown, plain: boolean): Uint8Array {
    const frame = encodeFrame({ v: 3, rid: randomId(16), ts: Date.now(), op, args });
    return plain ? frame : seal(this.key, frame);
  }
  private headers(plain: boolean, extra: Record<string, string> = {}): Record<string, string> {
    return { [HEADER_CLIENT]: this.clientPub, ...(plain ? { [HEADER_PLAIN]: '1' } : {}), ...extra };
  }
  private path(kind: 'rpc' | 'watch') { return `/api/w/${encodeURIComponent(this.workerId)}/${kind}`; }

  async rpc<O extends RpcOp>(op: O, args: RpcArgs<O>, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<RpcResult<O>> {
    const ctl = new AbortController();
    const timeout = opts.timeoutMs ?? (isBinaryOp(op) ? BINARY_RPC_TIMEOUT_MS : RPC_TIMEOUT_MS);
    const timer = setTimeout(() => ctl.abort(), timeout);
    const onAbort = () => ctl.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    let plain = this.usePlain();
    const post = async (): Promise<Response> => {
      try {
        return await this.saas.rawPost(this.path('rpc'), this.request(op, args, plain), this.headers(plain), ctl.signal);
      } catch (e) {
        if (ctl.signal.aborted && !opts.signal?.aborted) throw new RpcCallError('timeout', `${op} timed out`, 504);
        throw new RpcCallError('network', e instanceof Error ? e.message : String(e));
      }
    };
    try {
      let res = await post();
      if (!res.ok && plain) {
        const e = await this.plainRefused(res);
        if (!e.refused) throw new RpcCallError(e.code, e.message, res.status);
        plain = false; // retry once sealed (the refused request was never executed)
        res = await post();
      }
      if (!res.ok) {
        const e = await errorFromResponse(res);
        throw new RpcCallError(e.code, e.message, res.status);
      }
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await res.arrayBuffer());
      } catch (e) {
        if (ctl.signal.aborted && !opts.signal?.aborted) throw new RpcCallError('timeout', `${op} timed out`, 504);
        throw new RpcCallError('network', e instanceof Error ? e.message : String(e));
      }
      let frame: { header: unknown; body: Uint8Array };
      try { frame = decodeFrame(plain ? bytes : open(this.key, bytes)); } catch { throw new RpcCallError('bad_response', 'undecryptable response'); }
      const h = frame.header as ResponseHeader;
      if (!h.ok) throw new RpcCallError(h.error.code, h.error.message);
      if (isBinaryOp(op)) {
        const r: { bytes: Uint8Array; mediaType: string; name?: string } = { bytes: frame.body, mediaType: h.mediaType ?? 'application/octet-stream' };
        if (h.name !== undefined) r.name = h.name;
        return r as RpcResult<O>;
      }
      return h.result as RpcResult<O>;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Open a watch and read it until it ends. `ended: 'closed'` = the stream closed, `signal` aborted, or it stalled
   *  (no bytes — events or `: ping` — for `opts.stallMs`, default SSE_STALL_MS); the caller reopens as usual. */
  async watch<W extends WatchOp>(op: W, args: WatchArgs<W>, onEvent: (e: WatchEvent<W>) => void, parent: AbortSignal, opts: StreamOpts = {}):
    Promise<{ ended: 'end' | 'offline' | 'closed'; code?: string }> {
    const wd = stallWatchdog(parent, opts.stallMs ?? SSE_STALL_MS);
    try { return await this.watchOnce(op, args, onEvent, wd.signal, () => { wd.kick(); try { opts.onActivity?.(); } catch { /* caller error */ } }); }
    finally { wd.dispose(); }
  }

  private async watchOnce<W extends WatchOp>(op: W, args: WatchArgs<W>, onEvent: (e: WatchEvent<W>) => void, signal: AbortSignal, activity: () => void):
    Promise<{ ended: 'end' | 'offline' | 'closed'; code?: string }> {
    let plain = this.usePlain();
    const post = () => this.saas.rawPost(this.path('watch'), this.request(op, args, plain), this.headers(plain, { accept: 'text/event-stream' }), signal)
      .catch((e: unknown) => {
        if (signal.aborted) return null;
        throw new RpcCallError('network', e instanceof Error ? e.message : String(e));
      });
    let res = await post();
    if (!res) return { ended: 'closed' };
    if (!res.ok && plain) {
      const e = await this.plainRefused(res);
      if (!e.refused) throw new RpcCallError(e.code, e.message, res.status);
      plain = false; // retry the open once sealed
      res = await post();
      if (!res) return { ended: 'closed' };
    }
    if (!res.ok) {
      const e = await errorFromResponse(res);
      throw new RpcCallError(e.code, e.message, res.status);
    }
    activity();
    let result: { ended: 'end' | 'offline' | 'closed'; code?: string } = { ended: 'closed' };
    const stop = new AbortController();
    const onAbort = () => stop.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      await readSse(res, (m) => {
        if (stop.signal.aborted) return;
        if (m.event === 'offline') { result = { ended: 'offline' }; stop.abort(); return; }
        if (m.event === 'end') { result = m.data ? { ended: 'end', code: m.data } : { ended: 'end' }; stop.abort(); return; }
        if (!m.data) return;
        let ev: WatchEvent<W>;
        try {
          const bytes = fromB64url(m.data);
          ev = decodeFrame(plain ? bytes : open(this.key, bytes)).header as WatchEvent<W>;
        } catch { return; }
        onEvent(ev);
      }, stop.signal, activity);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
    // Worker switched plaintext off mid-stream: the caller reopens; make that reopen sealed even if plain() lags.
    if (plain && result.ended === 'end' && result.code === 'plaintext_disabled' && this.plain()) this.forceSealed = true;
    return result;
  }
}
