// Warm design tokens (same values as web/src/styles.css) + a handful of primitives used across screens.
import { type ReactNode } from 'react';
import {
  ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useColorScheme,
  type StyleProp, type TextInputProps, type TextStyle, type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export interface Palette {
  /** main background (chat, top bar) */ bg: string;
  /** secondary surface: drawer, grouped settings-style screens */ grouped: string;
  /** cards, sheets rows, composer */ card: string;
  /** chips, tool cards, pressed rows */ elevated: string;
  text: string; sub: string; faint: string;
  /** subtle borders / separators */ sep: string; lineStrong: string;
  hover: string; active: string;
  /** accent (clay) used for primary actions */ tint: string; tintText: string; accentSoft: string;
  danger: string; dangerSoft: string; ok: string; warn: string; warnSoft: string;
  bubble: string; bubbleText: string; code: string; field: string;
}
const light: Palette = {
  bg: '#faf9f5', grouped: '#f5f4ee', card: '#ffffff', elevated: '#efede6', text: '#1f1e1d', sub: '#6b6a65', faint: '#9c9a92',
  sep: '#e7e5dc', lineStrong: '#d6d3c8', hover: '#efede6', active: '#e8e6dd',
  tint: '#c6613f', tintText: '#ffffff', accentSoft: 'rgba(198,97,63,0.12)',
  danger: '#d64541', dangerSoft: 'rgba(214,69,65,0.10)', ok: '#2f9e6a', warn: '#c27a12', warnSoft: 'rgba(194,122,18,0.12)',
  bubble: '#f0eee6', bubbleText: '#1f1e1d', code: '#f0eee6', field: '#f0eee6',
};
const dark: Palette = {
  bg: '#262624', grouped: '#1f1e1d', card: '#30302e', elevated: '#393834', text: '#f3f1ea', sub: '#a8a59b', faint: '#78766f',
  sep: '#3a3936', lineStrong: '#4b4a45', hover: '#31302d', active: '#393834',
  tint: '#d97757', tintText: '#ffffff', accentSoft: 'rgba(217,119,87,0.16)',
  danger: '#f07167', dangerSoft: 'rgba(240,113,103,0.14)', ok: '#3ccf91', warn: '#f2b84b', warnSoft: 'rgba(242,184,75,0.14)',
  bubble: '#1a1a18', bubbleText: '#f3f1ea', code: '#1d1d1b', field: '#1d1d1b',
};
export function usePalette(): Palette {
  return useColorScheme() === 'dark' ? dark : light;
}

/** Spacing / radii / type scale shared by screens. */
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
export const radius = { sm: 8, md: 12, lg: 16, xl: 22, pill: 999 } as const;
export const font = { body: 16, small: 14, caption: 12, title: 17 } as const;
/** Readable column width for chat / content on wide screens (iPad). */
export const COLUMN_MAX = 760;

export const mono = { fontFamily: 'Menlo' } as const;

export function Button(props: {
  title: string; onPress: () => void; kind?: 'primary' | 'plain' | 'danger' | 'tinted'; disabled?: boolean; busy?: boolean;
  small?: boolean; style?: StyleProp<ViewStyle>;
}) {
  const c = usePalette();
  const kind = props.kind ?? 'primary';
  const bg = kind === 'primary' ? c.tint : kind === 'tinted' ? c.accentSoft : kind === 'danger' ? c.dangerSoft : 'transparent';
  const fg = kind === 'primary' ? c.tintText : kind === 'danger' ? c.danger : c.tint;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled || props.busy}
      onPress={props.onPress}
      style={({ pressed }) => [
        { backgroundColor: bg, borderRadius: props.small ? 10 : 14, paddingVertical: props.small ? 7 : 13, paddingHorizontal: props.small ? 10 : 16,
          alignItems: 'center', justifyContent: 'center', opacity: props.disabled ? 0.4 : pressed ? 0.7 : 1, flexDirection: 'row', gap: 6 },
        props.style,
      ]}
    >
      {props.busy ? <ActivityIndicator size="small" color={fg} /> : null}
      <Text style={{ color: fg, fontSize: props.small ? 14 : 16, fontWeight: '600' }}>{props.title}</Text>
    </Pressable>
  );
}

export function Field(props: TextInputProps & { label?: string }) {
  const c = usePalette();
  const { label, style, ...rest } = props;
  return (
    <View style={{ gap: 6 }}>
      {label ? <Text style={{ color: c.sub, fontSize: 13 }}>{label}</Text> : null}
      <TextInput
        placeholderTextColor={c.faint}
        autoCapitalize="none"
        autoCorrect={false}
        {...rest}
        style={[{ backgroundColor: c.field, color: c.text, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 11, fontSize: 16 }, style as TextStyle]}
      />
    </View>
  );
}

export function Section(props: { title?: string; footer?: string; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const c = usePalette();
  return (
    <View style={[{ marginHorizontal: 16, marginTop: 20 }, props.style]}>
      {props.title ? <Text style={{ color: c.sub, fontSize: 13, fontWeight: '500', marginLeft: 14, marginBottom: 6 }}>{props.title}</Text> : null}
      <View style={{ backgroundColor: c.card, borderRadius: radius.lg, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, borderColor: c.sep }}>{props.children}</View>
      {props.footer ? <Text style={{ color: c.faint, fontSize: 12, marginHorizontal: 14, marginTop: 6 }}>{props.footer}</Text> : null}
    </View>
  );
}

export function Row(props: {
  title: string; subtitle?: string; right?: ReactNode; left?: ReactNode; onPress?: () => void; onLongPress?: () => void;
  last?: boolean; destructive?: boolean; chevron?: boolean;
}) {
  const c = usePalette();
  return (
    <Pressable
      onPress={props.onPress}
      onLongPress={props.onLongPress}
      style={({ pressed }) => ({ backgroundColor: pressed && (props.onPress || props.onLongPress) ? c.hover : c.card })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 16, minHeight: 46 }}>
        {props.left ? <View style={{ marginRight: 12 }}>{props.left}</View> : null}
        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', paddingVertical: 11, paddingRight: 16,
          borderBottomWidth: props.last ? 0 : StyleSheet.hairlineWidth, borderBottomColor: c.sep }}>
          <View style={{ flex: 1 }}>
            <Text numberOfLines={1} style={{ color: props.destructive ? c.danger : c.text, fontSize: 15.5 }}>{props.title}</Text>
            {props.subtitle ? <Text numberOfLines={2} style={{ color: c.sub, fontSize: 13, marginTop: 2 }}>{props.subtitle}</Text> : null}
          </View>
          {props.right}
          {props.chevron ? <Text style={{ color: c.faint, fontSize: 20, marginLeft: 6 }}>›</Text> : null}
        </View>
      </View>
    </Pressable>
  );
}

export function Dot({ color, size = 8 }: { color: string; size?: number }) {
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />;
}

export function Pill({ text, color, bg }: { text: string; color?: string; bg?: string }) {
  const c = usePalette();
  return (
    <View style={{ backgroundColor: bg ?? c.elevated, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 }}>
      <Text style={{ color: color ?? c.sub, fontSize: 12, fontWeight: '600' }}>{text}</Text>
    </View>
  );
}

export function Empty({ title, hint, children }: { title: string; hint?: string; children?: ReactNode }) {
  const c = usePalette();
  return (
    <View style={{ alignItems: 'center', justifyContent: 'center', padding: 32, gap: 8 }}>
      <Text style={{ color: c.text, fontSize: 17, fontWeight: '600' }}>{title}</Text>
      {hint ? <Text style={{ color: c.sub, fontSize: 14, textAlign: 'center' }}>{hint}</Text> : null}
      {children}
    </View>
  );
}

/** Bottom sheet style modal (pageSheet on iOS). */
export function Sheet(props: { visible: boolean; title: string; onClose: () => void; children: ReactNode; right?: ReactNode; scroll?: boolean }) {
  const c = usePalette();
  const insets = useSafeAreaInsets();
  const body = props.scroll === false
    ? <View style={{ flex: 1 }}>{props.children}</View>
    : <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }} keyboardShouldPersistTaps="handled">{props.children}</ScrollView>;
  return (
    <Modal visible={props.visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={props.onClose}>
      <View style={{ flex: 1, backgroundColor: c.grouped }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 14, paddingBottom: 10 }}>
          <Pressable onPress={props.onClose} hitSlop={10}><Text style={{ color: c.tint, fontSize: 17, fontWeight: '500' }}>关闭</Text></Pressable>
          <Text style={{ flex: 1, textAlign: 'center', color: c.text, fontSize: 17, fontWeight: '600' }}>{props.title}</Text>
          <View style={{ minWidth: 40, alignItems: 'flex-end' }}>{props.right}</View>
        </View>
        {body}
      </View>
    </Modal>
  );
}

export const statusColor = (c: Palette, status: 'idle' | 'running' | 'error' | 'connecting' | 'online' | 'offline') =>
  status === 'running' ? c.tint : status === 'connecting' ? c.warn : status === 'error' || status === 'offline' ? c.danger
    : status === 'online' ? c.ok : c.lineStrong;
