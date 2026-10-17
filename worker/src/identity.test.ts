import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicKeyOf } from '@nopear/core/crypto';
import { loadOrCreateIdentity, saveIdentity } from './identity';

test('identity: created with 600 perms, stable across loads, valid workerId', () => {
  const home = mkdtempSync(join(tmpdir(), 'nopear-id-'));
  const a = loadOrCreateIdentity(home);
  assert.match(a.workerId, /^w_[a-z2-7]{16}$/);
  assert.equal(a.pub, publicKeyOf(a.priv));
  assert.equal(a.platformPub, null);
  assert.ok(a.secret.length >= 32);
  assert.equal(statSync(join(home, 'identity.json')).mode & 0o777, 0o600);
  const b = loadOrCreateIdentity(home);
  assert.equal(b.workerId, a.workerId);
  assert.deepEqual([...b.priv], [...a.priv]);
  assert.equal(b.secret, a.secret);
  saveIdentity(home, { ...b, platformPub: 'PP' });
  assert.equal(loadOrCreateIdentity(home).platformPub, 'PP');
});

test('F4 identity: stores saasUrl; a different SaaS clears the pinned platformPub (re-register) and logs', () => {
  const home = mkdtempSync(join(tmpdir(), 'nopear-id-'));
  const logs: string[] = [];
  const a = loadOrCreateIdentity(home, 'https://a.example', (m) => logs.push(m));
  assert.equal(a.saasUrl, 'https://a.example');
  saveIdentity(home, { ...a, platformPub: 'PP' });
  // same SaaS → keep the pin
  const same = loadOrCreateIdentity(home, 'https://a.example', (m) => logs.push(m));
  assert.equal(same.platformPub, 'PP');
  assert.equal(logs.length, 0);
  // different SaaS → pin cleared, url updated + persisted, clear log line
  const b = loadOrCreateIdentity(home, 'https://b.example', (m) => logs.push(m));
  assert.equal(b.platformPub, null);
  assert.equal(b.saasUrl, 'https://b.example');
  assert.equal(b.workerId, a.workerId, 'keeps the worker identity');
  assert.ok(logs.some((l) => l.includes('https://b.example') && l.includes('re-register')), logs.join(' | '));
  assert.equal(loadOrCreateIdentity(home, 'https://b.example').platformPub, null);
  assert.equal(statSync(join(home, 'identity.json')).mode & 0o777, 0o600);
});

test('F1 identity: legacy file without saasUrl keeps the pin and records the configured SaaS', () => {
  const home = mkdtempSync(join(tmpdir(), 'nopear-id-'));
  const a = loadOrCreateIdentity(home);
  saveIdentity(home, { ...a, platformPub: 'PP', saasUrl: null });
  const logs: string[] = [];
  const b = loadOrCreateIdentity(home, 'https://a.example', (m) => logs.push(m));
  assert.equal(b.platformPub, 'PP', 'pin kept');
  assert.equal(b.saasUrl, 'https://a.example', 'saasUrl recorded');
  const persisted = loadOrCreateIdentity(home, 'https://a.example', (m) => logs.push(m));
  assert.equal(persisted.platformPub, 'PP');
  assert.equal(persisted.saasUrl, 'https://a.example', 'saasUrl persisted');
  assert.equal(logs.length, 0, 'no "dropping pin" log');
  // missing key entirely (older file format) behaves the same
  const raw = JSON.parse(readFileSync(join(home, 'identity.json'), 'utf8'));
  delete raw.saasUrl;
  writeFileSync(join(home, 'identity.json'), JSON.stringify(raw));
  const c = loadOrCreateIdentity(home, 'https://a.example', () => {});
  assert.equal(c.platformPub, 'PP');
  assert.equal(c.saasUrl, 'https://a.example');
});

test('F9 identity: NOPEAR_HOME created 0700; an existing looser home is tightened to 0700', () => {
  const parent = mkdtempSync(join(tmpdir(), 'nopear-id-'));
  const home = join(parent, 'fresh', 'home');
  loadOrCreateIdentity(home);
  assert.equal(statSync(home).mode & 0o777, 0o700);
  const loose = join(parent, 'loose');
  mkdirSync(loose, { mode: 0o755 });
  chmodSync(loose, 0o755);
  loadOrCreateIdentity(loose);
  assert.equal(statSync(loose).mode & 0o777, 0o700);
});

test('F1 identity: redeemedInstallCodeHash persists across saves/loads; legacy file → null', () => {
  const home = mkdtempSync(join(tmpdir(), 'nopear-id-'));
  const a = loadOrCreateIdentity(home, 'https://a.example');
  assert.equal(a.redeemedInstallCodeHash ?? null, null);
  saveIdentity(home, { ...a, platformPub: 'PP', redeemedInstallCodeHash: 'H1' });
  const b = loadOrCreateIdentity(home, 'https://a.example');
  assert.equal(b.redeemedInstallCodeHash, 'H1');
  assert.equal(JSON.parse(readFileSync(join(home, 'identity.json'), 'utf8')).redeemedInstallCodeHash, 'H1');
  // a SaaS switch rewrites the file but keeps the redeemed hash
  const c = loadOrCreateIdentity(home, 'https://b.example', () => {});
  assert.equal(c.redeemedInstallCodeHash, 'H1');
  assert.equal(loadOrCreateIdentity(home, 'https://b.example').redeemedInstallCodeHash, 'H1');
  // legacy file without the key
  const raw = JSON.parse(readFileSync(join(home, 'identity.json'), 'utf8'));
  delete raw.redeemedInstallCodeHash;
  writeFileSync(join(home, 'identity.json'), JSON.stringify(raw));
  assert.equal(loadOrCreateIdentity(home, 'https://b.example').redeemedInstallCodeHash, null);
});
