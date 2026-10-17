// Board helpers shared by web + mobile: split cards into columns, and which drops are allowed.
import type { Card, CardMoveState, CardPatch, CardState } from '@nopear/protocol';

/** Columns of the board; `queued` is split per executing machine (workerId). */
export interface BoardColumns { inbox: Card[]; queued: Record<string, Card[]>; running: Card[]; review: Card[]; done: Card[] }

const byOrder = (a: Card, b: Card) => a.order - b.order || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0);

/** `projectId` undefined = all cards; null = cards without a project; string = that project's cards. */
export function groupBoard(cards: Card[], projectId?: string | null): BoardColumns {
  const out: BoardColumns = { inbox: [], queued: {}, running: [], review: [], done: [] };
  for (const c of cards) {
    if (projectId !== undefined && c.projectId !== projectId) continue;
    if (c.state === 'queued') (out.queued[c.workerId ?? ''] ??= []).push(c);
    else out[c.state].push(c);
  }
  out.inbox.sort(byOrder); out.running.sort(byOrder); out.review.sort(byOrder); out.done.sort(byOrder);
  for (const list of Object.values(out.queued)) list.sort(byOrder);
  return out;
}

/** `running` / `review` are set only by the executing worker — users cannot drop cards there. */
export function canDropOn(target: CardState): boolean {
  return target !== 'running' && target !== 'review';
}

/** PATCH body for dropping a card on a column; `workerId` is sent only for `queued` (= dispatch to that machine). */
export function dropPatch(target: CardMoveState, workerId: string | null, order?: number): CardPatch {
  const p: CardPatch = { state: target };
  if (target === 'queued' && workerId) p.workerId = workerId;
  if (order !== undefined) p.order = order;
  return p;
}
