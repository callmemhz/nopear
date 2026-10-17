import { useMemo, useState } from 'react';
import { engine, useEngine } from '../engine';
import { reportError } from '../routes/root';

/** Top-bar「快速记一条」: Enter → new card in 收件箱 (optionally tagged with a project). */
export function QuickAdd({ autoFocus }: { autoFocus?: boolean } = {}) {
  const projects = useEngine((s) => s.projects);
  const list = useMemo(() => Object.values(projects).sort((a, b) => a.name.localeCompare(b.name)), [projects]);
  const [title, setTitle] = useState('');
  const [projectId, setProjectId] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      await engine.createCard({ title: t, projectId: projectId || null });
      setTitle('');
    } catch (e) { reportError(e); } finally { setBusy(false); }
  };
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <input className="input h-8 min-w-0 flex-1 py-0 text-[13px]" autoFocus={autoFocus} placeholder="快速记一条（回车 → 收件箱）" value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); } }} />
      <select className="input h-8 w-36 py-0 text-xs" title="项目" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
        <option value="">无项目</option>
        {list.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
    </div>
  );
}
