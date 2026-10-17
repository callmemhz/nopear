import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { b64url, fromB64url, generateSigningKey } from '@nopear/core/crypto';
import { isValidEmail, normalizeEmail } from './allowlist';

export interface SaasConfigEnv {
  port: number;
  publicUrl: string;
  /** SAAS_PUBLIC_URL was set explicitly (else `publicUrl` is a localhost fallback and request origins are used). */
  publicUrlExplicit: boolean;
  dataDir: string;
  db: string;
  signingSeed: Uint8Array;
  sessionSecret: string;
  googleClientId: string | null;
  googleClientSecret: string | null;
  devLogin: boolean;
  bootstrapToken: string | null;
  redirectAllowlist: string[];
  bodyLimitBytes: number;
  webDir: string;
  /** SAAS_BOOTSTRAP_ADMIN (normalized): inserted as `admin` at startup when the login allowlist is empty. */
  bootstrapAdmin: string | null;
  /** SAAS_WORKER_TGZ (absolute): prebuilt worker package served by /install/worker.tgz; null → build at startup. */
  workerTgz: string | null;
}

/** Read a persisted secret file, or create it (chmod 600) with `make()`. */
function persisted(path: string, make: () => string): string {
  if (existsSync(path)) return readFileSync(path, 'utf8').trim();
  const v = make();
  writeFileSync(path, v + '\n', { mode: 0o600 });
  return v;
}

export function loadSaasConfig(env: NodeJS.ProcessEnv = process.env): SaasConfigEnv {
  const port = Number(env.SAAS_PORT || 8790);
  const dataDir = resolve(env.SAAS_DATA_DIR || './.saas');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const signingSeed = env.SAAS_SIGNING_KEY
    ? fromB64url(env.SAAS_SIGNING_KEY)
    : fromB64url(persisted(join(dataDir, 'signing.key'), () => b64url(generateSigningKey().seed)));
  if (signingSeed.length !== 32) throw new Error('SAAS_SIGNING_KEY must be a 32-byte Ed25519 seed (b64url)');
  const sessionSecret = env.SAAS_SESSION_SECRET || persisted(join(dataDir, 'session.secret'), () => randomBytes(32).toString('base64url'));
  // nopear:// (mobile deep link) is only the default; an explicit SAAS_REDIRECT_ALLOWLIST is used verbatim.
  const bootstrapAdmin = env.SAAS_BOOTSTRAP_ADMIN ? normalizeEmail(env.SAAS_BOOTSTRAP_ADMIN) : null;
  if (bootstrapAdmin !== null && !isValidEmail(bootstrapAdmin)) throw new Error('SAAS_BOOTSTRAP_ADMIN must be an email address');
  const allow = (env.SAAS_REDIRECT_ALLOWLIST ?? 'nopear://').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    port,
    publicUrl: (env.SAAS_PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
    publicUrlExplicit: !!env.SAAS_PUBLIC_URL,
    dataDir,
    db: env.SAAS_DB || `sqlite:${join(dataDir, 'saas.db')}`,
    signingSeed,
    sessionSecret,
    googleClientId: env.GOOGLE_CLIENT_ID || null,
    googleClientSecret: env.GOOGLE_CLIENT_SECRET || null,
    devLogin: env.SAAS_DEV_LOGIN === '1',
    bootstrapToken: env.SAAS_BOOTSTRAP_TOKEN || null,
    redirectAllowlist: allow,
    bodyLimitBytes: Number(env.SAAS_BODY_LIMIT_MB || 64) * 1024 * 1024,
    webDir: resolve(env.SAAS_WEB_DIR || '../web/dist'),
    bootstrapAdmin,
    workerTgz: env.SAAS_WORKER_TGZ ? resolve(env.SAAS_WORKER_TGZ) : null,
  };
}
