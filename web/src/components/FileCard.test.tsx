// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Block } from '@nopear/protocol';
import { engine } from '../engine';
import { FileCard, TEXT_PREVIEW_MAX_BYTES } from './FileCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type FileBlock = Extract<Block, { type: 'file' }>;
const fb = (over: Partial<FileBlock> = {}): FileBlock =>
  ({ type: 'file', name: 'demo.mp4', mediaType: 'video/mp4', size: 2048, blob: 'a'.repeat(64), ...over });

let el: HTMLDivElement;
let root: Root;
let rpc: ReturnType<typeof vi.fn>;
let created: Blob[];
let revoked: string[];
const orig = { createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL };

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const modal = () => document.querySelector('[data-testid="file-preview"]');
const link = (label: string) => Array.from(modal()?.querySelectorAll('a') ?? []).find((a) => a.textContent === label);
const render = async (block: FileBlock, bytes: Uint8Array = new Uint8Array([1, 2, 3])) => {
  rpc = vi.fn().mockResolvedValue({ mediaType: block.mediaType, bytes });
  vi.spyOn(engine, 'rpc').mockImplementation(rpc as never);
  await act(async () => { root.render(<FileCard block={block} workerId="w1" />); });
};
const openCard = async () => {
  await act(async () => { (el.querySelector('[data-testid="file-card"]') as HTMLButtonElement).click(); });
  await flush();
};

beforeEach(() => {
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  created = []; revoked = [];
  Object.assign(URL, {
    createObjectURL: (b: Blob) => { created.push(b); return `blob:u${created.length}`; },
    revokeObjectURL: (u: string) => { revoked.push(u); },
  });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  el.remove();
  vi.restoreAllMocks();
  Object.assign(URL, orig);
});

describe('FileCard', () => {
  it('shows title / name / size / note and fetches nothing until opened', async () => {
    await render(fb({ title: '演示视频', note: '最终版' }));
    const card = el.querySelector('[data-testid="file-card"]')!;
    expect(card.textContent).toContain('演示视频');
    expect(card.textContent).toContain('demo.mp4');
    expect(card.textContent).toContain('2.0 KB');
    expect(card.textContent).toContain('最终版');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('video: lazily fetches via blobs.get, <video controls>, 下载 + 在新标签页打开; cached on reopen; revoked on unmount', async () => {
    await render(fb());
    await openCard();
    expect(rpc).toHaveBeenCalledWith('w1', 'blobs.get', { hash: 'a'.repeat(64) });
    const v = modal()!.querySelector('video')!;
    expect(v.hasAttribute('controls')).toBe(true);
    expect(v.getAttribute('src')).toBe('blob:u1');
    expect(created[0]!.type).toBe('video/mp4');
    expect(link('下载')!.getAttribute('download')).toBe('demo.mp4');
    expect(link('下载')!.getAttribute('href')).toBe('blob:u1');
    expect(link('在新标签页打开')!.getAttribute('target')).toBe('_blank');
    await act(async () => { (modal()!.querySelector('[aria-label="关闭"]') as HTMLButtonElement).click(); });
    expect(modal()).toBeNull();
    await openCard();
    expect(rpc).toHaveBeenCalledTimes(1);
    await act(async () => { root.unmount(); });
    root = createRoot(el);
    expect(revoked).toEqual(['blob:u1']);
  });

  it('audio → <audio controls>', async () => {
    await render(fb({ name: 'a.mp3', mediaType: 'audio/mpeg' }));
    await openCard();
    expect(modal()!.querySelector('audio')!.hasAttribute('controls')).toBe(true);
  });

  it('html → iframe sandbox="allow-scripts" (no allow-same-origin), no new-tab link', async () => {
    await render(fb({ name: 'page.html', mediaType: 'text/html' }), new TextEncoder().encode('<script>1</script>'));
    await openCard();
    const f = modal()!.querySelector('iframe')!;
    expect(f.getAttribute('sandbox')).toBe('allow-scripts');
    expect(f.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(f.getAttribute('src')).toBe('blob:u1');
    expect(link('在新标签页打开')).toBeUndefined();
    expect(link('下载')).toBeTruthy();
  });

  it('pdf → iframe with the blob URL', async () => {
    await render(fb({ name: 'r.pdf', mediaType: 'application/pdf' }));
    await openCard();
    expect(modal()!.querySelector('iframe')!.getAttribute('src')).toBe('blob:u1');
    expect(link('在新标签页打开')).toBeTruthy();
  });

  it('image → img that opens the image viewer; svg → img without new-tab link', async () => {
    await render(fb({ name: 'p.png', mediaType: 'image/png' }));
    await openCard();
    const img = modal()!.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('blob:u1');
    await act(async () => { img.click(); });
    expect(document.querySelector('[data-testid="image-viewer"]')).toBeTruthy();
    await act(async () => { root.unmount(); });
    root = createRoot(el);
    await render(fb({ name: 'p.svg', mediaType: 'image/svg+xml', blob: 'b'.repeat(64) }));
    await openCard();
    expect(modal()!.querySelector('img')!.getAttribute('src')).toBe('blob:u2');
    expect(link('在新标签页打开')).toBeUndefined();
  });

  it('markdown → rendered markdown; text/json → <pre> served as text/plain', async () => {
    await render(fb({ name: 'r.md', mediaType: 'text/markdown' }), new TextEncoder().encode('# 标题\n\n- item'));
    await openCard();
    expect(modal()!.querySelector('h1')!.textContent).toBe('标题');
    await act(async () => { root.unmount(); });
    root = createRoot(el);
    await render(fb({ name: 'd.json', mediaType: 'application/json', blob: 'c'.repeat(64) }), new TextEncoder().encode('{"a":1}'));
    await openCard();
    expect(modal()!.querySelector('pre')!.textContent).toBe('{"a":1}');
    expect(created.at(-1)!.type).toBe('text/plain;charset=utf-8');
  });

  it('text over the display cap is truncated with a notice', async () => {
    const big = new Uint8Array(TEXT_PREVIEW_MAX_BYTES + 10).fill(0x61);
    await render(fb({ name: 'big.log', mediaType: 'text/plain', size: big.length }), big);
    await openCard();
    expect(modal()!.querySelector('pre')!.textContent!.length).toBe(TEXT_PREVIEW_MAX_BYTES);
    expect(modal()!.textContent).toContain('仅显示前');
  });

  it('other → download only', async () => {
    await render(fb({ name: 'x.zip', mediaType: 'application/zip' }));
    await openCard();
    expect(modal()!.textContent).toContain('不支持预览');
    expect(link('下载')).toBeTruthy();
    expect(link('在新标签页打开')).toBeUndefined();
    expect(created[0]!.type).toBe('application/octet-stream');
  });

  it('fetch failure shows an error', async () => {
    vi.spyOn(engine, 'rpc').mockRejectedValue(new Error('offline'));
    await act(async () => { root.render(<FileCard block={fb()} workerId="w1" />); });
    await openCard();
    expect(modal()!.textContent).toContain('加载失败');
  });
});
