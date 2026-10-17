// Custom top bar (replaces the native stack header): safe-area aware, warm background, no hairline.
// Left: ☰ on stack-root screens (opens the drawer; also enables the drawer's edge swipe while focused) or a back chevron
// on pushed screens (the native back swipe stays in charge). Center: title (+ optional subtitle node). Right: actions.
import { useCallback, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { router, useFocusEffect, useNavigation } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useDrawer } from '../drawer/Drawer';
import { usePalette } from '../theme';
import { Icon, type IconName } from './Icon';

export function TopBarButton({ icon, onPress, label, disabled }: { icon: IconName; onPress: () => void; label: string; disabled?: boolean }) {
  const c = usePalette();
  return (
    <Pressable onPress={onPress} disabled={disabled} hitSlop={8} accessibilityRole="button" accessibilityLabel={label}
      style={({ pressed }) => ({ width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center',
        backgroundColor: pressed ? c.hover : 'transparent', opacity: disabled ? 0.4 : 1 })}>
      <Icon name={icon} size={22} color={c.text} />
    </Pressable>
  );
}

export function TopBar({ title, subtitle, onTitlePress, right, left = 'auto' }: {
  title: string; subtitle?: ReactNode; onTitlePress?: () => void; right?: ReactNode;
  /** auto = ☰ on a stack root, ‹ when the screen can go back. */
  left?: 'auto' | 'none';
}) {
  const c = usePalette();
  const insets = useSafeAreaInsets();
  const nav = useNavigation();
  const drawer = useDrawer();
  const isRoot = !nav.canGoBack();
  const { setSwipeEnabled } = drawer;
  useFocusEffect(useCallback(() => { setSwipeEnabled(isRoot); }, [isRoot, setSwipeEnabled]));

  const center = (
    <View style={{ alignItems: 'center', maxWidth: '100%' }}>
      <Text numberOfLines={1} style={{ color: c.text, fontSize: 16, fontWeight: '600' }}>{title}</Text>
      {subtitle}
    </View>
  );
  return (
    <View style={{ paddingTop: insets.top, backgroundColor: c.bg }}>
      <View style={{ height: 50, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8 }}>
        <View style={{ width: 84, flexDirection: 'row', alignItems: 'center' }}>
          {left === 'none' ? null : isRoot
            ? <TopBarButton icon="menu" label="打开侧栏" onPress={drawer.open} />
            : <TopBarButton icon="chevronLeft" label="返回" onPress={() => router.back()} />}
        </View>
        <View style={{ flex: 1, alignItems: 'center' }}>
          {onTitlePress ? <Pressable onPress={onTitlePress} hitSlop={6} style={{ maxWidth: '100%' }}>{center}</Pressable> : center}
        </View>
        <View style={{ width: 84, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end' }}>{right}</View>
      </View>
    </View>
  );
}
