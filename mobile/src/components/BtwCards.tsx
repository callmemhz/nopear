// `/btw` side answers above the composer: never part of the conversation; closing one discards it.
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import type { BtwAnswer } from '@nopear/protocol';
import { engine } from '../engine';
import { COLUMN_MAX, usePalette } from '../theme';
import { Markdown } from './Markdown';

export function BtwCards({ workerId, sessionId, items }: { workerId: string; sessionId: string; items: BtwAnswer[] }) {
  const c = usePalette();
  if (items.length === 0) return null;
  return (
    <View style={{ width: '100%', maxWidth: COLUMN_MAX, alignSelf: 'center', paddingHorizontal: 12, gap: 8, paddingTop: 6 }}>
      {items.map((b) => (
        <View key={b.id} style={{ backgroundColor: c.card, borderRadius: 14, borderWidth: 1, borderStyle: 'dashed', borderColor: c.lineStrong, overflow: 'hidden' }}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 6 }}>
            <Text style={{ color: c.tint, fontSize: 12, fontWeight: '600', marginTop: 1 }}>/btw</Text>
            <Text style={{ flex: 1, color: c.text, fontSize: 14, fontWeight: '600' }} numberOfLines={3}>{b.question}</Text>
            {b.status === 'running' ? <ActivityIndicator size="small" color={c.sub} /> : null}
            <Pressable hitSlop={10} accessibilityRole="button" accessibilityLabel="关闭" onPress={() => engine.dismissBtw(workerId, sessionId, b.id)}>
              <Text style={{ color: c.sub, fontSize: 15 }}>✕</Text>
            </Pressable>
          </View>
          <ScrollView style={{ maxHeight: 260 }} contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 10 }} nestedScrollEnabled>
            {b.status === 'error'
              ? <Text selectable style={{ color: c.danger, fontSize: 13 }}>没答上来：{b.error}</Text>
              : b.text ? <Markdown text={b.text} /> : <Text style={{ color: c.sub, fontSize: 13 }}>正在看上下文…</Text>}
          </ScrollView>
        </View>
      ))}
    </View>
  );
}
