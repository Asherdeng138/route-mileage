import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Linking, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Badge, Button, Card, Field, Input, Notice, SectionTitle, SwitchRow } from '@/components/ui';
import { space, useTheme } from '@/constants/theme';
import { googleUsage } from '@/db/apiUsage';
import { getAppSettings, saveAppSettings } from '@/db/settings';
import { DEFAULT_GOOGLE_MONTHLY_LIMIT, ROUTES_MONTHLY_LIMIT } from '@/lib/googleQuota';
import { useFocusData } from '@/lib/useAsync';
import { parseNumber } from '@/lib/units';
import { googleNearby, isGoogleConfigured, loadGoogleKey, maskKey, saveGoogleKey } from '@/services/google';
import { clearNearbyCache } from '@/services/nearby';

const LONDON = { lat: 51.5072, lng: -0.1276 };

const STEPS = [
  '在 Google Cloud Console 新建项目并绑定结算账户（Google 要求，即使只用免费额度）。',
  '启用「Places API (New)」「Routes API」「Maps SDK for Android」。',
  '凭据 → 创建 API Key → 「API 限制」只勾选这三项。',
  '配额：Places API (New) → Quotas，把「SearchNearbyRequest per day」改为 50 左右；Routes API 的「ComputeRoutes requests per day」改为 100 左右。这是 App 内上限之外、Google 侧的第二道保险。',
  '结算 → 预算和提醒：设置 £1 预算提醒。',
  '把 Key 粘贴到下面保存。Key 只存在这部手机的加密存储里，不会上传或写进备份。',
];

export default function GoogleSettingsScreen() {
  const t = useTheme();
  const { data, reload } = useFocusData(async () => {
    const s = await getAppSettings();
    const key = await loadGoogleKey();
    const [usage, routes] = await Promise.all([
      googleUsage(s.googleMonthlyLimit),
      googleUsage(ROUTES_MONTHLY_LIMIT, new Date(), 'routes.compute'),
    ]);
    return { s, key, usage, routes };
  });
  const [keyText, setKeyText] = useState('');
  const [limitText, setLimitText] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  if (!data) return <View style={{ flex: 1, backgroundColor: t.bg }} />;
  const { s, key, usage } = data;

  const onSaveKey = async () => {
    const k = keyText.trim();
    if (!/^[A-Za-z0-9_-]{30,60}$/.test(k)) return Alert.alert('Key 格式不对', 'Google API Key 通常以 AIza 开头，约 39 个字符。');
    await saveGoogleKey(k);
    setKeyText('');
    clearNearbyCache();
    reload();
  };

  const onRemoveKey = () =>
    Alert.alert('删除 API Key？', '删除后只使用免费来源（常用地点、OpenStreetMap、手机地址解析）。', [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          await saveGoogleKey(null);
          clearNearbyCache();
          reload();
        },
      },
    ]);

  const onSaveLimit = async () => {
    const v = parseNumber(limitText ?? '');
    if (v == null || v < 0 || v > 5000) return Alert.alert('请输入 0–5000 之间的次数', 'Nearby Search Pro 每月免费 5,000 次；建议 1,000。');
    await saveAppSettings({ googleMonthlyLimit: Math.floor(v) });
    setLimitText(null);
    reload();
  };

  const onTest = async () => {
    setTesting(true);
    try {
      const r = await googleNearby(LONDON, 100);
      reload();
      if (r.status === 'ok') Alert.alert('连接成功', `Google 返回了 ${r.places.length} 个附近地点（本次计 1 次）。`);
      else if (r.status === 'quota') Alert.alert('本月次数已用完', '下个月自动恢复，或提高上限。');
      else if (r.status === 'error') Alert.alert('Google 返回错误', `${r.message ?? ''}\n\n请检查 Key、是否启用了 Places API (New)、结算账户。`);
      else Alert.alert('未启用', '请先填写 Key 并打开开关。');
    } finally {
      setTesting(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.bg }} behavior="height">
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Notice tone="info">
          Google 用于识别起点 / 终点附近的地点名称（每次开始和结束记录各 1 次，在地图上拖动选点时每次停下 1 次），
          以及信号中断时查驾车路线补算里程（每段中断 1 次）。Word 路线图和地址解析用免费来源，App 内 Google 地图加载免费。
          达到每月上限后自动切换到免费来源 / 按直线计算，下个月自动恢复。
        </Notice>

        <SectionTitle>本月用量</SectionTitle>
        <Card>
          <View style={styles.row}>
            <Text style={[styles.big, { color: usage.exhausted ? t.record : usage.warning ? t.warning : t.text }]}>
              {usage.used} / {usage.limit}
            </Text>
            <Badge label={usage.exhausted ? '已用完 · 使用免费来源' : usage.warning ? '接近上限' : '正常'} tone={usage.exhausted ? 'record' : usage.warning ? 'warning' : 'success'} />
          </View>
          <Text style={{ color: t.textSecondary, fontSize: 12, lineHeight: 17 }}>
            计费月 {usage.month}（按太平洋时间，比 Google 晚重置、不会提前）。只统计这部手机的调用；同一个 Key 用在别处的次数这里看不到。
          </Text>
          <SwitchRow label="使用 Google 识别附近地点" value={s.googleEnabled} onChange={(v) => saveAppSettings({ googleEnabled: v }).then(reload)} />
          <Text style={{ color: t.textSecondary, fontSize: 13, lineHeight: 18 }}>
            信号中断补算（Routes API）本月 {data.routes.used} / {data.routes.limit} 次。Compute Routes Essentials 每月免费 10,000 次，之后约 $5 / 1000 次。
            需要在 Google Cloud 给 Key 的「API 限制」勾选 Routes API。
          </Text>
          <Field label="每月上限（次）" hint={`默认 ${DEFAULT_GOOGLE_MONTHLY_LIMIT}。Google Nearby Search Pro 每月免费 5,000 次，之后约 $32 / 1000 次。`}>
            <View style={styles.row}>
              <Input
                style={{ flex: 1 }}
                keyboardType="number-pad"
                value={limitText ?? String(s.googleMonthlyLimit)}
                onChangeText={setLimitText}
              />
              <Button title="保存" kind="secondary" onPress={onSaveLimit} disabled={limitText == null} />
            </View>
          </Field>
        </Card>

        <SectionTitle>API Key</SectionTitle>
        <Card>
          <View style={styles.row}>
            <Text style={{ color: t.text, flex: 1 }}>{key ? maskKey(key) : '未填写'}</Text>
            <Badge label={isGoogleConfigured() ? '已保存' : '未配置'} tone={isGoogleConfigured() ? 'success' : 'personal'} />
          </View>
          <Field label="粘贴新的 Key">
            <Input value={keyText} onChangeText={setKeyText} autoCapitalize="none" autoCorrect={false} secureTextEntry placeholder="AIza…" />
          </Field>
          <View style={styles.row}>
            <Button title="保存 Key" onPress={onSaveKey} disabled={!keyText.trim()} style={{ flex: 1 }} />
            {key ? <Button title="删除" kind="ghost" onPress={onRemoveKey} /> : null}
          </View>
          <Button title="测试连接（计 1 次）" kind="secondary" onPress={onTest} loading={testing} disabled={!key || !s.googleEnabled} />
        </Card>

        <SectionTitle>Google Cloud 设置（避免意外收费）</SectionTitle>
        <Card>
          {STEPS.map((x, i) => (
            <Text key={x} style={{ color: t.text, lineHeight: 21 }}>
              {i + 1}. {x}
            </Text>
          ))}
          <Text style={{ color: t.textSecondary, fontSize: 12, lineHeight: 17 }}>
            App 内上限只能管住这部手机；第 4、5 步是 Google 侧的保险。限制为「Android 应用」对这种直接请求不一定生效，所以用「API 限制 + 每日配额」更可靠。
          </Text>
          <Button title="打开 Google Cloud Console" kind="ghost" onPress={() => Linking.openURL('https://console.cloud.google.com/google/maps-apis/overview')} />
        </Card>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, gap: space.md, paddingBottom: 64 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  big: { fontSize: 28, fontWeight: '800', flex: 1 },
});
