import { beforeEach, describe, expect, it } from 'vitest';
import { checkLoginNonce, issueLoginNonce } from './loginNonce';

describe('login nonce (OAuth CSRF guard)', () => {
  beforeEach(() => sessionStorage.clear());

  it('accepts the issued nonce exactly once', () => {
    const n = issueLoginNonce();
    expect(n).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(checkLoginNonce(n)).toBe(true);
    expect(checkLoginNonce(n)).toBe(false); // consumed
  });

  it('rejects a missing or mismatched nonce and consumes the stored one', () => {
    const n = issueLoginNonce();
    expect(checkLoginNonce(null)).toBe(false);
    expect(checkLoginNonce(n)).toBe(false); // the failed attempt deleted it
    issueLoginNonce();
    expect(checkLoginNonce('attacker')).toBe(false);
  });

  it('rejects when nothing was issued in this tab', () => {
    expect(checkLoginNonce('anything')).toBe(false);
    expect(checkLoginNonce('')).toBe(false);
  });
});
