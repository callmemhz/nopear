import { useEffect, useState } from 'react';
import { engine } from '../engine';
import { previewableType } from './blobPolicy';
import { ViewableImage } from './ImageViewer';

// Images are E2E: fetch bytes via the encrypted blobs.get RPC and show them as an object URL.
export function BlobImage({ workerId, hash, mediaType }: { workerId: string; hash: string; mediaType: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  useEffect(() => {
    let alive = true;
    let made: string | null = null;
    engine.rpc(workerId, 'blobs.get', { hash }).then((r) => {
      if (!alive) return;
      const type = previewableType(r.mediaType, mediaType);
      if (!type) { setUnsupported(true); return; } // never render or link non-image bytes
      made = URL.createObjectURL(new Blob([r.bytes as BlobPart], { type }));
      setUrl(made);
    }, () => alive && setErr(true));
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [workerId, hash, mediaType]);
  if (unsupported) return <div className="muted rounded border border-dashed p-3 text-xs panel">附件（不支持预览）</div>;
  if (err) return <div className="muted rounded border border-dashed p-3 text-xs panel">图片加载失败</div>;
  if (!url) return <div className="h-32 w-48 animate-pulse rounded-md bg-zinc-100 dark:bg-zinc-800" />;
  // Click opens the in-page lightbox (which keeps an 「在新标签页打开」 link to this object URL).
  return <ViewableImage src={url} className="max-h-80 max-w-full rounded-md border panel" />;
}
