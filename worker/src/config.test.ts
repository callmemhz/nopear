import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadConfig } from './config';

const base = { NOPEAR_SAAS_URL: 'http://saas.test', NOPEAR_HOME: '/tmp/nopear-config-test' };

test('NOPEAR_E2E defaults auto', () => {
  assert.equal(loadConfig(base).e2e, 'auto');
  assert.equal(loadConfig({ ...base, NOPEAR_E2E: '' }).e2e, 'auto');
});

test('NOPEAR_E2E=required', () => {
  assert.equal(loadConfig({ ...base, NOPEAR_E2E: 'required' }).e2e, 'required');
  assert.equal(loadConfig({ ...base, NOPEAR_E2E: 'auto' }).e2e, 'auto');
});

test('NOPEAR_E2E=bogus throws', () => {
  assert.throws(() => loadConfig({ ...base, NOPEAR_E2E: 'bogus' }), /^Error: invalid NOPEAR_E2E: bogus$/);
});

test('NOPEAR_CARD_WIP default 1 and parses 3', () => {
  assert.equal(loadConfig(base).cardWip, 1);
  assert.equal(loadConfig({ ...base, NOPEAR_CARD_WIP: '3' }).cardWip, 3);
});

test('NOPEAR_CARD_WIP=0 throws', () => {
  assert.throws(() => loadConfig({ ...base, NOPEAR_CARD_WIP: '0' }), /^Error: invalid NOPEAR_CARD_WIP: 0$/);
  assert.throws(() => loadConfig({ ...base, NOPEAR_CARD_WIP: '1.5' }), /invalid NOPEAR_CARD_WIP: 1\.5/);
  assert.throws(() => loadConfig({ ...base, NOPEAR_CARD_WIP: 'x' }), /invalid NOPEAR_CARD_WIP: x/);
});

test('NOPEAR_INSTALL_CODE → installCode', () => {
  assert.equal(loadConfig(base).installCode, null);
  assert.equal(loadConfig({ ...base, NOPEAR_INSTALL_CODE: '  ic_abc  ' }).installCode, 'ic_abc');
  assert.equal(loadConfig({ ...base, NOPEAR_INSTALL_CODE: '   ' }).installCode, null);
});

test("envFile = resolve(cwd, '.env')", () => {
  assert.equal(loadConfig(base).envFile, resolve(process.cwd(), '.env'));
});

test('worker version is 3.2.0 and matches package.json', async () => {
  assert.equal(loadConfig(base).version, '3.2.0');
  const pkg = JSON.parse((await import('node:fs')).readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  assert.equal(pkg.version, '3.2.0');
});
