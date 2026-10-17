// Full-screen image viewer: pinch / double-tap zoom (iOS ScrollView zoom), tap ✕ or swipe the backdrop to close.
import { useState } from 'react';
import { Image, Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from './Icon';

export function ImageViewer({ uri, onClose, title }: { uri: string | null; onClose: () => void; title?: string }) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [zoomed, setZoomed] = useState(false);
  return (
    <Modal visible={!!uri} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        {uri ? (
          <ScrollView
            style={StyleSheet.absoluteFill}
            contentContainerStyle={{ width, height, alignItems: 'center', justifyContent: 'center' }}
            maximumZoomScale={6}
            minimumZoomScale={1}
            centerContent
            showsHorizontalScrollIndicator={false}
            showsVerticalScrollIndicator={false}
            onScroll={(e) => setZoomed(e.nativeEvent.zoomScale > 1.01)}
            scrollEventThrottle={64}
          >
            <Pressable onPress={zoomed ? undefined : onClose} style={{ width, height }}>
              <Image source={{ uri }} style={{ width, height }} resizeMode="contain" accessibilityLabel={title ?? '图片'} />
            </Pressable>
          </ScrollView>
        ) : null}
        <View style={{ position: 'absolute', top: insets.top + 8, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12 }}>
          <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="关闭"
            style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: 'rgba(255,255,255,0.16)', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="x" size={20} color="#fff" />
          </Pressable>
          {title ? <Text numberOfLines={1} style={{ flex: 1, color: '#fff', fontSize: 14, marginLeft: 12 }}>{title}</Text> : null}
        </View>
      </View>
    </Modal>
  );
}
