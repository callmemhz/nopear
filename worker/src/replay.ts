import { REPLAY_WINDOW_MS } from '@nopear/protocol';

/** Rejects requests whose ts is outside ±window, or whose rid was seen within the window. */
export class ReplayGuard {
  private seen = new Map<string, number>(); // rid -> expiry
  constructor(private readonly windowMs: number = REPLAY_WINDOW_MS) {}
  check(rid: string, ts: number, now: number): 'ok' | 'stale' | 'replay' {
    if (!Number.isFinite(ts) || Math.abs(now - ts) > this.windowMs) return 'stale';
    for (const [k, exp] of this.seen) if (exp <= now) this.seen.delete(k); else break;
    if (this.seen.has(rid)) return 'replay';
    this.seen.set(rid, now + 2 * this.windowMs);
    return 'ok';
  }
}
