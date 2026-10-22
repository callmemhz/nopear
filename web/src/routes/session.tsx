import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { activeTaskCount, emptyTimeline } from '@nopear/core';
import { sessionKey, type Session } from '@nopear/protocol';
import { engine, useEngine } from '../engine';
import { MessageList } from '../components/MessageList';
import { BtwPanel } from '../components/BtwPanel';
import { Composer } from '../components/Composer';
import { AskCard } from '../components/AskCard';
import { SidePanel, type SidePanelTab } from '../components/SidePanel';
import { ModelPicker } from '../components/ModelPicker';
import { StatusDot } from '../components/SessionList';
import { Icon, type IconName } from '../components/Icons';
import { Popover } from '../components/Popover';
import { reportError } from './root';

const EMPTY = emptyTimeline();

/** Project tag picker styled as a chip (sessions.update projectId; '' clears the tag). */
function ProjectTag({ workerId, sessionId, projectId }: { workerId: string; sessionId: string; projectId: string | null }) {
  const projects = useEngine((s) => s.projects);
  const list = useMemo(() => Object.values(projects).sort((a, b) => a.name.localeCompare(b.name)), [projects]);
  const stale = projectId !== null && !projects[projectId];
  return (
    <span className="relative inline-flex shrink-0 items-center">
      <Icon name="folder" size={12} className="pointer-events-none absolute left-2 text-subtle" />
      <select className="h-6 max-w-40 cursor-pointer appearance-none truncate rounded-md bg-active py-0 pl-6 pr-5 text-[12px] font-medium text-subtle outline-none hover:text-ink"
        title="项目标签" aria-label="项目标签" value={projectId ?? ''}
        onChange={(e) => engine.updateSession(workerId, sessionId, { projectId: e.target.value || null }).catch(reportError)}>
        <option value="">无项目</option>
        {stale && <option value={projectId}>{projectId}</option>}
        {list.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <Icon name="chevronDown" size={12} className="pointer-events-none absolute right-1.5 text-subtle" />
    </span>
  );
}

function MenuItem({ icon, label, onClick, title }: { icon: IconName; label: string; onClick: () => void; title?: string }) {
  return (
    <button role="menuitem" className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-hover" title={title} onClick={onClick}>
      <Icon name={icon} size={15} className="text-subtle" />{label}
    </button>
  );
}

/** 「更多」: pin / star / archive / fork / machine memory, plus the working directory. */
function MoreMenu({ session, workerId, onFork }: { session: Session | undefined; workerId: string; onFork: () => void }) {
  const [open, setOpen] = useState(false);
  const update = (patch: { pinned?: boolean; starred?: boolean; archived?: boolean }) => {
    setOpen(false);
    if (session) engine.updateSession(workerId, session.id, patch).catch(reportError);
  };
  return (
    <Popover open={open} onClose={() => setOpen(false)} className="right-0 w-56"
      trigger={
        <button className={`btn-icon ${open ? 'bg-active text-ink' : ''}`} title="更多" aria-label="更多" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name="more" size={18} />
        </button>
      }>
      <div role="menu">
        {session?.cwd && <div className="truncate px-2 pb-1.5 pt-0.5 font-mono text-[11px] text-faint" title={session.cwd}>{session.cwd}</div>}
        {session && (
          <>
            <MenuItem icon="pin" label={session.pinned ? '取消置顶' : '置顶'} onClick={() => update({ pinned: !session.pinned })} />
            <MenuItem icon="star" label={session.starred ? '取消星标' : '星标'} onClick={() => update({ starred: !session.starred })} />
            <MenuItem icon={session.archived ? 'unarchive' : 'archive'} label={session.archived ? '取消归档' : '归档'} onClick={() => update({ archived: !session.archived })} />
          </>
        )}
        <MenuItem icon="fork" label="分叉" title="从当前末尾分叉出新会话" onClick={() => { setOpen(false); onFork(); }} />
        <Link role="menuitem" to="/memory/$workerId" params={{ workerId }} title="编辑这台机器的 AGENTS.md 记忆"
          className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] hover:bg-hover">
          <Icon name="book" size={15} className="text-subtle" />机器记忆
        </Link>
      </div>
    </Popover>
  );
}

export function SessionPage() {
  const { workerId, sessionId } = useParams({ strict: false }) as { workerId: string; sessionId: string };
  // Key the whole subtree by session so local UI state (attachments, steer, rename, file path…) never leaks across sessions.
  return <SessionView key={sessionKey(workerId, sessionId)} workerId={workerId} sessionId={sessionId} />;
}

function SessionView({ workerId, sessionId }: { workerId: string; sessionId: string }) {
  const key = sessionKey(workerId, sessionId);
  const timeline = useEngine((s) => s.timelines[key]) ?? EMPTY;
  const listed = useEngine((s) => s.sessions[workerId]?.[sessionId]);
  const machine = useEngine((s) => s.machines[workerId]);
  const conn = useEngine((s) => s.machineConn[workerId]);
  const session = timeline.session ?? listed;
  const navigate = useNavigate();
  const [panel, setPanel] = useState<SidePanelTab | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  useEffect(() => {
    engine.openSession(workerId, sessionId);
    return () => engine.closeSession(workerId, sessionId);
  }, [workerId, sessionId]);
  useEffect(() => { if ((session?.taskCount ?? 0) > 0) setPanel((p) => p ?? 'tasks'); }, [session?.taskCount]);

  const offline = !machine?.online || conn === 'offline';
  const running = session?.status === 'running';
  // Stable callbacks so memo(MessageItem) actually skips unchanged items; `running` is read from the store at call time.
  const onRewind = useCallback((messageId: string) => {
    const st = engine.store.getState();
    const cur = st.timelines[key]?.session ?? st.sessions[workerId]?.[sessionId];
    if (cur?.status === 'running') { reportError(new Error('运行中不能撤回，请先中断')); return; }
    engine.rewind(workerId, sessionId, messageId).then((text) => engine.setDraft(workerId, sessionId, text), reportError);
  }, [key, workerId, sessionId]);
  const onFork = useCallback((messageId?: string) => {
    engine.fork(workerId, sessionId, messageId).then(
      (s) => navigate({ to: '/s/$workerId/$sessionId', params: { workerId, sessionId: s.id } }), reportError);
  }, [workerId, sessionId, navigate]);
  const actions = useMemo(() => ({
    onRewind,
    onFork,
    onRetry: (cid: string) => { engine.retrySend(workerId, sessionId, cid).catch(reportError); },
    onReedit: (cid: string) => { engine.setDraft(workerId, sessionId, engine.discardSend(workerId, sessionId, cid)); },
  }), [onRewind, onFork, workerId, sessionId]);
  const rename = () => {
    const typed = renaming?.trim();
    setRenaming(null);
    if (typed && session && typed !== session.title) engine.updateSession(workerId, sessionId, { title: typed }).catch(reportError);
  };
  const togglePanel = (t: SidePanelTab) => setPanel((p) => (p === t ? null : t));
  const taskCount = session?.taskCount ?? activeTaskCount(timeline.tasks);

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="panel flex h-12 shrink-0 items-center gap-2.5 border-b px-4">
          {session && <StatusDot status={session.status} taskCount={taskCount} />}
          {renaming !== null ? (
            <input className="input h-8 max-w-sm py-0 text-[14px] font-medium" autoFocus aria-label="会话标题" value={renaming} onChange={(e) => setRenaming(e.target.value)}
              onBlur={rename} onKeyDown={(e) => { if (e.key === 'Enter') rename(); if (e.key === 'Escape') setRenaming(null); }} />
          ) : (
            <button className="min-w-0 truncate rounded-md px-1 py-0.5 text-[14px] font-medium hover:bg-hover" title="点击改名" onClick={() => setRenaming(session?.title ?? '')}>
              {session?.title || '未命名会话'}
            </button>
          )}
          {session && <ProjectTag workerId={workerId} sessionId={sessionId} projectId={session.projectId ?? null} />}
          <span className="inline-flex min-w-0 shrink items-center gap-1 truncate text-[12px] text-subtle" title={session?.cwd ? `${machine?.label ?? workerId} · ${session.cwd}` : machine?.label ?? workerId}>
            <Icon name="monitor" size={13} />
            <span className="truncate">{machine?.label ?? workerId}</span>
            {offline && <span className="text-amber-600 dark:text-amber-400">· 离线</span>}
          </span>
          <div className="flex-1" />
          <button className={`btn-icon ${panel === 'files' ? 'bg-active text-ink' : ''}`} title="文件" aria-label="文件" aria-pressed={panel === 'files'} onClick={() => togglePanel('files')}>
            <Icon name="folder" size={17} />
          </button>
          <button className={`btn-icon relative ${panel === 'tasks' ? 'bg-active text-ink' : ''}`} title="后台任务" aria-label="后台任务" aria-pressed={panel === 'tasks'} onClick={() => togglePanel('tasks')}>
            <Icon name="tasks" size={17} />
            {taskCount > 0 && <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 text-[10px] font-semibold text-white">{taskCount}</span>}
          </button>
          <MoreMenu session={session} workerId={workerId} onFork={() => actions.onFork()} />
        </header>
        <div className="min-h-0 flex-1">
          <MessageList workerId={workerId} sessionId={sessionId} timeline={timeline} actions={actions} />
        </div>
        <BtwPanel workerId={workerId} sessionId={sessionId} items={timeline.btw ?? []} />
        {timeline.prompts.length > 0 && (
          <div className="max-h-[50%] overflow-y-auto px-4">
            {timeline.prompts.map((p) => <AskCard key={p.id} workerId={workerId} prompt={p} />)}
          </div>
        )}
        <Composer workerId={workerId} sessionId={sessionId} running={running} disabled={offline}
          toolbar={session && (
            <ModelPicker compact workerId={workerId} model={session.model} thinking={session.thinking}
              onChange={(v) => engine.updateSession(workerId, sessionId, v).catch(reportError)} />
          )} />
      </div>
      {panel && <SidePanel workerId={workerId} sessionId={sessionId} tasks={timeline.tasks} tab={panel} onTab={setPanel} onClose={() => setPanel(null)} />}
    </div>
  );
}
