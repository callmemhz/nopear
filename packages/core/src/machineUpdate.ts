// How a machine's worker version reads in the machines list (web + mobile), and whether "update" is offered.
import type { Machine } from '@nopear/protocol';

export type UpdateTone = 'ok' | 'info' | 'warn' | 'busy' | 'bad';
export interface MachineUpdateView {
  label: string; tone: UpdateTone;
  /** Offer the one-click update button. */
  canUpdate: boolean;
  /** How to update by hand when one click is not possible. */
  command?: string;
  hint?: string;
}

/** Major.minor of a worker version ('3.2.0' → [3, 2]). */
function mm(v: string): [number, number] {
  const [a, b] = v.split('.').map((x) => Number.parseInt(x, 10));
  return [Number.isFinite(a) ? a! : 0, Number.isFinite(b) ? b! : 0];
}

export function updateCommand(saasUrl: string): string {
  return `curl -fsSL ${saasUrl.replace(/\/+$/, '')}/update.sh | bash`;
}

/** null while offline (nothing known). */
export function machineUpdateView(m: Machine, saasUrl: string): MachineUpdateView | null {
  const u = m.update;
  if (!m.online || !u) return null;
  const command = updateCommand(saasUrl);
  if (u.state === 'downloading') return { label: u.message || '正在下载新版本…', tone: 'busy', canUpdate: false };
  if (u.state === 'waiting') return { label: u.message || '新版本已就绪，等会话空闲后重启', tone: 'busy', canUpdate: false };
  if (u.state === 'restarting') return { label: u.message || '正在重启', tone: 'busy', canUpdate: false };
  const [major, minor] = mm(m.version || '0');
  // Workers before 3.2 do not report their build and cannot update themselves: one manual update first.
  if (major < 3 || (major === 3 && minor < 2)) {
    return { label: '旧版本', tone: 'warn', canUpdate: false, command, hint: '需要在那台机器上手动更新一次，之后就能在这里一键更新' };
  }
  const failed = u.state === 'failed' ? `更新失败：${u.message || '未知原因'}` : null;
  if (!u.build) return { label: failed ?? '源码运行', tone: failed ? 'bad' : 'info', canUpdate: false, hint: '从源码目录运行的 worker：git pull 后重启更新' };
  const behind = !!u.latest && u.latest !== u.build;
  const manual = u.self ? {} : { command, hint: '这台 worker 不是以系统服务运行（或关闭了 NOPEAR_AUTO_UPDATE），请在那台机器上运行更新命令' };
  if (failed) return { label: failed, tone: 'bad', canUpdate: u.self, ...manual };
  if (behind) return { label: '有新版本', tone: 'warn', canUpdate: u.self, ...manual };
  return { label: u.latest ? '已是最新' : `构建 ${u.build}`, tone: 'ok', canUpdate: false };
}
