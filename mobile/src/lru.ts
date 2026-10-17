// Tiny bounded LRU map (pure; no RN imports so it is unit-testable).
export class Lru<V> {
  #m = new Map<string, V>();
  constructor(readonly max: number) {}
  get(k: string): V | undefined {
    const v = this.#m.get(k);
    if (v !== undefined) { this.#m.delete(k); this.#m.set(k, v); }
    return v;
  }
  set(k: string, v: V): void {
    this.#m.delete(k);
    this.#m.set(k, v);
    while (this.#m.size > this.max) this.#m.delete(this.#m.keys().next().value as string);
  }
  get size(): number { return this.#m.size; }
}
