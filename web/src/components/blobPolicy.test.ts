import { describe, expect, it } from 'vitest';
import { previewableType } from './blobPolicy';

describe('blob preview policy', () => {
  it('allows only vision image types', () => {
    expect(previewableType('image/png', 'image/jpeg')).toBe('image/png');
    expect(previewableType('', 'image/webp')).toBe('image/webp');
  });
  it('refuses non-image or unsafe types', () => {
    expect(previewableType('text/html', 'image/png')).toBeNull();
    expect(previewableType('image/svg+xml', 'image/png')).toBeNull();
    expect(previewableType('application/octet-stream', 'image/png')).toBeNull();
    expect(previewableType('', 'text/html')).toBeNull();
  });
});
