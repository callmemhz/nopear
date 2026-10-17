import { Alert, Linking, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { engine, errorText, useEngine } from '../src/engine';
import { TopBar } from '../src/components/TopBar';
import { Row, Section, mono, usePalette } from '../src/theme';

export default function Settings() {
  const c = usePalette();
  const user = useEngine((s) => s.user);
  const saasUrl = useEngine((s) => s.saasUrl);
  const clientPub = useEngine((s) => s.clientPub);
  const error = useEngine((s) => s.error);
  const settings = useEngine((s) => s.settings);
  const webSettings = `${saasUrl.replace(/\/+$/, '')}/settings`;
  const openWeb = () => void Linking.openURL(webSettings).catch((e) => Alert.alert('无法打开', errorText(e)));
  const logout = () => Alert.alert('退出登录', '本机的客户端密钥会保留，重新登录后可直接使用。', [
    { text: '取消', style: 'cancel' }, { text: '退出', style: 'destructive', onPress: () => void engine.logout() }]);
  return (
    <View style={{ flex: 1, backgroundColor: c.grouped }}>
      <TopBar title="设置" />
      <ScrollView style={{ backgroundColor: c.grouped }} contentContainerStyle={{ paddingBottom: 40 }}>
        <Section title="账号">
          <Row title={user?.email ?? '—'} subtitle="当前登录" last />
        </Section>
        <Section title="SaaS" footer="修改 SaaS 地址需先退出登录，在登录页修改。">
          <Row title={saasUrl} subtitle="地址" last />
        </Section>
        <Section title="端到端加密" footer="E2E 开关是账号级设置，请在 web 控制台的设置页切换。">
          <Row title={settings ? (settings.e2e ? '已开启' : '已关闭') : '—'} subtitle="E2E" last />
        </Section>
        <Section title="MCP" footer="个人 API token（供 MCP 客户端使用）请在 web 控制台的设置页管理。">
          <Row title="在 web 控制台管理 API token" subtitle={webSettings} chevron onPress={openWeb} last />
        </Section>
        <Section title="记忆">
          <Row title="全局记忆" chevron onPress={() => router.push('/collab-memory' as never)} last />
        </Section>
        <Section title="客户端公钥" footer="E2E 开启时：SaaS 只转发密文，只有已授权的客户端公钥能与 worker 通信。">
          <View style={{ padding: 14 }}>
            <Text selectable style={{ color: c.text, fontSize: 12, ...mono }}>{clientPub ?? '—'}</Text>
          </View>
        </Section>
        {error ? (
          <Section title="最近错误"><View style={{ padding: 14 }}><Text style={{ color: c.danger, fontSize: 13 }}>{error}</Text></View></Section>
        ) : null}
        <Section>
          <Row title="退出登录" destructive onPress={logout} last />
        </Section>
      </ScrollView>
    </View>
  );
}
