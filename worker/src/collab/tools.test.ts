import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_CATALOG, type Card, type SessionIndexEntry, type ToolName, type ToolOutcome } from '@nopear/protocol';
import type { CollabLink } from './link';
import { createCollabTools } from './tools';

class FakeLink implements CollabLink {
  readonly workerId = 'w1';
  calls: { name: ToolName; args: Record<string, unknown>; sessionId?: string }[] = [];
  constructor(private answer: (name: ToolName, args: Record<string, unknown>) => ToolOutcome) {}
  connected(): boolean { return true; }
  async callTool(name: ToolName, args: Record<string, unknown>, sessionId?: string): Promise<ToolOutcome> {
    this.calls.push({ name, args, sessionId });
    return this.answer(name, args);
  }
  sendIndex(_f: { full: boolean; sessions: SessionIndexEntry[]; removed: string[] }): void {}
  sendCardState(_f: { cardId: string; state: 'running' | 'review'; sessionId?: string; error?: string }): void {}
  onCards(_fn: (cards: Card[]) => void): () => void { return () => {}; }
  onProjectsChanged(_fn: () => void): () => void { return () => {}; }
  onConnected(_fn: () => void): () => void { return () => {}; }
  onClaimChanged(_fn: (s: { claimed: boolean; userId?: string }) => void): () => void { return () => {}; }
}

type Exec = (id: string, args: unknown) => Promise<{ content: { type: string; text: string }[] }>;
const exec = (t: unknown): Exec => (t as { execute: Exec }).execute;

test('createCollabTools yields one tool per TOOL_CATALOG entry with the catalog schema', () => {
  const tools = createCollabTools(() => undefined, 's1');
  assert.deepEqual(tools.map((t) => t.name), TOOL_CATALOG.map((d) => d.name));
  assert.equal(tools.length, 15);
  for (const [i, t] of tools.entries()) {
    const def = TOOL_CATALOG[i]!;
    assert.equal(t.description, def.description);
    const params = t.parameters as unknown as { type: string; properties: Record<string, unknown>; required?: readonly string[] };
    assert.equal(params.type, 'object');
    assert.deepEqual(params.properties, def.parameters.properties);
    assert.deepEqual(params.required, def.parameters.required);
  }
});

test('execute forwards (name, args, sessionId) and returns the result as pretty JSON text', async () => {
  const link = new FakeLink(() => ({ ok: true, result: { cards: [{ id: 'c1' }] } }));
  const tools = createCollabTools(() => link, 's1');
  const t = tools.find((x) => x.name === 'card_list')!;
  const r = await exec(t)('call1', { projectId: 'p1' });
  assert.deepEqual(link.calls, [{ name: 'card_list', args: { projectId: 'p1' }, sessionId: 's1' }]);
  assert.equal(r.content[0]!.type, 'text');
  assert.equal(r.content[0]!.text, JSON.stringify({ cards: [{ id: 'c1' }] }, null, 2));
});

test('error outcome → {error} JSON text', async () => {
  const error = { code: 'not_found' as const, message: 'no project p9' };
  const link = new FakeLink(() => ({ ok: false, error }));
  const t = createCollabTools(() => link, 's1').find((x) => x.name === 'project_get')!;
  const r = await exec(t)('call1', { projectId: 'p9' });
  assert.equal(r.content[0]!.text, JSON.stringify({ error }));
});

test('no link → saas_unreachable without calling anything', async () => {
  const t = createCollabTools(() => undefined, 's1').find((x) => x.name === 'project_list')!;
  const r = await exec(t)('call1', {});
  const parsed = JSON.parse(r.content[0]!.text) as { error: { code: string; message: string } };
  assert.equal(parsed.error.code, 'saas_unreachable');
  assert.equal(typeof parsed.error.message, 'string');
});
