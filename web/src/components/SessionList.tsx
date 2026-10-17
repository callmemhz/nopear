import { useCallback, useMemo, useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import type { Session } from '@nopear/protocol';
import { engine, useEngine } from '../engine';
import { relativeTime } from '../lib/format';
import { filterSessions, groupSessions, loadCollapsed, saveCollapsed, sessionPlaceLabel, UNGROUPED, type SessionFilter } from '@nopear/core';
import { reportError } from '../routes/root';
import { Icon } from './Icons';

export type { SessionFilter } from '@nopear/core';
/** Project filter values: '' = any project, NO_PROJECT = untagged sessions, else a project id. */
export const NO_PROJECT = UNGROUPED;
const COLLAPSED_KEY = 'nopear.sidebarCollapsed';

export function StatusDot({ status, className = '' }: { status: Session['status']; className?: string }) {
  const c = status === 'running' ? 'bg-emerald-500 animate-pulse' : status === 'error' ? 'bg-red-500' : 'border border-line-strong';
  return <span aria-label={status === 'running' ? '运行中' : status === 'error' ? '出错' : '空闲'} className={`inline-block h-2 w-2 shrink-0 rounded-full ${c} ${className}`} />;
}

/** Flat filtered list split into pinned / rest (home page). */
export function useSessionList(filter: SessionFilter, project = '') {
  const sessions = useEngine((s) => s.sessions);
  const list = filterSessions(Object.values(sessions).flatMap((m) => Object.values(m)), filter, project);
  return { pinned: list.filter((s) => s.pinned && filter !== 'archived'), rest: list.filter((s) => !s.pinned || filter === 'archived') };
}

const ls = (): Storage | undefined => (typeof localStorage === 'undefined' ? undefined : localStorage);
/** Collapsed sidebar groups, persisted in localStorage. */
export function useCollapsedGroups() {
  const [collapsed, setCollapsed] = useState(() => loadCollapsed(ls(), COLLAPSED_KEY));
  const toggle = useCallback((id: string) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    saveCollapsed(ls(), COLLAPSED_KEY, next);
    return next;
  }), []);
  return { collapsed, toggle };
}

const actionBtn = 'grid h-6 w-6 place-items-center rounded-md text-subtle hover:bg-active hover:text-ink';

function Row({ s, multi, showPlace }: { s: Session; multi: boolean; showPlace: boolean }) {
  const params = useParams({ strict: false }) as { sessionId?: string; workerId?: string };
  const label = useEngine((st) => st.machines[s.workerId]?.label ?? s.workerId);
  const projects = useEngine((st) => st.projects);
  const homeDir = useEngine((st) => st.workerInfo[s.workerId]?.defaultCwd);
  const place = sessionPlaceLabel(s, projects, homeDir);
  const active = params.sessionId === s.id && (params.workerId === undefined || params.workerId === s.workerId);
  const toggle = (patch: { pinned?: boolean; starred?: boolean; archived?: boolean }) => (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    engine.updateSession(s.workerId, s.id, patch).catch(reportError);
  };
  const tip = [s.title || '未命名会话', [multi ? label : '', s.preview].filter(Boolean).join(' · ')].filter(Boolean).join('\n');
  return (
    <Link
      to="/s/$workerId/$sessionId"
      params={{ workerId: s.workerId, sessionId: s.id }}
      title={tip}
      aria-current={active ? 'page' : undefined}
      className={`group/row relative flex h-8 items-center gap-2 rounded-lg px-2 text-[13.5px] transition-colors ${active ? 'bg-active text-ink' : 'text-ink/85 hover:bg-hover'}`}
    >
      <StatusDot status={s.status} />
      <span className="min-w-0 flex-1 truncate">{s.title || '未命名会话'}</span>
      {place && (showPlace || place.kind === 'dir') && (
        place.kind === 'project'
          ? <span className="chip max-w-24 truncate" title="项目">{place.text}</span>
          : <span className="max-w-20 truncate text-[11px] text-faint" title={place.title}>{place.text}</span>
      )}
      {multi && <span className="max-w-16 shrink-0 truncate text-[11px] text-faint" title="机器">{label}</span>}
      {s.promptCount > 0 && <span className="chip bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">待答 {s.promptCount}</span>}
      {s.starred && <Icon name="star" size={12} className="fill-amber-400 text-amber-400 group-hover/row:hidden" />}
      <span className="shrink-0 text-[11px] text-faint group-focus-within/row:hidden group-hover/row:hidden">{relativeTime(s.lastActivityAt)}</span>
      <span className="hidden shrink-0 items-center group-focus-within/row:flex group-hover/row:flex">
        <button title={s.pinned ? '取消置顶' : '置顶'} aria-label={s.pinned ? '取消置顶' : '置顶'} className={actionBtn} onClick={toggle({ pinned: !s.pinned })}>
          <Icon name="pin" size={13} className={s.pinned ? 'fill-current' : ''} />
        </button>
        <button title={s.starred ? '取消星标' : '星标'} aria-label={s.starred ? '取消星标' : '星标'} className={actionBtn} onClick={toggle({ starred: !s.starred })}>
          <Icon name="star" size={13} className={s.starred ? 'fill-amber-400 text-amber-400' : ''} />
        </button>
        <button title={s.archived ? '取消归档' : '归档'} aria-label={s.archived ? '取消归档' : '归档'} className={actionBtn} onClick={toggle({ archived: !s.archived })}>
          <Icon name={s.archived ? 'unarchive' : 'archive'} size={13} />
        </button>
      </span>
    </Link>
  );
}

function SectionHeader({ name, count, collapsed, onToggle, onNew }: {
  name: string; count?: number; collapsed?: boolean; onToggle?: () => void; onNew?: () => void;
}) {
  const label = (
    <>
      {onToggle && <Icon name="chevronRight" size={12} className={`transition-transform ${collapsed ? '' : 'rotate-90'}`} />}
      <span className="truncate">{name}</span>
      {count !== undefined && <span className="font-normal text-faint">{count}</span>}
    </>
  );
  return (
    <div className="group/hdr flex h-7 items-center gap-1 pl-2 pr-1 pt-2">
      {onToggle ? (
        <button className="flex min-w-0 flex-1 items-center gap-1 text-left text-[12px] font-medium text-subtle hover:text-ink"
          aria-expanded={!collapsed} title={collapsed ? '展开' : '折叠'} onClick={onToggle}>{label}</button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-1 text-[12px] font-medium text-subtle">{label}</div>
      )}
      {onNew && (
        <button className="grid h-6 w-6 place-items-center rounded-md text-subtle opacity-0 hover:bg-hover hover:text-ink focus:opacity-100 group-hover/hdr:opacity-100"
          title={`在「${name}」新建会话`} aria-label={`在「${name}」新建会话`} onClick={onNew}>
          <Icon name="plus" size={14} />
        </button>
      )}
    </div>
  );
}

/** Sidebar sessions: 「置顶」, then one collapsible group per project (most recent first), 「未分类」 last. */
export function SessionList({ filter, project = '', query = '', onNewInProject }: {
  filter: SessionFilter; project?: string; query?: string; onNewInProject?: (projectId: string, recentWorkers: string[]) => void;
}) {
  const sessions = useEngine((s) => s.sessions);
  const projects = useEngine((s) => s.projects);
  const multi = useEngine((s) => Object.keys(s.machines).length > 1);
  const { collapsed, toggle } = useCollapsedGroups();
  const { pinned, groups } = useMemo(
    () => groupSessions(Object.values(sessions).flatMap((m) => Object.values(m)), projects, { filter, project, query }),
    [sessions, projects, filter, project, query]);
  const searching = query.trim() !== '';
  if (pinned.length + groups.length === 0) {
    return <p className="muted px-3 py-6 text-center text-xs">{searching ? '没有匹配的会话' : filter === 'archived' ? '没有归档的会话' : filter === 'starred' ? '没有星标会话' : '还没有会话'}</p>;
  }
  return (
    <div>
      {pinned.length > 0 && (
        <section>
          <SectionHeader name="置顶" />
          {pinned.map((s) => <Row key={s.workerId + s.id} s={s} multi={multi} showPlace />)}
        </section>
      )}
      {groups.map((g) => {
        const shut = !searching && collapsed.has(g.id);
        const onNew = onNewInProject && g.id !== UNGROUPED
          ? () => onNewInProject(g.id, [...new Set(g.sessions.map((s) => s.workerId))]) : undefined;
        return (
          <section key={g.id} data-testid="session-group" data-group={g.id}>
            <SectionHeader name={g.name} count={g.sessions.length} collapsed={shut} onToggle={() => toggle(g.id)} onNew={onNew} />
            {!shut && g.sessions.map((s) => <Row key={s.workerId + s.id} s={s} multi={multi} showPlace={false} />)}
          </section>
        );
      })}
    </div>
  );
}
