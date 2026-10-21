import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fromB64url, randomId, sha256Hex } from '@nopear/core/crypto';
import {
  BINARY_RPC_TIMEOUT_MS, HEADER_CLIENT, HEADER_PLAIN, INSTALL_CODE_TTL_MS, PLAINTEXT_DISABLED_MESSAGE, SAAS_TOKEN_TTL_MS, SSE_PING_MS,
  type AllowlistEntry, type AllowlistRole, type CardPatch, type CardState, type InstallCodeResult, type Machine, type MachineUpdate, type MeResult,
  type MemoryScope, type SaasEvent, type User,
  type AdminMachine, type AdminOverview, type AdminUser,
} from '@nopear/protocol';
import { accountUsable, isValidEmail, loginAllowed, normalizeEmail } from './allowlist';
import { hashToken, isAllowedRedirect, safeEq, signState, verifyState } from './auth';
import { CollabError, type Collab } from './collab';
import type { SaasConfigEnv } from './config';
import { workerAcceptsPlaintext, type WorkerHub } from './hub';
import { requestBaseUrl, shq } from './install';
import type { AllowlistRow, SaasStore, UserRow, WorkerRow } from './store';
import { executeTool, TOOL_HTTP_STATUS } from './tools';

const STATE_TTL_MS = 10 * 60 * 1000;

export interface RouteDeps {
  config: SaasConfigEnv;
  store: SaasStore;
  hub: WorkerHub;
  events: EventsBus;
  collab: Collab;
  signingPub: string;
}

/** Per-user plaintext /api/events SSE subscribers. */
export class EventsBus {
  private subs = new Map<string, Set<(e: SaasEvent) => void>>();
  private streams = new Map<() => void, string>();
  /** Track an open /api/events stream of `userId` so shutdown (or disabling the account) can end it; returns an untrack fn. */
  track(end: () => void, userId = ''): () => void {
    this.streams.set(end, userId);
    return () => { this.streams.delete(end); };
  }
  /** End every open /api/events stream (server shutdown). */
  closeAll(): void {
    for (const end of [...this.streams.keys()]) end();
    this.streams.clear();
  }
  /** End one user's open /api/events streams (account disabled). */
  closeUser(userId: string): void {
    for (const [end, uid] of [...this.streams]) if (uid === userId) { this.streams.delete(end); end(); }
  }
  subscribe(userId: string, fn: (e: SaasEvent) => void): () => void {
    let set = this.subs.get(userId);
    if (!set) { set = new Set(); this.subs.set(userId, set); }
    set.add(fn);
    return () => { set!.delete(fn); };
  }
  emit(userId: string, e: SaasEvent): void {
    for (const fn of this.subs.get(userId) ?? []) fn(e);
  }
}

export function toMachine(w: WorkerRow, hub: { isOnline(id: string): boolean; machineUpdate(id: string): MachineUpdate | undefined }): Machine {
  const m: Machine = { workerId: w.workerId, label: w.label, workerPub: w.workerPub, online: hub.isOnline(w.workerId), lastSeenAt: w.lastSeenAt, version: w.version };
  const update = hub.machineUpdate(w.workerId);
  if (update) m.update = update;
  return m;
}
const toUser = (u: UserRow): User => ({ id: u.id, email: u.email });
const toEntry = (r: AllowlistRow): AllowlistEntry => ({ email: r.email, role: r.role, addedBy: r.addedBy, createdAt: r.createdAt });
const isRole = (v: unknown): v is AllowlistRole => v === 'admin' || v === 'member';

function fail(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { code, message } });
}
/** Max bytes an SSE response may buffer for a slow client before the stream is dropped. */
export const SSE_MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

/** Write one SSE chunk. Returns false (and writes nothing) if the socket is gone or over the buffer cap. */
function sseWrite(raw: import('node:http').ServerResponse, chunk: string): boolean {
  if (raw.destroyed || raw.writableEnded) return false;
  if (raw.writableLength > SSE_MAX_BUFFERED_BYTES) return false;
  raw.write(chunk);
  return true;
}

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

export function registerRoutes(app: FastifyInstance, d: RouteDeps): void {
  // Shutdown: server.close() waits for open connections, and SSE streams never end on their own.
  // End them (and drop worker tunnels → every watch gets `event: offline`) BEFORE the server closes.
  app.addHook('preClose', async () => {
    d.events.closeAll();
    d.hub.close();
  });
  const { config, store, hub, events, collab } = d;

  async function authUser(req: FastifyRequest): Promise<UserRow | null> {
    const tok = bearer(req);
    if (!tok) return null;
    const t = await store.tokens.get(hashToken(tok));
    if (!t || t.expiresAt < Date.now()) return null;
    const u = await store.users.get(t.userId);
    // Login allowlist + admin disable: the single choke point for every saasToken-authenticated route.
    if (!u || !(await accountUsable(store, u))) return null;
    const nowMs = Date.now();
    if (nowMs - (touched.get(u.id) ?? 0) > TOUCH_EVERY_MS) {
      touched.set(u.id, nowMs);
      await store.users.touch(u.id, new Date(nowMs).toISOString());
    }
    return u;
  }
  /** lastSeenAt is coarse on purpose: one write per user every few minutes, not one per request. */
  const touched = new Map<string, number>();
  const TOUCH_EVERY_MS = 5 * 60_000;
  /**
   * Sign-in by someone the allowlist does not admit: when the list is enabled, record (or bump) an access request
   * for an admin to approve. Returns the request status, or null in open mode (nothing to request).
   */
  async function requestAccess(email: string): Promise<'pending' | 'rejected' | null> {
    if ((await store.allowlist.count()) === 0) return null;
    return (await store.accessRequests.record(normalizeEmail(email))).status;
  }
  async function issueToken(userId: string): Promise<string> {
    const token = randomId(32);
    await store.tokens.create(userId, hashToken(token), Date.now() + SAAS_TOKEN_TTL_MS);
    return token;
  }
  async function pushAuthzForUser(userId: string): Promise<void> {
    for (const w of await store.workers.listByUser(userId)) await hub.pushAuthz(w.workerId);
  }

  // ---------- public ----------
  app.get('/api/config', async () => ({
    googleEnabled: !!(config.googleClientId && config.googleClientSecret),
    devLogin: config.devLogin,
    publicUrl: config.publicUrl,
  }));

  app.post('/api/auth/dev', async (req, reply) => {
    if (!config.devLogin) return fail(reply, 404, 'not_found', 'dev login disabled');
    const email = (req.body as { email?: unknown } | null)?.email;
    if (typeof email !== 'string' || !email.includes('@')) return fail(reply, 400, 'bad_request', 'email required');
    if (!(await loginAllowed(store, email))) {
      const st = await requestAccess(email);
      return st === 'pending'
        ? fail(reply, 403, 'access_pending', '已提交加入申请，等管理员批准后即可登录')
        : fail(reply, 403, 'forbidden', 'email not allowed');
    }
    const u = await store.users.upsertDev(email.trim().toLowerCase());
    if (u.disabledAt) return fail(reply, 403, 'forbidden', 'account disabled');
    return { token: await issueToken(u.id), user: toUser(u) };
  });

  const googleRedirectUri = () => `${config.publicUrl}/api/auth/google/callback`;
  app.get('/api/auth/google/start', async (req, reply) => {
    if (!config.googleClientId || !config.googleClientSecret) return fail(reply, 404, 'not_found', 'google login not configured');
    const redirect = (req.query as { redirect?: string }).redirect ?? '';
    if (!isAllowedRedirect(redirect, config.publicUrl, config.redirectAllowlist)) return fail(reply, 400, 'bad_request', 'redirect not allowed');
    const state = signState(config.sessionSecret, { redirect, exp: Date.now() + STATE_TTL_MS });
    const q = new URLSearchParams({
      client_id: config.googleClientId, redirect_uri: googleRedirectUri(), response_type: 'code',
      scope: 'openid email', state, prompt: 'select_account',
    });
    return reply.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${q}`);
  });

  app.get('/api/auth/google/callback', async (req, reply) => {
    if (!config.googleClientId || !config.googleClientSecret) return fail(reply, 404, 'not_found', 'google login not configured');
    const { code, state } = req.query as { code?: string; state?: string };
    const st = state ? verifyState(config.sessionSecret, state, Date.now()) : null;
    if (!st || !code || !isAllowedRedirect(st.redirect, config.publicUrl, config.redirectAllowlist)) {
      return fail(reply, 400, 'bad_request', 'invalid oauth state');
    }
    const tokRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: config.googleClientId, client_secret: config.googleClientSecret,
        redirect_uri: googleRedirectUri(), grant_type: 'authorization_code',
      }),
    });
    if (!tokRes.ok) return fail(reply, 401, 'unauthorized', 'google token exchange failed');
    const { access_token } = (await tokRes.json()) as { access_token?: string };
    const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${access_token}` } });
    if (!infoRes.ok) return fail(reply, 401, 'unauthorized', 'google userinfo failed');
    const info = (await infoRes.json()) as { sub?: string; email?: string; email_verified?: unknown };
    if (!info.sub || !info.email) return fail(reply, 401, 'unauthorized', 'google account missing email');
    // Login allowlist: unverified emails are never trusted, even when listed (and never recorded as requests).
    if (info.email_verified !== true) return reply.redirect(`${st.redirect}#error=not_allowed`);
    if (!(await loginAllowed(store, info.email))) {
      const req = await requestAccess(info.email);
      return reply.redirect(`${st.redirect}#error=${req === 'pending' ? 'access_pending' : 'not_allowed'}`);
    }
    const u = await store.users.upsertGoogle(info.sub, info.email);
    if (u.disabledAt) return reply.redirect(`${st.redirect}#error=not_allowed`);
    const token = await issueToken(u.id);
    return reply.redirect(`${st.redirect}#token=${encodeURIComponent(token)}`);
  });

  // ---------- authenticated control plane ----------
  app.get('/api/me', async (req, reply) => {
    const u = await authUser(req);
    if (!u) return fail(reply, 401, 'unauthorized', 'login required');
    const enabled = (await store.allowlist.count()) > 0;
    const role = enabled ? (await store.allowlist.get(normalizeEmail(u.email)))?.role ?? null : null;
    const out: MeResult = { user: toUser(u), role, allowlistEnabled: enabled };
    return out;
  });
  app.post('/api/auth/logout', async (req) => {
    const tok = bearer(req);
    if (tok) await store.tokens.delete(hashToken(tok));
    return { ok: true };
  });

  app.post('/api/clients', async (req, reply) => {
    const u = await authUser(req);
    if (!u) return fail(reply, 401, 'unauthorized', 'login required');
    const b = (req.body ?? {}) as { clientPub?: unknown; label?: unknown };
    if (typeof b.clientPub !== 'string') return fail(reply, 400, 'bad_request', 'clientPub required');
    try { if (fromB64url(b.clientPub).length !== 32) throw new Error(); } catch { return fail(reply, 400, 'bad_request', 'clientPub must be raw32 b64url'); }
    const label = typeof b.label === 'string' ? b.label.slice(0, 200) : '';
    const c = await store.clients.upsert(u.id, b.clientPub, label, hub.signClient(u.id, b.clientPub));
    await pushAuthzForUser(u.id);
    return reply.code(201).send({ client: { clientPub: c.clientPub, label: c.label, createdAt: c.createdAt } });
  });
  app.get('/api/clients', async (req, reply) => {
    const u = await authUser(req);
    if (!u) return fail(reply, 401, 'unauthorized', 'login required');
    const clients = (await store.clients.list(u.id)).map((c) => ({ clientPub: c.clientPub, label: c.label, createdAt: c.createdAt }));
    return { clients };
  });
  app.delete('/api/clients/:clientPub', async (req, reply) => {
    const u = await authUser(req);
    if (!u) return fail(reply, 401, 'unauthorized', 'login required');
    const ok = await store.clients.delete(u.id, (req.params as { clientPub: string }).clientPub);
    if (!ok) return fail(reply, 404, 'not_found', 'client not found');
    await pushAuthzForUser(u.id);
    return { ok: true };
  });

  app.get('/api/machines', async (req, reply) => {
    const u = await authUser(req);
    if (!u) return fail(reply, 401, 'unauthorized', 'login required');
    const machines = (await store.workers.listByUser(u.id)).map((w) => toMachine(w, hub));
    return { machines };
  });
  app.post('/api/machines/claim', async (req, reply) => {
    const u = await authUser(req);
    if (!u) return fail(reply, 401, 'unauthorized', 'login required');
    const b = (req.body ?? {}) as { workerId?: unknown; claimToken?: unknown; label?: unknown };
    if (typeof b.workerId !== 'string' || typeof b.claimToken !== 'string') return fail(reply, 400, 'bad_request', 'workerId and claimToken required');
    const label = typeof b.label === 'string' && b.label.trim() ? b.label.trim().slice(0, 200) : undefined;
    const w = await store.workers.claim(b.workerId, sha256Hex(b.claimToken), u.id, label, Date.now());
    if (!w) return fail(reply, 400, 'bad_request', 'invalid, expired or already-used claim token');
    await hub.pushAuthz(w.workerId);
    const machine = toMachine(w, hub);
    events.emit(u.id, { type: 'machine.updated', machine });
    return { machine };
  });
  async function ownedWorker(req: FastifyRequest, reply: FastifyReply): Promise<{ u: UserRow; w: WorkerRow } | null> {
    const u = await authUser(req);
    if (!u) { fail(reply, 401, 'unauthorized', 'login required'); return null; }
    const w = await store.workers.get((req.params as { workerId: string }).workerId);
    if (!w) { fail(reply, 404, 'not_found', 'machine not found'); return null; }
    if (w.userId !== u.id) { fail(reply, 403, 'forbidden', 'machine belongs to another account'); return null; }
    return { u, w };
  }
  app.patch('/api/machines/:workerId', async (req, reply) => {
    const o = await ownedWorker(req, reply);
    if (!o) return reply;
    const label = (req.body as { label?: unknown } | null)?.label;
    if (typeof label !== 'string' || !label.trim()) return fail(reply, 400, 'bad_request', 'label required');
    await store.workers.update(o.w.workerId, { label: label.trim().slice(0, 200) });
    const machine = toMachine((await store.workers.get(o.w.workerId))!, hub);
    events.emit(o.u.id, { type: 'machine.updated', machine });
    return { machine };
  });
  app.post('/api/machines/:workerId/update', async (req, reply) => {
    const o = await ownedWorker(req, reply);
    if (!o) return reply;
    const u = hub.machineUpdate(o.w.workerId);
    if (!u) return fail(reply, 409, 'conflict', 'machine is offline');
    if (!u.self) return fail(reply, 409, 'conflict', 'this worker cannot update itself (not a one-line install running as a service, or NOPEAR_AUTO_UPDATE=0); run the update command on that machine');
    if (u.state === 'downloading' || u.state === 'waiting' || u.state === 'restarting') return { machine: toMachine(o.w, hub) };
    if (!hub.requestUpdate(o.w.workerId)) return fail(reply, 409, 'conflict', 'machine is offline');
    return { machine: toMachine(o.w, hub) };
  });
  app.delete('/api/machines/:workerId', async (req, reply) => {
    const o = await ownedWorker(req, reply);
    if (!o) return reply;
    await store.workers.unclaim(o.w.workerId);
    await hub.pushAuthz(o.w.workerId);
    // its queued/running/review cards → inbox; its index entries and project paths are dropped.
    // The unclaim is already committed, so a failing cascade must not swallow machine.removed.
    try {
      await collab.onMachineRemoved(o.u.id, o.w.workerId);
    } catch (err) {
      req.log.error({ err, workerId: o.w.workerId }, 'unbind cascade failed');
    }
    events.emit(o.u.id, { type: 'machine.removed', workerId: o.w.workerId });
    return { ok: true };
  });

  // ---------- collaboration hub (plaintext, saasToken only — API tokens are /mcp-only) ----------
  type Body = Record<string, unknown>;
  const bodyOf = (req: FastifyRequest): Body => {
    const b = req.body;
    return typeof b === 'object' && b !== null && !Array.isArray(b) ? b as Body : {};
  };
  /** Query values must be single strings (a repeated key arrives as an array) → else `bad_request`. */
  const queryOf = (req: FastifyRequest): Record<string, string | undefined> => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(q)) {
      if (v !== undefined && typeof v !== 'string') throw new CollabError('bad_request', `query parameter ${k} must be a single string`);
    }
    return q as Record<string, string | undefined>;
  };
  const idParam = (req: FastifyRequest) => (req.params as { id: string }).id;
  /** Copy only the keys present in `b` (so absent fields stay `undefined`, not overwritten). */
  const pick = <K extends string>(b: Body, keys: readonly K[]): Partial<Record<K, unknown>> => {
    const out: Partial<Record<K, unknown>> = {};
    for (const k of keys) if (k in b) out[k] = b[k];
    return out;
  };
  /** Authenticated collab handler; `CollabError` → its spec HTTP status. */
  const api = (fn: (u: UserRow, req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      const u = await authUser(req);
      if (!u) return fail(reply, 401, 'unauthorized', 'login required');
      try {
        return await fn(u, req, reply);
      } catch (e) {
        if (e instanceof CollabError) return fail(reply, TOOL_HTTP_STATUS[e.code], e.code, e.message);
        throw e;
      }
    };

  app.get('/api/settings', api(async (u) => ({ settings: await collab.getSettings(u.id) })));
  app.patch('/api/settings', api(async (u, req) => {
    const b = pick(bodyOf(req), ['e2e', 'autoCompact'] as const);
    return { settings: await collab.setSettings(u.id, b as Parameters<Collab['setSettings']>[1]) };
  }));

  app.get('/api/projects', api(async (u) => ({ projects: await collab.listProjects(u.id) })));
  app.post('/api/projects', api(async (u, req) => {
    const b = pick(bodyOf(req), ['name', 'description', 'paths'] as const);
    return { project: await collab.createProject(u.id, b as Parameters<Collab['createProject']>[1]) };
  }));
  app.get('/api/projects/:id', api(async (u, req) => ({ project: await collab.getProject(u.id, idParam(req)) })));
  app.patch('/api/projects/:id', api(async (u, req) => {
    const b = pick(bodyOf(req), ['name', 'description', 'paths'] as const);
    return { project: await collab.updateProject(u.id, idParam(req), b as Parameters<Collab['updateProject']>[2]) };
  }));
  app.delete('/api/projects/:id', api(async (u, req) => {
    await collab.deleteProject(u.id, idParam(req));
    return { ok: true };
  }));

  app.get('/api/cards', api(async (u, req) => {
    const q = queryOf(req);
    return { cards: await collab.listCards(u.id, { projectId: q.projectId, state: q.state as CardState | undefined, workerId: q.workerId }) };
  }));
  app.post('/api/cards', api(async (u, req) => {
    const b = pick(bodyOf(req), ['title', 'body', 'projectId'] as const);
    return { card: await collab.createCard(u.id, b as Parameters<Collab['createCard']>[1]) };
  }));
  app.patch('/api/cards/:id', api(async (u, req) => {
    const patch = pick(bodyOf(req), ['title', 'body', 'projectId', 'state', 'workerId', 'order'] as const) as CardPatch;
    return { card: await collab.patchCard(u.id, idParam(req), patch) };
  }));
  app.delete('/api/cards/:id', api(async (u, req) => {
    await collab.deleteCard(u.id, idParam(req));
    return { ok: true };
  }));

  app.get('/api/memory', api(async (u, req) => {
    const q = queryOf(req);
    return { memory: await collab.getMemory(u.id, q.scope as MemoryScope, q.projectId || null) };
  }));
  app.put('/api/memory', api(async (u, req) => {
    const b = bodyOf(req);
    const projectId = typeof b.projectId === 'string' && b.projectId ? b.projectId : null;
    return { memory: await collab.putMemory(u.id, b.scope as MemoryScope, projectId, b.content as string) };
  }));

  app.get('/api/sessions', api(async (u, req) => {
    const q = queryOf(req);
    const limit = q.limit === undefined || q.limit === '' ? undefined : Number(q.limit);
    return { sessions: await collab.querySessions(u.id, { projectId: q.projectId, workerId: q.workerId, q: q.q, limit }) };
  }));

  app.post('/api/tokens', api(async (u, req, reply) => {
    const label = bodyOf(req).label;
    if (typeof label !== 'string') return fail(reply, 400, 'bad_request', 'label required');
    const token = `fmcp_${randomId(24)}`;
    await store.apiTokens.create(u.id, label.trim().slice(0, 200), hashToken(token));
    return { token };
  }));
  app.get('/api/tokens', api(async (u) => ({
    tokens: (await store.apiTokens.list(u.id)).map((t) => ({ id: t.id, label: t.label, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt })),
  })));
  app.delete('/api/tokens/:id', api(async (u, req, reply) => {
    if (!(await store.apiTokens.delete(u.id, idParam(req)))) return fail(reply, 404, 'not_found', 'token not found');
    return { ok: true };
  }));

  app.post('/api/machines/install-code', api(async (u, req): Promise<InstallCodeResult> => {
    const raw = bodyOf(req).label;
    const label = typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 200) : null;
    const code = randomId(18);
    const expiresAt = Date.now() + INSTALL_CODE_TTL_MS;
    await store.installCodes.create(u.id, sha256Hex(code), label, expiresAt);
    const origin = (config.publicUrlExplicit ? config.publicUrl : requestBaseUrl(req.protocol, req.headers)).replace(/\/+$/, '');
    return { code, command: `curl -fsSL ${shq(`${origin}/install.sh?code=${code}`)} | bash`, expiresAt: new Date(expiresAt).toISOString() };
  }));

  app.post('/api/tools/:name', api(async (u, req, reply) => {
    const out = await executeTool(collab, { userId: u.id, workerId: null }, (req.params as { name: string }).name, bodyOf(req).args ?? {});
    if (out.ok) return { result: out.result };
    return fail(reply, TOOL_HTTP_STATUS[out.error.code], out.error.code, out.error.message);
  }));

  // ---------- login allowlist admin ----------
  /** Allowlist enabled → caller must be admin (else 403). Returns whether the list is enabled. */
  async function adminGate(u: UserRow): Promise<boolean> {
    if ((await store.allowlist.count()) === 0) return false;
    const me = await store.allowlist.get(normalizeEmail(u.email));
    if (me?.role !== 'admin') throw new CollabError('forbidden', 'admin only');
    return true;
  }
  const emailParam = (req: FastifyRequest) => normalizeEmail((req.params as { email: string }).email);
  app.get('/api/admin/allowlist', api(async (u) => {
    if (!(await adminGate(u))) return { entries: [] };
    return { entries: (await store.allowlist.list()).map(toEntry) };
  }));
  app.put('/api/admin/allowlist/:email', api(async (u, req, reply) => {
    const email = emailParam(req);
    const role = bodyOf(req).role;
    if (!(await adminGate(u)) && !(email === normalizeEmail(u.email) && role === 'admin')) {
      return fail(reply, 400, 'bad_request', '启用白名单必须先把自己设为管理员');
    }
    if (!isValidEmail(email)) return fail(reply, 400, 'bad_request', 'invalid email');
    if (!isRole(role)) return fail(reply, 400, 'bad_request', "role must be 'admin' or 'member'");
    const r = await store.allowlist.put(email, role, normalizeEmail(u.email));
    if (r === 'last_admin') return fail(reply, 409, 'conflict', '至少保留一名管理员');
    return { entry: toEntry(r) };
  }));
  app.delete('/api/admin/allowlist/:email', api(async (u, req, reply) => {
    if (!(await adminGate(u))) return fail(reply, 404, 'not_found', 'allowlist is empty');
    const email = emailParam(req);
    if (!isValidEmail(email)) return fail(reply, 400, 'bad_request', 'invalid email');
    const r = await store.allowlist.delete(email);
    if (r === 'last_admin') return fail(reply, 409, 'conflict', '至少保留一名管理员');
    if (r === 'not_found') return fail(reply, 404, 'not_found', 'not in allowlist');
    return { ok: true };
  }));

  // ---------- admin console (allowlist admins only) ----------
  /** Admin console endpoints need an enabled allowlist (open mode has no admins) and an admin caller. */
  const adminApi = (fn: (u: UserRow, req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    api(async (u, req, reply) => {
      if (!(await adminGate(u))) throw new CollabError('forbidden', 'admin console needs the login allowlist enabled');
      return fn(u, req, reply);
    });
  const DAY_MS = 86_400_000;

  app.get('/api/admin/overview', adminApi(async (): Promise<AdminOverview> => {
    const [users, workers, allowlist, requests, counts] = await Promise.all([
      store.users.list(), store.workers.listAll(), store.allowlist.list(), store.accessRequests.list(), store.admin.counts(),
    ]);
    const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
    const signups: AdminOverview['signups'] = [];
    for (let i = 29; i >= 0; i--) {
      const date = new Date(today - i * DAY_MS).toISOString().slice(0, 10);
      signups.push({ date, count: users.filter((x) => x.createdAt.slice(0, 10) === date).length });
    }
    const claimed = workers.filter((w) => w.userId);
    return {
      users: users.length, disabledUsers: users.filter((x) => x.disabledAt).length, allowlist: allowlist.length,
      pendingRequests: requests.filter((r) => r.status === 'pending').length,
      machines: claimed.length, machinesOnline: claimed.filter((w) => hub.isOnline(w.workerId)).length,
      sessions: counts.sessions, cards: counts.cards, signups,
    };
  }));

  app.get('/api/admin/users', adminApi(async () => {
    const [users, workers, allowlist, counts] = await Promise.all([
      store.users.list(), store.workers.listAll(), store.allowlist.list(), store.admin.counts(),
    ]);
    const roles = new Map(allowlist.map((e) => [e.email, e.role]));
    const out: AdminUser[] = users.map((x) => {
      const mine = workers.filter((w) => w.userId === x.id);
      return {
        id: x.id, email: x.email, role: roles.get(normalizeEmail(x.email)) ?? null, createdAt: x.createdAt,
        lastSeenAt: x.lastSeenAt, disabled: !!x.disabledAt,
        machines: mine.length, machinesOnline: mine.filter((w) => hub.isOnline(w.workerId)).length,
        sessions: counts.sessionsByUser[x.id] ?? 0, apiTokens: counts.apiTokensByUser[x.id] ?? 0,
      };
    });
    return { users: out };
  }));

  app.patch('/api/admin/users/:id', adminApi(async (u, req, reply) => {
    const id = (req.params as { id: string }).id;
    const disabled = bodyOf(req).disabled;
    if (typeof disabled !== 'boolean') return fail(reply, 400, 'bad_request', 'disabled must be a boolean');
    if (disabled && id === u.id) return fail(reply, 400, 'bad_request', '不能禁用自己');
    const target = await store.users.get(id);
    if (!target) return fail(reply, 404, 'not_found', 'user not found');
    if (disabled && (await store.allowlist.get(normalizeEmail(target.email)))?.role === 'admin') {
      return fail(reply, 409, 'conflict', '不能禁用管理员，请先把他改成成员');
    }
    const row = (await store.users.setDisabled(id, disabled))!;
    if (disabled) {
      // Take effect now, not at the next request: sign out, end live streams, drop and refuse their machines.
      await store.tokens.deleteByUser(id);
      events.closeUser(id);
      for (const w of await store.workers.listByUser(id)) hub.disconnect(w.workerId);
    }
    return { user: { id: row.id, email: row.email, disabled: !!row.disabledAt } };
  }));

  app.get('/api/admin/requests', adminApi(async () => ({ requests: await store.accessRequests.list() })));

  app.post('/api/admin/requests/:email/approve', adminApi(async (u, req, reply) => {
    const email = emailParam(req);
    const role = bodyOf(req).role ?? 'member';
    if (!isRole(role)) return fail(reply, 400, 'bad_request', "role must be 'admin' or 'member'");
    if (!(await store.accessRequests.get(email))) return fail(reply, 404, 'not_found', 'no such request');
    const r = await store.allowlist.put(email, role, normalizeEmail(u.email));
    if (r === 'last_admin') return fail(reply, 409, 'conflict', '至少保留一名管理员');
    await store.accessRequests.delete(email);
    return { entry: toEntry(r) };
  }));

  app.post('/api/admin/requests/:email/reject', adminApi(async (_u, req, reply) => {
    const r = await store.accessRequests.setStatus(emailParam(req), 'rejected');
    if (!r) return fail(reply, 404, 'not_found', 'no such request');
    return { request: r };
  }));

  app.delete('/api/admin/requests/:email', adminApi(async (_u, req, reply) => {
    if (!(await store.accessRequests.delete(emailParam(req)))) return fail(reply, 404, 'not_found', 'no such request');
    return { ok: true };
  }));

  app.get('/api/admin/machines', adminApi(async () => {
    const [workers, users] = await Promise.all([store.workers.listAll(), store.users.list()]);
    const emails = new Map(users.map((x) => [x.id, x.email]));
    const machines: AdminMachine[] = workers.map((w) => ({
      workerId: w.workerId, label: w.label, ownerId: w.userId, ownerEmail: w.userId ? emails.get(w.userId) ?? null : null,
      version: w.version, online: hub.isOnline(w.workerId), lastSeenAt: w.lastSeenAt, createdAt: w.createdAt,
    }));
    return { machines };
  }));

  /** Claimed machine → force-unbind (same cascade as the owner's own unbind); unclaimed → delete the record. */
  app.delete('/api/admin/machines/:workerId', adminApi(async (_u, req, reply) => {
    const workerId = (req.params as { workerId: string }).workerId;
    const w = await store.workers.get(workerId);
    if (!w) return fail(reply, 404, 'not_found', 'machine not found');
    if (!w.userId) {
      hub.disconnect(workerId);
      await store.workers.delete(workerId);
      return { ok: true, deleted: true };
    }
    await store.workers.unclaim(workerId);
    await hub.pushAuthz(workerId);
    try {
      await collab.onMachineRemoved(w.userId, workerId);
    } catch (err) {
      req.log.error({ err, workerId }, 'admin unbind cascade failed');
    }
    events.emit(w.userId, { type: 'machine.removed', workerId });
    return { ok: true, deleted: false };
  }));

  app.get('/api/events', async (req, reply) => {
    const u = await authUser(req);
    if (!u) return fail(reply, 401, 'unauthorized', 'login required');
    reply.hijack();
    const raw = reply.raw;
    // Register the close listener before any await so an early disconnect is never missed.
    // (reply.raw 'close' = the client connection went away; req.raw 'close' fires once the body is read.)
    let closed = false;
    let unsub: (() => void) | null = null;
    let untrack: (() => void) | null = null;
    const stop = () => { closed = true; clearInterval(ping); unsub?.(); unsub = null; untrack?.(); untrack = null; };
    // Over the buffer cap → drop the stream; the client reconnects and gets a fresh `machines` snapshot.
    const push = (chunk: string) => { if (!closed && !sseWrite(raw, chunk)) { stop(); raw.destroy(); } };
    const ping = setInterval(() => push(': ping\n\n'), SSE_PING_MS);
    raw.on('close', stop);
    untrack = events.track(() => { if (!closed) { stop(); raw.end(); } }, u.id);
    raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const send = (e: SaasEvent) => push(`data: ${JSON.stringify(e)}\n\n`);
    const machines = (await store.workers.listByUser(u.id)).map((w) => toMachine(w, hub));
    if (closed || raw.destroyed) { stop(); return; }
    send({ type: 'machines', machines });
    unsub = events.subscribe(u.id, send);
  });

  // ---------- data plane (opaque ciphertext) ----------
  async function dataPlane(
    req: FastifyRequest, reply: FastifyReply,
  ): Promise<{ workerId: string; clientPub: string; payload: string; plain: boolean } | null> {
    const u = await authUser(req);
    if (!u) { fail(reply, 401, 'unauthorized', 'login required'); return null; }
    const clientPub = req.headers[HEADER_CLIENT];
    if (typeof clientPub !== 'string' || !(await store.clients.list(u.id)).some((c) => c.clientPub === clientPub)) {
      fail(reply, 403, 'forbidden', 'client not registered for this account'); return null;
    }
    const workerId = (req.params as { workerId: string }).workerId;
    const w = await store.workers.get(workerId);
    if (!w) { fail(reply, 404, 'not_found', 'machine not found'); return null; }
    if (w.userId !== u.id) { fail(reply, 403, 'forbidden', 'machine belongs to another account'); return null; }
    // plaintext frames (E2E off) are marked `x-nopear-plain`; refused while the account has E2E on.
    const plain = req.headers[HEADER_PLAIN] === '1';
    if (plain && (await store.settings.get(u.id)).e2e) {
      fail(reply, 409, 'e2e_enabled', 'E2E is enabled for this account; plaintext requests are refused'); return null;
    }
    // Online check first: an offline machine's stored version may be stale, and the plaintext-disabled 400 below
    // makes the client stick to sealed for that channel — offline must stay a plain 503.
    if (!hub.isOnline(workerId)) { fail(reply, 503, 'offline', 'machine offline'); return null; }
    // A pre-3.1 worker cannot read plaintext frames: answer exactly like a worker that refuses plaintext, so the
    // client falls back to sealed instead of looping on the worker's 401. An unknown/empty version counts as old.
    if (plain && !workerAcceptsPlaintext(w.version)) { fail(reply, 400, 'bad_request', PLAINTEXT_DISABLED_MESSAGE); return null; }
    const body = req.body;
    if (!(body instanceof Buffer) || body.length === 0) { fail(reply, 400, 'bad_request', 'request body required'); return null; }
    return { workerId, clientPub, payload: body.toString('base64url'), plain };
  }

  app.post('/api/w/:workerId/rpc', async (req, reply) => {
    const dp = await dataPlane(req, reply);
    if (!dp) return reply;
    // Client went away before the worker answered → drop the pending entry (late rpc.res is ignored).
    const ac = new AbortController();
    const onClose = () => { if (!reply.raw.writableEnded) ac.abort(); };
    reply.raw.once('close', onClose);
    // The op is end-to-end encrypted, so SaaS uses one flat (longest) timeout; clients enforce 60s/300s per op.
    const out = await hub.rpc(dp.workerId, dp.clientPub, dp.payload, BINARY_RPC_TIMEOUT_MS, ac.signal, dp.plain);
    reply.raw.off('close', onClose);
    if (ac.signal.aborted || reply.raw.destroyed) return reply;
    if ('status' in out) return fail(reply, out.status, out.code, out.message);
    return reply.code(200).header('content-type', 'application/octet-stream').send(Buffer.from(out.payload, 'base64url'));
  });

  app.post('/api/w/:workerId/watch', async (req, reply) => {
    const dp = await dataPlane(req, reply);
    if (!dp) return reply;
    reply.hijack();
    const raw = reply.raw;
    let done = false;
    let cancel: () => void = () => {};
    const ping = setInterval(() => { if (!done) sseWrite(raw, ': ping\n\n'); }, SSE_PING_MS);
    // Listener first, so a disconnect racing with setup still cancels the worker-side watch.
    raw.on('close', () => {
      if (!done) { done = true; clearInterval(ping); cancel(); }
    });
    const finish = (chunk: string) => {
      if (done) return;
      done = true;
      clearInterval(ping);
      raw.end(chunk);
    };
    raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    raw.flushHeaders?.();
    if (raw.destroyed) { done = true; clearInterval(ping); return; }
    cancel = hub.watch(dp.workerId, dp.clientPub, dp.payload, {
      data: (p) => {
        if (done) return;
        // Slow/stalled reader: never buffer unboundedly — drop the stream; the client reconnects with its cursor.
        if (!sseWrite(raw, `data: ${p}\n\n`)) { done = true; clearInterval(ping); cancel(); raw.destroy(); }
      },
      end: (code) => finish(code ? `event: end\ndata: ${code}\n\n` : 'event: end\ndata: \n\n'),
      offline: () => finish('event: offline\ndata: \n\n'),
    }, dp.plain);
  });

  // ---------- worker bootstrap ----------
  app.post('/worker/register', async (req, reply) => {
    const b = (req.body ?? {}) as { workerId?: unknown; workerPub?: unknown; secretHash?: unknown; installCode?: unknown };
    const badCode = () => fail(reply, 400, 'bad_request', 'invalid, expired or already-used install code');
    // a currently-valid install code (exists, unexpired, unused or used by this same worker) stands in for the
    // bootstrap token. Validity is decided inside the store transaction below, so an invalid code registers nothing.
    const hasCode = b.installCode !== undefined;
    if (hasCode && (typeof b.installCode !== 'string' || !b.installCode)) return badCode();
    if (!hasCode && config.bootstrapToken && !safeEq(bearer(req) ?? '', config.bootstrapToken)) return fail(reply, 401, 'unauthorized', 'bootstrap token required');
    if (typeof b.workerId !== 'string' || !/^w_[a-z0-9]{4,64}$/.test(b.workerId)
      || typeof b.workerPub !== 'string' || typeof b.secretHash !== 'string' || !/^[0-9a-f]{64}$/.test(b.secretHash)) {
      return fail(reply, 400, 'bad_request', 'workerId, workerPub, secretHash required');
    }
    try { if (fromB64url(b.workerPub).length !== 32) throw new Error(); } catch { return fail(reply, 400, 'bad_request', 'workerPub must be raw32 b64url'); }
    if (!hasCode) {
      const r = await store.workers.register(b.workerId, b.workerPub, b.secretHash);
      if (r === 'exists') return fail(reply, 409, 'conflict', 'workerId already registered with a different identity');
      return { platformPub: d.signingPub };
    }
    // One transaction: check code → register → mark used → claim (all or nothing).
    const workerId = b.workerId;
    const r = await store.workers.registerWithInstallCode(workerId, b.workerPub, b.secretHash, sha256Hex(b.installCode as string), Date.now());
    if (r.status === 'invalid_code') return badCode();
    if (r.status === 'exists') return fail(reply, 409, 'conflict', 'workerId already registered with a different identity');
    if (r.status === 'owned_elsewhere') return fail(reply, 409, 'conflict', 'machine belongs to another account');
    await hub.pushAuthz(workerId);
    events.emit(r.code.userId, { type: 'machine.updated', machine: toMachine(r.worker, hub) });
    return { platformPub: d.signingPub };
  });
}
