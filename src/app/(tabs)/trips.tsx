import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, SectionList, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { TripRow } from '@/components/TripRow';
import { LargeTitle, MonthSwitcher, Segmented } from '@/components/ui';
import { space, useTheme } from '@/constants/theme';
import { amountsForRange } from '@/db/amounts';
import { getAppSettings } from '@/db/settings';
import { listTrips } from '@/db/trips';
import { addMonths, formatDateLong, monthKeyOf, monthLabel, monthRange, todayISO } from '@/lib/dates';
import type { Category, Trip } from '@/lib/types';
import { useFocusData } from '@/lib/useAsync';
import { formatDistance } from '@/lib/units';

type Filter = 'all' | Category;

export default function TripsScreen() {
  const t = useTheme();
  const currentMonth = monthKeyOf(todayISO());
  const [month, setMonth] = useState(currentMonth);
  const [filter, setFilter] = useState<Filter>('all');

  const { data } = useFocusData(async () => {
    const settings = await getAppSettings();
    const [from, to] = monthRange(month);
    const trips = await listTrips({ from, to, category: filter === 'all' ? undefined : filter });
    const amounts = await amountsForRange(from, to, settings);
    return { settings, trips, amounts };
  }, [month, filter]);

  const sections: { title: string; data: Trip[] }[] = [];
  for (const trip of data?.trips ?? []) {
    const last = sections[sections.length - 1];
    if (last && last.title === trip.date) last.data.push(trip);
    else sections.push({ title: trip.date, data: [trip] });
  }
  const unit = data?.settings.unit ?? 'mi';
  const totalM = (data?.trips ?? [])
    .filter((x) => x.category === 'business')
    .reduce((s, x) => s + x.distanceM, 0);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={['top']}>
      <View style={styles.header}>
        <LargeTitle>行程</LargeTitle>
        <MonthSwitcher
          label={monthLabel(month)}
          onPrev={() => setMonth(addMonths(month, -1))}
          onNext={() => setMonth(addMonths(month, 1))}
          nextDisabled={month >= currentMonth}
        />
        <Segmented<Filter>
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: '全部' },
            { value: 'business', label: '公务' },
            { value: 'personal', label: '私人' },
          ]}
        />
        <Text style={{ color: t.textSecondary, textAlign: 'center' }}>
          {data ? `${data.trips.length} 条 · 公务 ${formatDistance(totalM, unit)}` : ' '}
        </Text>
      </View>
      <SectionList
        sections={sections}
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={styles.list}
        stickySectionHeadersEnabled={false}
        renderSectionHeader={({ section }) => (
          <Text style={[styles.dateHeader, { color: t.textSecondary }]}>{formatDateLong(section.title)}</Text>
        )}
        renderItem={({ item }) => (
          <View style={{ marginBottom: space.sm }}>
            <TripRow trip={item} unit={unit} pence={data?.amounts.get(item.id)?.milliPence} showDate={false} />
          </View>
        )}
        ListEmptyComponent={
          data ? (
            <Text style={[styles.empty, { color: t.textSecondary }]}>这个月没有行程</Text>
          ) : undefined
        }
      />
      <Pressable
        accessibilityLabel="手动补录行程"
        onPress={() => router.push('/trip/new')}
        style={({ pressed }) => [styles.fab, { backgroundColor: t.primary, opacity: pressed ? 0.85 : 1 }]}>
        <Text style={[styles.fabText, { color: t.primaryText }]}>＋</Text>
      </Pressable>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: { padding: space.lg, paddingBottom: space.sm, gap: space.md },
  list: { paddingHorizontal: space.lg, paddingBottom: 160 },
  dateHeader: { fontSize: 13, fontWeight: '700', marginTop: space.md, marginBottom: space.sm },
  empty: { textAlign: 'center', marginTop: space.xxl },
  fab: {
    position: 'absolute',
    right: space.xl,
    bottom: 110,
    width: 60,
    height: 60,
    borderRadius: 30,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 6,
  },
  fabText: { fontSize: 30, fontWeight: '600', marginTop: -2 },
});
