import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_AUTO_COMPACT } from '@nopear/protocol';
import { PI_DEFAULT_RESERVE_TOKENS, compactionOverrides, compactionSettings, reserveTokensFor } from './compaction';

test('reserveTokens puts pi threshold exactly at thresholdTokens', () => {
  const ac = { enabled: true, thresholdTokens: 300_000, keepRecentTokens: 20_000 };
  assert.equal(reserveTokensFor(ac, 1_000_000), 700_000);
  assert.equal(reserveTokensFor(ac, 400_000), 100_000);
  // pi compacts once context > window - reserve, i.e. at the configured threshold
  assert.equal(1_000_000 - reserveTokensFor(ac, 1_000_000), 300_000);
});

test('degenerate windows fall back to pi default reserve', () => {
  const ac = { ...DEFAULT_AUTO_COMPACT };
  assert.equal(reserveTokensFor(ac, 300_000), PI_DEFAULT_RESERVE_TOKENS, 'threshold == window');
  assert.equal(reserveTokensFor(ac, 200_000), PI_DEFAULT_RESERVE_TOKENS, 'threshold > window');
  assert.equal(reserveTokensFor(ac, 0), PI_DEFAULT_RESERVE_TOKENS);
  assert.equal(reserveTokensFor(ac, Number.NaN), PI_DEFAULT_RESERVE_TOKENS);
  // a threshold just under a small window still keeps the default reserve
  assert.equal(reserveTokensFor({ ...ac, thresholdTokens: 20_000 }, 30_000), PI_DEFAULT_RESERVE_TOKENS);
});

test('compactionSettings carries enabled + keepRecent, and out-of-range input is clamped', () => {
  assert.deepEqual(compactionSettings(DEFAULT_AUTO_COMPACT, 1_000_000),
    { enabled: true, reserveTokens: 700_000, keepRecentTokens: 20_000 });
  assert.deepEqual(compactionSettings({ enabled: false, thresholdTokens: 1, keepRecentTokens: 10_000_000 }, 1_000_000),
    { enabled: false, reserveTokens: 980_000, keepRecentTokens: 200_000 }); // thresholdTokens clamped up to 20k
});

test('compactionOverrides nests under settings.compaction', () => {
  assert.deepEqual(compactionOverrides(DEFAULT_AUTO_COMPACT, 1_000_000),
    { compaction: { enabled: true, reserveTokens: 700_000, keepRecentTokens: 20_000 } });
});
