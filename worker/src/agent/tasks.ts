// Background tasks via pi-subagents' in-process event-bus RPC (TaskTracker), enriched from the status.json files
// pi-subagents keeps per run (steps, current tool, turns, the child's session file, errors).
import { readFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import type { EventBus } from '@earendil-works/pi-coding-agent';
import { ACTIVE_TASK_STATES, type BackgroundTask, type TaskActivity, type TaskState, type TaskStep } from '@nopear/protocol';
import { randomId } from '@nopear/core/crypto';

const ACTIVE: ReadonlySet<string> = new Set<string>(ACTIVE_TASK_STATES);
const TEXT_MAX = 300;
const ERROR_MAX = 600;
/** Finished runs kept in the list (newest first) so their transcript stays one tap away. */
const MAX_FINISHED = 8;

interface Run { id?: unknown; kind?: unknown; label?: unknown; state?: unknown; startedAt?: unknown; children?: Run[] }
interface Reply { success?: boolean; data?: { asyncSnapshot?: { runs?: Run[] } }; error?: { message?: string } }

/** The parts of pi-subagents' `<runs dir>/<runId>/status.json` we use (all optional: it is not our format). */
export interface StepStatus {
  agent?: string; label?: string; workflowKey?: string; sessionName?: string; description?: string;
  status?: string; runId?: string; startedAt?: number; endedAt?: number; model?: string; error?: string;
  currentTool?: string; currentToolArgs?: string; recentTools?: Array<{ tool?: string; args?: string }>; recentOutput?: string[];
  turnCount?: number; toolCount?: number; lastActivityAt?: number; sessionFile?: string;
}
export interface RunStatus {
  runId?: string; mode?: string; state?: string; startedAt?: number; endedAt?: number; error?: string;
  parentWorkflowRunId?: string; steps?: StepStatus[];
}
export type ReadStatus = (runId: string) => RunStatus | null;

/** Where pi-subagents keeps async run state (mirrors its TEMP_ROOT_DIR, which it does not export). */
export function subagentRunsDir(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.PI_SUBAGENTS_TEMP_ROOT?.trim();
  if (root) return join(resolve(root), 'async-subagent-runs');
  let scope: string;
  if (typeof process.getuid === 'function') scope = `uid-${process.getuid()}`;
  else {
    const name = env.USERNAME || env.USER || env.LOGNAME || (() => { try { return userInfo().username; } catch { return ''; } })();
    scope = `user-${name.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown'}`;
  }
  return join(tmpdir(), `pi-subagents-${scope}`, 'async-subagent-runs');
}

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export function readRunStatus(runId: string, dir = subagentRunsDir()): RunStatus | null {
  if (!RUN_ID.test(runId)) return null;
  try {
    const v = JSON.parse(readFileSync(join(dir, runId, 'status.json'), 'utf8')) as unknown;
    return v && typeof v === 'object' ? v as RunStatus : null;
  } catch { return null; }
}

export function taskState(s: unknown): TaskState {
  switch (String(s ?? '')) {
    case 'running': return 'running';
    case 'paused': return 'paused';
    case 'complete': case 'completed': return 'complete';
    case 'failed': case 'rejected': case 'partial': return 'failed';
    case 'stopped': case 'cancelled': case 'canceled': case 'interrupted': return 'stopped';
    default: return 'queued';
  }
}

const iso = (ms: unknown): string | undefined => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined);
const clip = (s: unknown, n = TEXT_MAX): string | undefined => {
  if (typeof s !== 'string') return undefined;
  const t = s.trim();
  return t ? (t.length > n ? `${t.slice(0, n - 1)}…` : t) : undefined;
};
const num = (n: unknown): number | undefined => (typeof n === 'number' && Number.isFinite(n) ? n : undefined);

function activityOf(s: StepStatus): TaskActivity | undefined {
  const last = Array.isArray(s.recentTools) ? s.recentTools.at(-1) : undefined;
  const tool = clip(s.currentTool, 60) ?? clip(last?.tool, 60);
  const toolArgs = clip(s.currentTool ? s.currentToolArgs : last?.args, 160);
  const outputs = Array.isArray(s.recentOutput) ? s.recentOutput.filter((x) => typeof x === 'string' && x.trim()) : [];
  const a: TaskActivity = {};
  if (tool) a.tool = tool;
  if (tool && toolArgs) a.toolArgs = toolArgs;
  const turns = num(s.turnCount); if (turns !== undefined) a.turns = turns;
  const tools = num(s.toolCount); if (tools !== undefined) a.tools = tools;
  const output = clip(outputs.at(-1)); if (output) a.output = output;
  const at = iso(s.lastActivityAt); if (at) a.lastActivityAt = at;
  return Object.keys(a).length ? a : undefined;
}

/** A single run's goal: its description, else the prompt preview pi-subagents puts in sessionName ("agent: …"). */
function goalOf(s: StepStatus): string {
  const d = clip(s.description);
  if (d && d !== '[prompt redacted]') return d;
  const n = clip(s.sessionName);
  if (n) return s.agent && n.startsWith(`${s.agent}: `) ? n.slice(s.agent.length + 2) : n;
  return s.agent ?? '';
}

/** "media、publish 进行中 · 1/3 完成" */
export function describeSteps(steps: Array<{ label: string; state: string }>): string {
  const active = steps.filter((c) => c.state === 'running' || c.state === 'paused').map((c) => c.label);
  const done = steps.filter((c) => c.state === 'complete').length;
  const head = active.length ? `${active.join('、')} 进行中 · ` : '';
  return `${head}${done}/${steps.length} 完成`;
}

/**
 * Fallback when status.json is unreadable: a workflow's own label is just its agents ("delegate, delegate, …"),
 * so describe it by its steps instead.
 */
export function describeRun(r: Run): string {
  const kids = Array.isArray(r.children) ? r.children : [];
  if (kids.length < 2) return String(r.label ?? '');
  return describeSteps(kids.map((c) => ({ label: String(c.label ?? c.id ?? ''), state: taskState(c.state) })));
}

function stepOf(s: StepStatus, index: number, run: RunStatus, runId: string, read: ReadStatus): TaskStep {
  // A workflow step is a run of its own (with its own status + session file); a chain/parallel step is not.
  const own = typeof s.runId === 'string' && s.runId !== runId ? s.runId : null;
  const child = own ? read(own) : null;
  const cs: StepStatus = { ...s, ...(child?.steps?.[0] ?? {}) };
  const state = taskState(child?.state ?? s.status);
  const step: TaskStep = {
    key: String(s.workflowKey ?? s.label ?? index), label: String(s.label ?? s.workflowKey ?? s.agent ?? `#${index + 1}`),
    agent: String(s.agent ?? ''), state, transcript: { runId: own ?? runId, step: own ? 0 : index },
  };
  const startedAt = iso(child?.startedAt ?? cs.startedAt); if (startedAt) step.startedAt = startedAt;
  const endedAt = iso(child?.endedAt ?? cs.endedAt); if (endedAt && !ACTIVE.has(state)) step.endedAt = endedAt;
  if (cs.model) step.model = cs.model;
  const activity = activityOf(cs); if (activity) step.activity = activity;
  const error = clip(cs.error ?? child?.error, ERROR_MAX); if (error && state === 'failed') step.error = error;
  return step;
}

/** One list entry for a run, from the snapshot node plus (when readable) its status.json. */
export function taskOf(r: Run & { id: string }, st: RunStatus | null, read: ReadStatus, firstSeen: () => string): BackgroundTask {
  const state = taskState(r.state ?? st?.state);
  const startedAt = iso(r.startedAt) ?? iso(st?.startedAt) ?? firstSeen();
  const endedAt = ACTIVE.has(state) ? undefined : iso(st?.endedAt);
  const base = { id: r.id, state, startedAt, ...(endedAt ? { endedAt } : {}) };
  const steps = Array.isArray(st?.steps) ? st.steps : [];
  if (!st || steps.length === 0) return { ...base, agent: String(r.kind ?? ''), goal: describeRun(r) };
  const runError = clip(st.error, ERROR_MAX);
  if (st.mode === 'workflow' || steps.length > 1) {
    const ts = steps.map((s, i) => stepOf(s, i, st, r.id, read));
    return { ...base, agent: String(st.mode ?? r.kind ?? 'workflow'), goal: describeSteps(ts), steps: ts,
      ...(runError && state === 'failed' ? { error: runError } : {}) };
  }
  const s = steps[0]!;
  const t: BackgroundTask = { ...base, agent: String(s.agent ?? r.kind ?? ''), goal: goalOf(s) || String(r.label ?? ''),
    transcript: { runId: r.id, step: 0 } };
  if (s.model) t.model = s.model;
  const activity = activityOf(s); if (activity) t.activity = activity;
  const error = clip(s.error, ERROR_MAX) ?? runError; if (error && state === 'failed') t.error = error;
  return t;
}

export class TaskTracker {
  private tasks: BackgroundTask[] = [];
  private readonly firstSeen = new Map<string, string>();
  /** Finished runs, kept after pi-subagents drops them from its snapshot. */
  private readonly finished = new Map<string, BackgroundTask>();
  private readonly unsubs: Array<() => void> = [];
  private poll: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private readonly pollMs: number;
  private readonly rpcTimeoutMs: number;
  private readonly read: ReadStatus;

  constructor(private readonly opts: {
    eventBus: EventBus; onChange(tasks: BackgroundTask[]): void; pollMs?: number; rpcTimeoutMs?: number; log?(msg: string): void;
    readStatus?: ReadStatus;
  }) {
    this.pollMs = opts.pollMs ?? 5000;
    this.rpcTimeoutMs = opts.rpcTimeoutMs ?? 5000;
    this.read = opts.readStatus ?? ((id) => readRunStatus(id));
    const kick = () => { void this.refresh(); };
    this.unsubs.push(opts.eventBus.on('subagent:async-started', kick), opts.eventBus.on('subagent:async-complete', kick));
  }

  /** Active runs first, then recently finished ones (newest first). */
  current(): BackgroundTask[] { return this.tasks; }
  active(): BackgroundTask[] { return this.tasks.filter((t) => ACTIVE.has(t.state)); }

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
    const all: BackgroundTask[] = [];
    const statuses = new Map<string, RunStatus | null>();
    const seen = new Set<string>();
    for (const r of reply.data?.asyncSnapshot?.runs ?? []) {
      if (typeof r.id !== 'string' || seen.has(r.id)) continue;
      seen.add(r.id);
      const id = r.id;
      const known = this.finished.get(id);
      if (known && !ACTIVE.has(taskState(r.state))) { all.push(known); continue; } // finished: status won't change
      const st = this.read(id);
      statuses.set(id, st);
      const firstSeen = () => { const v = this.firstSeen.get(id) ?? new Date().toISOString(); this.firstSeen.set(id, v); return v; };
      all.push(taskOf({ ...r, id }, st, this.read, firstSeen));
    }
    // Runs that vanished from the snapshot while active: settle them from their status file when possible.
    for (const t of this.tasks) {
      if (seen.has(t.id) || !ACTIVE.has(t.state)) continue;
      const st = this.read(t.id);
      if (st && !ACTIVE.has(taskState(st.state))) all.push(taskOf({ id: t.id, state: st.state }, st, this.read, () => t.startedAt));
    }
    // A workflow's steps are runs too: list them under the workflow, not again on their own.
    const nested = new Set<string>();
    for (const t of all) for (const s of t.steps ?? []) if (s.transcript && s.transcript.runId !== t.id) nested.add(s.transcript.runId);
    const ids = new Set(all.map((t) => t.id));
    const top = all.filter((t) => {
      if (nested.has(t.id)) return false;
      const parent = statuses.get(t.id)?.parentWorkflowRunId;
      return !(parent && ids.has(parent));
    });
    for (const t of top) if (!ACTIVE.has(t.state)) this.finished.set(t.id, t);
    const active = top.filter((t) => ACTIVE.has(t.state));
    const activeIds = new Set(active.map((t) => t.id));
    const done = [...this.finished.values()].filter((t) => !activeIds.has(t.id) && !nested.has(t.id))
      .sort((a, b) => (b.endedAt ?? b.startedAt).localeCompare(a.endedAt ?? a.startedAt));
    for (const t of done.slice(MAX_FINISHED)) this.finished.delete(t.id);
    const next = [...active, ...done.slice(0, MAX_FINISHED)];
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
    const busy = this.tasks.some((t) => ACTIVE.has(t.state));
    if (busy && !this.poll && !this.disposed) {
      this.poll = setInterval(() => { void this.refresh(); }, this.pollMs);
      this.poll.unref?.();
    } else if (!busy && this.poll) {
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
