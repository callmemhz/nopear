// Pure drawer geometry / gesture decisions. Functions are worklets so the gesture callbacks can call them on the UI thread.

/** Width (pt) of the left-edge strip that starts an opening swipe on root screens. */
export const DRAWER_EDGE = 24;
/** A horizontal fling faster than this (pt/s) decides open/closed by its direction. */
export const FLING_VELOCITY = 500;

/** Drawer panel width: the content stays visible as a 64pt strip on phones; capped on tablets. */
export function drawerWidth(screenWidth: number): number {
  'worklet';
  return Math.min(360, screenWidth - 64);
}

export function clamp01(v: number): number {
  'worklet';
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Open progress (0 closed … 1 open) while dragging, from the state at drag start and the horizontal translation. */
export function dragProgress(startOpen: boolean, translationX: number, width: number): number {
  'worklet';
  return clamp01((startOpen ? 1 : 0) + translationX / width);
}

/** Where a released drag settles: flings by direction, otherwise the nearer end (half-way counts as open). */
export function settleOpen(progress: number, velocityX: number): boolean {
  'worklet';
  if (Math.abs(velocityX) > FLING_VELOCITY) return velocityX > 0;
  return progress >= 0.5;
}

/** `/s/<workerId>/<sessionId>` → the open session (drawer highlights it), else null. */
export function parseSessionPath(pathname: string): { workerId: string; sessionId: string } | null {
  const m = /^\/s\/([^/]+)\/([^/]+)\/?$/.exec(pathname);
  if (!m) return null;
  try {
    return { workerId: decodeURIComponent(m[1]!), sessionId: decodeURIComponent(m[2]!) };
  } catch {
    return null;
  }
}
