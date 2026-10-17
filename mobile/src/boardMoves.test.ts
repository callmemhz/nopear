import { describe, expect, it } from 'vitest';
import type { Card, Machine } from '@nopear/protocol';
import { ANDROID_MAX_BUTTONS, cardMenu, menuPages, moveTargets, type MenuOption } from './boardMoves';

const machine = (workerId: string, label: string, online = true): Machine =>
  ({ workerId, label, workerPub: 'pub', online, lastSeenAt: null, version: '3' });
const card = (p: Partial<Card> = {}): Card => ({
  id: 'c_1', projectId: null, title: 't', body: '', state: 'inbox', workerId: null, sessionId: null,
  order: 1, createdAt: '', updatedAt: '', ...p,
});
const machines = [machine('w_a', 'mac'), machine('w_b', 'linux', false)];

describe('moveTargets', () => {
  it('inbox card: every machine queue + done, not inbox itself', () => {
    expect(moveTargets(card(), machines)).toEqual([
      { label: '待开始 · mac', patch: { state: 'queued', workerId: 'w_a' } },
      { label: '待开始 · linux', patch: { state: 'queued', workerId: 'w_b' } },
      { label: '完成', patch: { state: 'done' } },
    ]);
  });

  it('queued card: excludes its current machine queue', () => {
    expect(moveTargets(card({ state: 'queued', workerId: 'w_a' }), machines)).toEqual([
      { label: '收件箱', patch: { state: 'inbox' } },
      { label: '待开始 · linux', patch: { state: 'queued', workerId: 'w_b' } },
      { label: '完成', patch: { state: 'done' } },
    ]);
  });

  it('done card: inbox + every machine queue, not done', () => {
    expect(moveTargets(card({ state: 'done', workerId: 'w_b' }), machines)).toEqual([
      { label: '收件箱', patch: { state: 'inbox' } },
      { label: '待开始 · mac', patch: { state: 'queued', workerId: 'w_a' } },
      { label: '待开始 · linux', patch: { state: 'queued', workerId: 'w_b' } },
    ]);
  });

  it('never offers 进行中 / 待验收 as targets', () => {
    for (const state of ['inbox', 'queued', 'running', 'review', 'done'] as const) {
      const labels = moveTargets(card({ state, workerId: state === 'inbox' ? null : 'w_a' }), machines).map((t) => t.label);
      expect(labels).not.toContain('进行中');
      expect(labels).not.toContain('待验收');
      for (const t of moveTargets(card({ state }), machines)) expect(['inbox', 'queued', 'done']).toContain(t.patch.state);
    }
  });

  it('running / review cards can still be moved to inbox, any queue, or done', () => {
    expect(moveTargets(card({ state: 'running', workerId: 'w_a' }), machines).map((t) => t.label))
      .toEqual(['收件箱', '待开始 · mac', '待开始 · linux', '完成']);
  });
});

const opts = (n: number): MenuOption[] => Array.from({ length: n }, (_, i) => ({ label: `t${i}`, run: () => {} }));
/** walk every Android page via 「更多…」 and collect the reachable option labels */
const reachable = (options: MenuOption[]) => menuPages(options).flatMap((p) => p.filter((b) => b.option).map((b) => b.label));

describe('menuPages (Android Alert keeps ≤3 buttons)', () => {
  it('≤2 options: one page, options then 取消', () => {
    expect(menuPages(opts(2)).map((p) => p.map((b) => [b.label, b.style]))).toEqual([
      [['t0', 'default'], ['t1', 'default'], ['取消', 'cancel']],
    ]);
  });

  it('many options: pages of ≤2 options + 更多… / 取消, every option reachable in order', () => {
    for (let n = 0; n <= 9; n++) {
      const pages = menuPages(opts(n));
      for (const [i, page] of pages.entries()) {
        expect(page.length).toBeLessThanOrEqual(ANDROID_MAX_BUTTONS);
        const last = page[page.length - 1]!;
        if (i < pages.length - 1) expect([last.label, last.more]).toEqual(['更多…', true]);
        else expect([last.label, last.style]).toEqual(['取消', 'cancel']);
      }
      expect(reachable(opts(n))).toEqual(opts(n).map((o) => o.label));
    }
  });

  it('keeps destructive style on options', () => {
    expect(menuPages([{ label: '删除', run: () => {}, destructive: true }])[0]![0]!.style).toBe('destructive');
  });
});

describe('cardMenu', () => {
  const targets = moveTargets(card({ state: 'running', workerId: 'w_a' }), [...machines, machine('w_c', 'win')]);
  const noop = () => {};

  it('iOS: single sheet — every move target in order, then 删除 (destructive) last', () => {
    const menu = cardMenu(targets, noop, noop, 'ios');
    expect(menu.map((o) => o.label)).toEqual(['收件箱', '待开始 · mac', '待开始 · linux', '待开始 · win', '完成', '删除']);
    expect(menu.map((o) => !!o.destructive)).toEqual([false, false, false, false, false, true]);
    expect(menu.some((o) => o.submenu)).toBe(false);
  });

  it('Android: top level is exactly [移动到…, 删除, 取消]; every target reachable in the submenu', () => {
    const menu = cardMenu(targets, noop, noop, 'android');
    const top = menuPages(menu);
    expect(top).toHaveLength(1);
    expect(top[0]!.map((b) => [b.label, b.style])).toEqual([['移动到…', 'default'], ['删除', 'destructive'], ['取消', 'cancel']]);
    const sub = menu[0]!.submenu!;
    expect(sub.title).toBe('移动到…');
    expect(reachable(sub.options)).toEqual(targets.map((t) => t.label));
    for (const page of menuPages(sub.options)) expect(page.length).toBeLessThanOrEqual(ANDROID_MAX_BUTTONS);
  });

  it('runs the move with the chosen target and remove for 删除', () => {
    const moved: string[] = [];
    let removed = 0;
    const onMove = (t: { label: string }) => moved.push(t.label);
    const ios = cardMenu(targets, onMove, () => removed++, 'ios');
    ios[1]!.run!();
    ios[ios.length - 1]!.run!();
    const android = cardMenu(targets, onMove, () => removed++, 'android');
    android[0]!.submenu!.options[4]!.run!();
    android[1]!.run!();
    expect(moved).toEqual(['待开始 · mac', '完成']);
    expect(removed).toBe(2);
  });
});
