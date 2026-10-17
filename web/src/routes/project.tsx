import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { groupBoard } from '@nopear/core';
import type { Card, Project } from '@nopear/protocol';
import { engine, useEngine } from '../engine';
import { StatusDot } from '../components/SessionList';
import { relativeTime } from '../lib/format';
import { MemoryEditor } from './global-memory';
import { reportError } from './root';

function CardRow({ c }: { c: Card }) {
  const label = useEngine((s) => (c.workerId ? s.machines[c.workerId]?.label || c.workerId : ''));
  return (
    <div className="card px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium">{c.title}</span>
        {label && <span className="chip">{label}</span>}
        {c.workerId && c.sessionId && (
          <Link to="/s/$workerId/$sessionId" params={{ workerId: c.workerId, sessionId: c.sessionId }} className="hover:underline">会话 →</Link>
        )}
      </div>
      {c.error && <div className="mt-1 text-red-500">{c.error}</div>}
    </div>
  );
}

function ProjectForm({ project }: { project: Project }) {
  const machines = useEngine((s) => s.machines);
  const list = useMemo(() => Object.values(machines).sort((a, b) => (a.label || a.workerId).localeCompare(b.label || b.workerId)), [machines]);
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [paths, setPaths] = useState<Record<string, string>>(project.paths);
  const [saving, setSaving] = useState(false);
  // a remote update (another client / an agent tool) replaces the form while it has no local edits
  const [base, setBase] = useState(project);
  if (base !== project) {
    setBase(project);
    if (name === base.name && description === base.description && JSON.stringify(paths) === JSON.stringify(base.paths)) {
      setName(project.name); setDescription(project.description); setPaths(project.paths);
    }
  }
  const dirty = name !== project.name || description !== project.description || JSON.stringify(paths) !== JSON.stringify(project.paths);
  const save = async () => {
    setSaving(true);
    const clean = Object.fromEntries(Object.entries(paths).map(([w, p]) => [w, p.trim()]).filter(([, p]) => p));
    try {
      await engine.updateProject(project.id, { name: name.trim() || project.name, description, paths: clean });
    } catch (e) { reportError(e); } finally { setSaving(false); }
  };
  return (
    <section className="card space-y-3 p-4">
      <input className="input font-medium" value={name} onChange={(e) => setName(e.target.value)} placeholder="项目名" />
      <textarea className="input min-h-20" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="描述" />
      <div>
        <div className="muted pb-1 text-xs">各机器上的路径（新建会话时按 cwd 前缀自动打项目标签；卡片在该机器执行时用作 cwd）</div>
        <div className="space-y-1.5">
          {list.length === 0 && <p className="muted text-xs">还没有机器。</p>}
          {list.map((m) => (
            <label key={m.workerId} className="flex items-center gap-2 text-xs">
              <span className="w-32 shrink-0 truncate">{m.label || m.workerId}</span>
              <input className="input h-7 py-0 font-mono text-xs" placeholder="/abs/path（留空 = 该机器无路径）" value={paths[m.workerId] ?? ''}
                onChange={(e) => setPaths({ ...paths, [m.workerId]: e.target.value })} />
            </label>
          ))}
        </div>
      </div>
      <div className="flex justify-end">
        <button className="btn-primary text-xs" disabled={!dirty || saving} onClick={() => void save()}>{saving ? '保存中…' : '保存'}</button>
      </div>
    </section>
  );
}

const STATE_LABEL = { inbox: '收件箱', running: '进行中', review: '待验收', done: '完成' } as const;

export function ProjectPage() {
  const { projectId } = useParams({ strict: false }) as { projectId: string };
  const project = useEngine((s) => s.projects[projectId]);
  const cards = useEngine((s) => s.cards);
  const index = useEngine((s) => s.sessionIndex);
  const machines = useEngine((s) => s.machines);
  const navigate = useNavigate();
  const board = useMemo(() => groupBoard(Object.values(cards), projectId), [cards, projectId]);
  const sessions = useMemo(() => Object.values(index).filter((e) => e.projectId === projectId)
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)), [index, projectId]);
  const loaded = useEngine((s) => s.settings !== null);

  if (!project) {
    return <p className="muted p-6 text-sm">{loaded ? '项目不存在或已删除。' : '加载中…'} <Link to="/projects" className="underline">返回项目列表</Link></p>;
  }
  const remove = () => {
    if (!confirm(`删除项目「${project.name}」？其卡片、项目记忆与会话标签一并删除。`)) return;
    engine.deleteProject(project.id).then(() => navigate({ to: '/projects' }), reportError);
  };
  const groups: Array<[string, Card[]]> = [
    [STATE_LABEL.inbox, board.inbox],
    ...Object.entries(board.queued).map(([w, list]): [string, Card[]] => [`待开始 · ${machines[w]?.label || w}`, list]),
    [STATE_LABEL.running, board.running],
    [STATE_LABEL.review, board.review],
    [STATE_LABEL.done, board.done],
  ];
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-6 px-6 py-8">
        <div className="flex items-center gap-2">
          <Link to="/projects" className="muted text-xs hover:underline">项目</Link><span className="muted">/</span>
          <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">{project.name}</h1>
          <button className="btn-danger text-xs" onClick={remove}>删除项目</button>
        </div>
        <ProjectForm key={project.id} project={project} />
        <section>
          <h2 className="pb-2 text-sm font-semibold">项目记忆</h2>
          <MemoryEditor scope="project" projectId={project.id} />
        </section>
        <section>
          <div className="flex items-center pb-2">
            <h2 className="flex-1 text-sm font-semibold">卡片</h2>
            <Link to="/board" className="muted text-xs hover:underline">去看板 →</Link>
          </div>
          <div className="space-y-3">
            {groups.filter(([, list]) => list.length > 0).map(([title, list]) => (
              <div key={title}>
                <div className="muted pb-1 text-xs">{title} · {list.length}</div>
                <div className="space-y-1">{list.map((c) => <CardRow key={c.id} c={c} />)}</div>
              </div>
            ))}
            {groups.every(([, list]) => list.length === 0) && <p className="muted text-xs">还没有卡片。</p>}
          </div>
        </section>
        <section>
          <h2 className="pb-2 text-sm font-semibold">会话</h2>
          <div className="space-y-1">
            {sessions.length === 0 && <p className="muted text-xs">还没有带这个项目标签的会话。</p>}
            {sessions.map((s) => (
              <Link key={s.workerId + s.sessionId} to="/s/$workerId/$sessionId" params={{ workerId: s.workerId, sessionId: s.sessionId }}
                className="card flex items-center gap-2 px-3 py-2 text-xs hover:border-zinc-300 dark:hover:border-zinc-700">
                <StatusDot status={s.status} />
                <span className="min-w-0 flex-1 truncate font-medium">{s.title || '未命名会话'}</span>
                <span className="chip">{machines[s.workerId]?.label || s.workerId}</span>
                <span className="muted">{relativeTime(s.lastActivityAt)}</span>
              </Link>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
