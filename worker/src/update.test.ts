import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkerUpdateState } from '@nopear/protocol';
import { canSelfUpdate, readBuild, serviceManager, swapInNewCode, Updater, writePidFile } from './update';

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

test('build / service detection / capability', () => {
  const root = mkdtempSync(join(tmpdir(), 'upd-'));
  assert.equal(readBuild(root), undefined); // source checkout
  writeFileSync(join(root, 'nopear-build.json'), '{"build":"abc123def456"}');
  assert.equal(readBuild(root), 'abc123def456');
  writeFileSync(join(root, 'nopear-build.json'), '{"build":"../evil"}');
  assert.equal(readBuild(root), undefined);
  const no = () => false;
  assert.equal(serviceManager({ XPC_SERVICE_NAME: 'dev.nopear.worker' }, no), 'launchd');
  assert.equal(serviceManager({ XPC_SERVICE_NAME: '0' }, () => true), 'launchd'); // older install: found via the job's pid
  assert.equal(serviceManager({ XPC_SERVICE_NAME: 'com.apple.Terminal' }, no), null);
  assert.equal(serviceManager({ INVOCATION_ID: 'x' }, no), 'systemd');
  assert.equal(serviceManager({ NOPEAR_SERVICE: 'launchd' }, no), 'launchd');
  assert.equal(serviceManager({}, no), null);
  assert.equal(canSelfUpdate({ build: 'b', autoUpdate: true, env: { INVOCATION_ID: 'x' } }), true);
  assert.equal(canSelfUpdate({ build: 'b', autoUpdate: false, env: { INVOCATION_ID: 'x' } }), false);
  assert.equal(canSelfUpdate({ build: undefined, autoUpdate: true, env: { INVOCATION_ID: 'x' } }), false);
  assert.equal(canSelfUpdate({ build: 'b', autoUpdate: true, env: {}, launchdJobIsAncestor: () => false }), false); // manual nohup: nobody restarts it
});

test('pid file: written, removed only if still ours', () => {
  const home = mkdtempSync(join(tmpdir(), 'upd-home-'));
  const rm = writePidFile(home);
  assert.equal(readFileSync(join(home, 'worker.pid'), 'utf8').trim(), String(process.pid));
  rm();
  assert.equal(existsSync(join(home, 'worker.pid')), false);
  const rm2 = writePidFile(home);
  writeFileSync(join(home, 'worker.pid'), '999999\n'); // a newer worker took over
  rm2();
  assert.equal(readFileSync(join(home, 'worker.pid'), 'utf8').trim(), '999999');
});

function harness(o: { busy: number[]; code?: number; output?: string; fetchFails?: boolean }) {
  const states: Array<[WorkerUpdateState, string | undefined]> = [];
  let restarts = 0;
  const scripts: string[] = [];
  const busy = [...o.busy];
  const u = new Updater({
    saasUrl: 'https://saas.test', pollMs: 5,
    busy: () => (busy.length > 1 ? busy.shift()! : busy[0] ?? 0),
    report: (s, m) => states.push([s, m]),
    restart: () => { restarts++; },
    fetchScript: async (url) => { if (o.fetchFails) throw new Error('GET failed 502'); assert.equal(url, 'https://saas.test/update.sh'); return '#!/bin/bash\n'; },
    runScript: async (s) => { scripts.push(s); return { code: o.code ?? 0, output: o.output ?? 'ok' }; },
  });
  return { u, states, scripts, restarts: () => restarts };
}

test('update: download → wait for busy sessions → restart; progress reported once per change', async () => {
  const h = harness({ busy: [2, 2, 1, 0] });
  await h.u.update();
  for (let i = 0; i < 100 && h.restarts() === 0; i++) await tick();
  assert.equal(h.restarts(), 1);
  assert.equal(h.scripts.length, 1);
  assert.deepEqual(h.states.map(([s, m]) => `${s}:${m}`), [
    'downloading:下载新版本、安装依赖…', 'waiting:新版本已就绪，等 2 个会话空闲后重启', 'waiting:新版本已就绪，等 1 个会话空闲后重启', 'restarting:正在重启']);
  await h.u.update(); // already restarting: no second run
  assert.equal(h.scripts.length, 1);
});

test('update failure (script exit / fetch error) reports the tail and allows a retry', async () => {
  const h = harness({ busy: [0], code: 1, output: 'a\nb\nnpm ERR! network\n' });
  await h.u.update();
  assert.equal(h.restarts(), 0);
  assert.deepEqual(h.states.at(-1), ['failed', 'a\nb\nnpm ERR! network']);
  const f = harness({ busy: [0], fetchFails: true });
  await f.u.update();
  assert.match(f.states.at(-1)![1]!, /502/);
  assert.equal(f.u.state, 'idle'); // can be retried
});

test('restartWhenIdle (SIGUSR2 from a manual update.sh) restarts immediately when idle; reannounce after reconnect', async () => {
  const h = harness({ busy: [1, 0] });
  h.u.restartWhenIdle();
  assert.deepEqual(h.states, [['waiting', '新版本已就绪，等 1 个会话空闲后重启']]);
  h.u.reannounce();
  assert.equal(h.states.length, 2);
  for (let i = 0; i < 100 && h.restarts() === 0; i++) await tick();
  assert.equal(h.restarts(), 1);
  h.u.dispose();
});

test('swapInNewCode: new tree in, old kept as .old, log carried over; incomplete .new is left alone', () => {
  const base = mkdtempSync(join(tmpdir(), 'upd-swap-'));
  const root = join(base, '.nopear-worker');
  const mk = (dir: string, tag: string) => {
    mkdirSync(join(dir, 'worker', 'src'), { recursive: true });
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    writeFileSync(join(dir, 'worker', '.env'), 'NOPEAR_SAAS_URL=x\n');
    writeFileSync(join(dir, 'worker', 'src', 'main.ts'), tag);
  };
  mk(root, 'old');
  writeFileSync(join(root, 'worker.log'), 'log');
  assert.equal(swapInNewCode(root, () => {}), false); // nothing to swap
  mkdirSync(`${root}.new`);
  assert.equal(swapInNewCode(root, () => {}), false); // incomplete
  assert.equal(readFileSync(join(root, 'worker', 'src', 'main.ts'), 'utf8'), 'old');
  mk(`${root}.new`, 'new');
  assert.equal(swapInNewCode(root, () => {}), true);
  assert.equal(readFileSync(join(root, 'worker', 'src', 'main.ts'), 'utf8'), 'new');
  assert.equal(readFileSync(join(`${root}.old`, 'worker', 'src', 'main.ts'), 'utf8'), 'old');
  assert.equal(readFileSync(join(root, 'worker.log'), 'utf8'), 'log');
  assert.equal(existsSync(`${root}.new`), false);
});
