// Private-directory helper: NOPEAR_HOME and its subdirs hold the worker secret, client keys' authz
// cache, sessions and blobs — owner-only (0700).
import { chmodSync, mkdirSync, statSync } from 'node:fs';

/** mkdir -p with mode 0700; tightens an existing directory that is looser than 0700. */
export function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if ((statSync(path).mode & 0o777) !== 0o700) chmodSync(path, 0o700);
}
