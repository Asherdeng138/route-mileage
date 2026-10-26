import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, SectionList, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { TripRow } from '@/components/TripRow';
import { Button, LargeTitle, Segmented } from '@/components/ui';
import { radius, space, useTheme } from '@/constants/theme';
import { archiveCounts, restoreTrips, trashTrips } from '@/db/archive';
import { listClaimsByIds, revokeClaim, type ClaimRecord } from '@/db/claims';
import { getAppSettings } from '@/db/settings';
import { listTrips, setClaimed, type TripView } from '@/db/trips';
import { ARCHIVE_DAYS, lifecycleOf, TRASH_DAYS } from '@/lib/archive';
import { formatDateShort, monthLabel } from '@/lib/dates';
import { formatPence, formatTenths, metersToTenths } from '@/lib/money';
import type { Trip } from '@/lib/types';
import { useFocusData } from '@/lib/useAsync';
import { MIME, renderClaimFiles, shareFile } from '@/services/exporter';

type Tab = Exclude<TripView, 'active'>;

interface MonthSection {
  title: string;
  data: Trip[];
  claims: ClaimRecord[];
}

/**
 * 「归档」标签页：
 *  - 已报销：确认报销后的报表和行程，按月显示；可以重新分享报表、撤销已报销、删除本月。
 *    保留 30 天后自动移到「最近删除」。
 *  - 最近删除：保留 30 天，可以恢复，到期自动永久删除（已报销的里程仍计入本年累计）。
 */
export default function ArchiveScreen() {
  const t = useTheme();
  const params = useLocalSearchParams<{ tab?: string }>();
  const [tab, setTab] = useState<Tab>(params.tab === 'trash' ? 'trash' : 'archived');
  const [busy, setBusy] = useState<string | null>(null);

  const { data, reload } = useFocusData(async () => {
    const [settings, trips, counts] = await Promise.all([getAppSettings(), listTrips({ view: tab }), archiveCounts()]);
    const claimIds = [...new Set(trips.map((x) => x.claimId).filter((id): id is number => id != null))];
    const claims = await listClaimsByIds(claimIds);
    return { tab, settings, trips, counts, claims, now: Date.now() };
  }, [tab]);

  const now = data?.now ?? 0;
  const trips = data?.tab === tab ? data.trips : [];
  const sections: MonthSection[] = [];
  for (const trip of trips) {
    const key = trip.date.slice(0, 7);
    let sec = sections.find((s) => s.title === key);
    if (!sec) {
      sec = { title: key, data: [], claims: [] };
      sections.push(sec);
    }
    sec.data.push(trip);
    const claim = trip.claimId != null ? data?.claims.find((c) => c.id === trip.claimId) : undefined;
    if (claim && !sec.claims.includes(claim)) sec.claims.push(claim);
  }

  const run = (key: string, fn: () => Promise<void>) => async () => {
    setBusy(key);
    try {
      await fn();
      reload();
    } catch (e) {
      Alert.alert('操作失败', (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  /** 已报销 → 最近删除（保留 30 天，可以恢复，到期自动永久删除） */
  const onDelete = (list: Trip[], label: string) =>
    Alert.alert(
      `删除${label}？`,
      `${list.length} 条行程会移到「最近删除」，保留 ${TRASH_DAYS} 天后自动永久删除，期间可以恢复。已报销的里程仍计入本年累计。`,
      [
        { text: '取消', style: 'cancel' },
        { text: '移到最近删除', style: 'destructive', onPress: run(`del-${label}`, () => trashTrips(list.map((x) => x.id))) },
      ],
    );

  const onRestore = (list: Trip[], label: string) =>
    Alert.alert(`恢复${label}？`, `${list.length} 条行程会回到「行程」列表（已报销的仍在「归档」）。`, [
      { text: '取消', style: 'cancel' },
      { text: '恢复', onPress: run(`res-${label}`, () => restoreTrips(list.map((x) => x.id))) },
    ]);

  /** 撤销已报销：报表变回「等待报销」，行程回到「行程」和「报表」 */
  const onRevoke = (sec: MonthSection) =>
    Alert.alert(
      `撤销${monthLabel(sec.title)}的「已报销」？`,
      '这个月的行程会回到「行程」和「报表」，报表变回「等待公司报销」。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '撤销已报销',
          style: 'destructive',
          onPress: run(`rev-${sec.title}`, async () => {
            for (const c of sec.claims) await revokeClaim(c.id);
            const loose = sec.data.filter((x) => x.claimId == null || !sec.claims.some((c) => c.id === x.claimId)).map((x) => x.id);
            await setClaimed(loose, false);
          }),
        },
      ],
    );

  /** 重新生成这份报表并分享（报表来自确认报销时锁定的快照，内容不会变） */
  const onShare = (claim: ClaimRecord) =>
    run(`share-${claim.id}`, async () => {
      const files = await renderClaimFiles(claim.snapshot, claim.id, data?.settings.groupSameRoutes ?? true);
      await new Promise<void>((resolve) =>
        Alert.alert(`${monthLabel(claim.month)} 报表`, '选择要分享的文件', [
          { text: '取消', style: 'cancel', onPress: () => resolve() },
          { text: 'Excel', onPress: () => shareFile(files.excel, MIME.xlsx, '分享 Excel 里程明细').finally(resolve) },
          { text: 'Word', onPress: () => shareFile(files.word, MIME.docx, '分享 Word 报销文件').finally(resolve) },
        ]),
      );
    })();

  const renderMonthHeader = (sec: MonthSection) => {
    const label = monthLabel(sec.title);
    if (tab === 'trash') {
      return (
        <View style={styles.trashHeader}>
          <Text style={[styles.monthSmall, { color: t.textSecondary }]}>
            {label} · {sec.data.length} 条
          </Text>
          <Pressable hitSlop={10} disabled={!!busy} accessibilityRole="button" onPress={() => onRestore(sec.data, label)}>
            <Text style={{ color: t.primary, fontSize: 15 }}>恢复本月</Text>
          </Pressable>
        </View>
      );
    }
    const tenths = sec.data.reduce((s, x) => s + metersToTenths(x.distanceM), 0);
    const pence = sec.claims.reduce((s, c) => s + c.totalPence, 0);
    const confirmed = sec.claims.map((c) => c.confirmedAt).filter((x): x is number => x != null);
    const daysLeft = Math.min(...sec.data.map((x) => { const l = lifecycleOf(x, now); return l.state === 'archived' ? l.daysLeft : ARCHIVE_DAYS; }));
    const claim = sec.claims[0];
    return (
      <View style={[styles.monthCard, { backgroundColor: t.card }]}>
        <View style={styles.rowBetween}>
          <Text style={[styles.month, { color: t.text }]}>{label}</Text>
          <Text style={{ color: t.textSecondary, fontSize: 13 }}>{daysLeft > 0 ? `${daysLeft} 天后移到最近删除` : '即将移到最近删除'}</Text>
        </View>
        <Text style={{ color: t.textSecondary, fontSize: 14 }}>
          {sec.data.length} 条 · {formatTenths(tenths)} 英里{pence ? ` · ${formatPence(pence)}` : ''}
          {confirmed.length ? ` · 报销于 ${formatDateShort(new Date(Math.max(...confirmed)).toISOString().slice(0, 10))}` : ''}
        </Text>
        <View style={styles.actions}>
          {claim ? (
            <Button title="分享报表" kind="secondary" style={styles.action} loading={busy === `share-${claim.id}`} onPress={() => onShare(claim)} />
          ) : null}
          <Button title="撤销已报销" kind="ghost" style={styles.action} loading={busy === `rev-${sec.title}`} onPress={() => onRevoke(sec)} />
          <Pressable hitSlop={8} disabled={!!busy} accessibilityRole="button" onPress={() => onDelete(sec.data, label)} style={styles.deleteBtn}>
            <Text style={{ color: t.record, fontSize: 15 }}>删除本月</Text>
          </Pressable>
        </View>
      </View>
    );
  };

  const counts = data?.counts;
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={['top']}>
      <SectionList
        sections={sections}
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={styles.list}
        stickySectionHeadersEnabled={false}
        ListHeaderComponent={
          <View style={styles.header}>
            <LargeTitle>归档</LargeTitle>
            <Segmented<Tab>
              value={tab}
              onChange={setTab}
              options={[
                { value: 'archived', label: `已报销${counts ? `（${counts.archived}）` : ''}` },
                { value: 'trash', label: `最近删除${counts ? `（${counts.trash}）` : ''}` },
              ]}
            />
            <Text style={[styles.hint, { color: t.textSecondary }]}>
              {tab === 'archived'
                ? `确认报销后的报表和行程放在这里，${ARCHIVE_DAYS} 天后自动移到「最近删除」，也可以现在删除。`
                : `删除的行程保留 ${TRASH_DAYS} 天，可以恢复；到期后永久删除轨迹、地址和图片。已报销的里程仍计入本年累计。`}
            </Text>
            {tab === 'archived' && trips.length > 0 ? (
              <Button title={`全部删除（${trips.length} 条）`} kind="ghost" onPress={() => onDelete(trips, '全部已报销行程')} />
            ) : null}
            {tab === 'trash' && trips.length > 1 ? (
              <Button title={`全部恢复（${trips.length} 条）`} kind="secondary" onPress={() => onRestore(trips, '全部')} loading={!!busy} />
            ) : null}
          </View>
        }
        renderSectionHeader={({ section }) => renderMonthHeader(section as MonthSection)}
        renderItem={({ item }) => (
          <View style={{ marginBottom: space.sm }}>
            <TripRow
              trip={item}
              unit={data?.settings.unit ?? 'mi'}
              note={tab === 'trash' ? (() => { const l = lifecycleOf(item, now); return l.state === 'trash' ? (l.daysLeft > 0 ? `${l.daysLeft} 天后永久删除` : '下次打开 App 时永久删除') : undefined; })() : undefined}
            />
          </View>
        )}
        ListEmptyComponent={
          data?.tab === tab ? (
            <Text style={[styles.empty, { color: t.textSecondary }]}>
              {tab === 'archived' ? '还没有已报销的行程。在首页或报表点「已报销」后，报表和行程会移到这里。' : '最近没有删除的行程'}
            </Text>
          ) : undefined
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  list: { padding: space.lg, paddingBottom: 120 },
  header: { gap: space.md, marginBottom: space.sm },
  hint: { fontSize: 13, lineHeight: 18, paddingHorizontal: space.xs },
  monthCard: { borderRadius: radius.md, padding: space.lg, gap: 6, marginTop: space.md, marginBottom: space.sm },
  month: { fontSize: 17, fontWeight: '600' },
  monthSmall: { fontSize: 13, fontWeight: '700' },
  trashHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: space.md, marginBottom: space.sm },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.xs },
  action: { minHeight: 40, paddingHorizontal: space.md },
  deleteBtn: { marginLeft: 'auto', paddingVertical: 8 },
  empty: { textAlign: 'center', marginTop: space.xl, lineHeight: 21 },
});
