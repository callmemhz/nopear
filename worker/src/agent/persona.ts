// Identity rewrite of pi's default system prompt. Prompt text only — no request
// headers or client identifiers are touched anywhere.
const PI_IDENTITY = 'You are an expert coding assistant operating inside pi, a coding agent harness.';

const suffixOf = (persona: string): string => `When asked who or what you are, say you are ${persona}.`;

/** Idempotent: rewriting an already-rewritten prompt returns it unchanged (SYSTEM.md is rewritten by
 *  systemPromptOverride and again by the before_agent_start hook). */
export function rewriteSystemPrompt(base: string | undefined, persona: string): string | undefined {
  if (base === undefined) return undefined;
  let out = base.split(PI_IDENTITY).join(`You are ${persona}, an expert coding assistant.`);
  // Drop the "Pi documentation (...):" heading and its "- ..." bullet lines.
  out = out.replace(/\n*Pi documentation[^\n]*(?:\n- [^\n]*)*/g, '');
  const suffix = suffixOf(persona);
  out = out.trimEnd();
  if (out.endsWith(suffix) || out.includes(`\n\n${suffix}\n\n`)) return out;
  return `${out}\n\n${suffix}`;
}

/** Append `extra` (e.g. the PM brain prompt) once; a prompt that already contains it is returned as-is. */
export function appendOnce(prompt: string | undefined, extra: string | undefined): string | undefined {
  if (prompt === undefined || !extra) return prompt;
  if (prompt.includes(extra)) return prompt;
  return `${prompt}\n\n${extra}`;
}
