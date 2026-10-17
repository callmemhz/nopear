// ops: every RpcCatalog op + both watches, driven directly (no tunnel) against a real SessionHost
// on the faux provider.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MachineEvent, SessionEvent } from '@nopear/protocol';
import { loadConfig, type WorkerConfig } from './config';
import { OpError } from './errors';
import { BlobStore } from './agent/blobs';
import { MetaStore } from './agent/meta-store';
import { createModelRuntime } from './agent/models';
import { SessionHost } from './agent/host';
import { createOps } from './ops';
import type { OpHandlers, WatchHandlers } from './gateway';

process.env.NOPEAR_TEST_FAUX = '1';
const ctx = { clientPub: 'c' };
let cfg: WorkerConfig;
let host: SessionHost;
let ops: OpHandlers;
let watches: WatchHandlers;

before(async () => {
  const home = mkdtempSync(join(tmpdir(), 'ops-'));
  cfg = loadConfig({ NOPEAR_SAAS_URL: 'http://saas.test', NOPEAR_HOME: home, NOPEAR_DEFAULT_CWD: join(home, 'work'), NOPEAR_DEFAULT_MODEL: 'faux/echo',
    NOPEAR_PI_AUTH: join(home, 'auth.json'), NOPEAR_PI_MODELS: join(home, 'models.json'), NOPEAR_IDLE_DISPOSE_MS: '60000' });
  mkdirSync(cfg.defaultCwd, { recursive: true });
  const rt = await createModelRuntime(cfg);
  const meta = new MetaStore(join(cfg.home, 'sessions.json'));
  await meta.load();
  const blobs = new BlobStore(cfg.blobsDir);
  host = new SessionHost({ config: cfg, meta, blobs, models: rt, workerId: 'w_ops' });
  await host.init();
  ({ ops, watches } = createOps({ config: cfg, host, blobs }));
});

after(async () => { await host?.shutdown(); });

class MachineWatcher {
  events: MachineEvent[] = [];
  private ac = new AbortController();
  done: Promise<void>;
  constructor() { this.done = watches['machine.watch']({}, (e) => this.events.push(e), this.ac.signal, ctx); }
  async until(pred: (e: MachineEvent) => boolean, ms = 8000): Promise<MachineEvent> {
    const t0 = Date.now();
    for (;;) {
      const hit = this.events.find(pred);
      if (hit) return hit;
      if (Date.now() - t0 > ms) throw new Error('timeout; got ' + this.events.map((e) => e.type).join(','));
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  stop(): Promise<void> { this.ac.abort(); return this.done; }
}

async function code(p: Promise<unknown>): Promise<string> {
  try { await p; return 'ok'; } catch (e) { return e instanceof OpError ? e.code : `other:${(e as Error).message}`; }
}

test('worker.info lists the faux model', async () => {
  const info = await ops['worker.info']({}, ctx);
  assert.equal(info.workerId, 'w_ops');
  assert.ok(info.models.some((m) => m.id === 'faux/echo'));
});

test('sessions: create → list (chat only by default) → get → update → page → send → session.watch', async () => {
  const { session } = await ops['sessions.create']({ text: 'hello', clientMsgId: 'c1' }, ctx);
  assert.equal(session.kind, 'chat');
  const listed = (await ops['sessions.list']({}, ctx)).sessions;
  assert.ok(listed.some((s) => s.id === session.id));
  assert.ok(listed.every((s) => s.kind === 'chat'));
  assert.equal((await ops['sessions.get']({ sessionId: session.id }, ctx)).session.id, session.id);

  const up = await ops['sessions.update']({ sessionId: session.id, pinned: true, archived: true }, ctx);
  assert.equal(up.session.pinned, true);
  assert.equal(up.session.archived, true);
  assert.ok((await ops['sessions.list']({ archived: true }, ctx)).sessions.some((s) => s.id === session.id));
  assert.ok(!(await ops['sessions.list']({ archived: false }, ctx)).sessions.some((s) => s.id === session.id));

  const evs: SessionEvent[] = [];
  const ac = new AbortController();
  const done = watches['session.watch']({ sessionId: session.id }, (e) => evs.push(e), ac.signal, ctx);
  const t0 = Date.now();
  while (!evs.some((e) => e.type === 'message.upsert' && e.message.role === 'assistant' && e.message.status === 'complete')
    && !(evs[0]?.type === 'snapshot' && evs[0].messages.some((m) => m.role === 'assistant' && m.status === 'complete'))) {
    if (Date.now() - t0 > 8000) throw new Error('no assistant reply; got ' + evs.map((e) => e.type).join(','));
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(evs[0]!.type, 'snapshot');
  ac.abort();
  await done;

  const page = await ops['messages.page']({ sessionId: session.id }, ctx);
  assert.ok(page.messages.some((m) => m.role === 'user' && m.clientMsgId === 'c1'));
  assert.equal(await code(ops['sessions.interrupt']({ sessionId: session.id }, ctx)), 'conflict');
  assert.equal(await code(ops['sessions.get']({ sessionId: 'nope' }, ctx)), 'not_found');
});

test('files.list / files.read (binary) resolve against the session cwd', async () => {
  writeFileSync(join(cfg.defaultCwd, 'a.txt'), 'hi there');
  const { session } = await ops['sessions.create']({ text: '', clientMsgId: 'c-files' }, ctx);
  const ls = await ops['files.list']({ sessionId: session.id }, ctx);
  assert.ok(ls.entries.some((e) => e.name === 'a.txt' && e.type === 'file'));
  const f = await ops['files.read']({ sessionId: session.id, path: 'a.txt' }, ctx);
  assert.equal(Buffer.from(f.bytes).toString('utf8'), 'hi there');
  assert.equal(f.name, 'a.txt');
  assert.equal(await code(ops['files.read']({ sessionId: session.id, path: 'missing.txt' }, ctx)), 'not_found');
});

test('dirs.list: machine-level, defaults to defaultCwd, dirs only', async () => {
  mkdirSync(join(cfg.defaultCwd, 'picker-sub'), { recursive: true });
  const ls = await ops['dirs.list']({}, ctx);
  assert.equal(ls.path, cfg.defaultCwd);
  assert.ok(ls.entries.some((e) => e.name === 'picker-sub' && e.type === 'dir'));
  assert.ok(ls.entries.every((e) => e.type === 'dir'));
  assert.equal(await code(ops['dirs.list']({ path: join(cfg.defaultCwd, 'missing-dir') }, ctx)), 'not_found');
});

test('memory.put → memory.get; blobs.get missing → not_found', async () => {
  const put = await ops['memory.put']({ scope: 'global', content: '# rules' }, ctx);
  assert.equal(put.file.exists, true);
  const got = await ops['memory.get']({}, ctx);
  assert.equal(got.files.find((f) => f.scope === 'global')?.content, '# rules');
  assert.equal(await code(ops['blobs.get']({ hash: 'a'.repeat(64) }, ctx)), 'not_found');
});

test('machine.watch: snapshot carries worker + chat sessions (incl. archived), no projects; then session events', async () => {
  const w = new MachineWatcher();
  const snap = await w.until((e) => e.type === 'snapshot');
  assert.equal(snap.type, 'snapshot');
  if (snap.type === 'snapshot') {
    assert.equal(snap.worker.workerId, 'w_ops');
    assert.ok(snap.sessions.length > 0);
    assert.ok(snap.sessions.every((s) => s.kind === 'chat'));
    assert.ok(snap.sessions.some((s) => s.archived), 'snapshot includes archived sessions');
    assert.ok(!('projects' in snap), 'no projects in the machine snapshot');
  }
  const { session } = await ops['sessions.create']({ text: '', clientMsgId: 'c-mw' }, ctx);
  await w.until((e) => e.type === 'session.updated' && e.session.id === session.id);
  await w.stop();
});
