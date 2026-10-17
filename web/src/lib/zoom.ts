/**
 * Pure zoom/pan math for the image viewer.
 *
 * Model: the image keeps its fitted (1×) layout box, centred in the viewport, and is drawn with
 * `transform: translate(x, y) scale(scale)` around its centre (`transform-origin: center`). So a point `p` of the
 * 1× image (relative to the image centre) is shown at `viewportCentre + (x, y) + scale · p`.
 */

export interface ZoomState { scale: number; x: number; y: number }
export interface Size { width: number; height: number }

export const MIN_SCALE = 1;
export const MAX_SCALE = 8;
export const IDENTITY: ZoomState = { scale: 1, x: 0, y: 0 };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Allowed offset on one axis: an overflowing image may move until its edge meets the viewport edge; otherwise centred. */
const clampAxis = (v: number, scaled: number, view: number) => {
  const max = Math.max(0, (scaled - view) / 2);
  return clamp(v, -max, max) || 0; // `|| 0` normalises -0
};

/** Clamp the pan so the image never leaves the screen; at 1× (or below) the image is always centred. */
export function clampPan(s: ZoomState, viewport: Size, img: Size): ZoomState {
  const scale = clamp(s.scale, MIN_SCALE, MAX_SCALE);
  if (scale <= MIN_SCALE) return { ...IDENTITY };
  return {
    scale,
    x: clampAxis(s.x, img.width * scale, viewport.width),
    y: clampAxis(s.y, img.height * scale, viewport.height),
  };
}

/**
 * Multiply the scale by `factor` (clamped to [1, 8]) keeping the image point under (cx, cy) — viewport coordinates,
 * origin at the viewport's top-left — fixed on screen (as far as the pan clamp allows).
 */
export function zoomAt(s: ZoomState, factor: number, cx: number, cy: number, viewport: Size, img: Size): ZoomState {
  const scale = clamp(s.scale * factor, MIN_SCALE, MAX_SCALE);
  const r = scale / s.scale;
  const qx = cx - viewport.width / 2;
  const qy = cy - viewport.height / 2;
  return clampPan({ scale, x: qx - r * (qx - s.x), y: qy - r * (qy - s.y) }, viewport, img);
}

/**
 * Zoom factor for one wheel event: smooth and multiplicative. Line-mode deltas (Firefox) are converted to pixels;
 * trackpad pinch arrives as `wheel` + `ctrlKey` with small deltas, so it gets a higher sensitivity.
 */
export function wheelFactor(deltaY: number, deltaMode: number, ctrlKey: boolean): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  return Math.exp(-px * (ctrlKey ? 0.01 : 0.0015));
}
