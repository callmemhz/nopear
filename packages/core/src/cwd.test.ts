import { describe, expect, it } from 'vitest';
import type { Project, Session, SessionIndexEntry } from '@nopear/protocol';
import { joinDir, parentDir, pathCrumbs, recentCwds, sessionPlaceLabel } from './cwd';

const T = (n: number) => `2026-01-01T00:00:${String(n).padStart(2, '0')}.000Z`;
const proj = (id: string, name: string, paths: Record<string, string>): Project =>
  ({ id, name, description: '', paths, createdAt: T(0), updatedAt: T(0) });
const sess = (id: string, cwd: string, at: number, workerId = 'w1'): Session =>
  ({ id, workerId, cwd, lastActivityAt: T(at) } as unknown as Session);
const idx = (sessionId: string, cwd: string, at: number, workerId = 'w1'): SessionIndexEntry => ({
  workerId, sessionId, title: '', preview: '', status: 'idle', projectId: null, cwd, createdAt: T(0), lastActivityAt: T(at),
});

describe('recentCwds', () => {
  it('lists project paths for this worker first (by name), then recent session cwds by lastActivityAt desc', () => {
    const state = {
      projects: { p1: proj('p1', 'Zeta', { w1: '/src/zeta' }), p2: proj('p2', 'Alpha', { w1: '/src/alpha', w2: '/x' }), p3: proj('p3', 'Other', { w2: '/y' }) },
      sessions: { w1: { a: sess('a', '/tmp/old', 1), b: sess('b', '/home/me/new', 5) }, w2: { c: sess('c', '/elsewhere', 9, 'w2') } },
    };
    expect(recentCwds(state, 'w1')).toEqual([
      { path: '/src/alpha', label: 'Alpha', kind: 'project' },
      { path: '/src/zeta', label: 'Zeta', kind: 'project' },
      { path: '/home/me/new', kind: 'recent' },
      { path: '/tmp/old', kind: 'recent' },
    ]);
  });

  it('merges sessionIndex entries of this worker, dedupes against projects and each other, honors limit', () => {
    const state = {
      projects: { p1: proj('p1', 'P', { w1: '/src/p' }) },
      sessions: { w1: { a: sess('a', '/src/p', 9), b: sess('b', '/a', 3) } },
      sessionIndex: {
        'w1/a': idx('a', '/src/p', 9), 'w1/z': idx('z', '/b', 7), 'w1/y': idx('y', '/a', 8),
        'w2/q': idx('q', '/not-mine', 10, 'w2'), 'w1/e': idx('e', '', 11),
      },
    };
    expect(recentCwds(state, 'w1')).toEqual([
      { path: '/src/p', label: 'P', kind: 'project' },
      { path: '/a', kind: 'recent' },
      { path: '/b', kind: 'recent' },
    ]);
    expect(recentCwds(state, 'w1', 2).map((r) => r.path)).toEqual(['/src/p', '/a']);
  });

  it('empty when nothing is known for the worker', () => {
    expect(recentCwds({ projects: {}, sessions: {} }, 'w1')).toEqual([]);
  });
});

describe('path helpers', () => {
  it('parentDir', () => {
    expect(parentDir('/a/b')).toBe('/a');
    expect(parentDir('/a/b/')).toBe('/a');
    expect(parentDir('/a')).toBe('/');
    expect(parentDir('/')).toBe('/');
  });
  it('pathCrumbs', () => {
    expect(pathCrumbs('/a/b')).toEqual([{ name: '/', path: '/' }, { name: 'a', path: '/a' }, { name: 'b', path: '/a/b' }]);
    expect(pathCrumbs('/')).toEqual([{ name: '/', path: '/' }]);
  });
  it('joinDir', () => {
    expect(joinDir('/', 'x')).toBe('/x');
    expect(joinDir('/a', 'x')).toBe('/a/x');
  });
});

describe('sessionPlaceLabel', () => {
  const projects = { p1: proj('p1', 'NoPear', { w1: '/src/nopear' }) };
  it('tagged with a known project → project name', () => {
    expect(sessionPlaceLabel({ projectId: 'p1', cwd: '/src/nopear' }, projects)).toEqual({ kind: 'project', text: 'NoPear' });
  });
  it('untagged or unknown project → cwd basename (trailing slash stripped), full path as title', () => {
    expect(sessionPlaceLabel({ cwd: '/src/other/' }, projects)).toEqual({ kind: 'dir', text: 'other', title: '/src/other/' });
    expect(sessionPlaceLabel({ projectId: 'gone', cwd: '/a/b' }, projects)).toEqual({ kind: 'dir', text: 'b', title: '/a/b' });
  });
  it('null for empty cwd, root, and home dirs', () => {
    expect(sessionPlaceLabel({ cwd: '' }, projects)).toBeNull();
    expect(sessionPlaceLabel({ cwd: '/' }, projects)).toBeNull();
    expect(sessionPlaceLabel({ cwd: '/Users/me' }, projects)).toBeNull();
    expect(sessionPlaceLabel({ cwd: '/home/me/' }, projects)).toBeNull();
    expect(sessionPlaceLabel({ cwd: '/root' }, projects, '/root')).toBeNull();
    expect(sessionPlaceLabel({ cwd: '/root' }, projects)).toEqual({ kind: 'dir', text: 'root', title: '/root' });
    expect(sessionPlaceLabel({ cwd: '/Users/me/code' }, projects, '/Users/me')).toEqual({ kind: 'dir', text: 'code', title: '/Users/me/code' });
  });
});
