import { sessionKey, type QueueItem } from '@nopear/protocol';
import { editNeedsConfirm, queueActions, queueBadge, queueErrorText, queuePreview, type QueueAction } from '@nopear/core';
import { engine, useEngine } from '../engine';
import { reportError } from '../routes/root';

const EMPTY: QueueItem[] = [];
const TITLES: Record<QueueAction, (q: QueueItem) => string> = {
  steer: () => '改为插队：当前工具调用结束后立即送达',
  edit: (q) => (q.attachments > 0 ? '取回输入框编辑（附件不会带回）' : '取回输入框编辑'),
  cancel: () => '取消这条排队消息',
};

/** Compact cards of the messages queued while the session runs: 取消 / 编辑 / 插队. */
export function QueueList({ workerId, sessionId, confirm = (m) => window.confirm(m) }: {
  workerId: string; sessionId: string; confirm?: (message: string) => boolean;
}) {
  const key = sessionKey(workerId, sessionId);
  const queue = useEngine((s) => s.timelines[key]?.queue ?? EMPTY);
  if (queue.length === 0) return null;
  const fail = (e: unknown) => reportError(new Error(queueErrorText(e)));
  const cancel = (q: QueueItem) => { engine.removeQueued(workerId, sessionId, q.id).catch(fail); };
  const steer = (q: QueueItem) => { engine.updateQueued(workerId, sessionId, q.id, { delivery: 'steer' }).catch(fail); };
  const edit = (q: QueueItem) => {
    const draft = engine.store.getState().drafts[key] ?? '';
    if (editNeedsConfirm(draft) && !confirm('输入框里已有内容，要用这条排队消息替换吗？')) return;
    engine.removeQueued(workerId, sessionId, q.id).then(() => engine.setDraft(workerId, sessionId, q.text), fail);
  };
  const run: Record<QueueAction, (q: QueueItem) => void> = { steer, edit, cancel };
  return (
    <ul aria-label="排队消息" className="mx-auto mb-2 flex max-w-[720px] flex-col gap-1.5">
      {queue.map((q) => (
        <li key={q.id} data-testid="queue-card"
          className="flex items-center gap-2 rounded-xl border border-line bg-elev px-3 py-1.5 text-[13px] shadow-[0_1px_4px_rgba(31,30,29,0.04)]">
          <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium ${q.delivery === 'steer' ? 'bg-accent-soft text-accent' : 'bg-hover text-subtle'}`}
            title={q.delivery === 'steer' ? '当前工具调用结束后立即送达' : '本轮结束后送达'}>
            {queueBadge(q.delivery)}
          </span>
          <span className="min-w-0 flex-1 truncate text-ink" title={q.text}>{queuePreview(q)}</span>
          {q.attachments > 0 && <span className="shrink-0 text-[12px] text-subtle" title={`${q.attachments} 个附件`}>📎 {q.attachments}</span>}
          {queueActions(q).map(({ action, label }) => (
            <button key={action} type="button" aria-label={label} title={TITLES[action](q)} onClick={() => run[action](q)}
              className={`btn-ghost shrink-0 px-1.5 py-0.5 text-[12px] ${action === 'cancel' ? 'hover:text-red-600' : ''}`}>{label}</button>
          ))}
        </li>
      ))}
    </ul>
  );
}
