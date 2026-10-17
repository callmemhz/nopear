// Collaboration memory editor (SaaS, global or project scope): load, edit, save.
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, TextInput, View } from 'react-native';
import { memoryKey, type MemoryScope } from '@nopear/protocol';
import { engine, errorText, useEngine } from '../engine';
import { relativeTime } from '../format';
import { Button, mono, usePalette } from '../theme';

export function MemoryEditor({ scope, projectId, minHeight }: { scope: MemoryScope; projectId: string | null; minHeight?: number }) {
  const c = usePalette();
  const key = memoryKey(scope, projectId);
  const doc = useEngine((s) => s.memories[key]);
  const [draft, setDraft] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDraft(null); setLoadError(null);
    engine.loadMemory(scope, projectId).catch((e) => setLoadError(errorText(e)));
  }, [scope, projectId]);

  const value = draft ?? doc?.content ?? '';
  const dirty = draft !== null && draft !== (doc?.content ?? '');
  const save = async () => {
    setBusy(true);
    try {
      await engine.saveMemory(scope, projectId, value);
      setDraft(null);
    } catch (e) { Alert.alert('保存失败', errorText(e)); }
    finally { setBusy(false); }
  };

  if (!doc && !loadError) return <ActivityIndicator style={{ marginTop: 20 }} />;
  return (
    <View style={{ flex: minHeight ? undefined : 1, gap: 10 }}>
      {loadError ? <Text style={{ color: c.danger, fontSize: 13 }}>读取失败：{loadError}</Text> : null}
      {doc?.updatedAt ? <Text style={{ color: c.sub, fontSize: 12 }}>更新于 {relativeTime(doc.updatedAt)}</Text> : null}
      <TextInput
        value={value}
        onChangeText={setDraft}
        multiline
        autoCapitalize="none"
        autoCorrect={false}
        textAlignVertical="top"
        placeholder="Markdown；会注入到相关会话的 system prompt"
        placeholderTextColor={c.faint}
        style={{ flex: minHeight ? undefined : 1, minHeight, backgroundColor: c.card, color: c.text, borderRadius: 14, padding: 12, fontSize: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: c.sep, ...mono }}
      />
      <Button title="保存" onPress={() => void save()} busy={busy} disabled={!dirty} />
    </View>
  );
}
