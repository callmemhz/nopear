import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { engine, useEngine } from '../engine';
import { reportError } from './root';

export function CreateProject({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const input: { name: string; description?: string } = { name: name.trim() };
      if (description.trim()) input.description = description.trim();
      await engine.createProject(input);
      onClose();
    } catch (e) { reportError(e); } finally { setBusy(false); }
  };
  return (
    <div className="card mt-4 space-y-2 p-4">
      <input className="input" name="name" placeholder="项目名" value={name} onChange={(e) => setName(e.target.value)} />
      <textarea className="input min-h-20" name="description" placeholder="描述（可选）" value={description} onChange={(e) => setDescription(e.target.value)} />
      <p className="muted text-xs">各机器上的路径可在项目详情里设置。</p>
      <div className="flex justify-end gap-2">
        <button className="btn-ghost" onClick={onClose}>取消</button>
        <button className="btn-primary" disabled={busy || !name.trim()} onClick={() => void submit()}>创建</button>
      </div>
    </div>
  );
}

export function ProjectsPage() {
  const projects = useEngine((s) => s.projects);
  const machines = useEngine((s) => s.machines);
  const [creating, setCreating] = useState(false);
  const list = useMemo(() => Object.values(projects).sort((a, b) => a.name.localeCompare(b.name)), [projects]);
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <div className="flex items-center">
          <div className="flex-1">
            <h1 className="text-xl font-semibold tracking-tight">项目</h1>
            <p className="muted mt-1 text-sm">项目跨机器共享：每台机器一个路径、一份项目记忆、一组卡片与会话。</p>
          </div>
          <button className="btn-primary" onClick={() => setCreating(!creating)}>＋ 新项目</button>
        </div>
        {creating && <CreateProject onClose={() => setCreating(false)} />}
        <div className="mt-6 grid gap-2 sm:grid-cols-2">
          {list.length === 0 && <p className="muted text-sm">还没有项目。</p>}
          {list.map((p) => {
            const paths = Object.entries(p.paths);
            return (
              <div key={p.id} className="card p-4">
                <Link to="/projects/$projectId" params={{ projectId: p.id }} className="block truncate font-medium hover:underline">{p.name}</Link>
                {p.description && <div className="muted mt-1 line-clamp-2 text-xs">{p.description}</div>}
                <div className="muted mt-2 space-y-0.5 font-mono text-[11px]">
                  {paths.length === 0 && <div>（未设置机器路径）</div>}
                  {paths.map(([w, path]) => <div key={w} className="truncate">{machines[w]?.label || w} · {path}</div>)}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
