import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { engine } from '../engine';
import { formatBytes, relativeTime } from '../lib/format';
import { reportError } from '../routes/root';

const parentOf = (p: string) => p.replace(/\/[^/]+\/?$/, '') || '/';

export function FilesPanel({ workerId, sessionId }: { workerId: string; sessionId: string }) {
  const [path, setPath] = useState<string | undefined>(undefined);
  const q = useQuery({
    queryKey: ['files', workerId, sessionId, path ?? ''],
    queryFn: () => engine.rpc(workerId, 'files.list', path ? { sessionId, path } : { sessionId }),
  });
  const download = async (full: string, name: string) => {
    try {
      const r = await engine.rpc(workerId, 'files.read', { sessionId, path: full });
      const url = URL.createObjectURL(new Blob([r.bytes as BlobPart], { type: r.mediaType }));
      const a = document.createElement('a');
      a.href = url; a.download = r.name ?? name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) { reportError(e); }
  };
  const cur = q.data?.path;
  return (
    <div className="flex h-full flex-col text-xs">
      <div className="panel flex items-center gap-1 border-b px-2 py-1.5">
        <button className="btn-ghost px-1.5 py-0.5 text-xs" disabled={!cur || cur === '/'} onClick={() => cur && setPath(parentOf(cur))} title="上一级">↑</button>
        <span className="muted min-w-0 flex-1 truncate font-mono" title={cur}>{cur ?? '…'}</span>
        <button className="btn-ghost px-1.5 py-0.5 text-xs" onClick={() => void q.refetch()} title="刷新">⟳</button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {q.isLoading && <p className="muted p-3">加载中…</p>}
        {q.isError && <p className="p-3 text-red-500">{String(q.error)}</p>}
        {q.data?.entries.map((e) => {
          const full = `${cur?.replace(/\/$/, '')}/${e.name}`;
          return (
            <button key={e.name} className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800/60"
              onClick={() => (e.type === 'dir' ? setPath(full) : void download(full, e.name))} title={e.type === 'dir' ? '打开' : '下载'}>
              <span>{e.type === 'dir' ? '📁' : '📄'}</span>
              <span className="min-w-0 flex-1 truncate font-mono">{e.name}</span>
              {e.type === 'file' && <span className="muted shrink-0">{formatBytes(e.size)}</span>}
              <span className="muted w-16 shrink-0 text-right">{relativeTime(e.mtime)}</span>
            </button>
          );
        })}
        {q.data?.truncated && <p className="muted p-2">（仅显示前 500 项）</p>}
      </div>
    </div>
  );
}
