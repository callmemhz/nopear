import { describe, expect, it } from 'vitest';
import { IDENTITY, MAX_SCALE, clampPan, wheelFactor, zoomAt, type Size } from './zoom';

const vp: Size = { width: 1000, height: 800 };
const img: Size = { width: 800, height: 600 }; // fitted (1×) size, centred in the viewport

/** Where a point of the 1× image (relative to its centre) lands on screen (viewport coords). */
const project = (s: { scale: number; x: number; y: number }, px: number, py: number) =>
  [vp.width / 2 + s.x + s.scale * px, vp.height / 2 + s.y + s.scale * py];

describe('zoomAt', () => {
  it('keeps the point under the cursor fixed', () => {
    const cx = 700, cy = 300;
    const p = [(cx - 500) / 1, (cy - 400) / 1]; // image point under the cursor at 1×
    const a = zoomAt(IDENTITY, 3, cx, cy, vp, img);
    expect(a.scale).toBe(3);
    const [sx, sy] = project(a, p[0]!, p[1]!);
    expect(sx).toBeCloseTo(cx);
    expect(sy).toBeCloseTo(cy);
    // and again from an already zoomed / panned state
    const q = [(cx - 500 - a.x) / a.scale, (cy - 400 - a.y) / a.scale];
    const b = zoomAt(a, 1.5, cx, cy, vp, img);
    const [tx, ty] = project(b, q[0]!, q[1]!);
    expect(tx).toBeCloseTo(cx);
    expect(ty).toBeCloseTo(cy);
  });

  it('clamps the scale to [1, 8] and recentres at 1×', () => {
    expect(zoomAt(IDENTITY, 0.5, 100, 100, vp, img)).toEqual(IDENTITY);
    expect(zoomAt(IDENTITY, 100, 500, 400, vp, img).scale).toBe(MAX_SCALE);
    const zoomed = zoomAt(IDENTITY, 4, 900, 700, vp, img);
    expect(zoomAt(zoomed, 1 / 4, 100, 100, vp, img)).toEqual(IDENTITY);
  });

  it('a centred zoom does not pan', () => {
    expect(zoomAt(IDENTITY, 2, 500, 400, vp, img)).toEqual({ scale: 2, x: 0, y: 0 });
  });
});

describe('clampPan', () => {
  it('pins the image to the centre at 1× (no panning)', () => {
    expect(clampPan({ scale: 1, x: 300, y: -200 }, vp, img)).toEqual(IDENTITY);
  });

  it('lets an overflowing image move only until its edge reaches the viewport edge', () => {
    // 2× → 1600×1200 shown in 1000×800: may move ±300 horizontally, ±200 vertically
    expect(clampPan({ scale: 2, x: 5000, y: -5000 }, vp, img)).toEqual({ scale: 2, x: 300, y: -200 });
    expect(clampPan({ scale: 2, x: -100, y: 50 }, vp, img)).toEqual({ scale: 2, x: -100, y: 50 });
  });

  it('keeps an axis centred while the zoomed image is still narrower than the viewport', () => {
    const tall: Size = { width: 300, height: 800 };
    expect(clampPan({ scale: 2, x: 200, y: 999 }, vp, tall)).toEqual({ scale: 2, x: 0, y: 400 });
  });
});

describe('wheelFactor', () => {
  it('scroll up zooms in, scroll down zooms out, smoothly', () => {
    expect(wheelFactor(-100, 0, false)).toBeCloseTo(Math.exp(0.15));
    expect(wheelFactor(100, 0, false)).toBeCloseTo(Math.exp(-0.15));
  });
  it('line-mode deltas are converted to pixels and trackpad pinch (ctrlKey) is more sensitive', () => {
    expect(wheelFactor(-3, 1, false)).toBeCloseTo(wheelFactor(-48, 0, false));
    expect(wheelFactor(-10, 0, true)).toBeGreaterThan(wheelFactor(-10, 0, false));
  });
});
