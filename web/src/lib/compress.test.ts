import { describe, expect, it, vi } from 'vitest';
import { IMAGE_BUDGET_BYTES } from '@nopear/core';
import { checkAttachmentTotal, compressImage, isVisionImage } from './compress';

const MB = 1024 * 1024;
describe('compressImage', () => {
  it('returns null (use original) when within budget', async () => {
    const enc = vi.fn();
    expect(await compressImage(2 * MB, enc)).toBeNull();
    expect(enc).not.toHaveBeenCalled();
  });
  it('tries steps in order until one fits the budget', async () => {
    const enc = vi.fn()
      .mockResolvedValueOnce({ bytes: 5 * MB, dataBase64: 'a', mediaType: 'image/webp' })
      .mockResolvedValueOnce({ bytes: 3 * MB, dataBase64: 'b', mediaType: 'image/webp' });
    const r = await compressImage(10 * MB, enc);
    expect(r).toEqual({ dataBase64: 'b', mediaType: 'image/webp' });
    expect(enc.mock.calls.map((c) => c[0])).toEqual([{ maxSide: 2048, quality: 0.85 }, { maxSide: 1568, quality: 0.8 }]);
  });
  it('falls back to the last step when none fits', async () => {
    const enc = vi.fn().mockResolvedValue({ bytes: IMAGE_BUDGET_BYTES + 1, dataBase64: 'z' }); // encoder silent: WebP default
    const r = await compressImage(20 * MB, enc);
    expect(enc).toHaveBeenCalledTimes(3);
    expect(enc.mock.calls[2]![0]).toEqual({ maxSide: 1200, quality: 0.7 });
    expect(r).toEqual({ dataBase64: 'z', mediaType: 'image/webp' });
  });
});
describe('attachment helpers', () => {
  it('flags vision images', () => {
    expect(isVisionImage('image/png')).toBe(true);
    expect(isVisionImage('image/svg+xml')).toBe(false);
  });
  it('enforces the 45MB total', () => {
    expect(checkAttachmentTotal([10 * MB, 20 * MB])).toBe(true);
    expect(checkAttachmentTotal([30 * MB, 20 * MB])).toBe(false);
  });
});

describe('fileToAttachment', () => {
  const MBb = 1024 * 1024;
  const mkFile = (size: number, type: string, name = 'a.' + type.split('/')[1]) => {
    const f = new File([new Uint8Array(4)], name, { type });
    Object.defineProperty(f, 'size', { value: size });
    return f;
  };
  const mkDeps = (opts: { decodeFails?: boolean } = {}) => {
    const close = vi.fn();
    const decode = vi.fn(async () => { if (opts.decodeFails) throw new Error('no'); return { width: 10, height: 10, close } as never; });
    const enc = vi.fn(async () => ({ bytes: 1000, dataBase64: 'WEBP', mediaType: 'image/webp' }));
    return { deps: { decode, encoder: () => enc }, decode, enc, close };
  };
  it('decodes an over-budget vision image once and closes the bitmap', async () => {
    const { fileToAttachment } = await import('./compress');
    const { deps, decode, close } = mkDeps();
    const a = await fileToAttachment(mkFile(10 * MBb, 'image/png'), deps);
    expect(a).toMatchObject({ kind: 'image', mediaType: 'image/webp', dataBase64: 'WEBP', name: 'a.webp' });
    expect(decode).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('passes small vision images through without decoding', async () => {
    const { fileToAttachment } = await import('./compress');
    const { deps, decode } = mkDeps();
    const a = await fileToAttachment(mkFile(100, 'image/webp'), deps);
    expect(a).toMatchObject({ kind: 'image', mediaType: 'image/webp' });
    expect(decode).not.toHaveBeenCalled();
  });
  it('converts decodable non-vision images (heic) to WebP even when small', async () => {
    const { fileToAttachment } = await import('./compress');
    const { deps, close } = mkDeps();
    const a = await fileToAttachment(mkFile(100, 'image/heic', 'p.heic'), deps);
    expect(a).toMatchObject({ kind: 'image', mediaType: 'image/webp', name: 'p.webp' });
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('falls back to a file attachment for undecodable non-vision images', async () => {
    const { fileToAttachment } = await import('./compress');
    const { deps } = mkDeps({ decodeFails: true });
    const a = await fileToAttachment(mkFile(100, 'image/heic', 'p.heic'), deps);
    expect(a).toMatchObject({ kind: 'file', mediaType: 'image/heic', name: 'p.heic' });
  });
});
