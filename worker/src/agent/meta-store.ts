// $NOPEAR_HOME/sessions.json — nopear-side session metadata (pi owns the transcript).
// Same write discipline as the v2 server MetaStore: whole-file rewrite, tmp+rename, serialized.
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import type { SessionKind, ThinkingLevel } from '@nopear/protocol';
import type { TitleSource } from './titles';

export interface SessionMeta {
  id: string; kind: SessionKind; projectId?: string; title: string; cwd: string; sessionFile: string;
  createdAt: string; lastActivityAt: string; preview: string; pinned: boolean; starred: boolean; archived: boolean;
  model: string; thinking: ThinkingLevel; leafId?: string | null;
  /** Who set the title (see titles.ts); absent on sessions created before titles were tracked = 'prompt'. */
  titleSource?: TitleSource;
}

interface Shape { version: 1; sessions: Record<string, SessionMeta> }

export class MetaStore {
  private data: Shape = { version: 1, sessions: {} };
  private chain: Promise<void> = Promise.resolve();
  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Shape;
      // Only chat sessions survive: legacy v3 pm/card session metadata is dropped on load.
      if (parsed?.sessions) {
        const sessions = Object.fromEntries(Object.entries(parsed.sessions).filter(([, m]) => m?.kind === 'chat'));
        this.data = { version: 1, sessions };
        if (this.rebaseMovedFiles()) await this.flush();
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
      await mkdir(dirname(this.path), { recursive: true });
    }
  }

  /**
   * Session files are stored by absolute path. When the whole home directory was moved (e.g. `~/.fleet` →
   * `~/.nopear`, or a new NOPEAR_HOME), re-point every missing file at the same `sessions/…` path under the current
   * home if it exists there. Returns whether anything changed.
   */
  private rebaseMovedFiles(): boolean {
    const home = dirname(this.path);
    const marker = `${sep}sessions${sep}`;
    let changed = false;
    for (const m of Object.values(this.data.sessions)) {
      if (!m.sessionFile || existsSync(m.sessionFile)) continue;
      const i = m.sessionFile.lastIndexOf(marker);
      if (i < 0) continue;
      const moved = join(home, m.sessionFile.slice(i + 1));
      if (moved !== m.sessionFile && existsSync(moved)) { m.sessionFile = moved; changed = true; }
    }
    return changed;
  }

  list(): SessionMeta[] { return Object.values(this.data.sessions); }
  get(id: string): SessionMeta | undefined { return this.data.sessions[id]; }

  async put(m: SessionMeta): Promise<void> {
    this.data.sessions[m.id] = m;
    await this.flush();
  }

  /** Merge `p`, then delete the keys listed in `unset` (e.g. clearing an optional projectId). */
  async patch(id: string, p: Partial<SessionMeta>, unset: Array<keyof SessionMeta> = []): Promise<SessionMeta | undefined> {
    const cur = this.data.sessions[id];
    if (!cur) return undefined;
    const next = { ...cur, ...p, id };
    for (const k of unset) if (k !== 'id') delete (next as Partial<SessionMeta>)[k];
    this.data.sessions[id] = next;
    await this.flush();
    return next;
  }

  async delete(id: string): Promise<void> {
    if (!(id in this.data.sessions)) return;
    delete this.data.sessions[id];
    await this.flush();
  }

  private async flush(): Promise<void> {
    const snapshot = JSON.stringify(this.data, null, 2);
    this.chain = this.chain.catch(() => {}).then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, snapshot, 'utf8');
      await rename(tmp, this.path);
    });
    await this.chain;
  }
}
