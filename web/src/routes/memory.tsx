import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import type { MemoryScope } from '@nopear/protocol';
import { engine, useEngine } from '../engine';
import { reportError } from './root';

export function MemoryPage() {
  const { workerId } = useParams({ strict: false }) as { workerId: string };
  const label = useEngine((s) => s.machines[workerId]?.label ?? workerId);
  const q = useQuery({ queryKey: ['memory', workerId], queryFn: () => engine.rpc(workerId, 'memory.get', {}) });
  const [scope, setScope] = useState<MemoryScope>('global');
  const [text, setText] = useState<Record<MemoryScope, string>>({ global: '', project: '' });
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!q.data) return;
    const next = { global: '', project: '' } as Record<MemoryScope, string>;
    for (const f of q.data.files) next[f.scope] = f.content;
    setText(next);
  }, [q.data]);
  const file = q.data?.files.find((f) => f.scope === scope);
  const dirty = (file?.content ?? '') !== text[scope];
  const save = async () => {
    setSaving(true);
    try { await engine.rpc(workerId, 'memory.put', { scope, content: text[scope] }); await q.refetch(); } catch (e) { reportError(e); } finally { setSaving(false); }
  };
  return (
    <div className="flex h-full flex-col">
      <header className="panel flex items-center gap-3 border-b px-4 py-2">
        <h1 className="text-sm font-semibold">记忆 · {label}</h1>
        <div className="panel flex gap-1 rounded-md border p-0.5">
          {(['global', 'project'] as const).map((s) => (
            <button key={s} onClick={() => setScope(s)} className={`rounded px-2 py-0.5 text-xs ${scope === s ? 'bg-zinc-200 dark:bg-zinc-700' : 'muted'}`}>{s === 'global' ? '全局' : '默认项目'}</button>
          ))}
        </div>
        <span className="muted truncate font-mono text-[11px]">{file?.path}{file && !file.exists ? '（尚未创建）' : ''}</span>
        <div className="flex-1" />
        <button className="btn-primary text-xs" disabled={!dirty || saving} onClick={() => void save()}>{saving ? '保存中…' : '保存'}</button>
      </header>
      {q.isError ? <p className="p-6 text-sm text-red-500">{String(q.error)}</p> : (
        <textarea className="min-h-0 flex-1 resize-none bg-transparent p-6 font-mono text-[13px] leading-relaxed outline-none"
          value={text[scope]} onChange={(e) => setText({ ...text, [scope]: e.target.value })} placeholder="# AGENTS.md —— 写给 agent 的长期指令" spellCheck={false} />
      )}
    </div>
  );
}
