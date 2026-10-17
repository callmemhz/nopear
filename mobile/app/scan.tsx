// Scan the worker's claim QR (expo-camera) → claim.
import { useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { router } from 'expo-router';
import { claimFromLink } from '../src/claim';
import { TopBar } from '../src/components/TopBar';
import { Button, Empty, usePalette } from '../src/theme';

export default function Scan() {
  const c = usePalette();
  const [perm, request] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const handled = useRef(false);
  if (!perm) return <View style={{ flex: 1, backgroundColor: c.grouped }}><TopBar title="扫码认领" /></View>;
  if (!perm.granted) {
    return (
      <View style={{ flex: 1, backgroundColor: c.grouped }}>
        <TopBar title="扫码认领" />
        <View style={{ flex: 1, justifyContent: 'center' }}>
          <Empty title="需要相机权限" hint="用于扫描 worker 终端打印的认领二维码">
            <Button title="允许使用相机" onPress={() => void request()} />
          </Empty>
        </View>
      </View>
    );
  }
  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <TopBar title="扫码认领" />
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={busy ? undefined : async ({ data }) => {
            if (handled.current) return;
            handled.current = true;
            setBusy(true);
            const ok = await claimFromLink(data);
            setBusy(false);
            if (ok) router.back(); else handled.current = false;
          }}
        />
        <View style={{ position: 'absolute', bottom: 60, left: 0, right: 0, alignItems: 'center' }}>
          <Text style={{ color: '#fff', fontSize: 15, backgroundColor: '#0008', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10 }}>
            {busy ? '认领中…' : '对准 worker 终端里的二维码'}
          </Text>
        </View>
      </View>
    </View>
  );
}
