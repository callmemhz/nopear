// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Markdown } from './Markdown';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('Markdown', () => {
  it('never renders remote images as <img> (no auto-fetch)', async () => {
    const el = document.createElement('div');
    const root = createRoot(el);
    await act(async () => { root.render(<Markdown text={'hi ![x](https://evil.example/p.png?leak=1)'} />); });
    expect(el.querySelector('img')).toBeNull();
    const a = el.querySelector('a');
    expect(a?.getAttribute('href')).toBe('https://evil.example/p.png?leak=1');
    await act(async () => { root.unmount(); });
  });
});
