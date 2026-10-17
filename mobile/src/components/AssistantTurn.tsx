// One assistant turn: markdown text directly on the background, thinking one-liners, consecutive tool
// calls folded into a single summary row (same toolGroups logic as web), standalone images / sent files, errors.
import { memo, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { entryState, sameEntries, sameSegments, summarizeTools, type GroupEntry, type Segment } from '@nopear/core';
import { usePalette } from '../theme';
import { Markdown } from './Markdown';
import { ThinkingCard } from './ThinkingCard';
import { ToolCard } from './ToolCard';
import { BlobImage } from './BlobImage';
import { FileCard } from './FileCard';
import { Icon } from './Icon';

function GroupEntryView({ e, workerId, live }: { e: GroupEntry; workerId: string; live: boolean }) {
  if (e.kind === 'thinking') return <ThinkingCard text={e.text} streaming={e.streaming} />;
  const call = e.input !== undefined ? { type: 'tool_call' as const, id: e.key, name: e.name, input: e.input } : undefined;
  return <ToolCard call={call} result={e.result} progress={e.progress} orphan={!call} images={e.images} workerId={workerId}
    state={entryState(e, live)} />;
}

/** 「运行了 4 条命令（1 条失败），读取了 1 个文件 ›」: tap expands the ToolCards; while running the active card stays visible. */
export const ToolGroup = memo(function ToolGroup({ entries, workerId, live }: { entries: GroupEntry[]; workerId: string; live: boolean }) {
  const c = usePalette();
  const [open, setOpen] = useState(false);
  const s = summarizeTools(entries, live);
  let active = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.kind === 'tool' && entryState(e, live) === 'running') { active = i; break; }
  }
  const images = open ? [] : entries.flatMap((e) => (e.kind === 'tool' && e.images) || []);
  return (
    <View style={{ marginVertical: 4 }}>
      <Pressable onPress={() => setOpen((v) => !v)} hitSlop={6} accessibilityRole="button" accessibilityState={{ expanded: open }}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', maxWidth: '100%' }}>
        {s.running ? <ActivityIndicator size="small" color={c.tint} style={{ transform: [{ scale: 0.75 }], width: 16, height: 16 }} /> : null}
        <Text numberOfLines={1} style={{ flexShrink: 1, color: c.sub, fontSize: 14.5 }}>{s.text || '调用了工具'}</Text>
        <View style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}><Icon name="chevronRight" size={15} color={c.faint} /></View>
      </Pressable>
      {open ? (
        <View style={{ marginTop: 6, paddingLeft: 10, borderLeftWidth: 2, borderLeftColor: c.sep }}>
          {entries.map((e) => <GroupEntryView key={e.key} e={e} workerId={workerId} live={live} />)}
        </View>
      ) : (
        <>
          {active >= 0 ? <View style={{ marginTop: 6 }}><GroupEntryView e={entries[active]!} workerId={workerId} live={live} /></View> : null}
          {images.length > 0 ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
              {images.map((im, i) => <BlobImage key={i} workerId={workerId} hash={im.blob} mediaType={im.mediaType} size={140} />)}
            </View>
          ) : null}
        </>
      )}
    </View>
  );
}, (p, n) => p.workerId === n.workerId && p.live === n.live && sameEntries(p.entries, n.entries));

function AssistantTurnImpl({ segments, workerId, live }: { segments: Segment[]; workerId: string; live: boolean }) {
  const c = usePalette();
  return (
    <View style={{ paddingVertical: 8, gap: 6 }}>
      {segments.map((seg) => {
        switch (seg.kind) {
          case 'text': return <Markdown key={seg.key} text={seg.text} />;
          case 'thinking': return <ThinkingCard key={seg.key} text={seg.text} streaming={seg.streaming} />;
          case 'tools': return <ToolGroup key={seg.key} entries={seg.entries} workerId={workerId} live={live} />;
          case 'image': return (
            <BlobImage key={seg.key} workerId={workerId} mediaType={seg.block.mediaType}
              {...(seg.block.blob.startsWith('data:') ? { uri: seg.block.blob } : { hash: seg.block.blob })} />
          );
          case 'file': return <FileCard key={seg.key} block={seg.block} workerId={workerId} />;
          case 'error': return (
            <View key={seg.key} style={{ backgroundColor: c.dangerSoft, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 }}>
              <Text style={{ color: c.danger, fontSize: 13.5 }}>⚠ {seg.text}</Text>
            </View>
          );
          case 'typing': return (
            <View key={seg.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <ActivityIndicator size="small" color={c.tint} />
              <Text style={{ color: c.sub, fontSize: 14 }}>正在回复…</Text>
            </View>
          );
        }
      })}
    </View>
  );
}

export const AssistantTurn = memo(AssistantTurnImpl, (p, n) =>
  p.workerId === n.workerId && p.live === n.live && sameSegments(p.segments, n.segments));
