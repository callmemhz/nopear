// Platform adapters injected by web / mobile hosts. core never touches globals for I/O.
export interface KV {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}
export interface Platform {
  fetch: typeof fetch;
  storage: KV;
  secureStorage: KV;
  /** Optional store for large values (per-session timeline cache): IndexedDB on web, files on mobile.
   *  Absent → no timeline cache (sessions always open with a fresh snapshot). */
  bigStorage?: KV;
  now?: () => number;
}
/** In-memory KV (tests / ephemeral hosts). */
export function memoryKV(init: Record<string, string> = {}): KV & { data: Map<string, string> } {
  const data = new Map(Object.entries(init));
  return {
    data,
    async get(k) { return data.get(k) ?? null; },
    async set(k, v) { data.set(k, v); },
    async remove(k) { data.delete(k); },
  };
}
