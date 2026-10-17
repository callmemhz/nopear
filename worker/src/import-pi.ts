// One-time import of local pi CLI sessions (~/.pi/agent/sessions/<encoded-cwd>/*.jsonl) into this worker's
// NOPEAR_HOME: each kept transcript is COPIED (source never touched) to <sessionsDir>/<encoded-cwd>/<file> and a
// SessionMeta is written to sessions.json. Skips temp-cwd sessions, sessions without a user message, unparseable
// files and anything already imported (idempotent). Only files directly inside each cwd dir count (subagent artifacts
// live deeper and are ignored).
//
//   npm run import-pi -w @nopear/worker -- [--dry-run] [--source <dir>]
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { THINKING_LEVELS, type ThinkingLevel } from '@nopear/protocol';
import { assistantBlocks, previewOf } from './agent/mapping';
import { MetaStore, type SessionMeta } from './agent/meta-store';
import { loadLocalConfig, type LocalConfig } from './config';

const TEMP_PREFIXES = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders'];
const TITLE_FALLBACK = '导入的会话';

export const isTempCwd = (cwd: string): boolean => TEMP_PREFIXES.some((p) => cwd === p || cwd.startsWith(p + '/'));

export interface ImportSummary {
  found: number; imported: number; bytes: number;
  skipped: { temp: number; empty: number; invalid: number; alreadyImported: number };
  items: Array<{ id: string; cwd: string; title: string; source: string; dest: string; bytes: number }>;
}

interface Header { id: string; timestamp: string; cwd: string }
type Scan =
  | { kind: 'invalid' }
  | { kind: 'temp'; header: Header }
  | { kind: 'seen'; header: Header }
  | { kind: 'ok'; header: Header; hasUser: boolean; title: string; preview: string; model?: string; thinking?: ThinkingLevel; lastTs?: string };

const textOf = (content: unknown): string =>
  typeof content === 'string' ? content
    : Array.isArray(content) ? (content as Array<{ type?: string; text?: string }>).filter((c) => c?.type === 'text').map((c) => c.text ?? '').join('\n') : '';

function parseHeader(line: string | undefined): Header | null {
  if (!line) return null;
  try {
    const h = JSON.parse(line) as Record<string, unknown>;
    if (h?.type !== 'session' || typeof h.id !== 'string' || !h.id || typeof h.cwd !== 'string' || !h.cwd
      || typeof h.timestamp !== 'string' || Number.isNaN(Date.parse(h.timestamp))) return null;
    return { id: h.id, timestamp: h.timestamp, cwd: h.cwd };
  } catch { return null; }
}

/** Stream a pi JSONL file once; stops right after the header when the session is going to be skipped anyway. */
async function scan(file: string, seen: (id: string) => boolean): Promise<Scan> {
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  let header: Header | null = null;
  let first = true;
  const out = { hasUser: false, title: '', preview: '', model: undefined as string | undefined,
    thinking: undefined as ThinkingLevel | undefined, lastTs: undefined as string | undefined };
  try {
    for await (const line of rl) {
      if (first) {
        first = false;
        header = parseHeader(line);
        if (!header) return { kind: 'invalid' };
        if (isTempCwd(header.cwd)) return { kind: 'temp', header };
        if (seen(header.id)) return { kind: 'seen', header };
        continue;
      }
      if (!line.trim()) continue;
      let e: Record<string, unknown>;
      try { e = JSON.parse(line) as Record<string, unknown>; } catch { continue; } // tolerate a torn trailing line
      if (!e || typeof e !== 'object') continue;
      if (typeof e.timestamp === 'string' && !Number.isNaN(Date.parse(e.timestamp))) out.lastTs = e.timestamp;
      if (e.type === 'model_change' && typeof e.provider === 'string' && typeof e.modelId === 'string') out.model = `${e.provider}/${e.modelId}`;
      else if (e.type === 'thinking_level_change' && typeof e.thinkingLevel === 'string') {
        out.thinking = (THINKING_LEVELS as readonly string[]).includes(e.thinkingLevel) ? e.thinkingLevel as ThinkingLevel : undefined;
      } else if (e.type === 'message' && e.message && typeof e.message === 'object') {
        const m = e.message as { role?: string; content?: unknown };
        if (m.role === 'user') {
          if (!out.hasUser) out.title = textOf(m.content).trim().slice(0, 40);
          out.hasUser = true;
        } else if (m.role === 'assistant') {
          // Same preview rule as the host: text blocks, whitespace collapsed, PREVIEW_MAX_CHARS.
          const p = previewOf({ id: '', sessionId: '', role: 'assistant', blocks: assistantBlocks(m.content), ts: '', status: 'complete' });
          if (p) out.preview = p;
        }
      }
    }
  } finally { rl.close(); }
  if (!header) return { kind: 'invalid' };
  return { kind: 'ok', header, ...out };
}

/** Top-level `*.jsonl` files directly inside each `<source>/<encoded-cwd>/` dir (maxdepth 2), sorted. */
async function listSourceFiles(source: string): Promise<Array<{ dir: string; name: string; path: string }>> {
  const out: Array<{ dir: string; name: string; path: string }> = [];
  for (const d of (await readdir(source, { withFileTypes: true })).filter((d) => d.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const files = (await readdir(join(source, d.name), { withFileTypes: true }))
      .filter((f) => f.isFile() && f.name.endsWith('.jsonl')).map((f) => f.name).sort();
    for (const name of files) out.push({ dir: d.name, name, path: join(source, d.name, name) });
  }
  return out;
}

export async function importPiSessions(opts: { source: string; cfg: LocalConfig; dryRun?: boolean; log?: (s: string) => void }): Promise<ImportSummary> {
  const { source, cfg, dryRun = false } = opts;
  const log = opts.log ?? ((s: string) => console.log(s));
  const metaPath = join(cfg.home, 'sessions.json');
  const store = new MetaStore(metaPath);
  // MetaStore.load() creates the parent dir when the file is missing; a dry run must not write anything.
  if (!dryRun || existsSync(metaPath)) await store.load();
  const thisRun = new Set<string>();
  const seen = (id: string): boolean => thisRun.has(id) || store.get(id) !== undefined;
  const r: ImportSummary = { found: 0, imported: 0, bytes: 0, skipped: { temp: 0, empty: 0, invalid: 0, alreadyImported: 0 }, items: [] };

  for (const f of await listSourceFiles(source)) {
    r.found++;
    const s = await scan(f.path, seen);
    if (s.kind === 'invalid') { r.skipped.invalid++; continue; }
    if (s.kind === 'temp') { r.skipped.temp++; continue; }
    if (s.kind === 'seen') { r.skipped.alreadyImported++; continue; }
    if (!s.hasUser) { r.skipped.empty++; continue; }
    const dest = join(cfg.sessionsDir, f.dir, f.name);
    if (existsSync(dest)) { r.skipped.alreadyImported++; continue; }
    const st = await stat(f.path);
    const meta: SessionMeta = {
      id: s.header.id, kind: 'chat', title: s.title || TITLE_FALLBACK, cwd: s.header.cwd, sessionFile: dest,
      createdAt: s.header.timestamp, lastActivityAt: s.lastTs ?? st.mtime.toISOString(), preview: s.preview,
      pinned: false, starred: false, archived: false, model: s.model ?? cfg.defaultModel, thinking: s.thinking ?? cfg.defaultThinking,
    };
    thisRun.add(meta.id);
    if (dryRun) log(`[dry-run] 将导入 ${meta.id}  ${meta.cwd}  「${meta.title}」  (${st.size} B)`);
    else {
      await mkdir(join(cfg.sessionsDir, f.dir), { recursive: true });
      await copyFile(f.path, dest);
      await store.put(meta);
      log(`已导入 ${meta.id}  ${meta.cwd}  「${meta.title}」`);
    }
    r.imported++;
    r.bytes += st.size;
    r.items.push({ id: meta.id, cwd: meta.cwd, title: meta.title, source: f.path, dest, bytes: st.size });
  }
  return r;
}

const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(1)} MB`;

async function main(argv: string[]): Promise<void> {
  let dryRun = false;
  let source = join(homedir(), '.pi', 'agent', 'sessions');
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--dry-run') dryRun = true;
    else if (a === '--source') {
      const v = argv[++i];
      if (!v) throw new Error('--source needs a directory');
      source = resolve(v.startsWith('~') ? join(homedir(), v.slice(1)) : v);
    } else throw new Error(`unknown argument: ${a}（用法：import-pi [--dry-run] [--source <dir>]）`);
  }
  const cfg = loadLocalConfig();
  console.warn('⚠ 请先停止该 NOPEAR_HOME 的 worker（导入期间 sessions.json 会被改写）');
  console.log(`来源：${source}\nNOPEAR_HOME：${cfg.home}\n会话目录：${cfg.sessionsDir}${dryRun ? '\n（dry run：不写任何文件）' : ''}`);
  const r = await importPiSessions({ source, cfg, dryRun });
  const k = r.skipped;
  console.log([
    `—— 汇总${dryRun ? '（dry run）' : ''} ——`,
    `发现：${r.found}`,
    `${dryRun ? '将导入' : '已导入'}：${r.imported}`,
    `跳过：临时目录 ${k.temp} / 空会话 ${k.empty} / 无效文件 ${k.invalid} / 已导入 ${k.alreadyImported}`,
    `${dryRun ? '将复制' : '已复制'}：${mb(r.bytes)}（${r.bytes} B）`,
  ].join('\n'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
