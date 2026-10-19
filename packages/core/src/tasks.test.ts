import { describe, expect, it } from 'vitest';
import type { BackgroundTask, Message } from '@nopear/protocol';
import { activeTaskCount, activityLine, selectMessages, splitTasks, taskSeconds, taskTitle, taskTone, transcriptTimeline } from './index';

const task = (id: string, state: BackgroundTask['state']): BackgroundTask => ({ id, agent: 'delegate', goal: '', state, startedAt: '2026-10-19T00:00:00.000Z' });

describe('background tasks', () => {
  it('splits running from finished; only running ones count', () => {
    const ts = [task('a', 'running'), task('b', 'complete'), task('c', 'queued'), task('d', 'failed'), task('e', 'paused'), task('f', 'stopped')];
    const { active, finished } = splitTasks(ts);
    expect(active.map((t) => t.id)).toEqual(['a', 'c', 'e']);
    expect(finished.map((t) => t.id)).toEqual(['b', 'd', 'f']);
    expect(activeTaskCount(ts)).toBe(3);
    expect(['running', 'queued', 'complete', 'failed', 'stopped'].map((s) => taskTone(s as BackgroundTask['state']))).toEqual(['live', 'wait', 'ok', 'bad', 'off']);
  });

  it('title falls back goal → agent → id; activity line', () => {
    expect(taskTitle({ ...task('x', 'running'), goal: 'Verify publish' })).toBe('Verify publish');
    expect(taskTitle(task('x', 'running'))).toBe('delegate');
    expect(taskTitle({ ...task('x', 'running'), agent: '' })).toBe('x');
    expect(activityLine({ tool: 'bash', toolArgs: 'kubectl  get\npods', turns: 12, tools: 30 })).toBe('bash kubectl get pods · 12 轮 · 30 次工具');
    expect(activityLine({ turns: 3 })).toBe('3 轮');
    expect(activityLine(undefined)).toBe('');
  });

  it('duration runs until now, or until it ended', () => {
    const t0 = Date.parse('2026-10-19T00:00:00.000Z');
    expect(taskSeconds({ startedAt: '2026-10-19T00:00:00.000Z' }, t0 + 90_000)).toBe(90);
    expect(taskSeconds({ startedAt: '2026-10-19T00:00:00.000Z', endedAt: '2026-10-19T00:01:00.000Z' }, t0 + 999_000)).toBe(60);
    expect(taskSeconds({}, t0)).toBe(0);
  });

  it('a transcript renders through the normal timeline selectors (tool results attach to their calls)', () => {
    const ms: Message[] = [
      { id: 'r:0:1', sessionId: 's', role: 'user', ts: '', status: 'complete', blocks: [{ type: 'text', text: 'Task: x' }] },
      { id: 'r:0:2', sessionId: 's', role: 'assistant', ts: '', status: 'complete', blocks: [{ type: 'tool_call', id: 't1', name: 'bash', input: { command: 'ls' } }] },
      { id: 'r:0:3', sessionId: 's', role: 'tool', ts: '', status: 'complete', blocks: [{ type: 'tool_result', toolCallId: 't1', toolName: 'bash', text: 'a.ts', isError: false }] },
    ];
    const tl = transcriptTimeline(ms);
    expect(tl.hasMore).toBe(false);
    const items = selectMessages(tl);
    expect(items.map((i) => i.message.id)).toEqual(['r:0:1', 'r:0:2']);
    expect(items[1]!.results.t1?.text).toBe('a.ts');
  });
});
