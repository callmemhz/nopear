// 「快速记一条」: one line → a card in 收件箱, optionally tagged with a project. Also exports the shared
// action-sheet helper used by the board / project screens.
import { useMemo, useState } from 'react';
import { ActionSheetIOS, Alert, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { menuPages, type MenuOption } from './boardMoves';
import { engine, errorText, useEngine } from './engine';
import { usePalette } from './theme';

export type { MenuOption };

const choose = (o: MenuOption | undefined) => {
  if (!o) return;
  if (o.submenu) actionMenu(o.submenu.title, o.submenu.options);
  else o.run?.();
};

/** iOS action sheet (+ 取消) / Android alert, paginated into ≤3 buttons (Android Alert drops the rest);
 *  options with a submenu open it as a nested menu. */
export function actionMenu(title: string, options: MenuOption[], page = 0) {
  if (Platform.OS === 'ios') {
    ActionSheetIOS.showActionSheetWithOptions(
      { title, options: [...options.map((o) => o.label), '取消'], cancelButtonIndex: options.length,
        destructiveButtonIndex: options.findIndex((o) => o.destructive) },
      (i) => choose(options[i]),
    );
  } else {
    const pages = menuPages(options);
    const buttons = pages[Math.min(page, pages.length - 1)]!;
    Alert.alert(title, undefined, buttons.map((b) => ({
      text: b.label, style: b.style,
      onPress: b.more ? () => actionMenu(title, options, page + 1) : b.option ? () => choose(b.option) : undefined,
    })), { cancelable: true });
  }
}

export function QuickAdd({ projectId: initialProject = null, autoFocus, onAdded, compact }: {
  projectId?: string | null; autoFocus?: boolean; onAdded?: () => void; compact?: boolean;
}) {
  const c = usePalette();
  const projects = useEngine((s) => s.projects);
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const projectId = picked === undefined ? initialProject : picked;
  const list = useMemo(() => Object.values(projects).sort((a, b) => a.name.localeCompare(b.name)), [projects]);
  const projectName = projectId ? projects[projectId]?.name ?? projectId : null;

  const submit = async () => {
    const title = text.trim();
    if (!title || busy) return;
    setBusy(true);
    try {
      await engine.createCard({ title, projectId });
      setText('');
      onAdded?.();
    } catch (e) { Alert.alert('添加失败', errorText(e)); }
    finally { setBusy(false); }
  };
  const pick = () => actionMenu('卡片所属项目', [
    { label: '无项目', run: () => setPicked(null) },
    ...list.map((p) => ({ label: p.name, run: () => setPicked(p.id) })),
  ]);

  return (
    <View style={{ marginHorizontal: compact ? 0 : 16, marginTop: compact ? 0 : 14, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <TextInput
        value={text}
        onChangeText={setText}
        onSubmitEditing={() => void submit()}
        placeholder="快速记一条 → 收件箱"
        placeholderTextColor={c.faint}
        returnKeyType="done"
        editable={!busy}
        autoFocus={autoFocus}
        style={{ flex: 1, backgroundColor: compact ? c.card : c.field, color: c.text, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 }}
      />
      <Pressable onPress={pick} hitSlop={6} style={{ maxWidth: 110, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 12, backgroundColor: c.elevated }}>
        <Text numberOfLines={1} style={{ color: projectName ? c.tint : c.sub, fontSize: 14 }}>{projectName ?? '无项目'}</Text>
      </Pressable>
    </View>
  );
}
