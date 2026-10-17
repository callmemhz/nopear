// Tool executor — tool catalog, shared by MCP, POST /api/tools/:name and tunnel `t:'tool'`.
import { randomId } from '@nopear/core/crypto';
import {
  CARD_STATES, SESSION_CLASS_TOOLS, validateToolArgs,
  type Block, type CardMoveState, type CardPatch, type CardState, type MemoryScope, type Message, type RpcOp,
  type Session, type ToolErrorCode, type ToolName, type ToolOutcome,
} from '@nopear/protocol';
import { CollabError, type Collab, type ToolCaller } from './collab';
import { workerAcceptsPlaintext } from './hub';

/** HTTP mapping for /api/tools/:name, plus `saas_unreachable` (worker-side only) → 502. */
export const TOOL_HTTP_STATUS: Record<ToolErrorCode, number> = {
  bad_request: 400, forbidden: 403, not_found: 404, too_large: 413, e2e_enabled: 409,
  machine_offline: 503, timeout: 504, internal: 500, saas_unreachable: 502,
};

const MEMORY_PREVIEW_CHARS = 200;
const HISTORY_LIMIT_DEFAULT = 50;

type Args = Record<string, unknown>;
type Handler = (c: Collab, caller: ToolCaller, a: Args) => Promise<unknown>;

const opt = <T>(v: unknown): T | undefined => (v === undefined ? undefined : (v as T));

function callerPath(caller: ToolCaller, path: unknown): { workerId: string; path: string } | null {
  if (path === undefined) return null;
  if (caller.workerId === null) throw new CollabError('bad_request', 'path requires a calling machine');
  return { workerId: caller.workerId, path: path as string };
}

/**
 * Session-class gate, applied by `executeTool` to every tool in `SESSION_CLASS_TOOLS` before its
 * handler runs: account E2E → e2e_enabled; ownership → forbidden; offline → machine_offline; a pre-3.1 worker
 * (cannot read plaintext frames) → e2e_enabled.
 */
async function sessionGate(c: Collab, caller: ToolCaller, workerId: string): Promise<void> {
  if ((await c.getSettings(caller.userId)).e2e) throw new CollabError('e2e_enabled', 'session tools are unavailable while E2E is on');
  const w = await c.requireWorker(caller.userId, workerId);
  if (!c.hub.isOnline(workerId)) throw new CollabError('machine_offline', `machine ${workerId} is offline`);
  if (!workerAcceptsPlaintext(w.version)) {
    throw new CollabError('e2e_enabled', `machine ${workerId} runs a worker older than 3.1 that cannot serve session tools`);
  }
}

/** Plaintext RPC for a session-class tool (the gate already ran in `executeTool`). */
async function workerRpc<T>(c: Collab, workerId: string, op: RpcOp, args: unknown): Promise<T> {
  const o = await c.hub.plainRpc(workerId, op, args);
  if (!o.ok) throw new CollabError(o.error.code, o.error.message);
  return o.result as T;
}

function blockText(b: Block): string | null {
  if (b.type === 'text') return b.text;
  if (b.type === 'tool_call') return `[tool ${b.name}]`;
  if (b.type === 'image') return '[image]';
  return null;
}

const HANDLERS: Record<ToolName, Handler> = {
  async project_list(c, caller) {
    const projects = await c.listProjects(caller.userId);
    return {
      projects: await Promise.all(projects.map(async (p) => ({
        ...p, memoryPreview: (await c.getMemory(caller.userId, 'project', p.id)).content.slice(0, MEMORY_PREVIEW_CHARS),
      }))),
    };
  },
  async project_get(c, caller, a) {
    const project = await c.getProject(caller.userId, a.projectId as string);
    const memory = await c.getMemory(caller.userId, 'project', project.id);
    const cardCounts = Object.fromEntries(CARD_STATES.map((s) => [s, 0])) as Record<CardState, number>;
    for (const card of await c.listCards(caller.userId, { projectId: project.id })) cardCounts[card.state] += 1;
    return { project, memory, cardCounts };
  },
  async project_create(c, caller, a) {
    const p = callerPath(caller, a.path);
    const project = await c.createProject(caller.userId, {
      name: a.name as string, description: opt<string>(a.description), paths: p ? { [p.workerId]: p.path } : {},
    });
    return { project };
  },
  async project_update(c, caller, a) {
    const p = callerPath(caller, a.path);
    const id = a.projectId as string;
    const paths = p ? { ...(await c.getProject(caller.userId, id)).paths, [p.workerId]: p.path } : undefined;
    const project = await c.updateProject(caller.userId, id, { name: opt<string>(a.name), description: opt<string>(a.description), paths });
    return { project };
  },
  async card_list(c, caller, a) {
    return {
      cards: await c.listCards(caller.userId, {
        projectId: opt<string>(a.projectId), state: opt<CardState>(a.state), workerId: opt<string>(a.workerId),
      }),
    };
  },
  async card_create(c, caller, a) {
    return {
      card: await c.createCard(caller.userId, { title: a.title as string, body: opt<string>(a.body), projectId: opt<string | null>(a.projectId) }),
    };
  },
  async card_update(c, caller, a) {
    const patch: CardPatch = { title: opt<string>(a.title), body: opt<string>(a.body), projectId: opt<string | null>(a.projectId) };
    return { card: await c.patchCard(caller.userId, a.cardId as string, patch) };
  },
  async card_move(c, caller, a) {
    const patch: CardPatch = { state: a.state as CardMoveState, workerId: opt<string>(a.workerId), order: opt<number>(a.order) };
    return { card: await c.patchCard(caller.userId, a.cardId as string, patch) };
  },
  async memory_get(c, caller, a) {
    return { memory: await c.getMemory(caller.userId, a.scope as MemoryScope, opt<string | null>(a.projectId) ?? null) };
  },
  async memory_update(c, caller, a) {
    const scope = a.scope as MemoryScope;
    const projectId = opt<string | null>(a.projectId) ?? null;
    let content = a.content as string;
    if (a.mode === 'append') {
      const prev = (await c.getMemory(caller.userId, scope, projectId)).content;
      if (prev) content = `${prev}\n${content}`;
    }
    return { memory: await c.putMemory(caller.userId, scope, projectId, content) };
  },
  async machine_list(c, caller) {
    return { machines: await c.listMachines(caller.userId) };
  },
  async session_list(c, caller, a) {
    return {
      sessions: await c.querySessions(caller.userId, {
        projectId: opt<string>(a.projectId), workerId: opt<string>(a.workerId), q: opt<string>(a.q), limit: opt<number>(a.limit),
      }),
    };
  },
  async session_history(c, caller, a) {
    const workerId = a.workerId as string;
    const res = await workerRpc<{ messages: Message[] }>(c, workerId, 'messages.page', {
      sessionId: a.sessionId as string, limit: opt<number>(a.limit) ?? HISTORY_LIMIT_DEFAULT,
    });
    return {
      messages: (res.messages ?? []).map((m) => ({
        role: m.role, ts: m.ts,
        text: m.blocks.map(blockText).filter((t): t is string => t !== null).join('\n'),
      })),
    };
  },
  async session_start(c, caller, a) {
    const workerId = a.workerId as string;
    const projectId = opt<string>(a.projectId);
    const project = projectId === undefined ? undefined : await c.getProject(caller.userId, projectId);
    const cwd = opt<string>(a.cwd) ?? project?.paths[workerId];
    const args: Args = { text: a.prompt as string, clientMsgId: `tool-${randomId(8)}` };
    if (cwd !== undefined) args.cwd = cwd;
    if (projectId !== undefined) args.projectId = projectId;
    const res = await workerRpc<{ session: Session }>(c, workerId, 'sessions.create', args);
    return { sessionId: res.session.id };
  },
  async session_tag(c, caller, a) {
    const projectId = a.projectId as string | null;
    if (projectId !== null) await c.getProject(caller.userId, projectId);
    await workerRpc(c, a.workerId as string, 'sessions.update', { sessionId: a.sessionId as string, projectId });
    return { ok: true };
  },
};

function fail(code: ToolErrorCode, message: string): ToolOutcome {
  return { ok: false, error: { code, message } };
}

export async function executeTool(collab: Collab, caller: ToolCaller, name: string, args: unknown): Promise<ToolOutcome> {
  const invalid = validateToolArgs(name, args);
  if (invalid) return fail('bad_request', invalid);
  try {
    if (SESSION_CLASS_TOOLS.includes(name as ToolName)) await sessionGate(collab, caller, (args as Args).workerId as string);
    return { ok: true, result: await HANDLERS[name as ToolName](collab, caller, args as Args) };
  } catch (e) {
    if (e instanceof CollabError) return fail(e.code, e.message);
    return fail('internal', e instanceof Error ? e.message : String(e));
  }
}
