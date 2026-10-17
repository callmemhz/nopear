import { memo, useState } from 'react';
import { Icon } from './Icons';

/** Collapsed one-liner 「思考了 · 首行…」; expands to the full reasoning. While streaming shows the latest lines. */
export const ThinkingCard = memo(function ThinkingCard({ text, streaming }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  const first = text.trim().split('\n')[0] ?? '';
  return (
    <div className="text-[14px]">
      <button className="group inline-flex max-w-full items-center gap-1.5 rounded-md text-left text-subtle hover:text-ink"
        aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={`shrink-0 ${streaming ? 'animate-pulse' : ''}`}>{streaming ? '思考中…' : '思考了'}</span>
        {!open && !streaming && first && <span className="min-w-0 truncate text-faint">{first}</span>}
        <Icon name="chevronRight" size={14} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {(open || (streaming && text)) && (
        <div className={`muted mt-1.5 whitespace-pre-wrap border-l-2 border-line pl-3 text-[13.5px] leading-6 ${open ? '' : 'line-clamp-3'}`}>{text}</div>
      )}
    </div>
  );
});
