import * as Location from 'expo-location';

import { matchPlace } from '@/lib/geo';
import { bestMatch } from '@/lib/nearby';
import type { LatLng, Place } from '@/lib/types';

import { findNearby } from './nearby';

export interface ResolvedPlace {
  name: string | null;
  address: string | null;
}

const GEOCODE_TIMEOUT_MS = 6000;
/** 自动命名：最近的有名字地点要在这个距离内，否则只填街道地址 */
const AUTO_NAME_MAX_M = 60;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

/**
 * 坐标 → 名称 / 地址（行程开始和结束时自动调用）。
 * 顺序：常用地点（离线）→ 附近地点（Google 限额内，否则 OpenStreetMap）→ 手机自带地址解析。
 * 全部失败（例如没有网络）返回 null：调用方保留坐标并标记「地址未解析」，之后可重试或手动选择。
 */
export async function resolvePlace(point: LatLng, places: Place[]): Promise<ResolvedPlace | null> {
  const saved = matchPlace(point, places);
  if (saved) return { name: saved.name, address: saved.address };

  const nearby = await findNearby(point).catch(() => null);
  if (nearby) {
    const best = bestMatch(nearby.places, AUTO_NAME_MAX_M);
    if (best) return { name: best.name, address: best.address ?? nearby.address };
    if (nearby.address) return { name: null, address: nearby.address };
  }
  return null;
}

/** 地址文本 → 坐标（手机自带地理编码，失败返回 null） */
export async function geocodeAddress(text: string): Promise<LatLng | null> {
  try {
    const res = await withTimeout(Location.geocodeAsync(text), GEOCODE_TIMEOUT_MS);
    return res?.[0] ? { lat: res[0].latitude, lng: res[0].longitude } : null;
  } catch {
    return null;
  }
}
