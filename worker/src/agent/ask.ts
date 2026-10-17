// ask_user_question tool: opens a Prompt, waits for prompts.answer / abort / timeout.
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { AskQuestion, Prompt } from '@nopear/protocol';

export interface AskBridge {
  sessionId: string;
  open(p: Prompt): void;
  wait(sessionId: string, promptId: string, signal: AbortSignal): Promise<{ answers: Record<string, string>; note?: string } | 'timeout'>;
}

const Params = Type.Object({
  questions: Type.Array(Type.Object({
    question: Type.String({ description: 'The full question text' }),
    header: Type.String({ description: 'Short label (≤12 chars)' }),
    multiSelect: Type.Boolean({ description: 'Allow selecting multiple options' }),
    options: Type.Array(Type.Object({ label: Type.String(), description: Type.Optional(Type.String()) }), { minItems: 2, maxItems: 6 }),
  }), { minItems: 1, maxItems: 4 }),
});

export function createAskTool(bridge: AskBridge): ToolDefinition {
  return defineTool({
    name: 'ask_user_question',
    label: 'Ask user',
    description: 'Ask the user 1-4 multiple-choice questions and wait for their answers. Use when you need a decision from the user.',
    parameters: Params,
    async execute(toolCallId, params, signal) {
      const questions = params.questions as AskQuestion[];
      bridge.open({ id: toolCallId, sessionId: bridge.sessionId, questions, createdAt: new Date().toISOString() });
      const r = await bridge.wait(bridge.sessionId, toolCallId, signal ?? new AbortController().signal);
      if (r === 'timeout') return { content: [{ type: 'text', text: '用户未作答（超时）。' }], details: {} };
      const lines = questions.map((q) => `"${q.question}" → "${r.answers[q.question] ?? ''}"`);
      if (r.note) lines.push(`note: ${r.note}`);
      return { content: [{ type: 'text', text: lines.join('\n') }], details: {} };
    },
  }) as unknown as ToolDefinition;
}
