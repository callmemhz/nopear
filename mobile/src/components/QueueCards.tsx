// Messages queued while the session runs, shown as compact cards above the composer.
// Tap a card → 插队 / 编辑 / 取消 (labels and rules from @nopear/core's queue helpers).
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { editNeedsConfirm, queueActions, queueBadge, queueErrorText, queuePreview, type QueueAction } from '@nopear/core';
import { sessionKey, type QueueItem } from '@nopear/protocol';
import { engine, useEngine } from '../engine';
import { actionMenu } from '../QuickAdd';
import { COLUMN_MAX, usePalette } from '../theme';

const EMPTY: QueueItem[] = [];
const fail = (e: unknown) => Alert.alert('操作失败', queueErrorText(e));

export function QueueCards({ workerId, sessionId, draft, onEdit }: {
  workerId: string; sessionId: string;
  /** Current composer text: 编辑 asks before replacing it. */
  draft: string;
  /** 编辑: the queued text goes back into the composer. */
  onEdit: (text: string) => void;
}) {
  const c = usePalette();
  const queue = useEngine((s) => s.timelines[sessionKey(workerId, sessionId)]?.queue ?? EMPTY);
  if (queue.length === 0) return null;

  const edit = (q: QueueItem) => {
    const go = () => { engine.removeQueued(workerId, sessionId, q.id).then(() => onEdit(q.text), fail); };
    if (!editNeedsConfirm(draft)) return go();
    Alert.alert('替换输入框内容？', '输入框里已有内容，要用这条排队消息替换吗？', [
      { text: '取消', style: 'cancel' },
      { text: '替换', style: 'destructive', onPress: go },
    ]);
  };
  const run: Record<QueueAction, (q: QueueItem) => void> = {
    steer: (q) => { engine.updateQueued(workerId, sessionId, q.id, { delivery: 'steer' }).catch(fail); },
    edit,
    cancel: (q) => { engine.removeQueued(workerId, sessionId, q.id).catch(fail); },
  };
  const open = (q: QueueItem) => actionMenu(`${queueBadge(q.delivery)} · ${queuePreview(q, 40)}`, queueActions(q).map(({ action, label }) => ({
    label: action === 'edit' && q.attachments > 0 ? '编辑（附件不会带回）' : action === 'cancel' ? '取消这条' : label,
    destructive: action === 'cancel',
    run: () => run[action](q),
  })));

  return (
    <View style={{ paddingHorizontal: 10, gap: 6, paddingTop: 4 }}>
      {queue.map((q) => (
        <Pressable key={q.id} onPress={() => open(q)} accessibilityRole="button" accessibilityLabel={`排队消息：${queuePreview(q, 40)}`}
          style={({ pressed }) => ({ width: '100%', maxWidth: COLUMN_MAX, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 8,
            backgroundColor: pressed ? c.hover : c.card, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: c.lineStrong,
            paddingHorizontal: 10, paddingVertical: 7 })}>
          <View style={{ backgroundColor: q.delivery === 'steer' ? c.accentSoft : c.elevated, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1 }}>
            <Text style={{ color: q.delivery === 'steer' ? c.tint : c.sub, fontSize: 11, fontWeight: '600' }}>{queueBadge(q.delivery)}</Text>
          </View>
          <Text numberOfLines={1} style={{ flex: 1, color: c.text, fontSize: 14 }}>{queuePreview(q)}</Text>
          {q.attachments > 0 ? <Text style={{ color: c.sub, fontSize: 12 }}>📎 {q.attachments}</Text> : null}
          <Text style={{ color: c.faint, fontSize: 16 }}>⋯</Text>
        </Pressable>
      ))}
    </View>
  );
}
