// Login: editable SaaS URL (default from extra.saasUrl, set by NOPEAR_SAAS_URL at build time), Google (expo-web-browser) or dev login.
import { useEffect, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { SaasError } from '@nopear/core';
import type { SaasConfig } from '@nopear/protocol';
import { engine, errorText, saasClient, useEngine } from '../src/engine';
import { loginErrorFromRedirect, NOT_ALLOWED_MESSAGE } from '../src/loginRedirect';
import { Button, Field, usePalette } from '../src/theme';

const REDIRECT = 'nopear://auth';

/** `nopear://auth#token=…` (or `?token=`) → token. */
export function tokenFromRedirect(url: string): string | null {
  const m = /[#?&]token=([^&#]+)/.exec(url);
  return m ? decodeURIComponent(m[1]!) : null;
}

export default function Login() {
  const c = usePalette();
  const saasUrl = useEngine((s) => s.saasUrl);
  const [url, setUrl] = useState(saasUrl);
  const [cfg, setCfg] = useState<SaasConfig | null>(null);
  const [cfgErr, setCfgErr] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => { setUrl(saasUrl); }, [saasUrl]);
  useEffect(() => {
    let alive = true;
    setCfg(null); setCfgErr(null);
    saasClient().config().then((v) => { if (alive) setCfg(v); }).catch((e) => { if (alive) setCfgErr(errorText(e)); });
    return () => { alive = false; };
  }, [saasUrl]);

  const applyUrl = async () => {
    const u = url.trim().replace(/\/+$/, '');
    if (!/^https?:\/\/\S+$/.test(u)) { Alert.alert('地址无效', '请输入 http(s):// 开头的 SaaS 地址'); return; }
    if (u !== saasUrl) await engine.setSaasUrl(u);
  };
  const google = async () => {
    setBusy('google');
    try {
      await applyUrl();
      const res = await WebBrowser.openAuthSessionAsync(saasClient().googleStartUrl(REDIRECT), REDIRECT);
      if (res.type !== 'success') return;
      // SaaS refused the login (not on the login allowlist) → no token in the redirect.
      const loginErr = loginErrorFromRedirect(res.url);
      if (loginErr) { Alert.alert('登录失败', loginErr === 'not_allowed' ? NOT_ALLOWED_MESSAGE : loginErr); return; }
      const token = tokenFromRedirect(res.url);
      if (!token) throw new Error('登录回调里没有 token');
      await engine.completeLogin(token);
    } catch (e) { Alert.alert('登录失败', errorText(e)); }
    finally { setBusy(null); }
  };
  const dev = async () => {
    setBusy('dev');
    try { await applyUrl(); await engine.loginDev(email.trim()); }
    catch (e) {
      const notAllowed = e instanceof SaasError && e.status === 403 && e.code === 'forbidden';
      Alert.alert('登录失败', notAllowed ? NOT_ALLOWED_MESSAGE : errorText(e));
    }
    finally { setBusy(null); }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: c.bg }}>
      <ScrollView contentContainerStyle={{ padding: 24, paddingTop: 96, gap: 18 }} keyboardShouldPersistTaps="handled">
        <View style={{ gap: 10, marginBottom: 12 }}>
          <View style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: c.tint, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ color: '#fff', fontSize: 22, fontWeight: '800' }}>F</Text>
          </View>
          <Text style={{ color: c.text, fontSize: 30, fontWeight: '700' }}>NoPear</Text>
          <Text style={{ color: c.sub, fontSize: 15 }}>远程派活给 AI agent，实时看输出、发消息。</Text>
        </View>
        <Field label="SaaS 地址" value={url} onChangeText={setUrl} onEndEditing={() => void applyUrl()} keyboardType="url" placeholder="https://nopear.example.com" />
        {cfgErr ? <Text style={{ color: c.danger, fontSize: 13 }}>无法连接 SaaS：{cfgErr}</Text> : null}
        {cfg?.googleEnabled !== false ? (
          <Button title="使用 Google 登录" onPress={google} busy={busy === 'google'} disabled={!!busy} />
        ) : null}
        {cfg?.devLogin ? (
          <View style={{ gap: 10, marginTop: 8 }}>
            <Text style={{ color: c.sub, fontSize: 13 }}>开发登录（SAAS_DEV_LOGIN=1）</Text>
            <Field value={email} onChangeText={setEmail} keyboardType="email-address" placeholder="you@example.com" />
            <Button title="开发登录" kind="tinted" onPress={dev} busy={busy === 'dev'} disabled={!!busy || !email.trim()} />
          </View>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
