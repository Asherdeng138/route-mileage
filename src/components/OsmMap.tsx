import { Image } from 'expo-image';
import { useEffect, useMemo, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Polyline } from 'react-native-svg';

import { radius, useTheme } from '@/constants/theme';
import { routeSegments, type FilledGap } from '@/lib/gaps';
import { decimate } from '@/lib/geo';
import { boundsCenter, fitZoom, OSM, project, toView, viewTiles, type TileRef } from '@/lib/osm';
import type { LatLng } from '@/lib/types';
import { getTileFile } from '@/services/osmTiles';

const LONDON: LatLng = { lat: 51.5072, lng: -0.1276 };
const LIVE_ZOOM = 15;

/** 单个 OpenStreetMap 图块（经过本地缓存下载） */
export function Tile({ tile }: { tile: TileRef }) {
  const [uri, setUri] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    getTileFile(tile.z, tile.x, tile.y).then((f) => {
      if (alive && f) setUri(f.uri);
    });
    return () => {
      alive = false;
    };
  }, [tile.z, tile.x, tile.y]);
  if (!uri) return null;
  return (
    <Image
      source={{ uri }}
      transition={0}
      style={{ position: 'absolute', left: tile.left, top: tile.top, width: OSM.tileSize, height: OSM.tileSize }}
    />
  );
}

/**
 * OpenStreetMap 底图 + GPS 实际轨迹（不需要 Google API Key）。
 * 记录中（live）跟随最新位置；查看行程时自动缩放到整条轨迹。可用 ＋ / − 缩放。
 * 没有网络时图块显示为空白底色，轨迹照常显示。
 */
export function OsmMap({
  points,
  height,
  live,
  rounded = true,
  fills = [],
}: {
  points: (LatLng & { ts?: number })[];
  height: number;
  live?: boolean;
  rounded?: boolean;
  fills?: FilledGap[];
}) {
  const t = useTheme();
  const [width, setWidth] = useState(0);
  const [zoomDelta, setZoomDelta] = useState(0);
  const pts = useMemo(() => decimate(points, 800), [points]);
  const last = points.length ? points[points.length - 1] : null;

  const base = live ? LIVE_ZOOM : pts.length >= 2 && width > 0 ? fitZoom(pts, width, height, 28, 17) : 14;
  const z = Math.max(OSM.minZoom, Math.min(OSM.maxZoom, base + zoomDelta));
  const center = live && last ? project(last, z) : pts.length ? boundsCenter(pts, z) : project(LONDON, z);
  const tiles = width > 0 ? viewTiles(center, z, width, height) : [];
  const xy = width > 0 ? pts.map((p) => toView(project(p, z), center, width, height)) : [];
  const toLine = (arr: { x: number; y: number }[]) => arr.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const line = toLine(xy);
  const view = (p: LatLng) => toView(project(p, z), center, width, height);
  const seg = width > 0 && fills.length ? routeSegments(points, fills) : null;
  const solidLines = seg ? seg.solid.map((s) => toLine(decimate(s, 800).map(view))) : [line];
  const fillLines = seg ? seg.filled.map((s) => toLine(s.map(view))) : [];

  return (
    <View
      style={[styles.box, !rounded && styles.square, { height, backgroundColor: '#E8E4DC', borderColor: t.border }]}
      onLayout={(e) => setWidth(Math.round(e.nativeEvent.layout.width))}>
      {tiles.map((tile) => (
        <Tile key={`${tile.z}/${tile.x}/${tile.y}/${tile.left}`} tile={tile} />
      ))}
      {width > 0 ? (
        <Svg width={width} height={height} style={StyleSheet.absoluteFill} pointerEvents="none">
          {xy.length > 1 ? (
            <>
              {[...solidLines, ...fillLines].map((l, i) => (
                <Polyline key={`w${i}`} points={l} fill="none" stroke="#FFFFFF" strokeWidth={8} strokeLinejoin="round" strokeLinecap="round" />
              ))}
              {fillLines.map((l, i) => (
                <Polyline key={`f${i}`} points={l} fill="none" stroke="#5B8DEF" strokeWidth={5} strokeDasharray="10,7" />
              ))}
              {solidLines.map((l, i) => (
                <Polyline key={`s${i}`} points={l} fill="none" stroke="#007AFF" strokeWidth={5} strokeLinejoin="round" strokeLinecap="round" />
              ))}
            </>
          ) : null}
          {xy.length > 0 ? <Circle cx={xy[0].x} cy={xy[0].y} r={7} fill="#34C759" stroke="#FFFFFF" strokeWidth={3} /> : null}
          {xy.length > 1 && !live ? (
            <Circle cx={xy[xy.length - 1].x} cy={xy[xy.length - 1].y} r={7} fill="#FF3B30" stroke="#FFFFFF" strokeWidth={3} />
          ) : null}
          {live && xy.length > 0 ? (
            <Circle cx={xy[xy.length - 1].x} cy={xy[xy.length - 1].y} r={8} fill="#007AFF" stroke="#FFFFFF" strokeWidth={3} />
          ) : null}
        </Svg>
      ) : null}

      {points.length === 0 ? (
        <View style={styles.center} pointerEvents="none">
          <Text style={[styles.pill, { color: '#333' }]}>{live ? '正在获取定位…' : '没有 GPS 轨迹'}</Text>
        </View>
      ) : null}

      <View style={styles.zoom}>
        <Pressable accessibilityLabel="放大" onPress={() => setZoomDelta((d) => d + 1)} style={styles.zoomBtn} hitSlop={6}>
          <Text style={styles.zoomText}>＋</Text>
        </Pressable>
        <Pressable accessibilityLabel="缩小" onPress={() => setZoomDelta((d) => d - 1)} style={styles.zoomBtn} hitSlop={6}>
          <Text style={styles.zoomText}>－</Text>
        </Pressable>
      </View>

      <Text style={[styles.pill, styles.label]}>手机 GPS 实际轨迹</Text>
      <Pressable style={styles.attribution} onPress={() => Linking.openURL(OSM.copyrightUrl)} accessibilityRole="link">
        <Text style={styles.attributionText}>{OSM.attribution}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  square: { borderRadius: 0, borderWidth: 0 },
  center: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  pill: { backgroundColor: 'rgba(255,255,255,0.85)', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, fontSize: 12, overflow: 'hidden' },
  label: { position: 'absolute', left: 8, top: 8, color: '#333' },
  zoom: { position: 'absolute', right: 8, top: 8, gap: 6 },
  zoomBtn: { width: 36, height: 36, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.92)', alignItems: 'center', justifyContent: 'center' },
  zoomText: { fontSize: 20, fontWeight: '700', color: '#007AFF' },
  attribution: { position: 'absolute', right: 0, bottom: 0, backgroundColor: 'rgba(255,255,255,0.85)', paddingHorizontal: 6, paddingVertical: 2, borderTopLeftRadius: 6 },
  attributionText: { fontSize: 11, color: '#333' },
});
