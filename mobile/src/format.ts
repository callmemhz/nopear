// Small display helpers shared by screens.
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return '刚刚';
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} 天前`;
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function duration(fromIso: string, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - Date.parse(fromIso)) / 1000));
  if (!Number.isFinite(s)) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h${m}m`;
  if (m) return `${m}m${sec}s`;
  return `${sec}s`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function shortPath(p: string, max = 36): string {
  return p.length <= max ? p : `…${p.slice(-(max - 1))}`;
}

export const sessionHref = (workerId: string, sessionId: string) =>
  `/s/${encodeURIComponent(workerId)}/${encodeURIComponent(sessionId)}`;

export const projectHref = (projectId: string) => `/project/${encodeURIComponent(projectId)}`;

/** Display title of a session. */
export function sessionTitle(s: { title: string }): string {
  return s.title || '未命名会话';
}

/** Avatar initials from an email: 「john.doe@x」 → JD, 「alice@x」 → AL, empty → ?. */
export function initials(email: string | null | undefined): string {
  const name = (email ?? '').split('@')[0] ?? '';
  const parts = name.split(/[._\-+]/).filter(Boolean);
  const s = parts.length >= 2 ? parts[0]![0]! + parts[1]![0]! : name.slice(0, 2);
  return (s || '?').toUpperCase();
}

/** Composer model chip: the worker's display name for the model, else the id without its provider prefix. */
export function modelLabel(id: string | null | undefined, models: { id: string; name: string }[] = []): string {
  if (!id) return '默认模型';
  return models.find((m) => m.id === id)?.name || id.slice(id.lastIndexOf('/') + 1) || id;
}
