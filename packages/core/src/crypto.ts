// E2E crypto primitives shared by web, mobile, worker and saas.
// X25519 ECDH → HKDF-SHA256 → AES-256-GCM (nonce(12)‖ct‖tag(16)); Ed25519 authz signatures.
// Pure JS (@noble/*); randomness via @noble/hashes randomBytes → globalThis.crypto.getRandomValues (RN: expo-crypto polyfill).
import { gcm } from '@noble/ciphers/aes.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, randomBytes as nobleRandomBytes } from '@noble/hashes/utils.js';
import { authzMessage, HKDF_SALT } from '@nopear/protocol';

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

export const utf8 = {
  encode: (s: string): Uint8Array => enc.encode(s),
  decode: (b: Uint8Array): string => dec.decode(b),
};

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_CODES = Uint8Array.from(B64, (c) => c.charCodeAt(0));
/** charCode (< 128) → 6-bit value; 255 = invalid. */
const B64_DECODE = new Uint8Array(128).fill(255);
for (let i = 0; i < 64; i++) B64_DECODE[B64_CODES[i]!] = i;
/** Input bytes per output chunk: multiple of 3 so chunks concatenate without padding; → 32K chars. */
const ENC_CHUNK = 24 * 1024;

function b64Val(s: string, i: number): number {
  const c = s.charCodeAt(i);
  const v = c < 128 ? B64_DECODE[c]! : 255;
  if (v === 255) throw new Error('invalid base64url character');
  return v;
}

function fallbackEncode(bytes: Uint8Array): string {
  const parts: string[] = [];
  const codes = new Uint8Array(Math.ceil(Math.min(bytes.length, ENC_CHUNK) / 3) * 4);
  for (let start = 0; start < bytes.length; start += ENC_CHUNK) {
    const end = Math.min(start + ENC_CHUNK, bytes.length);
    let o = 0;
    let i = start;
    for (; i + 2 < end; i += 3) {
      const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
      codes[o++] = B64_CODES[n >> 18]!;
      codes[o++] = B64_CODES[(n >> 12) & 63]!;
      codes[o++] = B64_CODES[(n >> 6) & 63]!;
      codes[o++] = B64_CODES[n & 63]!;
    }
    const rest = end - i;
    if (rest === 1) {
      const n = bytes[i]! << 16;
      codes[o++] = B64_CODES[n >> 18]!;
      codes[o++] = B64_CODES[(n >> 12) & 63]!;
    } else if (rest === 2) {
      const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
      codes[o++] = B64_CODES[n >> 18]!;
      codes[o++] = B64_CODES[(n >> 12) & 63]!;
      codes[o++] = B64_CODES[(n >> 6) & 63]!;
    }
    // codes are pure ASCII, so the (fatal) UTF-8 decoder is an exact and fast bytes → string conversion.
    parts.push(dec.decode(codes.subarray(0, o)));
  }
  return parts.join('');
}

function fallbackDecode(s: string): Uint8Array {
  const len = s.length;
  const rem = len & 3;
  if (rem === 1) throw new Error('invalid base64url length');
  const out = new Uint8Array((len >> 2) * 3 + (rem ? rem - 1 : 0));
  const full = len - rem;
  let o = 0;
  let i = 0;
  for (; i < full; i += 4) {
    const n = (b64Val(s, i) << 18) | (b64Val(s, i + 1) << 12) | (b64Val(s, i + 2) << 6) | b64Val(s, i + 3);
    out[o++] = n >> 16;
    out[o++] = n >> 8;
    out[o++] = n;
  }
  if (rem === 2) {
    const a = b64Val(s, i);
    const b = b64Val(s, i + 1);
    if (b & 15) throw new Error('non-canonical base64url');
    out[o++] = (a << 2) | (b >> 4);
  } else if (rem === 3) {
    const a = b64Val(s, i);
    const b = b64Val(s, i + 1);
    const c = b64Val(s, i + 2);
    if (c & 3) throw new Error('non-canonical base64url');
    out[o++] = (a << 2) | (b >> 4);
    out[o++] = (b << 4) | (c >> 2);
  }
  return out;
}

/** Testing hook: the pure-JS implementation used when no native base64 is available. */
export const __b64urlFallback = { encode: fallbackEncode, decode: fallbackDecode } as const;

const B64URL_RE = /^[A-Za-z0-9_-]*$/;

/** Strict canonical check shared by the native decoders (which are lenient on their own). */
function assertCanonical(s: string): void {
  const rem = s.length & 3;
  if (rem === 1) throw new Error('invalid base64url length');
  if (!B64URL_RE.test(s)) throw new Error('invalid base64url character');
  if (rem !== 0 && b64Val(s, s.length - 1) & (rem === 2 ? 15 : 3)) throw new Error('non-canonical base64url');
}

interface NativeBase64Proto { toBase64?: (this: Uint8Array, o: { alphabet: 'base64url'; omitPadding: boolean }) => string }
interface NativeBase64Ctor { fromBase64?: (s: string, o: { alphabet: 'base64url' }) => Uint8Array }
interface NodeBufferLike extends Uint8Array { toString(encoding?: 'base64url'): string }
interface NodeBufferCtor {
  from(buf: ArrayBufferLike, byteOffset: number, length: number): NodeBufferLike;
  from(s: string, encoding: 'base64url'): NodeBufferLike;
}

const nativeToBase64 = (Uint8Array.prototype as NativeBase64Proto).toBase64;
const nativeFromBase64 = (Uint8Array as unknown as NativeBase64Ctor).fromBase64;
const NodeBuffer = (globalThis as { Buffer?: NodeBufferCtor }).Buffer;

const encodeImpl: (bytes: Uint8Array) => string = nativeToBase64
  ? (bytes) => nativeToBase64.call(bytes, { alphabet: 'base64url', omitPadding: true })
  : NodeBuffer
    ? (bytes) => NodeBuffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64url')
    : fallbackEncode;

const decodeImpl: (s: string) => Uint8Array = nativeFromBase64
  ? (s) => {
      assertCanonical(s);
      return nativeFromBase64(s, { alphabet: 'base64url' });
    }
  : NodeBuffer
    ? (s) => {
        assertCanonical(s);
        const b = NodeBuffer.from(s, 'base64url');
        // Small Buffers live in Node's shared pool: copy those so callers never see foreign bytes via .buffer.
        return b.byteOffset === 0 && b.byteLength === b.buffer.byteLength
          ? new Uint8Array(b.buffer, 0, b.byteLength)
          : new Uint8Array(b);
      }
    : fallbackDecode;

/** base64url without padding. */
export function b64url(bytes: Uint8Array): string {
  return encodeImpl(bytes);
}

/** Decode canonical unpadded base64url. Throws on padding, invalid chars/length or non-zero trailing bits. */
export function fromB64url(s: string): Uint8Array {
  return decodeImpl(s);
}

export function randomBytes(n: number): Uint8Array {
  return nobleRandomBytes(n);
}

export function randomId(bytes?: number): string {
  return b64url(randomBytes(bytes ?? 16));
}

export interface KeyPair { priv: Uint8Array; pub: string }

/** X25519 key pair (also used for the worker identity key). pub = b64url(raw32). */
export function generateClientKey(): KeyPair {
  const priv = randomBytes(32);
  return { priv, pub: publicKeyOf(priv) };
}

export function publicKeyOf(priv: Uint8Array): string {
  return b64url(x25519.getPublicKey(priv));
}

function decodeKey32(b64: string, what: string): Uint8Array {
  const raw = fromB64url(b64);
  if (raw.length !== 32) throw new Error(`${what} must be 32 bytes`);
  return raw;
}

/** X25519(ourPriv, peerPub) → HKDF-SHA256(salt=HKDF_SALT, info=`${workerId}:${clientPubB64}`) → 32B */
export function deriveKey(ourPriv: Uint8Array, peerPubB64: string, workerId: string, clientPubB64: string): Uint8Array {
  const shared = x25519.getSharedSecret(ourPriv, decodeKey32(peerPubB64, 'public key'));
  return hkdf(sha256, shared, utf8.encode(HKDF_SALT), utf8.encode(`${workerId}:${clientPubB64}`), 32);
}

const NONCE = 12;
const TAG = 16;
const KEY = 32;

function assertKey(key: Uint8Array): void {
  if (key.length !== KEY) throw new Error('key must be 32 bytes');
}

/** AES-256-GCM with a random 12-byte nonce. Output: nonce(12)‖ct‖tag(16). */
export function seal(key: Uint8Array, plaintext: Uint8Array): Uint8Array {
  assertKey(key);
  const nonce = randomBytes(NONCE);
  const ctTag = gcm(key, nonce).encrypt(plaintext);
  const out = new Uint8Array(NONCE + ctTag.length);
  out.set(nonce, 0);
  out.set(ctTag, NONCE);
  return out;
}

/** Inverse of seal. Throws on tampering, wrong key or malformed input. */
export function open(key: Uint8Array, sealed: Uint8Array): Uint8Array {
  assertKey(key);
  if (sealed.length < NONCE + TAG) throw new Error('ciphertext too short');
  return gcm(key, sealed.subarray(0, NONCE)).decrypt(sealed.subarray(NONCE));
}

/** Plaintext frame: u32be(headerLen)‖header(UTF-8 JSON)‖body. */
export function encodeFrame(header: unknown, body?: Uint8Array): Uint8Array {
  const h = utf8.encode(JSON.stringify(header));
  const b = body ?? new Uint8Array(0);
  const out = new Uint8Array(4 + h.length + b.length);
  new DataView(out.buffer).setUint32(0, h.length, false);
  out.set(h, 4);
  out.set(b, 4 + h.length);
  return out;
}

/** `body` is a zero-copy view (subarray) into `bytes`; copy it if `bytes` will be reused/mutated. */
export function decodeFrame(bytes: Uint8Array): { header: unknown; body: Uint8Array } {
  if (bytes.length < 4) throw new Error('frame too short');
  const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
  if (4 + len > bytes.length) throw new Error('frame header length out of range');
  const header: unknown = JSON.parse(utf8.decode(bytes.subarray(4, 4 + len)));
  return { header, body: bytes.subarray(4 + len) };
}

function toBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === 'string' ? utf8.encode(data) : data;
}

export function sha256Hex(data: Uint8Array | string): string {
  return bytesToHex(sha256(toBytes(data)));
}

export function sha256B64url(data: Uint8Array | string): string {
  return b64url(sha256(toBytes(data)));
}

export interface SigningKey { seed: Uint8Array; pub: string }

/** Ed25519 signing key (platform authz key). */
export function generateSigningKey(): SigningKey {
  const seed = randomBytes(32);
  return { seed, pub: signingPublicKey(seed) };
}

export function signingPublicKey(seed: Uint8Array): string {
  return b64url(ed25519.getPublicKey(seed));
}

export function signAuthz(seed: Uint8Array, userId: string, clientPub: string): string {
  return b64url(ed25519.sign(utf8.encode(authzMessage(userId, clientPub)), seed));
}

/** Never throws: malformed inputs simply fail verification. */
export function verifyAuthz(platformPub: string, userId: string, clientPub: string, sig: string): boolean {
  try {
    return ed25519.verify(fromB64url(sig), utf8.encode(authzMessage(userId, clientPub)), decodeKey32(platformPub, 'platform key'));
  } catch {
    return false;
  }
}
