import { describe, expect, it } from 'vitest';
import { cwdChip, dirsListArgs, pickerStart } from './dirPicker';

describe('dirPicker helpers', () => {
  it('dirsListArgs omits empty path and false showHidden', () => {
    expect(dirsListArgs(undefined, false)).toEqual({});
    expect(dirsListArgs('/a', false)).toEqual({ path: '/a' });
    expect(dirsListArgs('/a', true)).toEqual({ path: '/a', showHidden: true });
    expect(dirsListArgs(undefined, true)).toEqual({ showHidden: true });
  });
  it('pickerStart: typed cwd (trimmed) or undefined = worker default', () => {
    expect(pickerStart('  /src/x ')).toBe('/src/x');
    expect(pickerStart('   ')).toBeUndefined();
  });
  it('cwdChip: projects show their name + path, recents show the path', () => {
    expect(cwdChip({ path: '/src/p', label: 'P', kind: 'project' })).toEqual({ title: '📁 P', subtitle: '/src/p' });
    expect(cwdChip({ path: '/tmp/r', kind: 'recent' })).toEqual({ title: '/tmp/r' });
  });
});
