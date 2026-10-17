// User and system messages (assistant output is rendered per turn by AssistantTurn).
// User: warm-grey bubble on the right, long text collapsed with 展开/收起; long-press → 撤回 / 分叉.
import { memo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { isLongText, noticeView, type ViewItem } from '@nopear/core';
import { BlobImage } from './BlobImage';
import { NoticeCard } from './NoticeCard';
import { usePalette } from '../theme';
import { sameViewItem } from '../viewItemEq';

export interface MessageActions {
  onUserLongPress?: (item: ViewItem) => void;
  onRetry?: (clientMsgId: string) => void;
  onEdit?: (clientMsgId: string) => void;
}

const COLLAPSED_LINES = 12;

function UserMessage({ item, workerId, actions }: { item: ViewItem; workerId: string; actions: MessageActions }) {
  const c = usePalette();
  const m = item.message;
  const pending = item.pending;
  const text = m.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
  const long = isLongText(text);
  const [expanded, setExpanded] = useState(false);
  const collapsed = long && !expanded;
  const images = m.blocks.filter((b) => b.type === 'image');
  return (
    <View style={{ alignItems: 'flex-end', paddingTop: 14, paddingBottom: 4 }}>
      {images.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 6, marginBottom: 4, maxWidth: '86%' }}>
          {images.map((b, i) => b.type === 'image' ? (
            <BlobImage key={i} workerId={workerId} mediaType={b.mediaType} size={120}
              {...(b.blob.startsWith('data:') ? { uri: b.blob } : { hash: b.blob || undefined })} />
          ) : null)}
        </View>
      ) : null}
      {text ? (
        <Pressable onLongPress={() => actions.onUserLongPress?.(item)} delayLongPress={350}
          style={{ maxWidth: '86%', backgroundColor: c.bubble, borderRadius: 20, paddingHorizontal: 15, paddingVertical: 10,
            borderWidth: pending?.status === 'failed' ? 1 : 0, borderColor: c.danger, opacity: pending?.status === 'sending' ? 0.7 : 1 }}>
          <Text selectable={!collapsed} numberOfLines={collapsed ? COLLAPSED_LINES : undefined}
            style={{ color: c.bubbleText, fontSize: 16, lineHeight: 23 }}>{text}</Text>
          {long ? (
            <Pressable onPress={() => setExpanded((v) => !v)} hitSlop={8} accessibilityRole="button" accessibilityState={{ expanded }}>
              <Text style={{ color: c.sub, fontSize: 13, fontWeight: '600', marginTop: 4 }}>{expanded ? '收起' : '展开'}</Text>
            </Pressable>
          ) : null}
        </Pressable>
      ) : null}
      {pending?.status === 'sending' ? <Text style={{ color: c.faint, fontSize: 12, marginTop: 4 }}>发送中…</Text> : null}
      {pending?.status === 'sent' ? <Text style={{ color: c.faint, fontSize: 12, marginTop: 4 }}>已送达，等待回显</Text> : null}
      {pending?.status === 'failed' ? (
        <View style={{ flexDirection: 'row', gap: 14, marginTop: 5, alignItems: 'center' }}>
          <Text style={{ color: c.danger, fontSize: 12, flexShrink: 1 }} numberOfLines={1}>发送失败{pending.error ? `：${pending.error}` : ''}</Text>
          <Pressable onPress={() => actions.onRetry?.(pending.clientMsgId)} hitSlop={6}><Text style={{ color: c.tint, fontSize: 13 }}>重新发送</Text></Pressable>
          <Pressable onPress={() => actions.onEdit?.(pending.clientMsgId)} hitSlop={6}><Text style={{ color: c.tint, fontSize: 13 }}>重新编辑</Text></Pressable>
        </View>
      ) : null}
    </View>
  );
}

function MessageItemImpl({ item, workerId, actions }: { item: ViewItem; workerId: string; actions: MessageActions }) {
  const c = usePalette();
  const m = item.message;
  if (m.role === 'user') return <UserMessage item={item} workerId={workerId} actions={actions} />;
  const nv = noticeView(m);
  if (nv) return <NoticeCard v={nv} />;
  const text = m.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
  return <Text style={{ color: c.sub, fontSize: 13, textAlign: 'center', marginVertical: 10, paddingHorizontal: 16 }}>{text}</Text>;
}

export const MessageItem = memo(MessageItemImpl, (a, b) =>
  a.workerId === b.workerId && a.actions === b.actions && sameViewItem(a.item, b.item));
