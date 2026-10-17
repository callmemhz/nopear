// SaaS control-plane client (plaintext; SaaS is the counterparty) + raw data-plane POST.
import { SSE_STALL_MS } from '@nopear/protocol';
import type {
  AccountSettings, AllowlistEntry, AllowlistRole, ApiTokenInfo, AutoCompactSettings, Card, CardPatch, CardState, Client, InstallCodeResult, Machine, MemoryDoc, MemoryScope,
  MeResult, Project, SaasConfig, SaasEvent, SessionIndexEntry, User,
} from '@nopear/protocol';
import type { Platform } from './platform';
import { readSse, stallWatchdog } from './sse';

/** Options of a long-lived SSE stream: watchdog timeout (default SSE_STALL_MS) and an activity hook. */
export interface StreamOpts { stallMs?: number; onActivity?: () => void }

export class SaasError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = 'SaasError';
  }
}

export async function errorFromResponse(res: Response): Promise<{ code: string; message: string }> {
  try {
    const j = (await res.json()) as { error?: { code?: string; message?: string } };
    return { code: j.error?.code ?? `http_${res.status}`, message: j.error?.message ?? res.statusText };
  } catch {
    return { code: `http_${res.status}`, message: res.statusText || `HTTP ${res.status}` };
  }
}

function query(q: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export class SaasClient {
  readonly baseUrl: string;
  private platform: Platform;
  private getToken: () => string | null;

  constructor(opts: { baseUrl: string; platform: Platform; getToken: () => string | null }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.platform = opts.platform;
    this.getToken = opts.getToken;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const t = this.getToken();
    return { ...(t ? { authorization: `Bearer ${t}` } : {}), ...extra };
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method, headers: this.headers(body !== undefined ? { 'content-type': 'application/json' } : {}) };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await this.platform.fetch(this.baseUrl + path, init);
    if (!res.ok) {
      const e = await errorFromResponse(res);
      throw new SaasError(res.status, e.code, e.message);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  config(): Promise<SaasConfig> { return this.json('GET', '/api/config'); }
  devLogin(email: string): Promise<{ token: string; user: User }> { return this.json('POST', '/api/auth/dev', { email }); }
  googleStartUrl(redirect: string): string { return `${this.baseUrl}/api/auth/google/start?redirect=${encodeURIComponent(redirect)}`; }
  me(): Promise<MeResult> { return this.json('GET', '/api/me'); }
  async logout(): Promise<void> { await this.json('POST', '/api/auth/logout'); }
  registerClient(clientPub: string, label: string): Promise<{ client: Client }> { return this.json('POST', '/api/clients', { clientPub, label }); }
  listClients(): Promise<{ clients: Client[] }> { return this.json('GET', '/api/clients'); }
  async deleteClient(clientPub: string): Promise<void> { await this.json('DELETE', `/api/clients/${encodeURIComponent(clientPub)}`); }
  machines(): Promise<{ machines: Machine[] }> { return this.json('GET', '/api/machines'); }
  claim(workerId: string, claimToken: string, label?: string): Promise<{ machine: Machine }> {
    return this.json('POST', '/api/machines/claim', label !== undefined ? { workerId, claimToken, label } : { workerId, claimToken });
  }
  async renameMachine(workerId: string, label: string): Promise<void> { await this.json('PATCH', `/api/machines/${encodeURIComponent(workerId)}`, { label }); }
  async removeMachine(workerId: string): Promise<void> { await this.json('DELETE', `/api/machines/${encodeURIComponent(workerId)}`); }

  // ---------- login allowlist admin ----------
  allowlist(): Promise<{ entries: AllowlistEntry[] }> { return this.json('GET', '/api/admin/allowlist'); }
  putAllowlist(email: string, role: AllowlistRole): Promise<{ entry: AllowlistEntry }> {
    return this.json('PUT', `/api/admin/allowlist/${encodeURIComponent(email)}`, { role });
  }
  async deleteAllowlist(email: string): Promise<void> { await this.json('DELETE', `/api/admin/allowlist/${encodeURIComponent(email)}`); }

  // ---------- collaboration hub ----------
  settings(): Promise<{ settings: AccountSettings }> { return this.json('GET', '/api/settings'); }
  patchSettings(patch: { e2e?: boolean; autoCompact?: Partial<AutoCompactSettings> }): Promise<{ settings: AccountSettings }> {
    return this.json('PATCH', '/api/settings', patch);
  }
  projects(): Promise<{ projects: Project[] }> { return this.json('GET', '/api/projects'); }
  project(id: string): Promise<{ project: Project }> { return this.json('GET', `/api/projects/${encodeURIComponent(id)}`); }
  createProject(input: { name: string; description?: string; paths?: Record<string, string> }): Promise<{ project: Project }> {
    return this.json('POST', '/api/projects', input);
  }
  updateProject(id: string, patch: { name?: string; description?: string; paths?: Record<string, string> }): Promise<{ project: Project }> {
    return this.json('PATCH', `/api/projects/${encodeURIComponent(id)}`, patch);
  }
  async deleteProject(id: string): Promise<void> { await this.json('DELETE', `/api/projects/${encodeURIComponent(id)}`); }
  cards(filter: { projectId?: string; state?: CardState; workerId?: string } = {}): Promise<{ cards: Card[] }> {
    return this.json('GET', `/api/cards${query(filter)}`);
  }
  createCard(input: { title: string; body?: string; projectId?: string | null }): Promise<{ card: Card }> { return this.json('POST', '/api/cards', input); }
  updateCard(id: string, patch: CardPatch): Promise<{ card: Card }> { return this.json('PATCH', `/api/cards/${encodeURIComponent(id)}`, patch); }
  async deleteCard(id: string): Promise<void> { await this.json('DELETE', `/api/cards/${encodeURIComponent(id)}`); }
  memory(scope: MemoryScope, projectId: string | null): Promise<{ memory: MemoryDoc }> {
    return this.json('GET', `/api/memory${query(projectId !== null ? { scope, projectId } : { scope })}`);
  }
  putMemory(scope: MemoryScope, projectId: string | null, content: string): Promise<{ memory: MemoryDoc }> {
    return this.json('PUT', '/api/memory', { scope, projectId, content });
  }
  sessionIndex(q: { projectId?: string; workerId?: string; q?: string; limit?: number } = {}): Promise<{ sessions: SessionIndexEntry[] }> {
    return this.json('GET', `/api/sessions${query(q)}`);
  }
  createApiToken(label: string): Promise<{ token: string }> { return this.json('POST', '/api/tokens', { label }); }
  apiTokens(): Promise<{ tokens: ApiTokenInfo[] }> { return this.json('GET', '/api/tokens'); }
  async deleteApiToken(id: string): Promise<void> { await this.json('DELETE', `/api/tokens/${encodeURIComponent(id)}`); }
  createInstallCode(label?: string): Promise<InstallCodeResult> {
    return this.json('POST', '/api/machines/install-code', label !== undefined ? { label } : {});
  }

  /** Plaintext SSE of machine presence. Resolves when the stream ends, `signal` aborts or the stream stalls (no bytes
   *  for `opts.stallMs`, default SSE_STALL_MS — the caller reconnects); throws on HTTP error. */
  async events(onEvent: (e: SaasEvent) => void, signal: AbortSignal, opts: StreamOpts = {}): Promise<void> {
    const wd = stallWatchdog(signal, opts.stallMs ?? SSE_STALL_MS);
    const activity = () => { wd.kick(); try { opts.onActivity?.(); } catch { /* caller error */ } };
    try {
      let res: Response;
      try {
        res = await this.platform.fetch(`${this.baseUrl}/api/events`, { headers: this.headers({ accept: 'text/event-stream' }), signal: wd.signal });
      } catch (e) {
        if (wd.signal.aborted) return;
        throw e;
      }
      if (!res.ok) {
        const e = await errorFromResponse(res);
        throw new SaasError(res.status, e.code, e.message);
      }
      activity();
      await readSse(res, (m) => {
        if (!m.data) return;
        try { onEvent(JSON.parse(m.data) as SaasEvent); } catch { /* ignore malformed frame */ }
      }, wd.signal, activity);
    } finally {
      wd.dispose();
    }
  }

  rawPost(path: string, body: Uint8Array, headers: Record<string, string>, signal?: AbortSignal): Promise<Response> {
    const init: RequestInit = { method: 'POST', headers: this.headers({ 'content-type': 'application/octet-stream', ...headers }), body: body as BodyInit };
    if (signal) init.signal = signal;
    return this.platform.fetch(this.baseUrl + path, init);
  }
}
