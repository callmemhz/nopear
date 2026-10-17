// Working-directory picking for "new session": a folder browser over the machine-level `dirs.list` RPC, and the
// cwd field (text input + recent/project chips + 「浏览…」) used by NewSessionDialog.
import { useEffect, useMemo, useState } from 'react';
import type { FileListing } from '@nopear/protocol';
import { joinDir, parentDir, pathCrumbs, recentCwds } from '@nopear/core';
import { engine, useEngine } from '../engine';

export function DirPicker({ workerId, initialPath, onSelect, onClose }: {
  workerId: string; initialPath?: string; onSelect: (path: string) => void; onClose: () => void;
}) {
  // the browsed path is tied to the machine it was chosen on; switching machine restarts at initialPath/default
  const [at, setAt] = useState<{ workerId: string; path?: string }>({ workerId, path: initialPath || undefined });
  const path = at.workerId === workerId ? at.path : initialPath || undefined;
  const go = (p?: string) => setAt({ workerId, path: p });
  const [showHidden, setShowHidden] = useState(false);
  const [data, setData] = useState<FileListing | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setErr(null);
    const args: { path?: string; showHidden?: boolean } = {};
    if (path) args.path = path;
    if (showHidden) args.showHidden = true;
    engine.rpc(workerId, 'dirs.list', args).then(
      (r) => { if (!cancelled) { setData(r); setLoading(false); } },
      (e: unknown) => { if (!cancelled) { setData(null); setErr(e instanceof Error ? e.message : String(e)); setLoading(false); } },
    );
    return () => { cancelled = true; };
  }, [workerId, path, showHidden, reload]);

  const cur = data?.path;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-6 pt-[10vh]"
      onMouseDown={(e) => { e.stopPropagation(); onClose(); }}>
      <div className="card flex max-h-[70vh] w-full max-w-lg flex-col gap-2 p-4 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">选择工作目录</h3>
          <label className="muted flex items-center gap-1 text-xs">
            <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />显示隐藏目录
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-0.5 font-mono text-xs">
          {cur ? pathCrumbs(cur).map((c, i) => (
            <span key={c.path} className="flex items-center">
              {i > 1 && <span className="muted">/</span>}
              <button className="rounded px-1 hover:bg-zinc-100 dark:hover:bg-zinc-800" onClick={() => go(c.path)} title={c.path}>{c.name}</button>
            </span>
          )) : <span className="muted">{path ?? '…'}</span>}
        </div>
        <div className="flex gap-2 text-xs">
          <button className="btn-ghost px-2 py-1 text-xs" disabled={!cur || cur === '/'} onClick={() => cur && go(parentDir(cur))}>↑ 上一级</button>
          <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setReload((n) => n + 1)}>⟳ 刷新</button>
          {err && <button className="btn-ghost px-2 py-1 text-xs" onClick={() => go(undefined)}>回到默认目录</button>}
        </div>
        <div className="min-h-32 flex-1 overflow-y-auto rounded border border-zinc-200 p-1 text-xs dark:border-zinc-800">
          {loading && <p className="muted p-2">加载中…</p>}
          {err && <p className="p-2 text-red-600">{err}</p>}
          {!loading && !err && data?.entries.length === 0 && <p className="muted p-2">（没有子目录）</p>}
          {!loading && data?.entries.map((e) => (
            <button key={e.name} className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800/60"
              onClick={() => cur && go(joinDir(cur, e.name))}>
              <span>📁</span><span className="min-w-0 flex-1 truncate font-mono">{e.name}</span>
            </button>
          ))}
          {data?.truncated && <p className="muted p-2">（仅显示前 500 项）</p>}
        </div>
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" disabled={!cur || !!err} onClick={() => cur && onSelect(cur)}>选择此目录</button>
        </div>
      </div>
    </div>
  );
}

export function CwdField({ workerId, value, onChange, placeholder }: {
  workerId: string; value: string; onChange: (path: string) => void; placeholder?: string;
}) {
  const projects = useEngine((s) => s.projects);
  const sessions = useEngine((s) => s.sessions);
  const sessionIndex = useEngine((s) => s.sessionIndex);
  const recent = useMemo(() => recentCwds({ projects, sessions, sessionIndex }, workerId), [projects, sessions, sessionIndex, workerId]);
  const [browsing, setBrowsing] = useState(false);
  return (
    <div className="space-y-1 text-xs">
      <span className="muted">工作目录</span>
      <div className="flex gap-2">
        <input className="input min-w-0 flex-1 font-mono" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label="工作目录" />
        <button type="button" className="btn-ghost shrink-0 border border-zinc-200 dark:border-zinc-700" disabled={!workerId} onClick={() => setBrowsing(true)}>浏览…</button>
      </div>
      {recent.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {recent.map((r) => (
            <button key={r.path} type="button" title={r.path} onClick={() => onChange(r.path)}
              className={`max-w-full truncate rounded-full border px-2 py-0.5 font-mono ${value === r.path ? 'border-zinc-900 dark:border-zinc-100' : 'border-zinc-200 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800'}`}>
              {r.kind === 'project' ? <><span className="font-sans">📁 {r.label}</span> <span className="muted">{r.path}</span></> : r.path}
            </button>
          ))}
        </div>
      )}
      {browsing && (
        <DirPicker workerId={workerId} initialPath={value.trim() || undefined}
          onSelect={(p) => { onChange(p); setBrowsing(false); }} onClose={() => setBrowsing(false)} />
      )}
    </div>
  );
}
