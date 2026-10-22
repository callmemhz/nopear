// Drawer content (mirrors the web sidebar): app header, nav rows, session search + filter, 「置顶」, sessions grouped by
// project (collapsible, persisted; ＋ starts a session in that project), 「未分类」 last, and the account footer.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router, usePathname, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Session } from '@nopear/protocol';
import {
  groupSessions, parseCollapsed, pickProjectTarget, serializeCollapsed, sessionActivity, SESSION_ACTIVITY_LABEL, toggleCollapsed, UNGROUPED,
  type SessionFilter, type SessionGroup,
} from '@nopear/core';
import { engine, useEngine } from '../engine';
import { platform } from '../platform';
import { initials, relativeTime, sessionHref, sessionTitle } from '../format';
import { parseSessionPath } from '../drawerMath';
import { actionMenu, QuickAdd } from '../QuickAdd';
import { sessionRowMenu } from '../sessionActions';
import { Icon, type IconName } from '../components/Icon';
import { usePalette } from '../theme';
import { useDrawer } from './Drawer';

const COLLAPSED_KEY = 'nopear.drawerCollapsed';
const FILTER_LABEL: Record<SessionFilter, string> = { all: '全部', starred: '星标', archived: '归档' };

/** Collapsed project groups, persisted in the app's KV file. */
function useCollapsedGroups() {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const ref = useRef(collapsed);
  useEffect(() => {
    let alive = true;
    platform.storage.get(COLLAPSED_KEY).then((v) => {
      if (!alive) return;
      ref.current = parseCollapsed(v);
      setCollapsed(ref.current);
    }).catch(() => {});
    return () => { alive = false; };
  }, []);
  const toggle = useCallback((id: string) => {
    ref.current = toggleCollapsed(ref.current, id);
    setCollapsed(ref.current);
    void platform.storage.set(COLLAPSED_KEY, serializeCollapsed(ref.current)).catch(() => {});
  }, []);
  return { collapsed, toggle };
}

function NavRow({ icon, label, onPress, active }: { icon: IconName; label: string; onPress: () => void; active?: boolean }) {
  const c = usePalette();
  return (
    <Pressable onPress={onPress} accessibilityRole="button"
      style={({ pressed }) => ({ height: 40, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 10, borderRadius: 10,
        backgroundColor: pressed || active ? c.active : 'transparent' })}>
      <Icon name={icon} size={19} color={c.sub} />
      <Text style={{ color: c.text, fontSize: 15.5 }}>{label}</Text>
    </Pressable>
  );
}

/** Breathing status light: agent working (green, quick) > background tasks (blue, slow) > error > idle. */
function StatusDot({ status, taskCount }: { status: Session['status']; taskCount: number }) {
  const c = usePalette();
  const a = sessionActivity({ status, taskCount });
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (a !== 'running' && a !== 'background') { opacity.setValue(1); return; }
    const half = a === 'running' ? 1000 : 1500;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(opacity, { toValue: 0.35, duration: half, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 1, duration: half, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [a, opacity]);
  const style = a === 'running' ? { backgroundColor: c.ok } : a === 'background' ? { backgroundColor: c.info }
    : a === 'error' ? { backgroundColor: c.danger } : { borderWidth: 1.25, borderColor: c.lineStrong };
  return <Animated.View accessibilityLabel={SESSION_ACTIVITY_LABEL[a]} style={[{ width: 8, height: 8, borderRadius: 4, opacity }, style]} />;
}

const SessionRow = memo(function SessionRow({ s, active, machineLabel, now, onOpen }: {
  s: Session; active: boolean; machineLabel: string | null; now: number; onOpen: (s: Session) => void;
}) {
  const c = usePalette();
  const projects = useEngine((st) => st.projects);
  return (
    <Pressable onPress={() => onOpen(s)} onLongPress={() => sessionRowMenu(s, projects)} delayLongPress={350}
      accessibilityRole="button" accessibilityState={{ selected: active }}
      style={({ pressed }) => ({ minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 10, borderRadius: 10,
        backgroundColor: active ? c.active : pressed ? c.hover : 'transparent' })}>
      <StatusDot status={s.status} taskCount={s.taskCount} />
      <Text numberOfLines={1} style={{ flex: 1, color: c.text, fontSize: 15, fontWeight: active ? '600' : '400' }}>{sessionTitle(s)}</Text>
      {s.promptCount > 0 ? (
        <View style={{ backgroundColor: c.warnSoft, borderRadius: 999, paddingHorizontal: 6, paddingVertical: 1 }}>
          <Text style={{ color: c.warn, fontSize: 11, fontWeight: '600' }}>待答 {s.promptCount}</Text>
        </View>
      ) : null}
      {s.starred ? <Icon name="star" size={12} color={c.warn} fill={c.warn} /> : null}
      {machineLabel ? <Text numberOfLines={1} style={{ maxWidth: 70, color: c.faint, fontSize: 11 }}>{machineLabel}</Text> : null}
      <Text style={{ color: c.faint, fontSize: 11.5 }}>{relativeTime(s.lastActivityAt, now)}</Text>
    </Pressable>
  );
});

function GroupHeader({ name, count, collapsed, onToggle, onNew }: {
  name: string; count?: number; collapsed?: boolean; onToggle?: () => void; onNew?: () => void;
}) {
  const c = usePalette();
  const label = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flex: 1 }}>
      {onToggle ? (
        <View style={{ transform: [{ rotate: collapsed ? '0deg' : '90deg' }] }}><Icon name="chevronRight" size={13} color={c.sub} /></View>
      ) : null}
      <Text numberOfLines={1} style={{ color: c.sub, fontSize: 12.5, fontWeight: '600', flexShrink: 1 }}>{name}</Text>
      {count !== undefined ? <Text style={{ color: c.faint, fontSize: 12 }}>{count}</Text> : null}
    </View>
  );
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', height: 32, marginTop: 8, paddingLeft: 10, paddingRight: 2 }}>
      {onToggle ? (
        <Pressable onPress={onToggle} hitSlop={6} style={{ flex: 1 }} accessibilityRole="button" accessibilityState={{ expanded: !collapsed }}
          accessibilityLabel={`${name}，${collapsed ? '展开' : '折叠'}`}>{label}</Pressable>
      ) : label}
      {onNew ? (
        <Pressable onPress={onNew} hitSlop={6} accessibilityRole="button" accessibilityLabel={`在「${name}」新建会话`}
          style={({ pressed }) => ({ width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? c.hover : 'transparent' })}>
          <Icon name="plus" size={16} color={c.sub} />
        </Pressable>
      ) : null}
    </View>
  );
}

function Account({ go }: { go: (href: Href) => void }) {
  const c = usePalette();
  const insets = useSafeAreaInsets();
  const user = useEngine((s) => s.user);
  const machines = useEngine((s) => s.machines);
  const conn = useEngine((s) => s.machineConn);
  const syncing = useEngine((s) => s.syncing);
  const online = Object.values(machines).filter((m) => m.online && conn[m.workerId] !== 'offline').length;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingTop: 10,
      paddingBottom: Math.max(insets.bottom, 10), borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.sep }}>
      <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: c.text, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: c.grouped, fontSize: 12, fontWeight: '700' }}>{initials(user?.email)}</Text>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ color: c.text, fontSize: 14 }}>{user?.email ?? '…'}</Text>
        <Pressable onPress={() => go('/machines')} hitSlop={6} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2 }}>
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: online > 0 ? c.ok : c.lineStrong }} />
          <Text style={{ color: c.sub, fontSize: 12 }}>{syncing ? '同步中…' : `${online} 台在线`}</Text>
        </Pressable>
      </View>
      <Pressable onPress={() => go('/settings')} hitSlop={8} accessibilityRole="button" accessibilityLabel="设置"
        style={({ pressed }) => ({ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? c.hover : 'transparent' })}>
        <Icon name="settings" size={20} color={c.sub} />
      </Pressable>
    </View>
  );
}

export function DrawerContent() {
  const c = usePalette();
  const insets = useSafeAreaInsets();
  const drawer = useDrawer();
  const pathname = usePathname();
  const active = parseSessionPath(pathname);
  const sessions = useEngine((s) => s.sessions);
  const projects = useEngine((s) => s.projects);
  const machines = useEngine((s) => s.machines);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<SessionFilter>('all');
  const [quick, setQuick] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const { collapsed, toggle } = useCollapsedGroups();
  const multi = Object.keys(machines).length > 1;

  // relative times refresh whenever the drawer opens
  useEffect(() => { if (drawer.isOpen) setNow(Date.now()); else setQuick(false); }, [drawer.isOpen]);

  const { pinned, groups } = useMemo(
    () => groupSessions(Object.values(sessions).flatMap((m) => Object.values(m)), projects, { filter, project: '', query }),
    [sessions, projects, filter, query]);
  const searching = query.trim() !== '';

  const go = useCallback((href: Href, mode: 'push' | 'replace' = 'push') => {
    drawer.close();
    if (mode === 'replace') router.replace(href); else router.push(href);
  }, [drawer]);
  const openSession = useCallback((s: Session) => {
    if (active && active.workerId === s.workerId && active.sessionId === s.id) { drawer.close(); return; }
    go(sessionHref(s.workerId, s.id) as Href, 'replace');
  }, [active, drawer, go]);
  const newInProject = (g: SessionGroup) => {
    const st = engine.store.getState();
    const p = st.projects[g.id];
    const online = new Set(Object.values(st.machines).filter((m) => m.online && st.machineConn[m.workerId] !== 'offline').map((m) => m.workerId));
    const target = p ? pickProjectTarget(p, { current: active?.workerId, recent: [...new Set(g.sessions.map((s) => s.workerId))], online }) : {};
    go({ pathname: '/new', params: { projectId: g.id, ...(target.workerId ? { workerId: target.workerId } : {}) } }, 'replace');
  };
  const pickFilter = () => actionMenu('筛选会话', (Object.keys(FILTER_LABEL) as SessionFilter[]).map((f) => ({
    label: f === filter ? `✓ ${FILTER_LABEL[f]}` : FILTER_LABEL[f], run: () => setFilter(f),
  })));

  const row = (s: Session) => (
    <SessionRow key={`${s.workerId}/${s.id}`} s={s} now={now} onOpen={openSession}
      machineLabel={multi ? machines[s.workerId]?.label ?? s.workerId : null}
      active={!!active && active.workerId === s.workerId && active.sessionId === s.id} />
  );

  return (
    <View style={{ flex: 1, paddingTop: insets.top, backgroundColor: c.grouped }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10 }}>
        <Image source={require('../../assets/splash-icon.png')} style={{ width: 28, height: 28 }} accessibilityIgnoresInvertColors />
        <Text style={{ color: c.text, fontSize: 17, fontWeight: '700' }}>NoPear</Text>
      </View>
      <View style={{ paddingHorizontal: 8 }}>
        <NavRow icon="plus" label="新会话" onPress={() => go('/new', 'replace')} active={pathname === '/new'} />
        <NavRow icon="inbox" label="快速记一条" onPress={() => setQuick((v) => !v)} active={quick} />
        {quick ? <View style={{ paddingHorizontal: 4, paddingVertical: 6 }}><QuickAdd compact autoFocus onAdded={() => setQuick(false)} /></View> : null}
        <NavRow icon="board" label="看板" onPress={() => go('/board')} />
        <NavRow icon="folder" label="项目" onPress={() => go('/projects')} />
        <NavRow icon="book" label="记忆" onPress={() => go('/collab-memory')} />
        <NavRow icon="server" label="机器" onPress={() => go('/machines')} />
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingTop: 12, paddingBottom: 4 }}>
        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: c.hover, borderRadius: 10, paddingHorizontal: 10, height: 36 }}>
          <Icon name="search" size={15} color={c.faint} />
          <TextInput value={query} onChangeText={setQuery} placeholder="搜索会话" placeholderTextColor={c.faint} returnKeyType="search"
            autoCorrect={false} autoCapitalize="none" clearButtonMode="while-editing" accessibilityLabel="搜索会话"
            style={{ flex: 1, color: c.text, fontSize: 15, paddingVertical: 0 }} />
        </View>
        <Pressable onPress={pickFilter} hitSlop={6} accessibilityRole="button" accessibilityLabel="筛选会话"
          style={({ pressed }) => ({ width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
            backgroundColor: filter !== 'all' ? c.active : pressed ? c.hover : 'transparent' })}>
          <Icon name="filter" size={17} color={filter !== 'all' ? c.tint : c.sub} />
        </Pressable>
      </View>
      {filter !== 'all' ? (
        <Pressable onPress={() => setFilter('all')} style={{ paddingHorizontal: 18, paddingTop: 2 }}>
          <Text style={{ color: c.sub, fontSize: 12 }}>只看{FILTER_LABEL[filter]} · <Text style={{ color: c.tint }}>清除</Text></Text>
        </Pressable>
      ) : null}
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 16 }} keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag">
        {pinned.length + groups.length === 0 ? (
          <View style={{ alignItems: 'center', paddingVertical: 28, gap: 8 }}>
            <Text style={{ color: c.sub, fontSize: 13 }}>
              {Object.keys(machines).length === 0 ? '还没有机器' : searching ? '没有匹配的会话'
                : filter === 'archived' ? '没有归档的会话' : filter === 'starred' ? '没有星标会话' : '还没有会话'}
            </Text>
            {Object.keys(machines).length === 0
              ? <Pressable onPress={() => go('/machines')}><Text style={{ color: c.tint, fontSize: 14 }}>去认领一台机器</Text></Pressable> : null}
          </View>
        ) : null}
        {pinned.length > 0 ? (
          <View>
            <GroupHeader name="置顶" />
            {pinned.map(row)}
          </View>
        ) : null}
        {groups.map((g) => {
          const shut = !searching && collapsed.has(g.id);
          return (
            <View key={g.id}>
              <GroupHeader name={g.name} count={g.sessions.length} collapsed={shut} onToggle={() => toggle(g.id)}
                onNew={g.id !== UNGROUPED ? () => newInProject(g) : undefined} />
              {shut ? null : g.sessions.map(row)}
            </View>
          );
        })}
      </ScrollView>
      <Account go={(h) => go(h)} />
    </View>
  );
}
