import { describe, expect, it } from 'vitest';
import type { Project, Session } from '@nopear/protocol';
import {
  groupSessions, latestSession, loadCollapsed, matchesSearch, parseCollapsed, pickProjectTarget, saveCollapsed, serializeCollapsed,
  toggleCollapsed, UNGROUPED,
} from './sessionGroups';

const T = (n: number) => `2026-10-11T00:00:${String(n).padStart(2, '0')}Z`;
const sess = (id: string, at: number, over: Partial<Session> = {}): Session => ({
  id, workerId: 'w1', kind: 'chat', title: id, cwd: '', status: 'idle', createdAt: T(0), lastActivityAt: T(at), preview: '',
  pinned: false, starred: false, archived: false, model: 'm', thinking: 'off', promptCount: 0, taskCount: 0, ...over,
});
const proj = (id: string, name: string, paths: Record<string, string> = {}): Project =>
  ({ id, name, description: '', paths, createdAt: T(0), updatedAt: T(0) });
const projects = { p1: proj('p1', 'Alpha'), p2: proj('p2', 'Beta') };
const ids = (l: Session[]) => l.map((s) => s.id);

describe('groupSessions', () => {
  const list = [
    sess('a1', 1, { projectId: 'p1' }),
    sess('b1', 5, { projectId: 'p2' }),
    sess('a2', 3, { projectId: 'p1' }),
    sess('n1', 9),
    sess('stale', 2, { projectId: 'gone' }),
    sess('pin', 4, { projectId: 'p1', pinned: true }),
    sess('arch', 8, { projectId: 'p1', archived: true }),
  ];
  it('groups by project, most recently active first, sessions newest first; untagged/unknown → 未分类 last; pinned apart', () => {
    const r = groupSessions(list, projects, { filter: 'all', project: '', query: '' });
    expect(ids(r.pinned)).toEqual(['pin']);
    expect(r.groups.map((g) => [g.id, g.name, ids(g.sessions)])).toEqual([
      ['p2', 'Beta', ['b1']],
      ['p1', 'Alpha', ['a2', 'a1']],
      [UNGROUPED, '未分类', ['n1', 'stale']],
    ]);
  });
  it('starred / archived filters (archived: no pinned section)', () => {
    const starred = groupSessions([...list, sess('s', 1, { starred: true })], projects, { filter: 'starred', project: '', query: '' });
    expect(starred.groups.flatMap((g) => ids(g.sessions))).toEqual(['s']);
    const archived = groupSessions([...list, sess('ap', 1, { archived: true, pinned: true })], projects, { filter: 'archived', project: '', query: '' });
    expect(archived.pinned).toEqual([]);
    expect(archived.groups.map((g) => [g.id, ids(g.sessions)])).toEqual([['p1', ['arch']], [UNGROUPED, ['ap']]]);
  });
  it('project filter', () => {
    expect(groupSessions(list, projects, { filter: 'all', project: 'p1', query: '' }).groups.map((g) => g.id)).toEqual(['p1']);
    expect(groupSessions(list, projects, { filter: 'all', project: UNGROUPED, query: '' }).groups.flatMap((g) => ids(g.sessions))).toEqual(['n1']);
  });
  it('search filters by title / preview, case-insensitive, also inside pinned', () => {
    const l = [sess('x', 1, { title: 'Fix Login bug' }), sess('y', 2, { preview: 'deploy the login page', pinned: true }), sess('z', 3, { title: 'other' })];
    const r = groupSessions(l, projects, { filter: 'all', project: '', query: '  LOGIN ' });
    expect(ids(r.pinned)).toEqual(['y']);
    expect(r.groups.flatMap((g) => ids(g.sessions))).toEqual(['x']);
  });
  it('matchesSearch', () => {
    expect(matchesSearch(sess('q', 1, { title: '', preview: '' }), '')).toBe(true);
    expect(matchesSearch(sess('q', 1, { title: '迁移数据' }), '迁移')).toBe(true);
    expect(matchesSearch(sess('q', 1, { title: 'abc' }), 'zzz')).toBe(false);
  });
});

describe('collapsed persistence', () => {
  it('round-trips through storage and tolerates garbage', () => {
    const m = new Map<string, string>();
    const st = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
    expect(loadCollapsed(st, 'k')).toEqual(new Set());
    saveCollapsed(st, 'k', new Set(['p1', UNGROUPED]));
    expect(loadCollapsed(st, 'k')).toEqual(new Set(['p1', UNGROUPED]));
    m.set('k', '{not json');
    expect(loadCollapsed(st, 'k')).toEqual(new Set());
    m.set('k', '{"a":1}');
    expect(loadCollapsed(st, 'k')).toEqual(new Set());
  });
});

describe('pickProjectTarget', () => {
  const p = proj('p1', 'Alpha', { w1: '/src/a', w2: '/home/b' });
  const online = new Set(['w1', 'w2']);
  it('prefers the current session machine, then the group\'s latest machine, then any online machine with a path', () => {
    expect(pickProjectTarget(p, { current: 'w2', recent: ['w1'], online })).toEqual({ workerId: 'w2', cwd: '/home/b' });
    expect(pickProjectTarget(p, { current: 'w9', recent: ['w1'], online })).toEqual({ workerId: 'w1', cwd: '/src/a' });
    expect(pickProjectTarget(p, { recent: [], online: new Set(['w2']) })).toEqual({ workerId: 'w2', cwd: '/home/b' });
    expect(pickProjectTarget(p, { current: 'w1', recent: [], online: new Set(['w2']) })).toEqual({ workerId: 'w2', cwd: '/home/b' });
  });
  it('no online machine with a path → no target', () => {
    expect(pickProjectTarget(p, { recent: [], online: new Set(['w3']) })).toEqual({});
  });
});

describe('parse / serialize / toggle collapsed', () => {
  it('round-trips and tolerates null / garbage', () => {
    expect(parseCollapsed(null)).toEqual(new Set());
    expect(parseCollapsed(undefined)).toEqual(new Set());
    expect(parseCollapsed('nope')).toEqual(new Set());
    expect(parseCollapsed('[1,"a",null,"b"]')).toEqual(new Set(['a', 'b']));
    expect(parseCollapsed(serializeCollapsed(new Set(['p1', UNGROUPED])))).toEqual(new Set(['p1', UNGROUPED]));
  });
  it('toggle returns a new set and leaves the input untouched', () => {
    const a = new Set(['p1']);
    const b = toggleCollapsed(a, 'p2');
    expect(b).toEqual(new Set(['p1', 'p2']));
    expect(a).toEqual(new Set(['p1']));
    expect(toggleCollapsed(b, 'p1')).toEqual(new Set(['p2']));
  });
});

describe('latestSession', () => {
  it('picks the newest non-archived session', () => {
    expect(latestSession([])).toBeNull();
    const l = [sess('a', 3), sess('b', 7, { archived: true }), sess('c', 5), sess('d', 1)];
    expect(latestSession(l)?.id).toBe('c');
    expect(latestSession([sess('x', 1, { archived: true })])).toBeNull();
  });
});
