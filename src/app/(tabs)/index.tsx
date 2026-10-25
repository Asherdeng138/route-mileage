import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { TripRow } from '@/components/TripRow';
import { Button, Card, LargeTitle, SectionTitle, Stat } from '@/components/ui';
import { space, useTheme } from '@/constants/theme';
import { amountsForRange, yearTotals } from '@/db/amounts';
import { getAppSettings } from '@/db/settings';
import { getActiveTrip, listBusinessTrips, listTrips } from '@/db/trips';
import { formatDateLong, monthKeyOf, monthRange, todayISO, yearLabelOf } from '@/lib/dates';
import { formatPence, formatTenths, metersToTenths, milliPenceToPence } from '@/lib/money';
import { useAppActive } from '@/lib/useAppActive';
import { useFocusData } from '@/lib/useAsync';
import { formatDistance } from '@/lib/units';
import { requestBackgroundPermission, startRecording } from '@/tracking/recorder';

async function loadHome() {
  const settings = await getAppSettings();
  const today = todayISO();
  const [from, to] = monthRange(monthKeyOf(today));
  // 只读行程表（不读轨迹点）；最近行程只取 3 条
  // 本月里程含已归档的行程（与本年累计口径一致）
  const [active, business, recent, amounts, year] = await Promise.all([
    getActiveTrip(),
    listBusinessTrips(from, to),
    listTrips({ limit: 3 }),
    amountsForRange(from, to, settings),
    yearTotals(today, settings),
  ]);
  const monthTenths = business.reduce((s, t) => s + metersToTenths(t.distanceM), 0);
  const monthPence = milliPenceToPence(business.reduce((s, t) => s + (amounts.get(t.id)?.milliPence ?? 0), 0));
  const recentAmounts = recent.length ? await amountsForRange(recent[recent.length - 1].date, recent[0].date, settings) : new Map();
  const needsInfo = business.filter((t) => t.archivedAt == null && t.deletedAt == null && !t.startName && !t.startAddress && !t.reportDesc).length;
  return { settings, today, active, monthTenths, monthPence, monthCount: business.length, recent, recentAmounts, year, needsInfo };
}

export default function HomeScreen() {
  const t = useTheme();
  const { data, reload } = useFocusData(loadHome);
  const [starting, setStarting] = useState(false);
  const recording = !!data?.active;
  const appActive = useAppActive();

  // 记录中时首页的「已行驶」每 5 秒刷新一次；App 在后台 / 锁屏时不刷新（省电优化 #4）
  useEffect(() => {
    if (!recording || !appActive) return;
    reload();
    const timer = setInterval(reload, 5000);
    return () => clearInterval(timer);
  }, [recording, appActive, reload]);

  const onStart = async () => {
    setStarting(true);
    try {
      const res = await startRecording();
      if (!res.ok) {
        Alert.alert(
          '无法开始记录',
          res.message,
          res.code === 'permission-blocked' || res.code === 'services-off'
            ? [
                { text: '取消', style: 'cancel' },
                { text: '打开设置', onPress: () => Linking.openSettings() },
              ]
            : undefined,
        );
        return;
      }
      router.push('/recording');
      if (!res.precise) {
        Alert.alert(
          '定位权限是「大致位置」',
          '只有大致位置时，手机给出的定位误差有几百米，路线会变成几段直线。\n\n' +
            '请在 系统设置 → 应用 → 里程记录 → 权限 → 位置信息 中打开「使用确切位置」。',
          [
            { text: '以后再说', style: 'cancel' },
            { text: '打开设置', onPress: () => Linking.openSettings() },
          ],
        );
      } else if (!res.background && !res.resumed) {
        Alert.alert(
          '已开始记录',
          '通知栏会显示「正在记录行程」。\n\n为了锁屏和切换到导航 App 时记录更稳定，建议把定位权限改为「始终允许」。' +
            '安卓会打开系统设置页，请选择「始终允许」后返回。',
          [
            { text: '以后再说', style: 'cancel' },
            { text: '去设置', onPress: () => requestBackgroundPermission() },
          ],
        );
      }
    } finally {
      setStarting(false);
    }
  };

  const unit = data?.settings.unit ?? 'mi';

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={['top']}>
      <ScrollView contentContainerStyle={styles.content}>
        <LargeTitle subtitle={data ? formatDateLong(data.today) : ' '}>里程记录</LargeTitle>

        {data?.active ? (
          <Pressable
            onPress={() => router.push('/recording')}
            style={({ pressed }) => [styles.activeCard, { backgroundColor: t.record, opacity: pressed ? 0.85 : 1 }]}>
            <View style={styles.liveDot} />
            <View style={{ flex: 1 }}>
              <Text style={styles.activeTitle}>正在记录</Text>
              <Text style={styles.activeSub}>已行驶 {formatDistance(data.active.distanceGpsM, unit)} · 点这里查看或结束</Text>
            </View>
            <Text style={styles.activeChevron}>›</Text>
          </Pressable>
        ) : (
          <Button title="开始记录行程" big onPress={onStart} loading={starting} disabled={!data} />
        )}
        <Button title="手动补录行程" kind="secondary" onPress={() => router.push('/trip/new')} />

        <SectionTitle>本月公务</SectionTitle>
        <Card style={{ gap: space.sm }}>
          <View style={styles.stats}>
            <Stat label="里程" value={data ? `${formatTenths(data.monthTenths)} mi` : '–'} />
            <View style={[styles.vDivider, { backgroundColor: t.border }]} />
            <Stat label="预计可报" value={data ? formatPence(data.monthPence) : '–'} />
          </View>
          {data ? (
            <Text style={[styles.sub, { color: t.textSecondary }]}>
              {data.monthCount} 条行程 · {yearLabelOf(data.today, data.settings.yearBasis)}累计 {formatTenths(data.year.tenths)} 英里
              {data.year.manualTenths ? `（含往月手工 ${formatTenths(data.year.manualTenths)}）` : ''}
            </Text>
          ) : null}
          {data && data.needsInfo > 0 ? (
            <Text style={[styles.sub, { color: t.warning }]}>有 {data.needsInfo} 条行程缺少起终点，导出前需要补全</Text>
          ) : null}
        </Card>

        <SectionTitle
          right={
            <Pressable onPress={() => router.push('/trips')} hitSlop={10}>
              <Text style={{ color: t.primary, fontSize: 15 }}>全部</Text>
            </Pressable>
          }>
          最近行程
        </SectionTitle>
        {data && data.recent.length === 0 ? (
          <Card>
            <Text style={{ color: t.textSecondary, fontSize: 15 }}>还没有行程。出发时点「开始记录行程」。</Text>
          </Card>
        ) : null}
        {data?.recent.map((trip) => (
          <TripRow key={trip.id} trip={trip} unit={unit} pence={data.recentAmounts.get(trip.id)?.milliPence} />
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, gap: space.md, paddingBottom: 120 },
  activeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.lg,
    paddingHorizontal: space.lg,
    borderRadius: 16,
  },
  liveDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: '#FFFFFF' },
  activeTitle: { color: '#FFFFFF', fontSize: 19, fontWeight: '700' },
  activeSub: { color: 'rgba(255,255,255,0.9)', fontSize: 15, marginTop: 2 },
  activeChevron: { color: '#FFFFFF', fontSize: 28, fontWeight: '300' },
  stats: { flexDirection: 'row', gap: space.lg, alignItems: 'stretch' },
  vDivider: { width: StyleSheet.hairlineWidth },
  sub: { fontSize: 13, lineHeight: 18 },
});
