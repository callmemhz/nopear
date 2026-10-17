import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

export interface ResizableOptions {
  /** localStorage key the width is persisted under. */
  storageKey: string;
  min: number;
  max: number;
  defaultWidth: number;
}

export function clampWidth(w: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(w)));
}

/** Read a persisted width; missing / garbage / storage errors fall back to the default. Always clamped. */
export function loadWidth(storage: Pick<Storage, 'getItem'> | undefined, o: ResizableOptions): number {
  try {
    const raw = storage?.getItem(o.storageKey);
    const n = raw == null ? NaN : Number(raw);
    return clampWidth(Number.isFinite(n) ? n : o.defaultWidth, o.min, o.max);
  } catch {
    return clampWidth(o.defaultWidth, o.min, o.max);
  }
}

export function saveWidth(storage: Pick<Storage, 'setItem'> | undefined, key: string, w: number): void {
  try { storage?.setItem(key, String(w)); } catch { /* storage full / disabled: width just isn't remembered */ }
}

const ls = (): Storage | undefined => (typeof localStorage === 'undefined' ? undefined : localStorage);

/**
 * Drag-to-resize width for a panel's edge handle (pointer events + pointer capture, so mouse and touch both work).
 * Width is clamped to [min, max], persisted on drag end, and reset to the default by `reset()` (e.g. on double-click).
 */
export function useResizable(o: ResizableOptions) {
  const [width, setWidth] = useState(() => loadWidth(ls(), o));
  const drag = useRef<{ id: number; startX: number; startW: number; w: number } | null>(null);
  const { storageKey, min, max, defaultWidth } = o;

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault(); // no text selection while dragging
    drag.current = { id: e.pointerId, startX: e.clientX, startW: width, w: width };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }, [width]);

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    d.w = clampWidth(d.startW + e.clientX - d.startX, min, max);
    setWidth(d.w);
  }, [min, max]);

  const end = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (d.w !== d.startW) saveWidth(ls(), storageKey, d.w);
  }, [storageKey]);

  const reset = useCallback(() => {
    const w = clampWidth(defaultWidth, min, max);
    setWidth(w);
    saveWidth(ls(), storageKey, w);
  }, [defaultWidth, min, max, storageKey]);

  return {
    width,
    reset,
    handleProps: { onPointerDown, onPointerMove, onPointerUp: end, onPointerCancel: end, onDoubleClick: reset },
  };
}
