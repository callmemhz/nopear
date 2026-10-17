// Renderer lifetime for components/Markdown.tsx. react-native-marked's Renderer derives element keys from a
// stateful slugger (react-native-marked-ele, -1, -2, …), so it must be fresh per text: reusing one across streamed
// deltas keeps advancing the key counter (every delta remounts the whole message), and a shared/module-level one
// leaks that state across messages. The component itself needs a React Native renderer (not available under
// vitest), so this exercises the lifetime helper it uses with a renderer that keys elements the same way.
import { describe, expect, it } from 'vitest';
import { rendererPerText } from './rendererPerText';

/** Stand-in for react-native-marked's Renderer: one key per rendered element from a per-instance counter. */
class KeyedRenderer {
  static made = 0;
  #n = 0;
  constructor() { KeyedRenderer.made++; }
  getKey(): string { const n = this.#n++; return n === 0 ? 'react-native-marked-ele' : `react-native-marked-ele-${n}`; }
}
/** "Parse" text the way useMarkdown does: one element (key) per block. */
const keysOf = (r: KeyedRenderer, text: string) => text.split('\n\n').map(() => r.getKey());

describe('rendererPerText (Markdown renderer lifetime)', () => {
  it('two fresh renderers over the same blocks yield equal keys (no remount when a delta re-parses the text)', () => {
    const get = rendererPerText(() => new KeyedRenderer());
    const before = keysOf(get('para one\n\npara two'), 'para one\n\npara two');
    const after = keysOf(get('para one\n\npara two and more'), 'para one\n\npara two and more');
    expect(after).toEqual(before);
  });
  it('reuses the renderer across re-renders of the same text, and makes a new one only when the text changes', () => {
    const get = rendererPerText(() => new KeyedRenderer());
    const a = get('x');
    expect(get('x')).toBe(a);
    const b = get('xy');
    expect(b).not.toBe(a);
    expect(get('xy')).toBe(b);
  });
  it('separate component instances never share a renderer', () => {
    const one = rendererPerText(() => new KeyedRenderer());
    const two = rendererPerText(() => new KeyedRenderer());
    const made = KeyedRenderer.made;
    expect(one('same')).not.toBe(two('same'));
    expect(KeyedRenderer.made).toBe(made + 2);
  });
});
