// Local collaboration cache: the account's project list (for cwd auto-tagging and card paths) and
// global / project memories (for the synchronous systemPromptAppend hook). Filled via SaaS tools over the tunnel;
// memory entries go stale after ttlMs — a stale read returns the old value and refreshes in the background.
import { memoryKey, type MemoryDoc, type MemoryScope, type Project, type ToolName } from '@nopear/protocol';
import type { CollabLink } from './link';

const TTL_MS = 30_000;

interface MemEntry { content: string; at: number }

export class CollabCache {
  private projects = new Map<string, Project>();
  /** A project_list has been applied since construction / the last reset(): the project list is known. */
  private loaded = false;
  private memories = new Map<string, MemEntry>();
  private inflight = new Map<string, Promise<void>>();
  /** Bumped by reset(): replies to requests started before it (e.g. the previous owner's) are dropped. */
  private epoch = 0;
  /** Latest project_list request; an older reply arriving after a newer one is not applied. */
  private projectSeq = 0;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(private readonly o: { link: () => CollabLink | undefined; workerId: string; ttlMs?: number; now?: () => number }) {
    this.ttlMs = o.ttlMs ?? TTL_MS;
    this.now = o.now ?? Date.now;
  }

  /** Re-fetches project_list and returns the new id set. Returns null — keeping the cached list — on failure, a
   *  malformed result, or when superseded (a newer refresh or a reset() started meanwhile). */
  async refreshProjects(): Promise<Set<string> | null> {
    const seq = ++this.projectSeq;
    const epoch = this.epoch;
    const result = await this.call('project_list', {});
    if (result === undefined || seq !== this.projectSeq || epoch !== this.epoch) return null;
    const list = (result as { projects?: unknown } | null)?.projects;
    if (!Array.isArray(list) || !list.every(isProject)) {
      console.warn('[nopear] collab: malformed project_list result; keeping the cached projects');
      return null;
    }
    this.projects = new Map(list.map((p) => [p.id, p]));
    this.loaded = true;
    return this.projectIds();
  }

  /** Claim changed (claimed by / unbound from an account): drop projects + memories; in-flight replies are ignored. */
  reset(): void {
    this.epoch++;
    this.projectSeq++;
    this.projects = new Map();
    this.loaded = false;
    this.memories = new Map();
    this.inflight = new Map();
  }

  /** False until the first successful refreshProjects() (and again after reset()): an empty cache then means
   *  "unknown", not "no projects" — card paths must not be judged missing yet. */
  projectsLoaded(): boolean {
    return this.loaded;
  }

  projectIds(): Set<string> {
    return new Set(this.projects.keys());
  }

  projectPath(id: string): string | undefined {
    return this.projects.get(id)?.paths[this.o.workerId];
  }

  projectName(id: string): string | undefined {
    return this.projects.get(id)?.name;
  }

  /** D6: project whose local path is cwd or an ancestor of it (path-separator boundary); longest path wins. */
  matchProject(cwd: string): string | undefined {
    let best: { id: string; len: number } | undefined;
    for (const p of this.projects.values()) {
      const raw = p.paths[this.o.workerId];
      if (!raw) continue;
      const base = raw.length > 1 ? raw.replace(/\/+$/, '') : raw;
      const hit = cwd === base || cwd.startsWith(base.endsWith('/') ? base : `${base}/`);
      if (hit && (!best || base.length > best.len)) best = { id: p.id, len: base.length };
    }
    return best?.id;
  }

  /** Fetches one memory doc into the cache (concurrent calls share one request; failures keep the old value). */
  prefetchMemory(scope: MemoryScope, projectId: string | null): Promise<void> {
    const key = memoryKey(scope, projectId);
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const epoch = this.epoch;
    const inflight = this.inflight;
    const p = (async () => {
      const args: Record<string, unknown> = scope === 'global' ? { scope } : { scope, projectId };
      const result = await this.call('memory_get', args);
      if (result === undefined || epoch !== this.epoch) return;
      const doc = (result as { memory?: unknown } | null)?.memory;
      if (isMemoryDoc(doc)) this.memories.set(key, { content: doc.content, at: this.now() });
      else console.warn(`[nopear] collab: malformed memory_get result for ${key}; keeping the cached value`);
    })().finally(() => { if (inflight.get(key) === p) inflight.delete(key); });
    inflight.set(key, p);
    return p;
  }

  /** Sync hook: "# 用户全局记忆" (+ "# 项目记忆（<name>）" when tagged) from the local cache; empty sections omitted. */
  systemPromptAppend(meta: { projectId?: string }): string | undefined {
    const parts: string[] = [];
    const g = this.read('global', null);
    if (g?.trim()) parts.push(`# 用户全局记忆\n\n${g}`);
    if (meta.projectId) {
      const p = this.read('project', meta.projectId);
      if (p?.trim()) parts.push(`# 项目记忆（${this.projectName(meta.projectId) ?? meta.projectId}）\n\n${p}`);
    }
    return parts.length ? parts.join('\n\n') : undefined;
  }

  private read(scope: MemoryScope, projectId: string | null): string | undefined {
    const e = this.memories.get(memoryKey(scope, projectId));
    if (!e || this.now() - e.at >= this.ttlMs) void this.prefetchMemory(scope, projectId);
    return e?.content;
  }

  /** Tool result, or undefined (logged) when unreachable / failed. */
  private async call(name: ToolName, args: Record<string, unknown>): Promise<unknown> {
    const link = this.o.link();
    if (!link) return undefined;
    try {
      const out = await link.callTool(name, args);
      if (out.ok) return out.result;
      console.warn(`[nopear] collab: ${name} failed: ${out.error.code} ${out.error.message}`);
    } catch (e) {
      console.warn(`[nopear] collab: ${name} failed: ${(e as Error).message}`);
    }
    return undefined;
  }
}

function isProject(v: unknown): v is Project {
  const p = v as Project | null;
  return !!p && typeof p === 'object' && typeof p.id === 'string' && typeof p.name === 'string'
    && !!p.paths && typeof p.paths === 'object';
}

function isMemoryDoc(v: unknown): v is MemoryDoc {
  return !!v && typeof v === 'object' && typeof (v as MemoryDoc).content === 'string';
}
