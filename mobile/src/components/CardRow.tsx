// One board card row: tap opens its session (or shows the description), long-press → 移动到… / 删除.
import { Alert, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { Card } from '@nopear/protocol';
import { engine, errorText, useEngine } from '../engine';
import { sessionHref } from '../format';
import { cardMenu, moveTargets } from '../boardMoves';
import { actionMenu } from '../QuickAdd';
import { Pill, usePalette } from '../theme';

export function CardRow({ card, last }: { card: Card; last?: boolean }) {
  const c = usePalette();
  const projects = useEngine((s) => s.projects);
  const machines = useEngine((s) => s.machines);
  const project = card.projectId ? projects[card.projectId]?.name ?? card.projectId : null;
  const machine = card.workerId ? machines[card.workerId]?.label ?? card.workerId : null;
  const move = () => {
    const list = Object.values(machines).sort((a, b) => a.label.localeCompare(b.label));
    actionMenu(Platform.OS === 'ios' ? '移动到…' : card.title, cardMenu(
      moveTargets(card, list),
      (t) => void engine.updateCard(card.id, t.patch).catch((e) => Alert.alert('移动失败', errorText(e))),
      remove,
      Platform.OS === 'ios' ? 'ios' : 'android',
    ));
  };
  const remove = () => {
    const note = card.state === 'running' ? '执行中的会话会被中断。' : undefined;
    Alert.alert(`删除卡片「${card.title}」？`, note, [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive',
        onPress: () => void engine.deleteCard(card.id).catch((e) => Alert.alert('删除失败', errorText(e))) },
    ]);
  };
  const open = () => {
    if (card.workerId && card.sessionId) router.push(sessionHref(card.workerId, card.sessionId) as never);
    else Alert.alert(card.title, card.body || '（无描述）');
  };
  return (
    <Pressable onPress={open} onLongPress={move}
      style={({ pressed }) => ({ backgroundColor: pressed ? c.hover : c.card, paddingHorizontal: 16, paddingVertical: 12, gap: 5,
        borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth, borderBottomColor: c.sep })}>
      <Text style={{ color: c.text, fontSize: 15.5 }} numberOfLines={2}>{card.title}</Text>
      {project || machine ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {project ? <Pill text={project} /> : null}
          {machine ? <Pill text={`🖥 ${machine}`} /> : null}
          {card.sessionId ? <Pill text="会话 ›" color={c.tint} /> : null}
        </View>
      ) : null}
      {card.error ? <Text style={{ color: c.danger, fontSize: 13 }} numberOfLines={3}>{card.error}</Text> : null}
    </Pressable>
  );
}
