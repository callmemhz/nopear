import { useEffect, useState } from 'react';
import type { BackgroundTask } from '@nopear/protocol';
import { engine } from '../engine';
import { formatDuration } from '../lib/format';
import { reportError } from '../routes/root';

export function TasksPanel({ workerId, sessionId, tasks }: { workerId: string; sessionId: string; tasks: BackgroundTask[] }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (tasks.length === 0) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [tasks.length]);
  if (tasks.length === 0) return <p className="muted px-3 py-6 text-center text-xs">没有后台任务</p>;
  return (
    <ul className="space-y-1.5 p-2">
      {tasks.map((t) => (
        <li key={t.id} className="card p-2.5 text-xs">
          <div className="flex items-center gap-2">
            <span className={`h-1.5 w-1.5 rounded-full ${t.state === 'running' ? 'animate-pulse bg-emerald-500' : t.state === 'paused' ? 'bg-amber-500' : 'bg-zinc-400'}`} />
            <span className="font-medium">{t.agent || '任务'}</span>
            <span className="chip">{t.state === 'running' ? '运行中' : t.state === 'paused' ? '暂停' : '排队'}</span>
            <span className="muted ml-auto font-mono">{formatDuration((now - Date.parse(t.startedAt)) / 1000)}</span>
          </div>
          {t.goal && <div className="muted mt-1 line-clamp-2">{t.goal}</div>}
          <div className="mt-1.5 flex justify-end">
            <button className="btn-danger px-2 py-0.5 text-[11px]" onClick={() => engine.stopTask(workerId, sessionId, t.id).catch(reportError)}>停止</button>
          </div>
        </li>
      ))}
    </ul>
  );
}
