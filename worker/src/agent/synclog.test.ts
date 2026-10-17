import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SyncLog, newEpoch } from './synclog';

const ev = (i: number) => ({ type: 'tool.progress' as const, toolCallId: 't', text: String(i) });

test('newEpoch is 8 base32 chars', () => {
  assert.match(newEpoch(), /^[a-z2-7]{8}$/);
  assert.notEqual(newEpoch(), newEpoch());
});

test('assigns increasing cursors and replays after a cursor', () => {
  const log = new SyncLog('abcdefgh');
  assert.equal(log.current(), 'abcdefgh.0');
  const a = log.append(ev(1));
  const b = log.append(ev(2));
  const c = log.append(ev(3));
  assert.equal(a.cursor, 'abcdefgh.1');
  assert.equal(c.cursor, 'abcdefgh.3');
  assert.deepEqual(log.since(a.cursor), [b, c]);
  assert.deepEqual(log.since(c.cursor), []);
  assert.deepEqual(log.since('abcdefgh.0'), [a, b, c]);
  assert.equal(log.current(), 'abcdefgh.3');
});

test('needs snapshot: no cursor, other epoch, malformed, future, or older than window', () => {
  const log = new SyncLog('abcdefgh', 3);
  for (let i = 0; i < 5; i++) log.append(ev(i)); // keeps n=3..5
  assert.equal(log.since(undefined), null);
  assert.equal(log.since('zzzzzzzz.4'), null);
  assert.equal(log.since('garbage'), null);
  assert.equal(log.since('abcdefgh.9'), null);
  assert.equal(log.since('abcdefgh.1'), null); // n=2 already dropped
  assert.deepEqual(log.since('abcdefgh.2')?.map((e) => e.cursor), ['abcdefgh.3', 'abcdefgh.4', 'abcdefgh.5']);
});

test('caps retained events by total serialized bytes', () => {
  const big = (i: number) => ({ type: 'tool.progress' as const, toolCallId: 't', text: String(i).padEnd(1000, 'x') });
  const log = new SyncLog('abcdefgh', 1000, 4000); // ~1KB each → only ~3 retained
  const evs = Array.from({ length: 10 }, (_, i) => log.append(big(i)));
  assert.equal(log.since(evs[0]!.cursor), null);
  const tail = log.since(evs[7]!.cursor);
  assert.deepEqual(tail?.map((e) => e.cursor), [evs[8]!.cursor, evs[9]!.cursor]);
});
