import { router, useNavigation } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { RouteMap } from '@/components/RouteMap';
import { Button } from '@/components/ui';
import { space, useTheme } from '@/constants/theme';
import { getAppSettings } from '@/db/settings';
import { getActiveTrip, getPointsSince } from '@/db/trips';
import { formatClock } from '@/lib/dates';
import { PERMISSION_CHECK_MS, RECORDING_REFRESH_MS, STALE_FIX_SEC } from '@/lib/trackingConfig';
import type { AppSettings, TrackPoint, Trip } from '@/lib/types';
import { metersToUnit, unitShort } from '@/lib/units';
import { useAppActive } from '@/lib/useAppActive';
import { currentPowerMode, lastRawFixTs } from '@/tracking/power';
import {
  askToEnableLocationServices,
  discardRecording,
  getPermissionState,
  isUpdating,
  requestBackgroundPermission,
  requestNotificationPermission,
  resumeRecording,
  stopRecording,
  type PermissionState,
} from '@/tracking/recorder';

interface LiveState {
  trip: Trip | null;
  /** 这次打开记录页时看到的行程（自动结束后用来跳到行程详情） */
  lastTripId: number | null;
  points: TrackPoint[];
  updating: boolean;
  loaded: boolean;
}

type IssueFix = 'settings' | 'services' | 'resume' | 'background' | 'notifications';
interface Issue {
  text: string;
  action: string | null;
  fix: IssueFix | null;
}

/** 底部卡片盖住地图的高度（圆角部分），地图镜头避开它 */
const SHEET_OVERLAP = 24;

export default function RecordingScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const active = useAppActive();
  const [live, setLive] = useState<LiveState>({ trip: null, lastTripId: null, points: [], updating: true, loaded: false });
  const [perms, setPerms] = useState<PermissionState | null>(null);
  const [settings, setSettings] = useState<Pick<AppSettings, 'unit' | 'onlineMaps' | 'mapProvider'>>({
    unit: 'mi',
    onlineMaps: true,
    mapProvider: 'google',
  });
  const [now, setNow] = useState(() => Date.now());
  const [mapH, setMapH] = useState(0);
  const [stopping, setStopping] = useState(false);
  // 增量读取：只读上次之后的新点，长时间记录也不会每次读全部轨迹
  const cache = useRef<{ tripId: number | null; points: TrackPoint[] }>({ tripId: null, points: [] });

  const refreshTrip = useCallback(async () => {
    const [trip, updating] = await Promise.all([getActiveTrip(), isUpdating()]);
    const c = cache.current;
    if (!trip) {
      cache.current = { tripId: null, points: [] };
    } else {
      if (c.tripId !== trip.id) cache.current = { tripId: trip.id, points: [] };
      const last = cache.current.points[cache.current.points.length - 1];
      const fresh = await getPointsSince(trip.id, last ? last.ts : -1);
      if (fresh.length) cache.current.points = [...cache.current.points, ...fresh];
    }
    setLive((prev) => ({ trip, lastTripId: trip?.id ?? prev.lastTripId, points: cache.current.points, updating, loaded: true }));
  }, []);

  const refreshPerms = useCallback(async () => setPerms(await getPermissionState()), []);

  const refreshAll = useCallback(
    () => Promise.all([refreshTrip(), refreshPerms()]).catch(() => undefined),
    [refreshTrip, refreshPerms],
  );

  useEffect(() => {
    let alive = true;
    getAppSettings().then((s) => {
      if (alive) setSettings({ unit: s.unit, onlineMaps: s.onlineMaps, mapProvider: s.mapProvider });
    });
    return () => {
      alive = false;
    };
  }, []);

  // 省电优化 #4：只在 App 前台时刷新界面（轨迹 5 秒、权限 30 秒、时钟 1 秒）；锁屏 / 切到导航时全部停止
  useEffect(() => {
    if (!active) return;
    const first = setTimeout(() => {
      setNow(Date.now());
      refreshAll();
    }, 0);
    const trip = setInterval(() => refreshTrip().catch(() => undefined), RECORDING_REFRESH_MS);
    const perm = setInterval(() => refreshPerms().catch(() => undefined), PERMISSION_CHECK_MS);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearTimeout(first);
      clearInterval(trip);
      clearInterval(perm);
      clearInterval(clock);
    };
  }, [active, refreshAll, refreshTrip, refreshPerms]);

  const { trip, points, updating, loaded } = live;

  const onStop = async () => {
    setStopping(true);
    try {
      const id = await stopRecording();
      if (id != null) router.replace({ pathname: '/trip/[id]', params: { id: String(id), fresh: '1' } });
      else navigation.goBack();
    } catch (e) {
      Alert.alert('结束记录失败', `${(e as Error).message}\n\n已记录的点都已保存，可以再试一次。`);
    } finally {
      setStopping(false);
    }
  };

  const onDiscard = () =>
    Alert.alert('放弃这次记录？', '路线和里程都不会保存。', [
      { text: '取消', style: 'cancel' },
      {
        text: '放弃',
        style: 'destructive',
        onPress: async () => {
          await discardRecording();
          navigation.goBack();
        },
      },
    ]);

  const onResume = async () => {
    const r = await resumeRecording();
    if (!r.ok) Alert.alert('无法继续记录', r.message);
    refreshAll();
  };

  if (loaded && !trip) {
    const endedId = live.lastTripId;
    return (
      <View style={[styles.center, { backgroundColor: t.bg }]}>
        <Text style={{ color: t.text, fontSize: 17, fontWeight: '600', marginBottom: space.sm }}>
          {endedId != null ? '行程已结束并保存' : '当前没有正在记录的行程'}
        </Text>
        {endedId != null ? (
          <Text style={{ color: t.textSecondary, marginBottom: space.lg, textAlign: 'center' }}>
            停车时间较长，已自动结束（结束时间取开始停车的时刻）。请确认起点和终点。
          </Text>
        ) : null}
        <View style={{ alignSelf: 'stretch', gap: space.sm }}>
          {endedId != null ? (
            <Button
              title="查看行程"
              onPress={() => router.replace({ pathname: '/trip/[id]', params: { id: String(endedId), fresh: '1' } })}
            />
          ) : null}
          <Button title="返回" kind="secondary" onPress={() => navigation.goBack()} />
        </View>
      </View>
    );
  }

  const elapsed = trip?.startTime ? now - trip.startTime : 0;
  const lastFix = points.length ? points[points.length - 1] : null;
  // 停车时的点不入库（防漂移），所以取「最近入库的点」和「最近收到的原始定位」中较新的一个
  const lastFixAt = Math.max(lastFix?.ts ?? 0, trip?.startTime != null && lastRawFixTs() >= trip.startTime ? lastRawFixTs() : 0);
  const staleSec = lastFixAt > 0 ? Math.max(0, Math.round((now - lastFixAt) / 1000)) : null;
  const servicesOff = !!perms && !perms.servicesEnabled;
  const fgDenied = !!perms && perms.foreground !== 'granted';
  const lost = updating && !servicesOff && staleSec != null && staleSec > STALE_FIX_SEC;
  const saving = currentPowerMode() === 'low';
  const distance = metersToUnit(trip?.distanceGpsM ?? 0, settings.unit);

  const status = (() => {
    if (fgDenied) return { color: t.record, text: '定位权限已关闭' };
    if (servicesOff) return { color: t.record, text: '手机定位服务已关闭' };
    if (!updating) return { color: t.record, text: '后台定位已停止' };
    if (staleSec == null) return { color: t.warning, text: '正在获取定位…' };
    if (lost) return { color: t.warning, text: '定位信号弱' };
    if (saving) return { color: t.switchOn, text: '停车中 · 省电定位' };
    return { color: t.switchOn, text: '正在记录' };
  })();
  const fixText =
    staleSec == null ? '等待第一个 GPS 点' : staleSec < 60 ? `${staleSec} 秒前定位` : `${Math.round(staleSec / 60)} 分钟前定位`;

  // 需要用户处理的问题：只显示一条最重要的，紧凑显示
  const issue: Issue | null = fgDenied
    ? { text: '定位权限被关闭，记录无法继续。', action: '打开系统设置', fix: 'settings' }
    : servicesOff
      ? { text: '手机定位已关闭，打开后自动继续（已记录的点都在）。', action: '打开定位', fix: 'services' }
      : !updating
        ? { text: '后台定位被系统停止（可能是省电策略）。', action: '继续记录', fix: 'resume' }
        : perms && !perms.precise
          ? { text: '只允许了「大致位置」，路线会变成直线、里程偏少。', action: '打开系统设置', fix: 'settings' }
          : lost
            ? { text: '定位暂时丢失（隧道、地下停车场常见），恢复后按直线补算。', action: null, fix: null }
            : perms && perms.background !== 'granted'
              ? { text: '定位是「仅使用时允许」，改成「始终允许」后台更稳定、更省电。', action: '始终允许', fix: 'background' }
              : perms?.notifications === 'denied'
                ? { text: '通知被关闭，看不到记录状态和到达提醒。', action: '允许通知', fix: 'notifications' }
                : null;

  const onFix = (fix: IssueFix) => {
    if (fix === 'settings') Linking.openSettings();
    else if (fix === 'services') askToEnableLocationServices().then(refreshAll);
    else if (fix === 'resume') onResume();
    else if (fix === 'background') requestBackgroundPermission().then(refreshAll);
    else requestNotificationPermission().then(refreshAll);
  };
  const serious = fgDenied || servicesOff || !updating || (!!perms && !perms.precise);

  return (
    <View style={[styles.screen, { backgroundColor: t.bg }]}>
      <View style={styles.mapArea} onLayout={(e) => setMapH(Math.round(e.nativeEvent.layout.height))}>
        {mapH > 0 ? (
          <RouteMap
            points={points}
            height={mapH}
            live
            rounded={false}
            online={settings.onlineMaps}
            provider={settings.mapProvider}
            padding={{ top: 56, bottom: SHEET_OVERLAP + 16 }}
          />
        ) : null}
        <View style={[styles.statusPill, { backgroundColor: t.card }]} pointerEvents="none">
          <View style={[styles.statusDot, { backgroundColor: status.color }]} />
          <Text style={[styles.statusText, { color: t.text }]}>{status.text}</Text>
        </View>
      </View>

      <View style={[styles.sheet, { backgroundColor: t.card, paddingBottom: insets.bottom + space.md }]}>
        <View style={styles.stats}>
          <View style={styles.statMain}>
            <Text style={[styles.statLabel, { color: t.textSecondary }]}>已行驶</Text>
            <Text style={[styles.distance, { color: t.text }]} numberOfLines={1} adjustsFontSizeToFit>
              {distance.toFixed(2)}
              <Text style={[styles.unit, { color: t.textSecondary }]}> {unitShort(settings.unit)}</Text>
            </Text>
          </View>
          <View style={styles.statSide}>
            <Text style={[styles.statLabel, { color: t.textSecondary }]}>用时</Text>
            <Text style={[styles.clock, { color: t.text }]}>{formatClock(elapsed)}</Text>
          </View>
        </View>
        <Text style={[styles.meta, { color: t.textSecondary }]}>
          {fixText} · {points.length} 个 GPS 点 · 可锁屏或切到导航
        </Text>

        {issue ? (
          <View style={[styles.issue, { backgroundColor: serious ? t.warningSoft : t.bg }]}>
            <Text style={[styles.issueText, { color: serious ? t.warning : t.textSecondary }]}>{issue.text}</Text>
            {issue.action && issue.fix ? (
              <Pressable onPress={() => issue.fix && onFix(issue.fix)} hitSlop={8} accessibilityRole="button">
                <Text style={[styles.issueAction, { color: t.primary }]}>{issue.action}</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="结束记录"
          onPress={onStop}
          disabled={stopping}
          style={({ pressed }) => [styles.stop, { backgroundColor: t.record, opacity: stopping ? 0.6 : pressed ? 0.8 : 1 }]}>
          <View style={styles.stopIcon} />
          <Text style={styles.stopText}>{stopping ? '正在保存…' : '结束记录'}</Text>
        </Pressable>

        <View style={styles.links}>
          <Pressable onPress={onDiscard} hitSlop={10} accessibilityRole="button">
            <Text style={[styles.link, { color: t.record }]}>放弃记录</Text>
          </Pressable>
          <Pressable onPress={() => router.push('/help')} hitSlop={10} accessibilityRole="button">
            <Text style={[styles.link, { color: t.primary }]}>后台记录与省电说明</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  mapArea: { flex: 1 },
  statusPill: {
    position: 'absolute',
    top: space.md,
    left: space.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    elevation: 3,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  statusDot: { width: 9, height: 9, borderRadius: 5 },
  statusText: { fontSize: 15, fontWeight: '600' },
  sheet: {
    marginTop: -SHEET_OVERLAP,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: space.xl,
    paddingTop: space.xl,
    gap: space.md,
    elevation: 12,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: -4 },
  },
  stats: { flexDirection: 'row', alignItems: 'flex-end', gap: space.lg },
  statMain: { flex: 1 },
  statSide: { alignItems: 'flex-end' },
  statLabel: { fontSize: 13, fontWeight: '500', marginBottom: 2 },
  distance: { fontSize: 52, fontWeight: '700', letterSpacing: -1, fontVariant: ['tabular-nums'] },
  unit: { fontSize: 22, fontWeight: '600', letterSpacing: 0 },
  clock: { fontSize: 28, fontWeight: '600', fontVariant: ['tabular-nums'], marginBottom: 6 },
  meta: { fontSize: 13, marginTop: -space.xs },
  issue: { borderRadius: 12, paddingHorizontal: space.md, paddingVertical: 10, gap: 6 },
  issueText: { fontSize: 14, lineHeight: 19 },
  issueAction: { fontSize: 15, fontWeight: '600' },
  stop: {
    height: 60,
    borderRadius: 30,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    marginTop: space.xs,
  },
  stopIcon: { width: 16, height: 16, borderRadius: 3, backgroundColor: '#FFFFFF' },
  stopText: { color: '#FFFFFF', fontSize: 19, fontWeight: '700' },
  links: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: space.xs },
  link: { fontSize: 15 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl },
});
