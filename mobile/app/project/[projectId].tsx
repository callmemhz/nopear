// Project detail: description, per-machine paths (read-only; edit on web), project memory, cards and sessions; 删除项目.
import { useMemo } from 'react';
import { Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { groupBoard } from '@nopear/core';
import type { Card } from '@nopear/protocol';
import { engine, errorText, useEngine } from '../../src/engine';
import { relativeTime, sessionHref, shortPath } from '../../src/format';
import { Dot, Empty, Row, Section, mono, statusColor, usePalette } from '../../src/theme';
import { CardRow } from '../../src/components/CardRow';
import { MemoryEditor } from '../../src/components/MemoryEditor';
import { TopBar } from '../../src/components/TopBar';

const STATE_LABEL: Record<Card['state'], string> = { inbox: '收件箱', queued: '待开始', running: '进行中', review: '待验收', done: '完成' };

export default function ProjectDetail() {
  const c = usePalette();
  const projectId = String(useLocalSearchParams<{ projectId: string }>().projectId);
  const project = useEngine((s) => s.projects[projectId]);
  const machines = useEngine((s) => s.machines);
  const cards = useEngine((s) => s.cards);
  const index = useEngine((s) => s.sessionIndex);

  const sections = useMemo(() => {
    const cols = groupBoard(Object.values(cards), projectId);
    return [
      { state: 'inbox' as const, cards: cols.inbox },
      { state: 'queued' as const, cards: Object.values(cols.queued).flat() },
      { state: 'running' as const, cards: cols.running },
      { state: 'review' as const, cards: cols.review },
      { state: 'done' as const, cards: cols.done },
    ].filter((s) => s.cards.length > 0);
  }, [cards, projectId]);
  const sessions = useMemo(() => Object.values(index)
    .filter((e) => e.projectId === projectId)
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)), [index, projectId]);

  if (!project) {
    return (
      <View style={{ flex: 1, backgroundColor: c.grouped }}>
        <TopBar title="项目" />
        <Empty title="项目不存在" hint="可能已被删除" />
      </View>
    );
  }
  const paths = Object.entries(project.paths);
  const remove = () => {
    Alert.alert(`删除项目「${project.name}」？`, '其卡片、项目记忆与会话标签一并删除。执行中的卡片会话会被中断。', [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive',
        onPress: () => void engine.deleteProject(projectId).then(() => router.back(), (e) => Alert.alert('删除失败', errorText(e))) },
    ]);
  };
  return (
    <View style={{ flex: 1, backgroundColor: c.grouped }}>
      <TopBar title={project.name} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView style={{ backgroundColor: c.grouped }} contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
          {project.description ? (
            <Section title="描述"><Text style={{ color: c.text, fontSize: 15, padding: 14 }}>{project.description}</Text></Section>
          ) : null}
          <Section title="各机器路径" footer="路径在 web 控制台的项目页编辑。">
            {paths.length === 0 ? <Text style={{ color: c.faint, fontSize: 14, padding: 14 }}>还没有设置路径</Text> : null}
            {paths.map(([wid, p], i) => (
              <View key={wid} style={{ paddingHorizontal: 16, paddingVertical: 10, gap: 2, borderBottomWidth: i === paths.length - 1 ? 0 : StyleSheet.hairlineWidth, borderBottomColor: c.sep }}>
                <Text style={{ color: c.text, fontSize: 15 }}>{machines[wid]?.label ?? wid}</Text>
                <Text selectable style={{ color: c.sub, fontSize: 13, ...mono }}>{shortPath(p, 48)}</Text>
              </View>
            ))}
          </Section>
  
          <Section title="项目记忆">
            <View style={{ padding: 12 }}><MemoryEditor scope="project" projectId={projectId} minHeight={160} /></View>
          </Section>
  
          {sections.length === 0 ? <Section title="卡片"><Text style={{ color: c.faint, fontSize: 14, padding: 14 }}>没有卡片</Text></Section> : null}
          {sections.map((s) => (
            <Section key={s.state} title={`${STATE_LABEL[s.state]} · ${s.cards.length}`}>
              {s.cards.map((card, i) => <CardRow key={card.id} card={card} last={i === s.cards.length - 1} />)}
            </Section>
          ))}
  
          <Section title="会话">
            {sessions.length === 0 ? <Text style={{ color: c.faint, fontSize: 14, padding: 14 }}>没有带此项目标签的会话</Text> : null}
            {sessions.map((e, i) => (
              <Row key={`${e.workerId}/${e.sessionId}`} title={e.title}
                subtitle={`${machines[e.workerId]?.label ?? e.workerId} · ${relativeTime(e.lastActivityAt)}${e.preview ? ` · ${e.preview}` : ''}`}
                left={<Dot color={statusColor(c, e.status)} />} chevron last={i === sessions.length - 1}
                onPress={() => router.push(sessionHref(e.workerId, e.sessionId) as never)} />
            ))}
          </Section>
  
          <Section>
            <Row title="删除项目" destructive onPress={remove} last />
          </Section>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}
