import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { TASK_STATE_LABEL, buildTurns, selectMessages, transcriptTimeline } from '@nopear/core';
import { isActiveTask, type Message, type TaskState, type TaskTranscriptRef } from '@nopear/protocol';
import { engine } from '../engine';
import { AssistantTurn } from './AssistantTurn';
import { MessageItem } from './MessageItem';

/** While the run is still going, re-read its transcript this often. */
export const TRANSCRIPT_POLL_MS = 3000;
const NO_ACTIONS = {};

type Load = { status: 'loading' } | { status: 'error'; error: string } | { status: 'ready'; messages: Message[]; hasMore: boolean; state?: TaskState };

/** Read-only view of a background run's own conversation (its task, tool calls, results, answer). */
export function TranscriptDialog({ workerId, sessionId, transcript, title, onClose }: {
  workerId: string; sessionId: string; transcript: TaskTranscriptRef; title: string; onClose: () => void;
}) {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const { runId, step } = transcript;

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fetchOnce = () => {
      engine.taskTranscript(workerId, sessionId, { runId, step }).then((r) => {
        if (!alive) return;
        setLoad({ status: 'ready', ...r });
        if (r.state && isActiveTask({ state: r.state })) timer = setTimeout(fetchOnce, TRANSCRIPT_POLL_MS);
      }, (e: unknown) => {
        if (!alive) return;
        setLoad((cur) => (cur.status === 'ready' ? cur : { status: 'error', error: e instanceof Error ? e.message : String(e) }));
      });
    };
    fetchOnce();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [workerId, sessionId, runId, step]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const messages = load.status === 'ready' ? load.messages : null;
  const turns = useMemo(() => (messages ? buildTurns(selectMessages(transcriptTimeline(messages))) : []), [messages]);
  const live = load.status === 'ready' && !!load.state && isActiveTask({ state: load.state });
  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [turns]);

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={`后台任务过程：${title}`} data-testid="task-transcript"
      className="fixed inset-0 z-[80] flex justify-end bg-black/40" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="surface flex h-full w-full max-w-3xl flex-col shadow-2xl">
        <div className="panel flex items-center gap-2 border-b px-4 py-2.5">
          <span className="min-w-0 truncate text-[14px] font-medium" title={title}>{title}</span>
          {load.status === 'ready' && load.state && <span className="chip shrink-0 text-[11px]">{TASK_STATE_LABEL[load.state]}{live ? ' · 自动刷新' : ''}</span>}
          <button aria-label="关闭" title="关闭 (Esc)" onClick={onClose} className="btn-icon ml-auto h-7 w-7">✕</button>
        </div>
        <div ref={box} className="min-h-0 flex-1 overflow-y-auto"
          onScroll={() => { const el = box.current; if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
          <div className="mx-auto max-w-[720px] px-6 pb-6 pt-4">
            {load.status === 'loading' && <div className="muted py-16 text-center text-sm">加载中…</div>}
            {load.status === 'error' && <div className="py-16 text-center text-sm text-red-600 dark:text-red-400">读取失败：{load.error}</div>}
            {load.status === 'ready' && load.hasMore && <div className="muted pb-3 text-center text-xs">只显示最近 {load.messages.length} 条</div>}
            {load.status === 'ready' && load.messages.length === 0 && <div className="muted py-16 text-center text-sm">{live ? '还没开始，稍等…' : '没有记录'}</div>}
            {turns.map((t, i) => t.kind === 'message'
              ? <MessageItem key={t.key} item={t.item} workerId={workerId} actions={NO_ACTIONS} />
              : <AssistantTurn key={t.key} segments={t.segments} workerId={workerId} live={live && i === turns.length - 1} />)}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
