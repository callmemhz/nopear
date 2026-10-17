import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IDENTITY, clampPan, wheelFactor, zoomAt, type ZoomState } from '../lib/zoom';

/**
 * In-page image lightbox. Images register with the nearest <ImageGroup> (one per message / tool card) so the viewer
 * can cycle through siblings with ←/→; an image outside any group opens a single-image viewer.
 */

interface Entry { url: string; el: HTMLElement }
interface GroupApi {
  register(id: number, entry: Entry): () => void;
  open(id: number): void;
}
const GroupCtx = createContext<GroupApi | null>(null);
let nextId = 1;

interface Point { x: number; y: number }
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
/** Presses on the viewer's buttons/links are clicks, not zoom/pan gestures. */
const isControl = (t: EventTarget | null) => t instanceof Element && !!t.closest('button, a');
/** Movement (px) after which a press counts as a drag — a drag never closes the viewer. */
const DRAG_SLOP = 4;
const KEY_STEP = 1.25;
const DBLCLICK_SCALE = 2.5;

/**
 * Full-screen overlay: dark backdrop, image fit to screen; Esc / backdrop / ✕ close, ←/→ cycle when there are several.
 * Zoom (1×–8×): wheel / trackpad pinch around the cursor, double-click toggles 2.5×, `+`/`=`/`-`/`0` keys, two-finger
 * pinch on touch; drag pans while zoomed. While zoomed (or after a drag) a backdrop click does not close.
 */
export function ImageViewer({ urls, index, onIndex, onClose }: {
  urls: string[]; index: number; onIndex: (i: number) => void; onClose: () => void;
}) {
  const n = urls.length;
  const boxRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [zoom, setZoomState] = useState<ZoomState>(IDENTITY);
  const zoomRef = useRef(zoom); // latest value for native listeners / successive events within one tick
  const setZoom = useCallback((z: ZoomState) => { zoomRef.current = z; setZoomState(z); }, []);
  const [dragging, setDragging] = useState(false);
  /** Active pointers + whether the current press moved / started on the bare backdrop (decides if its click closes). */
  const gesture = useRef({ pointers: new Map<number, Point>(), start: null as Point | null, moved: false, onBackdrop: null as boolean | null });

  const measure = useCallback(() => {
    const box = boxRef.current, img = imgRef.current;
    const r = box?.getBoundingClientRect();
    return {
      left: r?.left ?? 0, top: r?.top ?? 0,
      viewport: { width: box?.clientWidth ?? 0, height: box?.clientHeight ?? 0 },
      img: { width: img?.offsetWidth ?? 0, height: img?.offsetHeight ?? 0 }, // layout (1×) size, unaffected by transform
    };
  }, []);
  /** Zoom by `factor` around a client point (default: viewport centre). */
  const zoomBy = useCallback((factor: number, clientX?: number, clientY?: number, from: ZoomState = zoomRef.current) => {
    const m = measure();
    const cx = clientX === undefined ? m.viewport.width / 2 : clientX - m.left;
    const cy = clientY === undefined ? m.viewport.height / 2 : clientY - m.top;
    setZoom(zoomAt(from, factor, cx, cy, m.viewport, m.img));
  }, [measure, setZoom]);
  const reset = useCallback(() => setZoom(IDENTITY), [setZoom]);
  const go = useCallback((d: number) => { if (n > 1) { reset(); onIndex((index + d + n) % n); } }, [index, n, onIndex, reset]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const plain = !e.ctrlKey && !e.metaKey && !e.altKey; // leave Ctrl/⌘ +/-/0 to the browser's own page zoom
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
      else if (plain && (e.key === '+' || e.key === '=')) { e.preventDefault(); zoomBy(KEY_STEP); }
      else if (plain && e.key === '-') { e.preventDefault(); zoomBy(1 / KEY_STEP); }
      else if (plain && e.key === '0') { e.preventDefault(); reset(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [go, onClose, reset, zoomBy]);

  const url = urls[index];
  // React's onWheel is passive, so preventDefault (no page scroll / browser pinch-zoom) needs a native listener.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomBy(wheelFactor(e.deltaY, e.deltaMode, e.ctrlKey), e.clientX, e.clientY);
    };
    box.addEventListener('wheel', onWheel, { passive: false });
    return () => box.removeEventListener('wheel', onWheel);
  }, [zoomBy, url]);

  if (!url) return null;
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();
  const zoomed = zoom.scale > 1;

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if ((e.pointerType === 'mouse' && e.button !== 0) || isControl(e.target)) return;
    const g = gesture.current;
    if (g.pointers.size === 0) { g.moved = false; g.onBackdrop = e.target === e.currentTarget; g.start = { x: e.clientX, y: e.clientY }; }
    g.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (g.pointers.size > 1) g.moved = true; // a pinch is never a click
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    if (zoomRef.current.scale > 1) setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    const prev = g.pointers.get(e.pointerId);
    if (!prev) return;
    const cur = { x: e.clientX, y: e.clientY };
    if (g.start && dist(cur, g.start) > DRAG_SLOP) g.moved = true;
    g.pointers.set(e.pointerId, cur);
    const s = zoomRef.current;
    const other = [...g.pointers].find(([id]) => id !== e.pointerId)?.[1];
    if (other) {
      // two-finger pinch: the image point under the fingers' midpoint follows it while the scale tracks their spread
      const d0 = dist(prev, other);
      if (d0 <= 0) return;
      const m0 = mid(prev, other), m1 = mid(cur, other);
      zoomBy(dist(cur, other) / d0, m1.x, m1.y, { ...s, x: s.x + m1.x - m0.x, y: s.y + m1.y - m0.y });
    } else if (s.scale > 1) {
      const m = measure();
      setZoom(clampPan({ ...s, x: s.x + cur.x - prev.x, y: s.y + cur.y - prev.y }, m.viewport, m.img));
    }
  };
  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    g.pointers.delete(e.pointerId);
    if (g.pointers.size === 0) setDragging(false);
  };
  const onBackdropClick = (e: MouseEvent<HTMLDivElement>) => {
    const g = gesture.current;
    const { moved, onBackdrop } = g;
    g.moved = false; g.onBackdrop = null;
    if (moved || zoomRef.current.scale > 1) return;
    // with pointer capture the click lands on the backdrop even when the press began on the image — use where it began
    if (onBackdrop ?? e.target === e.currentTarget) onClose();
  };
  const onDoubleClick = (e: MouseEvent<HTMLDivElement>) => {
    if (isControl(e.target)) return;
    if (zoomRef.current.scale > 1) reset(); else zoomBy(DBLCLICK_SCALE, e.clientX, e.clientY);
  };

  const ctl = 'grid place-items-center rounded-full bg-black/50 text-white hover:bg-black/70';
  return createPortal(
    <div ref={boxRef} role="dialog" aria-modal="true" aria-label="图片预览" data-testid="image-viewer"
      className="fixed inset-0 z-[100] flex touch-none items-center justify-center overflow-hidden bg-black/85 p-4 sm:p-10"
      style={{ cursor: zoomed ? (dragging ? 'grabbing' : 'grab') : undefined }}
      onClick={onBackdropClick} onDoubleClick={onDoubleClick}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}>
      <img ref={imgRef} src={url} alt="" onClick={stop} draggable={false} title="滚轮缩放 · 双击放大/还原"
        style={{ transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`, transformOrigin: 'center' }}
        className="max-h-full max-w-full select-none object-contain shadow-2xl" />
      <button aria-label="关闭" title="关闭 (Esc)" onClick={(e) => { stop(e); onClose(); }} className={`${ctl} absolute right-4 top-4 h-9 w-9 text-lg`}>✕</button>
      {n > 1 && (
        <>
          <button aria-label="上一张" title="上一张 (←)" onClick={(e) => { stop(e); go(-1); }} className={`${ctl} absolute left-4 top-1/2 h-11 w-11 -translate-y-1/2 text-2xl`}>‹</button>
          <button aria-label="下一张" title="下一张 (→)" onClick={(e) => { stop(e); go(1); }} className={`${ctl} absolute right-4 top-1/2 h-11 w-11 -translate-y-1/2 text-2xl`}>›</button>
        </>
      )}
      <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-full bg-black/50 px-3 py-1 text-xs text-white" onClick={stop}>
        {n > 1 && <span>{index + 1} / {n}</span>}
        {zoomed && (
          <>
            <span data-testid="zoom-readout" className="tabular-nums">{Math.round(zoom.scale * 100)}%</span>
            <button title="重置缩放 (0)" onClick={(e) => { stop(e); reset(); }} className="underline hover:text-zinc-200">重置</button>
          </>
        )}
        {/* browsers refuse top-level navigation to data: URLs, so only offer the link for blob:/http(s) images */}
        {!url.startsWith('data:') && <a href={url} target="_blank" rel="noreferrer" className="underline hover:text-zinc-200">在新标签页打开</a>}
      </div>
    </div>,
    document.body,
  );
}

/** Groups the images rendered inside it (in DOM order) for the viewer's ←/→ navigation. */
export function ImageGroup({ children }: { children: ReactNode }) {
  const entries = useRef(new Map<number, Entry>());
  const [openId, setOpenId] = useState<number | null>(null);
  const [, bump] = useState(0);
  const api = useMemo<GroupApi>(() => ({
    register(id, entry) {
      entries.current.set(id, entry);
      bump((v) => v + 1);
      return () => { entries.current.delete(id); bump((v) => v + 1); };
    },
    open: (id) => setOpenId(id),
  }), []);
  let viewer: ReactNode = null;
  if (openId !== null) {
    const list = [...entries.current.entries()].sort(([, a], [, b]) =>
      a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
    const index = list.findIndex(([id]) => id === openId);
    if (index >= 0) {
      viewer = <ImageViewer urls={list.map(([, e]) => e.url)} index={index}
        onIndex={(i) => setOpenId(list[i]![0])} onClose={() => setOpenId(null)} />;
    }
  }
  return <GroupCtx.Provider value={api}>{children}{viewer}</GroupCtx.Provider>;
}

/** A thumbnail that opens the lightbox on click (joins the nearest ImageGroup, else views alone). */
export function ViewableImage({ src, className }: { src: string; className?: string }) {
  const group = useContext(GroupCtx);
  const ref = useRef<HTMLImageElement>(null);
  const [id] = useState(() => nextId++);
  const [alone, setAlone] = useState(false);
  useEffect(() => {
    if (!group || !ref.current) return;
    return group.register(id, { url: src, el: ref.current });
  }, [group, id, src]);
  return (
    <>
      <img ref={ref} src={src} alt="" title="点击查看大图" className={`cursor-zoom-in ${className ?? ''}`}
        onClick={() => (group ? group.open(id) : setAlone(true))} />
      {alone && <ImageViewer urls={[src]} index={0} onIndex={() => {}} onClose={() => setAlone(false)} />}
    </>
  );
}
