import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { MEMORY_MAX_BYTES, memoryKey, type MemoryScope } from '@nopear/protocol';
import { engine, useEngine } from '../engine';
import { formatBytes } from '../lib/format';
import { reportError } from './root';

/** Editor for a SaaS memory doc (global or one project's). Live `memory.updated` events refresh it unless the user has unsaved edits. */
export function MemoryEditor({ scope, projectId, className = '' }: { scope: MemoryScope; projectId: string | null; className?: string }) {
  const key = memoryKey(scope, projectId);
  const doc = useEngine((s) => s.memories[key]);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const missing = doc === undefined; // also true again after an SSE reconnect reload (it keeps only the global doc)
  useEffect(() => {
    if (!missing) return;
    setLoadError(null);
    engine.loadMemory(scope, projectId).catch((e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)));
  }, [scope, projectId, missing]);
  const text = draft ?? doc?.content ?? '';
  const bytes = new TextEncoder().encode(text).length;
  const dirty = draft !== null && draft !== (doc?.content ?? '');
  const save = async () => {
    setSaving(true);
    try { await engine.saveMemory(scope, projectId, text); setDraft(null); } catch (e) { reportError(e); } finally { setSaving(false); }
  };
  return (
    <div className={`flex min-h-0 flex-col ${className}`}>
      <div className="flex items-center gap-3 pb-2 text-xs">
        <span className={bytes > MEMORY_MAX_BYTES ? 'text-red-500' : 'muted'}>{formatBytes(bytes)} / {formatBytes(MEMORY_MAX_BYTES)}</span>
        {loadError && <span className="text-red-500">{loadError}</span>}
        <div className="flex-1" />
        {dirty && <button className="btn-ghost text-xs" onClick={() => setDraft(null)}>放弃修改</button>}
        <button className="btn-primary text-xs" disabled={!dirty || saving || bytes > MEMORY_MAX_BYTES} onClick={() => void save()}>{saving ? '保存中…' : '保存'}</button>
      </div>
      <textarea className="input min-h-64 flex-1 resize-none font-mono text-[13px] leading-relaxed" spellCheck={false}
        placeholder={scope === 'global' ? '# 全局记忆 —— 每个带项目标签的会话都会注入' : '# 项目记忆 —— 该项目的会话每轮注入'}
        value={text} onChange={(e) => setDraft(e.target.value)} />
    </div>
  );
}

export function GlobalMemoryPage() {
  return (
    <div className="flex h-full flex-col">
      <header className="panel flex items-center gap-3 border-b px-4 py-2">
        <h1 className="text-sm font-semibold">全局记忆</h1>
        <span className="muted text-xs">存于 SaaS，注入所有带项目标签的会话；机器记忆（AGENTS.md）在</span>
        <Link to="/machines" className="text-xs hover:underline">机器页</Link>
      </header>
      <MemoryEditor scope="global" projectId={null} className="flex-1 p-4" />
    </div>
  );
}
