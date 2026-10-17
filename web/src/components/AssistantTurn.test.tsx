// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { GroupEntry } from '@nopear/core';

vi.mock('./BlobImage', () => ({
  BlobImage: ({ hash }: { hash: string }) => <img data-testid="blob" data-hash={hash} alt="" />,
}));
const { ToolGroup, AssistantTurn } = await import('./AssistantTurn');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const res = (id: string, isError = false) => ({ type: 'tool_result' as const, toolCallId: id, toolName: 'bash', text: 'out ' + id, isError });
const bash = (id: string, over: Partial<Extract<GroupEntry, { kind: 'tool' }>> = {}): GroupEntry =>
  ({ kind: 'tool', key: id, name: 'bash', input: { command: `echo ${id}` }, result: res(id), streaming: false, ...over });

let el: HTMLDivElement;
let root: Root;
beforeEach(() => { el = document.createElement('div'); document.body.appendChild(el); root = createRoot(el); });
afterEach(async () => { await act(async () => { root.unmount(); }); el.remove(); });

describe('ToolGroup', () => {
  it('collapses to a summary line and expands to the tool cards', async () => {
    const entries = [bash('a'), bash('b', { result: res('b', true) }), { kind: 'tool', key: 'r', name: 'read', input: { path: 'x.png' }, result: { ...res('r'), toolName: 'read' }, streaming: false,
      images: [{ type: 'image', mediaType: 'image/png', blob: 'h1' }] } as GroupEntry];
    await act(async () => { root.render(<ToolGroup entries={entries} workerId="w" live={false} />); });
    const summary = el.querySelector('button[aria-expanded]')!;
    expect(summary.textContent).toBe('运行了 2 条命令（1 条失败），读取了 1 个文件');
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    expect(el.textContent).not.toContain('echo a');
    expect(el.querySelector('img[data-hash="h1"]')).not.toBeNull(); // tool images stay visible when collapsed
    await act(async () => { (summary as HTMLButtonElement).click(); });
    expect(summary.getAttribute('aria-expanded')).toBe('true');
    expect(el.textContent).toContain('echo a');
    expect(el.textContent).toContain('echo b');
    expect(el.querySelectorAll('img[data-hash="h1"]').length).toBe(1); // now inside the read card
  });
  it('shows a spinner and the last running card while a tool runs', async () => {
    const entries = [bash('a'), bash('b', { result: undefined, progress: 'tail output' })];
    await act(async () => { root.render(<ToolGroup entries={entries} workerId="w" live={false} />); });
    expect(el.querySelector('[role="status"]')).not.toBeNull();
    expect(el.textContent).toContain('echo b');
    expect(el.textContent).toContain('tail output');
    expect(el.textContent).not.toContain('echo a');
  });
  it('no spinner once everything finished', async () => {
    await act(async () => { root.render(<ToolGroup entries={[bash('a')]} workerId="w" live={false} />); });
    expect(el.querySelector('[role="status"]')).toBeNull();
    expect(el.querySelector('button[aria-expanded]')!.textContent).toBe('运行了 1 条命令');
  });
});

describe('AssistantTurn file segment', () => {
  it('renders a send_file card standalone next to a collapsed tool group', async () => {
    const file = { type: 'file' as const, name: 'demo.html', mediaType: 'text/html', size: 10, blob: 'f'.repeat(64), title: '演示页' };
    await act(async () => {
      root.render(<AssistantTurn workerId="w" live={false} segments={[
        { kind: 'tools', key: 'g', entries: [bash('a')] },
        { kind: 'file', key: 'f', block: file },
      ]} />);
    });
    expect(el.querySelector('[data-testid="tool-group"] button')!.getAttribute('aria-expanded')).toBe('false');
    const card = el.querySelector('[data-testid="file-card"]')!;
    expect(card.textContent).toContain('演示页');
    expect(card.closest('[data-testid="tool-group"]')).toBeNull();
  });
});
