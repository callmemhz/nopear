// Platform-agnostic image compression policy; the host supplies the actual encoder.
export const IMAGE_BUDGET_BYTES = 3.5 * 1024 * 1024;
export const IMAGE_STEPS: readonly { maxSide: number; quality: number }[] = [
  { maxSide: 2048, quality: 0.85 },
  { maxSide: 1568, quality: 0.8 },
  { maxSide: 1200, quality: 0.7 },
];
export const ATTACHMENTS_TOTAL_MAX_BYTES = 45 * 1024 * 1024;
/** What re-encoded attachments are sent as. Only used when the encoder does not report its own. */
export const IMAGE_OUTPUT_MEDIA_TYPE = 'image/webp';

/** null = original is within budget; otherwise the first step that fits, or the last step if none does. */
export async function compressToBudget(
  sizeBytes: number,
  encode: (step: { maxSide: number; quality: number }) => Promise<{ bytes: number; dataBase64: string; mediaType?: string }>,
): Promise<{ dataBase64: string; mediaType: string } | null> {
  if (sizeBytes <= IMAGE_BUDGET_BYTES) return null;
  let last: { bytes: number; dataBase64: string; mediaType?: string } | null = null;
  for (const step of IMAGE_STEPS) {
    last = await encode(step);
    if (last.bytes <= IMAGE_BUDGET_BYTES) break;
  }
  // The encoder decides (a browser without a WebP encoder falls back to JPEG); the policy only supplies the default.
  return last ? { dataBase64: last.dataBase64, mediaType: last.mediaType ?? IMAGE_OUTPUT_MEDIA_TYPE } : null;
}
