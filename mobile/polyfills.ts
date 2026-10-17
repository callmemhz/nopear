// Must be the first import of app/_layout.tsx: @nopear/core (crypto + SSE) touches these globals at module load.
import { getRandomValues } from 'expo-crypto';

type G = typeof globalThis & { crypto?: { getRandomValues?: unknown } };
const g = globalThis as G;

// 1) crypto.getRandomValues (noble + randomBytes) — Hermes has no WebCrypto.
if (!g.crypto) (g as { crypto: unknown }).crypto = {};
if (typeof g.crypto!.getRandomValues !== 'function') {
  (g.crypto as { getRandomValues: typeof getRandomValues }).getRandomValues = getRandomValues;
}

// 2) TextEncoder / TextDecoder (UTF-8 only, supports `fatal` and `{ stream: true }`) when the engine lacks them.
class Utf8Encoder {
  readonly encoding = 'utf-8';
  encode(input = ''): Uint8Array {
    const out: number[] = [];
    for (let i = 0; i < input.length; i++) {
      let c = input.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < input.length) {
        const d = input.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
      }
      if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd; // lone surrogate
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }
}

class Utf8Decoder {
  readonly encoding = 'utf-8';
  readonly fatal: boolean;
  private rest: number[] = [];
  constructor(label = 'utf-8', opts: { fatal?: boolean } = {}) {
    if (!/^utf-?8$/i.test(label)) throw new RangeError(`unsupported encoding ${label}`);
    this.fatal = !!opts.fatal;
  }
  decode(input?: ArrayBufferView | ArrayBuffer, opts: { stream?: boolean } = {}): string {
    const src = input === undefined ? new Uint8Array(0)
      : input instanceof ArrayBuffer ? new Uint8Array(input)
      : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    const bytes = this.rest.length ? Uint8Array.from([...this.rest, ...src]) : src;
    this.rest = [];
    let s = '';
    let i = 0;
    const bad = () => { if (this.fatal) throw new TypeError('invalid utf-8'); s += '\ufffd'; };
    while (i < bytes.length) {
      const b = bytes[i]!;
      const need = b < 0x80 ? 0 : b >= 0xf0 && b <= 0xf4 ? 3 : b >= 0xe0 ? 2 : b >= 0xc2 && b < 0xe0 ? 1 : -1;
      if (need < 0) { bad(); i++; continue; }
      if (need > 0 && i + need >= bytes.length) { // truncated sequence at the end of this chunk
        if (opts.stream) { this.rest = Array.from(bytes.subarray(i)); break; }
        bad(); break;
      }
      let cp = need === 0 ? b : need === 1 ? b & 31 : need === 2 ? b & 15 : b & 7;
      let ok = true;
      for (let k = 1; k <= need; k++) {
        const c = bytes[i + k]!;
        if ((c & 0xc0) !== 0x80) { ok = false; break; }
        cp = (cp << 6) | (c & 63);
      }
      if (!ok || (need === 2 && cp < 0x800) || (need === 3 && (cp < 0x10000 || cp > 0x10ffff)) || (cp >= 0xd800 && cp <= 0xdfff)) {
        bad(); i++; continue;
      }
      s += String.fromCodePoint(cp);
      i += need + 1;
    }
    return s;
  }
}

const anyG = globalThis as unknown as Record<string, unknown>;
if (typeof anyG.TextEncoder !== 'function') anyG.TextEncoder = Utf8Encoder;
if (typeof anyG.TextDecoder !== 'function') anyG.TextDecoder = Utf8Decoder;

export {};
