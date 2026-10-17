// Collab service — SaaS collaboration hub logic shared by REST, MCP, /api/tools and tunnel frames.
// The store does not cascade; every cascade (delete project, unbind machine) and every dispatch lives here.
import {
  CARD_MOVE_STATES, CARD_STATES, MEMORY_MAX_BYTES,
  type AccountSettings, type AutoCompactSettings, type Card, type CardPatch, type CardState, type MemoryDoc, type MemoryScope, type Project,
  type RpcOp, type SaasEvent, type SaasToWorker, type SessionIndexEntry, type ToolErrorCode, type ToolOutcome,
  type WorkerToSaas,
} from '@nopear/protocol';
import type { SaasStore, WorkerRow } from './store';
import { executeTool } from './tools';

export interface CollabHub {
  isOnline(workerId: string): boolean;
  sendToWorker(workerId: string, f: SaasToWorker): boolean;
  plainRpc(workerId: string, op: RpcOp, args: unknown, timeoutMs?: number): Promise<ToolOutcome>;
  pushAuthz(workerId: string): Promise<void>;
}
export interface CollabEvents { emit(userId: string, e: SaasEvent): void }
export type ToolCaller = { userId: string; workerId: string | null };

export class CollabError extends Error {
  constructor(readonly code: ToolErrorCode, message: string) {
    super(message);
    this.name = 'CollabError';
  }
}

export interface MachineSummary { workerId: string; label: string; online: boolean; runningCards: Card[] }

const SESSION_LIMIT_DEFAULT = 50;
const SESSION_LIMIT_MAX = 500;
/** `projectId` input: absent (undefined), `null` (no project) or a non-empty string; anything else → `bad_request`. */
function checkProjectIdInput(v: unknown): void {
  if (v !== undefined && v !== null && (typeof v !== 'string' || v === '')) {
    throw new CollabError('bad_request', 'projectId must be a non-empty string or null');
  }
}
/** Optional string filter/id: absent or a string; anything else → `bad_request`. */
function checkOptString(name: string, v: unknown): void {
  if (v !== undefined && typeof v !== 'string') throw new CollabError('bad_request', `${name} must be a string`);
}
/** Cards a worker holds in its `cards` set. */
const inWorkerSet = (c: Card | null, workerId: string): boolean =>
  !!c && c.workerId === workerId && (c.state === 'queued' || c.state === 'running');

export class Collab {
  readonly store: SaasStore;
  readonly hub: CollabHub;
  private events: CollabEvents;

  constructor(opts: { store: SaasStore; hub: CollabHub; events: CollabEvents }) {
    this.store = opts.store;
    this.hub = opts.hub;
    this.events = opts.events;
  }

  // ---------- helpers ----------
  /** Throws `forbidden` unless `workerId` is a machine of this user. */
  async requireWorker(userId: string, workerId: string): Promise<WorkerRow> {
    const w = await this.store.workers.get(workerId);
    if (!w || w.userId !== userId) throw new CollabError('forbidden', `machine ${workerId} does not belong to this account`);
    return w;
  }

  private async requireCard(userId: string, id: string): Promise<Card> {
    const c = await this.store.cards.get(userId, id);
    if (!c) throw new CollabError('not_found', `card ${id} not found`);
    return c;
  }

  private async checkPaths(userId: string, paths: unknown): Promise<Record<string, string>> {
    if (typeof paths !== 'object' || paths === null || Array.isArray(paths)) throw new CollabError('bad_request', 'paths must be an object');
    const out: Record<string, string> = {};
    for (const [workerId, p] of Object.entries(paths as Record<string, unknown>)) {
      if (typeof p !== 'string' || !p.startsWith('/')) throw new CollabError('bad_request', `path for machine ${workerId} must be an absolute path`);
      await this.requireWorker(userId, workerId);
      out[workerId] = p;
    }
    return out;
  }

  private async notifyProjectsChanged(userId: string): Promise<void> {
    for (const w of await this.store.workers.listByUser(userId)) {
      if (this.hub.isOnline(w.workerId)) this.hub.sendToWorker(w.workerId, { t: 'projects.changed' });
    }
  }

  /**
   * Recompute and push the worker's queued+running card set (no-op while offline; `hello` re-pushes). Scoped to the
   * machine's current owner: an unclaimed machine gets an empty set, never cards left behind by a previous owner.
   */
  async dispatch(workerId: string): Promise<void> {
    if (!this.hub.isOnline(workerId)) return;
    const userId = await this.claimedOwner(workerId);
    const cards = userId ? await this.store.cards.forWorker(workerId, userId) : [];
    this.hub.sendToWorker(workerId, { t: 'cards', cards });
  }

  private async dispatchChanged(before: Card | null, after: Card | null): Promise<void> {
    const ids = new Set<string>();
    for (const c of [before, after]) if (c?.workerId) ids.add(c.workerId);
    for (const w of ids) if (inWorkerSet(before, w) || inWorkerSet(after, w)) await this.dispatch(w);
  }

  // ---------- projects ----------
  listProjects(userId: string): Promise<Project[]> {
    return this.store.projects.list(userId);
  }

  async getProject(userId: string, id: string): Promise<Project> {
    const p = await this.store.projects.get(userId, id);
    if (!p) throw new CollabError('not_found', `project ${id} not found`);
    return p;
  }

  async createProject(userId: string, input: { name: string; description?: string; paths?: Record<string, string> }): Promise<Project> {
    if (typeof input.name !== 'string' || !input.name.trim()) throw new CollabError('bad_request', 'name is required');
    if (input.description !== undefined && typeof input.description !== 'string') throw new CollabError('bad_request', 'description must be a string');
    const paths = await this.checkPaths(userId, input.paths ?? {});
    const p = await this.store.projects.create(userId, { name: input.name, description: input.description ?? '', paths });
    this.events.emit(userId, { type: 'project.updated', project: p });
    await this.notifyProjectsChanged(userId);
    return p;
  }

  async updateProject(userId: string, id: string, patch: { name?: string; description?: string; paths?: Record<string, string> }): Promise<Project> {
    await this.getProject(userId, id);
    if (patch.name !== undefined && (typeof patch.name !== 'string' || !patch.name.trim())) throw new CollabError('bad_request', 'name must be non-empty');
    if (patch.description !== undefined && typeof patch.description !== 'string') throw new CollabError('bad_request', 'description must be a string');
    const paths = patch.paths === undefined ? undefined : await this.checkPaths(userId, patch.paths);
    const p = await this.store.projects.update(userId, id, { name: patch.name, description: patch.description, paths });
    if (!p) throw new CollabError('not_found', `project ${id} not found`);
    this.events.emit(userId, { type: 'project.updated', project: p });
    await this.notifyProjectsChanged(userId);
    return p;
  }

  /** cards deleted (running sessions interrupted via `cards`), memory deleted, index tags cleared. */
  async deleteProject(userId: string, id: string): Promise<void> {
    if (!(await this.store.projects.delete(userId, id))) throw new CollabError('not_found', `project ${id} not found`);
    const cards = await this.store.cards.deleteByProject(userId, id);
    await this.store.memories.deleteProject(userId, id);
    await this.store.sessionIndex.clearProject(userId, id);
    for (const c of cards) this.events.emit(userId, { type: 'card.removed', cardId: c.id });
    const workers = new Set<string>();
    for (const c of cards) if (c.workerId && inWorkerSet(c, c.workerId)) workers.add(c.workerId);
    for (const w of workers) await this.dispatch(w);
    this.events.emit(userId, { type: 'project.removed', projectId: id });
    await this.notifyProjectsChanged(userId);
  }

  // ---------- cards ----------
  async listCards(userId: string, f: { projectId?: string; state?: CardState; workerId?: string }): Promise<Card[]> {
    if (f.state !== undefined && !CARD_STATES.includes(f.state)) throw new CollabError('bad_request', `unknown state: ${String(f.state)}`);
    checkOptString('projectId', f.projectId);
    checkOptString('workerId', f.workerId);
    return this.store.cards.list(userId, f);
  }

  async createCard(userId: string, input: { title: string; body?: string; projectId?: string | null }): Promise<Card> {
    if (typeof input.title !== 'string' || !input.title.trim()) throw new CollabError('bad_request', 'title is required');
    if (input.body !== undefined && typeof input.body !== 'string') throw new CollabError('bad_request', 'body must be a string');
    checkProjectIdInput(input.projectId);
    const projectId = input.projectId ?? null;
    if (projectId !== null) await this.getProject(userId, projectId);
    const order = (await this.store.cards.maxOrder(userId, 'inbox', null)) + 1;
    const c = await this.store.cards.create(userId, { title: input.title, body: input.body ?? '', projectId, order });
    this.events.emit(userId, { type: 'card.updated', card: c });
    return c;
  }

  /** Card state rules (shared by REST PATCH and card_move / card_update). */
  async patchCard(userId: string, id: string, patch: CardPatch): Promise<Card> {
    const before = await this.requireCard(userId, id);
    const { state, workerId } = patch;
    if (state !== undefined && !CARD_MOVE_STATES.includes(state)) {
      throw new CollabError('bad_request', `state ${String(state)} cannot be set; allowed: ${CARD_MOVE_STATES.join('|')}`);
    }
    if (workerId !== undefined && state === undefined) throw new CollabError('bad_request', 'workerId requires state');
    if (state === 'queued' && !workerId) throw new CollabError('bad_request', 'moving to queued requires workerId');
    checkOptString('workerId', workerId);
    checkProjectIdInput(patch.projectId);
    if (patch.title !== undefined && (typeof patch.title !== 'string' || !patch.title.trim())) throw new CollabError('bad_request', 'title must be non-empty');
    if (patch.body !== undefined && typeof patch.body !== 'string') throw new CollabError('bad_request', 'body must be a string');
    if (patch.order !== undefined && (typeof patch.order !== 'number' || !Number.isFinite(patch.order))) {
      throw new CollabError('bad_request', 'order must be a number');
    }
    if (patch.projectId) await this.getProject(userId, patch.projectId);

    const upd: Parameters<SaasStore['cards']['update']>[2] = {
      title: patch.title, body: patch.body, projectId: patch.projectId, order: patch.order,
    };
    if (state !== undefined) {
      let target: string | null;
      if (state === 'queued') {
        await this.requireWorker(userId, workerId!);
        target = workerId!;
      } else {
        target = state === 'inbox' ? null : before.workerId;
      }
      const sameColumn = before.state === state && (state !== 'queued' || before.workerId === target);
      upd.state = state;
      upd.workerId = target;
      if (state === 'inbox' || target !== before.workerId) upd.sessionId = null;
      if (patch.order === undefined && !sameColumn) {
        upd.order = (await this.store.cards.maxOrder(userId, state, state === 'queued' ? target : null)) + 1;
      }
    }
    const after = await this.store.cards.update(userId, id, upd);
    if (!after) throw new CollabError('not_found', `card ${id} not found`);
    this.events.emit(userId, { type: 'card.updated', card: after });
    await this.dispatchChanged(before, after);
    return after;
  }

  async deleteCard(userId: string, id: string): Promise<void> {
    const before = await this.requireCard(userId, id);
    if (!(await this.store.cards.delete(userId, id))) throw new CollabError('not_found', `card ${id} not found`);
    this.events.emit(userId, { type: 'card.removed', cardId: id });
    await this.dispatchChanged(before, null);
  }

  // ---------- memory ----------
  private async checkMemoryScope(userId: string, scope: MemoryScope, projectId: string | null): Promise<string | null> {
    if (scope === 'global') return null;
    if (scope !== 'project') throw new CollabError('bad_request', `unknown scope: ${String(scope)}`);
    if (!projectId) throw new CollabError('bad_request', 'projectId is required for project scope');
    checkOptString('projectId', projectId);
    await this.getProject(userId, projectId);
    return projectId;
  }

  async getMemory(userId: string, scope: MemoryScope, projectId: string | null): Promise<MemoryDoc> {
    const pid = await this.checkMemoryScope(userId, scope, projectId);
    return (await this.store.memories.get(userId, scope, pid)) ?? { scope, projectId: pid, content: '', updatedAt: '' };
  }

  async putMemory(userId: string, scope: MemoryScope, projectId: string | null, content: string): Promise<MemoryDoc> {
    const pid = await this.checkMemoryScope(userId, scope, projectId);
    if (typeof content !== 'string') throw new CollabError('bad_request', 'content must be a string');
    if (Buffer.byteLength(content, 'utf8') > MEMORY_MAX_BYTES) throw new CollabError('too_large', `memory exceeds ${MEMORY_MAX_BYTES} bytes`);
    const m = await this.store.memories.put(userId, scope, pid, content);
    this.events.emit(userId, { type: 'memory.updated', memory: m });
    return m;
  }

  // ---------- settings ----------
  getSettings(userId: string): Promise<AccountSettings> {
    return this.store.settings.get(userId);
  }

  async setSettings(userId: string, s: { e2e?: boolean; autoCompact?: Partial<AutoCompactSettings> }): Promise<AccountSettings> {
    const cur = await this.store.settings.get(userId);
    // PATCH semantics: an absent field keeps its current value; present fields are validated here (the store only
    // normalizes ranges).
    if (s?.e2e !== undefined && typeof s.e2e !== 'boolean') throw new CollabError('bad_request', 'e2e must be a boolean');
    const ac = s?.autoCompact;
    if (ac !== undefined) {
      if (ac === null || typeof ac !== 'object') throw new CollabError('bad_request', 'autoCompact must be an object');
      if (ac.enabled !== undefined && typeof ac.enabled !== 'boolean') throw new CollabError('bad_request', 'autoCompact.enabled must be a boolean');
      for (const k of ['thresholdTokens', 'keepRecentTokens'] as const) {
        const v = ac[k];
        if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v))) throw new CollabError('bad_request', `autoCompact.${k} must be a number`);
      }
    }
    const next: AccountSettings = {
      e2e: s?.e2e ?? cur.e2e,
      autoCompact: { ...cur.autoCompact, ...(ac ?? {}) },
    };
    const saved = await this.store.settings.put(userId, next);
    this.events.emit(userId, { type: 'settings.updated', settings: saved });
    for (const w of await this.store.workers.listByUser(userId)) await this.hub.pushAuthz(w.workerId);
    return saved;
  }

  // ---------- sessions index / machines ----------
  async querySessions(userId: string, f: { projectId?: string; workerId?: string; q?: string; limit?: number }): Promise<SessionIndexEntry[]> {
    checkOptString('projectId', f.projectId);
    checkOptString('workerId', f.workerId);
    checkOptString('q', f.q);
    const n = f.limit === undefined || !Number.isFinite(f.limit) ? SESSION_LIMIT_DEFAULT : Math.floor(f.limit);
    const limit = Math.min(Math.max(n, 1), SESSION_LIMIT_MAX);
    return this.store.sessionIndex.query(userId, { projectId: f.projectId, workerId: f.workerId, q: f.q, limit });
  }

  async listMachines(userId: string): Promise<MachineSummary[]> {
    const running = await this.store.cards.list(userId, { state: 'running' });
    return (await this.store.workers.listByUser(userId)).map((w) => ({
      workerId: w.workerId, label: w.label, online: this.hub.isOnline(w.workerId),
      runningCards: running.filter((c) => c.workerId === w.workerId),
    }));
  }

  /** Machine unbind: queued/running/review cards → inbox, index entries + project paths of the machine removed. */
  async onMachineRemoved(userId: string, workerId: string): Promise<void> {
    let order = await this.store.cards.maxOrder(userId, 'inbox', null);
    for (const c of await this.store.cards.byWorker(workerId)) {
      if (c.state !== 'queued' && c.state !== 'running' && c.state !== 'review') continue;
      const moved = await this.store.cards.update(userId, c.id, { state: 'inbox', workerId: null, sessionId: null, order: ++order });
      if (moved) this.events.emit(userId, { type: 'card.updated', card: moved });
    }
    await this.store.sessionIndex.deleteWorker(workerId);
    const changed = await this.store.projects.removeWorkerPaths(userId, workerId);
    for (const p of changed) this.events.emit(userId, { type: 'project.updated', project: p });
    if (changed.length) await this.notifyProjectsChanged(userId);
    await this.dispatch(workerId);
  }

  // ---------- tunnel frames (WorkerFrameHandlers) ----------
  private async claimedOwner(workerId: string): Promise<string | null> {
    return (await this.store.workers.get(workerId))?.userId ?? null;
  }

  async onHello(workerId: string): Promise<void> {
    if (!(await this.claimedOwner(workerId))) return;
    await this.dispatch(workerId);
  }

  async onIndex(workerId: string, f: Extract<WorkerToSaas, { t: 'index' }>): Promise<void> {
    const userId = await this.claimedOwner(workerId);
    if (!userId) return;
    const sessions = (f.sessions ?? []).map((e) => ({ ...e, workerId }));
    const removed = f.removed ?? [];
    if (f.full) {
      await this.store.sessionIndex.replaceWorker(userId, workerId, sessions);
    } else {
      await this.store.sessionIndex.upsert(userId, sessions);
      if (removed.length) await this.store.sessionIndex.remove(workerId, removed);
    }
    this.events.emit(userId, { type: 'session.indexed', workerId, full: !!f.full, sessions, removed });
  }

  /** accept running only from this worker's queued; review from its running (or queued with an error). */
  async onCardState(workerId: string, f: Extract<WorkerToSaas, { t: 'card.state' }>): Promise<void> {
    const userId = await this.claimedOwner(workerId);
    if (!userId) return;
    const before = await this.store.cards.get(userId, f.cardId);
    if (!before || before.workerId !== workerId) return;
    let upd: Parameters<SaasStore['cards']['update']>[2];
    if (f.state === 'running' && before.state === 'queued') {
      upd = { state: 'running', sessionId: f.sessionId ?? null, error: null };
    } else if (f.state === 'review' && (before.state === 'running' || (before.state === 'queued' && f.error))) {
      upd = { state: 'review' };
      if (f.sessionId) upd.sessionId = f.sessionId;
      if (f.error) upd.error = f.error;
    } else {
      return;
    }
    upd.order = (await this.store.cards.maxOrder(userId, f.state, null)) + 1;
    const after = await this.store.cards.update(userId, f.cardId, upd);
    if (!after) return;
    this.events.emit(userId, { type: 'card.updated', card: after });
    await this.dispatchChanged(before, after);
  }

  async onTool(workerId: string, f: Extract<WorkerToSaas, { t: 'tool' }>): Promise<ToolOutcome> {
    const userId = await this.claimedOwner(workerId);
    if (!userId) return { ok: false, error: { code: 'forbidden', message: 'machine is not claimed' } };
    return executeTool(this, { userId, workerId }, f.name, f.args);
  }
}
