// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

vi.mock('./BlobImage', () => ({
  BlobImage: ({ workerId, hash, mediaType }: { workerId: string; hash: string; mediaType: string }) =>
    <img data-testid="blob" data-worker={workerId} data-hash={hash} data-type={mediaType} alt="" />,
}));
const { ToolCard } = await import('./ToolCard');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const result = { type: 'tool_result' as const, toolCallId: 't1', toolName: 'read', text: 'Read image file', isError: false };

describe('ToolCard', () => {
  it('renders images a tool returned (resultImages) via BlobImage', async () => {
    const el = document.createElement('div');
    const root = createRoot(el);
    await act(async () => {
      root.render(<ToolCard workerId="w1" name="read" input={{ path: 'a.png' }} result={result}
        images={[{ type: 'image', mediaType: 'image/png', blob: 'h1' }]} />);
    });
    const img = el.querySelector('img[data-testid="blob"]');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('data-hash')).toBe('h1');
    expect(img?.getAttribute('data-worker')).toBe('w1');
    expect(img?.getAttribute('data-type')).toBe('image/png');
    await act(async () => { root.unmount(); });
  });
  it('renders no image without resultImages', async () => {
    const el = document.createElement('div');
    const root = createRoot(el);
    await act(async () => { root.render(<ToolCard workerId="w1" name="read" result={result} />); });
    expect(el.querySelector('img')).toBeNull();
    await act(async () => { root.unmount(); });
  });
});
