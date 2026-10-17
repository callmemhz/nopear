import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeEnvKey } from './envfile';

const tmp = () => mkdtempSync(join(tmpdir(), 'nopear-env-'));

test('removeEnvKey removes only that key line, keeps others, comments and trailing newline', () => {
  const dir = tmp();
  const p = join(dir, '.env');
  writeFileSync(p, '# worker env\nNOPEAR_SAAS_URL=http://x\nNOPEAR_INSTALL_CODE=abc\n  export NOPEAR_INSTALL_CODE=def\nNOPEAR_INSTALL_CODE_X=keep\n# NOPEAR_INSTALL_CODE=comment\nNOPEAR_LABEL=m\n');
  assert.equal(removeEnvKey(p, 'NOPEAR_INSTALL_CODE'), true);
  assert.equal(readFileSync(p, 'utf8'),
    '# worker env\nNOPEAR_SAAS_URL=http://x\nNOPEAR_INSTALL_CODE_X=keep\n# NOPEAR_INSTALL_CODE=comment\nNOPEAR_LABEL=m\n');
  assert.deepEqual(readdirSync(dir), ['.env'], 'no temp file left behind');
});

test('removeEnvKey: missing key → false and file untouched', () => {
  const p = join(tmp(), '.env');
  writeFileSync(p, 'A=1\nB=2');
  assert.equal(removeEnvKey(p, 'NOPEAR_INSTALL_CODE'), false);
  assert.equal(readFileSync(p, 'utf8'), 'A=1\nB=2');
});

test('removeEnvKey: missing file → false', () => {
  assert.equal(removeEnvKey(join(tmp(), 'nope.env'), 'NOPEAR_INSTALL_CODE'), false);
});
