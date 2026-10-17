// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { FileListing } from '@nopear/protocol';
import { engine } from '../engine';
import { CwdField, DirPicker } from './DirPicker';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const T = '2026-10-11T00:00:00Z';
let el: HTMLDivElement;
let root: Root;

const listing = (path: string, names: string[]): FileListing =>
  ({ path, truncated: false, entries: names.map((name) => ({ name, type: 'dir', size: 0, mtime: T })) });
const tree: Record<string, string[]> = { '/home/me': ['proj', 'docs'], '/home/me/proj': ['src'], '/home': ['me'], '/home/me/proj/src': [] };

function mockRpc() {
  return vi.spyOn(engine, 'rpc').mockImplementation((async (_wid: string, op: string, args: { path?: string }) => {
    expect(op).toBe('dirs.list');
    const p = args.path ?? '/home/me';
    if (!tree[p]) throw new Error('directory not found');
    return listing(p, tree[p]!);
  }) as never);
}
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const buttons = () => Array.from(el.querySelectorAll('button'));
const btn = (text: string) => buttons().find((b) => b.textContent?.includes(text))!;
const click = (b: Element) => act(async () => { b.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

beforeEach(() => {
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  el.remove();
  vi.restoreAllMocks();
});

describe('DirPicker', () => {
  it('starts at the worker default, enters folders, goes up, and selects the current dir', async () => {
    const rpc = mockRpc();
    const onSelect = vi.fn();
    await act(async () => { root.render(<DirPicker workerId="w1" onSelect={onSelect} onClose={() => {}} />); });
    await flush();
    expect(rpc).toHaveBeenLastCalledWith('w1', 'dirs.list', {});
    expect(el.textContent).toContain('proj');
    await click(btn('proj'));
    await flush();
    expect(rpc).toHaveBeenLastCalledWith('w1', 'dirs.list', { path: '/home/me/proj' });
    expect(el.textContent).toContain('src');
    await click(btn('上一级'));
    await flush();
    expect(rpc).toHaveBeenLastCalledWith('w1', 'dirs.list', { path: '/home/me' });
    await click(btn('上一级'));
    await flush();
    expect(rpc).toHaveBeenLastCalledWith('w1', 'dirs.list', { path: '/home' });
    await click(btn('选择此目录'));
    expect(onSelect).toHaveBeenCalledWith('/home');
  });

  it('starts at the given path, toggles hidden dirs, and shows errors', async () => {
    const rpc = mockRpc();
    await act(async () => { root.render(<DirPicker workerId="w1" initialPath="/home/me/proj" onSelect={() => {}} onClose={() => {}} />); });
    await flush();
    expect(rpc).toHaveBeenLastCalledWith('w1', 'dirs.list', { path: '/home/me/proj' });
    const toggle = el.querySelector('input[type=checkbox]') as HTMLInputElement;
    await click(toggle);
    await flush();
    expect(rpc).toHaveBeenLastCalledWith('w1', 'dirs.list', { path: '/home/me/proj', showHidden: true });

    await act(async () => { root.render(<DirPicker key="other" workerId="w1" initialPath="/nope" onSelect={() => {}} onClose={() => {}} />); });
    await flush();
    expect(el.textContent).toContain('directory not found');
  });

  it('re-fetches from the start when the machine changes', async () => {
    const rpc = mockRpc();
    await act(async () => { root.render(<DirPicker workerId="w1" onSelect={() => {}} onClose={() => {}} />); });
    await flush();
    await click(btn('proj'));
    await flush();
    await act(async () => { root.render(<DirPicker workerId="w2" onSelect={() => {}} onClose={() => {}} />); });
    await flush();
    expect(rpc).toHaveBeenLastCalledWith('w2', 'dirs.list', {});
  });
});

describe('CwdField', () => {
  it('shows project + recent chips for the machine; clicking fills the field', async () => {
    engine.store.setState({
      projects: { p1: { id: 'p1', name: 'Proj One', description: '', paths: { w1: '/src/one' }, createdAt: T, updatedAt: T } },
      sessions: { w1: { s1: { id: 's1', workerId: 'w1', cwd: '/tmp/recent', lastActivityAt: T } as never } },
      sessionIndex: {},
    });
    const onChange = vi.fn();
    await act(async () => { root.render(<CwdField workerId="w1" value="" onChange={onChange} placeholder="/home/me" />); });
    expect(el.textContent).toContain('Proj One');
    expect(el.textContent).toContain('/tmp/recent');
    await click(btn('Proj One'));
    expect(onChange).toHaveBeenLastCalledWith('/src/one');
    await click(btn('/tmp/recent'));
    expect(onChange).toHaveBeenLastCalledWith('/tmp/recent');
  });

  it('「浏览…」 opens the picker at the typed path and 「选择此目录」 fills the field', async () => {
    engine.store.setState({ projects: {}, sessions: {}, sessionIndex: {} });
    const rpc = mockRpc();
    const onChange = vi.fn();
    await act(async () => { root.render(<CwdField workerId="w1" value="/home/me/proj" onChange={onChange} />); });
    await click(btn('浏览…'));
    await flush();
    expect(rpc).toHaveBeenLastCalledWith('w1', 'dirs.list', { path: '/home/me/proj' });
    await click(btn('src'));
    await flush();
    await click(btn('选择此目录'));
    expect(onChange).toHaveBeenLastCalledWith('/home/me/proj/src');
    expect(el.textContent).not.toContain('选择此目录');
  });
});
