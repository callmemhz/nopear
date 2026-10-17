// View model for background-subagent notices (role=system messages carrying `notice`), shared by web/mobile.
import type { Message, NoticeStatus } from '@nopear/protocol';

export type NoticeTone = 'ok' | 'error' | 'warn' | 'info';
export interface NoticeView {
  /** 「后台任务完成 · worker」 */
  heading: string;
  /** First non-empty line after the title (markdown bold stripped); the title itself when there is no agent. */
  summary: string;
  tone: NoticeTone;
  /** Full markdown text (expanded view). */
  text: string;
}

const LABEL: Record<NoticeStatus, [string, NoticeTone]> = {
  completed: ['后台任务完成', 'ok'],
  failed: ['后台任务失败', 'error'],
  paused: ['后台任务已暂停', 'warn'],
  stopped: ['后台任务已停止', 'warn'],
  attention: ['后台任务需要处理', 'warn'],
};

export function noticeView(m: Message): NoticeView | null {
  const n = m.notice;
  if (!n) return null;
  const text = m.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
  const [label, tone] = n.status ? LABEL[n.status] : ['后台任务通知', 'info' as const];
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const after = (lines[1] ?? '').replace(/\*\*/g, '');
  return { heading: n.agent ? `${label} · ${n.agent}` : label, summary: n.agent ? after : n.title, tone, text };
}
