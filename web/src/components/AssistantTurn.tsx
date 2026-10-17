import { memo, useState } from 'react';
import type { Block } from '@nopear/protocol';
import { entryState, sameEntries, summarizeTools, type GroupEntry, type Segment } from '@nopear/core';
import { Markdown } from './Markdown';
import { ThinkingCard } from './ThinkingCard';
import { ToolCard } from './ToolCard';
import { BlobImage } from './BlobImage';
import { FileCard } from './FileCard';
import { ImageGroup, ViewableImage } from './ImageViewer';
import { Icon, Spinner } from './Icons';

type ImageBlock = Extract<Block, { type: 'image' }>;

function GroupEntryView({ e, workerId, live }: { e: GroupEntry; workerId: string; live: boolean }) {
  if (e.kind === 'thinking') return <ThinkingCard text={e.text} streaming={e.streaming} />;
  return <ToolCard name={e.name} input={e.input} result={e.result} progress={e.progress} streaming={e.streaming} live={live}
    images={e.images} workerId={workerId} />;
}

/**
 * Consecutive tool calls as one summary line 「运行了 4 条命令（1 条失败）›」; click expands the ToolCard list.
 * While a tool runs: spinner + the last running card is shown even when collapsed.
 */
export const ToolGroup = memo(function ToolGroup({ entries, workerId, live }: { entries: GroupEntry[]; workerId: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  const s = summarizeTools(entries, live);
  let active = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.kind === 'tool' && entryState(e, live) === 'running') { active = i; break; }
  }
  const images: ImageBlock[] = open ? [] : entries.flatMap((e) => (e.kind === 'tool' && e.images) || []);
  return (
    <div data-testid="tool-group" className="text-[14px]">
      <button className="inline-flex max-w-full items-center gap-1.5 rounded-md text-left text-subtle hover:text-ink"
        aria-expanded={open} onClick={() => setOpen(!open)}>
        {s.running && <Spinner className="text-accent" />}
        <span className="truncate">{s.text || '调用了工具'}</span>
        <Icon name="chevronRight" size={14} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open ? (
        <div className="mt-2 space-y-1.5 border-l-2 border-line pl-3">
          {entries.map((e) => <GroupEntryView key={e.key} e={e} workerId={workerId} live={live} />)}
        </div>
      ) : (
        <>
          {active >= 0 && <div className="mt-2"><GroupEntryView e={entries[active]!} workerId={workerId} live={live} /></div>}
          {images.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2 [&_img]:max-h-48">
              {images.map((im, i) => <BlobImage key={i} workerId={workerId} hash={im.blob} mediaType={im.mediaType} />)}
            </div>
          )}
        </>
      )}
    </div>
  );
}, (p, n) => p.workerId === n.workerId && p.live === n.live && sameEntries(p.entries, n.entries));

const ImageSeg = memo(function ImageSeg({ block, workerId }: { block: ImageBlock; workerId: string }) {
  return block.blob.startsWith('data:')
    ? <ViewableImage src={block.blob} className="max-h-80 rounded-lg border panel" />
    : <BlobImage workerId={workerId} hash={block.blob} mediaType={block.mediaType} />;
});

/** One assistant turn: plain markdown text, thinking one-liners, grouped tool calls, images, sent files, errors. */
export function AssistantTurn({ segments, workerId, live }: { segments: Segment[]; workerId: string; live: boolean }) {
  return (
    <div className="space-y-3 py-3">
      <ImageGroup>
        {segments.map((seg) => {
          switch (seg.kind) {
            case 'text': return <Markdown key={seg.key} text={seg.text} />;
            case 'thinking': return <ThinkingCard key={seg.key} text={seg.text} streaming={seg.streaming} />;
            case 'tools': return <ToolGroup key={seg.key} entries={seg.entries} workerId={workerId} live={live} />;
            case 'image': return <ImageSeg key={seg.key} block={seg.block} workerId={workerId} />;
            case 'file': return <FileCard key={seg.key} block={seg.block} workerId={workerId} />;
            case 'error': return <div key={seg.key} className="rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-600 dark:bg-red-950/40 dark:text-red-400">⚠ {seg.text}</div>;
            case 'typing': return <div key={seg.key} className="flex items-center gap-2 text-subtle"><Spinner className="text-accent" /><span className="text-[14px]">正在回复…</span></div>;
          }
        })}
      </ImageGroup>
    </div>
  );
}
