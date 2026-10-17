// Session index push: a full index after every (re)connect, then one incremental frame
// per session change / removal. Plaintext regardless of the E2E switch (D2). sendFull() re-sends the full index on
// demand (claim change: SaaS drops the index of an unclaimed worker).
import { sessionIndexEntry, type Session, type SessionKind } from '@nopear/protocol';
import type { CollabLink } from './link';

export function startIndexSync(o: {
  host: { list(a: { kinds?: SessionKind[] }): Session[]; onSessionChange(l: (s: Session, removed?: boolean) => void): () => void };
  link: CollabLink;
}): { stop(): void; sendFull(): void } {
  const { host, link } = o;
  const sendFull = () => {
    if (!link.connected()) return; // the next (re)connect sends one
    link.sendIndex({ full: true, sessions: host.list({ kinds: ['chat'] }).map(sessionIndexEntry), removed: [] });
  };
  const offConnected = link.onConnected(sendFull);
  const offChange = host.onSessionChange((s, removed) => {
    if (!link.connected()) return; // the next (re)connect sends a full index
    if (removed) link.sendIndex({ full: false, sessions: [], removed: [s.id] });
    else if (s.kind === 'chat') link.sendIndex({ full: false, sessions: [sessionIndexEntry(s)], removed: [] });
  });
  if (link.connected()) sendFull();
  return { stop: () => { offConnected(); offChange(); }, sendFull };
}
