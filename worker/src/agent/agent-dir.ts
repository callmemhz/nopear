// Background subagents (pi-subagents spawns the `pi` CLI) inherit PI_CODING_AGENT_DIR=$NOPEAR_HOME/agent
// and read <agentDir>/auth.json + models.json. Only the in-process ModelRuntime gets NOPEAR_PI_AUTH /
// NOPEAR_PI_MODELS, so link those files into the agent dir when it has none of its own.
import { existsSync, lstatSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

export function ensureAgentDirCredentials(
  cfg: { agentDir: string; piAuthPath: string; piModelsPath: string },
  log: (msg: string) => void = (m) => console.warn(m),
): void {
  for (const [name, src] of [['auth.json', cfg.piAuthPath], ['models.json', cfg.piModelsPath]] as const) {
    const dest = join(cfg.agentDir, name);
    let present = false;
    try { lstatSync(dest); present = true; } catch { /* missing */ }
    if (present) continue; // own file or existing link: leave it
    if (!existsSync(src)) continue;
    try {
      symlinkSync(src, dest);
      log(`[nopear] linked ${dest} → ${src} (for background subagents)`);
    } catch (err) {
      log(`[nopear] could not link ${dest} → ${src}: ${(err as Error)?.message ?? err}`);
    }
  }
}
