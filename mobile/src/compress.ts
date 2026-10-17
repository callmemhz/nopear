// Image picking + compression for attachments (same policy as web: core compressToBudget / IMAGE_STEPS).
import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { ATTACHMENTS_TOTAL_MAX_BYTES, compressToBudget } from '@nopear/core';
import type { Attachment } from '@nopear/protocol';
import { IMAGE_OUTPUT_MEDIA_TYPE, budgetInputSize, webpName } from './imagePolicy';

/** Approximate decoded size of a base64 payload. */
export const base64Bytes = (b64: string) => Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);

export const attachmentsBytes = (list: Attachment[]) => list.reduce((n, a) => n + base64Bytes(a.dataBase64), 0);
export const exceedsTotal = (list: Attachment[]) => attachmentsBytes(list) > ATTACHMENTS_TOTAL_MAX_BYTES;

async function toAttachment(asset: ImagePicker.ImagePickerAsset, index: number): Promise<Attachment | null> {
  if (!asset.base64) return null;
  const mime = asset.mimeType ?? 'image/jpeg';
  const name = asset.fileName ?? `image-${Date.now()}-${index}.${mime.split('/')[1] ?? 'jpg'}`;
  const size = asset.fileSize ?? base64Bytes(asset.base64);
  const longSide = Math.max(asset.width, asset.height);
  const encode = async ({ maxSide, quality }: { maxSide: number; quality: number }) => {
    const scale = longSide > maxSide ? maxSide / longSide : 1;
    const r = await manipulateAsync(
      asset.uri,
      scale < 1 ? [{ resize: { width: Math.round(asset.width * scale), height: Math.round(asset.height * scale) } }] : [],
      { compress: quality, format: SaveFormat.WEBP, base64: true },
    );
    const b64 = r.base64 ?? '';
    return { bytes: base64Bytes(b64), dataBase64: b64, mediaType: IMAGE_OUTPUT_MEDIA_TYPE };
  };
  // Non-vision types (e.g. image/heic) are forced through the budgeted steps so the re-encode stays in budget.
  const compressed = await compressToBudget(budgetInputSize(mime, size), encode);
  if (compressed) {
    return { kind: 'image', name: webpName(name), mediaType: compressed.mediaType, dataBase64: compressed.dataBase64 };
  }
  return { kind: 'image', name, mediaType: mime, dataBase64: asset.base64 };
}

/** Opens the photo library; returns compressed attachments ([] when cancelled). */
export async function pickImageAttachments(): Promise<Attachment[]> {
  const res = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: true,
    base64: true,
    quality: 1,
  });
  if (res.canceled) return [];
  const out: Attachment[] = [];
  for (const [i, a] of res.assets.entries()) {
    const att = await toAttachment(a, i);
    if (att) out.push(att);
  }
  return out;
}
