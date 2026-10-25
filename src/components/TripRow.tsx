import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { radius, space, useTheme } from '@/constants/theme';
import { placeLabel, routeDescription } from '@/lib/claim';
import { formatDateShort, formatTime } from '@/lib/dates';
import { formatPence, milliPenceToPence } from '@/lib/money';
import type { DistanceUnit, Trip } from '@/lib/types';
import { formatDistance } from '@/lib/units';

/** 行程行：iOS 列表样式——标题、灰色副标题、右侧数值和箭头；只在需要时显示一个状态标记 */
export function TripRow({
  trip,
  unit,
  pence: milliPence,
  showDate = true,
  note,
}: {
  trip: Trip;
  unit: DistanceUnit;
  /** 精确金额（千分之一便士） */
  pence?: number;
  showDate?: boolean;
  /** 替代状态标记显示的一行说明（例如归档页的「12 天后移到最近删除」） */
  note?: string;
}) {
  const t = useTheme();
  const from = placeLabel(trip.startName, trip.startAddress) || (trip.geocodeStatus === 'ok' ? '未填起点' : '地址未解析');
  const to = placeLabel(trip.endName, trip.endAddress) || (trip.geocodeStatus === 'ok' ? '未填终点' : '地址未解析');
  const missing = !routeDescription(trip);
  const time = trip.startTime ? `${formatTime(trip.startTime)}–${formatTime(trip.endTime)}` : '手动补录';
  const business = trip.category === 'business';

  const status: { text: string; color: string } | null = note
    ? { text: note, color: t.textSecondary }
    : !business
    ? { text: '私人', color: t.personal }
    : missing
      ? { text: '缺起终点', color: t.warning }
      : trip.claimedAt
        ? { text: '已报销', color: t.success }
        : null;

  return (
    <Pressable
      onPress={() => router.push({ pathname: '/trip/[id]', params: { id: String(trip.id) } })}
      style={({ pressed }) => [styles.row, { backgroundColor: pressed ? t.input : t.card }]}>
      <View style={[styles.dot, { backgroundColor: business ? t.primary : t.personal }]} />
      <View style={styles.main}>
        <Text style={[styles.route, { color: t.text }]} numberOfLines={2}>
          {from} → {trip.via.length ? `${trip.via.join(' → ')} → ` : ''}
          {to}
          {trip.roundTrip ? '（往返）' : ''}
        </Text>
        <Text style={[styles.meta, { color: t.textSecondary }]} numberOfLines={1}>
          {showDate ? `${formatDateShort(trip.date)} · ` : ''}
          {time}
          {trip.purpose ? ` · ${trip.purpose}` : ''}
        </Text>
        {status ? <Text style={[styles.status, { color: status.color }]}>{status.text}</Text> : null}
      </View>
      <View style={styles.side}>
        <Text style={[styles.dist, { color: t.text }]}>{formatDistance(trip.distanceM, unit)}</Text>
        {milliPence != null && business ? (
          <Text style={[styles.amount, { color: t.textSecondary }]}>{formatPence(milliPenceToPence(milliPence))}</Text>
        ) : null}
      </View>
      <Text style={[styles.chevron, { color: t.border }]}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingLeft: space.lg,
    paddingRight: space.md,
    borderRadius: radius.md,
    gap: space.md,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  main: { flex: 1, gap: 2 },
  route: { fontSize: 17, fontWeight: '600', lineHeight: 22 },
  meta: { fontSize: 15 },
  status: { fontSize: 13, fontWeight: '600', marginTop: 2 },
  side: { alignItems: 'flex-end', justifyContent: 'center', gap: 2 },
  dist: { fontSize: 17, fontWeight: '600', fontVariant: ['tabular-nums'] },
  amount: { fontSize: 15, fontVariant: ['tabular-nums'] },
  chevron: { fontSize: 26, fontWeight: '300', marginLeft: -4 },
});
