// Editable AGENTS.md memory: global = $NOPEAR_HOME/agent/AGENTS.md, project = $NOPEAR_DEFAULT_CWD/AGENTS.md.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { MemoryFile, MemoryScope } from '@nopear/protocol';
import type { WorkerConfig } from './config';

const pathOf = (cfg: WorkerConfig, scope: MemoryScope) =>
  scope === 'global' ? join(cfg.agentDir, 'AGENTS.md') : join(cfg.defaultCwd, 'AGENTS.md');

async function read(cfg: WorkerConfig, scope: MemoryScope): Promise<MemoryFile> {
  const path = pathOf(cfg, scope);
  try { return { scope, path, content: await readFile(path, 'utf8'), exists: true }; }
  catch { return { scope, path, content: '', exists: false }; }
}

export async function readMemory(cfg: WorkerConfig): Promise<MemoryFile[]> {
  return Promise.all((['global', 'project'] as const).map((s) => read(cfg, s)));
}

export async function writeMemory(cfg: WorkerConfig, scope: MemoryScope, content: string): Promise<MemoryFile> {
  const path = pathOf(cfg, scope);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
  return { scope, path, content, exists: true };
}
