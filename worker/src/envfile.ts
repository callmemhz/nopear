// Minimal .env editing: remove a key's line(s) in place (used to drop the one-time NOPEAR_INSTALL_CODE after
// registration). Comments, other keys and line endings are left untouched; the write is atomic (tmp + rename).
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Removes every `KEY=…` / `export KEY=…` line. Returns true when the file changed; missing file/key → false. */
export function removeEnvKey(path: string, key: string): boolean {
  if (!existsSync(path)) return false;
  const text = readFileSync(path, 'utf8');
  const re = new RegExp(`^\\s*(export\\s+)?${escapeRe(key)}=`);
  const lines = text.split('\n');
  const kept = lines.filter((l) => !re.test(l));
  if (kept.length === lines.length) return false;
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, kept.join('\n'), { mode: statSync(path).mode & 0o777 });
  renameSync(tmp, path);
  return true;
}
