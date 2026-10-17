// Pure helpers for the new-session working-directory picker (DirPickerSheet + recent list in app/new.tsx).
import type { RpcArgs } from '@nopear/protocol';
import type { CwdSuggestion } from '@nopear/core';

export function dirsListArgs(path: string | undefined, showHidden: boolean): RpcArgs<'dirs.list'> {
  const args: RpcArgs<'dirs.list'> = {};
  if (path) args.path = path;
  if (showHidden) args.showHidden = true;
  return args;
}

/** Where 「浏览…」 starts: the typed cwd, else undefined (= the worker's defaultCwd). */
export const pickerStart = (cwd: string): string | undefined => cwd.trim() || undefined;

export function cwdChip(s: CwdSuggestion): { title: string; subtitle?: string } {
  return s.kind === 'project' ? { title: `📁 ${s.label ?? s.path}`, subtitle: s.path } : { title: s.path };
}
