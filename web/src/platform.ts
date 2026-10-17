import type { KV, Platform } from '@nopear/core';

function localKV(prefix: string): KV {
  return {
    async get(k) { return localStorage.getItem(prefix + k); },
    async set(k, v) { localStorage.setItem(prefix + k, v); },
    async remove(k) { localStorage.removeItem(prefix + k); },
  };
}

/** Large-value KV in IndexedDB (database `nopear`, object store `kv`, string values) — the timeline cache. */
function idbKV(): KV | undefined {
  if (typeof indexedDB === 'undefined') return undefined;
  let db: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('nopear', 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('kv')) req.result.createObjectStore('kv'); };
      req.onsuccess = () => {
        const d = req.result;
        d.onversionchange = () => { d.close(); db = null; };
        d.onclose = () => { db = null; };
        resolve(d);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('indexedDB open blocked'));
    }).catch((e: unknown) => { db = null; throw e; });
    return db;
  };
  const run = async <T,>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const d = await open();
    return new Promise<T>((resolve, reject) => {
      const tx = d.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error ?? req.error);
      tx.onabort = () => reject(tx.error ?? new Error('indexedDB transaction aborted'));
    });
  };
  return {
    async get(k) { const v = await run('readonly', (s) => s.get(k)); return typeof v === 'string' ? v : null; },
    async set(k, v) { await run('readwrite', (s) => s.put(v, k)); },
    async remove(k) { await run('readwrite', (s) => s.delete(k)); },
  };
}

const bigStorage = idbKV();
export const platform: Platform = {
  fetch: window.fetch.bind(window),
  storage: localKV(''),
  secureStorage: localKV('nopear.secure.'),
  ...(bigStorage ? { bigStorage } : {}),
};
