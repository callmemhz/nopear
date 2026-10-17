// Tap opens the full-screen viewer.
// image Block → blobs.get over E2E → bytes written to Paths.cache/<hash>.<ext>; we cache only the
// file:// URI in a bounded LRU (never base64 data URIs in memory).
import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Pressable } from 'react-native';
import { File, Paths } from 'expo-file-system';
import { engine } from '../engine';
import { Lru } from '../lru';
import { extFor } from '../imagePolicy';
import { usePalette } from '../theme';
import { ImageViewer } from './ImageViewer';

const cache = new Lru<string>(200);
const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_');

async function loadBlob(workerId: string, hash: string, mediaType: string): Promise<string> {
  const key = `${workerId}/${hash}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const r = await engine.rpc(workerId, 'blobs.get', { hash });
  const f = new File(Paths.cache, `blob-${safe(workerId)}-${safe(hash)}.${extFor(r.mediaType || mediaType)}`);
  if (!f.exists) { f.create({ overwrite: true }); f.write(r.bytes); }
  cache.set(key, f.uri);
  return f.uri;
}

export function BlobImage({ workerId, hash, mediaType, uri, size = 220 }: { workerId: string; hash?: string; mediaType: string; uri?: string; size?: number }) {
  const c = usePalette();
  const [viewing, setViewing] = useState(false);
  const [src, setSrc] = useState<string | null>(uri ?? (hash ? cache.get(`${workerId}/${hash}`) ?? null : null));
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (src || !hash) return;
    let alive = true;
    loadBlob(workerId, hash, mediaType).then((u) => { if (alive) setSrc(u); }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [workerId, hash, mediaType, src]);
  return (
    <>
      <Pressable onPress={() => { if (src) setViewing(true); }} disabled={!src} accessibilityRole="imagebutton" accessibilityLabel="查看图片"
        style={{ width: size, height: size, borderRadius: 12, overflow: 'hidden', backgroundColor: c.elevated, marginVertical: 4, alignItems: 'center', justifyContent: 'center' }}>
        {src ? <Image source={{ uri: src }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
          : failed ? null : <ActivityIndicator color={c.sub} />}
      </Pressable>
      <ImageViewer uri={viewing ? src : null} onClose={() => setViewing(false)} />
    </>
  );
}
