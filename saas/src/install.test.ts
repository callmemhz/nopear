import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import Fastify from 'fastify';
import { sha256Hex } from '@nopear/core/crypto';
import { openStore } from './store';
import { buildWorkerTarball, invalidInstallScript, readPiVersion, registerInstall, renderInstallScript, tarFlagsFor } from './install';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = mkdtempSync(join(tmpdir(), 'saas-install-test-'));

function bashSyntaxOk(script: string): void {
  const r = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

function walk(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    out.push(p);
    if (e.isDirectory()) out.push(...walk(dir, p));
  }
  return out;
}

function extract(tgz: Buffer | string): string {
  const dir = mkdtempSync(join(tmp, 'x-'));
  const file = typeof tgz === 'string' ? tgz : `${dir}.tgz`;
  if (typeof tgz !== 'string') writeFileSync(file, tgz);
  const r = spawnSync('tar', ['-xzf', file, '-C', dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return dir;
}

test('readPiVersion(repoRoot) = 0.84.4', () => {
  assert.equal(readPiVersion(repoRoot), '0.84.4');
});

test('renderInstallScript passes bash -n and contains every step', () => {
  const script = renderInstallScript({ saasUrl: 'https://nopear.example.com', code: 'CODE_abc123', piVersion: '0.84.4', label: null });
  bashSyntaxOk(script);
  for (const s of [
    'CODE_abc123',
    'https://nopear.example.com',
    '@earendil-works/pi-coding-agent@0.84.4',
    'npm install -w @nopear/worker --include-workspace-root',
    'nopear-worker.service',
    '/etc/wsl.conf',
    'NOPEAR_INSTALL_CODE=',
    'NOPEAR_SAAS_URL=',
    'uname -s',
    'nvm install 22',
    'sudo apt-get install -y git',
    '/install/worker.tgz',
    'nohup',
  ]) {
    assert.ok(script.includes(s), `script should contain ${s}`);
  }
  assert.ok(!script.includes('NOPEAR_LABEL='), 'no label → no NOPEAR_LABEL');
  assert.ok(!/^\s*npm ci\b/m.test(script), 'never runs npm ci');
  // macOS /bin/bash 3.2 reads the bytes of a following non-ASCII char into the variable name: always brace those.
  assert.deepEqual(script.match(/(?<!\\)\$[A-Za-z_][A-Za-z0-9_]*(?=[^\x00-\x7F])/g), null);

  const labeled = renderInstallScript({ saasUrl: 'https://nopear.example.com', code: 'CODE_abc123', piVersion: '0.84.4', label: "bob's box" });
  bashSyntaxOk(labeled);
  assert.ok(labeled.includes('NOPEAR_LABEL='));
});

test('renderInstallScript: macOS installs a launchd agent whose plist is valid', { skip: process.platform !== 'darwin' && 'needs plutil' }, () => {
  const script = renderInstallScript({ saasUrl: 'https://nopear.example.com', code: 'CODE_abc123', piVersion: '0.84.4', label: null });
  for (const s of ['Darwin|Linux', 'dev.nopear.worker', 'launchctl bootstrap', 'xcode-select -p', 'RunAtLoad', 'SuccessfulExit']) {
    assert.ok(script.includes(s), `script should contain ${s}`);
  }
  // Render just the plist heredoc with sample values (same shell expansion as the real install) and lint it.
  const heredoc = script.slice(script.indexOf('cat > "$PLIST" <<PLIST'), script.indexOf('\nPLIST\n') + '\nPLIST\n'.length)
    .replace('cat > "$PLIST" <<PLIST', 'cat <<PLIST');
  const dir = mkdtempSync(join(tmpdir(), 'plist-'));
  const sh = `LABEL=dev.nopear.worker; DEST="/Users/a b/.nopear-worker"; NPM=/opt/homebrew/bin/npm; NODE_BIN=/opt/homebrew/bin; NPM_GLOBAL_BIN=/opt/homebrew/bin\n${heredoc}`;
  const plist = execFileSync('bash', ['-c', sh], { encoding: 'utf8' });
  writeFileSync(join(dir, 'w.plist'), plist);
  execFileSync('plutil', ['-lint', join(dir, 'w.plist')]);
  const json = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', join(dir, 'w.plist')], { encoding: 'utf8' }));
  assert.equal(json.Label, 'dev.nopear.worker');
  assert.equal(json.WorkingDirectory, '/Users/a b/.nopear-worker');
  assert.equal(json.ProgramArguments[2], '"/opt/homebrew/bin/npm" start -w @nopear/worker; c=$?; [ $c -eq 78 ] && exit 0; exit $c');
  assert.deepEqual(json.KeepAlive, { SuccessfulExit: false });
});

test('invalidInstallScript passes bash -n, contains exit 1 and fails when run', () => {
  const script = invalidInstallScript("安装码无效 'x'");
  bashSyntaxOk(script);
  assert.ok(script.includes('exit 1'));
  const r = spawnSync('bash', [], { input: script, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes("安装码无效 'x'"));
});

test('buildWorkerTarball excludes node_modules and .env and rewrites workspaces', async () => {
  const fake = mkdtempSync(join(tmp, 'repo-'));
  const put = (p: string, s: string) => { mkdirSync(dirname(join(fake, p)), { recursive: true }); writeFileSync(join(fake, p), s); };
  put('package.json', JSON.stringify({ name: 'nopear', workspaces: ['packages/*', 'saas', 'worker', 'web', 'mobile'], devDependencies: { tsx: '^4' } }));
  put('package-lock.json', '{}');
  put('packages/protocol/src/index.ts', 'export {};');
  put('packages/protocol/node_modules/x/index.js', '');
  put('packages/core/src/index.ts', 'export {};');
  put('worker/src/main.ts', '');
  put('worker/.env', 'SECRET=1');
  put('worker/.env.example', 'NOPEAR_SAAS_URL=');
  put('worker/node_modules/y/index.js', '');
  put('node_modules/z/index.js', '');
  put('saas/src/main.ts', '');
  put('web/src/main.tsx', '');
  const out = join(tmp, 'fake.tgz');
  await buildWorkerTarball(fake, out);
  const dir = extract(out);
  const files = walk(dir);
  assert.ok(!files.some((f) => f.split('/').includes('node_modules')), files.join(','));
  assert.ok(!files.some((f) => f.split('/').pop() === '.env'), files.join(','));
  assert.ok(!files.some((f) => f.startsWith('saas') || f.startsWith('web')), files.join(','));
  assert.ok(files.includes('worker/.env.example'));
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.workspaces, ['packages/protocol', 'packages/core', 'worker']);
  assert.deepEqual(pkg.devDependencies, { tsx: '^4' });
  assert.ok(existsSync(join(fake, 'worker/.env')), 'source repo untouched');
});

function makeFakeRepo(): { fake: string; put: (p: string, s: string) => void } {
  const fake = mkdtempSync(join(tmp, 'repo-'));
  const put = (p: string, s: string) => { mkdirSync(dirname(join(fake, p)), { recursive: true }); writeFileSync(join(fake, p), s); };
  put('package.json', JSON.stringify({ name: 'nopear', workspaces: ['worker'] }));
  put('package-lock.json', '{}');
  put('packages/protocol/src/index.ts', 'export {};');
  put('packages/core/src/index.ts', 'export {};');
  put('worker/src/main.ts', '');
  put('worker/.env.example', 'NOPEAR_SAAS_URL=');
  return { fake, put };
}

const STRAYS = [
  'worker/.env', 'worker/.env.local', 'worker/.env.production', 'worker/x.pem', 'worker/id.key', 'worker/debug.log',
  'worker/.nopear/identity.json', 'worker/.saas/db.sqlite', 'worker/.DS_Store', 'packages/core/.env.local', 'packages/protocol/src/k.pem',
];

function assertNoStrays(files: string[]): void {
  for (const s of STRAYS) assert.ok(!files.includes(s), `${s} must not be published: ${files.join(',')}`);
  assert.ok(!files.some((f) => f.split('/').includes('.nopear') || f.split('/').includes('.saas')), files.join(','));
}

test('buildWorkerTarball (no git) deny-filters secrets and junk', async () => {
  const { fake, put } = makeFakeRepo();
  for (const s of STRAYS) put(s, 'SECRET');
  const out = join(tmp, 'deny.tgz');
  await buildWorkerTarball(fake, out);
  const files = walk(extract(out));
  assertNoStrays(files);
  for (const f of ['worker/.env.example', 'worker/src/main.ts', 'packages/core/src/index.ts', 'package-lock.json']) assert.ok(files.includes(f), f);
});

test('buildWorkerTarball (git) ships only tracked files, still deny-filtered', async () => {
  const { fake, put } = makeFakeRepo();
  put('worker/x.tracked.pem', 'tracked secret');
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-C', fake, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  git('init', '-q');
  git('add', '-A');
  for (const s of STRAYS) put(s, 'SECRET');
  put('worker/src/untracked.ts', '');
  const out = join(tmp, 'git.tgz');
  await buildWorkerTarball(fake, out);
  const dir = extract(out);
  const files = walk(dir);
  assertNoStrays(files);
  assert.ok(!files.includes('worker/src/untracked.ts'), 'untracked files are not published');
  assert.ok(!files.includes('worker/x.tracked.pem'), 'deny filter applies to tracked files too');
  for (const f of ['worker/.env.example', 'worker/src/main.ts', 'packages/core/src/index.ts', 'packages/protocol/src/index.ts', 'package-lock.json']) {
    assert.ok(files.includes(f), f);
  }
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).workspaces, ['packages/protocol', 'packages/core', 'worker']);
});

/** 尽力给源文件打一个扩展属性（macOS xattr / Linux setfattr）；工具不可用时跳过即可，断言照样成立。 */
function trySetXattr(file: string): void {
  if (process.platform === 'darwin') spawnSync('xattr', ['-w', 'com.example.nopeartest', '1', file]);
  else spawnSync('setfattr', ['-n', 'user.nopeartest', '-v', '1', file]);
}

test('buildWorkerTarball carries no xattr / mac metadata PAX headers', async () => {
  const { fake } = makeFakeRepo();
  trySetXattr(join(fake, 'worker/src/main.ts'));
  trySetXattr(join(fake, 'package-lock.json'));
  const out = join(tmp, 'xattr.tgz');
  await buildWorkerTarball(fake, out);
  const raw = gunzipSync(readFileSync(out)).toString('latin1');
  for (const k of ['LIBARCHIVE.xattr', 'SCHILY.xattr', 'com.apple', 'nopeartest']) assert.ok(!raw.includes(k), `tarball must not contain ${k}`);
  assert.ok(!/(^|\/)\._/m.test(walk(extract(out)).join('\n')), 'no AppleDouble ._ files');
});

test('tarFlagsFor picks flags from the actual tar implementation', () => {
  assert.deepEqual(tarFlagsFor('bsdtar 3.5.3 - libarchive 3.7.4 zlib/1.2.12 liblzma/5.4.3 bz2lib/1.0.8\n'), ['--no-xattrs', '--no-mac-metadata']);
  assert.deepEqual(tarFlagsFor('tar (GNU tar) 1.35\nCopyright (C) 2023 Free Software Foundation, Inc.\n'), ['--no-xattrs']);
  // busybox tar 不认 --version（探测失败 → 空串），或输出 BusyBox 横幅
  assert.deepEqual(tarFlagsFor('BusyBox v1.36.1 (2023-07-27) multi-call binary.'), []);
  assert.deepEqual(tarFlagsFor(''), []);
});

test('renderInstallScript extracts with GNU-tar-only flag behind a guard', () => {
  const script = renderInstallScript({ saasUrl: 'https://nopear.example.com', code: 'C', piVersion: '0.84.4', label: null });
  bashSyntaxOk(script);
  assert.ok(script.includes('tar --version 2>/dev/null | grep -q GNU'));
  assert.ok(script.includes('--warning=no-unknown-keyword'));
});

test('renderInstallScript hardening: main wrapper, npm prefix, linger, restart, quoting', () => {
  const script = renderInstallScript({ saasUrl: 'https://nopear.example.com', code: 'CODE_abc123', piVersion: '0.84.4', label: null });
  bashSyntaxOk(script);
  assert.match(script, /^main\(\) \{$/m, 'body wrapped in main()');
  assert.match(script.trimEnd(), /\nmain "\$@"$/, 'main "$@" is the last line');
  assert.ok(script.indexOf('sudo apt-get update') >= 0 && script.indexOf('sudo apt-get update') < script.indexOf('sudo apt-get install -y git'));
  assert.ok(script.includes('prefix -g'), 'checks npm global prefix');
  assert.ok(script.includes('config set prefix "$HOME/.npm-global"'));
  assert.ok(script.includes('.npm-global/bin'));
  assert.ok(script.includes('loginctl enable-linger'));
  assert.ok(script.includes('sudo loginctl enable-linger'));
  assert.ok(script.includes('systemctl --user restart nopear-worker'));
  assert.ok(!script.includes('network-online.target'));
  assert.ok(script.includes('ExecStart="$NPM" start -w @nopear/worker'));
  // A permanent register rejection makes the worker exit 78 (EX_CONFIG) → systemd must not restart-loop it.
  assert.match(script, /^Restart=always\nRestartSec=5\nRestartPreventExitStatus=78$/m);
  assert.match(script, /^Environment="PATH=\$NODE_BIN:\$NPM_GLOBAL_BIN:/m);
});

test('renderInstallScript: linger failure never aborts (simulated loginctl/sudo failing)', () => {
  const script = renderInstallScript({ saasUrl: 'https://nopear.example.com', code: 'C', piVersion: '0.84.4', label: null });
  const start = script.indexOf('enable_linger() {');
  assert.ok(start >= 0, 'enable_linger helper exists');
  const end = script.indexOf('\n}\n', start);
  const fn = script.slice(start, end + 3);
  const harness = `set -eo pipefail\nsay() { echo "$*"; }\nloginctl() { return 1; }\nsudo() { return 1; }\n${fn}\nenable_linger\necho AFTER\n`;
  const r = spawnSync('bash', [], { input: harness, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('AFTER'));
  assert.ok(r.stdout.includes('enable-linger'), 'prints a hint');
});

test('GET /install.sh and /install/worker.tgz', async (t) => {
  const store = await openStore('sqlite::memory:');
  const app = Fastify();
  registerInstall(app, { store, repoRoot, publicUrl: null, workerTgz: null });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  t.after(async () => { await app.close(); await store.close(); });

  const user = await store.users.upsertDev('a@example.com');
  const now = Date.now();
  await store.installCodes.create(user.id, sha256Hex('good-code'), 'box', now + 60_000);
  await store.installCodes.create(user.id, sha256Hex('expired-code'), null, now - 1);
  await store.installCodes.create(user.id, sha256Hex('used-code'), null, now + 60_000);
  await store.installCodes.consume(sha256Hex('used-code'), 'w_other', now);

  await t.test('valid code → script with code, origin and pi version; not consumed', async () => {
    const r = await fetch(`${base}/install.sh?code=good-code`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /^text\/x-shellscript/);
    const s = await r.text();
    bashSyntaxOk(s);
    assert.ok(s.includes('good-code'));
    assert.ok(s.includes(base));
    assert.ok(s.includes('@earendil-works/pi-coding-agent@0.84.4'));
    assert.ok(s.includes('NOPEAR_LABEL='));
    assert.equal((await store.installCodes.get(sha256Hex('good-code')))?.usedBy, null);
  });

  await t.test('unknown / expired / used / missing code → invalid script', async () => {
    for (const q of ['?code=nope', '?code=expired-code', '?code=used-code', '']) {
      const r = await fetch(`${base}/install.sh${q}`);
      assert.equal(r.status, 200, q);
      assert.match(r.headers.get('content-type') ?? '', /^text\/x-shellscript/);
      const s = await r.text();
      bashSyntaxOk(s);
      assert.ok(s.includes('exit 1'), q);
      assert.ok(!s.includes('NOPEAR_INSTALL_CODE='), q);
    }
  });

  await t.test('worker.tgz → gzip with the worker workspace subset', async () => {
    const r = await fetch(`${base}/install/worker.tgz`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/gzip');
    const buf = Buffer.from(await r.arrayBuffer());
    assert.equal(buf[0], 0x1f);
    assert.equal(buf[1], 0x8b);
    const dir = extract(buf);
    const files = walk(dir);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    assert.deepEqual(pkg.workspaces, ['packages/protocol', 'packages/core', 'worker']);
    for (const f of ['package-lock.json', 'worker/src/main.ts', 'packages/core/src/index.ts', 'packages/protocol/src/index.ts']) {
      assert.ok(files.includes(f), f);
    }
    assert.ok(!files.some((f) => f.split('/').includes('node_modules')));
    assert.ok(!files.some((f) => f.split('/').pop() === '.env'));
  });

  await t.test('publicUrl overrides request origin', async () => {
    const app2 = Fastify();
    registerInstall(app2, { store, repoRoot, publicUrl: 'https://nopear.example.com', workerTgz: null });
    await app2.ready();
    const r = await app2.inject({ method: 'GET', url: '/install.sh?code=good-code' });
    await app2.close();
    assert.ok(r.body.includes("'https://nopear.example.com'"));
    assert.ok(!r.body.includes('127.0.0.1'));
  });

  await t.test('no publicUrl → honours X-Forwarded-Proto / X-Forwarded-Host', async () => {
    const app3 = Fastify();
    registerInstall(app3, { store, repoRoot, publicUrl: null, workerTgz: null });
    await app3.ready();
    const r = await app3.inject({
      method: 'GET',
      url: '/install.sh?code=good-code',
      headers: { host: 'internal:8790', 'x-forwarded-proto': 'https, http', 'x-forwarded-host': 'nopear.proxy.example, other' },
    });
    await app3.close();
    assert.ok(r.body.includes("SAAS_URL='https://nopear.proxy.example'"), r.body.slice(0, 400));
    assert.ok(!r.body.includes('internal:8790'));
  });
});

test('SAAS_WORKER_TGZ: existing file is served as-is (not deleted on close); missing file → 500', async (t) => {
  const store = await openStore('sqlite::memory:');
  t.after(async () => { await store.close(); });
  const pre = join(mkdtempSync(join(tmp, 'pre-')), 'worker.tgz');
  const bytes = Buffer.from([0x1f, 0x8b, 1, 2, 3, 4, 5]);
  writeFileSync(pre, bytes);

  await t.test('existing → exact bytes', async () => {
    const app = Fastify();
    registerInstall(app, { store, repoRoot, publicUrl: null, workerTgz: pre });
    await app.ready();
    const r = await app.inject({ method: 'GET', url: '/install/worker.tgz' });
    await app.close();
    assert.equal(r.statusCode, 200);
    assert.equal(r.headers['content-type'], 'application/gzip');
    assert.deepEqual(r.rawPayload, bytes);
    assert.ok(existsSync(pre), 'prebuilt package is not removed on close');
  });

  await t.test('missing → 500 internal, logs an error, install.sh still works', async () => {
    const errors: unknown[][] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { errors.push(a); };
    const missing = join(tmp, 'does-not-exist.tgz');
    const app = Fastify();
    try {
      registerInstall(app, { store, repoRoot, publicUrl: null, workerTgz: missing });
    } finally {
      console.error = orig;
    }
    await app.ready();
    const r = await app.inject({ method: 'GET', url: '/install/worker.tgz' });
    const sh = await app.inject({ method: 'GET', url: '/install.sh?code=nope' });
    await app.close();
    assert.equal(r.statusCode, 500);
    assert.equal(JSON.parse(r.body).error.code, 'internal');
    assert.equal(sh.statusCode, 200);
    assert.ok(errors.some((a) => String(a[0]).includes(`SAAS_WORKER_TGZ not found: ${missing}`)));
  });
});
