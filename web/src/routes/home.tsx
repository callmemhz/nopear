import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useEngine } from '../engine';
import { useSessionList, StatusDot } from '../components/SessionList';
import { NewSessionDialog } from '../components/NewSessionDialog';
import { relativeTime } from '../lib/format';

export function HomePage() {
  const { pinned, rest } = useSessionList('all');
  const machines = useEngine((s) => s.machines);
  const [creating, setCreating] = useState(false);
  const all = [...pinned, ...rest];
  const noMachines = Object.keys(machines).length === 0;
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <h1 className="text-xl font-semibold tracking-tight">会话</h1>
        <p className="muted mt-1 text-sm">把任务派给任意一台机器，实时看它干活。</p>
        {noMachines ? (
          <div className="card mt-8 p-8 text-center">
            <div className="text-sm font-medium">还没有机器</div>
            <p className="muted mt-1 text-sm">在目标机器上启动 worker，打开终端里打印的认领链接（或在「机器」页粘贴）。</p>
            <Link to="/machines" className="btn-primary mt-4">去认领机器</Link>
          </div>
        ) : all.length === 0 ? (
          <div className="card mt-8 p-8 text-center">
            <div className="text-sm font-medium">还没有会话</div>
            <button className="btn-primary mt-4" onClick={() => setCreating(true)}>＋ 新建会话</button>
          </div>
        ) : (
          <div className="mt-6 grid gap-2 sm:grid-cols-2">
            {all.slice(0, 30).map((s) => (
              <Link key={s.workerId + s.id} to="/s/$workerId/$sessionId" params={{ workerId: s.workerId, sessionId: s.id }} className="card block p-3 transition-colors hover:border-zinc-300 dark:hover:border-zinc-700">
                <div className="flex items-center gap-2 text-sm">
                  <StatusDot status={s.status} />
                  <span className="min-w-0 flex-1 truncate font-medium">{s.title || '未命名会话'}</span>
                  {s.pinned && <span className="muted text-xs">置顶</span>}
                  <span className="muted text-[11px]">{relativeTime(s.lastActivityAt)}</span>
                </div>
                <div className="muted mt-1 truncate text-xs">{machines[s.workerId]?.label ?? s.workerId} · {s.preview || '—'}</div>
              </Link>
            ))}
          </div>
        )}
      </div>
      {creating && <NewSessionDialog onClose={() => setCreating(false)} />}
    </div>
  );
}
