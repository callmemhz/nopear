import { describe, expect, it } from 'vitest';
import {
  authzMessage, formatCursor, parseCursor, sessionKey, isBinaryOp, type Empty, type RequestHeader,
  CARD_MOVE_STATES, CARD_STATES, HEADER_PLAIN, INSTALL_CODE_TTL_MS, MEMORY_MAX_BYTES, PLAINTEXT_DISABLED_MESSAGE, SAAS_CLIENT_PUB,
  SESSION_CLASS_TOOLS, TOOL_CATALOG, memoryKey, sessionIndexEntry, validateToolArgs, type JsonObjectSchema, type Session,
} from './index';

describe('protocol helpers', () => {
  it('round-trips cursors', () => {
    expect(formatCursor('ab12cd34', 7)).toBe('ab12cd34.7');
    expect(parseCursor('ab12cd34.7')).toEqual({ epoch: 'ab12cd34', n: 7 });
  });
  it('rejects malformed cursors', () => {
    for (const c of ['', 'x', 'a.', '.3', 'a.-1', 'a.1.2', 'a.b', `a.${'9'.repeat(400)}`, 'a.9007199254740992']) {
      expect(parseCursor(c)).toBeNull();
    }
    expect(parseCursor('a.9007199254740991')).toEqual({ epoch: 'a', n: Number.MAX_SAFE_INTEGER });
  });
  it('builds the authz message', () => {
    expect(authzMessage('u1', 'PUB')).toBe('nopear-authz:v3:u1:PUB');
  });
  it('builds session keys and flags binary ops', () => {
    expect(sessionKey('w_1', 's1')).toBe('w_1/s1');
    expect(isBinaryOp('files.read')).toBe(true);
    expect(isBinaryOp('sessions.list')).toBe(false);
  });
  it('links RequestHeader args to op (compile-time)', () => {
    const ok: RequestHeader = { v: 3, rid: 'r', ts: 0, op: 'sessions.get', args: { sessionId: 's' } };
    const watch: RequestHeader = { v: 3, rid: 'r', ts: 0, op: 'machine.watch', args: {} satisfies Empty };
    // @ts-expect-error args must match the op
    const bad: RequestHeader = { v: 3, rid: 'r', ts: 0, op: 'sessions.get', args: { projectId: 'p' } };
    expect([ok.op, watch.op, bad.op]).toEqual(['sessions.get', 'machine.watch', 'sessions.get']);
  });
});

describe('collab contract', () => {
  it('constants', () => {
    expect(HEADER_PLAIN).toBe('x-nopear-plain');
    expect(INSTALL_CODE_TTL_MS).toBe(30 * 60 * 1000);
    expect(MEMORY_MAX_BYTES).toBe(64 * 1024);
    expect(SAAS_CLIENT_PUB).toBe('saas');
    expect(PLAINTEXT_DISABLED_MESSAGE).toBe('plaintext disabled on this worker');
    expect(CARD_STATES).toEqual(['inbox', 'queued', 'running', 'review', 'done']);
    expect(CARD_MOVE_STATES).toEqual(['inbox', 'queued', 'done']);
  });
  it('catalog has the 15 spec tools in order', () => {
    expect(TOOL_CATALOG.map((t) => t.name)).toEqual([
      'project_list', 'project_get', 'project_create', 'project_update', 'card_list', 'card_create', 'card_update',
      'card_move', 'memory_get', 'memory_update', 'machine_list', 'session_list', 'session_history', 'session_start', 'session_tag',
    ]);
    expect(SESSION_CLASS_TOOLS).toEqual(['session_history', 'session_start', 'session_tag']);
    for (const t of TOOL_CATALOG) { expect(t.parameters.type).toBe('object'); expect(t.description.length).toBeGreaterThan(0); }
  });
  it('validateToolArgs', () => {
    expect(validateToolArgs('project_list', {})).toBeNull();
    expect(validateToolArgs('nope', {})).toMatch(/unknown tool/);
    expect(validateToolArgs('card_create', {})).toMatch(/title/);
    expect(validateToolArgs('card_create', { title: 3 })).toMatch(/title/);
    expect(validateToolArgs('card_move', { cardId: 'c', state: 'running' })).toMatch(/state/);
    expect(validateToolArgs('card_move', { cardId: 'c', state: 'queued', workerId: 'w_1', order: 2 })).toBeNull();
    expect(validateToolArgs('session_tag', { workerId: 'w', sessionId: 's', projectId: null })).toBeNull();
    expect(validateToolArgs('memory_update', { scope: 'global', content: 'x', mode: 'replace', extra: 1 })).toMatch(/extra/);
    expect(validateToolArgs('session_history', { workerId: 'w', sessionId: 's', limit: 1.5 })).toMatch(/limit/);
    expect(validateToolArgs('project_list', null)).toMatch(/object/);
    expect(validateToolArgs('session_list', { limit: 0 })).toMatch(/limit out of range/);
    expect(validateToolArgs('session_list', { limit: 501 })).toMatch(/limit out of range/);
    expect(validateToolArgs('session_list', { limit: 500 })).toBeNull();
    expect(validateToolArgs('card_create', { title: 't', projectId: 5 })).toMatch(/projectId must be string or null/);
    expect(validateToolArgs('project_list', [])).toMatch(/object/);
    expect(validateToolArgs('card_move', { cardId: 'c', state: 'inbox', order: Number.NaN })).toMatch(/order must be number/);
    expect(validateToolArgs('card_move', { cardId: 'c', state: 'inbox', order: Number.POSITIVE_INFINITY })).toMatch(/order must be number/);
    expect(validateToolArgs('session_list', { limit: Number.POSITIVE_INFINITY })).toMatch(/limit must be integer/);
    expect(validateToolArgs('card_list', { state: 'bogus' })).toMatch(/state must be one of/);
    expect(validateToolArgs('card_create', { title: undefined })).toMatch(/missing required argument: title/);
    expect(validateToolArgs('memory_get', { scope: 'global', projectId: null })).toBeNull();
    expect(validateToolArgs('memory_update', { scope: 'global', projectId: null, content: 'x', mode: 'append' })).toBeNull();
  });
  it('every required key is a declared property', () => {
    for (const t of TOOL_CATALOG) {
      const keys = Object.keys(t.parameters.properties);
      for (const r of t.parameters.required ?? []) expect(keys, `${t.name}.${r}`).toContain(r);
    }
  });
  it('ToolDef.parameters exposes object-schema fields without casts', () => {
    const req: readonly string[] | undefined = TOOL_CATALOG[1]!.parameters.required;
    const props: JsonObjectSchema['properties'] = TOOL_CATALOG[1]!.parameters.properties;
    expect(req).toEqual(['projectId']);
    expect(Object.keys(props)).toEqual(['projectId']);
  });
  it('memoryKey + sessionIndexEntry', () => {
    expect(memoryKey('global', null)).toBe('global');
    expect(memoryKey('project', 'p_1')).toBe('project:p_1');
    expect(() => memoryKey('project', null)).toThrow(/projectId/);
    expect(() => memoryKey('project', '')).toThrow(/projectId/);
    const s = { id: 's1', workerId: 'w1', kind: 'chat', title: 't', cwd: '/x', status: 'idle', createdAt: 'a', lastActivityAt: 'b',
      preview: 'p', pinned: false, starred: false, archived: false, model: 'm', thinking: 'off', promptCount: 0, taskCount: 0 } as Session;
    expect(sessionIndexEntry(s)).toEqual({ workerId: 'w1', sessionId: 's1', title: 't', preview: 'p', status: 'idle', projectId: null, cwd: '/x', createdAt: 'a', lastActivityAt: 'b' });
  });
});
