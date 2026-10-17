import { describe, expect, it } from 'vitest';
import type { Card } from '@nopear/protocol';
import { canDropOn, dropPatch, groupBoard } from './collab';

const card = (id: string, p: Partial<Card> = {}): Card => ({
  id, projectId: null, title: id, body: '', state: 'inbox', workerId: null, sessionId: null, order: 0,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...p,
});
const ids = (cs: Card[]) => cs.map((c) => c.id);

describe('groupBoard', () => {
  it('groupBoard splits columns and sorts by order', () => {
    const cards = [
      card('i2', { order: 2 }),
      card('i1', { order: 1 }),
      card('q_w1_b', { state: 'queued', workerId: 'w_1', order: 5 }),
      card('q_w1_a', { state: 'queued', workerId: 'w_1', order: 1 }),
      card('q_w2', { state: 'queued', workerId: 'w_2', order: 0 }),
      card('r1', { state: 'running', workerId: 'w_1' }),
      card('v1', { state: 'review', workerId: 'w_2' }),
      card('d_late', { state: 'done', order: 1, createdAt: '2026-01-03T00:00:00.000Z' }),
      card('d_early', { state: 'done', order: 1, createdAt: '2026-01-02T00:00:00.000Z' }),
      card('d0', { state: 'done', order: 0, createdAt: '2026-01-09T00:00:00.000Z' }),
    ];
    const b = groupBoard(cards);
    expect(ids(b.inbox)).toEqual(['i1', 'i2']);
    expect(Object.keys(b.queued).sort()).toEqual(['w_1', 'w_2']);
    expect(ids(b.queued.w_1!)).toEqual(['q_w1_a', 'q_w1_b']);
    expect(ids(b.queued.w_2!)).toEqual(['q_w2']);
    expect(ids(b.running)).toEqual(['r1']);
    expect(ids(b.review)).toEqual(['v1']);
    expect(ids(b.done)).toEqual(['d0', 'd_early', 'd_late']);
  });

  it('groupBoard filters by projectId when given', () => {
    const cards = [card('a', { projectId: 'p_1' }), card('b', { projectId: 'p_2' }), card('c')];
    expect(ids(groupBoard(cards, 'p_1').inbox)).toEqual(['a']);
    expect(ids(groupBoard(cards, null).inbox)).toEqual(['c']);
    expect(ids(groupBoard(cards).inbox).sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('canDropOn / dropPatch', () => {
  it('canDropOn is false for running/review, true for inbox/queued/done', () => {
    expect(canDropOn('running')).toBe(false);
    expect(canDropOn('review')).toBe(false);
    expect(canDropOn('inbox')).toBe(true);
    expect(canDropOn('queued')).toBe(true);
    expect(canDropOn('done')).toBe(true);
  });

  it('dropPatch builds the CardPatch for a drop', () => {
    expect(dropPatch('queued', 'w_1', 3)).toEqual({ state: 'queued', workerId: 'w_1', order: 3 });
    expect(dropPatch('inbox', null)).toEqual({ state: 'inbox' });
    expect(dropPatch('done', null, 0)).toEqual({ state: 'done', order: 0 });
  });
});
