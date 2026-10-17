import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Block } from '@nopear/protocol';
import { FILE_ICONS, fileBlobType, fileKind, type FileKind } from '@nopear/core';
import { engine } from '../engine';
import { formatBytes } from '../lib/format';
import { Markdown } from './Markdown';
import { ImageGroup, ViewableImage } from './ImageViewer';
import { Spinner } from './Icons';

type FileBlock = Extract<Block, { type: 'file' }>;

/** Text / markdown previews decode at most this many bytes (the download keeps the whole file). */
export const TEXT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

/** Kinds whose blob URL may be opened as a top-level tab: html and svg could run script in the app's origin. */
const NEW_TAB: readonly FileKind[] = ['video', 'audio', 'image', 'pdf', 'markdown', 'text'];

interface Loaded { url: string; text?: string; truncated?: boolean }
type LoadState = { status: 'idle' } | { status: 'loading' } | { status: 'error'; error: string } | { status: 'ready'; data: Loaded };

function Preview({ kind, block, data }: { kind: FileKind; block: FileBlock; data: Loaded }) {
  const label = block.title || block.name;
  const cap = data.truncated && (
    <div className="muted mb-2 text-[12px]">文件较大，仅显示前 {formatBytes(TEXT_PREVIEW_MAX_BYTES)}，完整内容请下载。</div>
  );
  switch (kind) {
    case 'video': return <video controls src={data.url} className="mx-auto max-h-[75vh] max-w-full bg-black" />;
    case 'audio': return <audio controls src={data.url} className="w-full" />;
    case 'image':
      return <ImageGroup><ViewableImage src={data.url} className="mx-auto max-h-[75vh] max-w-full rounded-md" /></ImageGroup>;
    // svg via <img> only: scripts never run there (a top-level svg document would run them in our origin)
    case 'svg': return <img src={data.url} alt={label} className="mx-auto max-h-[75vh] max-w-full rounded-md bg-white" />;
    case 'html':
      return (
        <>
          <div className="muted mb-2 text-[12px]">网页在沙箱中运行（不能访问本站的登录态与数据）。</div>
          {/* NO allow-same-origin: the page gets an opaque origin and cannot reach our storage/keys */}
          <iframe sandbox="allow-scripts" src={data.url} title={label} className="h-[75vh] w-full rounded-md border panel bg-white" />
        </>
      );
    case 'pdf': return <iframe src={data.url} title={label} className="h-[75vh] w-full rounded-md border panel" />;
    case 'markdown': return <>{cap}<Markdown text={data.text ?? ''} /></>;
    case 'text':
      return (
        <>
          {cap}
          <pre className="max-h-[75vh] overflow-auto whitespace-pre rounded-md bg-code p-3 font-mono text-[12px] leading-5">{data.text}</pre>
        </>
      );
    default: return <div className="muted py-10 text-center text-[14px]">该类型不支持预览，请下载后查看。</div>;
  }
}

function PreviewModal({ kind, block, state, onClose }: { kind: FileKind; block: FileBlock; state: LoadState; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const url = state.status === 'ready' ? state.data.url : null;
  const btn = 'rounded-md px-2 py-1 text-[13px] hover:bg-hover hover:text-ink';
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={`文件预览：${block.name}`} data-testid="file-preview"
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-2 sm:p-8" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="card flex max-h-full w-full max-w-5xl flex-col overflow-hidden shadow-2xl">
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <span aria-hidden>{FILE_ICONS[kind]}</span>
          <span className="min-w-0 truncate font-medium text-ink">{block.title || block.name}</span>
          <span className="muted shrink-0 text-[12px]">{formatBytes(block.size)}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1 text-subtle">
            {url && <a href={url} download={block.name} className={btn}>下载</a>}
            {url && NEW_TAB.includes(kind) && <a href={url} target="_blank" rel="noopener noreferrer" className={btn}>在新标签页打开</a>}
            <button aria-label="关闭" title="关闭 (Esc)" onClick={onClose} className={`${btn} text-[15px]`}>✕</button>
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-3">
          {state.status === 'ready' ? <Preview kind={kind} block={block} data={state.data} />
            : state.status === 'error' ? <div className="py-10 text-center text-[14px] text-red-500">文件加载失败：{state.error}</div>
            : <div className="flex items-center justify-center gap-2 py-10 text-subtle"><Spinner className="text-accent" />正在加载…</div>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * A file the agent sent (send_file): icon, title/name, size, note. Click opens an in-page preview; the bytes are fetched
 * lazily through the (E2E) `blobs.get` RPC on first open and kept as one object URL until the card unmounts.
 */
export const FileCard = memo(function FileCard({ block, workerId }: { block: FileBlock; workerId: string }) {
  const kind = fileKind(block.mediaType);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<LoadState>({ status: 'idle' });
  const urlRef = useRef<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
    };
  }, []);

  const load = () => {
    if (state.status === 'loading' || state.status === 'ready') return;
    setState({ status: 'loading' });
    engine.rpc(workerId, 'blobs.get', { hash: block.blob }).then((r) => {
      if (!alive.current) return;
      const bytes = r.bytes;
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: fileBlobType(kind, block.mediaType) }));
      urlRef.current = url;
      const data: Loaded = { url };
      if (kind === 'text' || kind === 'markdown') {
        data.truncated = bytes.byteLength > TEXT_PREVIEW_MAX_BYTES;
        data.text = new TextDecoder().decode(bytes.subarray(0, TEXT_PREVIEW_MAX_BYTES));
      }
      setState({ status: 'ready', data });
    }, (e: unknown) => {
      if (alive.current) setState({ status: 'error', error: e instanceof Error ? e.message : String(e) });
    });
  };
  const close = useCallback(() => setOpen(false), []);

  return (
    <>
      <button data-testid="file-card" onClick={() => { setOpen(true); load(); }} title="点击预览"
        className="flex w-full max-w-md items-center gap-3 rounded-xl border px-3 py-2.5 text-left panel hover:bg-hover">
        <span aria-hidden className="text-[22px] leading-none">{FILE_ICONS[kind]}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-medium text-ink">{block.title || block.name}</span>
          <span className="muted block truncate text-[12px]">{block.title ? `${block.name} · ` : ''}{formatBytes(block.size)}</span>
          {block.note && <span className="muted block truncate text-[12px]">{block.note}</span>}
        </span>
      </button>
      {open && <PreviewModal kind={kind} block={block} state={state} onClose={close} />}
    </>
  );
});
