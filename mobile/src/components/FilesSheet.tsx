// Browse a session's workspace (files.list, no sandbox) and download+share files (files.read → cache → share).
import { useState } from 'react';
import { ActivityIndicator, Alert, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { engine, errorText } from '../engine';
import { bytes, relativeTime, shortPath } from '../format';
import { Empty, Row, Section, Sheet, usePalette } from '../theme';

const parentOf = (p: string) => {
  const t = p.replace(/\/+$/, '');
  const i = t.lastIndexOf('/');
  return i <= 0 ? '/' : t.slice(0, i);
};
const join = (dir: string, name: string) => `${dir.replace(/\/+$/, '')}/${name}`;

export function FilesSheet(props: { visible: boolean; workerId: string; sessionId: string; onClose: () => void }) {
  const c = usePalette();
  const [path, setPath] = useState<string | undefined>(undefined);
  const [downloading, setDownloading] = useState<string | null>(null);
  const q = useQuery({
    enabled: props.visible,
    queryKey: ['files', props.workerId, props.sessionId, path ?? ''],
    queryFn: () => engine.rpc(props.workerId, 'files.list', path ? { sessionId: props.sessionId, path } : { sessionId: props.sessionId }),
  });
  const download = async (full: string, name: string) => {
    setDownloading(full);
    try {
      const r = await engine.rpc(props.workerId, 'files.read', { sessionId: props.sessionId, path: full });
      const f = new File(Paths.cache, `${Date.now()}-${r.name ?? name}`);
      f.create({ overwrite: true });
      f.write(r.bytes);
      if (await Sharing.isAvailableAsync()) {
        try { await Sharing.shareAsync(f.uri, { dialogTitle: name }); }
        finally { try { f.delete(); } catch { /* already gone */ } }
      } else Alert.alert('已下载', f.uri);
    } catch (e) {
      Alert.alert('下载失败', errorText(e));
    } finally { setDownloading(null); }
  };
  const listing = q.data;
  return (
    <Sheet visible={props.visible} title="文件" onClose={props.onClose}>
      <Text style={{ color: c.sub, fontSize: 13, marginHorizontal: 20, marginTop: 8 }} numberOfLines={2}>{listing?.path ?? ' '}</Text>
      {q.isLoading ? <ActivityIndicator style={{ marginTop: 30 }} /> : q.error ? <Empty title="无法读取目录" hint={errorText(q.error)} /> : listing ? (
        <Section footer={listing.truncated ? '只显示前 500 项' : undefined}>
          <Row title=".." subtitle="上级目录" onPress={() => setPath(parentOf(listing.path))} />
          {listing.entries.length === 0 ? <Row title="（空目录）" last /> : null}
          {listing.entries.map((e, i) => {
            const full = join(listing.path, e.name);
            return (
              <Row
                key={e.name}
                last={i === listing.entries.length - 1}
                title={`${e.type === 'dir' ? '📁' : '📄'} ${e.name}`}
                subtitle={e.type === 'dir' ? relativeTime(e.mtime) : `${bytes(e.size)} · ${relativeTime(e.mtime)}`}
                chevron={e.type === 'dir'}
                right={downloading === full ? <ActivityIndicator size="small" /> : undefined}
                onPress={() => (e.type === 'dir' ? setPath(full) : void download(full, e.name))}
              />
            );
          })}
        </Section>
      ) : null}
      {listing ? <View style={{ height: 1 }} /> : null}
      {listing ? <Text style={{ color: c.faint, fontSize: 12, textAlign: 'center', marginTop: 8 }}>{shortPath(listing.path, 60)}</Text> : null}
    </Sheet>
  );
}
