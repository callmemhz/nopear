// 「新会话」 (empty chat): greeting, chips for machine / working directory / project / title (open the
// session settings sheet), and the composer card with model + thinking chips; sending creates the session.
import { useEffect, useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { THINKING_LEVELS, type Attachment, type ThinkingLevel } from '@nopear/protocol';
import { recentCwds } from '@nopear/core';
import { engine, useEngine } from '../engine';
import { modelLabel, sessionHref, shortPath } from '../format';
import { cwdChip, pickerStart } from '../dirPicker';
import { actionMenu } from '../QuickAdd';
import { Composer } from '../components/Composer';
import { ModelPicker } from '../components/ModelPicker';
import { DirPickerSheet } from '../components/DirPickerSheet';
import { Icon, type IconName } from '../components/Icon';
import { TopBar } from '../components/TopBar';
import { Button, Field, Row, Section, Sheet, usePalette } from '../theme';

function Chip({ icon, label, onPress, muted }: { icon: IconName; label: string; onPress: () => void; muted?: boolean }) {
  const c = usePalette();
  return (
    <Pressable onPress={onPress} accessibilityRole="button"
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: 260, paddingHorizontal: 12, height: 34,
        borderRadius: 17, borderWidth: 1, borderColor: c.sep, backgroundColor: pressed ? c.hover : c.card })}>
      <Icon name={icon} size={15} color={c.sub} />
      <Text numberOfLines={1} style={{ color: muted ? c.faint : c.text, fontSize: 14, flexShrink: 1 }}>{label}</Text>
    </Pressable>
  );
}

export function NewSession({ initial, onDirty }: { initial?: { projectId?: string; workerId?: string }; onDirty?: () => void }) {
  const c = usePalette();
  const machines = useEngine((s) => s.machines);
  const conn = useEngine((s) => s.machineConn);
  const infos = useEngine((s) => s.workerInfo);
  const projects = useEngine((s) => s.projects);
  const sessions = useEngine((s) => s.sessions);
  const sessionIndex = useEngine((s) => s.sessionIndex);
  // same rule as web: online and not known-offline
  const online = useMemo(() => Object.values(machines).filter((m) => m.online && conn[m.workerId] !== 'offline')
    .sort((a, b) => a.label.localeCompare(b.label)), [machines, conn]);
  const [projectId, setProjectId] = useState(initial?.projectId ?? '');
  const projectPath = (w: string, pid = projectId) => (pid && projects[pid]?.paths[w]) || '';
  const [workerId, setWorkerId] = useState(() =>
    (initial?.workerId && online.some((m) => m.workerId === initial.workerId) ? initial.workerId : online[0]?.workerId) ?? '');
  const info = workerId ? infos[workerId] : undefined;
  const [cwd, setCwd] = useState(() => projectPath(workerId));
  const [title, setTitle] = useState('');
  const [model, setModel] = useState('');
  const [thinking, setThinking] = useState<ThinkingLevel>('medium');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const recent = useMemo(() => (workerId ? recentCwds({ projects, sessions, sessionIndex }, workerId) : []),
    [projects, sessions, sessionIndex, workerId]);

  const selectedOnline = online.some((m) => m.workerId === workerId);
  // keep a usable selection: if the chosen machine goes offline (or none chosen), switch to another online one
  useEffect(() => {
    if (!selectedOnline && online[0]) setWorkerId(online[0].workerId);
  }, [online, selectedOnline]);
  // apply worker defaults only when the target machine changes (not on every workerInfo refresh)
  const appliedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!info || appliedFor.current === workerId) return;
    appliedFor.current = workerId;
    setCwd(projectPath(workerId) || info.defaultCwd);
    setModel(info.defaultModel);
    setThinking(info.defaultThinking);
  }, [info, workerId]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickMachine = (w: string) => {
    setWorkerId(w);
    const p = projectPath(w);
    if (p) setCwd(p);
  };
  const pickProject = (pid: string) => {
    setProjectId(pid);
    const p = projectPath(workerId, pid);
    if (p) setCwd(p);
  };
  const projectMenu = () => actionMenu('项目标签', [
    { label: projectId ? '无项目' : '✓ 无项目', run: () => pickProject('') },
    ...Object.values(projects).sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({ label: p.id === projectId ? `✓ ${p.name}` : p.name, run: () => pickProject(p.id) })),
  ]);
  const thinkingMenu = () => actionMenu('思考强度', THINKING_LEVELS.map((t) => ({ label: t === thinking ? `✓ ${t}` : t, run: () => setThinking(t) })));

  const onText = (t: string) => { setText(t); if (t) onDirty?.(); };
  const create = async (t: string, attachments: Attachment[]) => {
    if (!workerId || !selectedOnline) throw new Error('没有选中在线机器');
    onDirty?.();
    setBusy(true);
    try {
      const args: Parameters<typeof engine.createSession>[1] = { text: t, thinking };
      if (cwd.trim()) args.cwd = cwd.trim();
      if (title.trim()) args.title = title.trim();
      if (projectId) args.projectId = projectId;
      if (model) args.model = model;
      if (attachments.length) args.attachments = attachments;
      const s = await engine.createSession(workerId, args);
      router.replace(sessionHref(workerId, s.id) as never);
    } finally { setBusy(false); }
  };

  const machineLabel = workerId ? machines[workerId]?.label ?? workerId : '选择机器';
  const projectName = projectId ? projects[projectId]?.name ?? projectId : null;

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <TopBar title="新会话" />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 24, gap: 18 }}
          keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">
          <View style={{ alignItems: 'center', gap: 10 }}>
            <Icon name="sparkle" size={34} color={c.tint} strokeWidth={2} />
            <Text style={{ color: c.text, fontSize: 24, fontWeight: '600', textAlign: 'center' }}>今天想让 AI 做什么？</Text>
          </View>
          {online.length === 0 ? (
            <View style={{ alignItems: 'center', gap: 10 }}>
              <Text style={{ color: c.sub, fontSize: 14, textAlign: 'center' }}>没有在线的机器。先认领一台并让它的 worker 在线。</Text>
              <Button kind="tinted" small title="去机器页" onPress={() => router.push('/machines')} />
            </View>
          ) : (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8 }}>
              <Chip icon="monitor" label={machineLabel} onPress={() => setSettings(true)} />
              <Chip icon="folder" label={cwd ? shortPath(cwd, 28) : '默认目录'} muted={!cwd} onPress={() => setSettings(true)} />
              <Chip icon="board" label={projectName ?? '无项目'} muted={!projectName} onPress={projectMenu} />
              {title.trim() ? <Chip icon="chat" label={title.trim()} onPress={() => setSettings(true)} /> : null}
            </View>
          )}
        </ScrollView>
        <Composer
          value={text}
          onChange={onText}
          running={false}
          disabled={!selectedOnline}
          busy={busy}
          restoreOnError
          errorTitle="创建失败"
          placeholder="要 AI 做什么？"
          onSend={(t, atts) => create(t, atts)}
          onInterrupt={() => {}}
          model={selectedOnline ? { label: modelLabel(model, info?.models), onPress: () => setModelOpen(true) } : null}
          thinking={selectedOnline ? { label: `思考 ${thinking}`, icon: 'bulb', onPress: thinkingMenu } : null}
        />
      </KeyboardAvoidingView>

      <Sheet visible={settings} title="会话设置" onClose={() => setSettings(false)}>
        <Section title="机器">
          {online.length === 0 ? <Row title="没有在线机器" last /> : null}
          {online.map((m, i) => (
            <Row key={m.workerId} title={m.label} last={i === online.length - 1} onPress={() => pickMachine(m.workerId)}
              right={m.workerId === workerId ? <Text style={{ color: c.tint, fontSize: 17 }}>✓</Text> : undefined} />
          ))}
        </Section>
        <View style={{ margin: 16, gap: 10 }}>
          <Field label="工作目录" value={cwd} onChangeText={setCwd} placeholder={info?.defaultCwd ?? '/path/to/project'} />
          <Button kind="tinted" small title="浏览…" disabled={!workerId} onPress={() => setBrowsing(true)} />
        </View>
        {recent.length ? (
          <Section title="最近目录" style={{ marginTop: 0 }}>
            {recent.map((r, i) => {
              const chip = cwdChip(r);
              return (
                <Row key={r.path} title={chip.title} subtitle={chip.subtitle} last={i === recent.length - 1} onPress={() => setCwd(r.path)}
                  right={r.path === cwd.trim() ? <Text style={{ color: c.tint, fontSize: 17 }}>✓</Text> : undefined} />
              );
            })}
          </Section>
        ) : null}
        <Section title="项目标签">
          <Row title={projectName ?? '无项目'} chevron last onPress={projectMenu} />
        </Section>
        <View style={{ margin: 16, gap: 14 }}>
          <Field label="标题（可选）" value={title} onChangeText={setTitle} placeholder="自动生成" />
          <Button title="完成" onPress={() => setSettings(false)} />
        </View>
        {/* nested so iOS presents it on top of this sheet */}
        {workerId ? (
          <DirPickerSheet visible={browsing} workerId={workerId} initialPath={pickerStart(cwd)} onClose={() => setBrowsing(false)}
            onSelect={(p) => { setCwd(p); setBrowsing(false); }} />
        ) : null}
      </Sheet>
      <ModelPicker visible={modelOpen} models={info?.models ?? []} model={model} thinking={thinking} onClose={() => setModelOpen(false)}
        onChange={(v) => { setModel(v.model); setThinking(v.thinking); }} />
    </View>
  );
}
