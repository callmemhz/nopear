// One-line summaries for tool cards.
const MAX = 120;
const clip = (s: string) => (s.length > MAX ? s.slice(0, MAX - 1) + '…' : s);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

export function toolSummary(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const i = input as Record<string, unknown>;
  const path = str(i.path) || str(i.file_path);
  switch (name) {
    case 'bash': case 'powershell': return clip(str(i.command).replace(/\s+/g, ' ').trim());
    case 'read': case 'edit': case 'write': case 'ls': return clip(path);
    case 'grep': case 'find': return clip([str(i.pattern), path].filter(Boolean).join(' · '));
    case 'ask_user_question': return `${Array.isArray(i.questions) ? i.questions.length : 0} 个问题`;
    case 'subagent': return clip([str(i.agent), str(i.task) || str(i.goal)].filter(Boolean).join(' · '));
    default: {
      const first = Object.values(i).find((v) => typeof v === 'string') as string | undefined;
      return first ? clip(first.replace(/\s+/g, ' ')) : '';
    }
  }
}
