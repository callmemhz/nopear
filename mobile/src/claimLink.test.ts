import { describe, expect, it } from 'vitest';
import { parseClaimLink } from './claimLink';

describe('parseClaimLink', () => {
  it('parses a valid claim link', () => {
    expect(parseClaimLink('https://nopear.example.com/claim?w=w_abcdefghijklmnop&t=tok123')).toEqual({
      workerId: 'w_abcdefghijklmnop', claimToken: 'tok123', saasUrl: 'https://nopear.example.com',
    });
  });
  it('accepts http and surrounding whitespace, with a base path', () => {
    expect(parseClaimLink('  http://localhost:8790/claim?t=x&w=w_1 \n')).toEqual({
      workerId: 'w_1', claimToken: 'x', saasUrl: 'http://localhost:8790',
    });
  });
  it('rejects missing or empty params', () => {
    expect(parseClaimLink('https://a.com/claim?w=w_1')).toBeNull();
    expect(parseClaimLink('https://a.com/claim?t=x')).toBeNull();
    expect(parseClaimLink('https://a.com/claim?w=&t=x')).toBeNull();
    expect(parseClaimLink('https://a.com/claim?w=w_1&t=')).toBeNull();
  });
  it('rejects non-http(s) and non-claim paths and garbage', () => {
    expect(parseClaimLink('nopear://claim?w=w_1&t=x')).toBeNull();
    expect(parseClaimLink('ftp://a.com/claim?w=w_1&t=x')).toBeNull();
    expect(parseClaimLink('https://a.com/other?w=w_1&t=x')).toBeNull();
    expect(parseClaimLink('not a url')).toBeNull();
    expect(parseClaimLink('')).toBeNull();
  });
});
