import { describe, expect, it } from 'vitest';
import type { Message } from '@nopear/protocol';
import { noticeView } from './notice';

const sys = (text: string, notice?: Message['notice']): Message =>
  ({ id: 'n', sessionId: 's', role: 'system', blocks: [{ type: 'text', text }], ts: '', status: 'complete', ...(notice ? { notice } : {}) });

describe('noticeView', () => {
  it('null for messages without a notice', () => {
    expect(noticeView(sys('x'))).toBeNull();
  });
  it('heading by status + agent; summary = first non-empty line after the title, markdown bold stripped', () => {
    const v = noticeView(sys('Background task completed: **worker**\n\n**Done**: all good\nmore', { kind: 'subagent', title: 'Background task completed: worker', status: 'completed', agent: 'worker' }));
    expect(v).toEqual({ heading: '后台任务完成 · worker', summary: 'Done: all good', tone: 'ok', text: 'Background task completed: **worker**\n\n**Done**: all good\nmore' });
  });
  it('failed / attention / paused / stopped / unknown', () => {
    expect(noticeView(sys('Subagent failed: a\nRun: r', { kind: 'subagent', title: 'Subagent failed: a', status: 'failed', agent: 'a' }))).toMatchObject({ heading: '后台任务失败 · a', summary: 'Run: r', tone: 'error' });
    expect(noticeView(sys('t', { kind: 'subagent', title: 't', status: 'attention', agent: 'b' }))).toMatchObject({ heading: '后台任务需要处理 · b', summary: '', tone: 'warn' });
    expect(noticeView(sys('t', { kind: 'subagent', title: 't', status: 'paused' }))?.heading).toBe('后台任务已暂停');
    expect(noticeView(sys('t', { kind: 'subagent', title: 't', status: 'stopped' }))?.heading).toBe('后台任务已停止');
    expect(noticeView(sys('Odd thing\nrest', { kind: 'subagent', title: 'Odd thing' }))).toMatchObject({ heading: '后台任务通知', summary: 'Odd thing', tone: 'info' });
  });
});
