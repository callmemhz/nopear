import { Text, View } from 'react-native';
import { useEngine } from '../engine';
import { usePalette } from '../theme';

export function OfflineBanner({ workerId }: { workerId: string }) {
  const c = usePalette();
  const conn = useEngine((s) => s.machineConn[workerId]);
  const label = useEngine((s) => s.machines[workerId]?.label);
  if (conn !== 'offline' && conn !== 'connecting') return null;
  return (
    <View style={{ backgroundColor: conn === 'offline' ? c.dangerSoft : c.warnSoft, paddingVertical: 6, paddingHorizontal: 16 }}>
      <Text style={{ color: conn === 'offline' ? c.danger : c.warn, fontSize: 13, textAlign: 'center' }}>
        {conn === 'offline' ? `机器「${label ?? workerId}」离线，恢复后自动重连` : '正在连接…'}
      </Text>
    </View>
  );
}
