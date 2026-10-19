// Chat composer: a rounded card at the bottom with an auto-growing input and a row below it —
// ＋ (photo attachments, compressed), model chip, thinking chip, and a round send / stop button. While running, tapping
// send queues the message (followUp); long-pressing it sends as 插队 (steer).
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Image, Keyboard, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { parseBtw, type Attachment } from '@nopear/protocol';
import { exceedsTotal, pickImageAttachments } from '../compress';
import { COLUMN_MAX, usePalette } from '../theme';
import { Icon, type IconName } from './Icon';

export interface ComposerChip { label: string; onPress: () => void; icon?: IconName }

function Chip({ chip, disabled }: { chip: ComposerChip; disabled?: boolean }) {
  const c = usePalette();
  return (
    <Pressable onPress={chip.onPress} disabled={disabled} hitSlop={4} accessibilityRole="button"
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 4, height: 32, paddingHorizontal: 9, borderRadius: 16,
        backgroundColor: pressed ? c.hover : 'transparent', opacity: disabled ? 0.5 : 1, flexShrink: 1 })}>
      {chip.icon ? <Icon name={chip.icon} size={15} color={c.sub} /> : null}
      <Text numberOfLines={1} style={{ color: c.sub, fontSize: 13.5, flexShrink: 1 }}>{chip.label}</Text>
      <Icon name="chevronDown" size={13} color={c.faint} />
    </Pressable>
  );
}

export function Composer(props: {
  value: string; onChange: (t: string) => void; running: boolean; disabled?: boolean;
  onSend: (text: string, attachments: Attachment[], delivery: 'followUp' | 'steer') => Promise<void> | void;
  onInterrupt: () => void; placeholder?: string;
  /** `/btw question` goes here instead of onSend (attachments stay in the composer). */
  onBtw?: (question: string) => void;
  model?: ComposerChip | null; thinking?: ComposerChip | null;
  /** e.g. creating the session: the send button shows a spinner. */
  busy?: boolean;
  /** When onSend throws: put the text and attachments back (new session) instead of relying on the engine's failed bubble. */
  restoreOnError?: boolean;
  errorTitle?: string;
}) {
  const c = usePalette();
  const insets = useSafeAreaInsets();
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [picking, setPicking] = useState(false);
  const [keyboardShown, setKeyboardShown] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => setKeyboardShown(true));
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setKeyboardShown(false));
    return () => { show.remove(); hide.remove(); };
  }, []);
  const canSend = !props.disabled && !props.busy && (props.value.trim().length > 0 || attachments.length > 0);

  const pick = async () => {
    setPicking(true);
    try {
      const more = await pickImageAttachments();
      const next = [...attachments, ...more];
      if (exceedsTotal(next)) Alert.alert('附件过大', '附件总量超过 45MB，请减少图片。');
      else setAttachments(next);
    } catch (e) {
      Alert.alert('无法读取图片', e instanceof Error ? e.message : String(e));
    } finally { setPicking(false); }
  };
  const send = async (steer = false) => {
    if (!canSend) return;
    const text = props.value.trim();
    const btw = props.onBtw ? parseBtw(text) : null;
    if (btw !== null) {
      if (btw) { props.onChange(''); props.onBtw!(btw); }
      return;
    }
    const atts = attachments;
    props.onChange('');
    setAttachments([]);
    try {
      await props.onSend(text, atts, props.running && steer ? 'steer' : 'followUp');
    } catch (e) {
      // chat: the engine keeps a failed optimistic bubble (重新发送/重新编辑); also surface the error here
      if (props.restoreOnError) { props.onChange(text); setAttachments(atts); }
      Alert.alert(props.errorTitle ?? '发送失败', e instanceof Error ? e.message : String(e));
    }
  };

  const stop = props.running && !canSend;
  return (
    <View style={{ paddingHorizontal: 10, paddingTop: 4, paddingBottom: keyboardShown ? 8 : Math.max(insets.bottom, 10), backgroundColor: c.bg }}>
      <View style={{ width: '100%', maxWidth: COLUMN_MAX, alignSelf: 'center', backgroundColor: c.card, borderRadius: 24,
        borderWidth: StyleSheet.hairlineWidth, borderColor: c.lineStrong, paddingTop: 10, paddingHorizontal: 8, paddingBottom: 6,
        shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 10, shadowOffset: { width: 0, height: 2 }, elevation: 2 }}>
        {attachments.length ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8, paddingHorizontal: 6 }} contentContainerStyle={{ gap: 8, paddingTop: 4 }}>
            {attachments.map((a, i) => (
              <Pressable key={i} onPress={() => setAttachments(attachments.filter((_, j) => j !== i))} accessibilityLabel={`移除 ${a.name}`}>
                {a.kind === 'image'
                  ? <Image source={{ uri: `data:${a.mediaType};base64,${a.dataBase64}` }} style={{ width: 56, height: 56, borderRadius: 10 }} />
                  : <View style={{ width: 56, height: 56, borderRadius: 10, backgroundColor: c.elevated, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: c.sub, fontSize: 10 }} numberOfLines={2}>{a.name}</Text></View>}
                <View style={{ position: 'absolute', top: -4, right: -4, width: 18, height: 18, borderRadius: 9, backgroundColor: c.text, alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name="x" size={11} color={c.bg} strokeWidth={2.5} />
                </View>
              </Pressable>
            ))}
          </ScrollView>
        ) : null}
        {props.running ? (
          <Text style={{ color: c.sub, fontSize: 12, paddingHorizontal: 8, paddingBottom: 6 }}>
            运行中 · 发送将排队（本轮结束后送达）· 长按发送可插队（当前工具调用后送达）
          </Text>
        ) : null}
        <TextInput
          value={props.value}
          onChangeText={props.onChange}
          placeholder={props.placeholder ?? '给 AI 发消息'}
          placeholderTextColor={c.faint}
          multiline
          editable={!props.disabled}
          style={{ maxHeight: 180, minHeight: 26, color: c.text, paddingHorizontal: 8, paddingTop: 2, paddingBottom: 6, fontSize: 16, lineHeight: 22 }}
        />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
          <Pressable onPress={pick} disabled={picking || props.disabled} hitSlop={6} accessibilityRole="button" accessibilityLabel="添加图片"
            style={({ pressed }) => ({ width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center',
              borderWidth: StyleSheet.hairlineWidth, borderColor: c.lineStrong, backgroundColor: pressed ? c.hover : 'transparent', opacity: props.disabled ? 0.5 : 1 })}>
            {picking ? <ActivityIndicator size="small" color={c.sub} /> : <Icon name="plus" size={18} color={c.sub} />}
          </Pressable>
          <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', minWidth: 0 }}>
            {props.model ? <Chip chip={props.model} disabled={props.disabled} /> : null}
            {props.thinking ? <Chip chip={props.thinking} disabled={props.disabled} /> : null}
          </View>
          {stop ? (
            <Pressable onPress={props.onInterrupt} accessibilityRole="button" accessibilityLabel="停止"
              style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: c.text, alignItems: 'center', justifyContent: 'center' }}>
              <View style={{ width: 11, height: 11, backgroundColor: c.bg, borderRadius: 2 }} />
            </Pressable>
          ) : (
            <Pressable onPress={() => void send()} onLongPress={props.running ? () => void send(true) : undefined} delayLongPress={350}
              disabled={!canSend} accessibilityRole="button" accessibilityLabel={props.running ? '发送（排队）' : '发送'}
              accessibilityHint={props.running ? '长按插队发送' : undefined}
              style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: canSend || props.busy ? c.tint : c.elevated, alignItems: 'center', justifyContent: 'center' }}>
              {props.busy ? <ActivityIndicator size="small" color="#fff" /> : <Icon name="arrowUp" size={18} color={canSend ? '#fff' : c.faint} strokeWidth={2.25} />}
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );
}
