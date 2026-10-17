// Left drawer shell: the drawer sits under the content; opening slides the content to the right and
// dims it. Root screens open it with ☰ or an edge swipe from the left; pushed screens keep the native back swipe
// (the edge pan is disabled there — screens report whether they are a stack root via TopBar → setSwipeEnabled).
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { BackHandler, Keyboard, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { interpolate, runOnJS, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { DRAWER_EDGE, drawerWidth, dragProgress, settleOpen } from '../drawerMath';
import { usePalette } from '../theme';

interface DrawerApi {
  open(): void;
  close(): void;
  isOpen: boolean;
  /** Edge swipe on/off: TopBar enables it on focused stack-root screens and disables it on pushed ones. */
  setSwipeEnabled(on: boolean): void;
}
const noop = () => {};
const Ctx = createContext<DrawerApi>({ open: noop, close: noop, isOpen: false, setSwipeEnabled: noop });
export const useDrawer = () => useContext(Ctx);

const SPRING = { damping: 28, stiffness: 280, mass: 0.9, overshootClamping: true } as const;

export function DrawerShell({ content, enabled, children }: { content: ReactNode; enabled: boolean; children: ReactNode }) {
  const c = usePalette();
  const { width: screenW } = useWindowDimensions();
  const width = drawerWidth(screenW);
  const progress = useSharedValue(0);
  const start = useSharedValue(0);
  const [isOpen, setOpen] = useState(false);
  const [swipeEnabled, setSwipeEnabled] = useState(true);

  const animateTo = useCallback((open: boolean) => {
    if (open) Keyboard.dismiss();
    setOpen(open);
    progress.value = withSpring(open ? 1 : 0, SPRING);
  }, [progress]);
  const open = useCallback(() => { if (enabled) animateTo(true); }, [enabled, animateTo]);
  const close = useCallback(() => animateTo(false), [animateTo]);

  // logging out (or anything else disabling the drawer) closes it
  useEffect(() => { if (!enabled) animateTo(false); }, [enabled, animateTo]);
  useEffect(() => {
    if (!isOpen) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { animateTo(false); return true; });
    return () => sub.remove();
  }, [isOpen, animateTo]);

  const onSettled = useCallback((o: boolean) => { if (o) Keyboard.dismiss(); setOpen(o); }, []);

  const pan = useMemo(() => Gesture.Pan()
    .enabled(enabled && (isOpen || swipeEnabled))
    // closed: only a drag that starts in the left edge strip; open: anywhere on the content strip / scrim
    .hitSlop(isOpen ? undefined : { left: 0, width: DRAWER_EDGE })
    .activeOffsetX(isOpen ? [-10, 10] : 10)
    .failOffsetY([-14, 14])
    .onBegin(() => { 'worklet'; start.value = progress.value; })
    .onUpdate((e) => { 'worklet'; progress.value = dragProgress(start.value > 0.5, e.translationX, width); })
    .onEnd((e) => {
      'worklet';
      const o = settleOpen(progress.value, e.velocityX);
      progress.value = withSpring(o ? 1 : 0, { ...SPRING, velocity: e.velocityX / width });
      runOnJS(onSettled)(o);
    }), [enabled, isOpen, swipeEnabled, width, progress, start, onSettled]);

  // the drawer panel itself: swipe left to close (vertical drags still scroll its list)
  const panelPan = useMemo(() => Gesture.Pan()
    .enabled(isOpen)
    .activeOffsetX(-12)
    .failOffsetY([-14, 14])
    .onUpdate((e) => { 'worklet'; progress.value = dragProgress(true, e.translationX, width); })
    .onEnd((e) => {
      'worklet';
      const o = settleOpen(progress.value, e.velocityX);
      progress.value = withSpring(o ? 1 : 0, SPRING);
      runOnJS(onSettled)(o);
    }), [isOpen, width, progress, onSettled]);

  const contentStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: progress.value * width }],
    borderRadius: interpolate(progress.value, [0, 1], [0, 18]),
  }));
  const scrimStyle = useAnimatedStyle(() => ({ opacity: progress.value * 0.28 }));
  const panelStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: interpolate(progress.value, [0, 1], [-width * 0.3, 0]) }],
    opacity: interpolate(progress.value, [0, 0.15, 1], [0, 1, 1]),
  }));

  const api = useMemo<DrawerApi>(() => ({ open, close, isOpen, setSwipeEnabled }), [open, close, isOpen]);

  return (
    <Ctx.Provider value={api}>
      <View style={{ flex: 1, backgroundColor: c.grouped }}>
        <GestureDetector gesture={panelPan}>
          <Animated.View style={[StyleSheet.absoluteFill, { width }, panelStyle]}
            pointerEvents={isOpen ? 'auto' : 'none'} accessibilityElementsHidden={!isOpen} importantForAccessibility={isOpen ? 'auto' : 'no-hide-descendants'}>
            {enabled ? content : null}
          </Animated.View>
        </GestureDetector>
        <GestureDetector gesture={pan}>
          <Animated.View style={[{ flex: 1, overflow: 'hidden', backgroundColor: c.bg }, contentStyle]}>
            <View style={{ flex: 1 }} accessibilityElementsHidden={isOpen} importantForAccessibility={isOpen ? 'no-hide-descendants' : 'auto'}>
              {children}
            </View>
            <Animated.View pointerEvents={isOpen ? 'auto' : 'none'} style={[StyleSheet.absoluteFill, { backgroundColor: '#000' }, scrimStyle]}>
              <Pressable style={StyleSheet.absoluteFill} onPress={close} accessibilityRole="button" accessibilityLabel="关闭侧栏" />
            </Animated.View>
          </Animated.View>
        </GestureDetector>
      </View>
    </Ctx.Provider>
  );
}
