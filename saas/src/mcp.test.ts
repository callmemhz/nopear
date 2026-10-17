import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_CATALOG, type ToolOutcome } from '@nopear/protocol';
import { registerMcp } from './mcp';

const calls: Array<{ caller: unknown; name: string; args: unknown }> = [];
let next: ToolOutcome = { ok: true, result: { cards: [] } };

const app = Fastify();
registerMcp(app, {
  authenticate: async (t) => (t === 'good' ? 'u1' : null),
  executeTool: async (caller, name, args) => {
    calls.push({ caller, name, args });
    return next;
  },
});
await app.listen({ port: 0, host: '127.0.0.1' });
const addr = app.server.address();
const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
after(async () => { await app.close(); });

async function connect(): Promise<Client> {
  const client = new Client({ name: 'test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
    requestInit: { headers: { authorization: 'Bearer good' } },
  });
  await client.connect(transport);
  return client;
}

test('initialize + tools/list returns the 15 catalog tools with their JSON Schemas', async () => {
  const client = await connect();
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 15);
    assert.deepEqual(tools.map((t) => t.name), TOOL_CATALOG.map((t) => t.name));
    for (const def of TOOL_CATALOG) {
      const t = tools.find((x) => x.name === def.name)!;
      assert.equal(t.description, def.description);
      assert.deepEqual(t.inputSchema, JSON.parse(JSON.stringify(def.parameters)));
    }
  } finally {
    await client.close();
  }
});

test('tools/call success → content[0].text is JSON of result', async () => {
  next = { ok: true, result: { cards: [] } };
  const client = await connect();
  try {
    const r = await client.callTool({ name: 'card_list', arguments: {} });
    assert.equal(r.isError, undefined);
    const content = r.content as Array<{ type: string; text: string }>;
    assert.equal(content[0]?.type, 'text');
    assert.deepEqual(JSON.parse(content[0]!.text), { cards: [] });
  } finally {
    await client.close();
  }
});

test('tools/call tool error → isError:true and text {error:{code,message}}', async () => {
  next = { ok: false, error: { code: 'not_found', message: 'no such card' } };
  const client = await connect();
  try {
    const r = await client.callTool({ name: 'card_update', arguments: { cardId: 'c_x', title: 't' } });
    assert.equal(r.isError, true);
    const content = r.content as Array<{ type: string; text: string }>;
    assert.deepEqual(JSON.parse(content[0]!.text), { error: { code: 'not_found', message: 'no such card' } });
  } finally {
    await client.close();
  }
});

test('tools/call invalid args → JSON-RPC error code -32602', async () => {
  const before = calls.length;
  const client = await connect();
  try {
    await assert.rejects(
      client.callTool({ name: 'card_move', arguments: { cardId: 'c_x', state: 'running' } }),
      (e: unknown) => e instanceof McpError && e.code === -32602,
    );
    await assert.rejects(
      client.callTool({ name: 'project_get', arguments: {} }),
      (e: unknown) => e instanceof McpError && e.code === -32602,
    );
    assert.equal(calls.length, before, 'executeTool must not be called');
  } finally {
    await client.close();
  }
});

test('bad token → HTTP 401', async () => {
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '1' } },
  });
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const bad = await fetch(base + '/mcp', { method: 'POST', headers: { ...headers, authorization: 'Bearer nope' }, body });
  assert.equal(bad.status, 401);
  assert.equal(((await bad.json()) as { error: { code: string } }).error.code, 'unauthorized');
  const none = await fetch(base + '/mcp', { method: 'POST', headers, body });
  assert.equal(none.status, 401);
});

test('GET /mcp and DELETE /mcp → 405', async () => {
  for (const method of ['GET', 'DELETE']) {
    const r = await fetch(base + '/mcp', { method, headers: { authorization: 'Bearer good' } });
    assert.equal(r.status, 405, method);
    assert.equal(((await r.json()) as { error: { code: string } }).error.code, 'method_not_allowed');
  }
});

test('executeTool receives caller {userId:\'u1\', workerId:null}', async () => {
  next = { ok: true, result: { projects: [] } };
  calls.length = 0;
  const client = await connect();
  try {
    await client.callTool({ name: 'project_list', arguments: {} });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { caller: { userId: 'u1', workerId: null }, name: 'project_list', args: {} });
  } finally {
    await client.close();
  }
});
