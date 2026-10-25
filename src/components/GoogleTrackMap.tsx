/**
 * Google 原生地图（Maps SDK for Android，移动端地图加载免费且不限次数，不计入每月 Google 地点查询次数）。
 * 需要构建时把 Key 写进安卓清单（app.config.ts → react-native-maps 插件），Key 要开通「Maps SDK for Android」。
 *
 * 记录中（live）：显示 Google 蓝点，镜头跟随最新位置；用户拖动地图后暂停跟随，点「定位」按钮恢复。
 * 查看行程：自动缩放到整条轨迹。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import MapView, { Marker, Polyline, PROVIDER_GOOGLE, type EdgePadding } from 'react-native-maps';

import { routeSegments, type FilledGap } from '@/lib/gaps';
import { decimate } from '@/lib/geo';
import type { LatLng } from '@/lib/types';

/** 淡雅的地图样式：弱化商家图标和公交标注，路线更突出（参照 Apple 地图的简洁观感） */
const CALM_STYLE = [
  { featureType: 'poi.business', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi', elementType: 'labels.icon', stylers: [{ saturation: -80 }, { lightness: 30 }] },
  { featureType: 'transit', elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ saturation: -20 }] },
  { featureType: 'landscape', stylers: [{ saturation: -30 }, { lightness: 10 }] },
];

const LONDON = { latitude: 51.5072, longitude: -0.1276 };

const toCoord = (p: LatLng) => ({ latitude: p.lat, longitude: p.lng });

function Dot({ color, size = 14 }: { color: string; size?: number }) {
  return <View style={[styles.dot, { width: size, height: size, borderRadius: size / 2, backgroundColor: color }]} />;
}

export function GoogleTrackMap({
  points,
  style,
  live,
  padding,
  fills = [],
}: {
  points: (LatLng & { ts?: number })[];
  /** 信号中断补算的路段（虚线） */
  fills?: FilledGap[];
  style?: object;
  live?: boolean;
  /** 被浮层遮住的边距（像素），镜头会避开 */
  padding?: Partial<EdgePadding>;
}) {
  const map = useRef<MapView>(null);
  const [following, setFollowing] = useState(true);
  const [ready, setReady] = useState(false);
  const coords = useMemo(() => decimate(points, 2000).map(toCoord), [points]);
  const segments = useMemo(() => {
    if (!fills.length) return null;
    const seg = routeSegments(points, fills);
    return { solid: seg.solid.map((s) => decimate(s, 2000).map(toCoord)), filled: seg.filled.map((s) => s.map(toCoord)) };
  }, [points, fills]);
  const last = coords.length ? coords[coords.length - 1] : null;
  const edge: EdgePadding = { top: 60, right: 40, bottom: 40, left: 40, ...padding };

  // 记录中：跟随最新位置
  useEffect(() => {
    if (!ready || !live || !following || !last) return;
    map.current?.animateCamera({ center: last, zoom: 16 }, { duration: 600 });
  }, [ready, live, following, last]);

  // 查看行程：缩放到整条轨迹
  useEffect(() => {
    if (!ready || live || coords.length < 2) return;
    map.current?.fitToCoordinates(coords, { edgePadding: edge, animated: false });
    // edge 每次渲染都是新对象，这里只在轨迹或地图就绪时重新缩放
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, live, coords]);

  const recenter = () => {
    setFollowing(true);
    if (live && last) map.current?.animateCamera({ center: last, zoom: 16 }, { duration: 400 });
    else if (coords.length > 1) map.current?.fitToCoordinates(coords, { edgePadding: edge, animated: true });
  };

  return (
    <View style={[styles.box, style]}>
      <MapView
        ref={map}
        provider={PROVIDER_GOOGLE}
        style={StyleSheet.absoluteFill}
        customMapStyle={CALM_STYLE}
        initialCamera={{ center: last ?? LONDON, zoom: last ? 15 : 10, heading: 0, pitch: 0 }}
        mapPadding={edge}
        showsUserLocation={!!live}
        showsMyLocationButton={false}
        showsCompass={false}
        toolbarEnabled={false}
        rotateEnabled={false}
        pitchEnabled={false}
        onMapReady={() => setReady(true)}
        onPanDrag={() => setFollowing(false)}>
        {coords.length > 1 && !segments ? (
          <>
            <Polyline coordinates={coords} strokeColor="#FFFFFF" strokeWidth={9} lineCap="round" lineJoin="round" zIndex={1} />
            <Polyline coordinates={coords} strokeColor="#007AFF" strokeWidth={5} lineCap="round" lineJoin="round" zIndex={2} />
          </>
        ) : null}
        {segments?.solid.map((s, i) => (
          <Polyline key={`s${i}`} coordinates={s} strokeColor="#007AFF" strokeWidth={5} lineCap="round" lineJoin="round" zIndex={2} />
        ))}
        {segments?.filled.map((s, i) => (
          <Polyline key={`f${i}`} coordinates={s} strokeColor="#5B8DEF" strokeWidth={5} lineDashPattern={[14, 10]} zIndex={2} />
        ))}
        {coords.length > 0 ? (
          <Marker coordinate={coords[0]} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false} zIndex={3}>
            <Dot color="#34C759" />
          </Marker>
        ) : null}
        {!live && coords.length > 1 ? (
          <Marker coordinate={coords[coords.length - 1]} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false} zIndex={3}>
            <Dot color="#FF3B30" />
          </Marker>
        ) : null}
      </MapView>
      {(!following || !live) && coords.length > 0 ? (
        <Pressable onPress={recenter} accessibilityLabel="回到当前位置" style={[styles.recenter, { top: (padding?.top ?? 0) + 12 }]}>
          <Text style={styles.recenterIcon}>◎</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { overflow: 'hidden', backgroundColor: '#E5E5EA' },
  dot: { borderWidth: 3, borderColor: '#FFFFFF', elevation: 3 },
  recenter: {
    position: 'absolute',
    right: 12,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.96)',
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  recenterIcon: { fontSize: 22, color: '#007AFF', marginTop: -2 },
});
