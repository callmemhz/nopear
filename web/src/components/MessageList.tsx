import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { buildTurns, selectMessages, type TimelineState } from '@nopear/core';
import { engine } from '../engine';
import { MessageItem, type MessageActions } from './MessageItem';
import { AssistantTurn } from './AssistantTurn';
import { reportError } from '../routes/root';

export function MessageList({ workerId, sessionId, timeline, actions }: {
  workerId: string; sessionId: string; timeline: TimelineState; actions: MessageActions;
}) {
  const items = useMemo(() => selectMessages(timeline), [timeline]);
  const turns = useMemo(() => buildTurns(items), [items]);
  const live = timeline.session?.status === 'running';
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const prevHeight = useRef<number | null>(null);
  const [loading, setLoading] = useState(false);

  const onScroll = () => {
    const el = box.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    if (prevHeight.current !== null) { el.scrollTop += el.scrollHeight - prevHeight.current; prevHeight.current = null; }
    else if (stick.current) el.scrollTop = el.scrollHeight;
  }, [items]);
  useEffect(() => { stick.current = true; }, [sessionId]);

  const earlier = async () => {
    if (box.current) prevHeight.current = box.current.scrollHeight;
    setLoading(true);
    try { await engine.loadEarlier(workerId, sessionId); } catch (e) { prevHeight.current = null; reportError(e); } finally { setLoading(false); }
  };

  return (
    <div ref={box} onScroll={onScroll} className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[720px] px-6 pb-6 pt-4">
        {timeline.hasMore && timeline.messages.length > 0 && (
          <div className="flex justify-center pb-2">
            <button className="btn-ghost text-xs" disabled={loading} onClick={() => void earlier()}>{loading ? '加载中…' : '加载更早的消息'}</button>
          </div>
        )}
        {items.length === 0 && <div className="muted py-16 text-center text-sm">{timeline.cursor ? '还没有消息' : '同步中…'}</div>}
        {turns.map((t, i) => t.kind === 'message'
          ? <MessageItem key={t.key} item={t.item} workerId={workerId} actions={actions} />
          : <AssistantTurn key={t.key} segments={t.segments} workerId={workerId} live={live && i === turns.length - 1} />)}
      </div>
    </div>
  );
}
