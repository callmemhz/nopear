// Preview classification for `file` blocks (send_file), shared by web and mobile.
import { VISION_MEDIA_TYPES } from '@nopear/protocol';

export type FileKind = 'video' | 'audio' | 'image' | 'svg' | 'html' | 'pdf' | 'markdown' | 'text' | 'other';

export const FILE_ICONS: Record<FileKind, string> = {
  video: '🎬', audio: '🎵', image: '🖼️', svg: '🖼️', html: '🌐', pdf: '📕', markdown: '📝', text: '📄', other: '📦',
};

export function fileKind(mediaType: string): FileKind {
  const t = (mediaType.split(';')[0] ?? '').trim().toLowerCase();
  if (t === 'image/svg+xml') return 'svg';
  if ((VISION_MEDIA_TYPES as readonly string[]).includes(t)) return 'image';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  if (t === 'text/html') return 'html';
  if (t === 'application/pdf') return 'pdf';
  if (t === 'text/markdown') return 'markdown';
  if (t.startsWith('text/') || t === 'application/json' || t === 'application/xml') return 'text';
  return 'other';
}

/** Blob type for the object URL: text is always served as text/plain, unknown bytes as octet-stream, so a blob URL
 *  opened in a tab can never run as an active document of the app's origin. html/svg keep their type: callers must
 *  only show them sandboxed (html: iframe without allow-same-origin; svg: <img>) and never offer "open in new tab". */
export function fileBlobType(kind: FileKind, mediaType: string): string {
  switch (kind) {
    case 'video': case 'audio': case 'image': case 'pdf': return (mediaType.split(';')[0] ?? '').trim().toLowerCase();
    case 'html': return 'text/html';
    case 'svg': return 'image/svg+xml';
    case 'markdown': case 'text': return 'text/plain;charset=utf-8';
    default: return 'application/octet-stream';
  }
}
