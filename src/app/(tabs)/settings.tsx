import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Badge, Button, Card, Field, Input, LargeTitle, Notice, SectionTitle, Segmented, SwitchRow } from '@/components/ui';
import { space, useTheme } from '@/constants/theme';
import { applyBackup, exportBackup, pickAndValidateBackup } from '@/db/backup';
import type { ValidatedBackup } from '@/db/backupCore';
import { googleUsage } from '@/db/apiUsage';
import { effectiveLimit } from '@/lib/googleQuota';
import { listMonthMiles } from '@/db/claims';
import { listPlaces, PLACE_TYPE_LABEL } from '@/db/places';
import { listRateVersions } from '@/db/rates';
import { getAppSettings, saveAppSettings } from '@/db/settings';
import { rateNote } from '@/lib/claim';
import { rateForDate } from '@/lib/rates';
import { todayISO, type YearBasis } from '@/lib/dates';
import type { AppSettings, DistanceUnit } from '@/lib/types';
import { useFocusData } from '@/lib/useAsync';
import { hasBuildTimeMapsKey, isGoogleConfigured } from '@/services/google';

export default function SettingsScreen() {
  const t = useTheme();
  const { data, reload } = useFocusData(async () => ({
    settings: await getAppSettings(),
    places: await listPlaces(),
    rates: await listRateVersions(),
    months: await listMonthMiles(),
    usage: await googleUsage('places.nearby', effectiveLimit('places.nearby', (await getAppSettings()).googleMonthlyLimit)),
  }));
  const [edits, setEdits] = useState<Partial<AppSettings>>({});
  const [restoring, setRestoring] = useState(false);

  if (!data) return <View style={{ flex: 1, backgroundColor: t.bg }} />;
  const form: AppSettings = { ...data.settings, ...edits };

  const update = async (patch: Partial<AppSettings>) => {
    setEdits((e) => ({ ...e, ...patch }));
    await saveAppSettings(patch);
  };

  const current = rateForDate(data.rates, todayISO());

  const restore = (backup: ValidatedBackup) => {
    const c = backup.counts;
    Alert.alert(
      '恢复备份',
      `备份时间：${backup.exportedAt?.slice(0, 16).replace('T', ' ') ?? '未知'}\n` +
        `行程 ${c.trips} 条、轨迹点 ${c.track_points} 个、常用地点 ${c.places} 个、报销记录 ${c.claims} 条。\n\n` +
        '「合并」保留手机上现有数据，只添加备份里没有的行程和地点；\n' +
        '「覆盖」先自动保存一份当前数据，再用备份替换。',
      [
        { text: '取消', style: 'cancel' },
        { text: '合并', onPress: () => doRestore(backup, 'merge') },
        { text: '覆盖', style: 'destructive', onPress: () => doRestore(backup, 'replace') },
      ],
    );
  };

  const doRestore = async (backup: ValidatedBackup, mode: 'replace' | 'merge') => {
    setRestoring(true);
    try {
      const r = await applyBackup(backup, mode);
      Alert.alert(
        '恢复完成',
        mode === 'merge'
          ? `新增行程 ${r.tripsAdded} 条（跳过重复 ${r.tripsSkipped} 条），新增地点 ${r.placesAdded} 个。`
          : `已恢复行程 ${r.tripsAdded} 条。恢复前的数据已自动保存在 App 内部。`,
      );
      setEdits({});
      reload();
    } catch (e) {
      Alert.alert('恢复失败，现有数据未改变', (e as Error).message);
    } finally {
      setRestoring(false);
    }
  };

  const onImport = async () => {
    try {
      const backup = await pickAndValidateBackup();
      if (backup) restore(backup);
    } catch (e) {
      Alert.alert('无法使用这个备份文件', (e as Error).message);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={['top']}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <LargeTitle>设置</LargeTitle>

        <SectionTitle>报销规则</SectionTitle>
        <Card>
          <Pressable onPress={() => router.push('/rates')} style={styles.linkRow}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>公司报销费率</Text>
              <Text style={{ color: t.textSecondary, fontSize: 13 }}>{rateNote(current)}</Text>
              <Text style={{ color: t.textSecondary, fontSize: 12 }}>{current.label}</Text>
            </View>
            <Text style={{ color: t.primary, fontWeight: '700' }}>管理 ›</Text>
          </Pressable>
          {data.rates.some((r) => r.source === '从 v1 设置迁移') ? (
            <Notice>旧版本里保存过不同的费率，已作为一个费率版本保留。请在「管理」中核对是否仍然适用。</Notice>
          ) : null}
          <Field label="「本年累计」与 10,000 英里分档的年度口径" hint="报表中的 “Takes me to … miles this year”。HMRC 分档按税年（4 月 6 日起）。">
            <Segmented<YearBasis>
              value={form.yearBasis}
              onChange={(yearBasis) => update({ yearBasis })}
              options={[
                { value: 'tax', label: '税年（4/6 起）' },
                { value: 'calendar', label: '自然年（1/1 起）' },
              ]}
            />
          </Field>
          <Pressable onPress={() => router.push('/month-miles')} style={styles.linkRow}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>往月里程（使用 App 之前）</Text>
              <Text style={{ color: t.textSecondary, fontSize: 13 }}>
                {data.months.length ? `已录入 ${data.months.length} 个月` : '例如 7 月 520.4、8 月 498.7，用于本年累计'}
              </Text>
            </View>
            <Text style={{ color: t.primary, fontWeight: '700' }}>编辑 ›</Text>
          </Pressable>
        </Card>

        <SectionTitle>记录与地图</SectionTitle>
        <Card>
          <Field
            label="地图"
            hint={
              hasBuildTimeMapsKey()
                ? 'Google 地图在手机上加载免费，不占用每月地点查询次数。Word 里的路线图始终用 OpenStreetMap。'
                : '这个安装包没有打包 Google 地图 Key，会自动使用 OpenStreetMap。'
            }>
            <Segmented<AppSettings['mapProvider']>
              value={form.mapProvider}
              onChange={(mapProvider) => update({ mapProvider })}
              options={[
                { value: 'google', label: 'Google 地图' },
                { value: 'osm', label: 'OpenStreetMap' },
              ]}
            />
          </Field>
          <SwitchRow
            label="信号中断时按 Google 路线补算"
            hint="两个 GPS 点之间断开超过 60 秒、相距 300 米以上时，联网后查 Google 驾车路线，选预计用时最接近实际断开时间的一条，代替直线计入里程（地图上为虚线，行程里可以撤销）。"
            value={form.gapFill}
            onChange={(gapFill) => update({ gapFill })}
          />
          <Field
            label="停车后自动结束记录"
            hint="停留 10 分钟（或设定时间的一半）先提醒；停满设定时间自动结束并保存，结束时间取开始停留的时刻。">
            <Segmented<string>
              value={String(form.autoEndMinutes)}
              onChange={(v) => update({ autoEndMinutes: Number(v) })}
              options={[
                { value: '0', label: '关闭' },
                { value: '15', label: '15 分' },
                { value: '20', label: '20 分' },
                { value: '30', label: '30 分' },
                { value: '60', label: '60 分' },
              ]}
            />
          </Field>
        </Card>

        <SectionTitle>导出</SectionTitle>
        <Card>
          <SwitchRow
            label="Word 中合并相同路线"
            hint="相同描述和里程的多天行程合并成一段，例如 “2026/09/02&2026/09/04 … 51.5 miles each”（样板写法）"
            value={form.groupSameRoutes}
            onChange={(groupSameRoutes) => update({ groupSameRoutes })}
          />
          <SwitchRow
            label="在线地图"
            hint="记录时实时显示地图，行程结束后自动生成 OpenStreetMap 路线图放进 Word（只下载所在区域的地图图块，不上传轨迹）。关闭后只显示无底图的轨迹预览。"
            value={form.onlineMaps}
            onChange={(onlineMaps) => update({ onlineMaps })}
          />
          <SwitchRow
            label="Word 中插入路线图"
            hint="优先用你附加的截图；没有截图时用 OpenStreetMap 路线图（注明 © OpenStreetMap contributors）；没有网络时用轨迹预览图"
            value={form.embedTrackPreview}
            onChange={(embedTrackPreview) => update({ embedTrackPreview })}
          />
          <Field label="姓名（可选，只写入文件属性；样板正文没有姓名栏）">
            <Input
              value={form.employeeName}
              onChangeText={(employeeName) => setEdits((e) => ({ ...e, employeeName }))}
              onEndEditing={() => saveAppSettings({ employeeName: form.employeeName })}
            />
          </Field>
          <Field label="公司（可选，只写入文件属性）">
            <Input
              value={form.companyName}
              onChangeText={(companyName) => setEdits((e) => ({ ...e, companyName }))}
              onEndEditing={() => saveAppSettings({ companyName: form.companyName })}
            />
          </Field>
          <Field label="App 内显示单位" hint="报销文件始终按英里（与样板一致）">
            <Segmented<DistanceUnit>
              value={form.unit}
              onChange={(unit) => update({ unit })}
              options={[
                { value: 'mi', label: '英里' },
                { value: 'km', label: '公里' },
              ]}
            />
          </Field>
        </Card>

        <SectionTitle
          right={
            <Pressable onPress={() => router.push({ pathname: '/place/[id]', params: { id: 'new' } })} hitSlop={10}>
              <Text style={{ color: t.primary, fontWeight: '700' }}>＋ 添加</Text>
            </Pressable>
          }>
          常用地点
        </SectionTitle>
        <Card style={{ gap: 0, paddingVertical: space.sm }}>
          {data.places.length === 0 ? (
            <Text style={{ color: t.textSecondary, paddingVertical: space.sm }}>
              添加 home、办公室、常去的门店后，记录的起终点会自动显示名称（报表用这个名称，建议用英文，如 home、B&Q Farnborough）。
            </Text>
          ) : null}
          {data.places.map((p, i) => (
            <Pressable
              key={p.id}
              onPress={() => router.push({ pathname: '/place/[id]', params: { id: String(p.id) } })}
              style={[styles.placeRow, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.border }]}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>{p.name}</Text>
                <Text style={{ color: t.textSecondary, fontSize: 13 }} numberOfLines={1}>
                  {p.address || (p.lat != null ? '已定位' : '未定位（无法自动识别）')}
                </Text>
              </View>
              <Badge label={PLACE_TYPE_LABEL[p.type]} tone={p.type === 'home' || p.type === 'office' ? 'warning' : 'business'} />
            </Pressable>
          ))}
        </Card>

        <SectionTitle>后台记录</SectionTitle>
        <Card>
          <Text style={{ color: t.textSecondary, lineHeight: 20 }}>
            锁屏 / 切导航时如何保证记录、哪些情况会中断（强制停止、重启、厂商省电）。
          </Text>
          <Button title="查看说明与省电设置" kind="secondary" onPress={() => router.push('/help')} />
        </Card>

        <SectionTitle>数据</SectionTitle>
        <Card>
          <Text style={{ color: t.textSecondary, lineHeight: 20 }}>
            数据只保存在这部手机上，不上传。建议每月导出一次备份，存到 Google Drive 或发到邮箱。
          </Text>
          <Button title="导出备份" kind="secondary" onPress={() => exportBackup().catch((e) => Alert.alert('导出失败', String(e)))} />
          <Button title="从备份恢复（合并或覆盖）" kind="ghost" onPress={onImport} loading={restoring} />
        </Card>

        <SectionTitle>Google 地点（可选）</SectionTitle>
        <Card>
          <Pressable onPress={() => router.push('/google')} style={styles.linkRow}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>起终点附近地点识别</Text>
              <Text style={{ color: t.textSecondary, fontSize: 13 }}>
                {!isGoogleConfigured()
                  ? '未填写 API Key：使用免费的 OpenStreetMap 附近地点'
                  : !form.googleEnabled
                    ? '已关闭：使用免费来源'
                    : `本月已用 ${data.usage.used} / ${data.usage.limit} 次${data.usage.exhausted ? '（已用完，已切换免费来源）' : ''}`}
              </Text>
            </View>
            <Text style={{ color: t.primary, fontWeight: '700' }}>设置 ›</Text>
          </Pressable>
        </Card>

        <Text style={[styles.version, { color: t.textSecondary }]}>里程记录 v{Constants.expoConfig?.version ?? '1.0.0'}</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, gap: space.md, paddingBottom: 120 },
  title: { fontSize: 28, fontWeight: '800' },
  linkRow: { flexDirection: 'row', gap: space.md, alignItems: 'center' },
  placeRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md },
  version: { textAlign: 'center', fontSize: 12, marginTop: space.lg },
});
