// Background-subagent notification (system message with `notice`): one compact row, tap to expand the full text.
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { NoticeView } from '@nopear/core';
import { usePalette } from '../theme';
import { Markdown } from './Markdown';
import { Icon } from './Icon';

export function NoticeCard({ v }: { v: NoticeView }) {
  const c = usePalette();
  const [open, setOpen] = useState(false);
  const color = v.tone === 'ok' ? c.ok : v.tone === 'error' ? c.danger : v.tone === 'warn' ? c.warn : c.sub;
  const icon = v.tone === 'ok' ? '✓' : v.tone === 'error' ? '✕' : v.tone === 'warn' ? '!' : 'i';
  return (
    <View style={{ marginVertical: 8, backgroundColor: c.card, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: c.sep, overflow: 'hidden' }}>
      <Pressable onPress={() => setOpen((x) => !x)} accessibilityState={{ expanded: open }}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 9 }}>
        <View style={{ width: 16, height: 16, borderRadius: 8, borderWidth: 1, borderColor: color, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color, fontSize: 10, fontWeight: '700' }}>{icon}</Text>
        </View>
        <Text style={{ color: c.text, fontSize: 14, fontWeight: '600' }} numberOfLines={1}>{v.heading}</Text>
        <Text style={{ color: c.sub, fontSize: 13, flex: 1 }} numberOfLines={1}>{v.summary}</Text>
        <View style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}><Icon name="chevronRight" size={14} color={c.faint} /></View>
      </Pressable>
      {open ? <View style={{ paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.sep }}><Markdown text={v.text} /></View> : null}
    </View>
  );
}
