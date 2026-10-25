import { useState } from 'react';
import { Alert, SectionList, StyleSheet, Text, View } from 'react-native';

import { TripRow } from '@/components/TripRow';
import { Button, Notice, Segmented } from '@/components/ui';
import { space, useTheme } from '@/constants/theme';
import { restoreTrips } from '@/db/archive';
import { getAppSettings } from '@/db/settings';
import { listTrips, type TripView } from '@/db/trips';
import { ARCHIVE_DAYS, lifecycleOf, TRASH_DAYS } from '@/lib/archive';
import { monthLabel } from '@/lib/dates';
import type { Trip } from '@/lib/types';
import { useFocusData } from '@/lib/useAsync';

type Tab = Exclude<TripView, 'active'>;

export default function ArchiveScreen() {
  const t = useTheme();
  const [tab, setTab] = useState<Tab>('archived');
  const [busy, setBusy] = useState(false);

  const { data, reload } = useFocusData(async () => {
    const [settings, trips] = await Promise.all([getAppSettings(), listTrips({ view: tab })]);
    return { tab, settings, trips, now: Date.now() };
  }, [tab]);

  const now = data?.now ?? 0;
  const trips = data?.tab === tab ? data.trips : [];
  const sections: { title: string; data: Trip[] }[] = [];
  for (const trip of trips) {
    const key = trip.date.slice(0, 7);
    const last = sections[sections.length - 1];
    if (last && last.title === key) last.data.push(trip);
    else sections.push({ title: key, data: [trip] });
  }

  const note = (trip: Trip) => {
    const l = lifecycleOf(trip, now);
    if (l.state === 'archived') return l.daysLeft > 0 ? `已归档 · ${l.daysLeft} 天后移到「最近删除」` : '已归档 · 下次打开 App 时移到「最近删除」';
    if (l.state === 'trash') return l.daysLeft > 0 ? `${l.daysLeft} 天后永久删除` : '下次打开 App 时永久删除';
    return undefined;
  };

  const onRestoreAll = () =>
    Alert.alert('全部恢复？', `${trips.length} 条行程会回到行程列表。`, [
      { text: '取消', style: 'cancel' },
      {
        text: '全部恢复',
        onPress: async () => {
          setBusy(true);
          try {
            await restoreTrips(trips.map((x) => x.id));
            reload();
          } finally {
            setBusy(false);
          }
        },
      },
    ]);

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <SectionList
        sections={sections}
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={styles.list}
        stickySectionHeadersEnabled={false}
        ListHeaderComponent={
          <View style={styles.header}>
            <Segmented<Tab>
              value={tab}
              onChange={setTab}
              options={[
                { value: 'archived', label: '已归档' },
                { value: 'trash', label: '最近删除' },
              ]}
            />
            <Notice tone="info">
              {tab === 'archived'
                ? `已报销的行程归档后不在行程列表显示，${ARCHIVE_DAYS} 天后自动移到「最近删除」。点行程可以查看或取消归档。`
                : `删除的行程在这里保留 ${TRASH_DAYS} 天，可以恢复；到期后永久删除轨迹、地址和图片。已报销的公务行程只保留日期和里程，保证本年累计和 10,000 英里分档不变。`}
            </Notice>
            {tab === 'trash' && trips.length > 1 ? (
              <Button title={`全部恢复（${trips.length} 条）`} kind="secondary" onPress={onRestoreAll} loading={busy} />
            ) : null}
          </View>
        }
        renderSectionHeader={({ section }) => (
          <Text style={[styles.month, { color: t.textSecondary }]}>{monthLabel(section.title)}</Text>
        )}
        renderItem={({ item }) => (
          <View style={{ marginBottom: space.sm }}>
            <TripRow trip={item} unit={data?.settings.unit ?? 'mi'} note={note(item)} />
          </View>
        )}
        ListEmptyComponent={
          data?.tab === tab ? (
            <Text style={[styles.empty, { color: t.textSecondary }]}>
              {tab === 'archived' ? '没有已归档的行程。报销确认后可以在「报表」里一键归档。' : '最近没有删除的行程'}
            </Text>
          ) : undefined
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  list: { padding: space.lg, paddingBottom: 48 },
  header: { gap: space.md, marginBottom: space.sm },
  month: { fontSize: 13, fontWeight: '700', marginTop: space.md, marginBottom: space.sm },
  empty: { textAlign: 'center', marginTop: space.xl, lineHeight: 21 },
});
