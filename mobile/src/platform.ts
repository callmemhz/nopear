// Platform adapters for @nopear/core on React Native.
import { fetch as expoFetch } from 'expo/fetch';
import { Directory, File, Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import type { KV, Platform } from '@nopear/core';

/** Plain (non-secret) KV persisted as one JSON file in the app document directory. */
function fileKV(name: string): KV {
  const file = new File(Paths.document, name);
  let cache: Record<string, string> | null = null;
  let chain: Promise<void> = Promise.resolve();
  const load = (): Record<string, string> => {
    if (cache) return cache;
    try {
      cache = file.exists ? (JSON.parse(file.textSync()) as Record<string, string>) : {};
    } catch {
      cache = {};
    }
    return cache;
  };
  const persist = () => {
    const snapshot = JSON.stringify(load());
    chain = chain.then(() => {
      if (!file.exists) file.create({ intermediates: true });
      file.write(snapshot);
    }).catch(() => { /* best effort */ });
    return chain;
  };
  return {
    async get(k) { return load()[k] ?? null; },
    async set(k, v) { load()[k] = v; await persist(); },
    async remove(k) { delete load()[k]; await persist(); },
  };
}

/** 32-bit FNV-1a (hex) — disambiguates truncated file names. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
/** One file per key (large values: the timeline cache) under the app cache directory. */
function dirKV(name: string): KV {
  const dir = new Directory(Paths.cache, name);
  const fileOf = (k: string) => {
    const enc = encodeURIComponent(k);
    return new File(dir, enc.length <= 160 ? enc : `${enc.slice(0, 120)}~${fnv1a(k)}${fnv1a(`${k}#`)}`);
  };
  return {
    async get(k) {
      try { const f = fileOf(k); return f.exists ? await f.text() : null; } catch { return null; }
    },
    async set(k, v) {
      if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
      const f = fileOf(k);
      if (!f.exists) f.create();
      f.write(v);
    },
    async remove(k) {
      const f = fileOf(k);
      if (f.exists) f.delete();
    },
  };
}

/** expo-secure-store only allows keys matching [A-Za-z0-9._-]. */
export const secureKey = (k: string) => k.replace(/[^A-Za-z0-9._-]/g, '_');

const secureKV: KV = {
  get: (k) => SecureStore.getItemAsync(secureKey(k)),
  set: (k, v) => SecureStore.setItemAsync(secureKey(k), v, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK }),
  remove: (k) => SecureStore.deleteItemAsync(secureKey(k)),
};

export const platform: Platform = {
  // expo/fetch streams response bodies (needed for SSE); the core only uses the WHATWG subset.
  fetch: expoFetch as unknown as typeof fetch,
  storage: fileKV('nopear-kv.json'),
  secureStorage: secureKV,
  bigStorage: dirKV('nopear-big'),
};
