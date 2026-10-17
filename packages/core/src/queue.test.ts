import { describe, expect, it } from 'vitest';
import { RpcCallError } from './channel';
import { editNeedsConfirm, queueActions, queueBadge, queueErrorText, queuePreview } from './queue';

describe('queue view helpers', () => {
  it('badge, preview, errors, edit confirmation', () => {
    expect(queueBadge('steer')).toBe('插队');
    expect(queueBadge('followUp')).toBe('排队');
    expect(queuePreview({ text: ' a \n b ', attachments: 0 })).toBe('a b');
    expect(queuePreview({ text: '', attachments: 2 })).toBe('（仅附件）');
    expect(queuePreview({ text: 'x'.repeat(10), attachments: 0 }, 5)).toBe('xxxx…');
    expect(queueErrorText(new RpcCallError('not_found', 'gone'))).toBe('这条消息已送达，无法再修改');
    expect(queueErrorText(new Error('boom'))).toBe('boom');
    expect(editNeedsConfirm('  ')).toBe(false);
    expect(editNeedsConfirm('draft')).toBe(true);
    expect(queueActions({ delivery: 'followUp' }).map((a) => a.action)).toEqual(['steer', 'edit', 'cancel']);
    expect(queueActions({ delivery: 'steer' }).map((a) => a.label)).toEqual(['编辑', '取消']);
  });
});
