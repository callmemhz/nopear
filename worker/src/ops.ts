// The worker's RPC + watch handler tables: a pure dispatch table over SessionHost,
// files, memory and blobs. The Gateway decrypts/authorizes and calls into these.

import type { MachineEvent, Session } from '@nopear/protocol';
import type { WorkerConfig } from './config';
import { OpError } from './errors';
import type { OpHandlers, WatchHandlers } from './gateway';
import type { SessionHost } from './agent/host';
import type { BlobStore } from './agent/blobs';
import { listDir, listDirs, readFileForDownload } from './files';
import { readMemory, writeMemory } from './memory';

export interface OpsDeps {
  config: WorkerConfig;
  host: SessionHost;
  blobs: BlobStore;
}

const MACHINE_KINDS = new Set<Session['kind']>(['chat']);

export function createOps(deps: OpsDeps): { ops: OpHandlers; watches: WatchHandlers } {
  const { config, host, blobs } = deps;

  const ops: OpHandlers = {
    'worker.info': async () => host.workerInfo(),

    'sessions.list': async (a) => ({ sessions: host.list(a ?? {}) }),
    'sessions.get': async (a) => ({ session: host.get(a.sessionId) }),
    'sessions.create': async (a) => ({ session: await host.create(a) }),
    'sessions.update': async (a) => ({ session: await host.update(a) }),
    'sessions.interrupt': async (a) => { await host.interrupt(a.sessionId); return {}; },
    'sessions.rewind': async (a) => ({ undoneText: await host.rewind(a.sessionId, a.messageId) }),
    'sessions.fork': async (a) => ({ session: await host.fork(a.sessionId, a.messageId) }),

    'messages.page': async (a) => host.page(a),
    'messages.send': async (a) => host.send(a),
    'messages.queue.remove': async (a) => { await host.queueRemove(a); return {}; },
    'messages.queue.update': async (a) => { await host.queueUpdate(a); return {}; },
    'prompts.answer': async (a) => { await host.answerPrompt(a); return {}; },
    'tasks.stop': async (a) => { await host.stopTask(a.sessionId, a.taskId); return {}; },
    'tasks.transcript': async (a) => host.taskTranscript(a),

    'files.list': async (a) => listDir(host.get(a.sessionId).cwd, a.path),
    'files.read': async (a) => {
      if (typeof a.path !== 'string' || !a.path) throw new OpError('bad_request', 'path is required');
      return readFileForDownload(host.get(a.sessionId).cwd, a.path);
    },
    'dirs.list': async (a) => {
      if (a?.path !== undefined && typeof a.path !== 'string') throw new OpError('bad_request', 'path must be a string');
      return listDirs(config.defaultCwd, a?.path, a?.showHidden === true);
    },
    'blobs.get': async (a) => {
      const b = await blobs.get(String(a.hash ?? ''));
      if (!b) throw new OpError('not_found', `blob ${a.hash} not found`);
      return b;
    },

    'memory.get': async () => ({ files: await readMemory(config) }),
    'memory.put': async (a) => {
      if (a.scope !== 'global' && a.scope !== 'project') throw new OpError('bad_request', 'scope must be global|project');
      if (typeof a.content !== 'string') throw new OpError('bad_request', 'content must be a string');
      return { file: await writeMemory(config, a.scope, a.content) };
    },
  };

  const watches: WatchHandlers = {
    'session.watch': async (a, emit, signal) => host.watch(a.sessionId, a.cursor, emit, signal),

    'machine.watch': async (_a, emit, signal) => {
      if (signal.aborted) return;
      // Subscribe first and buffer until the snapshot is out, so no change between the snapshot read and
      // the subscription is lost (later events are idempotent upserts on the client).
      let buffer: MachineEvent[] | null = [];
      const send = (e: MachineEvent) => { if (buffer) buffer.push(e); else emit(e); };
      const offHost = host.onSessionChange((s, removed) => {
        if (!MACHINE_KINDS.has(s.kind)) return;
        send(removed ? { type: 'session.removed', sessionId: s.id } : { type: 'session.updated', session: s });
      });
      try {
        const worker = await host.workerInfo();
        emit({ type: 'snapshot', worker, sessions: host.list({ kinds: ['chat'] }) });
        const pending = buffer;
        buffer = null;
        for (const e of pending) emit(e);
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      } finally {
        offHost();
      }
    },
  };

  return { ops, watches };
}
