// Background tasks of a session (pi-subagents runs): running + recently finished, workflow steps, live activity,
// failure reasons, stop, and each run's own conversation (TranscriptSheet).
import { useEffect, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import { TASK_STATE_LABEL, activityLine, splitTasks, taskSeconds, taskTitle, taskTone, type TaskTone } from '@nopear/core';
import type { BackgroundTask, TaskStep, TaskTranscriptRef } from '@nopear/protocol';
import { Button, Empty, Section, Sheet, mono, usePalette, type Palette } from '../theme';
import { TranscriptSheet } from './TranscriptSheet';

export function secondsLabel(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h${m}m`;
  if (m) return `${m}m${s % 60}s`;
  return `${s}s`;
}
const toneColor = (c: Palette, t: TaskTone) => (t === 'live' ? c.ok : t === 'wait' ? c.warn : t === 'ok' ? c.ok : t === 'bad' ? c.danger : c.faint);

function Dot({ tone }: { tone: TaskTone }) {
  const c = usePalette();
  return <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: toneColor(c, tone), opacity: tone === 'ok' ? 0.6 : 1 }} />;
}

interface Open { ref: TaskTranscriptRef; title: string }

export function TasksSheet(props: {
  visible: boolean; workerId: string; sessionId: string; tasks: BackgroundTask[]; onClose: () => void; onStop: (id: string) => Promise<void>;
}) {
  const c = usePalette();
  const [now, setNow] = useState(Date.now());
  const [open, setOpen] = useState<Open | null>(null);
  const { active, finished } = splitTasks(props.tasks);
  useEffect(() => {
    if (!props.visible || active.length === 0) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [props.visible, active.length]);
  const list = (ts: BackgroundTask[]) => ts.map((t, i) => (
    <TaskRow key={t.id} task={t} now={now} last={i === ts.length - 1} onOpen={setOpen}
      onStop={() => props.onStop(t.id).catch((e) => Alert.alert('停止失败', e instanceof Error ? e.message : String(e)))} />
  ));
  return (
    <Sheet visible={props.visible} title="后台任务" onClose={props.onClose}>
      {props.tasks.length === 0 ? <Empty title="没有后台任务" /> : null}
      {props.tasks.length > 0 && active.length === 0 ? <Text style={{ color: c.sub, fontSize: 13, margin: 16, marginBottom: 0 }}>没有在跑的后台任务</Text> : null}
      {active.length ? <Section title="运行中">{list(active)}</Section> : null}
      {finished.length ? <Section title="已结束">{list(finished)}</Section> : null}
      <TranscriptSheet visible={open !== null} workerId={props.workerId} sessionId={props.sessionId}
        transcript={open?.ref ?? null} title={open?.title ?? ''} onClose={() => setOpen(null)} />
    </Sheet>
  );
}

function TaskRow({ task: t, now, last, onOpen, onStop }: { task: BackgroundTask; now: number; last: boolean; onOpen: (o: Open) => void; onStop: () => void }) {
  const c = usePalette();
  const tone = taskTone(t.state);
  const live = tone === 'live' || tone === 'wait';
  const activity = activityLine(t.activity);
  const title = taskTitle(t);
  return (
    <View style={{ padding: 14, gap: 6, borderBottomWidth: last ? 0 : 0.5, borderBottomColor: c.sep }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Dot tone={tone} />
        <Text style={{ flex: 1, color: c.text, fontSize: 15, fontWeight: '600' }} numberOfLines={2}>{title}</Text>
      </View>
      <Text style={{ color: t.state === 'failed' ? c.danger : c.sub, fontSize: 13 }} numberOfLines={1}>
        {TASK_STATE_LABEL[t.state]} · {t.agent} · {secondsLabel(taskSeconds(t, now))}{t.model ? ` · ${t.model}` : ''}
      </Text>
      {activity ? <Text style={[mono, { color: c.sub, fontSize: 12 }]} numberOfLines={1}>{activity}</Text> : null}
      {t.activity?.output && live ? <Text style={{ color: c.faint, fontSize: 12, fontStyle: 'italic' }} numberOfLines={2}>{t.activity.output}</Text> : null}
      {t.error ? <Text selectable style={{ color: c.danger, fontSize: 12 }} numberOfLines={5}>{t.error}</Text> : null}
      {t.steps?.length ? (
        <View style={{ marginTop: 4, gap: 2, borderLeftWidth: 1, borderLeftColor: c.sep, paddingLeft: 10 }}>
          {t.steps.map((s) => <StepRow key={s.key} step={s} now={now} onOpen={onOpen} />)}
        </View>
      ) : null}
      {t.transcript || live ? (
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 2 }}>
          {t.transcript ? <Button small kind="tinted" title="查看过程" onPress={() => onOpen({ ref: t.transcript!, title })} /> : null}
          {live ? <Button small kind="danger" title="停止" onPress={onStop} /> : null}
        </View>
      ) : null}
    </View>
  );
}

function StepRow({ step: s, now, onOpen }: { step: TaskStep; now: number; onOpen: (o: Open) => void }) {
  const c = usePalette();
  const can = !!s.transcript && s.state !== 'queued';
  const activity = activityLine(s.activity);
  return (
    <Pressable disabled={!can} onPress={() => onOpen({ ref: s.transcript!, title: s.label })} accessibilityRole={can ? 'button' : undefined}
      accessibilityLabel={`${s.label} ${TASK_STATE_LABEL[s.state]}`} style={({ pressed }) => ({ paddingVertical: 5, opacity: pressed ? 0.6 : 1 })}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Dot tone={taskTone(s.state)} />
        <Text style={{ color: c.text, fontSize: 14, fontWeight: '500', flexShrink: 1 }} numberOfLines={1}>{s.label}</Text>
        <Text style={{ color: c.sub, fontSize: 12 }}>{TASK_STATE_LABEL[s.state]}{s.startedAt ? ` · ${secondsLabel(taskSeconds(s, now))}` : ''}</Text>
        {can ? <Text style={{ color: c.tint, fontSize: 13, marginLeft: 'auto' }}>过程 ›</Text> : null}
      </View>
      {activity ? <Text style={[mono, { color: c.sub, fontSize: 11.5, marginLeft: 13 }]} numberOfLines={1}>{activity}</Text> : null}
      {s.error ? <Text selectable style={{ color: c.danger, fontSize: 12, marginLeft: 13 }} numberOfLines={3}>{s.error}</Text> : null}
    </Pressable>
  );
}
