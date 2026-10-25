import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Badge, Button, Card, LargeTitle, MonthSwitcher, Notice, SectionTitle, Stat } from '@/components/ui';
import { space, useTheme, type Theme } from '@/constants/theme';
import { archiveTrips } from '@/db/archive';
import { confirmClaim, listClaims, listMonthMiles, revokeClaim, type ClaimRecord } from '@/db/claims';
import { listPlaces } from '@/db/places';
import { listRateVersions } from '@/db/rates';
import { getAppSettings } from '@/db/settings';
import { listBusinessTrips, listTrips } from '@/db/trips';
import { buildClaimSnapshot, routeDescription, validateTrip, type ClaimIssue, type ClaimSnapshot } from '@/lib/claim';
import { ARCHIVE_DAYS, TRASH_DAYS } from '@/lib/archive';
import { addMonths, formatDateShort, formatDateSlash, monthKeyOf, monthLabel, monthRange, todayISO, yearRangeOf } from '@/lib/dates';
import { formatPence, formatTenths, metersToTenths, milliPenceToPence } from '@/lib/money';
import { useFocusData } from '@/lib/useAsync';
import type { Trip } from '@/lib/types';
import {
  createMonthlyClaim,
  MIME,
  renderClaimFiles,
  saveFilesToFolder,
  shareCsv,
  shareFile,
  sharePdf,
  type ExportFiles,
} from '@/services/exporter';

interface Exported {
  claimId: number;
  snapshot: ClaimSnapshot;
  files: ExportFiles;
}

export default function ReportsScreen() {
  const t = useTheme();
  const currentMonth = monthKeyOf(todayISO());
  const [month, setMonth] = useState(currentMonth);
  const [selection, setSelection] = useState<{ month: string; ids: Set<number> } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [exported, setExported] = useState<Exported | null>(null);

  const { data, reload } = useFocusData(async () => {
    const settings = await getAppSettings();
    const [from, to] = monthRange(month);
    const [yearStart] = yearRangeOf(from, settings.yearBasis);
    const [monthTrips, yearTrips, manualMonths, rateVersions, places, claims] = await Promise.all([
      listTrips({ from, to, includeRecording: true }),
      listBusinessTrips(yearStart, to),
      listMonthMiles(),
      listRateVersions(),
      listPlaces(),
      listClaims(month),
    ]);
    const trips = monthTrips.filter((x) => x.category === 'business').reverse();
    const personal = monthTrips.filter((x) => x.category === 'personal').length;
    const issues = new Map<number, ClaimIssue[]>();
    for (const trip of trips) issues.set(trip.id, validateTrip(trip, places));
    return { month, settings, trips, personal, yearTrips, manualMonths, rateVersions, issues, claims };
  }, [month]);

  // 默认选中本月未报销的公务行程
  const selected = useMemo(() => {
    if (!data || data.month !== month) return new Set<number>();
    if (selection && selection.month === month) return selection.ids;
    return new Set(data.trips.filter((x) => !x.claimedAt && x.status === 'completed').map((x) => x.id));
  }, [data, month, selection]);

  const preview = useMemo(() => {
    if (!data || data.month !== month) return null;
    return buildClaimSnapshot({
      month,
      selected: data.trips.filter((x) => selected.has(x.id)),
      yearBusinessTrips: data.yearTrips,
      manualMonths: data.manualMonths,
      rateVersions: data.rateVersions,
      yearBasis: data.settings.yearBasis,
    });
  }, [data, month, selected]);

  const changeMonth = (m: string) => {
    setMonth(m);
    setSelection(null);
    setExported(null);
  };
  const toggle = (id: number) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelection({ month, ids: next });
  };

  const selectedTrips = data?.trips.filter((x) => selected.has(x.id)) ?? [];
  const selectedIssues = selectedTrips.flatMap((x) => data?.issues.get(x.id) ?? []);
  const errorCount = selectedIssues.filter((i) => i.level === 'error').length;
  const claimedSelected = selectedTrips.filter((x) => x.claimedAt).length;

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      Alert.alert('操作失败', (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const onExport = () =>
    run('export', async () => {
      if (!data) return;
      const go = async () => {
        const r = await createMonthlyClaim(month, [...selected], data.settings);
        setExported(r);
        reload();
      };
      if (claimedSelected > 0) {
        await new Promise<void>((resolve) =>
          Alert.alert('包含已报销的行程', `选中的行程里有 ${claimedSelected} 条已经报销过，确定要再次导出吗？`, [
            { text: '取消', style: 'cancel', onPress: () => resolve() },
            { text: '仍然导出', onPress: () => go().finally(resolve) },
          ]),
        );
      } else {
        await go();
      }
    });

  const reExport = (c: ClaimRecord) =>
    run(`re-${c.id}`, async () => {
      const files = await renderClaimFiles(c.snapshot, c.id, data?.settings.groupSameRoutes ?? true);
      setExported({ claimId: c.id, snapshot: c.snapshot, files });
    });

  const archiveNote = `归档后不在行程列表显示（可在「行程 → 已归档」查看），${ARCHIVE_DAYS} 天后移到「最近删除」，再过 ${TRASH_DAYS} 天永久删除。本年累计里程不受影响，导出记录保留。`;

  const archiveClaim = (claimId: number, ids: number[]) =>
    run(`archive-${claimId}`, async () => {
      const n = await archiveTrips(ids);
      reload();
      Alert.alert('已归档', `${n} 条行程已归档。`);
    });

  const askArchive = (claimId: number, ids: number[]) =>
    Alert.alert(`归档这 ${ids.length} 条已报销的行程？`, archiveNote, [
      { text: '以后再说', style: 'cancel' },
      { text: '归档', onPress: () => archiveClaim(claimId, ids) },
    ]);

  const onConfirm = (claimId: number, count: number) =>
    Alert.alert(
      '确认已报销？',
      `把这次导出的 ${count} 条行程标记为已报销，并锁定这份报销快照。之后修改费率或行程，不会改变这份报表。`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '确认已报销',
          onPress: () =>
            run('confirm', async () => {
              await confirmClaim(claimId);
              reload();
              const claim = data?.claims.find((c) => c.id === claimId);
              const ids = claim?.tripIds ?? exported?.snapshot.trips.map((x) => x.tripId) ?? [];
              if (ids.length) askArchive(claimId, ids);
            }),
        },
      ],
    );

  const onRevoke = (claimId: number) =>
    Alert.alert('撤销「已报销」？', '这些行程会恢复为未报销。导出记录会保留。', [
      { text: '取消', style: 'cancel' },
      { text: '撤销', style: 'destructive', onPress: () => run('revoke', async () => { await revokeClaim(claimId); reload(); }) },
    ]);

  const loading = !data || data.month !== month;
  const empty = !loading && data.trips.length === 0;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={['top']}>
      <ScrollView contentContainerStyle={styles.content}>
        <LargeTitle>报表</LargeTitle>
        <MonthSwitcher
          label={monthLabel(month)}
          onPrev={() => changeMonth(addMonths(month, -1))}
          onNext={() => changeMonth(addMonths(month, 1))}
          nextDisabled={month >= currentMonth}
        />

        <Card>
          <View style={styles.stats}>
            <Stat label="选中行程" value={preview ? String(preview.trips.length) : '–'} sub={data && !loading ? `本月公务共 ${data.trips.length} 条` : undefined} />
            <Stat label="里程" value={preview ? formatTenths(preview.monthTenths) : '–'} sub="miles" />
            <Stat label="报销金额" value={preview ? formatPence(preview.monthPence) : '–'} />
          </View>
          {preview ? (
            <Text style={[styles.small, { color: t.textSecondary }]}>
              {preview.rateNotes.join('；')}
              {'\n'}
              {preview.yearLabel}累计（含本次）{formatTenths(preview.yearTenths)} 英里
              {preview.previousMonths.length
                ? `：${preview.previousMonths.map((m) => `${m.month.slice(5)}月 ${formatTenths(m.tenths)}${m.source === 'manual' ? '（手工）' : ''}`).join('，')}`
                : ''}
            </Text>
          ) : null}
          {!loading && data.personal > 0 ? (
            <Text style={[styles.small, { color: t.textSecondary }]}>另有 {data.personal} 条私人行程，不计入报销。</Text>
          ) : null}
        </Card>

        {empty && data.claims.some((c) => c.status === 'claimed') ? (
          <Notice tone="info">
            {monthLabel(month)}已报销的行程已归档（可在「行程 → 已归档」查看）。下方导出记录可以重新生成当月的 Word / Excel。
          </Notice>
        ) : empty ? (
          <Notice>
            {monthLabel(month)}没有公务行程，无法生成报销文件。可以在「行程」里把行程改为公务，或用「手动补录」补登。
          </Notice>
        ) : null}

        {!loading && errorCount > 0 ? (
          <Notice>选中的行程还有 {errorCount} 个必填问题（下方红色标记），修正后才能导出。点行程可以直接修改。</Notice>
        ) : null}

        {!loading && data.trips.length > 0 ? (
          <>
            <SectionTitle
              right={
                <View style={{ flexDirection: 'row', gap: space.lg }}>
                  <Pressable hitSlop={8} onPress={() => setSelection({ month, ids: new Set(data.trips.filter((x) => !x.claimedAt && x.status === 'completed').map((x) => x.id)) })}>
                    <Text style={{ color: t.primary, fontWeight: '600' }}>选未报销</Text>
                  </Pressable>
                  <Pressable hitSlop={8} onPress={() => setSelection({ month, ids: new Set() })}>
                    <Text style={{ color: t.primary, fontWeight: '600' }}>全不选</Text>
                  </Pressable>
                </View>
              }>
              选择导出的行程
            </SectionTitle>
            {data.trips.map((trip) => (
              <SelectRow
                key={trip.id}
                t={t}
                trip={trip}
                checked={selected.has(trip.id)}
                issues={data.issues.get(trip.id) ?? []}
                milliPence={preview?.trips.find((x) => x.tripId === trip.id)?.milliPence}
                onToggle={() => toggle(trip.id)}
              />
            ))}
          </>
        ) : null}

        <Button
          title={`生成 Word + Excel（${selected.size} 条）`}
          onPress={onExport}
          loading={busy === 'export'}
          disabled={loading || selected.size === 0 || errorCount > 0 || !!busy}
        />
        <Text style={[styles.small, { color: t.textSecondary }]}>
          同一次导出的 Word 和 Excel 来自同一份数据快照。导出不会自动标记为已报销。
        </Text>

        {exported && exported.snapshot.month === month ? (
          <Card>
            <Text style={[styles.cardTitle, { color: t.text }]}>
              已生成：{exported.snapshot.trips.length} 条 · {formatTenths(exported.snapshot.monthTenths)} miles ·{' '}
              {formatPence(exported.snapshot.monthPence)}
            </Text>
            <Text style={[styles.small, { color: t.textSecondary }]}>
              {exported.files.word.name}
              {'\n'}
              {exported.files.excel.name}
            </Text>
            <View style={styles.row}>
              <Button title="分享 Word" style={{ flex: 1 }} onPress={() => run('w', () => shareFile(exported.files.word, MIME.docx, '分享 Word 报销文件'))} loading={busy === 'w'} />
              <Button title="分享 Excel" style={{ flex: 1 }} onPress={() => run('x', () => shareFile(exported.files.excel, MIME.xlsx, '分享 Excel 里程明细'))} loading={busy === 'x'} />
            </View>
            <Text style={[styles.small, { color: t.textSecondary }]}>
              保存到文件夹时请选 Documents 或新建一个文件夹（安卓不允许直接选「下载」根目录）。
            </Text>
            <Button
              title="两个文件保存到文件夹…"
              kind="secondary"
              loading={busy === 'save'}
              onPress={() =>
                run('save', async () => {
                  const n = await saveFilesToFolder([exported.files.word, exported.files.excel]);
                  Alert.alert('已保存', `${n} 个文件已保存到所选文件夹`);
                })
              }
            />
            <View style={styles.row}>
              <Button title="PDF（补充）" kind="ghost" style={{ flex: 1 }} onPress={() => run('pdf', () => sharePdf(exported.snapshot, exported.claimId))} loading={busy === 'pdf'} />
              <Button title="CSV（补充）" kind="ghost" style={{ flex: 1 }} onPress={() => run('csv', () => shareCsv(exported.snapshot, exported.claimId))} loading={busy === 'csv'} />
            </View>
            {data?.claims.find((c) => c.id === exported.claimId)?.status !== 'claimed' ? (
              <Button
                title="公司已报销？确认标记"
                kind="secondary"
                onPress={() => onConfirm(exported.claimId, exported.snapshot.trips.length)}
                loading={busy === 'confirm'}
              />
            ) : (
              <Badge label="已确认报销" tone="success" />
            )}
          </Card>
        ) : null}

        {!loading && data.claims.length > 0 ? (
          <>
            <SectionTitle>本月导出记录</SectionTitle>
            {data.claims.map((c) => (
              <Card key={c.id}>
                <View style={styles.rowBetween}>
                  <Text style={{ color: t.text, fontWeight: '700' }}>
                    {new Date(c.createdAt).toLocaleString('en-GB')} · {c.tripIds.length} 条
                  </Text>
                  <Badge label={c.status === 'claimed' ? '已报销' : '已导出，未确认'} tone={c.status === 'claimed' ? 'success' : 'warning'} />
                </View>
                <Text style={{ color: t.textSecondary }}>
                  {formatTenths(c.totalTenths)} miles · {formatPence(c.totalPence)}
                  {c.confirmedAt ? ` · 确认于 ${formatDateShort(new Date(c.confirmedAt).toISOString().slice(0, 10))}` : ''}
                </Text>
                {c.status === 'claimed' && data.trips.some((x) => x.claimId === c.id) ? (
                  <Button
                    title={`归档这 ${data.trips.filter((x) => x.claimId === c.id).length} 条行程`}
                    kind="secondary"
                    loading={busy === `archive-${c.id}`}
                    onPress={() => askArchive(c.id, data.trips.filter((x) => x.claimId === c.id).map((x) => x.id))}
                  />
                ) : null}
                <View style={styles.row}>
                  <Button title="重新生成此快照" kind="ghost" style={{ flex: 1 }} onPress={() => reExport(c)} loading={busy === `re-${c.id}`} />
                  {c.status === 'claimed' ? (
                    <Button title="撤销已报销" kind="ghost" style={{ flex: 1 }} onPress={() => onRevoke(c.id)} />
                  ) : (
                    <Button title="确认已报销" kind="ghost" style={{ flex: 1 }} onPress={() => onConfirm(c.id, c.tripIds.length)} />
                  )}
                </View>
              </Card>
            ))}
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function SelectRow({
  t,
  trip,
  checked,
  issues,
  milliPence,
  onToggle,
}: {
  t: Theme;
  trip: Trip;
  checked: boolean;
  issues: ClaimIssue[];
  milliPence?: number;
  onToggle: () => void;
}) {
  const errors = issues.filter((i) => i.level === 'error');
  const warnings = issues.filter((i) => i.level === 'warning' && i.code !== 'no-purpose');
  const desc = routeDescription(trip);
  return (
    <View style={[styles.selectRow, { backgroundColor: t.card, borderColor: t.record, borderWidth: errors.length && checked ? 1.5 : 0 }]}>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked }}
        onPress={onToggle}
        hitSlop={8}
        style={[styles.check, { borderColor: checked ? t.primary : t.border, backgroundColor: checked ? t.primary : 'transparent' }]}>
        {checked ? <Text style={{ color: '#FFFFFF', fontWeight: '700', fontSize: 14 }}>✓</Text> : null}
      </Pressable>
      <Pressable style={{ flex: 1, gap: 3 }} onPress={() => router.push({ pathname: '/trip/[id]', params: { id: String(trip.id) } })}>
        <Text style={{ color: t.text, fontWeight: '600' }} numberOfLines={3}>
          {formatDateSlash(trip.date)} {desc || '（缺少起点 / 终点）'}
        </Text>
        <View style={styles.badges}>
          {trip.claimedAt ? <Badge label={`已报销 ${formatDateShort(new Date(trip.claimedAt).toISOString().slice(0, 10))}`} tone="success" /> : null}
          {trip.status === 'recording' ? <Badge label="记录中" tone="record" /> : null}
          {trip.source === 'gps' && trip.distanceEdited ? <Badge label="里程已修正" tone="personal" /> : null}
          {trip.source === 'manual' ? <Badge label="手动" tone="personal" /> : null}
        </View>
        {errors.map((i) => (
          <Text key={i.code} style={{ color: t.record, fontSize: 13 }}>
            ✕ {i.message}
          </Text>
        ))}
        {warnings.map((i) => (
          <Text key={i.code} style={{ color: t.warning, fontSize: 13 }}>
            ! {i.message}
          </Text>
        ))}
      </Pressable>
      <View style={{ alignItems: 'flex-end' }}>
        <Text style={{ color: t.text, fontWeight: '800' }}>{formatTenths(metersToTenths(trip.distanceM))}</Text>
        <Text style={{ color: t.textSecondary, fontSize: 12 }}>miles</Text>
        {checked && milliPence != null ? (
          <Text style={{ color: t.success, fontSize: 12 }}>{formatPence(milliPenceToPence(milliPence))}</Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, gap: space.md, paddingBottom: 120 },
  stats: { flexDirection: 'row', gap: space.md },
  small: { fontSize: 12, lineHeight: 17 },
  cardTitle: { fontSize: 16, fontWeight: '700' },
  row: { flexDirection: 'row', gap: space.md },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: space.md },
  badges: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  selectRow: {
    flexDirection: 'row',
    gap: space.md,
    padding: space.md,
    borderRadius: 12,
    alignItems: 'flex-start',
  },
  check: { width: 24, height: 24, borderRadius: 12, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
});
