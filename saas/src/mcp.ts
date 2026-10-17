import type { FastifyInstance, FastifyReply } from 'fastify';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_CATALOG, validateToolArgs, type ToolOutcome } from '@nopear/protocol';

/** MCP 端点：无状态 Streamable HTTP，工具即 TOOL_CATALOG，执行交给 SaaS 统一执行器。 */
export interface McpDeps {
  /** 个人 API token → userId；无效 → null。 */
  authenticate(token: string): Promise<string | null>;
  executeTool(caller: { userId: string; workerId: null }, name: string, args: unknown): Promise<ToolOutcome>;
}

const SERVER_INFO = { name: 'nopear', version: '3.1.0' };

function bearer(header: string | undefined): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? '');
  return m?.[1]?.trim() || null;
}

function buildServer(deps: McpDeps, userId: string): Server {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_CATALOG.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name } = req.params;
    const args = req.params.arguments ?? {};
    const invalid = validateToolArgs(name, args);
    if (invalid) throw new McpError(ErrorCode.InvalidParams, invalid);
    const out = await deps.executeTool({ userId, workerId: null }, name, args);
    if (out.ok) return { content: [{ type: 'text' as const, text: JSON.stringify(out.result) }] };
    return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: out.error }) }] };
  });
  return server;
}

export function registerMcp(app: FastifyInstance, deps: McpDeps): void {
  app.post('/mcp', async (req, reply) => {
    const token = bearer(req.headers.authorization);
    const userId = token ? await deps.authenticate(token) : null;
    if (!userId) return reply.code(401).send({ error: { code: 'unauthorized', message: 'invalid or missing API token' } });

    const server = buildServer(deps, userId);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (e) {
      req.log.error({ err: e }, 'mcp request failed');
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
        reply.raw.end(JSON.stringify({ jsonrpc: '2.0', error: { code: ErrorCode.InternalError, message: 'internal error' }, id: null }));
      }
    }
  });
  const notAllowed = async (_req: unknown, reply: FastifyReply) =>
    reply.code(405).send({ error: { code: 'method_not_allowed', message: 'stateless MCP: POST only' } });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);
}
