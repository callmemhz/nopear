// Projects: every project (name, description, machines with a path) → project detail.
import { useMemo } from 'react';
import { ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { useEngine } from '../src/engine';
import { projectHref } from '../src/format';
import { TopBar } from '../src/components/TopBar';
import { Empty, Row, Section, usePalette } from '../src/theme';

export default function Projects() {
  const c = usePalette();
  const projects = useEngine((s) => s.projects);
  const machines = useEngine((s) => s.machines);
  const list = useMemo(() => Object.values(projects).sort((a, b) => a.name.localeCompare(b.name)), [projects]);
  return (
    <View style={{ flex: 1, backgroundColor: c.grouped }}>
      <TopBar title="项目" />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <Section footer="新建项目与设置各机器路径请在 web 控制台操作。">
          {list.length === 0 ? <Empty title="还没有项目" hint="在 web 控制台新建项目，并为各机器设置路径" /> : null}
          {list.map((p, i) => {
            const where = Object.keys(p.paths).map((w) => machines[w]?.label ?? w).join('、');
            return (
              <Row key={p.id} title={p.name} chevron last={i === list.length - 1}
                subtitle={[p.description, where ? `🖥 ${where}` : ''].filter(Boolean).join(' · ') || undefined}
                onPress={() => router.push(projectHref(p.id) as never)} />
            );
          })}
        </Section>
      </ScrollView>
    </View>
  );
}
