import { describe, expect, it } from 'vitest';
import { parseClaimLink } from './claimLink';

describe('parseClaimLink (web)', () => {
  it('parses valid links and reports the SaaS origin', () => {
    expect(parseClaimLink('https://nopear.example.com/claim?w=w_abc&t=tok')).toEqual({ workerId: 'w_abc', claimToken: 'tok', saasUrl: 'https://nopear.example.com' });
    expect(parseClaimLink('  http://localhost:8790/claim/?t=x&w=w_1 \n')).toEqual({ workerId: 'w_1', claimToken: 'x', saasUrl: 'http://localhost:8790' });
  });
  it('rejects bad links', () => {
    for (const l of ['https://a.com/claim?w=w_1', 'https://a.com/claim?t=x', 'https://a.com/claim?w=&t=x', 'https://a.com/claim?w=w_1&t=',
      'ftp://a.com/claim?w=a&t=b', 'https://a.com/other?w=a&t=b', 'javascript:alert(1)//claim?w=a&t=b', 'not a url']) {
      expect(parseClaimLink(l)).toBeNull();
    }
  });
});
