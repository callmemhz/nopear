import { useStore } from 'zustand';
import { createNoPearEngine, SaasClient, type EngineState } from '@nopear/core';
import { platform } from './platform';

function uaSummary(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : /iPhone|iPad/.test(ua) ? 'iOS' : '';
  return [browser, os].filter(Boolean).join(' / ');
}

export const engine = createNoPearEngine({ platform, defaultSaasUrl: location.origin, clientLabel: 'web · ' + uaSummary() });
export const ready = engine.init();
// Persist a pending snapshot-cache update before the tab goes away / to the background.
addEventListener('pagehide', () => engine.flushCache());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') engine.flushCache();
  else engine.resume(); // back from a background tab / laptop sleep: reopen streams that silently stalled
});
// Network back / page restored from the back-forward cache: health-check every stream now.
addEventListener('online', () => engine.resume());
addEventListener('pageshow', () => engine.resume());

export function useEngine<T>(selector: (s: EngineState) => T): T {
  return useStore(engine.store, selector);
}

/** Plaintext control-plane client bound to the engine's current SaaS URL + token. */
export function saasClient(): SaasClient {
  const st = engine.store.getState();
  return new SaasClient({ baseUrl: st.saasUrl, platform, getToken: () => engine.store.getState().token });
}
