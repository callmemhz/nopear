import { describe, expect, it } from 'vitest';
import { toolSummary } from './tools';

describe('toolSummary', () => {
  it('bash shows the command', () => expect(toolSummary('bash', { command: 'ls -la' })).toBe('ls -la'));
  it('read/edit/write show the path', () => {
    expect(toolSummary('read', { path: 'a.ts' })).toBe('a.ts');
    expect(toolSummary('edit', { path: 'b.ts', edits: [] })).toBe('b.ts');
    expect(toolSummary('write', { file_path: 'c.ts' })).toBe('c.ts');
  });
  it('ask_user_question counts questions', () => expect(toolSummary('ask_user_question', { questions: [{}, {}] })).toBe('2 个问题'));
  it('subagent shows the goal', () => {
    expect(toolSummary('subagent', { agent: 'reviewer', task: 'review the diff' })).toBe('reviewer · review the diff');
  });
  it('truncates long text and handles unknown input', () => {
    expect(toolSummary('bash', { command: 'x'.repeat(200) }).length).toBeLessThanOrEqual(120);
    expect(toolSummary('mystery', null)).toBe('');
    expect(toolSummary('grep', { pattern: 'foo', path: 'src' })).toBe('foo · src');
  });
});
