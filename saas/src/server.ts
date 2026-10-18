import Fastify, { type FastifyInstance } from 'fastify';
import { WebSocketServer } from 'ws';
import { hashToken, safeEq } from './auth';
import { sha256Hex, signingPublicKey } from '@nopear/core/crypto';
import { HEADER_WORKER, TUNNEL_MAX_FRAME_BYTES } from '@nopear/protocol';
import { resolve } from 'node:path';
import { accountUsable } from './allowlist';
import { Collab } from './collab';
import type { SaasConfigEnv } from './config';
import { WorkerHub } from './hub';
import { registerInstall } from './install';
import { registerMcp } from './mcp';
import { EventsBus, registerRoutes, toMachine } from './routes';
import { registerStatic } from './static';
import type { SaasStore } from './store';
import { executeTool } from './tools';


const HUBS = new WeakMap<FastifyInstance, WorkerHub>();
/** The WorkerHub behind a built server (observability / tests). */
export function hubOf(app: FastifyInstance): WorkerHub {
  const h = HUBS.get(app);
  if (!h) throw new Error('not a nopear saas server');
  return h;
}

export async function buildServer(opts: { config: SaasConfigEnv; store: SaasStore }): Promise<FastifyInstance> {
  const { config, store } = opts;
  // Login allowlist bootstrap: only when the list is empty (atomic in the store).
  if (config.bootstrapAdmin) await store.allowlist.bootstrap(config.bootstrapAdmin);
  const app = Fastify({ bodyLimit: config.bodyLimitBytes, logger: false });
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: config.bodyLimitBytes }, (_req, body, done) => done(null, body));

  const events = new EventsBus();
  const hub = new WorkerHub({
    store,
    signingSeed: config.signingSeed,
    onPresence: (workerId) => {
      void (async () => {
        const w = await store.workers.get(workerId);
        if (w?.userId) events.emit(w.userId, { type: 'machine.updated', machine: toMachine(w, hub.isOnline(workerId)) });
      })();
    },
  });
  // Collab needs the hub and the hub dispatches tunnel frames to collab: wire the cycle after both exist.
  const collab = new Collab({ store, hub, events });
  hub.setHandlers(collab);
  // every SaaS-layer error is plaintext {error:{code,message}}.
  app.setErrorHandler((err: { statusCode?: number; code?: string; message?: string }, _req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    const code = status === 413 ? 'too_large' : status === 415 ? 'unsupported_media_type'
      : status >= 500 ? 'internal' : status === 404 ? 'not_found' : 'bad_request';
    void reply.code(status).send({ error: { code, message: status >= 500 ? 'internal error' : (err.message || code) } });
  });
  registerRoutes(app, { config, store, hub, events, collab, signingPub: signingPublicKey(config.signingSeed) });
  // MCP + install routes must precede registerStatic (its not-found handler is the SPA fallback).
  registerMcp(app, {
    authenticate: async (token) => {
      const row = await store.apiTokens.get(hashToken(token));
      if (!row) return null;
      // Login allowlist and admin disable apply to personal API tokens too.
      const user = await store.users.get(row.userId);
      if (!user || !(await accountUsable(store, user))) return null;
      await store.apiTokens.touch(row.id);
      return row.userId;
    },
    executeTool: (caller, name, args) => executeTool(collab, caller, name, args),
  });
  registerInstall(app, {
    store,
    repoRoot: resolve(import.meta.dirname, '../..'),
    publicUrl: config.publicUrlExplicit ? config.publicUrl : null,
    workerTgz: config.workerTgz,
  });
  registerStatic(app, config.webDir);

  const wss = new WebSocketServer({ noServer: true, maxPayload: TUNNEL_MAX_FRAME_BYTES });
  app.server.on('upgrade', (req, socket, head) => {
    void (async () => {
      const path = (req.url ?? '').split('?')[0];
      const reject = (code: number, msg: string) => {
        socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        socket.destroy();
      };
      if (path !== '/worker/connect') return reject(404, 'Not Found');
      const auth = req.headers.authorization ?? '';
      const workerId = req.headers[HEADER_WORKER];
      const secret = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      if (typeof workerId !== 'string' || !secret) return reject(401, 'Unauthorized');
      const w = await store.workers.get(workerId);
      if (!w || !safeEq(sha256Hex(secret), w.secretHash)) return reject(401, 'Unauthorized');
      // A machine of a disabled account stays off the relay until the account is re-enabled.
      if (w.userId && (await store.users.get(w.userId))?.disabledAt) return reject(403, 'Forbidden');
      wss.handleUpgrade(req, socket, head, (ws) => hub.attach(workerId, ws));
    })().catch(() => socket.destroy());
  });

  // hub + SSE streams are torn down in registerRoutes' preClose hook; here only the tunnel sockets.
  app.addHook('preClose', async () => {
    for (const c of wss.clients) c.terminate();
    wss.close();
  });
  HUBS.set(app, hub);
  return app;
}
