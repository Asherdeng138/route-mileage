import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Line, Polyline } from 'react-native-svg';

import { radius, useTheme } from '@/constants/theme';
import { boundsOf, decimate, pathDistanceM, projectToBox } from '@/lib/geo';
import type { FilledGap } from '@/lib/gaps';
import type { LatLng } from '@/lib/types';
import { hasBuildTimeMapsKey } from '@/services/google';

import { OsmMap } from './OsmMap';

interface Props {
  points: (LatLng & { ts?: number })[];
  height?: number;
  /** 记录中：跟随最新位置 */
  live?: boolean;
  /** 允许使用在线地图（设置中可关闭；关闭后只画 GPS 轨迹形状） */
  online?: boolean;
  /** 地图来源（设置）：Google 原生地图需要构建时 Key，没有时自动改用 OpenStreetMap */
  provider?: 'google' | 'osm';
  /** 圆角卡片样式（记录页的全屏地图不要） */
  rounded?: boolean;
  /** 信号中断补算的路段（虚线） */
  fills?: FilledGap[];
  /** 被浮层遮住的边距（仅 Google 地图），镜头会避开 */
  padding?: { top?: number; bottom?: number; left?: number; right?: number };
}

/**
 * 路线图。
 * Google：原生 Google 地图（构建时 Key，移动端地图加载免费、不计入地点查询次数）；
 * OpenStreetMap：OSM 瓦片 + 实际轨迹（不需要 Key）；
 * 关闭在线地图：GPS 轨迹预览（按经纬度比例画出的轨迹形状，不是地图路线），不依赖网络。
 */
export function RouteMap({ points, height = 220, live, online = true, provider = 'google', rounded = true, padding, fills }: Props) {
  const t = useTheme();
  if (online && provider === 'google' && hasBuildTimeMapsKey()) {
    // 延迟加载：没有 Key 的构建完全不触碰原生地图模块（否则会闪退）
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { GoogleTrackMap } = require('./GoogleTrackMap') as typeof import('./GoogleTrackMap');
    const frame = rounded ? [styles.box, { borderColor: t.border }] : null;
    return <GoogleTrackMap points={points} live={live} padding={padding} fills={fills} style={[frame, { height }]} />;
  }
  if (online) return <OsmMap points={points} height={height} live={live} rounded={rounded} fills={fills} />;
  return <RouteSketch points={points} height={height} />;
}

function RouteSketch({ points, height }: { points: LatLng[]; height: number }) {
  const t = useTheme();
  const [width, setWidth] = useState(0);
  const pts = decimate(points, 600);
  const xy = width > 0 ? projectToBox(pts, width, height, 22) : [];
  const spanM = (() => {
    const b = boundsOf(pts);
    if (!b) return 0;
    return pathDistanceM([
      { lat: b.minLat, lng: b.minLng },
      { lat: b.maxLat, lng: b.maxLng },
    ]);
  })();

  // 网格线
  const grid = [0.25, 0.5, 0.75];

  return (
    <View
      style={[styles.box, { height, backgroundColor: t.input, borderColor: t.border }]}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {width > 0 && (
        <Svg width={width} height={height}>
          {grid.map((g) => (
            <Line key={`h${g}`} x1={0} x2={width} y1={height * g} y2={height * g} stroke={t.border} strokeWidth={1} />
          ))}
          {grid.map((g) => (
            <Line key={`v${g}`} y1={0} y2={height} x1={width * g} x2={width * g} stroke={t.border} strokeWidth={1} />
          ))}
          {xy.length > 1 && (
            <Polyline
              points={xy.map((p) => `${p.x},${p.y}`).join(' ')}
              fill="none"
              stroke={t.primary}
              strokeWidth={4}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          )}
          {xy.length > 0 && (
            <Circle cx={xy[0].x} cy={xy[0].y} r={7} fill={t.success} stroke={t.card} strokeWidth={2} />
          )}
          {xy.length > 1 && (
            <Circle
              cx={xy[xy.length - 1].x}
              cy={xy[xy.length - 1].y}
              r={7}
              fill={t.record}
              stroke={t.card}
              strokeWidth={2}
            />
          )}
        </Svg>
      )}
      {points.length < 2 && (
        <View style={styles.empty} pointerEvents="none">
          <Text style={{ color: t.textSecondary }}>
            {points.length === 0 ? '暂无路线' : '等待更多 GPS 点…'}
          </Text>
        </View>
      )}
      <View style={styles.legend} pointerEvents="none">
        <Text style={[styles.legendText, { color: t.textSecondary }]}>
          GPS 轨迹预览（不是地图路线）{spanM > 0 ? ` · 范围约 ${(spanM / 1000).toFixed(1)} km` : ''}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  empty: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  legend: { position: 'absolute', left: 10, bottom: 6 },
  legendText: { fontSize: 11 },
});
