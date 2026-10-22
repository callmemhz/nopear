// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StatusDot } from './SessionList';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let el: HTMLDivElement;
let root: Root;
afterEach(async () => { await act(async () => { root.unmount(); }); el.remove(); });

describe('StatusDot', () => {
  it('green while the agent works, slow blue while only background tasks run', async () => {
    el = document.createElement('div'); document.body.appendChild(el); root = createRoot(el);
    await act(async () => { root.render(<>
      <StatusDot status="running" taskCount={2} />
      <StatusDot status="idle" taskCount={1} />
      <StatusDot status="error" taskCount={0} />
      <StatusDot status="idle" />
    </>); });
    const dots = Array.from(el.querySelectorAll("span"));
    expect(dots.map((d) => d.dataset.activity)).toEqual(['running', 'background', 'error', 'idle']);
    expect(dots[0]!.className).toContain('bg-emerald-500');
    expect(dots[1]!.className).toContain('bg-sky-500');
    expect(dots[1]!.className).toContain('pulse_3s');
    expect(dots[1]!.getAttribute('aria-label')).toBe('后台任务运行中');
  });
});
