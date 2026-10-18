// SaasStore — abstract storage interface (Postgres can implement the same later).
import type { AccessRequest, AccessRequestStatus, AccountSettings, AllowlistRole, Card, CardState, MemoryDoc, MemoryScope, Project, SessionIndexEntry } from '@nopear/protocol';

export interface UserRow {
  id: string; email: string; googleSub: string | null; createdAt: string;
  /** Set while an admin has disabled the account (see AdminUser.disabled). */
  disabledAt: string | null;
  lastSeenAt: string | null;
}
export interface ClientRow { userId: string; clientPub: string; label: string; sig: string; createdAt: string }
export interface WorkerRow {
  workerId: string; workerPub: string; secretHash: string; userId: string | null; label: string;
  claimTokenHash: string | null; claimExpiresAt: number | null; lastSeenAt: string | null; version: string; createdAt: string;
}
export interface ApiTokenRow { id: string; userId: string; label: string; tokenHash: string; createdAt: string; lastUsedAt: string | null }
export interface InstallCodeRow { codeHash: string; userId: string; label: string | null; expiresAt: number; usedBy: string | null; createdAt: string }
/** Login allowlist entry; `email` is normalized (see allowlist.ts). */
export interface AllowlistRow { email: string; role: AllowlistRole; addedBy: string; createdAt: string }
export type RegisterWithCodeResult =
  | { status: 'ok'; worker: WorkerRow; code: InstallCodeRow }
  | { status: 'invalid_code' } | { status: 'exists' } | { status: 'owned_elsewhere' };
export interface SaasStore {
  users: {
    upsertGoogle(sub: string, email: string): Promise<UserRow>;
    upsertDev(email: string): Promise<UserRow>;
    get(id: string): Promise<UserRow | null>;
    /** Sorted by createdAt. */
    list(): Promise<UserRow[]>;
    /** Returns the updated row, or null when no such user. */
    setDisabled(id: string, disabled: boolean): Promise<UserRow | null>;
    touch(id: string, at: string): Promise<void>;
  };
  tokens: {
    create(userId: string, tokenHash: string, expiresAt: number): Promise<void>;
    get(tokenHash: string): Promise<{ userId: string; expiresAt: number } | null>;
    delete(tokenHash: string): Promise<void>;
    /** Sign the user out everywhere (disable). */
    deleteByUser(userId: string): Promise<void>;
  };
  clients: {
    upsert(userId: string, clientPub: string, label: string, sig: string): Promise<ClientRow>;
    list(userId: string): Promise<ClientRow[]>;
    delete(userId: string, clientPub: string): Promise<boolean>;
  };
  workers: {
    /** 'ok' when inserted or when the same (workerPub, secretHash) is already registered (idempotent retry);
     *  'exists' when workerId is taken by a different identity. */
    register(workerId: string, workerPub: string, secretHash: string): Promise<'ok' | 'exists'>;
    get(workerId: string): Promise<WorkerRow | null>;
    setClaimTokenHash(workerId: string, hash: string, expiresAt: number): Promise<void>;
    /** Atomic: hash matches, not expired, unclaimed → assign to user and clear token; else null. */
    claim(workerId: string, tokenHash: string, userId: string, label: string | undefined, now: number): Promise<WorkerRow | null>;
    listByUser(userId: string): Promise<WorkerRow[]>;
    /** Every registered worker, claimed or not (admin console). */
    listAll(): Promise<WorkerRow[]>;
    /** Remove a worker record entirely (admin: stale unclaimed machines). */
    delete(workerId: string): Promise<boolean>;
    update(workerId: string, patch: { label?: string; lastSeenAt?: string; version?: string }): Promise<void>;
    unclaim(workerId: string): Promise<void>;
    /** Install-code claim: unclaimed → assign to user (label when given); already owned by the same user → row; else null. */
    claimDirect(workerId: string, userId: string, label: string | null): Promise<WorkerRow | null>;
    /** Atomic install-code registration (one transaction, all or nothing): the code must exist, be unexpired and be
     *  unused or used by this same worker (else 'invalid_code', nothing written); the worker is registered (idempotent
     *  for the same identity; a different identity → 'exists'); a worker owned by another account → 'owned_elsewhere'
     *  (code not consumed); otherwise the code is marked used by `workerId` and the worker is claimed (claimDirect). */
    registerWithInstallCode(workerId: string, workerPub: string, secretHash: string, codeHash: string, now: number): Promise<RegisterWithCodeResult>;
  };
  projects: {
    /** Sorted by createdAt. */
    list(userId: string): Promise<Project[]>;
    get(userId: string, id: string): Promise<Project | null>;
    create(userId: string, p: { name: string; description: string; paths: Record<string, string> }): Promise<Project>;
    /** `paths` replaces the whole map. */
    update(userId: string, id: string, patch: { name?: string; description?: string; paths?: Record<string, string> }): Promise<Project | null>;
    delete(userId: string, id: string): Promise<boolean>;
    /** Drops `workerId` from every project's paths; returns the projects that changed. */
    removeWorkerPaths(userId: string, workerId: string): Promise<Project[]>;
  };
  cards: {
    /** Sorted by order, then createdAt. */
    list(userId: string, f: { projectId?: string; state?: CardState; workerId?: string }): Promise<Card[]>;
    get(userId: string, id: string): Promise<Card | null>;
    /** New cards start in `inbox` with no worker/session. */
    create(userId: string, c: { title: string; body: string; projectId: string | null; order: number }): Promise<Card>;
    update(userId: string, id: string, patch: {
      title?: string; body?: string; projectId?: string | null; state?: CardState;
      workerId?: string | null; sessionId?: string | null; order?: number; error?: string | null;
    }): Promise<Card | null>;
    delete(userId: string, id: string): Promise<boolean>;
    /** Max order in the column (state, plus workerId when non-null); -1 when empty. */
    maxOrder(userId: string, state: CardState, workerId: string | null): Promise<number>;
    /** Deletes and returns the project's cards. */
    deleteByProject(userId: string, projectId: string): Promise<Card[]>;
    /** queued + running cards of `userId` (the machine's current owner) assigned to the worker, sorted by order. */
    forWorker(workerId: string, userId: string): Promise<Card[]>;
    /** Every state, for unclaim cascade. */
    byWorker(workerId: string): Promise<Card[]>;
  };
  memories: {
    get(userId: string, scope: MemoryScope, projectId: string | null): Promise<MemoryDoc | null>;
    put(userId: string, scope: MemoryScope, projectId: string | null, content: string): Promise<MemoryDoc>;
    deleteProject(userId: string, projectId: string): Promise<void>;
  };
  sessionIndex: {
    /** Replaces every entry of the worker with `entries`. */
    replaceWorker(userId: string, workerId: string, entries: SessionIndexEntry[]): Promise<void>;
    upsert(userId: string, entries: SessionIndexEntry[]): Promise<void>;
    remove(workerId: string, sessionIds: string[]): Promise<void>;
    /** `q` matches title/preview case-insensitively; ordered by lastActivityAt desc. */
    query(userId: string, f: { projectId?: string; workerId?: string; q?: string; limit: number }): Promise<SessionIndexEntry[]>;
    clearProject(userId: string, projectId: string): Promise<void>;
    deleteWorker(workerId: string): Promise<void>;
  };
  apiTokens: {
    create(userId: string, label: string, tokenHash: string): Promise<ApiTokenRow>;
    list(userId: string): Promise<ApiTokenRow[]>;
    get(tokenHash: string): Promise<ApiTokenRow | null>;
    touch(id: string): Promise<void>;
    delete(userId: string, id: string): Promise<boolean>;
  };
  installCodes: {
    create(userId: string, codeHash: string, label: string | null, expiresAt: number): Promise<void>;
    get(codeHash: string): Promise<InstallCodeRow | null>;
    /** Atomic: exists && expiresAt > now && (usedBy null || usedBy === workerId) → mark usedBy=workerId and return; else null. */
    consume(codeHash: string, workerId: string, now: number): Promise<InstallCodeRow | null>;
  };
  /** Login allowlist (empty = disabled). Callers pass normalized emails. */
  allowlist: {
    /** Sorted by email. */
    list(): Promise<AllowlistRow[]>;
    get(email: string): Promise<AllowlistRow | null>;
    count(): Promise<number>;
    /** One transaction: inserts (email, 'admin', 'bootstrap') only when the list is empty; returns whether it inserted. */
    bootstrap(email: string): Promise<boolean>;
    /** One transaction: absent → insert; present → change `role` only (keeps addedBy/createdAt).
     *  Demoting the only admin → nothing written, 'last_admin'. */
    put(email: string, role: AllowlistRole, addedBy: string): Promise<AllowlistRow | 'last_admin'>;
    /** One transaction: deleting the only admin → nothing deleted, 'last_admin'. */
    delete(email: string): Promise<'ok' | 'not_found' | 'last_admin'>;
  };
  /** Sign-in attempts by people outside the allowlist (see AccessRequest). */
  accessRequests: {
    /** Absent → new `pending`; present → attempts + 1 (status kept, so a rejection sticks). */
    record(email: string): Promise<AccessRequest>;
    get(email: string): Promise<AccessRequest | null>;
    /** Newest first. */
    list(): Promise<AccessRequest[]>;
    setStatus(email: string, status: AccessRequestStatus): Promise<AccessRequest | null>;
    delete(email: string): Promise<boolean>;
  };
  /** Aggregate counts for the admin console. */
  admin: {
    counts(): Promise<{ sessionsByUser: Record<string, number>; apiTokensByUser: Record<string, number>; sessions: number; cards: number }>;
  };
  settings: {
    /** Default `{ e2e: false }`. */
    get(userId: string): Promise<AccountSettings>;
    put(userId: string, s: AccountSettings): Promise<AccountSettings>;
  };
  close(): Promise<void>;
}

export async function openStore(dsn: string): Promise<SaasStore> {
  if (dsn.startsWith('postgres://') || dsn.startsWith('postgresql://')) throw new Error('postgres store not implemented');
  if (dsn.startsWith('sqlite:')) {
    const { SqliteSaasStore } = await import('./sqlite-store');
    return new SqliteSaasStore(dsn.slice('sqlite:'.length));
  }
  throw new Error(`unsupported SAAS_DB: ${dsn}`);
}
