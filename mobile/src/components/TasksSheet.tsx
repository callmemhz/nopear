// Background tasks of a session (pi-subagents runs) with live duration + stop.
import { useEffect, useState } from 'react';
import { Alert, Text, View } from 'react-native';
import type { BackgroundTask } from '@nopear/protocol';
import { duration } from '../format';
import { Button, Empty, Section, Sheet, usePalette } from '../theme';

const STATE: Record<BackgroundTask['state'], string> = { queued: '排队中', running: '运行中', paused: '已暂停' };

export function TasksSheet(props: { visible: boolean; tasks: BackgroundTask[]; onClose: () => void; onStop: (id: string) => Promise<void> }) {
  const c = usePalette();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!props.visible) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [props.visible]);
  return (
    <Sheet visible={props.visible} title="后台任务" onClose={props.onClose}>
      {props.tasks.length === 0 ? <Empty title="没有在跑的后台任务" /> : (
        <Section>
          {props.tasks.map((t, i) => (
            <View key={t.id} style={{ padding: 14, gap: 6, borderBottomWidth: i === props.tasks.length - 1 ? 0 : 0.5, borderBottomColor: c.sep }}>
              <Text style={{ color: c.text, fontSize: 15, fontWeight: '600' }} numberOfLines={2}>{t.goal || t.agent || t.id}</Text>
              <Text style={{ color: c.sub, fontSize: 13 }}>{t.agent} · {STATE[t.state]} · {duration(t.startedAt, now)}{t.model ? ` · ${t.model}` : ''}</Text>
              <Button small kind="danger" title="停止" style={{ alignSelf: 'flex-start' }}
                onPress={() => props.onStop(t.id).catch((e) => Alert.alert('停止失败', e instanceof Error ? e.message : String(e)))} />
            </View>
          ))}
        </Section>
      )}
    </Sheet>
  );
}
