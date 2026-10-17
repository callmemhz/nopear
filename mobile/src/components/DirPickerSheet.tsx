// Folder browser for the new-session working directory (machine-level `dirs.list`): breadcrumb path, 上一级,
// tap a folder to enter, 显示隐藏目录 toggle, 选择此目录 returns the current path.
import { useEffect, useState } from 'react';
import { ActivityIndicator, Switch, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { joinDir, parentDir } from '@nopear/core';
import { engine, errorText } from '../engine';
import { dirsListArgs } from '../dirPicker';
import { Button, Empty, mono, Row, Section, Sheet, usePalette } from '../theme';

export function DirPickerSheet(props: {
  visible: boolean; workerId: string; initialPath?: string; onSelect: (path: string) => void; onClose: () => void;
}) {
  const c = usePalette();
  const [path, setPath] = useState<string | undefined>(props.initialPath);
  const [showHidden, setShowHidden] = useState(false);
  // every opening (or machine switch) restarts at the typed cwd / worker default
  useEffect(() => { if (props.visible) setPath(props.initialPath); }, [props.visible, props.workerId, props.initialPath]);
  const q = useQuery({
    enabled: props.visible && !!props.workerId,
    queryKey: ['dirs', props.workerId, path ?? '', showHidden],
    queryFn: () => engine.rpc(props.workerId, 'dirs.list', dirsListArgs(path, showHidden)),
  });
  const listing = q.data;
  return (
    <Sheet visible={props.visible} title="选择工作目录" onClose={props.onClose}>
      <Text selectable style={[mono, { color: c.text, fontSize: 13, marginHorizontal: 20, marginTop: 8 }]}>{listing?.path ?? path ?? '（默认目录）'}</Text>
      <View style={{ flexDirection: 'row', gap: 10, marginHorizontal: 16, marginTop: 12 }}>
        <Button kind="tinted" small title="↑ 上一级" disabled={!listing || listing.path === '/'} onPress={() => listing && setPath(parentDir(listing.path))} />
        <Button title="选择此目录" small disabled={!listing || !!q.error} onPress={() => listing && props.onSelect(listing.path)} style={{ flex: 1 }} />
      </View>
      <Section>
        <Row title="显示隐藏目录" last right={<Switch value={showHidden} onValueChange={setShowHidden} />} />
      </Section>
      {q.isLoading ? <ActivityIndicator style={{ marginTop: 30 }} /> : q.error ? (
        <Empty title="无法读取目录" hint={errorText(q.error)}>
          <Button kind="plain" small title="回到默认目录" onPress={() => setPath(undefined)} />
        </Empty>
      ) : listing ? (
        <Section footer={listing.truncated ? '只显示前 500 项' : undefined}>
          {listing.entries.length === 0 ? <Row title="（没有子目录）" last /> : null}
          {listing.entries.map((e, i) => (
            <Row key={e.name} title={`📁 ${e.name}`} chevron last={i === listing.entries.length - 1}
              onPress={() => setPath(joinDir(listing.path, e.name))} />
          ))}
        </Section>
      ) : null}
    </Sheet>
  );
}
