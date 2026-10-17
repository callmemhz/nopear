import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionIndexEntry, type Card, type Session, type SessionIndexEntry, type SessionKind, type ToolName, type ToolOutcome } from '@nopear/protocol';
import type { CollabLink } from './link';
import { startIndexSync } from './index-sync';

type IndexFrame = { full: boolean; sessions: SessionIndexEntry[]; removed: string[] };
class FakeLink implements CollabLink {
  readonly workerId = 'w1';
  isConnected = false;
  index: IndexFrame[] = [];
  private conn = new Set<() => void>();
  connected(): boolean { return this.isConnected; }
  async callTool(_n: ToolName, _a: Record<string, unknown>, _s?: string): Promise<ToolOutcome> {
    return { ok: false, error: { code: 'internal', message: 'unused' } };
  }
  sendIndex(f: IndexFrame): void { this.index.push(f); }
  sendCardState(_f: { cardId: string; state: 'running' | 'review'; sessionId?: string; error?: string }): void {}
  onCards(_fn: (cards: Card[]) => void): () => void { return () => {}; }
  onProjectsChanged(_fn: () => void): () => void { return () => {}; }
  onConnected(fn: () => void): () => void { this.conn.add(fn); return () => { this.conn.delete(fn); }; }
  onClaimChanged(_fn: (s: { claimed: boolean; userId?: string }) => void): () => void { return () => {}; }
  connect(): void { this.isConnected = true; for (const fn of this.conn) fn(); }
}

const T = '2026-10-11T00:00:00.000Z';
const session = (id: string, extra: Partial<Session> = {}): Session => ({
  id, workerId: 'w1', kind: 'chat', title: id, cwd: '/x', status: 'idle', createdAt: T, lastActivityAt: T, preview: '',
  pinned: false, starred: false, archived: false, model: 'faux/echo', thinking: 'medium', promptCount: 0, taskCount: 0, ...extra,
});

class FakeHost {
  sessions: Session[] = [session('a', { projectId: 'p1' }), session('b')];
  listArgs: { kinds?: SessionKind[] }[] = [];
  listeners = new Set<(s: Session, removed?: boolean) => void>();
  list(a: { kinds?: SessionKind[] }): Session[] { this.listArgs.push(a); return this.sessions; }
  onSessionChange(l: (s: Session, removed?: boolean) => void): () => void { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
  change(s: Session, removed?: boolean): void { for (const l of this.listeners) l(s, removed); }
}

test('onConnected → full index of all chat sessions', () => {
  const host = new FakeHost();
  const link = new FakeLink();
  startIndexSync({ host, link });
  assert.equal(link.index.length, 0, 'not connected yet');
  link.connect();
  assert.deepEqual(host.listArgs.at(-1), { kinds: ['chat'] });
  assert.deepEqual(link.index, [{ full: true, sessions: host.sessions.map(sessionIndexEntry), removed: [] }]);
  assert.equal(link.index[0]!.sessions[1]!.projectId, null);
  link.connect(); // reconnect → full again
  assert.equal(link.index.length, 2);
  assert.equal(link.index[1]!.full, true);
});

test('starting while already connected sends a full index right away', () => {
  const host = new FakeHost();
  const link = new FakeLink();
  link.isConnected = true;
  startIndexSync({ host, link });
  assert.deepEqual(link.index, [{ full: true, sessions: host.sessions.map(sessionIndexEntry), removed: [] }]);
});

test('session change → incremental entry; removal → removed id', () => {
  const host = new FakeHost();
  const link = new FakeLink();
  startIndexSync({ host, link });
  link.connect();
  link.index = [];
  const s = session('c', { status: 'running', projectId: 'p2' });
  host.change(s);
  host.change(session('b'), true);
  assert.deepEqual(link.index, [
    { full: false, sessions: [sessionIndexEntry(s)], removed: [] },
    { full: false, sessions: [], removed: ['b'] },
  ]);
});

test('changes while disconnected are not sent; stop() unsubscribes', () => {
  const host = new FakeHost();
  const link = new FakeLink();
  const { stop } = startIndexSync({ host, link });
  host.change(session('c'));
  assert.deepEqual(link.index, []);
  link.connect();
  stop();
  host.change(session('d'));
  link.connect();
  assert.equal(link.index.length, 1);
});

test('sendFull() re-sends the full index on demand (e.g. after a claim change); no-op while disconnected', () => {
  const host = new FakeHost();
  const link = new FakeLink();
  const sync = startIndexSync({ host, link });
  sync.sendFull();
  assert.deepEqual(link.index, [], 'not connected: nothing sent');
  link.connect();
  host.sessions = [...host.sessions, session('c')];
  sync.sendFull();
  assert.equal(link.index.length, 2);
  assert.deepEqual(link.index[1], { full: true, sessions: host.sessions.map(sessionIndexEntry), removed: [] });
});
