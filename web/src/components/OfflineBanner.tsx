import { useEngine } from '../engine';

export function OfflineBanner() {
  const machines = useEngine((s) => s.machines);
  const conn = useEngine((s) => s.machineConn);
  const syncing = useEngine((s) => s.syncing);
  if (syncing) return null; // cached snapshot on screen; presence not known yet
  const offline = Object.values(machines).filter((m) => !m.online || conn[m.workerId] === 'offline');
  if (offline.length === 0) return null;
  return (
    <div className="border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300">
      机器离线：{offline.map((m) => m.label || m.workerId).join('、')} —— 其会话暂不可操作，恢复在线后自动重连。
    </div>
  );
}
