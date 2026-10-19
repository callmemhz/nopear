// Session chat: custom top bar (title + project chip + machine, … menu), streaming timeline of turns, composer card
// with model / thinking chips, Ask / tasks / files / model sheets, rewind / fork, interrupt.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { sessionKey, THINKING_LEVELS, type Attachment } from '@nopear/protocol';
import { activeTaskCount, type ViewItem } from '@nopear/core';
import { engine, errorText, useEngine } from '../../../src/engine';
import { modelLabel, sessionHref, sessionTitle } from '../../../src/format';
import { clearActiveSession, setActiveSession } from '../../../src/notifications';
import { MessageList } from '../../../src/components/MessageList';
import { Composer } from '../../../src/components/Composer';
import { QueueCards } from '../../../src/components/QueueCards';
import { AskSheet } from '../../../src/components/AskSheet';
import { TasksSheet } from '../../../src/components/TasksSheet';
import { FilesSheet } from '../../../src/components/FilesSheet';
import { ModelPicker } from '../../../src/components/ModelPicker';
import { OfflineBanner } from '../../../src/components/OfflineBanner';
import { TopBar, TopBarButton } from '../../../src/components/TopBar';
import { flagOptions, pickProjectTag, renameSession } from '../../../src/sessionActions';
import { usePalette } from '../../../src/theme';
import { actionMenu } from '../../../src/QuickAdd';

const fail = (title: string) => (e: unknown) => Alert.alert(title, errorText(e));

export default function SessionRoute() {
  const params = useLocalSearchParams<{ workerId: string; sessionId: string }>();
  const workerId = String(params.workerId);
  const sessionId = String(params.sessionId);
  // keyed: switching sessions in place (drawer → replace) starts from that session's own draft / sheets state
  return <SessionScreen key={sessionKey(workerId, sessionId)} workerId={workerId} sessionId={sessionId} />;
}

function SessionScreen({ workerId, sessionId }: { workerId: string; sessionId: string }) {
  const c = usePalette();
  const key = sessionKey(workerId, sessionId);

  const timeline = useEngine((s) => s.timelines[key]);
  const listed = useEngine((s) => s.sessions[workerId]?.[sessionId]);
  const info = useEngine((s) => s.workerInfo[workerId]);
  const savedDraft = useEngine((s) => s.drafts[key]);
  const projects = useEngine((s) => s.projects);
  const machineLabel = useEngine((s) => s.machines[workerId]?.label ?? workerId);
  // same rule as web: the composer is disabled while the machine is offline
  const offline = useEngine((s) => !s.machines[workerId]?.online || s.machineConn[workerId] === 'offline');
  const session = timeline?.session ?? listed;
  const running = session?.status === 'running';

  const [text, setText] = useState(savedDraft ?? '');
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);

  useEffect(() => {
    engine.openSession(workerId, sessionId);
    return () => { engine.closeSession(workerId, sessionId); };
  }, [workerId, sessionId]);

  // "当前正在看的会话不弹": track focus, not mount — a pushed screen (e.g. fork) blurs this one and
  // going back re-focuses it.
  useFocusEffect(
    useCallback(() => {
      setActiveSession(workerId, sessionId);
      return () => clearActiveSession(workerId, sessionId);
    }, [workerId, sessionId]),
  );

  const onText = useCallback((t: string) => { setText(t); engine.setDraft(workerId, sessionId, t); }, [workerId, sessionId]);
  const prompt = timeline?.prompts[0] ?? null;
  const tasks = timeline?.tasks ?? [];
  const runningTasks = activeTaskCount(tasks);

  useEffect(() => { if (prompt) setAskOpen(true); }, [prompt?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const forkAt = useCallback(async (messageId?: string) => {
    try {
      const s = await engine.fork(workerId, sessionId, messageId);
      router.push(sessionHref(workerId, s.id) as never);
    } catch (e) { fail('分叉失败')(e); }
  }, [workerId, sessionId]);

  const openMenu = useCallback(() => {
    if (!session) return;
    const tag = session.projectId ? projects[session.projectId]?.name ?? session.projectId : null;
    actionMenu(sessionTitle(session), [
      { label: '文件', run: () => setFilesOpen(true) },
      { label: `后台任务${runningTasks ? `（${runningTasks}）` : ''}`, run: () => setTasksOpen(true) },
      ...flagOptions(session).slice(0, 2),
      { label: tag ? `项目标签：${tag}…` : '设置项目标签…', run: () => pickProjectTag(session, projects) },
      { label: '重命名', run: () => renameSession(session) },
      { label: '分叉一份继续', run: () => void forkAt() },
      { label: '机器记忆（AGENTS.md）', run: () => router.push(`/memory/${encodeURIComponent(workerId)}` as never) },
      { label: '模型与思考…', run: () => setModelOpen(true) },
      ...flagOptions(session).slice(2),
    ]);
  }, [session, projects, runningTasks, workerId, forkAt]);

  const actions = useMemo(() => ({
    onUserLongPress: (item: ViewItem) => {
      const m = item.message;
      if (m.id.startsWith('local:')) return;
      actionMenu('这条消息', [
        { label: '撤回到这条之前（回填输入框）', destructive: true, run: () => {
          engine.rewind(workerId, sessionId, m.id).then((t) => onText(t)).catch(fail('撤回失败'));
        } },
        { label: '从这里分叉', run: () => void forkAt(m.id) },
      ]);
    },
    onRetry: (cid: string) => void engine.retrySend(workerId, sessionId, cid),
    onEdit: (cid: string) => onText(engine.discardSend(workerId, sessionId, cid)),
  }), [workerId, sessionId, onText, forkAt]);

  const send = async (t: string, atts: Attachment[], delivery: 'followUp' | 'steer') => {
    engine.setDraft(workerId, sessionId, '');
    await engine.send(workerId, sessionId, t, { ...(atts.length ? { attachments: atts } : {}), ...(running ? { delivery } : {}) });
  };
  const pickThinking = () => {
    if (!session) return;
    actionMenu('思考强度（下一轮生效）', THINKING_LEVELS.map((t) => ({
      label: t === session.thinking ? `✓ ${t}` : t,
      run: () => void engine.updateSession(workerId, sessionId, { thinking: t }).catch(fail('修改失败')),
    })));
  };

  const projectName = session?.projectId ? projects[session.projectId]?.name ?? null : null;
  const subtitle = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 1, maxWidth: '100%' }}>
      {projectName ? (
        <View style={{ backgroundColor: c.elevated, borderRadius: 999, paddingHorizontal: 7, paddingVertical: 1, flexShrink: 1 }}>
          <Text numberOfLines={1} style={{ color: c.sub, fontSize: 11, fontWeight: '600' }}>{projectName}</Text>
        </View>
      ) : null}
      <Text numberOfLines={1} style={{ color: c.faint, fontSize: 11.5, flexShrink: 1 }}>{machineLabel}</Text>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <TopBar title={session ? sessionTitle(session) : '会话'} subtitle={subtitle} onTitlePress={session ? openMenu : undefined}
        right={<TopBarButton icon="more" label="更多操作" onPress={openMenu} disabled={!session} />} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <OfflineBanner workerId={workerId} />
        {prompt && !askOpen ? (
          <Pressable onPress={() => setAskOpen(true)} style={{ backgroundColor: c.warnSoft, padding: 10 }}>
            <Text style={{ color: c.warn, textAlign: 'center', fontWeight: '600' }}>AI 在等你回答问题 · 点此作答</Text>
          </Pressable>
        ) : null}
        {runningTasks ? (
          <Pressable onPress={() => setTasksOpen(true)} style={{ paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.sep }}>
            <Text style={{ color: c.sub, fontSize: 13, textAlign: 'center' }}>{runningTasks} 个后台任务运行中 ›</Text>
          </Pressable>
        ) : null}
        <View style={{ flex: 1 }}>
          <MessageList
            timeline={timeline}
            workerId={workerId}
            actions={actions}
            running={running}
            loadingEarlier={loadingEarlier}
            onLoadEarlier={() => {
              setLoadingEarlier(true);
              engine.loadEarlier(workerId, sessionId).catch(() => {}).finally(() => setLoadingEarlier(false));
            }}
          />
        </View>
        <QueueCards workerId={workerId} sessionId={sessionId} draft={text} onEdit={onText} />
        <Composer
          value={text}
          onChange={onText}
          running={running}
          disabled={offline}
          onSend={send}
          onInterrupt={() => void engine.interrupt(workerId, sessionId).catch(fail('中断失败'))}
          model={session ? { label: modelLabel(session.model, info?.models), onPress: () => setModelOpen(true) } : null}
          thinking={session ? { label: `思考 ${session.thinking}`, icon: 'bulb', onPress: pickThinking } : null}
        />
      </KeyboardAvoidingView>
      <AskSheet prompt={askOpen ? prompt : null} onClose={() => setAskOpen(false)}
        onSubmit={(answers, note) => engine.answerPrompt(workerId, sessionId, prompt!.id, answers, note)} />
      <TasksSheet visible={tasksOpen} workerId={workerId} sessionId={sessionId} tasks={tasks} onClose={() => setTasksOpen(false)} onStop={(id) => engine.stopTask(workerId, sessionId, id)} />
      <FilesSheet visible={filesOpen} workerId={workerId} sessionId={sessionId} onClose={() => setFilesOpen(false)} />
      {session ? (
        <ModelPicker visible={modelOpen} models={info?.models ?? []} model={session.model} thinking={session.thinking}
          onClose={() => setModelOpen(false)}
          onChange={(v) => void engine.updateSession(workerId, sessionId, v).catch(fail('修改失败'))} />
      ) : null}
    </View>
  );
}
