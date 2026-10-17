// Attachment preparation: image compression policy (shared @nopear/core) + browser canvas encoder.
import type { Attachment } from '@nopear/protocol';
import { VISION_MEDIA_TYPES } from '@nopear/protocol';
import { ATTACHMENTS_TOTAL_MAX_BYTES, IMAGE_BUDGET_BYTES, compressToBudget } from '@nopear/core';

type Encode = (step: { maxSide: number; quality: number }) => Promise<{ bytes: number; dataBase64: string; mediaType: string }>;

export function compressImage(sizeBytes: number, encode: Encode) {
  return compressToBudget(sizeBytes, encode);
}
export function isVisionImage(mediaType: string): boolean {
  return (VISION_MEDIA_TYPES as readonly string[]).includes(mediaType);
}
export function checkAttachmentTotal(sizes: number[]): boolean {
  return sizes.reduce((a, b) => a + b, 0) <= ATTACHMENTS_TOTAL_MAX_BYTES;
}

function bufToB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const b64Bytes = (b64: string) => Math.floor((b64.length * 3) / 4);

type Bitmap = { width: number; height: number; close(): void };

/** WebP is the output format; Safari <14 has no canvas WebP encoder, so fall back to JPEG. */
function supportsWebp(canvas: HTMLCanvasElement): boolean {
  return canvas.toDataURL('image/webp').startsWith('data:image/webp');
}

/** Encoder over an already-decoded bitmap (decode once, re-encode per step). */
function canvasEncoder(bmp: Bitmap & CanvasImageSource): Encode {
  return async ({ maxSide, quality }) => {
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const type = supportsWebp(canvas) ? 'image/webp' : 'image/jpeg';
    const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), type, quality));
    return { bytes: blob.size, dataBase64: bufToB64(await blob.arrayBuffer()), mediaType: blob.type || type };
  };
}

/** Extension follows the media type the encoder actually produced. */
const extFor = (mediaType: string) => (mediaType === 'image/webp' ? 'webp' : 'jpg');
const renamed = (name: string, mediaType: string) => name.replace(/\.\w+$/, '') + '.' + extFor(mediaType);

export interface ImageDeps {
  decode: (file: File) => Promise<Bitmap & CanvasImageSource>;
  encoder: (bmp: Bitmap & CanvasImageSource) => Encode;
}
const browserDeps: ImageDeps = { decode: (f) => createImageBitmap(f), encoder: canvasEncoder };

/**
 * File → Attachment.
 * - vision images (png/jpeg/gif/webp) over budget are re-encoded as WebP (JPEG where the browser cannot encode it);
 * - other image/* types (heic, bmp, tiff…) are converted the same way when the browser can decode them,
 *   so the model receives a real vision block; undecodable ones fall back to a plain file attachment.
 */
export async function fileToAttachment(file: File, deps: ImageDeps = browserDeps): Promise<Attachment> {
  const mediaType = file.type || 'application/octet-stream';
  const vision = isVisionImage(mediaType);
  if (vision || mediaType.startsWith('image/')) {
    if (vision && file.size <= IMAGE_BUDGET_BYTES) {
      return { kind: 'image', name: file.name, mediaType, dataBase64: bufToB64(await file.arrayBuffer()) };
    }
    let bmp: (Bitmap & CanvasImageSource) | null = null;
    try {
      bmp = await deps.decode(file);
    } catch {
      bmp = null; // not decodable here
    }
    if (bmp) {
      try {
        const enc = deps.encoder(bmp);
        // non-vision types must always be re-encoded (size 0 below budget → force at least the first step)
        const c = (await compressImage(vision ? file.size : Math.max(file.size, IMAGE_BUDGET_BYTES + 1), enc));
        if (c) return { kind: 'image', name: renamed(file.name, c.mediaType), mediaType: c.mediaType, dataBase64: c.dataBase64 };
      } finally {
        bmp.close();
      }
    }
    if (vision) return { kind: 'image', name: file.name, mediaType, dataBase64: bufToB64(await file.arrayBuffer()) };
  }
  return { kind: 'file', name: file.name, mediaType, dataBase64: bufToB64(await file.arrayBuffer()) };
}
export const attachmentBytes = (a: Attachment) => b64Bytes(a.dataBase64);
