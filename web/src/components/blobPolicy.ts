import { VISION_MEDIA_TYPES } from '@nopear/protocol';

/** The Blob type to preview with, or null when the bytes must not be rendered/linked (non-image, svg, html…). */
export function previewableType(reported: string, declared: string): string | null {
  const t = (reported || declared || '').toLowerCase();
  return (VISION_MEDIA_TYPES as readonly string[]).includes(t) ? t : null;
}
