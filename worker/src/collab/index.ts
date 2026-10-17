// Collaboration wiring: builds the SessionHost hooks (native tools, memory injection, cwd auto-tag,
// project-memory prefetch) and, once the tunnel exists, attaches the project cache refresh + stale-tag clearing
// (rebuilt on every (re)connect and claim change; a failed first project_list is retried with backoff), the session index push and the card executor to it. Hooks work
// before attach: the link is resolved per call (no link → tools answer saas_unreachable, cache reads stay empty).
import type { Card, RpcArgs, Session, SessionKind } from '@nopear/protocol';
import type { WorkerConfig } from '../config';
import type { HostDeps } from '../agent/host';
import { CollabCache } from './cache';
import { CardExecutor, type ExecutorHost } from './executor';
import { startIndexSync } from './index-sync';
import type { CollabLink } from './link';
import { createCollabTools } from './tools';

export type CollabHost = ExecutorHost & {
  list(a: { kinds?: SessionKind[] }): Session[];
  onSessionChange(l: (s: Session, removed?: boolean) => void): () => void;
  update(args: RpcArgs<'sessions.update'>): Promise<Session>;
};

/** Backoff between project_list retries while the project list is still unknown; the last entry is the cap. */
export const PROJECT_RETRY_DELAYS_MS: readonly number[] = [5_000, 10_000, 20_000, 60_000];

/** Schedules `fn` after `ms`; returns a cancel function. Default: an unref'd setTimeout. */
export type ScheduleRetry = (fn: () => void, ms: number) => () => void;
const defaultScheduleRetry: ScheduleRetry = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
};

export type CollabHooks = Required<Pick<HostDeps, 'extraTools' | 'systemPromptAppend' | 'autoProject' | 'onTagged'>>;

export function createCollab(o: { config: WorkerConfig; workerId: string; scheduleRetry?: ScheduleRetry }): {
  hooks: CollabHooks;
  attach(link: CollabLink, host: CollabHost): () => void;
} {
  let link: CollabLink | undefined;
  const scheduleRetry = o.scheduleRetry ?? defaultScheduleRetry;
  const cache = new CollabCache({ link: () => link, workerId: o.workerId });

  const hooks: CollabHooks = {
    extraTools: (meta) => createCollabTools(() => link, meta.id),
    systemPromptAppend: (meta) => cache.systemPromptAppend(meta),
    autoProject: (cwd) => cache.matchProject(cwd),
    onTagged: (projectId) => cache.prefetchMemory('project', projectId),
  };

  const attach = (l: CollabLink, host: CollabHost): (() => void) => {
    link = l;
    let detached = false;
    /** Latest project refresh; cards frames wait for it so project paths are known before cards start. */
    let refreshed: Promise<void> = Promise.resolve();
    let cardChain: Promise<void> = Promise.resolve();
    /** Bumped on unbind: queued card frames from before it are dropped. */
    let cardGen = 0;
    /** Last claim state reported by onClaimChanged (the first authz only sets the link's baseline: assume claimed). */
    let claimed = true;
    /** Pending project_list retry (cancel fn) and the backoff step of the next one. */
    let cancelRetry: (() => void) | undefined;
    let retryStep = 0;
    /** "project cards held" was logged for the current not-loaded period. */
    let heldWarned = false;

    const stopRetry = (restart: boolean) => {
      cancelRetry?.();
      cancelRetry = undefined;
      if (restart) retryStep = 0;
    };
    /** While the project list is unknown (first project_list failed), retry with backoff as long as connected and
     *  claimed. A disconnect stops it (the timer finds the link down and does not reschedule); connect/claim restart it. */
    const maybeRetry = () => {
      if (detached || cache.projectsLoaded() || !l.connected() || !claimed) {
        if (cache.projectsLoaded()) { stopRetry(true); heldWarned = false; }
        return;
      }
      if (cancelRetry) return;
      const ms = PROJECT_RETRY_DELAYS_MS[Math.min(retryStep, PROJECT_RETRY_DELAYS_MS.length - 1)]!;
      retryStep++;
      cancelRetry = scheduleRetry(() => {
        cancelRetry = undefined;
        if (detached || cache.projectsLoaded() || !l.connected() || !claimed) return;
        void refresh();
      }, ms);
    };

    const refresh = (): Promise<void> => {
      const p = (async () => {
        // null = failed / malformed / superseded by a newer refresh or a claim change: only the latest good
        // project_list may clear tags.
        const ids = await cache.refreshProjects();
        if (detached) return;
        maybeRetry();
        if (!ids) return;
        executor.resume(); // project cards held back while the list was unknown can start now
        for (const s of host.list({ kinds: ['chat'] })) {
          if (!s.projectId || ids.has(s.projectId)) continue;
          try { await host.update({ sessionId: s.id, projectId: null }); } catch (e) {
            console.warn(`[nopear] collab: clearing stale tag of ${s.id} failed: ${(e as Error).message}`);
          }
        }
      })().catch((e: unknown) => { console.warn(`[nopear] collab: project refresh failed: ${(e as Error)?.message ?? e}`); });
      refreshed = p;
      return p;
    };
    const onConnected = () => {
      stopRetry(true);
      void refresh();
      void cache.prefetchMemory('global', null);
    };

    const executor = new CardExecutor({
      host, link: l, wip: o.config.cardWip, defaultCwd: o.config.defaultCwd, projectPath: (id) => cache.projectPath(id),
      projectsReady: () => cache.projectsLoaded(),
    });
    const index = startIndexSync({ host, link: l });
    const offs = [
      l.onConnected(onConnected),
      l.onProjectsChanged(() => { void refresh(); }),
      // Claimed by / unbound from an account mid-connection: the cache belongs to the previous state. Claimed →
      // rebuild as on connect (SaaS dropped the index while unclaimed); unclaimed → just forget, and drop the old
      // owner's cards as a cards:[] frame would (SaaS's own cards:[] is lost if the unbind happened while we were
      // offline, and SaaS sends no cards to an unclaimed worker). Card frames still waiting for a refresh are
      // the old owner's too: skip them.
      l.onClaimChanged((s) => {
        cache.reset();
        claimed = s.claimed;
        stopRetry(true);
        heldWarned = false;
        if (!s.claimed) {
          cardGen++;
          executor.onCards([]);
          return;
        }
        if (!l.connected()) return;
        onConnected();
        index.sendFull();
      }),
      l.onCards((cards: Card[]) => {
        const wait = refreshed;
        const gen = cardGen;
        cardChain = cardChain.then(() => wait).then(() => {
          if (detached || gen !== cardGen) return;
          executor.onCards(cards);
          if (!heldWarned && !cache.projectsLoaded() && cards.some((c) => c.state === 'queued' && c.projectId)) {
            heldWarned = true;
            console.warn('[nopear] collab: project list unknown (project_list failed); project cards held until it loads, retrying');
          }
        })
          .catch((e: unknown) => { console.warn(`[nopear] collab: card executor failed: ${(e as Error)?.message ?? e}`); });
      }),
      index.stop,
      () => executor.dispose(),
      () => stopRetry(true),
    ];
    if (l.connected()) onConnected();

    return () => {
      if (detached) return;
      detached = true;
      for (const off of offs) off();
      if (link === l) link = undefined;
    };
  };

  return { hooks, attach };
}
