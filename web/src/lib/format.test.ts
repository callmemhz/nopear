import { describe, expect, it } from 'vitest';
import { formatBytes, formatDuration, relativeTime } from './format';

describe('format', () => {
  it('formats durations', () => {
    expect(formatDuration(5)).toBe('5s');
    expect(formatDuration(65)).toBe('1m5s');
    expect(formatDuration(3725)).toBe('1h2m');
    expect(formatDuration(-3)).toBe('0s');
  });
  it('formats bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
  it('formats relative time', () => {
    const now = Date.parse('2026-10-10T12:00:00Z');
    expect(relativeTime('2026-10-10T11:59:30Z', now)).toBe('刚刚');
    expect(relativeTime('2026-10-10T11:55:00Z', now)).toBe('5 分钟前');
    expect(relativeTime('2026-10-10T09:00:00Z', now)).toBe('3 小时前');
    expect(relativeTime('2026-10-07T12:00:00Z', now)).toBe('3 天前');
  });
});
