// Claim a machine from a worker's claim link (QR scan or pasted): SaaS mismatch check + one-click confirm.
import { Alert } from 'react-native';
import { parseClaimLink } from './claimLink';
import { engine, errorText } from './engine';

export async function claimFromLink(link: string): Promise<boolean> {
  const parsed = parseClaimLink(link);
  if (!parsed) { Alert.alert('链接无效', '应形如 https://<saas>/claim?w=…&t=…'); return false; }
  const cur = engine.store.getState().saasUrl.replace(/\/+$/, '');
  if (parsed.saasUrl && parsed.saasUrl !== cur) {
    const ok = await new Promise<boolean>((resolve) => Alert.alert('SaaS 地址不一致', `链接指向 ${parsed.saasUrl}，当前登录的是 ${cur}。仍在当前 SaaS 认领？`, [
      { text: '取消', style: 'cancel', onPress: () => resolve(false) }, { text: '继续', onPress: () => resolve(true) }]));
    if (!ok) return false;
  }
  // Policy: always one-click confirm before claiming (guards against lured claim links).
  const email = engine.store.getState().user?.email ?? '（未知账号）';
  const confirmed = await new Promise<boolean>((resolve) => Alert.alert('认领这台机器？',
    `机器：${parsed.workerId}\nSaaS：${cur}\n账号：${email}\n\n认领后，这台机器将执行你派发的任务。`, [
      { text: '取消', style: 'cancel', onPress: () => resolve(false) }, { text: '认领', onPress: () => resolve(true) }]));
  if (!confirmed) return false;
  try {
    await engine.claim(parsed.workerId, parsed.claimToken);
    Alert.alert('认领成功', parsed.workerId);
    return true;
  } catch (e) {
    Alert.alert('认领失败', errorText(e));
    return false;
  }
}
