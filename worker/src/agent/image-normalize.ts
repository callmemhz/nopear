// Image normalization for everything that reaches the model: re-encode to WebP and cap the long
// side. Two reasons, and the second is the important one:
//  - WebP is smaller on the wire and in the session file than PNG;
//  - providers bill images by pixel area (~width×height/750 tokens for Claude), while pi's context estimate charges a
//    flat ~1200 tokens per image. A retina screenshot (2880×1800 → ~6900 tokens) is therefore mis-reported by ~5.7×,
//    and a session of screenshots can overflow the window while the reported usage still looks comfortable.
//    Shrinking to 1568px keeps the real cost close to the estimate instead of 6× above it.
import type { ImageContent } from '@earendil-works/pi-ai';

/** Anthropic's own long-side cap for vision input; above it the provider downscales anyway (so it is wasted bytes). */
export const IMAGE_MAX_SIDE = 1568;
/** WebP quality. Screenshots/UI stay legible; photographic content is far smaller than PNG. */
export const WEBP_QUALITY = 82;
const DEFAULTS = { maxSide: IMAGE_MAX_SIDE };

interface PhotonImageLike { get_width(): number; get_height(): number; get_bytes_webp(q?: number): Uint8Array; free(): void }
type PhotonImageCtor = { new_from_byteslice(b: Uint8Array): PhotonImageLike };
type Photon = {
  PhotonImage: PhotonImageCtor;
  resize(img: PhotonImageLike, w: number, h: number, filter: unknown): PhotonImageLike;
  SamplingFilter: { Lanczos3: unknown };
};
let photonPromise: Promise<Photon | null> | null = null;
/**
 * photon-node's CJS entry reads its `.wasm` sibling through `fs.readFileSync(__dirname + …)`, which breaks when the
 * module is hoisted/bundled; retry the same read from the package directory. Loaded once per process and `null` when
 * the backend is unavailable — callers then pass images through untouched.
 */
async function loadPhotonSafely(): Promise<Photon | null> {
  const fs = await import('node:fs');
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url);
  const orig = fs.default.readFileSync.bind(fs.default);
  const restore = () => { (fs.default as { readFileSync: unknown }).readFileSync = orig; };
  let pkgDir = '';
  try { pkgDir = req.resolve('@silvia-odwyer/photon-node/package.json').replace(/[\\/]package\.json$/, ''); } catch { /* not installed */ }
  const patched = ((...args: Parameters<typeof orig>) => {
    try { return orig(...args); } catch (err) {
      const name = typeof args[0] === 'string' ? args[0] : '';
      if (!pkgDir || !name.endsWith('photon_rs_bg.wasm')) throw err;
      return orig(`${pkgDir}/photon_rs_bg.wasm`);
    }
  }) as typeof orig;
  try {
    (fs.default as { readFileSync: unknown }).readFileSync = patched;
    return (await import('@silvia-odwyer/photon-node')) as unknown as Photon;
  } catch {
    return null;
  } finally {
    restore();
  }
}
function photon(): Promise<Photon | null> {
  if (!photonPromise) photonPromise = loadPhotonSafely();
  return photonPromise;
}

export interface NormalizeOptions {
  /** Long-side cap; ≤0 disables resizing (still converts to WebP). */
  maxSide?: number;
}

/**
 * Convert one base64 image to WebP with the long side capped. Returns `null` when nothing should change — GIF
 * (converting would flatten the animation), an already-small WebP, or an image the backend cannot decode.
 */
export async function toWebp(dataBase64: string, mediaType: string, opts: NormalizeOptions = {}): Promise<{ data: string; mimeType: string } | null> {
  const mime = mediaType.split(';')[0]!.trim().toLowerCase();
  if (mime === 'image/gif') return null; // keep animation
  const maxSide = opts.maxSide ?? DEFAULTS.maxSide;
  const p = await photon();
  if (!p) return null;
  let img: PhotonImageLike | null = null;
  let out: PhotonImageLike | null = null;
  try {
    img = p.PhotonImage.new_from_byteslice(Buffer.from(dataBase64, 'base64'));
    const w = img.get_width();
    const h = img.get_height();
    if (!w || !h) return null;
    const long = Math.max(w, h);
    const needResize = maxSide > 0 && long > maxSide;
    // An undersized WebP is already what we want; only re-encode when it actually shrinks or when resizing.
    if (!needResize && mime === 'image/webp') return null;
    if (needResize) {
      const scale = maxSide / long;
      const tw = Math.max(1, Math.round(w * scale));
      const th = Math.max(1, Math.round(h * scale));
      out = p.resize(img, tw, th, p.SamplingFilter.Lanczos3);
      const bytes = out.get_bytes_webp(WEBP_QUALITY);
      if (!bytes?.length) return null;
      // Resizing is the point here (it is what the token bill follows), but never ship a *larger* payload.
      if (bytes.length >= Math.floor((dataBase64.length * 3) / 4)) return null;
      return { data: Buffer.from(bytes).toString('base64'), mimeType: 'image/webp' };
    }
    const bytes = img.get_bytes_webp(WEBP_QUALITY);
    if (!bytes?.length) return null;
    // Skip when the conversion would grow the payload (tiny PNG icons are often smaller than their WebP).
    if (bytes.length >= Math.floor((dataBase64.length * 3) / 4)) return null;
    return { data: Buffer.from(bytes).toString('base64'), mimeType: 'image/webp' };
  } catch {
    return null; // undecodable (e.g. a .heic renamed to .png): pass the original through
  } finally {
    try { out?.free(); } catch { /* ignore */ }
    try { img?.free(); } catch { /* ignore */ }
  }
}

/** Normalize image blocks of one tool result / user message; non-image blocks pass through unchanged. */
export async function normalizeImageBlocks<T extends { type: string; data?: string; mimeType?: string }>(
  blocks: readonly T[], opts: NormalizeOptions = {},
): Promise<T[]> {
  let changed = false;
  const out: T[] = [];
  for (const b of blocks) {
    if (b.type !== 'image' || typeof b.data !== 'string' || typeof b.mimeType !== 'string') { out.push(b); continue; }
    const conv = await toWebp(b.data, b.mimeType, opts);
    if (!conv) { out.push(b); continue; }
    changed = true;
    out.push({ ...b, data: conv.data, mimeType: conv.mimeType });
  }
  return changed ? out : (blocks as T[]);
}

/** Convenience for pi `ImageContent[]`. */
export async function normalizeImages(images: ImageContent[], opts: NormalizeOptions = {}): Promise<ImageContent[]> {
  return normalizeImageBlocks(images, opts);
}
