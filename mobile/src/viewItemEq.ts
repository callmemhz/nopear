// memo comparator for MessageItem. selectMessages() rebuilds every ViewItem (fresh results/progress
// objects) on each timeline change, so compare the message by identity and the per-item maps shallowly:
// an item re-renders only when its own message, tool results, progress or pending state changed.
import type { ViewItem } from '@nopear/core';

function shallowEq<V>(a: Record<string, V>, b: Record<string, V>): boolean {
  if (a === b) return true;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}

/** resultImages/resultFiles arrays are rebuilt by selectMessages(); their blocks are stable, so compare element-wise. */
function sameLists<T>(a: Record<string, T[]>, b: Record<string, T[]>): boolean {
  if (a === b) return true;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => { const x = a[k]!, y = b[k]; return !!y && x.length === y.length && x.every((im, i) => im === y[i]); });
}

export function sameViewItem(a: ViewItem, b: ViewItem): boolean {
  return a.message === b.message && a.pending === b.pending && shallowEq(a.results, b.results) && shallowEq(a.progress, b.progress)
    && sameLists(a.resultImages, b.resultImages) && sameLists(a.resultFiles, b.resultFiles);
}
