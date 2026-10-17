// Worker identity persisted at $NOPEAR_HOME/identity.json (chmod 600): workerId, X25519 keypair,
// tunnel secret, and the TOFU-pinned SaaS platform signing key.
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { b64url, fromB64url, generateClientKey, publicKeyOf, randomBytes, randomId } from '@nopear/core/crypto';
import { ensurePrivateDir } from './fsutil';

export interface Identity {
  workerId: string; priv: Uint8Array; pub: string; secret: string; platformPub: string | null;
  /** SaaS this identity is registered with (platformPub is pinned per SaaS). */
  saasUrl?: string | null;
  /** sha256 of the last install code successfully redeemed — a restart with the same (already used) code skips it. */
  redeemedInstallCodeHash?: string | null;
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
function newWorkerId(): string {
  const b = randomBytes(16);
  let s = 'w_';
  for (let i = 0; i < 16; i++) s += B32[b[i]! & 31];
  return s;
}

const file = (home: string) => join(home, 'identity.json');

export function saveIdentity(home: string, id: Identity): void {
  ensurePrivateDir(home);
  const tmp = file(home) + '.tmp';
  const data = { workerId: id.workerId, priv: b64url(id.priv), secret: id.secret, platformPub: id.platformPub, saasUrl: id.saasUrl ?? null,
    redeemedInstallCodeHash: id.redeemedInstallCodeHash ?? null };
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file(home));
}

/** Load (or create) the identity. With `saasUrl`: a pin recorded for a genuinely different SaaS is dropped so
 *  the tunnel re-registers there (register is idempotent for the same pub + secret). A legacy file with no
 *  recorded saasUrl keeps its pin and just records the current URL. */
export function loadOrCreateIdentity(home: string, saasUrl?: string, log: (msg: string) => void = (m) => console.warn(m)): Identity {
  ensurePrivateDir(home);
  if (existsSync(file(home))) {
    const j = JSON.parse(readFileSync(file(home), 'utf8')) as {
      workerId: string; priv: string; secret: string; platformPub: string | null; saasUrl?: string | null;
      redeemedInstallCodeHash?: string | null;
    };
    const priv = fromB64url(j.priv);
    const id: Identity = { workerId: j.workerId, priv, pub: publicKeyOf(priv), secret: j.secret,
      platformPub: j.platformPub ?? null, saasUrl: j.saasUrl ?? null,
      redeemedInstallCodeHash: j.redeemedInstallCodeHash ?? null };
    if (saasUrl !== undefined && id.saasUrl !== saasUrl) {
      if (id.saasUrl) {
        if (id.platformPub) {
          log(`[nopear] identity was registered with ${id.saasUrl}; now using ${saasUrl} — `
            + 'dropping the pinned platform key and will re-register this worker there');
        }
        id.platformPub = null;
      }
      id.saasUrl = saasUrl;
      saveIdentity(home, id);
    }
    return id;
  }
  const kp = generateClientKey();
  const id: Identity = { workerId: newWorkerId(), priv: kp.priv, pub: kp.pub, secret: randomId(32), platformPub: null,
    saasUrl: saasUrl ?? null };
  saveIdentity(home, id);
  return id;
}
