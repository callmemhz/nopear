import { describe, expect, it } from 'vitest';
import { FILE_ICONS, fileBlobType, fileKind } from './fileKind';

describe('fileKind', () => {
  it('classifies media types', () => {
    const cases: Record<string, string> = {
      'video/mp4': 'video', 'video/quicktime': 'video', 'audio/mpeg': 'audio', 'image/png': 'image', 'image/webp': 'image',
      'image/svg+xml': 'svg', 'image/heic': 'other', 'text/html': 'html', 'TEXT/HTML; charset=utf-8': 'html', 'application/pdf': 'pdf',
      'text/markdown': 'markdown', 'text/plain': 'text', 'text/csv': 'text', 'application/json': 'text', 'application/zip': 'other',
      'application/octet-stream': 'other', '': 'other',
    };
    for (const [t, k] of Object.entries(cases)) expect(fileKind(t), t).toBe(k);
  });
  it('blob types never let active content escape its sandbox', () => {
    expect(fileBlobType('video', 'video/mp4')).toBe('video/mp4');
    expect(fileBlobType('pdf', 'application/pdf')).toBe('application/pdf');
    expect(fileBlobType('html', 'text/html')).toBe('text/html');
    expect(fileBlobType('svg', 'image/svg+xml')).toBe('image/svg+xml');
    expect(fileBlobType('text', 'application/json')).toBe('text/plain;charset=utf-8');
    expect(fileBlobType('markdown', 'text/markdown')).toBe('text/plain;charset=utf-8');
    expect(fileBlobType('other', 'application/x-evil')).toBe('application/octet-stream');
    expect(Object.keys(FILE_ICONS)).toHaveLength(9);
  });
});
