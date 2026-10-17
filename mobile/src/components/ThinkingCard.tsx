// Thinking: one quiet line (「思考 · first line」 ›); tap expands the full text.
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { usePalette } from '../theme';
import { Icon } from './Icon';

export function ThinkingCard({ text, streaming }: { text: string; streaming?: boolean }) {
  const c = usePalette();
  const [open, setOpen] = useState(false);
  const firstLine = text.trim().split('\n')[0] ?? '';
  return (
    <Pressable onPress={() => setOpen((v) => !v)} accessibilityRole="button" accessibilityState={{ expanded: open }}
      style={{ marginVertical: 3 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Icon name="bulb" size={15} color={c.faint} />
        <Text numberOfLines={1} style={{ flexShrink: 1, color: c.sub, fontSize: 14 }}>
          {streaming ? '思考中…' : '思考'}{!open && firstLine ? <Text style={{ color: c.faint }}>{` · ${firstLine}`}</Text> : null}
        </Text>
        <View style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}><Icon name="chevronRight" size={14} color={c.faint} /></View>
      </View>
      {open ? (
        <Text selectable style={{ color: c.sub, fontSize: 14, lineHeight: 21, marginTop: 6, paddingLeft: 10, borderLeftWidth: 2, borderLeftColor: c.sep }}>
          {text}
        </Text>
      ) : null}
    </Pressable>
  );
}
