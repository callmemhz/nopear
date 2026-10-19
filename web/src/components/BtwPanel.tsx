import type { BtwAnswer } from '@nopear/protocol';
import { engine } from '../engine';
import { Markdown } from './Markdown';
import { Spinner } from './Icons';

/** `/btw` side answers: shown above the composer, never part of the conversation. Closing one discards it. */
export function BtwPanel({ workerId, sessionId, items }: { workerId: string; sessionId: string; items: BtwAnswer[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mx-auto w-full max-w-[720px] space-y-2 px-4 pb-1" aria-label="顺便问">
      {items.map((b) => (
        <section key={b.id} data-btw={b.id} className="card overflow-hidden border-dashed text-[14px]">
          <header className="flex items-start gap-2 border-b border-line px-3.5 py-2">
            <span className="chip shrink-0 text-[11px]">/btw</span>
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words font-medium">{b.question}</span>
            {b.status === 'running' && <Spinner className="h-3.5 w-3.5 shrink-0" />}
            <button className="btn-icon -my-1 h-6 w-6 shrink-0 text-[13px]" title="关闭（不会进入会话）" aria-label="关闭" onClick={() => engine.dismissBtw(workerId, sessionId, b.id)}>✕</button>
          </header>
          <div className="max-h-[40vh] overflow-y-auto px-3.5 py-2.5">
            {b.status === 'error'
              ? <p className="whitespace-pre-wrap break-words text-[13px] text-red-600 dark:text-red-400">没答上来：{b.error}</p>
              : b.text ? <Markdown text={b.text} /> : <p className="muted text-[13px]">正在看上下文…</p>}
          </div>
          <footer className="muted px-3.5 pb-2 text-[11px]">只用当前上下文回答，不调用工具，不写进会话{b.model ? ` · ${b.model}` : ''}</footer>
        </section>
      ))}
    </div>
  );
}
