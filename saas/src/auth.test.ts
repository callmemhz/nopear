import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashToken, isAllowedRedirect, safeEq, signState, verifyState } from './auth';

test('hashToken is sha256 hex', () => {
  assert.match(hashToken('abc'), /^[0-9a-f]{64}$/);
  assert.equal(hashToken('abc'), hashToken('abc'));
});

test('state round-trips and rejects tamper / expiry / wrong secret', () => {
  const st = signState('sec', { redirect: 'https://app/x', exp: 2000 });
  assert.deepEqual(verifyState('sec', st, 1000), { redirect: 'https://app/x' });
  assert.equal(verifyState('sec', st, 3000), null);
  assert.equal(verifyState('other', st, 1000), null);
  const [body, mac] = st.split('.');
  assert.equal(verifyState('sec', `${body}x.${mac}`, 1000), null);
  assert.equal(verifyState('sec', 'garbage', 1000), null);
});

test('redirect allowlist', () => {
  const pub = 'https://nopear.example.com';
  const allow = ['nopear://'];
  assert.equal(isAllowedRedirect('https://nopear.example.com/auth/callback', pub, allow), true);
  assert.equal(isAllowedRedirect('nopear://auth', pub, allow), true);
  assert.equal(isAllowedRedirect('https://evil.com/cb', pub, allow), false);
  assert.equal(isAllowedRedirect('https://nopear.example.com.evil.com/', pub, allow), false);
  assert.equal(isAllowedRedirect('not a url', pub, allow), false);
});

test('redirect allowlist: http(s) entries match origin exactly, not by raw prefix', () => {
  const pub = 'https://nopear.example.com';
  const allow = ['https://app.example.com', 'https://app2.example.com/cb', 'nopear://'];
  assert.equal(isAllowedRedirect('https://app.example.com/auth/callback', pub, allow), true);
  assert.equal(isAllowedRedirect('https://app.example.com.evil.com/x', pub, allow), false);
  assert.equal(isAllowedRedirect('https://app.example.com@evil.com/x', pub, allow), false);
  assert.equal(isAllowedRedirect('http://app.example.com/x', pub, allow), false);
  assert.equal(isAllowedRedirect('https://app2.example.com/cb/done', pub, allow), true);
  assert.equal(isAllowedRedirect('https://app2.example.com/other', pub, allow), false);
  assert.equal(isAllowedRedirect('nopear://auth', pub, allow), true);
  assert.equal(isAllowedRedirect('nopearx://auth', pub, allow), false);
});

test('safeEq is constant-time equality', () => {
  assert.equal(safeEq('abc', 'abc'), true);
  assert.equal(safeEq('abc', 'abd'), false);
  assert.equal(safeEq('abc', 'abcd'), false);
});
