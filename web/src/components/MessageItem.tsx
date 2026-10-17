import { memo, useState } from 'react';
import { isLongText, noticeView, type NoticeTone, type NoticeView, type ViewItem } from '@nopear/core';
import { Markdown } from './Markdown';
import { BlobImage } from './BlobImage';
import { ImageGroup, ViewableImage } from './ImageViewer';
import { Icon } from './Icons';

export interface MessageActions {
  onRewind?: (messageId: string) => void;
  onFork?: (messageId: string) => void;
  onRetry?: (clientMsgId: string) => void;
  onReedit?: (clientMsgId: string) => void;
}

/** Re-exported for existing callers; the rule is shared with mobile via @nopear/core. */
export { isLongText };

function UserBubble({ item, workerId }: { item: ViewItem; workerId: string }) {
  const m = item.message;
  const p = item.pending;
  const text = m.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
  const long = isLongText(text);
  const [expanded, setExpanded] = useState(false);
  const collapsed = long && !expanded;
  return (
    <div className={`max-w-[85%] rounded-2xl bg-bubble px-4 py-2.5 text-[15px] leading-7 ${p?.status === 'failed' ? 'ring-1 ring-red-400' : ''} ${p?.status === 'sending' ? 'opacity-70' : ''}`}>
      <div data-testid="user-text" data-collapsed={collapsed}
        className={`whitespace-pre-wrap break-words ${collapsed ? 'max-h-[21rem] overflow-hidden [mask-image:linear-gradient(to_bottom,black_75%,transparent)]' : ''}`}>
        <ImageGroup>
          {m.blocks.map((b, i) => b.type === 'text' ? <span key={i}>{b.text}</span>
            : b.type === 'image' ? (b.blob.startsWith('data:') ? <ViewableImage key={i} src={b.blob} className="mt-1 max-h-48 rounded-lg" /> : <BlobImage key={i} workerId={workerId} hash={b.blob} mediaType={b.mediaType} />)
            : null)}
        </ImageGroup>
      </div>
      {long && (
        <button className="mt-1 text-[13px] font-medium text-subtle hover:text-ink" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? '收起' : '展开'}
        </button>
      )}
    </div>
  );
}

const TONE: Record<NoticeTone, { icon: string; cls: string }> = {
  ok: { icon: '✓', cls: 'text-emerald-600 dark:text-emerald-400' },
  error: { icon: '✕', cls: 'text-red-500' },
  warn: { icon: '!', cls: 'text-amber-600 dark:text-amber-400' },
  info: { icon: 'i', cls: 'text-subtle' },
};

/** Background-subagent notification: one slim line (icon + heading + summary); click expands the full markdown. */
function NoticeCard({ v }: { v: NoticeView }) {
  const [open, setOpen] = useState(false);
  const t = TONE[v.tone];
  return (
    <div data-testid="notice-card" className="my-2 rounded-xl border panel text-[13px]">
      <button className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-hover" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-current text-[10px] font-bold ${t.cls}`}>{t.icon}</span>
        <span className="shrink-0 font-medium text-ink">{v.heading}</span>
        {v.summary && <span className="muted min-w-0 truncate">{v.summary}</span>}
        <Icon name="chevronRight" size={14} className={`ml-auto shrink-0 text-subtle transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && <div className="border-t border-line px-3.5 py-2.5"><Markdown text={v.text} /></div>}
    </div>
  );
}

/** User and system messages (assistant output is rendered per turn by AssistantTurn). */
export const MessageItem = memo(function MessageItem({ item, workerId, actions }: { item: ViewItem; workerId: string; actions: MessageActions }) {
  const m = item.message;
  if (m.role === 'user') {
    const p = item.pending;
    const confirmed = !m.id.startsWith('local:');
    return (
      <div className="group flex flex-col items-end gap-1 pt-4">
        <UserBubble item={item} workerId={workerId} />
        <div className="flex h-6 items-center gap-1 text-[12px]">
          {p?.status === 'sending' && <span className="muted">发送中…</span>}
          {p?.status === 'sent' && <span className="muted">已送达，等待回显</span>}
          {p?.status === 'failed' && (
            <>
              <span className="text-red-500">发送失败{p.error ? `：${p.error}` : ''}</span>
              <button className="underline" onClick={() => actions.onRetry?.(p.clientMsgId)}>重发</button>
              <button className="underline" onClick={() => actions.onReedit?.(p.clientMsgId)}>重新编辑</button>
            </>
          )}
          {confirmed && (
            <span className="muted flex gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
              <button className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-hover hover:text-ink" title="撤回到这条消息之前，并把它放回输入框" onClick={() => actions.onRewind?.(m.id)}>
                <Icon name="undo" size={13} />撤回
              </button>
              <button className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-hover hover:text-ink" title="从这里分叉出新会话" onClick={() => actions.onFork?.(m.id)}>
                <Icon name="fork" size={13} />分叉
              </button>
            </span>
          )}
        </div>
      </div>
    );
  }
  const nv = noticeView(m);
  if (nv) return <NoticeCard v={nv} />;
  // system (and any stray role) — a quiet dashed note
  return (
    <div className="muted my-3 rounded-xl border border-dashed panel px-3.5 py-2.5 text-[13px]">
      <ImageGroup>
        {m.blocks.map((b, i) => b.type === 'text' ? (b.text ? <Markdown key={i} text={b.text} /> : null)
          : b.type === 'image' ? (b.blob.startsWith('data:') ? <ViewableImage key={i} src={b.blob} className="max-h-80 rounded-lg border panel" /> : <BlobImage key={i} workerId={workerId} hash={b.blob} mediaType={b.mediaType} />)
          : null)}
      </ImageGroup>
    </div>
  );
}, sameItem);

function shallowEq(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  if (a === b) return true;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => a[k] === b[k]);
}
/** selectMessages() rebuilds ViewItems each render; compare their parts by reference instead. */
export function sameItem(
  p: { item: ViewItem; workerId: string; actions: MessageActions },
  n: { item: ViewItem; workerId: string; actions: MessageActions },
): boolean {
  return p.workerId === n.workerId && p.actions === n.actions
    && p.item.message === n.item.message && p.item.pending === n.item.pending
    && shallowEq(p.item.results, n.item.results) && shallowEq(p.item.progress, n.item.progress)
    && sameLists(p.item.resultImages, n.item.resultImages) && sameLists(p.item.resultFiles, n.item.resultFiles);
}
/** resultImages/resultFiles arrays are rebuilt by selectMessages(); their blocks are stable, so compare element-wise. */
function sameLists<T>(a: Record<string, T[]>, b: Record<string, T[]>): boolean {
  if (a === b) return true;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => { const x = a[k]!, y = b[k]; return !!y && x.length === y.length && x.every((im, i) => im === y[i]); });
}
