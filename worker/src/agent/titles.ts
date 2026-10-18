// Session titles. A new session starts with its first prompt cut to 40 characters (`prompt`). After the first completed
// reply the worker asks the session's own model for a short topic title (`auto`). The agent can rename its session
// with the `session_rename` tool (`agent`), and a rename from a client is `user`. Precedence: user > agent > auto >
// prompt; a lower source never overwrites a higher one.
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

export type TitleSource = 'prompt' | 'auto' | 'agent' | 'user';
const RANK: Record<TitleSource, number> = { prompt: 0, auto: 1, agent: 2, user: 3 };
export const TITLE_MAX_CHARS = 40;
export const SESSION_RENAME_TOOL = 'session_rename';

/** Whether a title from `next` may replace the current one (missing source = a legacy first-prompt title). */
export function canRetitle(current: TitleSource | undefined, next: TitleSource): boolean {
  return RANK[next] >= RANK[current ?? 'prompt'];
}

/** Only sessions still showing their first prompt get an automatic title. */
export function wantsAutoTitle(current: TitleSource | undefined): boolean {
  return (current ?? 'prompt') === 'prompt';
}

/** Model output / agent input → a one-line title: no quotes, markdown or trailing punctuation; '' if nothing usable. */
export function cleanTitle(raw: string): string {
  const line = raw.split('\n').map((l) => l.trim()).find((l) => l) ?? '';
  const Q = '"\'“”‘’「」『』《》';
  const PUNCT = '。.!！?？,，;；:：、';
  let t = line.replace(/[*_`]/g, '').replace(/^[#>\-\s]+/, '').trim();
  t = t.replace(/^(?:title|标题)\s*[:：]\s*/i, '');
  // quotes and trailing punctuation can wrap each other ("「标题」。"): peel both until stable
  for (let prev = ''; prev !== t;) {
    prev = t;
    t = t.trim();
    while (t && Q.includes(t[0]!)) t = t.slice(1);
    while (t && (Q.includes(t.at(-1)!) || PUNCT.includes(t.at(-1)!))) t = t.slice(0, -1);
  }
  return [...t].slice(0, TITLE_MAX_CHARS).join('');
}

export const AUTO_TITLE_SYSTEM = [
  'You name chat sessions. Reply with the title only — no quotes, no trailing punctuation, no explanation.',
  'At most 16 Chinese characters or 8 English words. Use the language of the user\'s message.',
  'Describe the task or topic concretely (e.g. "爬山游戏改赛璐璐画风", "Fix tunnel reconnect loop").',
].join(' ');

/** The single user turn sent to the title model: the opening exchange, both sides capped. */
export function autoTitlePrompt(firstUser: string, firstReply: string): string {
  const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
  return `User:\n${cap(firstUser.trim(), 1500)}\n\nAssistant:\n${cap(firstReply.trim(), 1500)}\n\nTitle:`;
}

/** Agent tool: rename the current session. `rename` returns null when applied, or the reason it was refused. */
export function createSessionRenameTool(o: { rename: (title: string) => Promise<string | null> }): ToolDefinition {
  return defineTool({
    name: SESSION_RENAME_TOOL,
    label: 'Rename session',
    description: '修改当前会话的标题（显示在会话列表里）。在话题明确、或对话方向明显变了、而现标题不能概括时使用；'
      + '标题要短（不超过 16 个字），具体描述任务。用户手动改过的标题不会被覆盖。'
      + ' Rename this session (the title shown in the session list); keep it short and concrete.',
    parameters: Type.Object({ title: Type.String({ description: 'New title, ≤16 Chinese characters / 8 English words' }) }),
    async execute(_toolCallId, params) {
      const title = cleanTitle(String((params as { title?: unknown }).title ?? ''));
      if (!title) throw new Error('title is empty');
      const refused = await o.rename(title);
      return { content: [{ type: 'text', text: refused ?? `会话标题已改为「${title}」` }], details: {} };
    },
  }) as unknown as ToolDefinition;
}
