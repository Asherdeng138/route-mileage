import { useRef, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View, type GestureResponderEvent } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import { OSM, project, toView, unproject, viewTiles } from '@/lib/osm';
import type { LatLng } from '@/lib/types';

import { Tile } from './OsmMap';

export interface MapMarker extends LatLng {
  key: string;
  selected?: boolean;
}

/**
 * 可拖动的 OpenStreetMap 地图，中心固定一个图钉（类似 Uber 选上车点）：
 * 拖动地图让图钉对准位置，松手后 onSettle 返回图钉处的坐标。可 ＋ / − 缩放。
 */
export function PanMap({
  initial,
  height,
  markers = [],
  onSettle,
  onDragStart,
}: {
  initial: LatLng;
  height: number;
  markers?: MapMarker[];
  onSettle: (p: LatLng) => void;
  onDragStart?: () => void;
}) {
  const [width, setWidth] = useState(0);
  const [zoom, setZoom] = useState(17);
  const [center, setCenter] = useState<LatLng>(initial);
  const [drag, setDrag] = useState({ dx: 0, dy: 0 });
  const [dragging, setDragging] = useState(false);

  // 手指按下时的位置（只在触摸事件里读写）
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  const offset = (e: GestureResponderEvent) => {
    const s = touchStart.current;
    return s ? { dx: e.nativeEvent.pageX - s.x, dy: e.nativeEvent.pageY - s.y } : { dx: 0, dy: 0 };
  };

  const onGrant = (e: GestureResponderEvent) => {
    touchStart.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY };
    setDragging(true);
    onDragStart?.();
  };

  const onRelease = (e: GestureResponderEvent) => {
    const { dx, dy } = offset(e);
    touchStart.current = null;
    setDrag({ dx: 0, dy: 0 });
    setDragging(false);
    if (Math.abs(dx) + Math.abs(dy) < 2) return;
    const px = project(center, zoom);
    const next = unproject({ x: px.x - dx, y: px.y - dy }, zoom);
    setCenter(next);
    onSettle(next);
  };

  const cpx = project(center, zoom);
  const viewCenter = { x: cpx.x - drag.dx, y: cpx.y - drag.dy };
  const tiles = width > 0 ? viewTiles(viewCenter, zoom, width, height) : [];

  return (
    <View
      style={[styles.box, { height }]}
      onLayout={(e) => setWidth(Math.round(e.nativeEvent.layout.width))}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
      onResponderGrant={onGrant}
      onResponderMove={(e) => setDrag(offset(e))}
      onResponderRelease={onRelease}
      onResponderTerminate={() => {
        touchStart.current = null;
        setDrag({ dx: 0, dy: 0 });
        setDragging(false);
      }}>
      {tiles.map((tile) => (
        <Tile key={`${tile.z}/${tile.x}/${tile.y}/${tile.left}`} tile={tile} />
      ))}
      {width > 0 ? (
        <Svg width={width} height={height} style={StyleSheet.absoluteFill} pointerEvents="none">
          {markers.map((m) => {
            const v = toView(project(m, zoom), viewCenter, width, height);
            return (
              <Circle
                key={m.key}
                cx={v.x}
                cy={v.y}
                r={m.selected ? 8 : 6}
                fill={m.selected ? '#D93B3B' : '#1F4E9C'}
                stroke="#FFFFFF"
                strokeWidth={2}
              />
            );
          })}
          {/* 中心图钉：拖动时抬起 */}
          <Circle cx={width / 2} cy={height / 2} r={4} fill="rgba(0,0,0,0.35)" />
          <Path
            transform={`translate(${width / 2 - 16}, ${height / 2 - (dragging ? 52 : 44)})`}
            d="M16 0C7.2 0 0 7 0 15.6 0 27.3 16 44 16 44s16-16.7 16-28.4C32 7 24.8 0 16 0z"
            fill="#111111"
          />
          <Circle cx={width / 2} cy={height / 2 - (dragging ? 52 : 44) + 15.5} r={6} fill="#FFFFFF" />
        </Svg>
      ) : null}

      <View style={styles.zoom}>
        <Pressable accessibilityLabel="放大" onPress={() => setZoom((z) => Math.min(OSM.maxZoom, z + 1))} style={styles.zoomBtn} hitSlop={6}>
          <Text style={styles.zoomText}>＋</Text>
        </Pressable>
        <Pressable accessibilityLabel="缩小" onPress={() => setZoom((z) => Math.max(OSM.minZoom, z - 1))} style={styles.zoomBtn} hitSlop={6}>
          <Text style={styles.zoomText}>－</Text>
        </Pressable>
      </View>
      <Pressable style={styles.attribution} onPress={() => Linking.openURL(OSM.copyrightUrl)} accessibilityRole="link">
        <Text style={styles.attributionText}>{OSM.attribution}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { overflow: 'hidden', backgroundColor: '#E8E4DC' },
  zoom: { position: 'absolute', right: 10, top: 10, gap: 8 },
  zoomBtn: { width: 40, height: 40, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.95)', alignItems: 'center', justifyContent: 'center' },
  zoomText: { fontSize: 22, fontWeight: '700', color: '#1F4E9C' },
  attribution: { position: 'absolute', right: 0, bottom: 0, backgroundColor: 'rgba(255,255,255,0.85)', paddingHorizontal: 6, paddingVertical: 2, borderTopLeftRadius: 6 },
  attributionText: { fontSize: 11, color: '#333' },
});
