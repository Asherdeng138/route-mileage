/**
 * 信号中断补算（纯函数，可测试）。
 *
 * 乡村、隧道、树林里 GPS 可能一段时间没有可用的点，两端之间只能按直线计入，里程偏少。
 * 有网络后，用 Google Routes API 查这两点之间的驾车路线（含备选路线，最多 4 条），
 * 选「预计用时最接近实际断开时间」的那条——最可能是真实走过的路，不会系统性偏多或偏少。
 *
 * 选择规则（阈值见 trackingConfig.GAP_FILL）：
 *  1. 只考虑「来得及开完」的路线：预计用时 ≤ 断开时间 × 1.25 + 60 秒，平均速度 ≤ 90 mph，长度不短于直线；
 *  2. 断开时间超过最长可行路线用时的 2 倍：中途多半停过车，用 Google 推荐路线（DEFAULT_ROUTE）；
 *  3. 否则选预计用时与断开时间相差最小的路线；
 *  4. 没有任何可行路线：保持直线，标记为「需要核对」。
 */
import { haversineM } from './geo';
import { GAP_FILL } from './trackingConfig';
import type { LatLng, TrackPoint } from './types';

export interface TrackGapSpan {
  /** 中断前最后一个点、中断后第一个点 */
  from: TrackPoint;
  to: TrackPoint;
  startTs: number;
  endTs: number;
  gapSec: number;
  straightM: number;
}

/** 找出需要补算的中断（输入为已接受的轨迹点，按时间排序） */
export function findGaps(points: TrackPoint[], opts = GAP_FILL): TrackGapSpan[] {
  const out: TrackGapSpan[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const gapSec = (b.ts - a.ts) / 1000;
    if (gapSec < opts.minGapSec) continue;
    const straightM = haversineM(a, b);
    if (straightM < opts.minStraightM) continue;
    out.push({ from: a, to: b, startTs: a.ts, endTs: b.ts, gapSec, straightM });
  }
  return out;
}

export interface RouteCandidate {
  distanceM: number;
  durationSec: number;
  /** Google 推荐路线（routeLabels 含 DEFAULT_ROUTE） */
  isDefault: boolean;
  path: LatLng[];
}

export type RouteChoice =
  | { kind: 'filled'; route: RouteCandidate; reason: 'time-match' | 'stopped-default' }
  | { kind: 'check'; reason: 'no-route' | 'too-fast' };

export function chooseRoute(gap: Pick<TrackGapSpan, 'gapSec' | 'straightM'>, candidates: RouteCandidate[], opts = GAP_FILL): RouteChoice {
  if (!candidates.length) return { kind: 'check', reason: 'no-route' };
  const feasible = candidates.filter(
    (r) =>
      r.distanceM >= gap.straightM * 0.98 &&
      r.durationSec <= gap.gapSec * opts.feasibleFactor + opts.feasibleSlackSec &&
      r.distanceM / gap.gapSec <= opts.maxSpeedMps,
  );
  if (!feasible.length) return { kind: 'check', reason: 'too-fast' };
  const longest = Math.max(...feasible.map((r) => r.durationSec));
  if (gap.gapSec > longest * opts.stoppedFactor) {
    const def = feasible.find((r) => r.isDefault) ?? [...feasible].sort((a, b) => a.durationSec - b.durationSec)[0];
    return { kind: 'filled', route: def, reason: 'stopped-default' };
  }
  const best = [...feasible].sort(
    (a, b) => Math.abs(a.durationSec - gap.gapSec) - Math.abs(b.durationSec - gap.gapSec) || a.distanceM - b.distanceM,
  )[0];
  return { kind: 'filled', route: best, reason: 'time-match' };
}

/** 补算增加的里程（路线长度 − 已按直线计入的长度，不为负） */
export const extraMeters = (fills: { routeM: number; straightM: number }[]) =>
  fills.reduce((s, f) => s + Math.max(0, f.routeM - f.straightM), 0);

/** Google Encoded Polyline 解码（精度 1e-5） */
export function decodePolyline(encoded: string): LatLng[] {
  const out: LatLng[] = [];
  let i = 0;
  let lat = 0;
  let lng = 0;
  const next = () => {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = encoded.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < encoded.length) {
    lat += next();
    lng += next();
    out.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return out;
}

export interface FilledGap {
  startTs: number;
  endTs: number;
  path: LatLng[];
}

/**
 * 地图绘制用：把 GPS 轨迹在已补算的中断处断开（不再画直线），返回实线段和补算段（虚线）。
 */
export function routeSegments<P extends LatLng & { ts?: number }>(points: P[], fills: FilledGap[]): { solid: P[][]; filled: LatLng[][] } {
  if (!fills.length || points.length < 2) return { solid: points.length ? [points] : [], filled: [] };
  const breaks = new Set(fills.map((f) => f.startTs));
  const solid: P[][] = [];
  let cur: P[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    cur.push(p);
    const next = points[i + 1];
    if (next && p.ts != null && breaks.has(p.ts)) {
      solid.push(cur);
      cur = [];
    }
  }
  if (cur.length) solid.push(cur);
  return { solid: solid.filter((s) => s.length > 1), filled: fills.map((f) => f.path).filter((p) => p.length > 1) };
}

/** Routes API computeRoutes 请求：只用 Essentials 功能（驾车、不考虑实时路况、无途经点），要备选路线 */
export function googleRoutesBody(from: LatLng, to: LatLng) {
  const wp = (p: LatLng) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
  return {
    origin: wp(from),
    destination: wp(to),
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_UNAWARE',
    computeAlternativeRoutes: true,
    polylineQuality: 'OVERVIEW',
    units: 'METRIC',
  };
}

export const GOOGLE_ROUTES_FIELD_MASK = 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline,routes.routeLabels';

/** 解析 computeRoutes 响应（duration 形如 "540s"） */
export function parseGoogleRoutes(json: unknown): RouteCandidate[] {
  const routes = (json as { routes?: unknown[] } | null)?.routes;
  if (!Array.isArray(routes)) return [];
  const out: RouteCandidate[] = [];
  for (const r of routes as { distanceMeters?: number; duration?: string; polyline?: { encodedPolyline?: string }; routeLabels?: string[] }[]) {
    const distanceM = Number(r.distanceMeters);
    const durationSec = Number(String(r.duration ?? '').replace(/s$/, ''));
    if (!Number.isFinite(distanceM) || !Number.isFinite(durationSec) || distanceM <= 0) continue;
    out.push({
      distanceM,
      durationSec,
      isDefault: (r.routeLabels ?? []).includes('DEFAULT_ROUTE'),
      path: r.polyline?.encodedPolyline ? decodePolyline(r.polyline.encodedPolyline) : [],
    });
  }
  return out;
}
