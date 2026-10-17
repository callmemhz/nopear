// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { engine } from '../engine';
import { ImageGroup, ViewableImage } from './ImageViewer';
import { BlobImage } from './BlobImage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let el: HTMLDivElement;
let root: Root;
const viewer = () => document.querySelector('[data-testid="image-viewer"]');
const viewerImg = () => viewer()?.querySelector('img')?.getAttribute('src');
const thumbs = () => Array.from(el.querySelectorAll('img'));
const click = (n: Element) => act(async () => { n.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
const key = (k: string) => act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); });
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const readout = () => viewer()?.querySelector('[data-testid="zoom-readout"]')?.textContent ?? null;
const transform = () => (viewer()?.querySelector('img') as HTMLImageElement | null)?.style.transform;
const resetBtn = () => Array.from(viewer()!.querySelectorAll('button')).find((b) => b.textContent === '重置');
const fire = (n: Element, ev: Event) => act(async () => { n.dispatchEvent(ev); });
const wheel = async (n: Element, deltaY: number, at: { x?: number; y?: number; ctrlKey?: boolean } = {}) => {
  const ev = new WheelEvent('wheel', { deltaY, clientX: at.x ?? 0, clientY: at.y ?? 0, ctrlKey: at.ctrlKey ?? false, bubbles: true, cancelable: true });
  await fire(n, ev);
  return ev;
};
/** [x, y, scale] parsed from the viewer image's `translate(xpx, ypx) scale(s)` transform. */
const transformNums = () => (/^translate\((\S+)px, (\S+)px\) scale\((\S+)\)$/.exec(transform() ?? '') ?? []).slice(1).map(Number);
const dbl = (n: Element, x = 0, y = 0) => fire(n, new MouseEvent('dblclick', { bubbles: true, clientX: x, clientY: y }));
const ptr = (n: Element, type: string, x: number, y: number, pointerId = 1, pointerType = 'mouse') =>
  fire(n, new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId, pointerType, button: 0, isPrimary: pointerId === 1 }));

/** jsdom has no layout: pretend the viewport is 1000×800 and the fitted image 800×600 (centred). */
function mockLayout() {
  const sizes: Record<string, number> = { clientWidth: 1000, clientHeight: 800, offsetWidth: 800, offsetHeight: 600 };
  const saved = Object.keys(sizes).map((k) => [k, Object.getOwnPropertyDescriptor(HTMLElement.prototype, k)] as const);
  for (const [k, v] of Object.entries(sizes)) Object.defineProperty(HTMLElement.prototype, k, { configurable: true, get: () => v });
  onTestFinished(() => {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(HTMLElement.prototype, k, d);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k];
    }
  });
}

beforeEach(() => {
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  el.remove();
  vi.restoreAllMocks();
});

describe('ImageViewer', () => {
  it('click opens the viewer, ←/→ cycle through the group, Esc closes', async () => {
    await act(async () => {
      root.render(<ImageGroup>
        <ViewableImage src="blob:a" /><span>text</span><ViewableImage src="blob:b" /><ViewableImage src="blob:c" />
      </ImageGroup>);
    });
    expect(viewer()).toBeNull();
    await click(thumbs()[1]!);
    expect(viewer()).not.toBeNull();
    expect(viewerImg()).toBe('blob:b');
    expect(viewer()!.textContent).toContain('2 / 3');
    const link = Array.from(viewer()!.querySelectorAll('a')).find((a) => a.textContent === '在新标签页打开')!;
    expect(link.getAttribute('href')).toBe('blob:b');
    expect(link.getAttribute('target')).toBe('_blank');
    await key('ArrowRight');
    expect(viewerImg()).toBe('blob:c');
    await key('ArrowRight'); // wraps
    expect(viewerImg()).toBe('blob:a');
    await key('ArrowLeft');
    expect(viewerImg()).toBe('blob:c');
    await click(viewer()!.querySelector('[aria-label="上一张"]')!);
    expect(viewerImg()).toBe('blob:b');
    await key('Escape');
    expect(viewer()).toBeNull();
  });

  it('closes on backdrop click and ✕, but not when clicking the image itself', async () => {
    await act(async () => { root.render(<ImageGroup><ViewableImage src="blob:a" /></ImageGroup>); });
    await click(thumbs()[0]!);
    await click(viewer()!.querySelector('img')!);
    expect(viewer()).not.toBeNull();
    expect(viewer()!.querySelector('[aria-label="下一张"]')).toBeNull(); // single image: no arrows
    await click(viewer()!);
    expect(viewer()).toBeNull();
    await click(thumbs()[0]!);
    await click(viewer()!.querySelector('[aria-label="关闭"]')!);
    expect(viewer()).toBeNull();
  });

  it('an image outside any group opens on its own', async () => {
    await act(async () => { root.render(<ViewableImage src="blob:solo" />); });
    await click(thumbs()[0]!);
    expect(viewerImg()).toBe('blob:solo');
    await key('ArrowRight');
    expect(viewerImg()).toBe('blob:solo');
    await key('Escape');
    expect(viewer()).toBeNull();
  });

  it('BlobImage opens its object URL in the in-page viewer instead of a new tab', async () => {
    vi.spyOn(engine, 'rpc').mockResolvedValue({ mediaType: 'image/png', bytes: new Uint8Array([1, 2, 3]) } as never);
    const create = vi.fn().mockReturnValueOnce('blob:one').mockReturnValueOnce('blob:two');
    const orig = { createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL };
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    onTestFinished(() => { Object.assign(URL, orig); });
    await act(async () => {
      root.render(<ImageGroup>
        <BlobImage workerId="w1" hash="h1" mediaType="image/png" /><BlobImage workerId="w1" hash="h2" mediaType="image/png" />
      </ImageGroup>);
    });
    await flush();
    expect(el.querySelector('a')).toBeNull(); // no more target=_blank wrapper
    expect(thumbs().map((i) => i.getAttribute('src'))).toEqual(['blob:one', 'blob:two']);
    await click(thumbs()[0]!);
    expect(viewerImg()).toBe('blob:one');
    await key('ArrowRight');
    expect(viewerImg()).toBe('blob:two');
    await key('Escape');
    expect(viewer()).toBeNull();
  });

  describe('zoom & pan', () => {
    const open = async (srcs = ['blob:a']) => {
      await act(async () => { root.render(<ImageGroup>{srcs.map((s) => <ViewableImage key={s} src={s} />)}</ImageGroup>); });
      await click(thumbs()[0]!);
      expect(readout()).toBeNull();
      expect(transform()).toBe('translate(0px, 0px) scale(1)');
    };

    it('wheel on the image zooms (cancelling the page scroll); 重置 restores fit', async () => {
      await open();
      const ev = await wheel(viewer()!.querySelector('img')!, -200);
      expect(ev.defaultPrevented).toBe(true);
      expect(readout()).toBe(`${Math.round(Math.exp(0.3) * 100)}%`);
      expect(transform()).toMatch(/scale\(1\.34/);
      await wheel(viewer()!.querySelector('img')!, 100000); // way past 1× → clamped to fit
      expect(readout()).toBeNull();
      expect(transform()).toBe('translate(0px, 0px) scale(1)');
      await wheel(viewer()!.querySelector('img')!, -100000); // clamped at 8×
      expect(readout()).toBe('800%');
      await click(resetBtn()!);
      expect(viewer()).not.toBeNull();
      expect(readout()).toBeNull();
      expect(resetBtn()).toBeUndefined();
      expect(transform()).toBe('translate(0px, 0px) scale(1)');
    });

    it('zooms around the cursor (wheel and trackpad pinch)', async () => {
      mockLayout();
      await open();
      // 2× via wheel at (700, 300): image point (200, -100) from centre stays under the cursor → translate(-200, 100)
      await wheel(viewer()!.querySelector('img')!, -Math.log(2) / 0.0015, { x: 700, y: 300 });
      expect(readout()).toBe('200%');
      const [x, y, scale] = transformNums();
      expect(x).toBeCloseTo(-200);
      expect(y).toBeCloseTo(100);
      expect(scale).toBeCloseTo(2);
      await wheel(viewer()!, -10, { x: 500, y: 400, ctrlKey: true }); // pinch-zoom gesture zooms too
      expect(readout()).toBe(`${Math.round(2 * Math.exp(0.1) * 100)}%`);
    });

    it('double-click toggles 1× ↔ 2.5× around the click point', async () => {
      mockLayout();
      await open();
      await dbl(viewer()!.querySelector('img')!, 600, 400);
      expect(readout()).toBe('250%');
      expect(transform()).toBe('translate(-150px, 0px) scale(2.5)');
      await dbl(viewer()!.querySelector('img')!, 600, 400);
      expect(readout()).toBeNull();
      expect(transform()).toBe('translate(0px, 0px) scale(1)');
    });

    it('+ / = zoom in, - zooms out, 0 resets', async () => {
      await open();
      await key('+');
      expect(readout()).toBe('125%');
      await key('=');
      expect(readout()).toBe('156%');
      await key('-');
      expect(readout()).toBe('125%');
      await key('0');
      expect(readout()).toBeNull();
      expect(transform()).toBe('translate(0px, 0px) scale(1)');
      expect(viewer()).not.toBeNull();
    });

    it('switching images with ←/→ resets the zoom', async () => {
      await open(['blob:a', 'blob:b']);
      await dbl(viewer()!.querySelector('img')!);
      expect(readout()).toBe('250%');
      await key('ArrowRight');
      expect(viewerImg()).toBe('blob:b');
      expect(readout()).toBeNull();
      expect(transform()).toBe('translate(0px, 0px) scale(1)');
    });

    it('dragging pans a zoomed image (clamped) and never closes the viewer', async () => {
      mockLayout();
      await open();
      const img = viewer()!.querySelector('img')!;
      await dbl(img, 500, 400); // 2.5× → 2000×1500 in 1000×800: pan limits ±500 / ±350
      expect(transform()).toBe('translate(0px, 0px) scale(2.5)');
      expect((viewer() as HTMLElement).style.cursor).toBe('grab');
      await ptr(img, 'pointerdown', 500, 400);
      expect((viewer() as HTMLElement).style.cursor).toBe('grabbing');
      await ptr(img, 'pointermove', 400, 350);
      expect(transform()).toBe('translate(-100px, -50px) scale(2.5)');
      await ptr(img, 'pointermove', -2000, 2000);
      expect(transform()).toBe('translate(-500px, 350px) scale(2.5)');
      await ptr(img, 'pointerup', -2000, 2000);
      expect((viewer() as HTMLElement).style.cursor).toBe('grab');
      await click(viewer()!); // the click that ends a drag lands on the backdrop
      expect(viewer()).not.toBeNull();
      await click(viewer()!); // zoomed: a plain backdrop click does not close either
      expect(viewer()).not.toBeNull();
      await key('0');
      // at 1× nothing pans, and a drag that starts on the backdrop still must not close
      await ptr(viewer()!, 'pointerdown', 10, 10);
      await ptr(viewer()!, 'pointermove', 300, 300);
      expect(transform()).toBe('translate(0px, 0px) scale(1)');
      await ptr(viewer()!, 'pointerup', 300, 300);
      await click(viewer()!);
      expect(viewer()).not.toBeNull();
      // a press that starts on the image and ends on the backdrop doesn't close
      await ptr(img, 'pointerdown', 500, 400);
      await ptr(viewer()!, 'pointerup', 500, 400);
      await click(viewer()!);
      expect(viewer()).not.toBeNull();
      // a plain click on the backdrop at 1× still closes
      await ptr(viewer()!, 'pointerdown', 10, 10);
      await ptr(viewer()!, 'pointerup', 10, 10);
      await click(viewer()!);
      expect(viewer()).toBeNull();
    });

    it('two-finger pinch zooms around the fingers', async () => {
      mockLayout();
      await open();
      const img = viewer()!.querySelector('img')!;
      await ptr(img, 'pointerdown', 400, 400, 1, 'touch');
      await ptr(img, 'pointerdown', 600, 400, 2, 'touch');
      await ptr(img, 'pointermove', 800, 400, 2, 'touch'); // fingers 200 → 400 apart, midpoint 500 → 600
      expect(readout()).toBe('200%');
      expect(transform()).toBe('translate(100px, 0px) scale(2)');
      await ptr(img, 'pointerup', 800, 400, 2, 'touch');
      await ptr(img, 'pointerup', 400, 400, 1, 'touch');
      await key('0');
      await click(viewer()!); // the pinch counted as a gesture: its trailing click doesn't close
      expect(viewer()).not.toBeNull();
    });
  });
});
