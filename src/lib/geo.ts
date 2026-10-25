import { FILTER } from './trackingConfig';
import type { LatLng, Place, TrackPoint } from './types';

const EARTH_RADIUS_M = 6371008.8;

const toRad = (deg: number) => (deg * Math.PI) / 180;

/** 两点间球面距离（米） */
export function haversineM(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 折线总长（米） */
export function pathDistanceM(points: LatLng[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += haversineM(points[i - 1], points[i]);
  return total;
}

export type FilterOptions = { [K in keyof typeof FILTER]: number };

export const DEFAULT_FILTER: FilterOptions = { ...FILTER };

export interface FilterResult {
  accept: boolean;
  stepM: number;
  reason?: 'accuracy' | 'too-close' | 'stationary' | 'jump';
}

/** 原地漂移阈值：精度越差，要求的最小位移越大 */
export function driftThresholdM(next: TrackPoint, opts: FilterOptions = DEFAULT_FILTER): number {
  const byAccuracy = (next.accuracy ?? 0) * opts.accuracyStepFactor;
  return Math.max(opts.minStepM, Math.min(opts.maxDriftStepM, byAccuracy));
}

/** 判断新 GPS 点是否计入轨迹 */
export function acceptPoint(
  prev: TrackPoint | null,
  next: TrackPoint,
  opts: FilterOptions = DEFAULT_FILTER,
): FilterResult {
  if (next.accuracy != null && next.accuracy > opts.maxAccuracyM) {
    return { accept: false, stepM: 0, reason: 'accuracy' };
  }
  if (!prev) return { accept: true, stepM: 0 };

  const d = haversineM(prev, next);
  if (d < driftThresholdM(next, opts)) return { accept: false, stepM: 0, reason: 'too-close' };

  const dt = (next.ts - prev.ts) / 1000;
  const acc = Math.max(next.accuracy ?? 0, opts.minStepM);
  const slow =
    (next.speed != null && next.speed >= 0 && next.speed < opts.stationarySpeedMps) ||
    (dt > 0 && d / dt < opts.stationarySpeedMps);
  if (slow && d < acc * opts.stationaryAccuracyFactor) return { accept: false, stepM: 0, reason: 'stationary' };

  if (dt > 0 && dt < opts.gapResetSec && d / dt > opts.maxSpeedMps) {
    return { accept: false, stepM: 0, reason: 'jump' };
  }
  return { accept: true, stepM: d };
}

/** 依次过滤一批点，返回被接受的点和新增距离 */
export function filterPoints(
  prev: TrackPoint | null,
  incoming: TrackPoint[],
  opts: FilterOptions = DEFAULT_FILTER,
): { accepted: TrackPoint[]; addedM: number } {
  const sorted = [...incoming].sort((a, b) => a.ts - b.ts);
  const accepted: TrackPoint[] = [];
  let last = prev;
  let addedM = 0;
  for (const p of sorted) {
    const r = acceptPoint(last, p, opts);
    if (r.accept) {
      accepted.push(p);
      addedM += r.stepM;
      last = p;
    }
  }
  return { accepted, addedM };
}

/** 找出坐标所在的常用地点（在半径内且最近） */
export function matchPlace(point: LatLng, places: Place[]): Place | null {
  let best: Place | null = null;
  let bestD = Infinity;
  for (const pl of places) {
    if (pl.lat == null || pl.lng == null) continue;
    const d = haversineM(point, { lat: pl.lat, lng: pl.lng });
    if (d <= pl.radiusM && d < bestD) {
      best = pl;
      bestD = d;
    }
  }
  return best;
}

export interface Bounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

export function boundsOf(points: LatLng[]): Bounds | null {
  if (!points.length) return null;
  let minLat = Infinity,
    maxLat = -Infinity,
    minLng = Infinity,
    maxLng = -Infinity;
  for (const p of points) {
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLng = Math.min(minLng, p.lng);
    maxLng = Math.max(maxLng, p.lng);
  }
  return { minLat, maxLat, minLng, maxLng };
}

/**
 * 把经纬度投影到 width×height 的画布（等距投影，按纬度修正经度比例），
 * 用于没有地图底图时画路线草图。
 */
export function projectToBox(
  points: LatLng[],
  width: number,
  height: number,
  padding = 16,
): { x: number; y: number }[] {
  const b = boundsOf(points);
  if (!b) return [];
  const midLat = toRad((b.minLat + b.maxLat) / 2);
  const kx = Math.cos(midLat);
  const spanX = Math.max((b.maxLng - b.minLng) * kx, 1e-9);
  const spanY = Math.max(b.maxLat - b.minLat, 1e-9);
  const w = width - padding * 2;
  const h = height - padding * 2;
  const scale = Math.min(w / spanX, h / spanY);
  const offX = padding + (w - spanX * scale) / 2;
  const offY = padding + (h - spanY * scale) / 2;
  return points.map((p) => ({
    x: offX + (p.lng - b.minLng) * kx * scale,
    y: offY + (b.maxLat - p.lat) * scale,
  }));
}

/** 抽稀：点太多时按步长取样，保留首尾 */
export function decimate<T>(points: T[], maxPoints: number): T[] {
  if (points.length <= maxPoints) return points;
  const step = (points.length - 1) / (maxPoints - 1);
  const out: T[] = [];
  for (let i = 0; i < maxPoints; i++) out.push(points[Math.round(i * step)]);
  return out;
}
