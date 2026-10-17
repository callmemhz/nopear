// Sidebar / drawer session list model (shared by web and mobile): filter (all / starred / archived + project + search) and group by project.
import type { Project, Session } from '@nopear/protocol';

export type SessionFilter = 'all' | 'starred' | 'archived';
/** Group / project-filter id for sessions without a (known) project. */
export const UNGROUPED = '__none__';

export interface SessionGroup { id: string; name: string; sessions: Session[]; lastActivityAt: string }

export function matchesSearch(s: Session, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (s.title ?? '').toLowerCase().includes(q) || (s.preview ?? '').toLowerCase().includes(q);
}

/** Sessions passing the status filter and project filter ('' any, UNGROUPED untagged, else a project id), newest first. */
export function filterSessions(all: Session[], filter: SessionFilter, project = ''): Session[] {
  const list = all.filter((s) => (filter === 'archived' ? s.archived : !s.archived && (filter !== 'starred' || s.starred))
    && (project === '' || (project === UNGROUPED ? !s.projectId : s.projectId === project)));
  return list.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
}

/**
 * Pinned sessions (not in archived view) get their own section; the rest are grouped one group per project, ordered by
 * the group's most recent activity; untagged sessions (or tagged with a project that no longer exists) go to 「未分类」, last.
 */
export function groupSessions(all: Session[], projects: Record<string, Project>, o: { filter: SessionFilter; project: string; query: string }) {
  const list = filterSessions(all, o.filter, o.project).filter((s) => matchesSearch(s, o.query));
  const pinned = o.filter === 'archived' ? [] : list.filter((s) => s.pinned);
  const rest = o.filter === 'archived' ? list : list.filter((s) => !s.pinned);
  const byId = new Map<string, SessionGroup>();
  for (const s of rest) { // already newest first, so each group's first session sets its lastActivityAt
    const p = s.projectId ? projects[s.projectId] : undefined;
    const id = p ? p.id : UNGROUPED;
    let g = byId.get(id);
    if (!g) { g = { id, name: p ? p.name : '未分类', sessions: [], lastActivityAt: s.lastActivityAt }; byId.set(id, g); }
    g.sessions.push(s);
  }
  const groups = [...byId.values()].sort((a, b) =>
    a.id === UNGROUPED ? 1 : b.id === UNGROUPED ? -1 : b.lastActivityAt.localeCompare(a.lastActivityAt));
  return { pinned, groups };
}

/** Minimal synchronous storage (localStorage-like). */
export interface SyncStorage { getItem(k: string): string | null; setItem(k: string, v: string): void }

/** Collapsed group ids from their persisted JSON form (garbage → empty set). */
export function parseCollapsed(raw: string | null | undefined): Set<string> {
  try {
    const v: unknown = JSON.parse(raw ?? '[]');
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}
export const serializeCollapsed = (ids: Set<string>): string => JSON.stringify([...ids]);
/** A new set with `id` toggled. */
export function toggleCollapsed(ids: Set<string>, id: string): Set<string> {
  const next = new Set(ids);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}

export function loadCollapsed(storage: Pick<SyncStorage, 'getItem'> | undefined, key: string): Set<string> {
  try {
    return parseCollapsed(storage?.getItem(key));
  } catch {
    return new Set();
  }
}
export function saveCollapsed(storage: Pick<SyncStorage, 'setItem'> | undefined, key: string, ids: Set<string>): void {
  try { storage?.setItem(key, serializeCollapsed(ids)); } catch { /* not remembered */ }
}

/** The most recently active non-archived session (the mobile app's default screen), or null. */
export function latestSession<S extends Pick<Session, 'archived' | 'lastActivityAt'>>(all: Iterable<S>): S | null {
  let best: S | null = null;
  for (const s of all) if (!s.archived && (!best || s.lastActivityAt > best.lastActivityAt)) best = s;
  return best;
}

/**
 * Machine + cwd for a new session in a project: the open session's machine, else the machine of the group's most recent
 * sessions, else any online machine — whichever is online and has a path for the project.
 */
export function pickProjectTarget(p: Project, o: { current?: string; recent: string[]; online: Set<string> }): { workerId?: string; cwd?: string } {
  const candidates = [...(o.current ? [o.current] : []), ...o.recent, ...Object.keys(p.paths)];
  const w = candidates.find((id) => o.online.has(id) && p.paths[id]);
  return w ? { workerId: w, cwd: p.paths[w]! } : {};
}
