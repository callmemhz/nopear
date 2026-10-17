import { useState } from 'react';
import type { Block } from '@nopear/protocol';
import { toolSummary } from '../lib/tools';
import { BlobImage } from './BlobImage';
import { ImageGroup } from './ImageViewer';
import { Icon } from './Icons';

type Result = Extract<Block, { type: 'tool_result' }>;
type Image = Extract<Block, { type: 'image' }>;

export function ToolCard({ name, input, result, progress, streaming, live, images, workerId }: {
  name: string; input?: unknown; result?: Result; progress?: string; streaming?: boolean; images?: Image[]; workerId?: string;
  /** The session is running: a call without a result counts as running. */
  live?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const running = !result && (progress !== undefined || streaming || live);
  const state = result ? (result.isError ? 'error' : 'ok') : running ? 'running' : 'pending';
  const dot = { ok: 'bg-emerald-500', error: 'bg-red-500', running: 'bg-amber-500 animate-pulse', pending: 'bg-line-strong' }[state];
  const summary = input !== undefined ? toolSummary(name, input) : '';
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-elev text-xs">
      <button className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-hover" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
        <span className="font-mono font-medium">{name}</span>
        <span className="muted min-w-0 flex-1 truncate font-mono">{summary}</span>
        <Icon name="chevronRight" size={14} className={`text-subtle transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {running && progress && !open && (
        <pre className="max-h-24 overflow-hidden border-t panel bg-code px-3 py-1.5 font-mono text-[11px] text-subtle">{progress.slice(-600)}</pre>
      )}
      {open && (
        <div className="space-y-2 border-t panel px-3 py-2">
          {input !== undefined && (
            <div><div className="muted mb-1">输入</div>
              <pre className="max-h-64 overflow-auto rounded-lg bg-code p-2 font-mono text-[11px]">{JSON.stringify(input, null, 2)}</pre>
            </div>
          )}
          {(result || progress) && (
            <div><div className={`mb-1 ${result?.isError ? 'text-red-500' : 'muted'}`}>{result ? (result.isError ? '错误' : '结果') : '运行输出'}</div>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-code p-2 font-mono text-[11px]">{result ? result.text : progress}</pre>
            </div>
          )}
        </div>
      )}
      {images && images.length > 0 && workerId !== undefined && (
        // Images the tool returned (e.g. read on a png): thumbnails under the result, shown even when collapsed.
        <div className="flex flex-wrap gap-2 border-t panel px-3 py-2 [&_img]:max-h-48">
          <ImageGroup>{images.map((im, i) => <BlobImage key={i} workerId={workerId} hash={im.blob} mediaType={im.mediaType} />)}</ImageGroup>
        </div>
      )}
    </div>
  );
}
