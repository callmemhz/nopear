import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureAgentDirCredentials } from './agent-dir';
import { ensurePrivateDir } from '../fsutil';

const SECRET = 'sk-SUPER-SECRET-VALUE';

test('F3: missing agentDir auth.json/models.json are symlinked to the configured pi files; contents never logged', () => {
  const root = mkdtempSync(join(tmpdir(), 'nopear-ad-'));
  const src = join(root, 'pi'); mkdirSync(src);
  const auth = join(src, 'auth.json'); writeFileSync(auth, `{"k":"${SECRET}"}`);
  const models = join(src, 'models.json'); writeFileSync(models, `{"m":"${SECRET}"}`);
  const agentDir = join(root, 'agent'); mkdirSync(agentDir);
  const logs: string[] = [];
  ensureAgentDirCredentials({ agentDir, piAuthPath: auth, piModelsPath: models }, (m) => logs.push(m));
  assert.ok(lstatSync(join(agentDir, 'auth.json')).isSymbolicLink());
  assert.equal(readlinkSync(join(agentDir, 'auth.json')), auth);
  assert.equal(readlinkSync(join(agentDir, 'models.json')), models);
  assert.equal(readFileSync(join(agentDir, 'auth.json'), 'utf8'), `{"k":"${SECRET}"}`);
  assert.equal(logs.length, 2, logs.join(' | '));
  assert.ok(logs.every((l) => !l.includes(SECRET)));
  // idempotent: second run does nothing and logs nothing
  ensureAgentDirCredentials({ agentDir, piAuthPath: auth, piModelsPath: models }, (m) => logs.push(m));
  assert.equal(logs.length, 2);
});

test('F3: an existing regular file is left alone; a missing source is skipped', () => {
  const root = mkdtempSync(join(tmpdir(), 'nopear-ad-'));
  const agentDir = join(root, 'agent'); mkdirSync(agentDir);
  writeFileSync(join(agentDir, 'auth.json'), '{"own":true}');
  const src = join(root, 'auth.json'); writeFileSync(src, '{}');
  const logs: string[] = [];
  ensureAgentDirCredentials({ agentDir, piAuthPath: src, piModelsPath: join(root, 'nope.json') }, (m) => logs.push(m));
  assert.ok(!lstatSync(join(agentDir, 'auth.json')).isSymbolicLink());
  assert.equal(readFileSync(join(agentDir, 'auth.json'), 'utf8'), '{"own":true}');
  assert.throws(() => lstatSync(join(agentDir, 'models.json')));
  assert.equal(logs.length, 0);
});

test('F9: ensurePrivateDir creates 0700 dirs and tightens existing ones', () => {
  const root = mkdtempSync(join(tmpdir(), 'nopear-ad-'));
  const d = join(root, 'a', 'b');
  ensurePrivateDir(d);
  assert.equal(statSync(d).mode & 0o777, 0o700);
  mkdirSync(join(root, 'loose'), { mode: 0o755 });
  ensurePrivateDir(join(root, 'loose'));
  assert.equal(statSync(join(root, 'loose')).mode & 0o777, 0o700);
});
