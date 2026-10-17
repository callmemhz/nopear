import { describe, expect, it } from 'vitest';
import { DRAWER_EDGE, clamp01, drawerWidth, dragProgress, settleOpen, parseSessionPath } from './drawerMath';

describe('drawerWidth', () => {
  it('leaves a strip of the content visible and caps on wide screens', () => {
    expect(drawerWidth(390)).toBe(390 - 64);
    expect(drawerWidth(320)).toBe(320 - 64);
    expect(drawerWidth(1024)).toBe(360);
  });
});

describe('clamp01 / dragProgress', () => {
  it('clamps', () => {
    expect(clamp01(-0.2)).toBe(0);
    expect(clamp01(0.4)).toBe(0.4);
    expect(clamp01(3)).toBe(1);
  });
  it('opening drag from closed follows the finger', () => {
    expect(dragProgress(false, 150, 300)).toBe(0.5);
    expect(dragProgress(false, -40, 300)).toBe(0);
    expect(dragProgress(false, 900, 300)).toBe(1);
  });
  it('closing drag from open only moves left', () => {
    expect(dragProgress(true, -75, 300)).toBe(0.75);
    expect(dragProgress(true, 80, 300)).toBe(1);
    expect(dragProgress(true, -600, 300)).toBe(0);
  });
});

describe('settleOpen', () => {
  it('a fling decides by direction', () => {
    expect(settleOpen(0.1, 900)).toBe(true);
    expect(settleOpen(0.9, -900)).toBe(false);
  });
  it('otherwise the nearer end wins', () => {
    expect(settleOpen(0.6, 0)).toBe(true);
    expect(settleOpen(0.4, 100)).toBe(false);
    expect(settleOpen(0.5, 0)).toBe(true);
  });
});

describe('edge strip', () => {
  it('is wide enough for a thumb but narrow enough not to block content', () => {
    expect(DRAWER_EDGE).toBeGreaterThanOrEqual(16);
    expect(DRAWER_EDGE).toBeLessThanOrEqual(32);
  });
});

describe('parseSessionPath', () => {
  it('extracts the open session from the pathname', () => {
    expect(parseSessionPath('/s/w1/abc')).toEqual({ workerId: 'w1', sessionId: 'abc' });
    expect(parseSessionPath('/s/w%2F1/a%20b')).toEqual({ workerId: 'w/1', sessionId: 'a b' });
    expect(parseSessionPath('/board')).toBeNull();
    expect(parseSessionPath('/s/w1')).toBeNull();
  });
});
