import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isValidEmail, loginAllowed, normalizeEmail } from './allowlist';
import { openStore } from './store';

test('normalizeEmail trims and lowercases (no gmail dot/alias folding)', () => {
  assert.equal(normalizeEmail('  Foo.Bar@Gmail.COM \n'), 'foo.bar@gmail.com');
  assert.equal(normalizeEmail('a+b@x.com'), 'a+b@x.com');
});

test('isValidEmail', () => {
  assert.equal(isValidEmail('a@b'), true);
  assert.equal(isValidEmail('  A@B.com  '), true);
  for (const bad of ['', 'nope', '@x', 'a@', 'a b@x', 'a@b@c', 'a@ b']) assert.equal(isValidEmail(bad), false, bad);
});

test('loginAllowed: open mode admits everyone; enabled admits only listed (normalized) emails', async () => {
  const store = await openStore(`sqlite:${join(mkdtempSync(join(tmpdir(), 'saas-allow-')), 'saas.db')}`);
  assert.equal(await loginAllowed(store, 'anyone@x.com'), true);
  await store.allowlist.bootstrap('admin@x.com');
  assert.equal(await loginAllowed(store, 'anyone@x.com'), false);
  assert.equal(await loginAllowed(store, 'admin@x.com'), true);
  assert.equal(await loginAllowed(store, '  ADMIN@x.com '), true);
  await store.close();
});
