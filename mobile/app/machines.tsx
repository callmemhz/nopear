// Machines: list + online state, rename, unclaim, memory; claim via QR scan or pasted link.
import { useState } from 'react';
import { ActionSheetIOS, Alert, Platform, ScrollView, Share, Text, View } from 'react-native';
import { machineUpdateView } from '@nopear/core';
import { router } from 'expo-router';
import type { Machine } from '@nopear/protocol';
import { claimFromLink } from '../src/claim';
import { engine, errorText, useEngine } from '../src/engine';
import { relativeTime } from '../src/format';
import { TopBar } from '../src/components/TopBar';
import { Button, Dot, Empty, Field, Row, Section, statusColor, usePalette } from '../src/theme';

function rename(m: Machine) {
  Alert.prompt('重命名机器', undefined, (t) => {
    if (t?.trim()) engine.renameMachine(m.workerId, t.trim()).catch((e) => Alert.alert('失败', errorText(e)));
  }, 'plain-text', m.label);
}
function unclaim(m: Machine) {
  Alert.alert('解绑机器', `「${m.label}」将回到未认领状态，需要重新扫码认领。`, [
    { text: '取消', style: 'cancel' },
    { text: '解绑', style: 'destructive', onPress: () => void engine.removeMachine(m.workerId).catch((e) => Alert.alert('失败', errorText(e))) },
  ]);
}
function saasUrl(): string { return engine.store.getState().saasUrl; }
function update(m: Machine) {
  engine.updateMachine(m.workerId).catch((e) => Alert.alert('更新失败', errorText(e)));
}
function menu(m: Machine) {
  const v = machineUpdateView(m, saasUrl());
  const opts = [
    ...(v?.canUpdate ? [{ label: '更新 worker（会话空闲后自动重启）', run: () => update(m) }] : []),
    ...(v?.command ? [{ label: '分享更新命令（在那台机器上运行）', run: () => void Share.share({ message: v.command! }) }] : []),
    { label: '编辑记忆（AGENTS.md）', run: () => router.push(`/memory/${encodeURIComponent(m.workerId)}` as never) },
    { label: '重命名', run: () => rename(m) },
    { label: '解绑', run: () => unclaim(m), destructive: true },
  ];
  if (Platform.OS === 'ios') {
    ActionSheetIOS.showActionSheetWithOptions({ title: m.label, options: [...opts.map((o) => o.label), '取消'], cancelButtonIndex: opts.length, destructiveButtonIndex: opts.length - 1 }, (i) => opts[i]?.run());
  } else {
    Alert.alert(m.label, undefined, [...opts.map((o) => ({ text: o.label, onPress: o.run })), { text: '取消', style: 'cancel' as const }]);
  }
}

export default function Machines() {
  const c = usePalette();
  const machines = useEngine((s) => s.machines);
  const conn = useEngine((s) => s.machineConn);
  const info = useEngine((s) => s.workerInfo);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const list = Object.values(machines).sort((a, b) => a.label.localeCompare(b.label));

  return (
    <View style={{ flex: 1, backgroundColor: c.grouped }}>
      <TopBar title="机器" />
      <ScrollView style={{ backgroundColor: c.grouped }} contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        <Section title="我的机器" footer="点按机器查看操作：更新、编辑记忆、重命名、解绑">
          {list.length === 0 ? <Empty title="还没有机器" hint="在 worker 终端里会打印认领链接与二维码" /> : null}
          {list.map((m, i) => {
            const st = conn[m.workerId] ?? (m.online ? 'connecting' : 'offline');
            const w = info[m.workerId];
            const v = machineUpdateView(m, saasUrl());
            return (
              <Row key={m.workerId} last={i === list.length - 1} chevron
                left={<Dot color={statusColor(c, st)} size={10} />}
                title={m.label}
                subtitle={`${st === 'online' ? '在线' : st === 'connecting' ? '连接中' : `离线 · ${relativeTime(m.lastSeenAt)}`} · v${m.version || '?'}${v ? ` · ${v.label}` : ''}${w ? ` · ${w.defaultModel}` : ''}`}
                onPress={() => menu(m)} />
            );
          })}
        </Section>
        <Section title="认领新机器">
          <View style={{ padding: 14, gap: 12 }}>
            <Button title="扫码认领" onPress={() => router.push('/scan')} />
            <Field value={link} onChangeText={setLink} placeholder="或粘贴认领链接 https://…/claim?w=…&t=…" />
            <Button title="用链接认领" kind="tinted" busy={busy} disabled={!link.trim()}
              onPress={async () => { setBusy(true); try { if (await claimFromLink(link)) setLink(''); } finally { setBusy(false); } }} />
            <Text style={{ color: c.sub, fontSize: 12 }}>认领令牌 10 分钟内有效，过期后 worker 会自动换新链接。</Text>
          </View>
        </Section>
      </ScrollView>
    </View>
  );
}
