// Background tasks (pi-subagents runs) — display logic shared by web + mobile.
import { isActiveTask, type BackgroundTask, type Message, type TaskActivity, type TaskState } from '@nopear/protocol';
import { emptyTimeline, type TimelineState } from './timeline';

export const TASK_STATE_LABEL: Record<TaskState, string> = {
  queued: '排队中', running: '运行中', paused: '已暂停', complete: '已完成', failed: '失败', stopped: '已停止',
};
export type TaskTone = 'live' | 'wait' | 'ok' | 'bad' | 'off';
export const taskTone = (s: TaskState): TaskTone =>
  s === 'running' ? 'live' : s === 'queued' || s === 'paused' ? 'wait' : s === 'complete' ? 'ok' : s === 'failed' ? 'bad' : 'off';

/** Running ones (what the session row / badge count) vs. recently finished ones (kept for their transcript). */
export function splitTasks(tasks: readonly BackgroundTask[]): { active: BackgroundTask[]; finished: BackgroundTask[] } {
  const active: BackgroundTask[] = [];
  const finished: BackgroundTask[] = [];
  for (const t of tasks) (isActiveTask(t) ? active : finished).push(t);
  return { active, finished };
}
export const activeTaskCount = (tasks: readonly BackgroundTask[]): number => tasks.filter(isActiveTask).length;

export const taskTitle = (t: Pick<BackgroundTask, 'goal' | 'agent' | 'id'>): string => t.goal || t.agent || t.id;

/** "bash `kubectl get pods` · 12 轮 · 30 次工具" (tool args already shortened by the worker). */
export function activityLine(a: TaskActivity | undefined): string {
  if (!a) return '';
  const parts: string[] = [];
  if (a.tool) parts.push(a.toolArgs ? `${a.tool} ${a.toolArgs.replace(/\s+/g, ' ')}` : a.tool);
  if (a.turns !== undefined) parts.push(`${a.turns} 轮`);
  if (a.tools !== undefined) parts.push(`${a.tools} 次工具`);
  return parts.join(' · ');
}

/** Seconds a task / step has run (until it ended). */
export function taskSeconds(t: { startedAt?: string; endedAt?: string }, now: number): number {
  const start = t.startedAt ? Date.parse(t.startedAt) : NaN;
  if (!Number.isFinite(start)) return 0;
  const end = t.endedAt ? Date.parse(t.endedAt) : now;
  return Math.max(0, ((Number.isFinite(end) ? end : now) - start) / 1000);
}

/** A read-only timeline for a run's transcript, so the normal message components can render it. */
export function transcriptTimeline(messages: Message[]): TimelineState {
  return { ...emptyTimeline(), cursor: 'transcript', messages, hasMore: false };
}

/**
 * What a session's status light shows. The agent working beats background tasks (the turn ended but subagents it
 * launched are still running), which beat a failed last turn.
 */
export type SessionActivity = 'running' | 'background' | 'error' | 'idle';
export function sessionActivity(s: { status: 'idle' | 'running' | 'error'; taskCount?: number }): SessionActivity {
  if (s.status === 'running') return 'running';
  if ((s.taskCount ?? 0) > 0) return 'background';
  return s.status === 'error' ? 'error' : 'idle';
}
export const SESSION_ACTIVITY_LABEL: Record<SessionActivity, string> = { running: '运行中', background: '后台任务运行中', error: '出错', idle: '空闲' };
