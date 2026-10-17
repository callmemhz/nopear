// Session-workspace file browsing (ported from v2 files.ts). Paths resolve against the
// session cwd but may escape it (`..`/absolute) — no sandbox by design: an authorized client can
// already run arbitrary code through sessions.
import { readdir, readFile, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { FILE_READ_MAX_BYTES, FILES_MAX_ENTRIES, type BinaryResult, type FileEntry, type FileListing } from '@nopear/protocol';
import { OpError } from './errors';

const resolvePath = (root: string, rel?: string) => resolve(resolve(root), rel || '.');

export async function listDir(root: string, path?: string): Promise<FileListing> {
  const abs = resolvePath(root, path);
  let names: import('node:fs').Dirent[];
  try { names = await readdir(abs, { withFileTypes: true }); } catch { throw new OpError('not_found', 'directory not found'); }
  const entries: FileEntry[] = [];
  for (const d of names) {
    let st: Stats;
    try { st = await stat(resolve(abs, d.name)); } catch { continue; } // follow symlinks; skip broken
    if (st.isDirectory()) entries.push({ name: d.name, type: 'dir', size: 0, mtime: st.mtime.toISOString() });
    else if (st.isFile()) entries.push({ name: d.name, type: 'file', size: st.size, mtime: st.mtime.toISOString() });
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  const truncated = entries.length > FILES_MAX_ENTRIES;
  return { path: abs, entries: truncated ? entries.slice(0, FILES_MAX_ENTRIES) : entries, truncated };
}

const expandHome = (p: string) => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

/** Machine-level directory picker (`dirs.list`): sub-directories only of `path` (absolute, `~`/`~/x`, or relative to
 *  `defaultCwd`; default = `defaultCwd`). Not sandboxed — same trust model as `files.list`. */
export async function listDirs(defaultCwd: string, path?: string, showHidden = false): Promise<FileListing> {
  const abs = resolvePath(defaultCwd, path ? expandHome(path) : undefined);
  let names: import('node:fs').Dirent[];
  try { names = await readdir(abs, { withFileTypes: true }); } catch { throw new OpError('not_found', 'directory not found'); }
  const entries: FileEntry[] = [];
  for (const d of names) {
    if (!showHidden && d.name.startsWith('.')) continue;
    if (!d.isDirectory() && !d.isSymbolicLink()) continue; // cheap pre-filter; symlinks are resolved below
    let st: Stats;
    try { st = await stat(resolve(abs, d.name)); } catch { continue; }
    if (st.isDirectory()) entries.push({ name: d.name, type: 'dir', size: 0, mtime: st.mtime.toISOString() });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const truncated = entries.length > FILES_MAX_ENTRIES;
  return { path: abs, entries: truncated ? entries.slice(0, FILES_MAX_ENTRIES) : entries, truncated };
}

export async function readFileForDownload(root: string, path: string): Promise<BinaryResult> {
  const abs = resolvePath(root, path);
  let st: Stats;
  try { st = await stat(abs); } catch { throw new OpError('not_found', 'file not found'); }
  if (!st.isFile()) throw new OpError('bad_request', 'not a file');
  if (st.size > FILE_READ_MAX_BYTES) throw new OpError('too_large', 'file exceeds the 100MB download cap');
  return { bytes: new Uint8Array(await readFile(abs)), mediaType: 'application/octet-stream', name: basename(abs) };
}
