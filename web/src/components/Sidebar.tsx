import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { engine, useEngine } from '../engine';
import { NO_PROJECT, SessionList, type SessionFilter } from './SessionList';
import { NewSessionDialog } from './NewSessionDialog';
import { QuickAdd } from './QuickAdd';
import { Popover } from './Popover';
import { Icon, type IconName } from './Icons';
import { useResizable } from '../lib/useResizable';
import { pickProjectTarget } from '@nopear/core';

const row = 'flex h-8 w-full items-center gap-2.5 rounded-lg px-2 text-[13.5px] text-ink/85 transition-colors hover:bg-hover';
const rowActive = 'bg-active text-ink';

function NavRow({ to, icon, label, exact }: { to: '/board' | '/projects' | '/memory' | '/machines'; icon: IconName; label: string; exact?: boolean }) {
  return (
    <Link to={to} className={row} activeProps={{ className: rowActive }} activeOptions={exact ? { exact: true } : undefined}>
      <Icon name={icon} size={16} className="text-subtle" />{label}
    </Link>
  );
}

const FILTER_LABEL: Record<SessionFilter, string> = { all: '全部', starred: '星标', archived: '归档' };

function FilterMenu({ filter, setFilter, project, setProject }: {
  filter: SessionFilter; setFilter: (f: SessionFilter) => void; project: string; setProject: (p: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const projects = useEngine((s) => s.projects);
  const projectList = useMemo(() => Object.values(projects).sort((a, b) => a.name.localeCompare(b.name)), [projects]);
  const active = filter !== 'all' || project !== '';
  return (
    <Popover open={open} onClose={() => setOpen(false)} className="right-0 w-56 space-y-2"
      trigger={
        <button className={`btn-icon relative h-8 w-8 ${active ? 'bg-active text-ink' : ''}`} title="筛选会话" aria-label="筛选会话" aria-expanded={open}
          onClick={() => setOpen(!open)}>
          <Icon name="filter" size={15} />
          {active && <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-accent" />}
        </button>
      }>
      <div className="flex gap-1 rounded-lg bg-side p-0.5" role="group" aria-label="会话状态">
        {(Object.keys(FILTER_LABEL) as SessionFilter[]).map((f) => (
          <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}
            className={`flex-1 rounded-md px-2 py-1 text-xs ${filter === f ? 'bg-elev text-ink shadow-sm' : 'text-subtle hover:text-ink'}`}>{FILTER_LABEL[f]}</button>
        ))}
      </div>
      <select className="input h-8 py-0 text-xs" title="按项目筛选" value={project} onChange={(e) => setProject(e.target.value)}>
        <option value="">全部项目</option>
        <option value={NO_PROJECT}>无项目</option>
        {projectList.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      {active && <button className="btn-ghost w-full justify-center py-1 text-xs" onClick={() => { setFilter('all'); setProject(''); }}>清除筛选</button>}
    </Popover>
  );
}

function initials(email: string | undefined): string {
  const name = (email ?? '').split('@')[0] ?? '';
  const parts = name.split(/[._\-+]/).filter(Boolean);
  const s = parts.length >= 2 ? parts[0]![0]! + parts[1]![0]! : name.slice(0, 2);
  return (s || '?').toUpperCase();
}

function Account() {
  const user = useEngine((s) => s.user);
  const machines = useEngine((s) => s.machines);
  const conn = useEngine((s) => s.machineConn);
  const syncing = useEngine((s) => s.syncing);
  const navigate = useNavigate();
  const all = Object.values(machines);
  const online = all.filter((m) => m.online && conn[m.workerId] !== 'offline').length;
  return (
    <div className="panel flex items-center gap-2 border-t px-2 py-2">
      <div className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-ink text-[11px] font-semibold text-app" aria-hidden="true">{initials(user?.email)}</div>
      <div className="min-w-0 flex-1 leading-tight">
        <div className="truncate text-[13px]" title={user?.email}>{user?.email ?? '…'}</div>
        <Link to="/machines" className="inline-flex items-center gap-1 text-[11px] text-subtle hover:text-ink" title={`共 ${all.length} 台机器`}>
          <span className={`h-1.5 w-1.5 rounded-full ${online > 0 ? 'bg-emerald-500' : 'bg-line-strong'}`} />{syncing ? '同步中…' : `${online} 台在线`}
        </Link>
      </div>
      <Link to="/settings" className="btn-icon" title="设置" aria-label="设置" activeProps={{ className: 'bg-active text-ink' }}><Icon name="settings" size={16} /></Link>
      <button className="btn-icon" title="退出登录" aria-label="退出登录"
        onClick={() => { void engine.logout().then(() => navigate({ to: '/login', search: { redirect: undefined } })); }}>
        <Icon name="logout" size={16} />
      </button>
    </div>
  );
}

export function Sidebar() {
  const [filter, setFilter] = useState<SessionFilter>('all');
  const [project, setProject] = useState('');
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState<null | { workerId?: string; projectId?: string }>(null);
  const [quick, setQuick] = useState(false);
  const params = useParams({ strict: false }) as { workerId?: string };
  const { width, handleProps } = useResizable({ storageKey: 'nopear.sidebarWidth', min: 200, max: 480, defaultWidth: 288 });

  const newInProject = (projectId: string, recent: string[]) => {
    const st = engine.store.getState();
    const p = st.projects[projectId];
    const online = new Set(Object.values(st.machines).filter((m) => m.online && st.machineConn[m.workerId] !== 'offline').map((m) => m.workerId));
    const target = p ? pickProjectTarget(p, { current: params.workerId, recent, online }) : {};
    setCreating({ projectId, ...(target.workerId ? { workerId: target.workerId } : {}) });
  };

  return (
    <aside className="surface panel relative flex shrink-0 flex-col border-r" style={{ width }}>
      <div {...handleProps} role="separator" aria-orientation="vertical" aria-label="调整侧栏宽度" title="拖动调整宽度，双击恢复默认"
        className="group absolute inset-y-0 -right-1.5 z-10 w-3 cursor-col-resize touch-none select-none">
        <div className="mx-auto h-full w-0.5 transition-colors group-hover:bg-line-strong group-active:bg-subtle" />
      </div>
      <div className="flex items-center gap-2 px-3 pb-2 pt-3">
        <Link to="/" className="flex min-w-0 items-center gap-2 rounded-md" title="全部会话">
          <span className="grid h-6 w-6 place-items-center rounded-md bg-accent text-[11px] font-bold text-white">F</span>
          <span className="truncate text-[14px] font-semibold">NoPear</span>
        </Link>
      </div>
      <nav className="space-y-px px-2" aria-label="主导航">
        <button className={row} onClick={() => setCreating({})}><Icon name="plus" size={16} className="text-subtle" />新会话</button>
        <Popover open={quick} onClose={() => setQuick(false)} className="left-0 w-[380px]"
          trigger={
            <button className={`${row} ${quick ? rowActive : ''}`} aria-expanded={quick} onClick={() => setQuick(!quick)}>
              <Icon name="inbox" size={16} className="text-subtle" />快速记一条
            </button>
          }>
          <QuickAdd autoFocus />
        </Popover>
        <NavRow to="/board" icon="board" label="看板" />
        <NavRow to="/projects" icon="folder" label="项目" />
        <NavRow to="/memory" icon="book" label="记忆" exact />
        <NavRow to="/machines" icon="server" label="机器" />
      </nav>
      <div className="flex items-center gap-1 px-2 pb-1 pt-3">
        <label className="relative min-w-0 flex-1">
          <Icon name="search" size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
          <input className="input h-8 bg-transparent py-0 pl-8 text-[13px]" type="search" placeholder="搜索会话" aria-label="搜索会话"
            value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }} />
        </label>
        <FilterMenu filter={filter} setFilter={setFilter} project={project} setProject={setProject} />
      </div>
      {filter !== 'all' && (
        <div className="px-4 pt-1 text-[11px] text-subtle">只看{FILTER_LABEL[filter]}</div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <SessionList filter={filter} project={project} query={query} onNewInProject={newInProject} />
      </div>
      <Account />
      {creating && <NewSessionDialog initial={creating} onClose={() => setCreating(null)} />}
    </aside>
  );
}
