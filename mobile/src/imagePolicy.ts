// Attachment image policy (pure). Vision types go to the model as-is (if within budget);
// any other image/* (heic, bmp, tiff…) must be re-encoded so the model sees an image. Re-encodes are WebP
//: smaller on the wire than JPEG at the same quality.
import { VISION_MEDIA_TYPES } from '@nopear/protocol';
import { IMAGE_BUDGET_BYTES } from '@nopear/core';

export const isVisionType = (mime: string) => (VISION_MEDIA_TYPES as readonly string[]).includes(mime);
export const needsConversion = (mime: string) => !isVisionType(mime);
/** @deprecated kept for callers outside this package; `needsConversion` is the truthful name. */
export const needsJpegConversion = needsConversion;
/** The media type every re-encoded attachment is uploaded as. */
export const IMAGE_OUTPUT_MEDIA_TYPE = 'image/webp';
export const webpName = (name: string) => name.replace(/\.[^.]+$/, '') + '.webp';
/** File extension for a cached blob of the given media type. */
export const extFor = (mediaType: string) => {
  const sub = (mediaType.split('/')[1] ?? 'bin').split(/[+;]/)[0]!.toLowerCase();
  return sub === 'jpeg' ? 'jpg' : /^[a-z0-9]{1,8}$/.test(sub) ? sub : 'bin';
};
/** Size to feed compressToBudget: non-vision types are forced over budget so they always go through the
 *  bounded IMAGE_STEPS re-encode (a full-res/high-quality re-encode of a small HEIC can blow the budget). */
export const budgetInputSize = (mime: string, size: number) =>
  needsConversion(mime) ? Math.max(size, IMAGE_BUDGET_BYTES + 1) : size;
