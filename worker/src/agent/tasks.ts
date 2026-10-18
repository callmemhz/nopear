// Background tasks via pi-subagents' in-process event-bus RPC (TaskTracker).
import type { EventBus } from '@earendil-works/pi-coding-agent';
import type { BackgroundTask, TaskState } from '@nopear/protocol';
import { randomId } from '@nopear/core/crypto';

const ACTIVE: ReadonlySet<string> = new Set<TaskState>(['queued', 'running', 'paused']);
interface Run { id?: unknown; kind?: unknown; label?: unknown; state?: unknown; startedAt?: unknown; children?: Run[] }

/**
 * What a run is doing, for the task list. A workflow's own label is just its agents ("delegate, delegate, …"), so
 * it is described by its steps instead: the ones still active by name, plus how many are done.
 */
export function describeRun(r: Run): string {
  const kids = Array.isArray(r.children) ? r.children : [];
  if (kids.length < 2) return String(r.label ?? '');
  const active = kids.filter((c) => ACTIVE.has(String(c.state))).map((c) => String(c.label ?? c.id ?? ''));
  const done = kids.filter((c) => String(c.state) === 'complete').length;
  const head = active.length ? `${active.join('、')} 进行中 · ` : '';
  return `${head}${done}/${kids.length} 完成`;
}
interface Reply { success?: boolean; data?: { asyncSnapshot?: { runs?: Run[] } }; error?: { message?: string } }

export class TaskTracker {
  private tasks: BackgroundTask[] = [];
  private readonly firstSeen = new Map<string, string>();
  private readonly unsubs: Array<() => void> = [];
  private poll: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private readonly pollMs: number;
  private readonly rpcTimeoutMs: number;

  constructor(private readonly opts: { eventBus: EventBus; onChange(tasks: BackgroundTask[]): void; pollMs?: number; rpcTimeoutMs?: number; log?(msg: string): void }) {
    this.pollMs = opts.pollMs ?? 5000;
    this.rpcTimeoutMs = opts.rpcTimeoutMs ?? 5000;
    const kick = () => { void this.refresh(); };
    this.unsubs.push(opts.eventBus.on('subagent:async-started', kick), opts.eventBus.on('subagent:async-complete', kick));
  }

  current(): BackgroundTask[] { return this.tasks; }

  async refresh(): Promise<void> {
    if (this.disposed) return;
    let reply: Reply;
    try {
      reply = await this.rpc('status', {});
    } catch (err) {
      this.opts.log?.(`task status failed: ${(err as Error).message}`);
      return; // keep previous snapshot
    }
    if (!reply.success) { this.opts.log?.(`task status error: ${reply.error?.message ?? 'unknown'}`); return; }
    const next: BackgroundTask[] = [];
    for (const r of reply.data?.asyncSnapshot?.runs ?? []) {
      if (typeof r.id !== 'string' || !ACTIVE.has(String(r.state))) continue;
      let startedAt: string;
      if (typeof r.startedAt === 'number') startedAt = new Date(r.startedAt).toISOString();
      else {
        startedAt = this.firstSeen.get(r.id) ?? new Date().toISOString();
        this.firstSeen.set(r.id, startedAt);
      }
      next.push({ id: r.id, agent: String(r.kind ?? ''), goal: describeRun(r), state: r.state as TaskState, startedAt });
    }
    const changed = JSON.stringify(next) !== JSON.stringify(this.tasks);
    this.tasks = next;
    this.schedule();
    if (changed && !this.disposed) this.opts.onChange(next);
  }

  async stop(taskId: string): Promise<void> {
    const reply = await this.rpc('stop', { id: taskId });
    if (!reply.success) throw new Error(reply.error?.message ?? 'stop failed');
    await this.refresh();
  }

  dispose(): void {
    this.disposed = true;
    for (const u of this.unsubs) u();
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }

  private schedule(): void {
    if (this.tasks.length > 0 && !this.poll && !this.disposed) {
      this.poll = setInterval(() => { void this.refresh(); }, this.pollMs);
      this.poll.unref?.();
    } else if (this.tasks.length === 0 && this.poll) {
      clearInterval(this.poll);
      this.poll = null;
    }
  }

  private rpc(method: string, params: unknown): Promise<Reply> {
    const requestId = randomId(12);
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error(`subagents rpc ${method} timeout`)); }, this.rpcTimeoutMs);
      const off = this.opts.eventBus.on(`subagents:rpc:v1:reply:${requestId}`, (d) => { clearTimeout(timer); off(); resolve(d as Reply); });
      this.opts.eventBus.emit('subagents:rpc:v1:request', { version: 1, requestId, method, params });
    });
  }
}
