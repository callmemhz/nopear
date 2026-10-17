// Inverted chat list of turns (newest at the bottom; reaching the top loads older pages) in a centered readable column.
import { useMemo } from 'react';
import { ActivityIndicator, FlatList, Text, View } from 'react-native';
import { buildTurns, selectMessages, type TimelineState, type Turn } from '@nopear/core';
import { MessageItem, type MessageActions } from './MessageItem';
import { AssistantTurn } from './AssistantTurn';
import { COLUMN_MAX, usePalette } from '../theme';

const column = { width: '100%', maxWidth: COLUMN_MAX, alignSelf: 'center', paddingHorizontal: 16 } as const;

export function MessageList(props: {
  timeline: TimelineState | undefined; workerId: string; actions: MessageActions;
  loadingEarlier: boolean; onLoadEarlier: () => void; running: boolean;
}) {
  const c = usePalette();
  const turns = useMemo<Turn[]>(() => (props.timeline ? buildTurns(selectMessages(props.timeline)).reverse() : []), [props.timeline]);
  const hasMore = props.timeline?.hasMore ?? false;
  return (
    <FlatList
      inverted
      data={turns}
      keyExtractor={(t) => t.key}
      renderItem={({ item: t, index }) => (
        <View style={column}>
          {t.kind === 'message'
            ? <MessageItem item={t.item} workerId={props.workerId} actions={props.actions} />
            : <AssistantTurn segments={t.segments} workerId={props.workerId} live={props.running && index === 0} />}
        </View>
      )}
      onEndReached={() => { if (hasMore && !props.loadingEarlier && turns.length > 0) props.onLoadEarlier(); }}
      onEndReachedThreshold={0.4}
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingVertical: 12 }}
      ListHeaderComponent={props.running ? (
        <View style={[column, { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 }]}>
          <ActivityIndicator size="small" color={c.tint} />
          <Text style={{ color: c.sub, fontSize: 13 }}>运行中</Text>
        </View>
      ) : null}
      ListFooterComponent={hasMore && turns.length > 0 ? (
        <View style={{ padding: 12, alignItems: 'center' }}>
          {props.loadingEarlier ? <ActivityIndicator color={c.sub} /> : <Text style={{ color: c.faint, fontSize: 12 }}>上滑加载更早</Text>}
        </View>
      ) : null}
      ListEmptyComponent={props.timeline ? null : <ActivityIndicator color={c.sub} style={{ marginTop: 40 }} />}
    />
  );
}
