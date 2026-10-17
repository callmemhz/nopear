// App-wide NoPearEngine singleton + React bindings.
import Constants from 'expo-constants';
import { AppState, Platform as RNPlatform } from 'react-native';
import { useStore } from 'zustand';
import { createNoPearEngine, SaasClient, type EngineState } from '@nopear/core';
import { platform } from './platform';

const extra = (Constants.expoConfig?.extra ?? {}) as { saasUrl?: string };
export const DEFAULT_SAAS_URL = extra.saasUrl ?? 'http://localhost:8790';

export const engine = createNoPearEngine({
  platform,
  defaultSaasUrl: DEFAULT_SAAS_URL,
  clientLabel: `${RNPlatform.OS === 'ios' ? 'iPhone' : RNPlatform.OS} · NoPear`,
});

// Leaving the foreground: persist a pending snapshot-cache update. Back to the foreground: iOS/Android may have
// silently frozen the SSE streams meanwhile — health-check them now (stalled ones reopen, backoffs are cut short).
AppState.addEventListener('change', (s) => { if (s === 'active') engine.resume(); else engine.flushCache(); });

let initPromise: Promise<void> | null = null;
/** Idempotent: restores saasUrl/token/client key and starts streams when logged in. */
export function initEngine(): Promise<void> {
  initPromise ??= engine.init().catch(() => {});
  return initPromise;
}

/** Subscribe to a slice of engine state. Select stable references; derive arrays with useMemo. */
export function useEngine<T>(selector: (s: EngineState) => T): T {
  return useStore(engine.store, selector);
}

/** A SaaS control-plane client bound to the current SaaS URL + token (for calls the engine does not wrap). */
export function saasClient(): SaasClient {
  const s = engine.store.getState();
  return new SaasClient({ baseUrl: s.saasUrl, platform, getToken: () => engine.store.getState().token });
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
