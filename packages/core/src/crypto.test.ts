import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, randomBytes as nodeRandom } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  __b64urlFallback, b64url, decodeFrame, deriveKey, encodeFrame, fromB64url, generateClientKey, generateSigningKey, open,
  publicKeyOf, randomId, seal, sha256B64url, sha256Hex, signAuthz, signingPublicKey, utf8, verifyAuthz,
} from './crypto';

const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex');

function nodeDerive(priv: Uint8Array, peerPub: string, info: string): Buffer {
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_X25519, Buffer.from(priv)]), format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey({ key: Buffer.concat([SPKI_X25519, Buffer.from(fromB64url(peerPub))]), format: 'der', type: 'spki' });
  const shared = diffieHellman({ privateKey, publicKey });
  return Buffer.from(hkdfSync('sha256', shared, 'nopear/v3', info, 32));
}

describe('crypto', () => {
  const client = generateClientKey();
  const worker = generateClientKey();
  const workerId = 'w_abc';

  it('both sides derive the same key', () => {
    const a = deriveKey(client.priv, worker.pub, workerId, client.pub);
    const b = deriveKey(worker.priv, client.pub, workerId, client.pub);
    expect(a).toHaveLength(32);
    expect(b64url(a)).toBe(b64url(b));
    expect(publicKeyOf(client.priv)).toBe(client.pub);
  });

  it('interoperates with node:crypto both directions', () => {
    const key = deriveKey(client.priv, worker.pub, workerId, client.pub);
    const nodeKey = nodeDerive(worker.priv, client.pub, `${workerId}:${client.pub}`);
    expect(b64url(nodeKey)).toBe(b64url(key));

    const sealed = seal(key, utf8.encode('hello 世界'));
    const d = createDecipheriv('aes-256-gcm', nodeKey, sealed.slice(0, 12));
    d.setAuthTag(Buffer.from(sealed.slice(sealed.length - 16)));
    const pt = Buffer.concat([d.update(sealed.slice(12, sealed.length - 16)), d.final()]);
    expect(pt.toString('utf8')).toBe('hello 世界');

    const nonce = nodeRandom(12);
    const c = createCipheriv('aes-256-gcm', nodeKey, nonce);
    const ct = Buffer.concat([c.update('from node', 'utf8'), c.final()]);
    const wire = new Uint8Array(Buffer.concat([nonce, ct, c.getAuthTag()]));
    expect(utf8.decode(open(key, wire))).toBe('from node');
  });

  it('open rejects tampering and wrong keys', () => {
    const key = deriveKey(client.priv, worker.pub, workerId, client.pub);
    const sealed = seal(key, utf8.encode('x'));
    const bad = sealed.slice();
    bad[13] = bad[13]! ^ 1;
    expect(() => open(key, bad)).toThrow();
    const other = deriveKey(client.priv, generateClientKey().pub, workerId, client.pub);
    expect(() => open(other, sealed)).toThrow();
    expect(() => open(key, new Uint8Array(10))).toThrow();
  });

  it('seal uses a random nonce and adds 28 bytes', () => {
    const key = deriveKey(client.priv, worker.pub, workerId, client.pub);
    const pt = utf8.encode('same');
    const a = seal(key, pt);
    const b = seal(key, pt);
    expect(a.length).toBe(pt.length + 28);
    expect(b64url(a)).not.toBe(b64url(b));
  });

  it('frames round-trip and reject truncation', () => {
    const body = new Uint8Array([1, 2, 3, 255]);
    const f1 = decodeFrame(encodeFrame({ op: 'x', n: 1 }, body));
    expect(f1.header).toEqual({ op: 'x', n: 1 });
    expect(Array.from(f1.body)).toEqual([1, 2, 3, 255]);
    const f2 = decodeFrame(encodeFrame({ 中文: '你好' }));
    expect(f2.header).toEqual({ 中文: '你好' });
    expect(f2.body.length).toBe(0);
    const enc = encodeFrame({ a: 'long header' });
    expect(() => decodeFrame(enc.slice(0, enc.length - 3))).toThrow();
    expect(() => decodeFrame(new Uint8Array(2))).toThrow();
  });

  it('authz signatures verify only for exact userId/clientPub', () => {
    const sk = generateSigningKey();
    expect(signingPublicKey(sk.seed)).toBe(sk.pub);
    const sig = signAuthz(sk.seed, 'u1', client.pub);
    expect(verifyAuthz(sk.pub, 'u1', client.pub, sig)).toBe(true);
    expect(verifyAuthz(sk.pub, 'u2', client.pub, sig)).toBe(false);
    expect(verifyAuthz(sk.pub, 'u1', worker.pub, sig)).toBe(false);
    expect(verifyAuthz(sk.pub, 'u1', client.pub, 'garbage!')).toBe(false);
  });

  it('b64url is url-safe, unpadded and round-trips', () => {
    for (let n = 0; n < 40; n++) {
      const x = new Uint8Array(n).map((_, i) => (i * 37 + 251) & 255);
      const s = b64url(x);
      expect(s).not.toMatch(/[=+/]/);
      expect(Array.from(fromB64url(s))).toEqual(Array.from(x));
    }
    expect(() => fromB64url('a*b')).toThrow();
    expect(randomId()).toHaveLength(22);
  });

  it('fromB64url is canonical: rejects padding, bad length and non-zero leftover bits', () => {
    for (const dec of [fromB64url, __b64urlFallback.decode]) {
      expect(Array.from(dec('AQ'))).toEqual([1]);
      expect(Array.from(dec('AQI'))).toEqual([1, 2]);
      expect(dec('').length).toBe(0);
      expect(() => dec('AQ==')).toThrow();
      expect(() => dec('AQI=')).toThrow();
      expect(() => dec('AQID=')).toThrow();
      expect(() => dec('A')).toThrow();
      expect(() => dec('AQIDB')).toThrow();
      expect(() => dec('AR')).toThrow(); // leftover bits non-zero
      expect(() => dec('AQJ')).toThrow(); // leftover bits non-zero
      expect(() => dec('a+b/')).toThrow(); // standard alphabet rejected
      expect(() => dec('a*bc')).toThrow();
      expect(() => dec('ab c')).toThrow();
      expect(() => dec('ab\u00e9c')).toThrow();
    }
  });

  it('b64url round-trips ~1MB random payloads on native and fallback paths', () => {
    const x = new Uint8Array(nodeRandom(1024 * 1024 + 1));
    const s = b64url(x);
    expect(s).toBe(Buffer.from(x).toString('base64url'));
    expect(Buffer.from(fromB64url(s)).equals(Buffer.from(x))).toBe(true);
    const fs = __b64urlFallback.encode(x);
    expect(fs).toBe(s);
    expect(Buffer.from(__b64urlFallback.decode(fs)).equals(Buffer.from(x))).toBe(true);
    // subarray views encode only their window
    const view = x.subarray(3, 1000);
    expect(b64url(view)).toBe(Buffer.from(view).toString('base64url'));
    expect(__b64urlFallback.encode(view)).toBe(Buffer.from(view).toString('base64url'));
  });

  it('fallback b64url matches node for small sizes', () => {
    for (let n = 0; n < 40; n++) {
      const x = new Uint8Array(nodeRandom(n));
      const s = __b64urlFallback.encode(x);
      expect(s).toBe(Buffer.from(x).toString('base64url'));
      expect(Array.from(__b64urlFallback.decode(s))).toEqual(Array.from(x));
    }
  });

  it('seal/open require a 32-byte key and handle empty plaintext', () => {
    const key = deriveKey(client.priv, worker.pub, workerId, client.pub);
    const sealed = seal(key, new Uint8Array(0));
    expect(sealed.length).toBe(28);
    expect(open(key, sealed).length).toBe(0);
    expect(() => seal(new Uint8Array(16), utf8.encode('x'))).toThrow(/32/);
    expect(() => seal(new Uint8Array(24), utf8.encode('x'))).toThrow(/32/);
    expect(() => open(key.subarray(0, 16), sealed)).toThrow(/32/);
  });

  it('deriveKey rejects wrong-length and low-order peer keys', () => {
    expect(() => deriveKey(client.priv, b64url(new Uint8Array(31)), workerId, client.pub)).toThrow();
    expect(() => deriveKey(client.priv, b64url(new Uint8Array(33)), workerId, client.pub)).toThrow();
    expect(() => deriveKey(client.priv, b64url(new Uint8Array(32)), workerId, client.pub)).toThrow();
  });

  it('decodeFrame rejects invalid JSON headers and returns body as a view', () => {
    const h = utf8.encode('{not json');
    const bad = new Uint8Array(4 + h.length);
    new DataView(bad.buffer).setUint32(0, h.length, false);
    bad.set(h, 4);
    expect(() => decodeFrame(bad)).toThrow();
    const f = encodeFrame({ a: 1 }, new Uint8Array([9, 8, 7]));
    const { body } = decodeFrame(f);
    expect(body.buffer).toBe(f.buffer);
    expect(Array.from(body)).toEqual([9, 8, 7]);
  });

  it('sha256 helpers', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256B64url(utf8.encode('abc'))).toBe(b64url(Buffer.from(sha256Hex('abc'), 'hex')));
  });
});
