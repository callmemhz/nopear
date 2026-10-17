import { useEffect, useRef, type ReactNode } from 'react';

/** Close a popover on outside pointer-down or Escape. */
export function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) closeRef.current(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
    document.addEventListener('pointerdown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', down); document.removeEventListener('keydown', key); };
  }, [open]);
  return ref;
}

export function Popover({ open, onClose, trigger, children, className = '' }: {
  open: boolean; onClose: () => void; trigger: ReactNode; children: ReactNode; className?: string;
}) {
  const ref = useDismiss(open, onClose);
  return (
    <div ref={ref} className="relative">
      {trigger}
      {open && <div className={`card absolute z-30 mt-1 p-2 shadow-lg ${className}`}>{children}</div>}
    </div>
  );
}
