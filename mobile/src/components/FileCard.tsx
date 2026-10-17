// A file the agent sent (send_file `file` block): icon, title/name, size, note. Tap opens the in-app preview
// (FilePreview: images/video/audio/html/pdf/text), with the OS share sheet as an explicit action there.
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Block } from '@nopear/protocol';
import { FILE_ICONS, fileKind } from '@nopear/core';
import { bytes as fmtBytes } from '../format';
import { usePalette } from '../theme';
import { FilePreview } from './FilePreview';

type FileBlock = Extract<Block, { type: 'file' }>;

export function FileCard({ block, workerId }: { block: FileBlock; workerId: string }) {
  const c = usePalette();
  const [open, setOpen] = useState(false);
  return (
    <>
    <Pressable onPress={() => setOpen(true)}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: pressed ? c.hover : c.card,
        borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: c.sep, paddingHorizontal: 12, paddingVertical: 10, marginVertical: 4 })}>
      <Text style={{ fontSize: 24 }}>{FILE_ICONS[fileKind(block.mediaType)]}</Text>
      <View style={{ flex: 1 }}>
        <Text style={{ color: c.text, fontSize: 15, fontWeight: '600' }} numberOfLines={1}>{block.title || block.name}</Text>
        <Text style={{ color: c.sub, fontSize: 12 }} numberOfLines={1}>{block.title ? `${block.name} · ` : ''}{fmtBytes(block.size)}</Text>
        {block.note ? <Text style={{ color: c.sub, fontSize: 12 }} numberOfLines={2}>{block.note}</Text> : null}
      </View>
      <Text style={{ color: c.tint, fontSize: 13, fontWeight: '600' }}>打开</Text>
    </Pressable>
    <FilePreview block={open ? block : null} workerId={workerId} onClose={() => setOpen(false)} />
    </>
  );
}
