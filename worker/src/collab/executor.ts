// Card executor: runs the `queued` cards SaaS pushes for this machine as ordinary chat sessions,
// up to `wip` at a time, and reports progress with `card.state` (running → review).
import { randomUUID } from 'node:crypto';
import type { Card, RpcArgs, Session } from '@nopear/protocol';
import type { CollabLink } from './link';

export interface ExecutorHost {
  create(args: RpcArgs<'sessions.create'>, opts: { projectId?: string; cwd?: string; title?: string }): Promise<Session>;
  get(id: string): Session;
  waitIdle(id: string): Promise<void>;
  interrupt(id: string): Promise<void>;
  lastError(id: string): string | undefined;
}

export const NO_LOCAL_PATH = '该项目在本机没有路径';

type CardStateFrame = Parameters<CollabLink['sendCardState']>[0];

/** What we did with one queued instance of a card. Not keyed by `updatedAt`: every card edit (title/body/order)
 *  bumps it, so it cannot tell a re-queue from an edit. A re-queue to this machine keeps our sessionId on the card
 *  (SaaS clears it when the machine changes, and the card then leaves our set). */
interface Report {
  /** Session started for this instance (unset for a missing path, a failed create, or while create is pending). */
  sessionId?: string;
  /** No local project path: rejected with review+error, no session. */
  missingPath: boolean;
  /** card.state frames sent for this instance, in order (re-sent if the tunnel dropped them). */
  frames: CardStateFrame[];
}

interface Run {
  sessionId?: string;
  cancelled: boolean;
  /** SaaS has shown the card as running since this run started. */
  seenRunning: boolean;
  report: Report;
}

export class CardExecutor {
  /** Latest card set from SaaS (this worker's queued + running cards). */
  private cards = new Map<string, Card>();
  /** Cards this executor is running (sessionId set once the session exists). */
  private runs = new Map<string, Run>();
  /** cardId → the queued instance we already acted on (started or rejected for a missing path), so a stale or
   *  edited `cards` frame still showing it queued does not start it again. Dropped once the card leaves the set
   *  or is re-queued. */
  private reports = new Map<string, Report>();
  /** Tunnel reconnected: the next `cards` frame (SaaS's fresh view) re-sends reports the outage swallowed. */
  private resync = false;
  private disposed = false;
  private readonly offConnected: () => void;

  constructor(private readonly o: {
    host: ExecutorHost; link: CollabLink; wip: number; defaultCwd: string; projectPath(id: string): string | undefined;
    /** The project list is known (default: always). Until then project cards stay queued — no session, no report —
     *  instead of failing with NO_LOCAL_PATH on a transient project_list failure; call resume() once it is. */
    projectsReady?(): boolean;
  }) {
    this.offConnected = o.link.onConnected(() => { this.resync = true; });
  }

  /** Detached from the link: unsubscribe, and stop reporting / starting cards. Started sessions keep running
   *  (one still being created is interrupted, as for a cancelled card). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.offConnected();
    for (const run of this.runs.values()) run.cancelled = true;
    this.runs.clear();
    this.cards.clear();
    this.reports.clear();
  }

  /** The project list became known (first good refresh): start project cards that were held back. */
  resume(): void {
    this.pump();
  }

  onCards(cards: Card[]): void {
    if (this.disposed) return;
    const me = this.o.link.workerId;
    this.cards = new Map(cards.filter((c) => c.workerId === me && (c.state === 'queued' || c.state === 'running')).map((c) => [c.id, c]));
    for (const [cardId, run] of this.runs) {
      const c = this.cards.get(cardId);
      if (c?.state === 'running') run.seenRunning = true;
      // Gone, or queued again after SaaS showed it running / still carrying our session (re-queued to this same
      // machine). Plain edits of a queued card (title/body/order) are not re-queues and must not cancel the run.
      else if (!c || run.seenRunning || (run.sessionId !== undefined && c.sessionId === run.sessionId)) {
        this.cancel(cardId, run);
        if (c) this.reports.delete(cardId); // a new instance: let pump() start it afresh
      }
    }
    for (const id of this.reports.keys()) if (!this.cards.has(id)) this.reports.delete(id);
    if (this.resync) { this.resync = false; this.resend(); }
    for (const c of this.cards.values()) if (c.state === 'running' && !this.runs.has(c.id)) this.reconcile(c);
    this.pump();
  }

  /** The queued card `c` is still the instance `rep` acted on (not re-queued since): a re-queue to this machine
   *  keeps our session on the card; leaving the machine drops it from the set, which drops the report. */
  private sameInstance(rep: Report, c: Card): boolean {
    return c.state === 'queued' && (rep.sessionId === undefined || c.sessionId !== rep.sessionId);
  }

  /** After a reconnect: a card still queued as the very instance we acted on means SaaS got none of our frames
   *  (any accepted frame moves it out of queued; edits made meanwhile do not matter). Missing-path cards are
   *  re-evaluated by pump(); started cards get their frames re-sent. Lost reviews of running cards are covered
   *  by reconcile(). */
  private resend(): void {
    for (const [id, rep] of this.reports) {
      const c = this.cards.get(id);
      if (!c || !this.sameInstance(rep, c)) continue;
      if (rep.missingPath) this.reports.delete(id);
      else for (const f of rep.frames) this.o.link.sendCardState(f);
    }
  }

  private send(rep: Report, f: CardStateFrame): void {
    rep.frames.push(f);
    this.o.link.sendCardState(f);
  }

  /** Card left this machine's set or was re-queued: stop its session; its later idle is not reported. */
  private cancel(cardId: string, run: Run): void {
    run.cancelled = true;
    this.runs.delete(cardId);
    if (run.sessionId) this.interrupt(run.sessionId);
  }

  /** `running` card we do not track (restart / reconnect): its session is not running here → review. */
  private reconcile(c: Card): void {
    let s: Session | undefined;
    try { s = c.sessionId ? this.o.host.get(c.sessionId) : undefined; } catch { s = undefined; }
    if (s?.status === 'running') return;
    const error = s?.status === 'error' ? this.o.host.lastError(s.id) : undefined;
    this.o.link.sendCardState({ cardId: c.id, state: 'review', ...(error ? { error } : {}) });
  }

  private interrupt(sessionId: string): Promise<void> {
    return Promise.resolve().then(() => this.o.host.interrupt(sessionId)).catch(() => {});
  }

  private pump(): void {
    if (this.disposed) return;
    const ready = this.o.projectsReady?.() ?? true;
    const next = [...this.cards.values()]
      .filter((c) => {
        const rep = this.reports.get(c.id);
        return c.state === 'queued' && !this.runs.has(c.id) && !(rep && this.sameInstance(rep, c))
          && (ready || !c.projectId); // project unknown yet: keep it queued, re-pumped by resume()
      })
      .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt));
    for (const c of next) {
      if (this.runs.size >= this.o.wip) break;
      const path = c.projectId ? this.o.projectPath(c.projectId) : this.o.defaultCwd;
      const report: Report = { missingPath: path === undefined, frames: [] };
      this.reports.set(c.id, report);
      if (path === undefined) {
        this.send(report, { cardId: c.id, state: 'review', error: NO_LOCAL_PATH });
        continue;
      }
      const run: Run = { cancelled: false, seenRunning: false, report };
      this.runs.set(c.id, run);
      void this.run(c, path, run);
    }
  }

  private async run(c: Card, cwd: string, run: Run): Promise<void> {
    const { host } = this.o;
    try {
      const opts = { ...(c.projectId ? { projectId: c.projectId } : {}), cwd, title: c.title };
      const s = await host.create({ text: `# ${c.title}\n\n${c.body}`, clientMsgId: randomUUID() }, opts);
      run.sessionId = run.report.sessionId = s.id;
      if (run.cancelled) { await this.interrupt(s.id); return; }
      this.send(run.report, { cardId: c.id, state: 'running', sessionId: s.id });
      await host.waitIdle(s.id);
      if (run.cancelled) return;
      let error: string | undefined;
      try { if (host.get(s.id).status === 'error') error = host.lastError(s.id) ?? 'error'; } catch { /* session gone */ }
      this.send(run.report, { cardId: c.id, state: 'review', ...(error ? { error } : {}) });
    } catch (e) {
      if (!run.cancelled) this.send(run.report, { cardId: c.id, state: 'review', error: (e as Error).message || String(e) });
    } finally {
      if (this.runs.get(c.id) === run) this.runs.delete(c.id);
      if (!run.cancelled) this.pump();
    }
  }
}
