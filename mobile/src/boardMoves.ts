// "移动到…" menu for the global board (long-press replaces drag & drop): only settable targets.
import { dropPatch } from '@nopear/core';
import type { Card, CardPatch, Machine } from '@nopear/protocol';

export interface MoveTarget { label: string; patch: CardPatch }

/** 收件箱 / 每台机器的「待开始」/ 完成 — never 进行中 / 待验收, and never the card's current column. */
export function moveTargets(card: Card, machines: Machine[]): MoveTarget[] {
  const out: MoveTarget[] = [];
  if (card.state !== 'inbox') out.push({ label: '收件箱', patch: dropPatch('inbox', null) });
  for (const m of machines) {
    if (card.state === 'queued' && card.workerId === m.workerId) continue;
    out.push({ label: `待开始 · ${m.label}`, patch: dropPatch('queued', m.workerId) });
  }
  if (card.state !== 'done') out.push({ label: '完成', patch: dropPatch('done', null) });
  return out;
}

// ── action menus (pure; rendered by actionMenu in QuickAdd.tsx) ───────────────────────────────────────────

/** A menu entry: either runs an action or opens a nested menu. */
export interface MenuOption {
  label: string;
  run?: () => void;
  destructive?: boolean;
  submenu?: { title: string; options: MenuOption[] };
}

/** One Android Alert button: an option, the 「更多…」 pager (opens the next page), or 取消. */
export interface MenuButton {
  label: string;
  style: 'default' | 'destructive' | 'cancel';
  option?: MenuOption;
  more?: true;
}

/** RN's Android Alert renders only the first 3 buttons. */
export const ANDROID_MAX_BUTTONS = 3;

/** Android pages: ≤2 options each + 「更多…」 (more pages follow) or 取消 (last page) — every option reachable. */
export function menuPages(options: MenuOption[]): MenuButton[][] {
  const per = ANDROID_MAX_BUTTONS - 1;
  const btn = (o: MenuOption): MenuButton => ({ label: o.label, style: o.destructive ? 'destructive' : 'default', option: o });
  const pages: MenuButton[][] = [];
  let rest = options;
  while (rest.length > per) {
    pages.push([...rest.slice(0, per).map(btn), { label: '更多…', style: 'default', more: true }]);
    rest = rest.slice(per);
  }
  pages.push([...rest.map(btn), { label: '取消', style: 'cancel' }]);
  return pages;
}

/** Long-press menu of a board card. iOS: one action sheet (targets…, 删除 destructive);
 *  Android: [移动到…, 删除] (+ 取消) with the targets in a paginated submenu, so 删除 is never cut off. */
export function cardMenu(
  targets: MoveTarget[], onMove: (t: MoveTarget) => void, onRemove: () => void, os: 'ios' | 'android',
): MenuOption[] {
  const moves: MenuOption[] = targets.map((t) => ({ label: t.label, run: () => onMove(t) }));
  const del: MenuOption = { label: '删除', destructive: true, run: onRemove };
  if (os === 'ios') return [...moves, del];
  return [{ label: '移动到…', submenu: { title: '移动到…', options: moves } }, del];
}
