import { useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';

import { space, useTheme } from '@/constants/theme';
import { revertGapFill, type GapRow } from '@/db/gaps';
import { findGaps } from '@/lib/gaps';
import type { DistanceUnit, TrackPoint, Trip } from '@/lib/types';
import { formatDistance } from '@/lib/units';
import { fillTripGaps } from '@/services/gapFill';
import { generateRouteMap } from '@/services/routeMap';

import { Button, Card } from './ui';

/**
 * 行程详情：信号中断补算的状态和操作（补算 / 撤销 / 重试）。
 * 已报销的行程里程已锁定，只显示说明。
 */
export function GapFillCard({
  trip,
  gaps,
  points,
  unit,
  onChanged,
}: {
  trip: Trip;
  gaps: GapRow[];
  points: TrackPoint[];
  unit: DistanceUnit;
  onChanged: () => void;
}) {
  const t = useTheme();
  const [busy, setBusy] = useState(false);
  if (trip.source !== 'gps' || trip.status !== 'completed') return null;

  const filled = gaps.filter((g) => g.status === 'filled');
  const check = gaps.filter((g) => g.status === 'check');
  const failed = gaps.find((g) => g.status === 'failed');
  const candidates = trip.gapFillStatus === 'none' ? findGaps(points).length : gaps.length;
  if (!candidates) return null;
  const locked = trip.claimedAt != null;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      onChanged();
      // Word 路线图跟着更新（补算段画虚线 / 撤销后恢复直线），在后台进行
      generateRouteMap(trip.id)
        .then(onChanged)
        .catch(() => undefined);
    } catch (e) {
      Alert.alert('补算失败', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const fill = () => run(() => fillTripGaps(trip.id, { force: true }));
  const revert = () =>
    Alert.alert('撤销补算？', '这条行程的信号中断路段改回按直线计算（里程会变少）。之后可以再补算。', [
      { text: '取消', style: 'cancel' },
      { text: '撤销补算', style: 'destructive', onPress: () => run(() => revertGapFill(trip.id)) },
    ]);

  let title: string;
  let body: string | null = null;
  let tone: 'normal' | 'warning' = 'normal';
  let action: { title: string; onPress: () => void } | null = null;
  switch (trip.gapFillStatus) {
    case 'done':
      title = filled.length
        ? `已补算 ${filled.length} 段信号中断：+${formatDistance(trip.gapFillM, unit)}`
        : `${check.length} 段信号中断无法合理补算`;
      body = filled.length
        ? `按 Google 驾车路线中「预计用时最接近实际断开时间」的一条计算，地图上用虚线表示。GPS 实测 ${formatDistance(trip.distanceGpsM, unit)}。`
        : null;
      if (check.length) {
        tone = 'warning';
        body = `${body ? body + '\n' : ''}另有 ${check.length} 段找不到在断开时间内开得完的路线，仍按直线计算，请核对里程。`;
      }
      if (filled.length) action = { title: '撤销补算', onPress: revert };
      break;
    case 'pending':
      title = `有 ${candidates} 段信号中断，等待联网补算`;
      body = '联网后会自动按 Google 驾车路线补算（打开 App 时）。';
      action = { title: '现在补算', onPress: fill };
      break;
    case 'failed':
      tone = 'warning';
      title = '信号中断补算失败';
      body = failed?.reason ? `原因：${failed.reason}` : null;
      action = { title: '重试', onPress: fill };
      break;
    case 'off':
      title = `已撤销补算：${candidates} 段信号中断按直线计算`;
      action = { title: '重新补算', onPress: fill };
      break;
    default:
      title = `有 ${candidates} 段信号中断按直线计算，里程可能偏少`;
      body = '可以按 Google 驾车路线补算（选预计用时最接近实际断开时间的路线）。';
      action = { title: '按 Google 路线补算', onPress: fill };
  }

  return (
    <Card style={tone === 'warning' ? { backgroundColor: t.warningSoft } : undefined}>
      <Text style={[styles.title, { color: tone === 'warning' ? t.warning : t.text }]}>{title}</Text>
      {body ? <Text style={[styles.body, { color: t.textSecondary }]}>{body}</Text> : null}
      {locked ? (
        <Text style={[styles.body, { color: t.textSecondary }]}>这条行程已报销，里程已锁定，不再改动。</Text>
      ) : action ? (
        <View style={styles.row}>
          <Button title={action.title} kind="secondary" onPress={action.onPress} loading={busy} style={{ flex: 1 }} />
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 16, fontWeight: '600' },
  body: { fontSize: 14, lineHeight: 20 },
  row: { flexDirection: 'row', gap: space.md },
});
