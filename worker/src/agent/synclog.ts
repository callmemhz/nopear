// Per-session in-memory change log. Cursors are "<epoch>.<n>";
// a cursor from another epoch, malformed, from the future, or older than the retained window means
// the client must be sent a fresh snapshot (since() returns null).
import { formatCursor, parseCursor, SYNC_LOG_LIMIT, type SessionEvent } from '@nopear/protocol';
import { randomBytes } from '@nopear/core/crypto';

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
export function newEpoch(): string {
  const bytes = randomBytes(8);
  let s = '';
  for (const b of bytes) s += B32[b & 31];
  return s;
}

/** A SessionEvent before the log assigns its cursor. */
export type Uncursored = SessionEvent extends infer E ? (E extends SessionEvent ? Omit<E, 'cursor'> : never) : never;

/** Default byte budget per session log (serialized JSON), on top of the SYNC_LOG_LIMIT event count. */
export const SYNC_LOG_MAX_BYTES = 8 * 1024 * 1024;

export class SyncLog {
  private readonly events: SessionEvent[] = [];
  private readonly sizes: number[] = [];
  private bytes = 0;
  private n = 0;
  constructor(private readonly epoch: string, private readonly limit: number = SYNC_LOG_LIMIT, private readonly maxBytes: number = SYNC_LOG_MAX_BYTES) {}

  append<E extends Uncursored>(e: E): SessionEvent {
    const ev = { ...e, cursor: formatCursor(this.epoch, ++this.n) } as unknown as SessionEvent;
    const size = JSON.stringify(ev).length;
    this.events.push(ev);
    this.sizes.push(size);
    this.bytes += size;
    while (this.events.length > 1 && (this.events.length > this.limit || this.bytes > this.maxBytes)) {
      this.events.shift();
      this.bytes -= this.sizes.shift()!;
    }
    return ev;
  }

  since(cursor: string | undefined): SessionEvent[] | null {
    if (!cursor) return null;
    const c = parseCursor(cursor);
    if (!c || c.epoch !== this.epoch || c.n > this.n) return null;
    const first = this.n - this.events.length + 1; // n of the oldest retained event
    if (c.n < first - 1) return null;
    return this.events.slice(c.n - first + 1);
  }

  current(): string {
    return formatCursor(this.epoch, this.n);
  }
}
