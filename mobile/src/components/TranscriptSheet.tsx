// Read-only conversation of one background run (its task, tool calls, results, answer); re-read while it runs.
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Text, View } from 'react-native';
import { TASK_STATE_LABEL, buildTurns, selectMessages, transcriptTimeline, type Turn } from '@nopear/core';
import { isActiveTask, type Message, type TaskState, type TaskTranscriptRef } from '@nopear/protocol';
import { engine } from '../engine';
import { COLUMN_MAX, Sheet, usePalette } from '../theme';
import { AssistantTurn } from './AssistantTurn';
import { MessageItem } from './MessageItem';

export const TRANSCRIPT_POLL_MS = 3000;
const column = { width: '100%', maxWidth: COLUMN_MAX, alignSelf: 'center', paddingHorizontal: 16 } as const;
const NO_ACTIONS = {};

type Load = { status: 'loading' } | { status: 'error'; error: string } | { status: 'ready'; messages: Message[]; hasMore: boolean; state?: TaskState };

export function TranscriptSheet(props: {
  visible: boolean; workerId: string; sessionId: string; transcript: TaskTranscriptRef | null; title: string; onClose: () => void;
}) {
  const c = usePalette();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const { workerId, sessionId } = props;
  const runId = props.transcript?.runId;
  const step = props.transcript?.step;

  useEffect(() => {
    if (!props.visible || runId === undefined || step === undefined) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoad({ status: 'loading' });
    const fetchOnce = () => {
      engine.taskTranscript(workerId, sessionId, { runId, step }).then((r) => {
        if (!alive) return;
        setLoad({ status: 'ready', ...r });
        if (r.state && isActiveTask({ state: r.state })) timer = setTimeout(fetchOnce, TRANSCRIPT_POLL_MS);
      }, (e: unknown) => {
        if (!alive) return;
        setLoad((cur) => (cur.status === 'ready' ? cur : { status: 'error', error: e instanceof Error ? e.message : String(e) }));
      });
    };
    fetchOnce();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [props.visible, workerId, sessionId, runId, step]);

  const messages = load.status === 'ready' ? load.messages : null;
  const turns = useMemo<Turn[]>(() => (messages ? buildTurns(selectMessages(transcriptTimeline(messages))).reverse() : []), [messages]);
  const live = load.status === 'ready' && !!load.state && isActiveTask({ state: load.state });
  const badge = load.status === 'ready' && load.state ? `${TASK_STATE_LABEL[load.state]}${live ? ' · 自动刷新' : ''}` : '';

  return (
    <Sheet visible={props.visible} title={props.title || '过程'} onClose={props.onClose} scroll={false}
      right={badge ? <Text style={{ color: c.sub, fontSize: 12 }}>{badge}</Text> : null}>
      {load.status === 'loading' ? <ActivityIndicator color={c.sub} style={{ marginTop: 40 }} /> : null}
      {load.status === 'error' ? <Text style={{ color: c.danger, textAlign: 'center', margin: 24 }}>读取失败：{load.error}</Text> : null}
      {load.status === 'ready' ? (
        <FlatList
          inverted
          data={turns}
          keyExtractor={(t) => t.key}
          renderItem={({ item: t, index }) => (
            <View style={column}>
              {t.kind === 'message'
                ? <MessageItem item={t.item} workerId={workerId} actions={NO_ACTIONS} />
                : <AssistantTurn segments={t.segments} workerId={workerId} live={live && index === 0} />}
            </View>
          )}
          contentContainerStyle={{ paddingVertical: 12, flexGrow: 1 }}
          ListHeaderComponent={live ? (
            <View style={[column, { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 }]}>
              <ActivityIndicator size="small" color={c.tint} />
              <Text style={{ color: c.sub, fontSize: 13 }}>运行中</Text>
            </View>
          ) : null}
          ListFooterComponent={load.hasMore ? <Text style={{ color: c.faint, fontSize: 12, textAlign: 'center', padding: 12 }}>只显示最近 {load.messages.length} 条</Text> : null}
          ListEmptyComponent={<Text style={{ color: c.sub, textAlign: 'center', marginTop: 40, transform: [{ scaleY: -1 }] }}>{live ? '还没开始，稍等…' : '没有记录'}</Text>}
        />
      ) : null}
    </Sheet>
  );
}
