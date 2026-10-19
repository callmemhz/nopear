import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { parseBtw, sessionKey, type Attachment } from '@nopear/protocol';
import { engine, useEngine } from '../engine';
import { attachmentBytes } from '../lib/compress';
import { formatBytes } from '../lib/format';
import { usePasteAttachments } from '../lib/usePasteAttachments';
import { ImageGroup, ViewableImage } from './ImageViewer';
import { reportError } from '../routes/root';
import { Icon, Spinner } from './Icons';
import { QueueList } from './QueueList';

/** 📎 button (or a round ＋ icon when `compact`): hands picked files to the shared paste/drop pipeline (`usePasteAttachments().addFiles`). */
export function AttachmentPicker({ busy, onFiles, compact }: { busy: boolean; onFiles: (files: File[]) => void | Promise<void>; compact?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const pick = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    void onFiles(Array.from(files));
    if (input.current) input.current.value = '';
  };
  return (
    <>
      <input ref={input} type="file" multiple hidden onChange={(e) => pick(e.target.files)} />
      {compact ? (
        <button type="button" className="btn-icon h-8 w-8" disabled={busy} onClick={() => input.current?.click()}
          title="添加图片或文件（也可直接粘贴或拖入）" aria-label="添加附件">
          {busy ? <Spinner /> : <Icon name="plus" size={18} />}
        </button>
      ) : (
        <button type="button" className="btn-ghost px-2 text-xs" disabled={busy} onClick={() => input.current?.click()} title="添加图片或文件（也可直接粘贴或拖入）">
          {busy ? '处理中…' : '📎 附件'}
        </button>
      )}
    </>
  );
}

function ImageThumb({ a, onRemove }: { a: Attachment; onRemove: () => void }) {
  const src = useMemo(() => `data:${a.mediaType};base64,${a.dataBase64}`, [a.mediaType, a.dataBase64]);
  return (
    <span className="relative inline-block" title={`${a.name} · ${formatBytes(attachmentBytes(a))}`}>
      <ViewableImage src={src} className="h-14 w-14 rounded-md border border-zinc-200 object-cover dark:border-zinc-700" />
      <button type="button" aria-label={`移除 ${a.name}`} onClick={onRemove}
        className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full bg-zinc-800/80 text-[10px] leading-none text-white hover:bg-red-600">✕</button>
    </span>
  );
}

/** Attached items: images as clickable thumbnails (in-page viewer, ←/→ across them), other files as name + size chips. */
export function AttachmentChips({ items, onRemove }: { items: Attachment[]; onRemove: (i: number) => void }) {
  if (items.length === 0) return null;
  return (
    <ImageGroup>
      <div className="flex flex-wrap items-center gap-2">
        {items.map((a, i) => a.kind === 'image' ? (
          <ImageThumb key={i} a={a} onRemove={() => onRemove(i)} />
        ) : (
          <span key={i} className="chip gap-1.5 py-1">
            📄 {a.name} <span className="muted">{formatBytes(attachmentBytes(a))}</span>
            <button type="button" aria-label={`移除 ${a.name}`} className="hover:text-red-500" onClick={() => onRemove(i)}>×</button>
          </span>
        ))}
      </div>
    </ImageGroup>
  );
}

/** Bottom input card: queued messages (QueueList), auto-growing textarea, attachments (📎 / paste / drop), `toolbar`
 *  (model pickers), send / stop. While running: Enter / ➤ = 发送（排队）, ⌘/Ctrl+Enter / 「插队发送」 = steer. */
export function Composer({ workerId, sessionId, running, disabled, toolbar }: {
  workerId: string; sessionId: string; running: boolean; disabled?: boolean; toolbar?: ReactNode;
}) {
  const key = sessionKey(workerId, sessionId);
  const draft = useEngine((s) => s.drafts[key] ?? '');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const ta = useRef<HTMLTextAreaElement>(null);
  const attach = usePasteAttachments({
    current: attachments,
    onAdd: (a) => setAttachments((prev) => [...prev, ...a]),
    onError: (m) => reportError(new Error(m)),
  });
  // auto-grow up to ~40% of the viewport, then scroll
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    const max = Math.max(160, Math.round(window.innerHeight * 0.4));
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [draft]);

  const send = (steer = false) => {
    if (disabled) return;
    const text = draft.trim();
    if (!text && attachments.length === 0) return;
    const btw = parseBtw(text);
    if (btw !== null) { // side question: answered next to the session, never sent into it (attachments stay for later)
      if (!btw) return;
      engine.setDraft(workerId, sessionId, '');
      void engine.btw(workerId, sessionId, btw);
      return;
    }
    const opts: { attachments?: Attachment[]; delivery?: 'followUp' | 'steer' } = {};
    if (attachments.length) opts.attachments = attachments;
    if (running) opts.delivery = steer ? 'steer' : 'followUp';
    engine.setDraft(workerId, sessionId, '');
    setAttachments([]);
    engine.send(workerId, sessionId, text, opts).catch(reportError);
  };
  const canSend = !disabled && (draft.trim() !== '' || attachments.length > 0);
  const sendLabel = running ? '发送（排队）' : '发送';
  const mod = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

  return (
    <div className="px-4 pb-4 pt-1">
      <QueueList workerId={workerId} sessionId={sessionId} />
      <div data-testid="attach-drop" data-dragging={attach.dragging} {...attach.dropProps}
        className={`mx-auto max-w-[720px] rounded-2xl border border-line bg-elev shadow-[0_2px_12px_rgba(31,30,29,0.05)] transition-colors focus-within:border-line-strong ${attach.dragging ? 'ring-2 ring-accent/40' : ''}`}>
        {attachments.length > 0 && <div className="px-3 pt-3"><AttachmentChips items={attachments} onRemove={(i) => setAttachments((prev) => prev.filter((_, j) => j !== i))} /></div>}
        <textarea
          ref={ta}
          className="block max-h-[40vh] min-h-[48px] w-full resize-none bg-transparent px-4 pt-3 text-[15px] leading-6 text-ink outline-none placeholder:text-faint"
          rows={1}
          value={draft}
          disabled={disabled}
          aria-label="消息"
          placeholder={disabled ? '机器离线' : running ? `运行中 —— Enter 排队发送，${mod}+Enter 插队；/btw 顺便问一句不打断` : '发消息（Enter 发送，Shift+Enter 换行；/btw 顺便问一句）'}
          onChange={(e) => engine.setDraft(workerId, sessionId, e.target.value)}
          onPaste={attach.onPaste}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
            e.preventDefault();
            send(running && (e.metaKey || e.ctrlKey));
          }}
        />
        <div className="flex items-center gap-1 px-2 pb-2 pt-1">
          <AttachmentPicker compact busy={attach.busy} onFiles={attach.addFiles} />
          {toolbar}
          <div className="flex-1" />
          {running && canSend && (
            <button type="button" className="rounded-full px-2.5 py-1 text-[12.5px] text-subtle transition-colors hover:bg-hover hover:text-ink"
              aria-label="插队发送" title={`插队：当前工具调用结束后立即送达，而不是等本轮结束（${mod}+Enter）`} onClick={() => send(true)}>
              插队发送
            </button>
          )}
          {running && (
            <button className="grid h-8 w-8 place-items-center rounded-full bg-ink text-app transition-opacity hover:opacity-85" title="中断" aria-label="中断"
              onClick={() => engine.interrupt(workerId, sessionId).catch(reportError)}>
              <Icon name="stop" size={14} className="fill-current" />
            </button>
          )}
          {(!running || canSend) && (
            <button className="grid h-8 w-8 place-items-center rounded-full bg-accent text-white transition-opacity hover:opacity-90 disabled:opacity-40"
              disabled={!canSend} onClick={() => send()} title={running ? '发送（排队）：本轮结束后送达（Enter）' : sendLabel} aria-label={sendLabel}>
              <Icon name="arrowUp" size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
