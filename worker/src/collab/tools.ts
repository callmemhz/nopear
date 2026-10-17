// Native collaboration tools: one pi tool per TOOL_CATALOG entry, proxied to the SaaS executor over
// the tunnel (t:'tool' carrying the calling session's id). Results go back to the model as JSON text.
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { TOOL_CATALOG, type ToolOutcome } from '@nopear/protocol';
import type { CollabLink } from './link';

const UNREACHABLE: ToolOutcome = { ok: false, error: { code: 'saas_unreachable', message: 'SaaS 隧道未连接' } };

export function outcomeText(out: ToolOutcome): string {
  return out.ok ? JSON.stringify(out.result, null, 2) : JSON.stringify({ error: out.error });
}

export function createCollabTools(link: () => CollabLink | undefined, sessionId: string): ToolDefinition[] {
  return TOOL_CATALOG.map((def) => defineTool({
    name: def.name,
    label: def.name,
    description: def.description,
    parameters: Type.Unsafe<Record<string, unknown>>(def.parameters as never),
    async execute(_toolCallId, args) {
      const l = link();
      const out = l ? await l.callTool(def.name, (args ?? {}) as Record<string, unknown>, sessionId) : UNREACHABLE;
      return { content: [{ type: 'text' as const, text: outcomeText(out) }], details: {} };
    },
  }) as unknown as ToolDefinition);
}
