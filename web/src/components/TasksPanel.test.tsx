// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { BackgroundTask, Message } from '@nopear/protocol';
import { engine } from '../engine';
import { TasksPanel } from './TasksPanel';
import { TRANSCRIPT_POLL_MS } from './TranscriptDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let el: HTMLDivElement;
let root: Root;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
async function render(tasks: BackgroundTask[]) {
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  await act(async () => { root.render(<TasksPanel workerId="w" sessionId="s" tasks={tasks} />); });
}
const button = (text: string, scope: ParentNode = el) => Array.from(scope.querySelectorAll('button')).find((b) => b.textContent?.trim() === text);
const T = new Date(Date.now() - 65_000).toISOString();

const workflow: BackgroundTask = {
  id: 'wf', agent: 'workflow', goal: 'media 进行中 · 1/3 完成', state: 'running', startedAt: T,
  steps: [
    { key: 'media', label: 'media', agent: 'delegate', state: 'running', startedAt: T, model: 'p/m', transcript: { runId: 'c1', step: 0 },
      activity: { tool: 'bash', toolArgs: 'kubectl get pods', turns: 12, tools: 30 } },
    { key: 'web', label: 'web', agent: 'delegate', state: 'failed', startedAt: T, endedAt: T, transcript: { runId: 'c2', step: 0 }, error: '400 Third-party apps now draw from extra usage' },
    { key: 'later', label: 'later', agent: 'delegate', state: 'queued', transcript: { runId: 'wf', step: 2 } },
  ],
};
const failed: BackgroundTask = {
  id: 'f1', agent: 'delegate', goal: 'Answer chat A’s ask', state: 'failed', startedAt: T, endedAt: T, model: 'p/m',
  transcript: { runId: 'f1', step: 0 }, activity: { tool: 'edit', turns: 69 }, error: '400 quota exhausted',
};
const msg = (id: string, role: Message['role'], text: string): Message => ({ id, sessionId: 's', role, ts: T, status: 'complete', blocks: [{ type: 'text', text }] });

afterEach(async () => {
  await act(async () => { root.unmount(); });
  el.remove();
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('TasksPanel', () => {
  it('running vs finished; workflow steps with activity, errors; stop only for running ones', async () => {
    const stop = vi.spyOn(engine, 'stopTask').mockResolvedValue();
    await render([workflow, failed]);
    const wf = el.querySelector('[data-task="wf"]')!;
    expect(wf.textContent).toContain('media 进行中 · 1/3 完成');
    expect(wf.querySelector('[data-step="media"]')!.textContent).toContain('bash kubectl get pods · 12 轮 · 30 次工具');
    expect(wf.querySelector('[data-step="web"]')!.textContent).toContain('Third-party apps');
    expect(button('过程', wf.querySelector('[data-step="later"]')!)).toBeUndefined(); // not started yet
    expect(button('查看过程', wf)).toBeUndefined(); // a workflow has no transcript of its own
    expect(el.textContent).toContain('已结束（1）');
    const f = el.querySelector('[data-task="f1"]')!;
    expect(f.textContent).toContain('失败');
    expect(f.textContent).toContain('400 quota exhausted');
    expect(button('停止', f)).toBeUndefined();
    await act(async () => { button('停止', wf)!.click(); });
    expect(stop).toHaveBeenCalledWith('w', 's', 'wf');
  });

  it('opens a step transcript; polls while it runs, stops once finished; Esc closes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const tr = vi.spyOn(engine, 'taskTranscript')
      .mockResolvedValueOnce({ messages: [msg('c1:0:1', 'user', 'Task: migrate media'), msg('c1:0:2', 'assistant', 'Working on it')], hasMore: false, state: 'running' })
      .mockResolvedValueOnce({ messages: [msg('c1:0:1', 'user', 'Task: migrate media'), msg('c1:0:3', 'assistant', 'All done')], hasMore: true, state: 'complete' });
    await render([workflow]);
    await act(async () => { button('过程', el.querySelector('[data-step="media"]')!)!.click(); });
    await flush();
    const dlg = () => document.querySelector('[data-testid="task-transcript"]');
    expect(tr).toHaveBeenCalledWith('w', 's', { runId: 'c1', step: 0 });
    expect(dlg()!.textContent).toContain('Task: migrate media');
    expect(dlg()!.textContent).toContain('Working on it');
    expect(dlg()!.textContent).toContain('运行中 · 自动刷新');
    await act(async () => { await vi.advanceTimersByTimeAsync(TRANSCRIPT_POLL_MS); });
    await flush();
    expect(dlg()!.textContent).toContain('All done');
    expect(dlg()!.textContent).toContain('只显示最近 2 条');
    expect(dlg()!.textContent).not.toContain('自动刷新');
    await act(async () => { await vi.advanceTimersByTimeAsync(TRANSCRIPT_POLL_MS * 3); });
    expect(tr).toHaveBeenCalledTimes(2);
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(dlg()).toBeNull();
  });

  it('a finished single run opens its own transcript; a read error is shown', async () => {
    vi.spyOn(engine, 'taskTranscript').mockRejectedValue(new Error('no background run f1'));
    await render([failed]);
    await act(async () => { button('查看过程', el.querySelector('[data-task="f1"]')!)!.click(); });
    await flush();
    expect(document.querySelector('[data-testid="task-transcript"]')!.textContent).toContain('读取失败：no background run f1');
  });

  it('empty list', async () => {
    await render([]);
    expect(el.textContent).toContain('没有后台任务');
  });
});
