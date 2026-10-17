// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { engine } from '../engine';
import { Composer } from '../components/Composer';
import { namePastedFile, transferFiles } from './usePasteAttachments';

const over = vi.hoisted(() => ({ limit: false }));
vi.mock('./compress', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./compress')>();
  return { ...orig, checkAttachmentTotal: (sizes: number[]) => !over.limit && orig.checkAttachmentTotal(sizes) };
});

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => () => Promise.resolve(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let el: HTMLDivElement;
let root: Root;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
const textarea = () => el.querySelector('textarea')!;
const thumbs = () => Array.from(el.querySelectorAll('img')).filter((i) => i.getAttribute('src')?.startsWith('data:'));
const viewer = () => document.querySelector('[data-testid="image-viewer"]');

function transfer(files: File[], text = '') {
  return {
    items: [...files.map((f) => ({ kind: 'file', type: f.type, getAsFile: () => f })), ...(text ? [{ kind: 'string', type: 'text/plain', getAsFile: () => null }] : [])],
    files,
    types: [...(files.length ? ['Files'] : []), ...(text ? ['text/plain'] : [])],
    getData: (t: string) => (t === 'text/plain' ? text : ''),
    dropEffect: 'none',
  };
}
async function paste(target: Element, files: File[], text = '') {
  const ev = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clipboardData', { value: transfer(files, text) });
  await act(async () => { target.dispatchEvent(ev); });
  await flush();
  return ev;
}

beforeEach(async () => {
  over.limit = false;
  engine.store.setState({ error: null, drafts: {} });
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  await act(async () => { root.render(<Composer workerId="w1" sessionId="s1" running={false} />); });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  el.remove();
  vi.restoreAllMocks();
});

describe('paste attachments (Composer)', () => {
  it('pasting an image adds an attachment rendered as a thumbnail; paste is prevented; screenshot gets a name', async () => {
    const ev = await paste(textarea(), [new File([PNG], 'image.png', { type: 'image/png' })]);
    expect(ev.defaultPrevented).toBe(true);
    const t = thumbs();
    expect(t).toHaveLength(1);
    expect(t[0]!.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    expect(t[0]!.className).toContain('object-cover');
    expect(el.querySelector('[title^="粘贴图片-"]')).not.toBeNull();
    // ✕ removes it
    await act(async () => { el.querySelector<HTMLButtonElement>('button[aria-label^="移除"]')!.click(); });
    expect(thumbs()).toHaveLength(0);
  });

  it('plain-text paste adds nothing and is not prevented', async () => {
    const ev = await paste(textarea(), [], 'hello');
    expect(ev.defaultPrevented).toBe(false);
    expect(thumbs()).toHaveLength(0);
    expect(el.textContent).not.toContain('KB');
  });

  it('text + files: files are attached and the text paste is left to the browser', async () => {
    const ev = await paste(textarea(), [new File(['abc'], 'notes.txt', { type: 'text/plain' })], 'notes.txt');
    expect(ev.defaultPrevented).toBe(false);
    expect(el.textContent).toContain('notes.txt');
    expect(thumbs()).toHaveLength(0); // non-image → name chip
  });

  it('total-size overflow reports the error and attaches nothing', async () => {
    over.limit = true;
    await paste(textarea(), [new File([PNG], 'a.png', { type: 'image/png' })]);
    expect(engine.store.getState().error).toBe('附件总大小超过 45MB，请减少附件');
    expect(thumbs()).toHaveLength(0);
  });

  it('clicking a thumbnail opens the in-page image viewer', async () => {
    await paste(textarea(), [new File([PNG], 'shot.png', { type: 'image/png' })]);
    expect(viewer()).toBeNull();
    await act(async () => { thumbs()[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(viewer()).not.toBeNull();
    expect(viewer()!.querySelector('img')!.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    await act(async () => { viewer()!.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click(); });
    expect(viewer()).toBeNull();
  });

  it('dropping files attaches them and highlights while dragging', async () => {
    const zone = el.querySelector('[data-testid="attach-drop"]')!;
    const drag = (type: string, files: File[]) => {
      const ev = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'dataTransfer', { value: transfer(files) });
      return act(async () => { zone.dispatchEvent(ev); });
    };
    const f = new File([PNG], 'drop.png', { type: 'image/png' });
    await drag('dragenter', [f]);
    expect(zone.getAttribute('data-dragging')).toBe('true');
    await drag('drop', [f]);
    await flush();
    expect(zone.getAttribute('data-dragging')).toBe('false');
    expect(thumbs()).toHaveLength(1);
  });
});

describe('helpers', () => {
  it('names generic/unnamed clipboard images 粘贴图片-HHmmss', () => {
    const now = new Date(2026, 0, 1, 9, 5, 7);
    expect(namePastedFile(new File([PNG], 'image.png', { type: 'image/png' }), now).name).toBe('粘贴图片-090507.png');
    expect(namePastedFile(new File([PNG], '', { type: 'image/jpeg' }), now).name).toBe('粘贴图片-090507.jpg');
    const keep = new File([PNG], 'diagram.png', { type: 'image/png' });
    expect(namePastedFile(keep, now)).toBe(keep);
  });
  it('extracts only file items', () => {
    const f = new File(['x'], 'x.txt');
    expect(transferFiles(transfer([f], 'x'))).toEqual([f]);
    expect(transferFiles(transfer([], 'x'))).toEqual([]);
    expect(transferFiles(null)).toEqual([]);
  });
});

describe('paste attachments (NewSessionDialog)', () => {
  it('pasting an image into the first prompt adds a thumbnail; overflow shows the inline error', async () => {
    const { NewSessionDialog } = await import('../components/NewSessionDialog');
    engine.store.setState({
      machines: { w1: { workerId: 'w1', label: 'box', workerPub: '', online: true, lastSeenAt: null, version: '3.1.0' } },
      machineConn: {},
    });
    await act(async () => { root.render(<NewSessionDialog onClose={() => {}} />); });
    const ta = el.querySelector('textarea')!;
    expect(ta.getAttribute('placeholder')).toContain('要它做什么');
    const ev = await paste(ta, [new File([PNG], 'image.png', { type: 'image/png' })]);
    expect(ev.defaultPrevented).toBe(true);
    expect(thumbs()).toHaveLength(1);
    over.limit = true;
    await paste(ta, [new File([PNG], 'b.png', { type: 'image/png' })]);
    expect(el.textContent).toContain('附件总大小超过 45MB，请减少附件');
    expect(thumbs()).toHaveLength(1);
  });
});
