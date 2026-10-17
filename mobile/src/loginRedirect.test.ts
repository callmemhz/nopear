import { describe, expect, it } from 'vitest';
import { loginErrorFromRedirect, NOT_ALLOWED_MESSAGE } from './loginRedirect';

describe('loginErrorFromRedirect', () => {
  it('recognizes #error=not_allowed (and ?error=)', () => {
    expect(loginErrorFromRedirect('nopear://auth#error=not_allowed')).toBe('not_allowed');
    expect(loginErrorFromRedirect('nopear://auth?error=not_allowed')).toBe('not_allowed');
    expect(loginErrorFromRedirect('nopear://auth?x=1#error=not%5Fallowed')).toBe('not_allowed');
  });
  it('null when there is no error (token redirect)', () => {
    expect(loginErrorFromRedirect('nopear://auth#token=abc')).toBeNull();
    expect(loginErrorFromRedirect('nopear://auth')).toBeNull();
    expect(loginErrorFromRedirect('nopear://auth#terror=x')).toBeNull();
  });
  it('has the shared message', () => {
    expect(NOT_ALLOWED_MESSAGE).toBe('该账号不在白名单，请联系管理员');
  });
});
