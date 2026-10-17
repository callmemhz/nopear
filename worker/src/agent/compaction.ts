// Account-level context auto-compaction: map the account's AutoCompactSettings onto pi's
// `compaction` settings. The threshold is an absolute token count because what overflows is a token count —
// deriving it from a window ratio would inherit the provider's window figure, which is exactly what fails.
import type { CompactionSettings } from '@earendil-works/pi-coding-agent';
import { DEFAULT_AUTO_COMPACT, normalizeAutoCompact, type AutoCompactSettings } from '@nopear/protocol';

/** pi's own default reserve; used when the threshold leaves no room to summarize. */
export const PI_DEFAULT_RESERVE_TOKENS = 16_384;

/**
 * `reserveTokens = contextWindow − thresholdTokens`: pi compacts once `context > window − reserve`, so a reserve
 * of `window − threshold` starts compaction exactly at `threshold` tokens. A threshold at or above the window
 * would make the reserve non-positive (compaction on every turn), so it falls back to pi's default reserve.
 */
export function reserveTokensFor(autoCompact: AutoCompactSettings, contextWindow: number): number {
  const a = normalizeAutoCompact(autoCompact);
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return PI_DEFAULT_RESERVE_TOKENS;
  const reserve = contextWindow - a.thresholdTokens;
  if (reserve <= 0) return PI_DEFAULT_RESERVE_TOKENS;
  // Never below the default reserve: a threshold just under the window must not squeeze out the reply.
  return Math.max(PI_DEFAULT_RESERVE_TOKENS, Math.round(reserve));
}

/** pi compaction settings for one conversation window. */
export function compactionSettings(autoCompact: AutoCompactSettings, contextWindow: number): CompactionSettings {
  const a = normalizeAutoCompact(autoCompact);
  return { enabled: a.enabled, reserveTokens: reserveTokensFor(a, contextWindow), keepRecentTokens: a.keepRecentTokens };
}

/** The `Settings` override handed to a session's `SettingsManager` (never persisted to disk). */
export function compactionOverrides(autoCompact: AutoCompactSettings, contextWindow: number): { compaction: CompactionSettings } {
  return { compaction: compactionSettings(autoCompact, contextWindow) };
}
