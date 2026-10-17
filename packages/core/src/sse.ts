// Minimal text/event-stream parser (fetch-based; we never use EventSource so headers can carry auth).
export interface SseMessage { event?: string; data: string; id?: string }

export function createSseParser(onMessage: (m: SseMessage) => void): { push(chunk: string): void; end(): void } {
  let buf = '';
  let data: string[] | null = null;
  let event: string | undefined;
  let id: string | undefined;

  const dispatch = () => {
    if (data !== null) {
      const m: SseMessage = { data: data.join('\n') };
      if (event !== undefined) m.event = event;
      if (id !== undefined) m.id = id;
      onMessage(m);
    }
    data = null; event = undefined; id = undefined;
  };
  const line = (l: string) => {
    if (l === '') return dispatch();
    if (l.startsWith(':')) return;
    const i = l.indexOf(':');
    const field = i < 0 ? l : l.slice(0, i);
    let value = i < 0 ? '' : l.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') (data ??= []).push(value);
    else if (field === 'event') event = value;
    else if (field === 'id') id = value;
  };
  const drain = (final: boolean) => {
    for (;;) {
      const m = /\r\n|\r|\n/.exec(buf);
      if (!m) break;
      // a trailing lone '\r' may be the first half of '\r\n' split across chunks
      if (!final && m[0] === '\r' && m.index === buf.length - 1) break;
      line(buf.slice(0, m.index));
      buf = buf.slice(m.index + m[0].length);
    }
  };
  return {
    push(chunk) { buf += chunk; drain(false); },
    end() {
      drain(true);
      if (buf) { line(buf); buf = ''; }
      dispatch();
    },
  };
}

/** Read an SSE response body to completion (or until `signal` aborts). `onActivity` fires for every chunk received
 *  (events and `: ping` comment lines alike) so callers can run a liveness watchdog. */
export async function readSse(res: Response, onMessage: (m: SseMessage) => void, signal?: AbortSignal, onActivity?: () => void): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const parser = createSseParser(onMessage);
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  if (signal?.aborted) onAbort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      let r: ReadableStreamReadResult<Uint8Array>;
      try { r = await reader.read(); } catch (e) { if (signal?.aborted) return; throw e; }
      if (r.done) break;
      try { onActivity?.(); } catch { /* caller error */ }
      parser.push(dec.decode(r.value, { stream: true }));
      if (signal?.aborted) return;
    }
    parser.push(dec.decode());
    parser.end();
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Liveness watchdog for one long-lived stream: `signal` aborts when `parent` aborts or when `kick()` has not been
 *  called for `ms` (then `stalled` is true). Call `kick()` on every received chunk and `dispose()` when done. */
export interface StallWatchdog { readonly signal: AbortSignal; readonly stalled: boolean; kick(): void; dispose(): void }

export function stallWatchdog(parent: AbortSignal, ms: number): StallWatchdog {
  const ctl = new AbortController();
  let stalled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const onParent = () => { clear(); ctl.abort(); };
  const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
  const arm = () => {
    clear();
    if (ctl.signal.aborted || !(ms > 0) || !Number.isFinite(ms)) return;
    timer = setTimeout(() => { timer = null; stalled = true; ctl.abort(); }, ms);
  };
  if (parent.aborted) ctl.abort();
  else { parent.addEventListener('abort', onParent, { once: true }); arm(); }
  return {
    signal: ctl.signal,
    get stalled() { return stalled; },
    kick: arm,
    dispose() { clear(); parent.removeEventListener('abort', onParent); },
  };
}
