// Edit the worker's AGENTS.md memories (global = $NOPEAR_HOME/agent/AGENTS.md, project = default cwd).
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { MemoryScope } from '@nopear/protocol';
import { engine, errorText, useEngine } from '../../src/engine';
import { TopBar } from '../../src/components/TopBar';
import { Button, Empty, mono, usePalette } from '../../src/theme';

export default function Memory() {
  const c = usePalette();
  const { workerId } = useLocalSearchParams<{ workerId: string }>();
  const wid = String(workerId);
  const label = useEngine((s) => s.machines[wid]?.label ?? wid);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['memory', wid], queryFn: () => engine.rpc(wid, 'memory.get', {}) });
  const [scope, setScope] = useState<MemoryScope>('project');
  const [draft, setDraft] = useState<Record<MemoryScope, string | null>>({ global: null, project: null });
  const [busy, setBusy] = useState(false);
  const file = q.data?.files.find((f) => f.scope === scope);
  useEffect(() => { setDraft({ global: null, project: null }); }, [q.data]);
  const value = draft[scope] ?? file?.content ?? '';
  const dirty = draft[scope] !== null && draft[scope] !== file?.content;

  const save = async () => {
    setBusy(true);
    try {
      await engine.rpc(wid, 'memory.put', { scope, content: value });
      await qc.invalidateQueries({ queryKey: ['memory', wid] });
    } catch (e) { Alert.alert('保存失败', errorText(e)); }
    finally { setBusy(false); }
  };

  const bar = <TopBar title="机器记忆" subtitle={<Text numberOfLines={1} style={{ color: c.sub, fontSize: 12 }}>{label} · AGENTS.md</Text>} />;
  if (q.isLoading || q.error) {
    return (
      <View style={{ flex: 1, backgroundColor: c.grouped }}>
        {bar}
        {q.error ? <Empty title="读取失败" hint={errorText(q.error)} /> : <ActivityIndicator style={{ marginTop: 40 }} />}
      </View>
    );
  }
  return (
    <View style={{ flex: 1, backgroundColor: c.grouped }}>
      {bar}
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', margin: 16, backgroundColor: c.elevated, borderRadius: 10, padding: 2 }}>
          {(['project', 'global'] as const).map((s) => (
            <Pressable key={s} onPress={() => setScope(s)} style={{ flex: 1, paddingVertical: 7, borderRadius: 7, backgroundColor: scope === s ? c.card : 'transparent' }}>
              <Text style={{ textAlign: 'center', color: c.text, fontWeight: scope === s ? '600' : '400' }}>{s === 'project' ? '项目' : '全局'}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={{ color: c.sub, fontSize: 12, marginHorizontal: 20 }} numberOfLines={2}>
          {file?.path}{file && !file.exists ? '（尚不存在，保存后创建）' : ''}
        </Text>
        <TextInput
          value={value}
          onChangeText={(t) => setDraft((d) => ({ ...d, [scope]: t }))}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          textAlignVertical="top"
          style={{ flex: 1, margin: 16, backgroundColor: c.card, color: c.text, borderRadius: 14, padding: 12, fontSize: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: c.sep, ...mono }}
        />
        <View style={{ marginHorizontal: 16, marginBottom: 30 }}>
          <Button title="保存" onPress={save} busy={busy} disabled={!dirty} />
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}
