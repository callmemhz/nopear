// In-app file preview (mirrors web's FileCard modal): images, video, audio, html, pdf, text/markdown, svg — all
// rendered inside the app instead of handing the file to the iOS share sheet (which only offered "save/download").
// Bytes come from the E2E `blobs.get` RPC and are cached on disk under Paths.cache; the OS share sheet stays available
// as an explicit "分享" action.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Image, Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { WebView } from 'react-native-webview';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Block } from '@nopear/protocol';
import { FILE_ICONS, fileBlobType, fileKind, type FileKind } from '@nopear/core';
import { engine, errorText } from '../engine';
import { bytes as fmtBytes } from '../format';
import { extFor } from '../imagePolicy';
import { usePalette } from '../theme';
import { Icon } from './Icon';

type FileBlock = Extract<Block, { type: 'file' }>;

/** Text/markdown previews decode at most this much (web parity); the download keeps the whole file. */
export const TEXT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

const safe = (s: string) => s.replace(/[^A-Za-z0-9._\u4e00-\u9fff-]/g, '_') || 'file';

/** Write the blob to the cache dir once and reuse it for the life of the process (per worker+hash). */
const fileCache = new Map<string, string>();
async function blobFile(workerId: string, hash: string, name: string, mediaType: string): Promise<File> {
  const key = `${workerId}/${hash}`;
  const hit = fileCache.get(key);
  if (hit) {
    const f = new File(hit);
    if (f.exists) return f;
    fileCache.delete(key);
  }
  const r = await engine.rpc(workerId, 'blobs.get', { hash });
  const f = new File(Paths.cache, `preview-${safe(workerId)}-${hash}.${extFor(r.mediaType || mediaType)}`);
  if (!f.exists) { f.create({ overwrite: true }); f.write(r.bytes); }
  fileCache.set(key, f.uri);
  return f;
}

function VideoPlayer({ uri, height }: { uri: string; height: number }) {
  const player = useVideoPlayer(uri, (p) => { p.loop = false; });
  return <VideoView player={player} style={{ width: '100%', height, backgroundColor: '#000' }} contentFit="contain" nativeControls />;
}

function Body({ kind, block, uri, text, truncated }: { kind: FileKind; block: FileBlock; uri: string; text?: string; truncated?: boolean }) {
  const c = usePalette();
  const { width, height } = useWindowDimensions();
  const h = Math.round(height * 0.66);
  const mention = (
    <Text style={{ color: c.sub, fontSize: 12, marginBottom: 6 }}>
      {truncated ? `文件较大，仅显示前 ${fmtBytes(TEXT_PREVIEW_MAX_BYTES)}，完整内容请分享/保存。` : ' '}
    </Text>
  );
  switch (kind) {
    case 'image':
    case 'svg':
      // SVG goes through the image decoder (no scripts), same rule as web's <img>
      return (
        <ScrollView maximumZoomScale={4} centerContent contentContainerStyle={{ alignItems: 'center', justifyContent: 'center' }}>
          <Image source={{ uri }} style={{ width, height: h }} resizeMode="contain" accessibilityLabel={block.title || block.name} />
        </ScrollView>
      );
    case 'video':
      return <VideoPlayer uri={uri} height={h} />;
    case 'audio':
      return <View style={{ height: 96 }}><VideoPlayer uri={uri} height={96} /></View>;
    case 'html':
      // The page is local and untrusted: no origin, no network tricks beyond what it ships, no app storage.
      return <WebView originWhitelist={['*']} allowFileAccess allowingReadAccessToURL={uri} javaScriptEnabled source={{ uri }} style={{ flex: 1, backgroundColor: '#fff' }} />;
    case 'pdf':
      return <WebView originWhitelist={['*']} allowFileAccess allowingReadAccessToURL={uri} source={{ uri }} style={{ flex: 1, backgroundColor: '#fff' }} />;
    case 'markdown':
      return <ScrollView contentContainerStyle={{ padding: 16 }}>{mention}<Text selectable style={{ color: c.text, fontSize: 14, lineHeight: 21 }}>{text ?? ''}</Text></ScrollView>;
    case 'text':
      return <ScrollView contentContainerStyle={{ padding: 16 }}>{mention}
        <Text selectable style={{ color: c.text, fontFamily: 'Menlo', fontSize: 12, lineHeight: 18 }}>{text ?? ''}</Text>
      </ScrollView>;
    default:
      return <View style={{ padding: 40, alignItems: 'center' }}>
        <Text style={{ color: c.sub, fontSize: 14, textAlign: 'center' }}>该类型不支持预览，点右上角「分享」保存后查看。</Text>
      </View>;
  }
}

export function FilePreview({ block, workerId, onClose }: { block: FileBlock | null; workerId: string; onClose: () => void }) {
  const c = usePalette();
  const insets = useSafeAreaInsets();
  const kind = useMemo(() => (block ? fileKind(block.mediaType) : 'other'), [block]);
  const [state, setState] = useState<{ status: 'idle' | 'loading' | 'error'; error?: string; uri?: string; text?: string; truncated?: boolean }>({ status: 'idle' });

  useEffect(() => {
    if (!block) { setState({ status: 'idle' }); return; }
    let alive = true;
    setState({ status: 'loading' });
    void (async () => {
      try {
        const f = await blobFile(workerId, block.blob, block.name, block.mediaType);
        let text: string | undefined;
        let truncated: boolean | undefined;
        if (kind === 'text' || kind === 'markdown') {
          const all = f.bytesSync();
          truncated = all.byteLength > TEXT_PREVIEW_MAX_BYTES;
          text = new TextDecoder().decode(all.subarray(0, TEXT_PREVIEW_MAX_BYTES));
        }
        if (alive) setState({ status: 'idle', uri: f.uri, text, truncated });
      } catch (e) {
        if (alive) setState({ status: 'error', error: errorText(e) });
      }
    })();
    return () => { alive = false; };
  }, [block, workerId, kind]);

  const share = useCallback(async () => {
    if (!block || !state.uri) return;
    try {
      if (!(await Sharing.isAvailableAsync())) { Alert.alert('无法分享', '此设备不支持系统分享'); return; }
      await Sharing.shareAsync(state.uri, { dialogTitle: block.title || block.name, mimeType: block.mediaType });
    } catch (e) { Alert.alert('分享失败', errorText(e)); }
  }, [block, state.uri]);

  const loading = state.status === 'loading' || (state.status === 'idle' && !state.uri && !!block);
  return (
    <Modal visible={!!block} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={{ flex: 1, backgroundColor: c.bg, paddingTop: insets.top }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 10,
          borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.sep }}>
          <Text style={{ fontSize: 20 }}>{block ? FILE_ICONS[kind] : ''}</Text>
          <View style={{ flex: 1 }}>
            <Text numberOfLines={1} style={{ color: c.text, fontSize: 15, fontWeight: '600' }}>{block?.title || block?.name}</Text>
            <Text numberOfLines={1} style={{ color: c.sub, fontSize: 12 }}>
              {block ? `${block.title ? `${block.name} · ` : ''}${fmtBytes(block.size)}` : ''}
            </Text>
          </View>
          <Pressable onPress={() => void share()} disabled={!state.uri} hitSlop={8} accessibilityRole="button" accessibilityLabel="分享或保存"
            style={{ paddingHorizontal: 8, paddingVertical: 6, opacity: state.uri ? 1 : 0.4 }}>
            <Text style={{ color: c.tint, fontSize: 14, fontWeight: '600' }}>分享</Text>
          </Pressable>
          <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="关闭"
            style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: c.elevated, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="x" size={18} color={c.text} />
          </Pressable>
        </View>
        <View style={{ flex: 1 }}>
          {state.status === 'error' ? <View style={{ padding: 30 }}><Text style={{ color: c.sub, textAlign: 'center' }}>文件加载失败：{state.error}</Text></View>
            : loading || !block || !state.uri ? <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={c.sub} /></View>
            : <Body kind={kind} block={block} uri={state.uri} {...(state.text !== undefined ? { text: state.text } : {})} {...(state.truncated ? { truncated: true } : {})} />}
        </View>
      </View>
    </Modal>
  );
}
