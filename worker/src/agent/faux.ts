// Test-only scripted model (NOPEAR_TEST_FAUX=1): provider "faux", model "faux/echo".
//  - last message is an ask_user_question result → "answered"
//  - last message is any other tool result → "answered: <tool result text>" (first 4000 chars)
//  - last user text starts with "ask:"    → calls ask_user_question (1 question, 2 options)
//  - last user text "tool:<name> <json>"  → calls tool <name> with the JSON args (no json → {})
//  - last user text starts with "sys:"    → "system: <system prompt>"
//  - last user text starts with "slow:"   → waits 400ms, then echoes (lets tests observe a running session)
//  - otherwise                             → thinking + streamed "echo: <text>"
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall, type FauxResponseFactory } from '@earendil-works/pi-ai';

const registered = new WeakSet<ModelRuntime>();

type Msg = { role: string; content?: unknown; toolName?: string };
const textOf = (m: Msg | undefined): string =>
  !m ? '' : typeof m.content === 'string' ? m.content
    : Array.isArray(m.content) ? (m.content as Array<{ type: string; text?: string }>).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('') : '';

export function maybeRegisterFaux(rt: ModelRuntime, env: NodeJS.ProcessEnv = process.env): void {
  if (env.NOPEAR_TEST_FAUX !== '1' || registered.has(rt)) return;
  registered.add(rt);
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'echo', name: 'Faux Echo', reasoning: true, input: ['text', 'image'] }], tokensPerSecond: 400 });
  const respond: FauxResponseFactory = async (context) => {
    faux.appendResponses([respond]); // keep the script queue non-empty
    const msgs = context.messages as Msg[];
    const last = msgs[msgs.length - 1];
    if (last?.role === 'toolResult') {
      return fauxAssistantMessage(last.toolName === 'ask_user_question' ? 'answered' : `answered: ${textOf(last).slice(0, 4000)}`);
    }
    const user = [...msgs].reverse().find((m) => m.role === 'user');
    const text = textOf(user);
    if (text.startsWith('ask:')) {
      return fauxAssistantMessage(fauxToolCall('ask_user_question', {
        questions: [{ question: 'Pick one?', header: 'Choice', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }],
      }), { stopReason: 'toolUse' });
    }
    if (text.startsWith('tool:')) {
      const rest = text.slice('tool:'.length).trim();
      const sp = rest.indexOf(' ');
      const name = sp < 0 ? rest : rest.slice(0, sp);
      const json = sp < 0 ? '' : rest.slice(sp + 1).trim();
      return fauxAssistantMessage(fauxToolCall(name, JSON.parse(json || '{}')), { stopReason: 'toolUse' });
    }
    if (text.startsWith('sys:')) return fauxAssistantMessage(`system: ${context.systemPrompt ?? ''}`);
    if (text.startsWith('slow:')) await new Promise((r) => setTimeout(r, 400));
    return fauxAssistantMessage([fauxThinking('thinking about it'), fauxText(`echo: ${text}`)]);
  };
  faux.setResponses([respond]);
  rt.registerNativeProvider(faux.provider);
}
