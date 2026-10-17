// The worker's view of its SaaS collaboration link: native collaboration tools, the session
// index push, card state reports and the SaaS → worker card/project pushes. Implemented by TunnelClient.
import type { Card, SessionIndexEntry, ToolName, ToolOutcome } from '@nopear/protocol';

export interface CollabLink {
  readonly workerId: string;
  connected(): boolean;
  /** t:'tool' → awaits t:'tool.res'. Not connected → {ok:false,error:{code:'saas_unreachable'}} immediately;
   *  no answer within RPC_TIMEOUT_MS → code 'timeout'; tunnel closes while pending → 'saas_unreachable'. */
  callTool(name: ToolName, args: Record<string, unknown>, sessionId?: string): Promise<ToolOutcome>;
  sendIndex(f: { full: boolean; sessions: SessionIndexEntry[]; removed: string[] }): void;
  sendCardState(f: { cardId: string; state: 'running' | 'review'; sessionId?: string; error?: string }): void;
  onCards(fn: (cards: Card[]) => void): () => void;
  onProjectsChanged(fn: () => void): () => void;
  /** Fires after every (re)connect, right after hello is sent. */
  onConnected(fn: () => void): () => void;
  /** Fires when an authz frame changes the claim state (claimed / owning userId) relative to the previous authz
   *  (kept across reconnects; the first authz only sets the baseline). Not fired for client-list-only updates. */
  onClaimChanged(fn: (s: { claimed: boolean; userId?: string }) => void): () => void;
}
