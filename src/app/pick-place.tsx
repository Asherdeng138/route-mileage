import * as Location from 'expo-location';
import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { PanMap } from '@/components/PanMap';
import { Badge } from '@/components/ui';
import { space, useTheme } from '@/constants/theme';
import { googleUsage } from '@/db/apiUsage';
import { effectiveLimit } from '@/lib/googleQuota';
import { getAppSettings } from '@/db/settings';
import { haversineM } from '@/lib/geo';
import type { NearbyPlace } from '@/lib/nearby';
import { putPick } from '@/lib/pickerBridge';
import type { LatLng } from '@/lib/types';
import { findNearby, type NearbyResult } from '@/services/nearby';

const LONDON: LatLng = { lat: 51.5072, lng: -0.1276 };
/** 图钉移动超过这个距离才重新查询，避免频繁计费 */
const REQUERY_M = 25;
const SETTLE_MS = 600;

const SOURCE_LABEL: Record<NearbyPlace['source'], string> = {
  saved: '常用',
  google: 'Google',
  osm: 'OSM',
  address: '地址',
};

/**
 * 在地图上选择起点 / 终点（类似 Uber 选上车点）：拖动地图让中心图钉对准位置，
 * 下面列出附近的门店 / 公司 / 设施，点一下就填入，不用自己搜地址。
 */
export default function PickPlaceScreen() {
  const t = useTheme();
  const navigation = useNavigation();
  const params = useLocalSearchParams<{ key: string; label?: string; lat?: string; lng?: string }>();
  const [start, setStart] = useState<LatLng | null>(
    params.lat && params.lng ? { lat: Number(params.lat), lng: Number(params.lng) } : null,
  );
  const [pin, setPin] = useState<LatLng | null>(start);
  const [result, setResult] = useState<NearbyResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [quotaText, setQuotaText] = useState('');
  const lastQuery = useRef<LatLng | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    navigation.setOptions({ title: `选择${params.label ?? '地点'}` });
  }, [navigation, params.label]);

  // 没有传入坐标（例如手动补录）：先取当前位置（最多等 5 秒），取不到再用手机最近一次的位置
  useEffect(() => {
    if (start) return;
    let alive = true;
    Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      new Promise<null>((r) => setTimeout(() => r(null), 5000)),
    ])
      .catch(() => null)
      .then((p) => p ?? Location.getLastKnownPositionAsync().catch(() => null))
      .then((p) => {
        if (!alive) return;
        const c = p ? { lat: p.coords.latitude, lng: p.coords.longitude } : LONDON;
        setStart(c);
        setPin(c);
      });
    return () => {
      alive = false;
    };
  }, [start]);

  const refreshQuota = useCallback(async () => {
    const s = await getAppSettings();
    if (!s.googleEnabled) return setQuotaText('Google 已关闭，使用免费来源');
    const u = await googleUsage('places.nearby', effectiveLimit('places.nearby', s.googleMonthlyLimit));
    setQuotaText(u.exhausted ? `本月 Google ${u.used}/${u.limit} 次已用完，已切换到免费来源` : `本月 Google 已用 ${u.used}/${u.limit} 次`);
  }, []);

  const query = useCallback(
    async (p: LatLng) => {
      if (lastQuery.current && haversineM(lastQuery.current, p) < REQUERY_M) return;
      lastQuery.current = p;
      setLoading(true);
      try {
        setResult(await findNearby(p));
      } finally {
        setLoading(false);
        refreshQuota();
      }
    },
    [refreshQuota],
  );

  useEffect(() => {
    if (!pin) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => query(pin), SETTLE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [pin, query]);

  const choose = (name: string, address: string | null, p: LatLng) => {
    putPick(params.key, { name, address, lat: p.lat, lng: p.lng });
    router.back();
  };

  if (!start || !pin) {
    return (
      <View style={[styles.center, { backgroundColor: t.bg }]}>
        <ActivityIndicator />
      </View>
    );
  }

  const places = result?.places ?? [];
  const googleNote =
    result?.google === 'quota'
      ? '本月 Google 次数已用完，下面是 OpenStreetMap 的免费结果'
      : result?.google === 'no-key'
        ? '未填写 Google API Key，下面是 OpenStreetMap 的免费结果'
        : result?.google === 'error'
          ? `Google 查询失败（${result.googleMessage ?? '网络问题'}），已改用免费来源`
          : null;

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <PanMap
        initial={start}
        height={320}
        markers={places.map((p) => ({ key: p.key, lat: p.lat, lng: p.lng }))}
        onSettle={setPin}
      />
      <FlatList
        data={places}
        keyExtractor={(p) => p.key}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <View style={{ gap: space.sm }}>
            <Text style={{ color: t.textSecondary, fontSize: 12 }}>拖动地图，让图钉对准{params.label ?? '地点'}；下面会列出附近的地点。{quotaText ? `\n${quotaText}` : ''}</Text>
            <Pressable
              onPress={() => choose(result?.address?.split(',')[0] ?? '', result?.address ?? null, pin)}
              disabled={!result?.address}
              style={({ pressed }) => [styles.row, { backgroundColor: t.card, borderColor: t.border, opacity: pressed ? 0.7 : 1 }]}>
              <Text style={{ fontSize: 20 }}>📍</Text>
              <View style={{ flex: 1 }}>
                <Text style={{ color: t.text, fontWeight: '700' }}>使用图钉位置</Text>
                <Text style={{ color: t.textSecondary }} numberOfLines={2}>
                  {loading && !result ? '正在识别地址…' : (result?.address ?? '没有识别到地址（可能没有网络）')}
                </Text>
              </View>
            </Pressable>
            {googleNote ? <Text style={{ color: t.warning, fontSize: 12 }}>{googleNote}</Text> : null}
            <View style={styles.header}>
              <Text style={{ color: t.textSecondary, fontWeight: '700' }}>附近地点</Text>
              {loading ? <ActivityIndicator size="small" /> : null}
            </View>
          </View>
        }
        ListEmptyComponent={
          !loading && result ? <Text style={{ color: t.textSecondary }}>附近 150 米内没有找到有名字的地点，可以用图钉位置。</Text> : undefined
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() => choose(item.name, item.address ?? result?.address ?? null, item)}
            style={({ pressed }) => [styles.row, { backgroundColor: t.card, borderColor: t.border, opacity: pressed ? 0.7 : 1 }]}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ color: t.text, fontWeight: '700' }} numberOfLines={1}>
                {item.name}
              </Text>
              <Text style={{ color: t.textSecondary, fontSize: 13 }} numberOfLines={1}>
                {[item.kind, item.address].filter(Boolean).join(' · ')}
              </Text>
            </View>
            <View style={{ alignItems: 'flex-end', gap: 4 }}>
              <Text style={{ color: t.textSecondary, fontSize: 12 }}>{Math.round(item.distanceM)} m</Text>
              <Badge label={SOURCE_LABEL[item.source]} tone={item.source === 'saved' ? 'success' : 'business'} />
            </View>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  list: { padding: space.lg, gap: space.sm, paddingBottom: 48 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: space.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth },
});
