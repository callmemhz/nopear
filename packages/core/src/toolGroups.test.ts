import { describe, expect, it } from 'vitest';
import type { Block, Message } from '@nopear/protocol';
import type { ViewItem } from './timeline';
import {
  buildTurns, entryState, isLongText, sameEntries, sameSegments, summarizeTools, toolCategory, type GroupEntry, type Segment, type ToolEntry,
} from './toolGroups';

type Result = Extract<Block, { type: 'tool_result' }>;
const msg = (id: string, role: Message['role'], blocks: Block[], status: Message['status'] = 'complete'): Message =>
  ({ id, sessionId: 's', role, blocks, ts: '', status });
const item = (m: Message, results: Record<string, Result> = {}, progress: Record<string, string> = {}): ViewItem =>
  ({ message: m, results, resultImages: {}, resultFiles: {}, progress });
const call = (id: string, name: string, input: unknown = {}): Block => ({ type: 'tool_call', id, name, input });
const res = (id: string, name: string, isError = false): Result => ({ type: 'tool_result', toolCallId: id, toolName: name, text: 'out', isError });
const tool = (name: string, over: Partial<ToolEntry> = {}): GroupEntry =>
  ({ kind: 'tool', key: name + Math.random(), name, streaming: false, result: res('x', name), ...over });

describe('toolCategory', () => {
  it('maps known tool names', () => {
    expect(toolCategory('bash')).toBe('command');
    expect(toolCategory('powershell')).toBe('command');
    expect(toolCategory('read')).toBe('read');
    expect(toolCategory('write')).toBe('edit');
    expect(toolCategory('edit')).toBe('edit');
    expect(toolCategory('grep')).toBe('search');
    expect(toolCategory('find')).toBe('search');
    expect(toolCategory('ls')).toBe('search');
    expect(toolCategory('subagent')).toBe('subagent');
    expect(toolCategory('card_create')).toBe('other');
  });
});

describe('summarizeTools', () => {
  it('counts commands with failures', () => {
    const s = summarizeTools([tool('bash'), tool('bash'), tool('bash', { result: res('x', 'bash', true) }), tool('bash')]);
    expect(s.text).toBe('运行了 4 条命令（1 条失败）');
    expect(s.failed).toBe(1);
    expect(s.running).toBe(false);
  });
  it('reads files', () => expect(summarizeTools([tool('read'), tool('read'), tool('read')]).text).toBe('读取了 3 个文件'));
  it('mixed categories in order of first appearance', () => {
    expect(summarizeTools([tool('bash'), tool('read'), tool('bash')]).text).toBe('运行了 2 条命令，读取了 1 个文件');
    expect(summarizeTools([tool('edit'), tool('grep'), tool('ls'), tool('subagent'), tool('memory_get'), tool('card_list')]).text)
      .toBe('修改了 1 个文件，搜索了 2 次，启动了 1 个子任务，调用了 2 个工具');
  });
  it('ignores thinking entries and reports running tools', () => {
    const entries: GroupEntry[] = [tool('read'), { kind: 'thinking', key: 't', text: 'hm', streaming: false },
      tool('bash', { result: undefined, progress: 'partial' })];
    const s = summarizeTools(entries);
    expect(s.text).toBe('读取了 1 个文件，运行了 1 条命令');
    expect(s.running).toBe(true);
  });
  it('a tool without result counts as running only while the session is live', () => {
    const entries = [tool('bash', { result: undefined })];
    expect(summarizeTools(entries).running).toBe(false);
    expect(summarizeTools(entries, true).running).toBe(true);
  });
});

describe('entryState', () => {
  it('mirrors ToolCard states', () => {
    expect(entryState(tool('bash') as ToolEntry)).toBe('ok');
    expect(entryState(tool('bash', { result: res('x', 'bash', true) }) as ToolEntry)).toBe('error');
    expect(entryState(tool('bash', { result: undefined, streaming: true }) as ToolEntry)).toBe('running');
    expect(entryState(tool('bash', { result: undefined }) as ToolEntry)).toBe('pending');
    expect(entryState(tool('bash', { result: undefined }) as ToolEntry, true)).toBe('running');
  });
});

describe('buildTurns', () => {
  it('merges consecutive tool calls across assistant messages into one group; text breaks groups', () => {
    const items = [
      item(msg('u1', 'user', [{ type: 'text', text: 'hi' }])),
      item(msg('a1', 'assistant', [{ type: 'thinking', text: 'plan' }, { type: 'text', text: 'Let me look' }, call('c1', 'bash'), call('c2', 'read')]),
        { c1: res('c1', 'bash'), c2: res('c2', 'read') }),
      item(msg('a2', 'assistant', [{ type: 'thinking', text: 'more' }, call('c3', 'bash')]), {}, { c3: 'running…' }),
      item(msg('a3', 'assistant', [{ type: 'text', text: '' }, { type: 'text', text: 'Done' }, call('c4', 'edit')])),
    ];
    const turns = buildTurns(items);
    expect(turns.map((t) => t.kind)).toEqual(['message', 'assistant']);
    const a = turns[1]!;
    if (a.kind !== 'assistant') throw new Error();
    expect(a.key).toBe('a1');
    expect(a.segments.map((s) => s.kind)).toEqual(['thinking', 'text', 'tools', 'text', 'tools']);
    const g = a.segments[2]!;
    if (g.kind !== 'tools') throw new Error();
    // thinking between two tool calls is folded into the group, in order
    expect(g.entries.map((e) => (e.kind === 'tool' ? e.name : 'thinking'))).toEqual(['bash', 'read', 'thinking', 'bash']);
    expect(g.key).toBe('a1:2');
    const c3 = g.entries[3] as ToolEntry;
    expect(c3.progress).toBe('running…');
    expect((g.entries[0] as ToolEntry).result?.toolCallId).toBe('c1');
  });

  it('user and system messages end a turn; trailing thinking after tools stays standalone', () => {
    const items = [
      item(msg('a1', 'assistant', [call('c1', 'bash'), { type: 'thinking', text: 'wrap up' }]), { c1: res('c1', 'bash') }),
      item(msg('s1', 'system', [{ type: 'text', text: 'compacted' }])),
      item(msg('a2', 'assistant', [call('c2', 'bash')])),
      item(msg('u1', 'user', [{ type: 'text', text: 'next' }])),
      item(msg('a3', 'assistant', [call('c3', 'bash')])),
    ];
    const turns = buildTurns(items);
    expect(turns.map((t) => t.kind)).toEqual(['assistant', 'message', 'assistant', 'message', 'assistant']);
    const first = turns[0]!;
    if (first.kind !== 'assistant') throw new Error();
    expect(first.segments.map((s) => s.kind)).toEqual(['tools', 'thinking']);
  });

  it('orphan tool messages contribute entries; errors and empty streaming messages get their own segments', () => {
    const items = [
      item(msg('a1', 'assistant', [call('c1', 'bash')])),
      item(msg('t1', 'tool', [res('zz', 'read')])),
      item(msg('a2', 'assistant', [], 'error')),
      item(msg('a3', 'assistant', [], 'streaming')),
    ];
    const t = buildTurns(items)[0]!;
    if (t.kind !== 'assistant') throw new Error();
    expect(t.segments.map((s) => s.kind)).toEqual(['tools', 'error', 'typing']);
    const g = t.segments[0]!;
    if (g.kind !== 'tools') throw new Error();
    expect(g.entries.map((e) => (e as ToolEntry).name)).toEqual(['bash', 'read']);
    expect((g.entries[1] as ToolEntry).result?.toolCallId).toBe('zz');
  });

  it('marks tool calls of a streaming message as streaming', () => {
    const t = buildTurns([item(msg('a1', 'assistant', [call('c1', 'bash')], 'streaming'))])[0]!;
    if (t.kind !== 'assistant' || t.segments[0]!.kind !== 'tools') throw new Error();
    expect((t.segments[0]!.entries[0] as ToolEntry).streaming).toBe(true);
  });
});

describe('sameEntries', () => {
  it('compares rebuilt entry lists by their parts', () => {
    const r = res('c1', 'bash');
    const input = { command: 'ls' };
    const a: GroupEntry[] = [{ kind: 'tool', key: 'k', name: 'bash', input, result: r, streaming: false }];
    const b: GroupEntry[] = [{ kind: 'tool', key: 'k', name: 'bash', input, result: r, streaming: false }];
    expect(sameEntries(a, b)).toBe(true);
    expect(sameEntries(a, [{ ...b[0]!, progress: 'x' } as GroupEntry])).toBe(false);
    expect(sameEntries(a, [...b, { kind: 'thinking', key: 't', text: '', streaming: false }])).toBe(false);
  });
});

describe('buildTurns: send_file cards', () => {
  const file = { type: 'file' as const, name: 'demo.mp4', mediaType: 'video/mp4', size: 3, blob: 'h' };
  it('a send_file result renders a standalone file segment right after its (still grouped) tool call', () => {
    const m = msg('a', 'assistant', [call('t1', 'bash'), call('t2', 'send_file', { path: 'demo.mp4' }), call('t3', 'read')]);
    const it0: ViewItem = { ...item(m, { t1: res('t1', 'bash'), t2: res('t2', 'send_file'), t3: res('t3', 'read') }), resultFiles: { t2: [file] } };
    const turns = buildTurns([it0]);
    const segs = (turns[0] as Extract<typeof turns[0], { kind: 'assistant' }>).segments;
    expect(segs.map((s) => s.kind)).toEqual(['tools', 'file', 'tools']);
    expect((segs[0] as { entries: ToolEntry[] }).entries.map((e) => e.name)).toEqual(['bash', 'send_file']);
    expect((segs[1] as { block: unknown }).block).toBe(file);
  });
  it('an orphan tool message with a file block also yields a file segment', () => {
    const turns = buildTurns([item(msg('r', 'tool', [res('zz', 'send_file'), file]))]);
    const segs = (turns[0] as Extract<typeof turns[0], { kind: 'assistant' }>).segments;
    expect(segs.map((s) => s.kind)).toEqual(['tools', 'file']);
  });
});

describe('sameSegments', () => {
  const r = res('c1', 'bash');
  const m = msg('a', 'assistant', [{ type: 'text', text: 'hi' }, call('c1', 'bash')]); // stable message, as in the store
  const build = (results: Record<string, Result>) => {
    const t = buildTurns([item(m, results)])[0]!;
    return t.kind === 'assistant' ? t.segments : [];
  };
  it('rebuilt segments with the same parts are equal', () => {
    expect(sameSegments(build({ c1: r }), build({ c1: r }))).toBe(true);
  });
  it('a new tool result, text change or extra segment is a difference', () => {
    expect(sameSegments(build({}), build({ c1: r }))).toBe(false);
    const a: Segment[] = [{ kind: 'text', key: 'k', text: 'a' }];
    expect(sameSegments(a, [{ kind: 'text', key: 'k', text: 'b' }])).toBe(false);
    expect(sameSegments(a, [...a, { kind: 'typing', key: 't' }])).toBe(false);
    expect(sameSegments(a, [{ kind: 'error', key: 'k', text: 'a' }])).toBe(false);
  });
});

describe('isLongText', () => {
  it('counts hard lines and wrapped lines', () => {
    expect(isLongText('a\nb\nc')).toBe(false);
    expect(isLongText(Array.from({ length: 13 }, (_, i) => `line ${i}`).join('\n'))).toBe(true);
    expect(isLongText('x'.repeat(70 * 13))).toBe(true);
    expect(isLongText('x'.repeat(70 * 5))).toBe(false);
  });
});
