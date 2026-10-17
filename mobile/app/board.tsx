// Global board (all machines, all projects): sections in column order; long-press a card → 「移动到…」 / 删除.
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { groupBoard } from '@nopear/core';
import type { Card, Machine } from '@nopear/protocol';
import { useEngine } from '../src/engine';
import { projectHref } from '../src/format';
import { QuickAdd } from '../src/QuickAdd';
import { CardRow } from '../src/components/CardRow';
import { TopBar } from '../src/components/TopBar';
import { Row, Section, usePalette } from '../src/theme';

/** undefined = all cards; null = cards without a project; string = that project. */
type Filter = string | null | undefined;


function Column({ title, cards, dim }: { title: string; cards: Card[]; dim?: boolean }) {
  const c = usePalette();
  return (
    <View style={{ opacity: dim ? 0.6 : 1 }}>
      <Section title={`${title} · ${cards.length}`}>
        {cards.length === 0 ? <Text style={{ color: c.faint, fontSize: 14, padding: 14 }}>空</Text> : null}
        {cards.map((card, i) => <CardRow key={card.id} card={card} last={i === cards.length - 1} />)}
      </Section>
    </View>
  );
}

export default function Board() {
  const c = usePalette();
  const cards = useEngine((s) => s.cards);
  const projects = useEngine((s) => s.projects);
  const machines = useEngine((s) => s.machines);
  const [filter, setFilter] = useState<Filter>(undefined);

  const projectList = useMemo(() => Object.values(projects).sort((a, b) => a.name.localeCompare(b.name)), [projects]);
  const cols = useMemo(() => groupBoard(Object.values(cards), filter), [cards, filter]);
  // one 「待开始」 section per machine (offline ones dimmed), plus queues of machines no longer listed
  const queues = useMemo(() => {
    const list: { id: string; machine?: Machine }[] = Object.values(machines)
      .sort((a, b) => a.label.localeCompare(b.label)).map((m) => ({ id: m.workerId, machine: m }));
    for (const id of Object.keys(cols.queued)) if (!machines[id]) list.push({ id });
    return list;
  }, [machines, cols.queued]);

  const chips: { label: string; value: Filter }[] = [
    { label: '全部', value: undefined }, { label: '无项目', value: null },
    ...projectList.map((p) => ({ label: p.name, value: p.id })),
  ];
  const selected = typeof filter === 'string' ? projects[filter] : undefined;

  return (
    <View style={{ flex: 1, backgroundColor: c.grouped }}>
      <TopBar title="看板" />
      <ScrollView style={{ backgroundColor: c.grouped }} contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        <QuickAdd key={String(filter)} projectId={typeof filter === 'string' ? filter : null} />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 12, gap: 8 }}>
          {chips.map((ch) => {
            const on = ch.value === filter;
            return (
              <Pressable key={String(ch.value)} onPress={() => setFilter(ch.value)}
                style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, backgroundColor: on ? c.text : c.card, borderWidth: 1, borderColor: on ? c.text : c.sep }}>
                <Text style={{ color: on ? c.bg : c.text, fontSize: 14 }}>{ch.label}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
        {selected ? (
          <Section>
            <Row title={selected.name} subtitle={selected.description || '项目详情'} chevron last
              onPress={() => router.push(projectHref(selected.id) as never)} />
          </Section>
        ) : null}

        <Column title="收件箱" cards={cols.inbox} />
        {queues.map((q) => (
          <Column key={q.id} title={`待开始 · ${q.machine?.label ?? q.id}${q.machine && !q.machine.online ? '（离线）' : ''}`}
            cards={cols.queued[q.id] ?? []} dim={!q.machine?.online} />
        ))}
        <Column title="进行中" cards={cols.running} />
        <Column title="待验收" cards={cols.review} />
        <Column title="完成" cards={cols.done} />
      </ScrollView>
    </View>
  );
}
