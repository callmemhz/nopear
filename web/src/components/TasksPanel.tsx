import { useEffect, useState } from 'react';
import {
  TASK_STATE_LABEL, activityLine, splitTasks, taskSeconds, taskTitle, taskTone, type TaskTone,
} from '@nopear/core';
import type { BackgroundTask, TaskStep, TaskTranscriptRef } from '@nopear/protocol';
import { engine } from '../engine';
import { formatDuration } from '../lib/format';
import { reportError } from '../routes/root';
import { TranscriptDialog } from './TranscriptDialog';

const DOT: Record<TaskTone, string> = {
  live: 'animate-pulse bg-emerald-500', wait: 'bg-amber-500', ok: 'bg-emerald-500/60', bad: 'bg-red-500', off: 'bg-zinc-400',
};
export const toneDot = (tone: TaskTone) => `h-1.5 w-1.5 shrink-0 rounded-full ${DOT[tone]}`;

export interface OpenTranscript { ref: TaskTranscriptRef; title: string }

export function TasksPanel({ workerId, sessionId, tasks }: { workerId: string; sessionId: string; tasks: BackgroundTask[] }) {
  const { active, finished } = splitTasks(tasks);
  const [now, setNow] = useState(Date.now());
  const [open, setOpen] = useState<OpenTranscript | null>(null);
  const [showDone, setShowDone] = useState(true);
  useEffect(() => {
    if (active.length === 0) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active.length]);
  if (tasks.length === 0) return <p className="muted px-3 py-6 text-center text-xs">没有后台任务</p>;
  const card = (t: BackgroundTask) => <TaskCard key={t.id} task={t} now={now} workerId={workerId} sessionId={sessionId} onOpen={setOpen} />;
  return (
    <div className="space-y-3 p-2">
      {active.length > 0 && <ul className="space-y-1.5" aria-label="运行中的后台任务">{active.map(card)}</ul>}
      {active.length === 0 && <p className="muted px-1 pt-1 text-xs">没有在跑的后台任务</p>}
      {finished.length > 0 && (
        <section>
          <button className="muted mb-1.5 px-1 text-[11px] hover:text-ink" aria-expanded={showDone} onClick={() => setShowDone((v) => !v)}>
            {showDone ? '▾' : '▸'} 已结束（{finished.length}）
          </button>
          {showDone && <ul className="space-y-1.5" aria-label="已结束的后台任务">{finished.map(card)}</ul>}
        </section>
      )}
      {open && <TranscriptDialog workerId={workerId} sessionId={sessionId} transcript={open.ref} title={open.title} onClose={() => setOpen(null)} />}
    </div>
  );
}

function TaskCard({ task: t, now, workerId, sessionId, onOpen }: {
  task: BackgroundTask; now: number; workerId: string; sessionId: string; onOpen: (o: OpenTranscript) => void;
}) {
  const tone = taskTone(t.state);
  const live = tone === 'live' || tone === 'wait';
  const activity = activityLine(t.activity);
  const title = taskTitle(t);
  return (
    <li className="card p-2.5 text-xs" data-task={t.id}>
      <div className="flex items-start gap-2">
        <span className={`mt-1 ${toneDot(tone)}`} />
        <span className="line-clamp-2 min-w-0 flex-1 font-medium" title={t.goal}>{title}</span>
        <span className="muted shrink-0 font-mono">{formatDuration(taskSeconds(t, now))}</span>
      </div>
      <div className="muted mt-1 flex flex-wrap items-center gap-x-1.5 pl-3.5">
        <span className={`chip ${t.state === 'failed' ? 'text-red-600 dark:text-red-400' : ''}`}>{TASK_STATE_LABEL[t.state]}</span>
        <span>{t.agent}</span>
        {t.model && <span className="truncate">· {t.model}</span>}
      </div>
      {activity && <div className="muted mt-1 truncate pl-3.5 font-mono text-[11px]" title={activity}>{activity}</div>}
      {t.activity?.output && live && <div className="muted mt-0.5 line-clamp-2 pl-3.5 text-[11px] italic">{t.activity.output}</div>}
      {t.error && <div className="mt-1 line-clamp-4 break-words pl-3.5 text-[11px] text-red-600 dark:text-red-400" title={t.error}>{t.error}</div>}
      {t.steps && t.steps.length > 0 && (
        <ul className="mt-2 space-y-1 border-l border-line pl-2.5" aria-label="步骤">
          {t.steps.map((s) => <StepRow key={s.key} step={s} now={now} onOpen={onOpen} />)}
        </ul>
      )}
      <div className="mt-1.5 flex justify-end gap-1.5">
        {t.transcript && <button className="btn-ghost px-2 py-0.5 text-[11px]" onClick={() => onOpen({ ref: t.transcript!, title })}>查看过程</button>}
        {live && <button className="btn-danger px-2 py-0.5 text-[11px]" onClick={() => engine.stopTask(workerId, sessionId, t.id).catch(reportError)}>停止</button>}
      </div>
    </li>
  );
}

function StepRow({ step: s, now, onOpen }: { step: TaskStep; now: number; onOpen: (o: OpenTranscript) => void }) {
  const activity = activityLine(s.activity);
  return (
    <li data-step={s.key}>
      <div className="flex items-center gap-1.5">
        <span className={toneDot(taskTone(s.state))} />
        <span className="min-w-0 truncate font-medium">{s.label}</span>
        <span className="muted shrink-0">{TASK_STATE_LABEL[s.state]}</span>
        {s.startedAt && <span className="muted shrink-0 font-mono">{formatDuration(taskSeconds(s, now))}</span>}
        {s.transcript && s.state !== 'queued' && (
          <button className="ml-auto shrink-0 rounded px-1 text-[11px] text-subtle hover:bg-hover hover:text-ink"
            onClick={() => onOpen({ ref: s.transcript!, title: s.label })}>过程</button>
        )}
      </div>
      {activity && <div className="muted truncate pl-3 font-mono text-[11px]" title={activity}>{activity}</div>}
      {s.error && <div className="line-clamp-3 break-words pl-3 text-[11px] text-red-600 dark:text-red-400" title={s.error}>{s.error}</div>}
    </li>
  );
}
