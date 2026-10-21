// Self-update of a one-line install (see MachineUpdate in @nopear/protocol): when SaaS asks, run SaaS's
// update.sh with --from-worker (it puts the new code in place next to the running one), then restart once no
// session is working; the service manager (launchd / systemd) starts the new code.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { WorkerUpdateState } from '@nopear/protocol';

/** Repository root of this worker (…/worker/src → …). */
export const WORKER_ROOT = resolve(import.meta.dirname, '../..');

/** Installer build this worker runs (nopear-build.json, only in installer packages); undefined for a source checkout. */
export function readBuild(root = WORKER_ROOT): string | undefined {
  try {
    const b = (JSON.parse(readFileSync(join(root, 'nopear-build.json'), 'utf8')) as { build?: unknown }).build;
    return typeof b === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(b) ? b : undefined;
  } catch { return undefined; }
}

/**
 * The service manager that restarts this worker: NOPEAR_SERVICE (set by newer installers), systemd's INVOCATION_ID,
 * or — for older macOS installs, where launchd's XPC_SERVICE_NAME does not reach node — the dev.nopear.worker
 * launchd job's process being one of our ancestors.
 */
export function serviceManager(env: NodeJS.ProcessEnv = process.env, launchdJobIsAncestor: () => boolean = probeLaunchd): 'launchd' | 'systemd' | null {
  if (env.NOPEAR_SERVICE === 'launchd' || env.NOPEAR_SERVICE === 'systemd') return env.NOPEAR_SERVICE;
  if (env.INVOCATION_ID) return 'systemd';
  if (env.XPC_SERVICE_NAME === 'dev.nopear.worker' || launchdJobIsAncestor()) return 'launchd';
  return null;
}

function probeLaunchd(): boolean {
  if (process.platform !== 'darwin' || typeof process.getuid !== 'function') return false;
  try {
    const out = execFileSync('launchctl', ['print', `gui/${process.getuid()}/dev.nopear.worker`], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    const job = Number(/^\tpid = (\d+)$/m.exec(out)?.[1]);
    if (!job) return false;
    let pid = process.pid;
    for (let i = 0; i < 12 && pid > 1; i++) {
      if (pid === job) return true;
      pid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000 }).trim());
    }
    return false;
  } catch { return false; }
}

/** Self-update needs an installer package (there is code to replace) and a service manager (to come back). */
export function canSelfUpdate(o: { build?: string; autoUpdate: boolean; env?: NodeJS.ProcessEnv; launchdJobIsAncestor?: () => boolean }): boolean {
  return !!o.build && o.autoUpdate && serviceManager(o.env, o.launchdJobIsAncestor) !== null;
}

/** `<home>/worker.pid` lets a manual `update.sh` ask the running worker to restart when idle (SIGUSR2). */
export function writePidFile(home: string): () => void {
  const file = join(home, 'worker.pid');
  try { writeFileSync(file, `${process.pid}\n`, { mode: 0o600 }); } catch { return () => {}; }
  return () => {
    try { if (readFileSync(file, 'utf8').trim() === String(process.pid)) rmSync(file); } catch { /* gone */ }
  };
}

/**
 * update.sh prepares the new code in `<root>.new` (deps installed, worker/.env copied) and leaves the running tree
 * alone; swap it in right before exiting: `<root>` → `<root>.old` (kept until the next update), `<root>.new` →
 * `<root>`. Returns false when there is nothing to swap or the new tree looks incomplete.
 */
export function swapInNewCode(root = WORKER_ROOT, log: (m: string) => void = (m) => console.warn(m)): boolean {
  const next = `${root}.new`;
  if (!existsSync(join(next, 'worker', '.env')) || !existsSync(join(next, 'node_modules')) || !existsSync(join(next, 'worker', 'src', 'main.ts'))) return false;
  try {
    rmSync(`${root}.old`, { recursive: true, force: true });
    renameSync(root, `${root}.old`);
    renameSync(next, root);
    if (existsSync(join(`${root}.old`, 'worker.log'))) renameSync(join(`${root}.old`, 'worker.log'), join(root, 'worker.log'));
    return true;
  } catch (err) {
    log(`[nopear] could not swap in the new code: ${(err as Error)?.message ?? err}`);
    if (!existsSync(root) && existsSync(`${root}.old`)) { try { renameSync(`${root}.old`, root); } catch { /* leave it */ } }
    return false;
  }
}

export interface UpdaterDeps {
  saasUrl: string;
  /** Sessions still working (running turn, background tasks, /btw…); restart waits for 0. */
  busy(): number;
  report(state: WorkerUpdateState, message?: string): void;
  /** Exit so the service manager starts the new code. */
  restart(): void;
  /** Tests. */
  pollMs?: number;
  fetchScript?(url: string): Promise<string>;
  runScript?(script: string): Promise<{ code: number; output: string }>;
  log?(msg: string): void;
}

export class Updater {
  private phase: 'idle' | 'downloading' | 'waiting' | 'restarting' = 'idle';
  private last: { state: WorkerUpdateState; message?: string } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly d: UpdaterDeps) {}

  get state(): string { return this.phase; }

  /** Download + prepare the new code, then restart when idle. A second call while one runs is ignored. */
  async update(): Promise<void> {
    if (this.phase !== 'idle') { this.reannounce(); return; }
    this.phase = 'downloading';
    this.set('downloading', '下载新版本、安装依赖…');
    try {
      const script = await (this.d.fetchScript ?? defaultFetch)(`${this.d.saasUrl}/update.sh`);
      const r = await (this.d.runScript ?? defaultRun)(script);
      if (r.code !== 0) throw new Error(tail(r.output) || `update.sh exited with ${r.code}`);
    } catch (err) {
      this.phase = 'idle';
      const msg = String((err as Error)?.message ?? err).slice(-600);
      this.d.log?.(`[nopear] update failed: ${msg}`);
      this.set('failed', msg);
      return;
    }
    this.restartWhenIdle();
  }

  /** Restart once no session is working (new code already in place: after update(), or on SIGUSR2 from update.sh). */
  restartWhenIdle(): void {
    if (this.phase === 'restarting') return;
    this.phase = 'waiting';
    if (this.timer) clearTimeout(this.timer);
    const check = () => {
      this.timer = null;
      const n = this.d.busy();
      if (n > 0) {
        this.set('waiting', `新版本已就绪，等 ${n} 个会话空闲后重启`);
        this.timer = setTimeout(check, this.d.pollMs ?? 10_000);
        this.timer.unref?.();
        return;
      }
      this.phase = 'restarting';
      this.set('restarting', '正在重启');
      this.d.restart();
    };
    check();
  }

  /** After a reconnect: SaaS forgot the state with the old connection. */
  reannounce(): void {
    if (this.last && this.phase !== 'idle') this.d.report(this.last.state, this.last.message);
  }

  dispose(): void { if (this.timer) clearTimeout(this.timer); this.timer = null; }

  private set(state: WorkerUpdateState, message?: string): void {
    if (this.last?.state === state && this.last.message === message) return;
    this.last = { state, ...(message ? { message } : {}) };
    this.d.report(state, message);
  }
}

const tail = (s: string) => s.trim().split('\n').slice(-6).join('\n');

async function defaultFetch(url: string): Promise<string> {
  const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
  const text = await r.text();
  if (!text.startsWith('#!')) throw new Error(`GET ${url} did not return a script`);
  return text;
}

function defaultRun(script: string): Promise<{ code: number; output: string }> {
  return new Promise((done) => {
    const child = spawn('bash', ['-s', '--', '--from-worker'], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    let output = '';
    const keep = (b: Buffer) => { output = (output + b.toString('utf8')).slice(-8000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill('SIGKILL'), 20 * 60_000);
    child.on('error', (e) => { clearTimeout(timer); done({ code: 1, output: `${output}\n${e.message}` }); });
    child.on('close', (code) => { clearTimeout(timer); done({ code: code ?? 1, output }); });
    child.stdin.end(script);
  });
}
