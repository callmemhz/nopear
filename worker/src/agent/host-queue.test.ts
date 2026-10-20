// Message queue: queued sends are mirrored as `queue` events / snapshot.queue and can be
// cancelled, edited and switched followUp ↔ steer. Real pi + faux provider ("slow:" keeps a run going ~400ms).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message, QueueItem, SessionEvent } from '@nopear/protocol';
import { loadConfig } from '../config';
import { OpError } from '../errors';
import { BlobStore } from './blobs';
import { MetaStore } from './meta-store';
import { createModelRuntime } from './models';
import { SessionHost } from './host';

process.env.NOPEAR_TEST_FAUX = '1';

const hosts: SessionHost[] = [];
after(async () => { for (const h of hosts) await h.shutdown().catch(() => {}); });
const rtP = (async () => {
  const home = mkdtempSync(join(tmpdir(), 'hostq-rt-'));
  return createModelRuntime(loadConfig({ NOPEAR_SAAS_URL: 'http://s', NOPEAR_HOME: home, NOPEAR_PI_AUTH: join(home, 'a.json'), NOPEAR_PI_MODELS: join(home, 'm.json') }));
})();

async function makeHost(): Promise<SessionHost> {
  const home = mkdtempSync(join(tmpdir(), 'hostq-'));
  const cfg = loadConfig({ NOPEAR_SAAS_URL: 'http://saas.test', NOPEAR_HOME: home, NOPEAR_DEFAULT_CWD: join(home, 'work'), NOPEAR_DEFAULT_MODEL: 'faux/echo',
    NOPEAR_PI_AUTH: join(home, 'auth.json'), NOPEAR_PI_MODELS: join(home, 'models.json'), NOPEAR_IDLE_DISPOSE_MS: '60000' });
  const meta = new MetaStore(join(home, 'sessions.json'));
  await meta.load();
  const host = new SessionHost({ config: cfg, meta, blobs: new BlobStore(cfg.blobsDir), models: await rtP, workerId: 'w_test' });
  await host.init();
  hosts.push(host);
  return host;
}

class Watcher {
  events: SessionEvent[] = [];
  private ac = new AbortController();
  done: Promise<void>;
  constructor(host: SessionHost, id: string) {
    this.done = host.watch(id, undefined, (e) => this.events.push(e), this.ac.signal);
  }
  async until(pred: (evs: SessionEvent[]) => boolean, ms = 10000): Promise<void> {
    const t0 = Date.now();
    while (!pred(this.events)) {
      if (Date.now() - t0 > ms) throw new Error('timeout; got ' + this.events.map((e) => e.type).join(','));
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  /** The latest queue state seen (snapshot.queue or a queue event). */
  get queue(): QueueItem[] {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i]!;
      if (e.type === 'queue') return e.items;
      if (e.type === 'snapshot') return e.queue;
    }
    return [];
  }
  stop(): Promise<void> { this.ac.abort(); return this.done; }
}
const textOf = (m: Message) => m.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
const ids = (q: QueueItem[]) => q.map((x) => `${x.id}:${x.delivery}`);
async function users(host: SessionHost, sid: string): Promise<Message[]> {
  return (await host.page({ sessionId: sid })).messages.filter((m) => m.role === 'user');
}
const notFound = (e: unknown) => e instanceof OpError && e.code === 'not_found';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('a queued send emits a queue event, shows in snapshots, and leaves the queue once delivered', async () => {
  const host = await makeHost();
  const s = await host.create({ text: 'slow: run', clientMsgId: 'c0' });
  const w = new Watcher(host, s.id);
  await w.until((e) => e.length > 0);
  const r = await host.send({ sessionId: s.id, text: 'next', clientMsgId: 'f1' });
  assert.deepEqual(r, { queued: true });
  await w.until(() => w.queue.length === 1);
  assert.deepEqual(w.queue.map(({ id, text, delivery, attachments }) => ({ id, text, delivery, attachments })),
    [{ id: 'f1', text: 'next', delivery: 'followUp', attachments: 0 }]);
  assert.ok(w.queue[0]!.createdAt);
  // a new watcher's snapshot carries the queue
  const w2 = new Watcher(host, s.id);
  await w2.until((e) => e.length > 0);
  const snap = w2.events[0]!;
  assert.equal(snap.type, 'snapshot');
  assert.deepEqual(snap.type === 'snapshot' && ids(snap.queue), ['f1:followUp']);
  await w2.stop();
  await host.waitIdle(s.id);
  await w.until(() => w.queue.length === 0);
  // the queue event dropping f1 comes before f1's persisted user message
  const qi = w.events.findIndex((e) => e.type === 'queue' && e.items.length === 0);
  const ui = w.events.findIndex((e) => e.type === 'message.upsert' && e.message.clientMsgId === 'f1');
  assert.ok(qi >= 0 && ui > qi, `queue(empty)@${qi} before upsert(f1)@${ui}`);
  assert.deepEqual((await users(host, s.id)).map((m) => [textOf(m), m.clientMsgId]), [['slow: run', 'c0'], ['next', 'f1']]);
  await assert.rejects(host.queueRemove({ sessionId: s.id, id: 'f1' }), notFound);
  await assert.rejects(host.queueUpdate({ sessionId: s.id, id: 'f1', text: 'x' }), notFound);
  await w.stop();
});

test('remove cancels one queued message; the others keep their order and clientMsgIds', async () => {
  const host = await makeHost();
  const s = await host.create({ text: 'slow: run', clientMsgId: 'c0' });
  const w = new Watcher(host, s.id);
  await w.until((e) => e.length > 0);
  for (const id of ['a', 'b', 'c']) await host.send({ sessionId: s.id, text: `slow: ${id}`, clientMsgId: id });
  await w.until(() => w.queue.length === 3);
  assert.deepEqual(ids(w.queue), ['a:followUp', 'b:followUp', 'c:followUp']);
  await host.queueRemove({ sessionId: s.id, id: 'b' });
  await w.until(() => !w.queue.some((q) => q.id === 'b'));
  assert.deepEqual(ids(w.queue), ['a:followUp', 'c:followUp']);
  await assert.rejects(host.queueRemove({ sessionId: s.id, id: 'b' }), notFound);
  await host.waitIdle(s.id);
  assert.deepEqual((await users(host, s.id)).map((m) => [textOf(m), m.clientMsgId]), [['slow: run', 'c0'], ['slow: a', 'a'], ['slow: c', 'c']]);
  assert.deepEqual(w.queue, []);
  await w.stop();
});

test('edit text keeps the id and the attachments; the edited text is what gets delivered', async () => {
  const host = await makeHost();
  const s = await host.create({ text: 'slow: run', clientMsgId: 'c0' });
  const w = new Watcher(host, s.id);
  await w.until((e) => e.length > 0);
  await host.send({ sessionId: s.id, text: 'draft', clientMsgId: 'e1', attachments: [{ kind: 'image', name: 'p.png', mediaType: 'image/png', dataBase64: PNG }] });
  await w.until(() => w.queue.length === 1);
  assert.equal(w.queue[0]!.attachments, 1);
  await host.queueUpdate({ sessionId: s.id, id: 'e1', text: 'final text' });
  await w.until(() => w.queue[0]?.text === 'final text');
  assert.deepEqual(ids(w.queue), ['e1:followUp']);
  await host.waitIdle(s.id);
  const u = (await users(host, s.id)).at(-1)!;
  assert.equal(textOf(u), 'final text');
  assert.equal(u.clientMsgId, 'e1');
  assert.ok(u.blocks.some((b) => b.type === 'image'), 'the image survives the re-queue');
  await w.stop();
});

test('an empty edit of a text-only queued message is rejected', async () => {
  const host = await makeHost();
  const s = await host.create({ text: 'slow: run', clientMsgId: 'c0' });
  await host.send({ sessionId: s.id, text: 'keep me', clientMsgId: 'k1' });
  await assert.rejects(host.queueUpdate({ sessionId: s.id, id: 'k1', text: '  ' }), (e: unknown) => e instanceof OpError && e.code === 'bad_request');
  await host.waitIdle(s.id);
  assert.equal(textOf((await users(host, s.id)).at(-1)!), 'keep me');
});

test('converting a followUp to steer delivers it before the remaining followUps', async () => {
  const host = await makeHost();
  const s = await host.create({ text: 'slow: run', clientMsgId: 'c0' });
  const w = new Watcher(host, s.id);
  await w.until((e) => e.length > 0);
  await host.send({ sessionId: s.id, text: 'first', clientMsgId: 'f1' });
  await host.send({ sessionId: s.id, text: 'urgent', clientMsgId: 'f2' });
  await w.until(() => w.queue.length === 2);
  assert.deepEqual(ids(w.queue), ['f1:followUp', 'f2:followUp']);
  await host.queueUpdate({ sessionId: s.id, id: 'f2', delivery: 'steer' });
  await w.until(() => w.queue[0]?.delivery === 'steer');
  assert.deepEqual(ids(w.queue), ['f2:steer', 'f1:followUp']);
  await host.waitIdle(s.id);
  assert.deepEqual((await users(host, s.id)).map((m) => [textOf(m), m.clientMsgId]), [['slow: run', 'c0'], ['urgent', 'f2'], ['first', 'f1']]);
  assert.deepEqual(w.queue, []);
  await w.stop();
});

test('a steer send is queued as steer, ahead of earlier followUps', async () => {
  const host = await makeHost();
  const s = await host.create({ text: 'slow: run', clientMsgId: 'c0' });
  const w = new Watcher(host, s.id);
  await w.until((e) => e.length > 0);
  await host.send({ sessionId: s.id, text: 'later', clientMsgId: 'f1' });
  await host.send({ sessionId: s.id, text: 'now', clientMsgId: 's1', delivery: 'steer' });
  await w.until(() => w.queue.length === 2);
  assert.deepEqual(ids(w.queue), ['s1:steer', 'f1:followUp']);
  await host.waitIdle(s.id);
  assert.deepEqual((await users(host, s.id)).map(textOf), ['slow: run', 'now', 'later']);
  await w.stop();
});

test('an attachments-only queued message (no text) leaves the queue once delivered, as steer and as followUp', async () => {
  for (const delivery of ['steer', 'followUp'] as const) {
    const host = await makeHost();
    const s = await host.create({ text: 'slow: run', clientMsgId: 'c0' });
    const w = new Watcher(host, s.id);
    await w.until((e) => e.length > 0);
    const img = { kind: 'image' as const, name: 'p.png', mediaType: 'image/png', dataBase64: PNG };
    assert.deepEqual(await host.send({ sessionId: s.id, text: '', clientMsgId: 'a1', attachments: [img], delivery }), { queued: true });
    await w.until(() => w.queue.length === 1);
    assert.deepEqual(ids(w.queue), [`a1:${delivery}`]);
    await host.waitIdle(s.id);
    await w.until(() => w.queue.length === 0); // pi skips text-less messages when clearing its queue: this hung
    const u = (await users(host, s.id)).at(-1)!;
    assert.equal(u.clientMsgId, 'a1');
    assert.ok(u.blocks.some((b) => b.type === 'image'));
    assert.deepEqual(host.get(s.id).status, 'idle');
    await w.stop();
  }
});
