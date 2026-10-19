import { describe, expect, it } from 'vitest';
import { parseBtw, type BtwAnswer, type Session, type SessionEvent } from '@nopear/protocol';
import { applySessionEvent, dismissBtw, emptyTimeline, upsertBtw } from './timeline';

const b = (id: string, p: Partial<BtwAnswer> = {}): BtwAnswer => ({ id, question: 'q', text: '', status: 'running', ts: '', ...p });
const ev = (btw: BtwAnswer, cursor = 'c'): SessionEvent => ({ type: 'btw', cursor, btw });
const sess: Session = { id: 's', workerId: 'w', kind: 'chat', title: 't', cwd: '/', status: 'running', createdAt: '', lastActivityAt: '', preview: '', pinned: false, starred: false, archived: false, model: 'm', thinking: 'medium', promptCount: 0, taskCount: 0 };

describe('/btw', () => {
  it('parses only a leading /btw', () => {
    expect(parseBtw('/btw what does this function do?')).toBe('what does this function do?');
    expect(parseBtw('  /BTW\nmulti\nline ')).toBe('multi\nline');
    expect(parseBtw('/btw')).toBe('');
    expect(parseBtw('/btwx hi')).toBeNull();
    expect(parseBtw('hello /btw hi')).toBeNull();
  });

  it('streams in place (updates keep their position), next to the session, not in it', () => {
    let t = upsertBtw(emptyTimeline(), b('a'));
    t = applySessionEvent(t, ev(b('b', { question: 'second' })));
    t = applySessionEvent(t, ev(b('a', { text: 'partial' })));
    t = applySessionEvent(t, ev(b('a', { text: 'full answer', status: 'done' })));
    expect(t.btw.map((x) => [x.id, x.text, x.status])).toEqual([['a', 'full answer', 'done'], ['b', '', 'running']]);
    expect(t.messages).toEqual([]);
    // a snapshot (reconnect) keeps them
    t = applySessionEvent(t, { type: 'snapshot', cursor: 'c2', session: sess, messages: [], hasMore: false, prompts: [], tasks: [], queue: [] });
    expect(t.btw.length).toBe(2);
  });

  it('a closed answer stays closed while it keeps streaming', () => {
    let t = applySessionEvent(emptyTimeline(), ev(b('a', { text: 'x' })));
    t = dismissBtw(t, 'a');
    expect(t.btw).toEqual([]);
    t = applySessionEvent(t, ev(b('a', { text: 'xy', status: 'done' })));
    expect(t.btw).toEqual([]);
    expect(t.cursor).toBe('c');
  });
});
