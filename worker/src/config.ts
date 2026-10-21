import { homedir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { THINKING_LEVELS, type ThinkingLevel } from '@nopear/protocol';

export interface WorkerConfig {
  saasUrl: string; bootstrapToken: string | null; label: string; home: string; agentDir: string;
  sessionsDir: string; blobsDir: string; defaultCwd: string; defaultModel: string; defaultThinking: ThinkingLevel;
  piAuthPath: string; piModelsPath: string; persona: string; askTimeoutMs: number; idleDisposeMs: number; version: string;
  /** NOPEAR_E2E: 'auto' follows the account's E2E switch; 'required' rejects all plaintext frames (and the saas client). */
  e2e: 'auto' | 'required';
  /** NOPEAR_CARD_WIP: max cards executed concurrently on this machine (≥ 1). */
  cardWip: number;
  /** NOPEAR_INSTALL_CODE: one-time install code written by the install script (removed after registration). */
  installCode: string | null;
  /** The worker's .env (cwd-relative, as loaded by `tsx --env-file-if-exists=.env`). */
  envFile: string;
  /** NOPEAR_DNS_ORDER: DNS result order for outbound connections. `ipv4first` (default) avoids stalls on hosts whose
   *  IPv6 path is flaky (the tunnel silently dies with 1006); `verbatim` keeps the resolver's order (IPv6-only hosts). */
  dnsOrder: 'ipv4first' | 'verbatim';
  /** NOPEAR_AUTO_TITLE (default on): after the first reply, ask the session's model for a short title. */
  autoTitle: boolean;
  /** NOPEAR_AUTO_UPDATE (default on): a one-line install may update itself when asked from the console. */
  autoUpdate: boolean;
}
const expand = (p: string): string => resolve(p.startsWith('~') ? join(homedir(), p.slice(1)) : p);
const num = (v: string | undefined, d: number): number => {
  if (v === undefined || v === '') return d;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid number: ${v}`);
  return n;
};
/** The NOPEAR_HOME-local subset of the config; needs no NOPEAR_SAAS_URL (offline commands such as import-pi). */
export type LocalConfig = Pick<WorkerConfig, 'home' | 'sessionsDir' | 'defaultModel' | 'defaultThinking'>;
export function loadLocalConfig(env: NodeJS.ProcessEnv = process.env): LocalConfig {
  const home = expand(env.NOPEAR_HOME || '~/.nopear');
  const thinking = (env.NOPEAR_DEFAULT_THINKING || 'medium') as ThinkingLevel;
  if (!THINKING_LEVELS.includes(thinking)) throw new Error(`invalid NOPEAR_DEFAULT_THINKING: ${thinking}`);
  return {
    home,
    sessionsDir: join(home, 'sessions'),
    // '' = the first available model of the pi configuration (models.json / auth.json).
    defaultModel: env.NOPEAR_DEFAULT_MODEL?.trim() || '',
    defaultThinking: thinking,
  };
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const saasUrl = env.NOPEAR_SAAS_URL?.trim().replace(/\/+$/, '');
  if (!saasUrl) throw new Error('NOPEAR_SAAS_URL is required');
  const { home, sessionsDir, defaultModel, defaultThinking } = loadLocalConfig(env);
  const e2e = env.NOPEAR_E2E || 'auto';
  if (e2e !== 'auto' && e2e !== 'required') throw new Error(`invalid NOPEAR_E2E: ${e2e}`);
  const wipRaw = env.NOPEAR_CARD_WIP;
  const cardWip = wipRaw === undefined || wipRaw === '' ? 1 : Number(wipRaw);
  if (!Number.isInteger(cardWip) || cardWip < 1) throw new Error(`invalid NOPEAR_CARD_WIP: ${wipRaw}`);
  const dnsOrder = env.NOPEAR_DNS_ORDER || 'ipv4first';
  if (dnsOrder !== 'ipv4first' && dnsOrder !== 'verbatim') throw new Error(`invalid NOPEAR_DNS_ORDER: ${dnsOrder}`);
  return {
    saasUrl,
    bootstrapToken: env.NOPEAR_SAAS_BOOTSTRAP_TOKEN || null,
    label: env.NOPEAR_LABEL || hostname(),
    home,
    agentDir: join(home, 'agent'),
    sessionsDir,
    blobsDir: join(home, 'blobs'),
    defaultCwd: expand(env.NOPEAR_DEFAULT_CWD || homedir()),
    defaultModel,
    defaultThinking,
    piAuthPath: expand(env.NOPEAR_PI_AUTH || '~/.pi/agent/auth.json'),
    piModelsPath: expand(env.NOPEAR_PI_MODELS || '~/.pi/agent/models.json'),
    persona: env.NOPEAR_PERSONA || 'Claude Code',
    askTimeoutMs: num(env.NOPEAR_ASK_TIMEOUT_MS, 0),
    idleDisposeMs: num(env.NOPEAR_IDLE_DISPOSE_MS, 600_000),
    version: '3.2.0',
    e2e,
    cardWip,
    installCode: env.NOPEAR_INSTALL_CODE?.trim() || null,
    envFile: resolve(process.cwd(), '.env'),
    dnsOrder,
    autoTitle: !['0', 'false', 'off'].includes((env.NOPEAR_AUTO_TITLE ?? '').trim().toLowerCase()),
    autoUpdate: !['0', 'false', 'off'].includes((env.NOPEAR_AUTO_UPDATE ?? '').trim().toLowerCase()),
  };
}
