import '../polyfills';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, View, useColorScheme } from 'react-native';
import { Stack } from 'expo-router/stack';
import { DarkTheme, DefaultTheme, ThemeProvider, router, useRootNavigationState, useSegments } from 'expo-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { StatusBar } from 'expo-status-bar';
import { initEngine, useEngine } from '../src/engine';
import { handleColdStartNotification, startNotifications } from '../src/notifications';
import { DrawerShell } from '../src/drawer/Drawer';
import { DrawerContent } from '../src/drawer/DrawerContent';
import { usePalette } from '../src/theme';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 5_000 } } });

/** Keeps the user on /login while logged out and off it once logged in (waits for the navigator to mount). */
function AuthGate() {
  const token = useEngine((s) => s.token);
  const segments = useSegments();
  const navReady = !!useRootNavigationState()?.key;
  const onLogin = segments[0] === 'login';
  useEffect(() => {
    if (!navReady) return;
    if (!token && !onLogin) router.replace('/login');
    else if (token && onLogin) router.replace('/');
  }, [navReady, token, onLogin]);
  // a notification tap that launched the app is routed only once navigation is mounted and logged in
  useEffect(() => { if (navReady && token && !onLogin) handleColdStartNotification(); }, [navReady, token, onLogin]);
  return null;
}

function Shell() {
  const token = useEngine((s) => s.token);
  const c = usePalette();
  return (
    <DrawerShell enabled={!!token} content={<DrawerContent />}>
      {/* No native headers anywhere: every screen renders its own TopBar. */}
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c.bg } }}>
        <Stack.Screen name="login" options={{ gestureEnabled: false, animation: 'fade' }} />
        <Stack.Screen name="index" options={{ animation: 'fade' }} />
      </Stack>
      <AuthGate />
    </DrawerShell>
  );
}

export default function RootLayout() {
  const scheme = useColorScheme();
  const c = usePalette();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    void initEngine().finally(() => { if (alive) setReady(true); });
    const stop = startNotifications();
    return () => { alive = false; stop(); };
  }, []);
  const navTheme = useMemo(() => {
    const base = scheme === 'dark' ? DarkTheme : DefaultTheme;
    return { ...base, colors: { ...base.colors, background: c.bg, card: c.bg, text: c.text, border: c.sep, primary: c.tint } };
  }, [scheme, c]);
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider value={navTheme}>
            <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
            {ready ? <Shell /> : (
              <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.bg }}><ActivityIndicator color={c.sub} /></View>
            )}
          </ThemeProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
