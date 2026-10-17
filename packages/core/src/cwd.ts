// Working-directory suggestions for the "new session" dialogs (web + mobile): pure, derived from engine state.
import type { Project, Session, SessionIndexEntry } from '@nopear/protocol';

export interface CwdSuggestion { path: string; label?: string; kind: 'project' | 'recent' }
export interface CwdSourceState {
  projects: Record<string, Project>;
  sessions: Record<string, Record<string, Session>>;
  sessionIndex?: Record<string, SessionIndexEntry>;
}

/** Project paths on this machine first (label = project name, sorted by name), then distinct cwds of this machine's
 *  sessions (engine sessions + session index), most recently active first. De-duplicated; at most `limit` entries. */
export function recentCwds(state: CwdSourceState, workerId: string, limit = 8): CwdSuggestion[] {
  const out: CwdSuggestion[] = [];
  const seen = new Set<string>();
  const projects = Object.values(state.projects)
    .filter((p) => typeof p.paths?.[workerId] === 'string' && p.paths[workerId] !== '')
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const p of projects) {
    const path = p.paths[workerId]!;
    if (seen.has(path)) continue;
    seen.add(path);
    out.push({ path, label: p.name, kind: 'project' });
  }
  const recent: Array<{ cwd: string; at: string }> = [];
  for (const s of Object.values(state.sessions[workerId] ?? {})) recent.push({ cwd: s.cwd, at: s.lastActivityAt });
  for (const e of Object.values(state.sessionIndex ?? {})) if (e.workerId === workerId) recent.push({ cwd: e.cwd, at: e.lastActivityAt });
  recent.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  for (const r of recent) {
    if (!r.cwd || seen.has(r.cwd)) continue;
    seen.add(r.cwd);
    out.push({ path: r.cwd, kind: 'recent' });
  }
  return out.slice(0, Math.max(0, limit));
}

/** Parent of an absolute POSIX path (`/a/b` → `/a`, `/` → `/`). Used by the folder browsers' 「上一级」. */
export function parentDir(path: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path;
  const i = trimmed.lastIndexOf('/');
  return i <= 0 ? '/' : trimmed.slice(0, i);
}

/** Breadcrumb segments of an absolute POSIX path: `/a/b` → [{name:'/',path:'/'},{name:'a',path:'/a'},{name:'b',path:'/a/b'}]. */
export function pathCrumbs(path: string): Array<{ name: string; path: string }> {
  const parts = path.split('/').filter(Boolean);
  const crumbs = [{ name: '/', path: '/' }];
  let acc = '';
  for (const p of parts) { acc += `/${p}`; crumbs.push({ name: p, path: acc }); }
  return crumbs;
}

/** Join a directory and a child name (no normalization beyond the root case). */
export function joinDir(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

/** What a session-list row shows to say where a session lives: its project (if tagged and known), else the cwd's
 *  basename (full path as `title`), else nothing (no cwd, `/`, or the machine's home dir). */
export type SessionPlaceLabel = { kind: 'project'; text: string } | { kind: 'dir'; text: string; title: string };

const HOME_RE = /^\/(?:Users|home)\/[^/]+$/;

/** `homeDir` = the machine's home (callers pass `workerInfo.defaultCwd`, which defaults to the worker's home dir);
 *  `/Users/<x>` and `/home/<x>` are always treated as home too. */
export function sessionPlaceLabel(
  session: Pick<Session, 'projectId' | 'cwd'>,
  projects: Record<string, Pick<Project, 'name'>>,
  homeDir?: string,
): SessionPlaceLabel | null {
  const project = session.projectId ? projects[session.projectId] : undefined;
  if (project) return { kind: 'project', text: project.name };
  const cwd = (session.cwd ?? '').replace(/\/+$/, '');
  if (!cwd) return null; // '' or '/'
  const home = homeDir?.replace(/\/+$/, '');
  if ((home && cwd === home) || HOME_RE.test(cwd)) return null;
  const text = cwd.slice(cwd.lastIndexOf('/') + 1);
  return text ? { kind: 'dir', text, title: session.cwd } : null;
}
