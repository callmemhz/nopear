import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AccessRequest, AccessRequestStatus, AccountSettings, AllowlistRole, Card, CardState, MemoryDoc, MemoryScope, Project, SessionIndexEntry, SessionStatus } from '@nopear/protocol';
import { DEFAULT_AUTO_COMPACT, normalizeAutoCompact } from '@nopear/protocol';
import type { AllowlistRow, ApiTokenRow, ClientRow, InstallCodeRow, RegisterWithCodeResult, SaasStore, UserRow, WorkerRow } from './store';

type Row = Record<string, unknown>;
const now = (): string => new Date().toISOString();

const shortId = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

/** MIGRATIONS[v - 1] upgrades a database from user_version v-1 to v. v3 databases (no user_version) are at 0;
 *  migration 1 is the original v3 DDL (IF NOT EXISTS, so it is a no-op on them). Append only — never edit. */
const MIGRATIONS: string[] = [
  `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL, google_sub TEXT UNIQUE, dev_email TEXT UNIQUE, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS clients (
  user_id TEXT NOT NULL, client_pub TEXT NOT NULL, label TEXT NOT NULL, sig TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, client_pub));
CREATE TABLE IF NOT EXISTS workers (
  worker_id TEXT PRIMARY KEY, worker_pub TEXT NOT NULL, secret_hash TEXT NOT NULL, user_id TEXT, label TEXT NOT NULL DEFAULT '',
  claim_token_hash TEXT, claim_expires_at INTEGER, last_seen_at TEXT, version TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS workers_user ON workers(user_id);
`,
  `
CREATE TABLE projects (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  paths_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX projects_user ON projects(user_id);
CREATE TABLE cards (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL, worker_id TEXT, session_id TEXT, ord REAL NOT NULL, error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX cards_user ON cards(user_id);
CREATE INDEX cards_worker_state ON cards(worker_id, state);
CREATE TABLE memories (
  user_id TEXT NOT NULL, scope TEXT NOT NULL, project_id TEXT NOT NULL DEFAULT '', content TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, scope, project_id));
CREATE TABLE session_index (
  worker_id TEXT NOT NULL, session_id TEXT NOT NULL, user_id TEXT NOT NULL, title TEXT NOT NULL, preview TEXT NOT NULL,
  status TEXT NOT NULL, project_id TEXT, cwd TEXT NOT NULL, created_at TEXT NOT NULL, last_activity_at TEXT NOT NULL,
  PRIMARY KEY (worker_id, session_id));
CREATE INDEX session_index_user ON session_index(user_id, last_activity_at);
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, label TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL, last_used_at TEXT);
CREATE TABLE install_codes (
  code_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, label TEXT, expires_at INTEGER NOT NULL, used_by TEXT, created_at TEXT NOT NULL);
CREATE TABLE settings (
  user_id TEXT PRIMARY KEY, e2e INTEGER NOT NULL DEFAULT 0);
`,
  `
CREATE TABLE allowlist (email TEXT PRIMARY KEY, role TEXT NOT NULL, added_by TEXT NOT NULL, created_at TEXT NOT NULL);
`,
  // 4: account auto-compaction. Existing rows take the protocol defaults.
  `
ALTER TABLE settings ADD COLUMN auto_compact_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE settings ADD COLUMN auto_compact_threshold_tokens INTEGER NOT NULL DEFAULT 300000;
ALTER TABLE settings ADD COLUMN auto_compact_keep_recent_tokens INTEGER NOT NULL DEFAULT 20000;
`,
  // 5: admin console — disabled accounts, last activity, sign-in requests from outside the allowlist.
  `
ALTER TABLE users ADD COLUMN disabled_at TEXT;
ALTER TABLE users ADD COLUMN last_seen_at TEXT;
CREATE TABLE access_requests (
  email TEXT PRIMARY KEY, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 1,
  requested_at TEXT NOT NULL, updated_at TEXT NOT NULL);
`,
];
/** Target schema version = number of migrations applied. */
export const MIGRATIONS_COUNT = MIGRATIONS.length;

function user(r: Row): UserRow {
  return {
    id: String(r.id), email: String(r.email), googleSub: (r.google_sub as string | null) ?? null, createdAt: String(r.created_at),
    disabledAt: (r.disabled_at as string | null) ?? null, lastSeenAt: (r.last_seen_at as string | null) ?? null,
  };
}
function accessRequest(r: Row): AccessRequest {
  return {
    email: String(r.email), status: String(r.status) as AccessRequestStatus, attempts: Number(r.attempts),
    requestedAt: String(r.requested_at), updatedAt: String(r.updated_at),
  };
}
function client(r: Row): ClientRow {
  return { userId: String(r.user_id), clientPub: String(r.client_pub), label: String(r.label), sig: String(r.sig), createdAt: String(r.created_at) };
}
function worker(r: Row): WorkerRow {
  return {
    workerId: String(r.worker_id), workerPub: String(r.worker_pub), secretHash: String(r.secret_hash),
    userId: (r.user_id as string | null) ?? null, label: String(r.label ?? ''),
    claimTokenHash: (r.claim_token_hash as string | null) ?? null,
    claimExpiresAt: r.claim_expires_at == null ? null : Number(r.claim_expires_at),
    lastSeenAt: (r.last_seen_at as string | null) ?? null, version: String(r.version ?? ''), createdAt: String(r.created_at),
  };
}

function project(r: Row): Project {
  return {
    id: String(r.id), name: String(r.name), description: String(r.description ?? ''),
    paths: JSON.parse(String(r.paths_json ?? '{}')) as Record<string, string>,
    createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  };
}
function card(r: Row): Card {
  const c: Card = {
    id: String(r.id), projectId: (r.project_id as string | null) ?? null, title: String(r.title), body: String(r.body ?? ''),
    state: String(r.state) as CardState, workerId: (r.worker_id as string | null) ?? null,
    sessionId: (r.session_id as string | null) ?? null, order: Number(r.ord),
    createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  };
  if (r.error != null) c.error = String(r.error);
  return c;
}
function memory(r: Row): MemoryDoc {
  const scope = String(r.scope) as MemoryScope;
  return { scope, projectId: scope === 'global' ? null : String(r.project_id), content: String(r.content), updatedAt: String(r.updated_at) };
}
function indexEntry(r: Row): SessionIndexEntry {
  return {
    workerId: String(r.worker_id), sessionId: String(r.session_id), title: String(r.title), preview: String(r.preview),
    status: String(r.status) as SessionStatus, projectId: (r.project_id as string | null) ?? null, cwd: String(r.cwd),
    createdAt: String(r.created_at), lastActivityAt: String(r.last_activity_at),
  };
}
function apiToken(r: Row): ApiTokenRow {
  return {
    id: String(r.id), userId: String(r.user_id), label: String(r.label), tokenHash: String(r.token_hash),
    createdAt: String(r.created_at), lastUsedAt: (r.last_used_at as string | null) ?? null,
  };
}
function installCode(r: Row): InstallCodeRow {
  return {
    codeHash: String(r.code_hash), userId: String(r.user_id), label: (r.label as string | null) ?? null,
    expiresAt: Number(r.expires_at), usedBy: (r.used_by as string | null) ?? null, createdAt: String(r.created_at),
  };
}
function allowlistRow(r: Row): AllowlistRow {
  return { email: String(r.email), role: String(r.role) as AllowlistRole, addedBy: String(r.added_by), createdAt: String(r.created_at) };
}
const memoryProjectKey = (scope: MemoryScope, projectId: string | null): string => {
  if (scope === 'global') return '';
  if (!projectId) throw new Error("memory scope 'project' requires a non-empty projectId");
  return projectId;
};

export class SqliteSaasStore implements SaasStore {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.migrate();
  }
  private migrate(): void {
    const version = Number((this.one('PRAGMA user_version') ?? {}).user_version ?? 0);
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(MIGRATIONS[v]!);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    }
  }
  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
  private one(sql: string, ...args: (string | number | null)[]): Row | undefined {
    return this.db.prepare(sql).get(...args) as Row | undefined;
  }
  private all(sql: string, ...args: (string | number | null)[]): Row[] {
    return this.db.prepare(sql).all(...args) as Row[];
  }
  private run(sql: string, ...args: (string | number | null)[]): number {
    return Number(this.db.prepare(sql).run(...args).changes);
  }

  users = {
    upsertGoogle: async (sub: string, email: string): Promise<UserRow> => {
      const ex = this.one('SELECT * FROM users WHERE google_sub = ?', sub);
      if (ex) {
        this.run('UPDATE users SET email = ? WHERE id = ?', email, String(ex.id));
        return user({ ...ex, email });
      }
      const id = `u_${randomUUID()}`;
      this.run('INSERT INTO users (id, email, google_sub, created_at) VALUES (?, ?, ?, ?)', id, email, sub, now());
      return user(this.one('SELECT * FROM users WHERE id = ?', id)!);
    },
    upsertDev: async (email: string): Promise<UserRow> => {
      const ex = this.one('SELECT * FROM users WHERE dev_email = ?', email);
      if (ex) return user(ex);
      const id = `u_${randomUUID()}`;
      this.run('INSERT INTO users (id, email, dev_email, created_at) VALUES (?, ?, ?, ?)', id, email, email, now());
      return user(this.one('SELECT * FROM users WHERE id = ?', id)!);
    },
    get: async (id: string): Promise<UserRow | null> => {
      const r = this.one('SELECT * FROM users WHERE id = ?', id);
      return r ? user(r) : null;
    },
    list: async (): Promise<UserRow[]> => this.all('SELECT * FROM users ORDER BY created_at, rowid').map(user),
    setDisabled: async (id: string, disabled: boolean): Promise<UserRow | null> => {
      if (this.run('UPDATE users SET disabled_at = ? WHERE id = ?', disabled ? now() : null, id) === 0) return null;
      return user(this.one('SELECT * FROM users WHERE id = ?', id)!);
    },
    touch: async (id: string, at: string): Promise<void> => {
      this.run('UPDATE users SET last_seen_at = ? WHERE id = ?', at, id);
    },
  };

  tokens = {
    create: async (userId: string, tokenHash: string, expiresAt: number): Promise<void> => {
      this.run('INSERT INTO tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)', tokenHash, userId, expiresAt);
    },
    get: async (tokenHash: string): Promise<{ userId: string; expiresAt: number } | null> => {
      const r = this.one('SELECT * FROM tokens WHERE token_hash = ?', tokenHash);
      return r ? { userId: String(r.user_id), expiresAt: Number(r.expires_at) } : null;
    },
    delete: async (tokenHash: string): Promise<void> => {
      this.run('DELETE FROM tokens WHERE token_hash = ?', tokenHash);
    },
    deleteByUser: async (userId: string): Promise<void> => {
      this.run('DELETE FROM tokens WHERE user_id = ?', userId);
    },
  };

  clients = {
    upsert: async (userId: string, clientPub: string, label: string, sig: string): Promise<ClientRow> => {
      this.run(
        `INSERT INTO clients (user_id, client_pub, label, sig, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, client_pub) DO UPDATE SET label = excluded.label, sig = excluded.sig`,
        userId, clientPub, label, sig, now(),
      );
      return client(this.one('SELECT * FROM clients WHERE user_id = ? AND client_pub = ?', userId, clientPub)!);
    },
    list: async (userId: string): Promise<ClientRow[]> =>
      this.all('SELECT * FROM clients WHERE user_id = ? ORDER BY created_at', userId).map(client),
    delete: async (userId: string, clientPub: string): Promise<boolean> =>
      this.run('DELETE FROM clients WHERE user_id = ? AND client_pub = ?', userId, clientPub) > 0,
  };

  workers = {
    register: async (workerId: string, workerPub: string, secretHash: string): Promise<'ok' | 'exists'> => {
      const changes = this.run(
        'INSERT OR IGNORE INTO workers (worker_id, worker_pub, secret_hash, created_at) VALUES (?, ?, ?, ?)',
        workerId, workerPub, secretHash, now(),
      );
      if (changes > 0) return 'ok';
      // Idempotent re-register (e.g. the first response was lost): same identity → ok; mismatch → exists.
      const ex = this.one('SELECT worker_pub, secret_hash FROM workers WHERE worker_id = ?', workerId);
      return ex && ex.worker_pub === workerPub && ex.secret_hash === secretHash ? 'ok' : 'exists';
    },
    get: async (workerId: string): Promise<WorkerRow | null> => {
      const r = this.one('SELECT * FROM workers WHERE worker_id = ?', workerId);
      return r ? worker(r) : null;
    },
    setClaimTokenHash: async (workerId: string, hash: string, expiresAt: number): Promise<void> => {
      this.run('UPDATE workers SET claim_token_hash = ?, claim_expires_at = ? WHERE worker_id = ?', hash, expiresAt, workerId);
    },
    claim: async (workerId: string, tokenHash: string, userId: string, label: string | undefined, nowMs: number): Promise<WorkerRow | null> => {
      const changes = this.run(
        `UPDATE workers SET user_id = ?, label = COALESCE(?, label), claim_token_hash = NULL, claim_expires_at = NULL
         WHERE worker_id = ? AND user_id IS NULL AND claim_token_hash = ? AND claim_expires_at > ?`,
        userId, label ?? null, workerId, tokenHash, nowMs,
      );
      if (changes === 0) return null;
      return worker(this.one('SELECT * FROM workers WHERE worker_id = ?', workerId)!);
    },
    listByUser: async (userId: string): Promise<WorkerRow[]> =>
      this.all('SELECT * FROM workers WHERE user_id = ? ORDER BY created_at', userId).map(worker),
    listAll: async (): Promise<WorkerRow[]> => this.all('SELECT * FROM workers ORDER BY created_at, rowid').map(worker),
    delete: async (workerId: string): Promise<boolean> => this.run('DELETE FROM workers WHERE worker_id = ?', workerId) > 0,
    update: async (workerId: string, patch: { label?: string; lastSeenAt?: string; version?: string }): Promise<void> => {
      if (patch.label !== undefined) this.run('UPDATE workers SET label = ? WHERE worker_id = ?', patch.label, workerId);
      if (patch.lastSeenAt !== undefined) this.run('UPDATE workers SET last_seen_at = ? WHERE worker_id = ?', patch.lastSeenAt, workerId);
      if (patch.version !== undefined) this.run('UPDATE workers SET version = ? WHERE worker_id = ?', patch.version, workerId);
    },
    unclaim: async (workerId: string): Promise<void> => {
      this.run('UPDATE workers SET user_id = NULL, claim_token_hash = NULL, claim_expires_at = NULL WHERE worker_id = ?', workerId);
    },
    claimDirect: async (workerId: string, userId: string, label: string | null): Promise<WorkerRow | null> => {
      const changes = this.run(
        `UPDATE workers SET user_id = ?, label = COALESCE(?, label), claim_token_hash = NULL, claim_expires_at = NULL
         WHERE worker_id = ? AND (user_id IS NULL OR user_id = ?)`,
        userId, label, workerId, userId,
      );
      if (changes === 0) return null;
      return worker(this.one('SELECT * FROM workers WHERE worker_id = ?', workerId)!);
    },
    registerWithInstallCode: async (
      workerId: string, workerPub: string, secretHash: string, codeHash: string, nowMs: number,
    ): Promise<RegisterWithCodeResult> =>
      this.tx((): RegisterWithCodeResult => {
        const c = this.one('SELECT * FROM install_codes WHERE code_hash = ?', codeHash);
        const code = c ? installCode(c) : null;
        if (!code || code.expiresAt <= nowMs || (code.usedBy !== null && code.usedBy !== workerId)) return { status: 'invalid_code' };
        const ex = this.one('SELECT * FROM workers WHERE worker_id = ?', workerId);
        if (ex) {
          if (ex.worker_pub !== workerPub || ex.secret_hash !== secretHash) return { status: 'exists' };
          if (ex.user_id != null && ex.user_id !== code.userId) return { status: 'owned_elsewhere' };
        } else {
          this.run(
            'INSERT INTO workers (worker_id, worker_pub, secret_hash, created_at) VALUES (?, ?, ?, ?)',
            workerId, workerPub, secretHash, now(),
          );
        }
        this.run('UPDATE install_codes SET used_by = ? WHERE code_hash = ?', workerId, codeHash);
        this.run(
          `UPDATE workers SET user_id = ?, label = COALESCE(?, label), claim_token_hash = NULL, claim_expires_at = NULL
           WHERE worker_id = ?`,
          code.userId, code.label, workerId,
        );
        return {
          status: 'ok',
          worker: worker(this.one('SELECT * FROM workers WHERE worker_id = ?', workerId)!),
          code: { ...code, usedBy: workerId },
        };
      }),
  };

  projects = {
    list: async (userId: string): Promise<Project[]> =>
      this.all('SELECT * FROM projects WHERE user_id = ? ORDER BY created_at, rowid', userId).map(project),
    get: async (userId: string, id: string): Promise<Project | null> => {
      const r = this.one('SELECT * FROM projects WHERE user_id = ? AND id = ?', userId, id);
      return r ? project(r) : null;
    },
    create: async (userId: string, p: { name: string; description: string; paths: Record<string, string> }): Promise<Project> => {
      const id = shortId('p');
      const t = now();
      this.run(
        'INSERT INTO projects (id, user_id, name, description, paths_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id, userId, p.name, p.description, JSON.stringify(p.paths), t, t,
      );
      return project(this.one('SELECT * FROM projects WHERE id = ?', id)!);
    },
    update: async (
      userId: string, id: string, patch: { name?: string; description?: string; paths?: Record<string, string> },
    ): Promise<Project | null> => {
      const changes = this.run(
        `UPDATE projects SET name = COALESCE(?, name), description = COALESCE(?, description),
         paths_json = COALESCE(?, paths_json), updated_at = ? WHERE user_id = ? AND id = ?`,
        patch.name ?? null, patch.description ?? null, patch.paths === undefined ? null : JSON.stringify(patch.paths), now(), userId, id,
      );
      if (changes === 0) return null;
      return project(this.one('SELECT * FROM projects WHERE id = ?', id)!);
    },
    delete: async (userId: string, id: string): Promise<boolean> =>
      this.run('DELETE FROM projects WHERE user_id = ? AND id = ?', userId, id) > 0,
    removeWorkerPaths: async (userId: string, workerId: string): Promise<Project[]> =>
      this.tx(() => {
        const changed: Project[] = [];
        const t = now();
        for (const r of this.all('SELECT * FROM projects WHERE user_id = ? ORDER BY created_at, rowid', userId)) {
          const p = project(r);
          if (!Object.prototype.hasOwnProperty.call(p.paths, workerId)) continue;
          delete p.paths[workerId];
          this.run('UPDATE projects SET paths_json = ?, updated_at = ? WHERE id = ?', JSON.stringify(p.paths), t, p.id);
          changed.push({ ...p, updatedAt: t });
        }
        return changed;
      }),
  };

  cards = {
    list: async (userId: string, f: { projectId?: string; state?: CardState; workerId?: string }): Promise<Card[]> => {
      let sql = 'SELECT * FROM cards WHERE user_id = ?';
      const args: string[] = [userId];
      if (f.projectId !== undefined) { sql += ' AND project_id = ?'; args.push(f.projectId); }
      if (f.state !== undefined) { sql += ' AND state = ?'; args.push(f.state); }
      if (f.workerId !== undefined) { sql += ' AND worker_id = ?'; args.push(f.workerId); }
      return this.all(`${sql} ORDER BY ord, created_at, rowid`, ...args).map(card);
    },
    get: async (userId: string, id: string): Promise<Card | null> => {
      const r = this.one('SELECT * FROM cards WHERE user_id = ? AND id = ?', userId, id);
      return r ? card(r) : null;
    },
    create: async (userId: string, c: { title: string; body: string; projectId: string | null; order: number }): Promise<Card> => {
      const id = shortId('c');
      const t = now();
      this.run(
        `INSERT INTO cards (id, user_id, project_id, title, body, state, worker_id, session_id, ord, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'inbox', NULL, NULL, ?, NULL, ?, ?)`,
        id, userId, c.projectId, c.title, c.body, c.order, t, t,
      );
      return card(this.one('SELECT * FROM cards WHERE id = ?', id)!);
    },
    update: async (userId: string, id: string, patch: {
      title?: string; body?: string; projectId?: string | null; state?: CardState;
      workerId?: string | null; sessionId?: string | null; order?: number; error?: string | null;
    }): Promise<Card | null> => {
      const cols: Record<string, string | number | null | undefined> = {
        title: patch.title, body: patch.body, project_id: patch.projectId, state: patch.state,
        worker_id: patch.workerId, session_id: patch.sessionId, ord: patch.order, error: patch.error,
      };
      const sets: string[] = [];
      const args: (string | number | null)[] = [];
      for (const [col, v] of Object.entries(cols)) {
        if (v === undefined) continue;
        sets.push(`${col} = ?`);
        args.push(v);
      }
      sets.push('updated_at = ?');
      args.push(now());
      const changes = this.run(`UPDATE cards SET ${sets.join(', ')} WHERE user_id = ? AND id = ?`, ...args, userId, id);
      if (changes === 0) return null;
      return card(this.one('SELECT * FROM cards WHERE id = ?', id)!);
    },
    delete: async (userId: string, id: string): Promise<boolean> =>
      this.run('DELETE FROM cards WHERE user_id = ? AND id = ?', userId, id) > 0,
    maxOrder: async (userId: string, state: CardState, workerId: string | null): Promise<number> => {
      const r = workerId === null
        ? this.one('SELECT MAX(ord) AS m FROM cards WHERE user_id = ? AND state = ?', userId, state)
        : this.one('SELECT MAX(ord) AS m FROM cards WHERE user_id = ? AND state = ? AND worker_id = ?', userId, state, workerId);
      return r?.m == null ? -1 : Number(r.m);
    },
    deleteByProject: async (userId: string, projectId: string): Promise<Card[]> =>
      this.tx(() => {
        const rows = this.all('SELECT * FROM cards WHERE user_id = ? AND project_id = ? ORDER BY ord, created_at, rowid', userId, projectId);
        this.run('DELETE FROM cards WHERE user_id = ? AND project_id = ?', userId, projectId);
        return rows.map(card);
      }),
    forWorker: async (workerId: string, userId: string): Promise<Card[]> =>
      this.all(
        "SELECT * FROM cards WHERE worker_id = ? AND user_id = ? AND state IN ('queued', 'running') ORDER BY ord, created_at, rowid",
        workerId, userId,
      ).map(card),
    byWorker: async (workerId: string): Promise<Card[]> =>
      this.all('SELECT * FROM cards WHERE worker_id = ? ORDER BY ord, created_at, rowid', workerId).map(card),
  };

  memories = {
    get: async (userId: string, scope: MemoryScope, projectId: string | null): Promise<MemoryDoc | null> => {
      const r = this.one(
        'SELECT * FROM memories WHERE user_id = ? AND scope = ? AND project_id = ?', userId, scope, memoryProjectKey(scope, projectId),
      );
      return r ? memory(r) : null;
    },
    put: async (userId: string, scope: MemoryScope, projectId: string | null, content: string): Promise<MemoryDoc> => {
      const key = memoryProjectKey(scope, projectId);
      this.run(
        `INSERT INTO memories (user_id, scope, project_id, content, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, scope, project_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
        userId, scope, key, content, now(),
      );
      return memory(this.one('SELECT * FROM memories WHERE user_id = ? AND scope = ? AND project_id = ?', userId, scope, key)!);
    },
    deleteProject: async (userId: string, projectId: string): Promise<void> => {
      this.run("DELETE FROM memories WHERE user_id = ? AND scope = 'project' AND project_id = ?", userId, projectId);
    },
  };

  private upsertIndex(userId: string, entries: SessionIndexEntry[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO session_index (worker_id, session_id, user_id, title, preview, status, project_id, cwd, created_at, last_activity_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(worker_id, session_id) DO UPDATE SET user_id = excluded.user_id, title = excluded.title,
         preview = excluded.preview, status = excluded.status, project_id = excluded.project_id, cwd = excluded.cwd,
         created_at = excluded.created_at, last_activity_at = excluded.last_activity_at`,
    );
    for (const e of entries) {
      stmt.run(e.workerId, e.sessionId, userId, e.title, e.preview, e.status, e.projectId, e.cwd, e.createdAt, e.lastActivityAt);
    }
  }

  sessionIndex = {
    replaceWorker: async (userId: string, workerId: string, entries: SessionIndexEntry[]): Promise<void> => {
      this.tx(() => {
        this.run('DELETE FROM session_index WHERE worker_id = ?', workerId);
        this.upsertIndex(userId, entries.map((e) => ({ ...e, workerId })));
      });
    },
    upsert: async (userId: string, entries: SessionIndexEntry[]): Promise<void> => {
      this.tx(() => this.upsertIndex(userId, entries));
    },
    remove: async (workerId: string, sessionIds: string[]): Promise<void> => {
      this.tx(() => {
        const stmt = this.db.prepare('DELETE FROM session_index WHERE worker_id = ? AND session_id = ?');
        for (const id of sessionIds) stmt.run(workerId, id);
      });
    },
    query: async (userId: string, f: { projectId?: string; workerId?: string; q?: string; limit: number }): Promise<SessionIndexEntry[]> => {
      let sql = 'SELECT * FROM session_index WHERE user_id = ?';
      const args: (string | number)[] = [userId];
      if (f.projectId !== undefined) { sql += ' AND project_id = ?'; args.push(f.projectId); }
      if (f.workerId !== undefined) { sql += ' AND worker_id = ?'; args.push(f.workerId); }
      if (f.q) {
        sql += ' AND (instr(lower(title), lower(?)) > 0 OR instr(lower(preview), lower(?)) > 0)';
        args.push(f.q, f.q);
      }
      sql += ' ORDER BY last_activity_at DESC, rowid DESC LIMIT ?';
      args.push(f.limit);
      return this.all(sql, ...args).map(indexEntry);
    },
    clearProject: async (userId: string, projectId: string): Promise<void> => {
      this.run('UPDATE session_index SET project_id = NULL WHERE user_id = ? AND project_id = ?', userId, projectId);
    },
    deleteWorker: async (workerId: string): Promise<void> => {
      this.run('DELETE FROM session_index WHERE worker_id = ?', workerId);
    },
  };

  apiTokens = {
    create: async (userId: string, label: string, tokenHash: string): Promise<ApiTokenRow> => {
      const id = shortId('t');
      this.run(
        'INSERT INTO api_tokens (id, user_id, label, token_hash, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, NULL)',
        id, userId, label, tokenHash, now(),
      );
      return apiToken(this.one('SELECT * FROM api_tokens WHERE id = ?', id)!);
    },
    list: async (userId: string): Promise<ApiTokenRow[]> =>
      this.all('SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at, rowid', userId).map(apiToken),
    get: async (tokenHash: string): Promise<ApiTokenRow | null> => {
      const r = this.one('SELECT * FROM api_tokens WHERE token_hash = ?', tokenHash);
      return r ? apiToken(r) : null;
    },
    touch: async (id: string): Promise<void> => {
      this.run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', now(), id);
    },
    delete: async (userId: string, id: string): Promise<boolean> =>
      this.run('DELETE FROM api_tokens WHERE user_id = ? AND id = ?', userId, id) > 0,
  };

  installCodes = {
    create: async (userId: string, codeHash: string, label: string | null, expiresAt: number): Promise<void> => {
      this.run(
        'INSERT INTO install_codes (code_hash, user_id, label, expires_at, used_by, created_at) VALUES (?, ?, ?, ?, NULL, ?)',
        codeHash, userId, label, expiresAt, now(),
      );
    },
    get: async (codeHash: string): Promise<InstallCodeRow | null> => {
      const r = this.one('SELECT * FROM install_codes WHERE code_hash = ?', codeHash);
      return r ? installCode(r) : null;
    },
    consume: async (codeHash: string, workerId: string, nowMs: number): Promise<InstallCodeRow | null> => {
      const changes = this.run(
        'UPDATE install_codes SET used_by = ? WHERE code_hash = ? AND expires_at > ? AND (used_by IS NULL OR used_by = ?)',
        workerId, codeHash, nowMs, workerId,
      );
      if (changes === 0) return null;
      return installCode(this.one('SELECT * FROM install_codes WHERE code_hash = ?', codeHash)!);
    },
  };

  allowlist = {
    list: async (): Promise<AllowlistRow[]> => this.all('SELECT * FROM allowlist ORDER BY email').map(allowlistRow),
    get: async (email: string): Promise<AllowlistRow | null> => {
      const r = this.one('SELECT * FROM allowlist WHERE email = ?', email);
      return r ? allowlistRow(r) : null;
    },
    count: async (): Promise<number> => Number(this.one('SELECT COUNT(*) AS n FROM allowlist')!.n),
    bootstrap: async (email: string): Promise<boolean> =>
      this.tx(() => {
        if (Number(this.one('SELECT COUNT(*) AS n FROM allowlist')!.n) > 0) return false;
        this.run('INSERT INTO allowlist (email, role, added_by, created_at) VALUES (?, ?, ?, ?)', email, 'admin', 'bootstrap', now());
        return true;
      }),
    put: async (email: string, role: AllowlistRole, addedBy: string): Promise<AllowlistRow | 'last_admin'> =>
      this.tx((): AllowlistRow | 'last_admin' => {
        const ex = this.one('SELECT * FROM allowlist WHERE email = ?', email);
        if (!ex) {
          this.run('INSERT INTO allowlist (email, role, added_by, created_at) VALUES (?, ?, ?, ?)', email, role, addedBy, now());
        } else {
          if (ex.role === 'admin' && role !== 'admin' && this.adminCount() <= 1) return 'last_admin';
          this.run('UPDATE allowlist SET role = ? WHERE email = ?', role, email);
        }
        return allowlistRow(this.one('SELECT * FROM allowlist WHERE email = ?', email)!);
      }),
    delete: async (email: string): Promise<'ok' | 'not_found' | 'last_admin'> =>
      this.tx((): 'ok' | 'not_found' | 'last_admin' => {
        const ex = this.one('SELECT role FROM allowlist WHERE email = ?', email);
        if (!ex) return 'not_found';
        if (ex.role === 'admin' && this.adminCount() <= 1) return 'last_admin';
        this.run('DELETE FROM allowlist WHERE email = ?', email);
        return 'ok';
      }),
  };
  private adminCount(): number {
    return Number(this.one("SELECT COUNT(*) AS n FROM allowlist WHERE role = 'admin'")!.n);
  }

  accessRequests = {
    record: async (email: string): Promise<AccessRequest> => {
      const t = now();
      this.run(
        `INSERT INTO access_requests (email, status, attempts, requested_at, updated_at) VALUES (?, 'pending', 1, ?, ?)
         ON CONFLICT(email) DO UPDATE SET attempts = attempts + 1, updated_at = excluded.updated_at`,
        email, t, t,
      );
      return accessRequest(this.one('SELECT * FROM access_requests WHERE email = ?', email)!);
    },
    get: async (email: string): Promise<AccessRequest | null> => {
      const r = this.one('SELECT * FROM access_requests WHERE email = ?', email);
      return r ? accessRequest(r) : null;
    },
    list: async (): Promise<AccessRequest[]> =>
      this.all('SELECT * FROM access_requests ORDER BY updated_at DESC, rowid DESC').map(accessRequest),
    setStatus: async (email: string, status: AccessRequestStatus): Promise<AccessRequest | null> => {
      if (this.run('UPDATE access_requests SET status = ?, updated_at = ? WHERE email = ?', status, now(), email) === 0) return null;
      return accessRequest(this.one('SELECT * FROM access_requests WHERE email = ?', email)!);
    },
    delete: async (email: string): Promise<boolean> => this.run('DELETE FROM access_requests WHERE email = ?', email) > 0,
  };

  admin = {
    counts: async () => {
      const by = (sql: string) => Object.fromEntries(this.all(sql).map((r) => [String(r.user_id), Number(r.n)]));
      return {
        sessionsByUser: by('SELECT user_id, COUNT(*) AS n FROM session_index GROUP BY user_id'),
        apiTokensByUser: by('SELECT user_id, COUNT(*) AS n FROM api_tokens GROUP BY user_id'),
        sessions: Number(this.one('SELECT COUNT(*) AS n FROM session_index')!.n),
        cards: Number(this.one('SELECT COUNT(*) AS n FROM cards')!.n),
      };
    },
  };

  settings = {
    get: async (userId: string): Promise<AccountSettings> => {
      const r = this.one('SELECT e2e, auto_compact_enabled, auto_compact_threshold_tokens, auto_compact_keep_recent_tokens FROM settings WHERE user_id = ?', userId);
      return {
        e2e: r ? Number(r.e2e) !== 0 : false,
        autoCompact: r
          ? normalizeAutoCompact({
            enabled: Number(r.auto_compact_enabled) !== 0,
            thresholdTokens: Number(r.auto_compact_threshold_tokens),
            keepRecentTokens: Number(r.auto_compact_keep_recent_tokens),
          })
          : { ...DEFAULT_AUTO_COMPACT },
      };
    },
    put: async (userId: string, s: AccountSettings): Promise<AccountSettings> => {
      const a = normalizeAutoCompact(s.autoCompact);
      this.run(
        'INSERT INTO settings (user_id, e2e, auto_compact_enabled, auto_compact_threshold_tokens, auto_compact_keep_recent_tokens) '
        + 'VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET e2e = excluded.e2e, '
        + 'auto_compact_enabled = excluded.auto_compact_enabled, auto_compact_threshold_tokens = excluded.auto_compact_threshold_tokens, '
        + 'auto_compact_keep_recent_tokens = excluded.auto_compact_keep_recent_tokens',
        userId, s.e2e ? 1 : 0, a.enabled ? 1 : 0, a.thresholdTokens, a.keepRecentTokens,
      );
      return { e2e: s.e2e, autoCompact: a };
    },
  };

  async close(): Promise<void> {
    this.db.close();
  }
}
