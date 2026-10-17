// Queue-card view logic shared by web + mobile.
import type { QueueDelivery, QueueItem } from '@nopear/protocol';
import { RpcCallError } from './channel';

/** Badge text: 「插队」 for steer (delivered after the current tool call), 「排队」 for followUp. */
export function queueBadge(d: QueueDelivery): string {
  return d === 'steer' ? '插队' : '排队';
}

/** One-line preview of a queued message (whitespace collapsed, truncated to `max` chars). */
export function queuePreview(item: Pick<QueueItem, 'text' | 'attachments'>, max = 120): string {
  const t = item.text.replace(/\s+/g, ' ').trim();
  if (!t) return item.attachments > 0 ? '（仅附件）' : '（空）';
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** User-facing error of a queue action: not_found means the message was delivered meanwhile. */
export function queueErrorText(e: unknown): string {
  if (e instanceof RpcCallError && e.code === 'not_found') return '这条消息已送达，无法再修改';
  return e instanceof Error ? e.message : String(e);
}

/** 编辑 needs confirmation only when it would replace a non-empty draft. */
export function editNeedsConfirm(draft: string): boolean {
  return draft.trim() !== '';
}

export type QueueAction = 'steer' | 'edit' | 'cancel';
/** Actions offered on a queue card, in display order (插队 only for a followUp). */
export function queueActions(item: Pick<QueueItem, 'delivery'>): { action: QueueAction; label: string }[] {
  return [
    ...(item.delivery === 'followUp' ? [{ action: 'steer' as const, label: '插队' }] : []),
    { action: 'edit', label: '编辑' },
    { action: 'cancel', label: '取消' },
  ];
}
