/**
 * 起点 / 终点附近的地点（自动命名和「在地图上选择」共用）。
 *
 * 顺序：
 *  1. 常用地点（免费、离线）
 *  2. Google Places Nearby Search（启用、有 Key、本月未达上限时；每次查询计 1 次）
 *  3. OpenStreetMap Overpass（免费；Google 不可用、超限或出错时）
 *  4. 手机自带地址解析：给出这个位置的街道地址
 * 同一位置（约 30 米格子）在本次打开 App 期间只查一次，不长期缓存 Google 返回的内容。
 */
import Constants from 'expo-constants';
import * as Location from 'expo-location';

import { listPlaces } from '@/db/places';
import { mergeNearby, nearbyCacheKey, overpassQuery, parseOverpass, savedNearby, type NearbyPlace } from '@/lib/nearby';
import type { LatLng } from '@/lib/types';

import { googleNearby, type GoogleNearbyResult } from './google';

export interface NearbyResult {
  places: NearbyPlace[];
  /** 这个位置的街道地址（手机解析，可能为 null） */
  address: string | null;
  /** 本次是否用了 Google；未用时的原因，用来在界面上提示 */
  google: GoogleNearbyResult['status'];
  googleMessage?: string;
}

const SEARCH_RADIUS_M = 150;
const cache = new Map<string, NearbyResult>();

const UA = `RouteMileage/${Constants.expoConfig?.version ?? '1.0'} (Android; personal business-mileage log app)`;

async function overpassNearby(center: LatLng, radiusM: number): Promise<NearbyPlace[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
      body: `data=${encodeURIComponent(overpassQuery(center, radiusM))}`,
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    return parseOverpass(await res.json(), center);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function deviceAddress(p: LatLng): Promise<string | null> {
  try {
    const res = await Promise.race([
      Location.reverseGeocodeAsync({ latitude: p.lat, longitude: p.lng }),
      new Promise<null>((r) => setTimeout(() => r(null), 6000)),
    ]);
    const a = res?.[0];
    if (!a) return null;
    if (a.formattedAddress) return a.formattedAddress;
    const street = [a.streetNumber, a.street].filter(Boolean).join(' ');
    return [street, a.city ?? a.subregion, a.postalCode].filter(Boolean).join(', ') || null;
  } catch {
    return null;
  }
}

const inflight = new Map<string, Promise<NearbyResult>>();

/** 同一位置正在查询时直接复用，避免重复计费 */
export function findNearby(center: LatLng, opts: { useGoogle?: boolean; radiusM?: number } = {}): Promise<NearbyResult> {
  const key = `${nearbyCacheKey(center)}:${opts.useGoogle === false ? 'free' : 'any'}`;
  let p = inflight.get(key);
  if (!p) {
    p = lookup(center, opts).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

async function lookup(center: LatLng, opts: { useGoogle?: boolean; radiusM?: number }): Promise<NearbyResult> {
  const key = nearbyCacheKey(center);
  const hit = cache.get(key);
  if (hit && (hit.google === 'ok' || opts.useGoogle === false)) return hit;

  const radius = opts.radiusM ?? SEARCH_RADIUS_M;
  const saved = savedNearby(await listPlaces(), center, radius);
  const google: GoogleNearbyResult = opts.useGoogle === false ? { status: 'disabled', places: [] } : await googleNearby(center, radius);
  const osm = google.status === 'ok' ? [] : await overpassNearby(center, radius);
  const address = await deviceAddress(center);

  const result: NearbyResult = {
    places: mergeNearby([saved, google.places, osm]),
    address,
    google: google.status,
    googleMessage: google.status === 'error' ? google.message : undefined,
  };
  if (result.places.length || address) cache.set(key, result);
  return result;
}

/** 测试 / 切换 Key 后清空会话缓存 */
export const clearNearbyCache = () => cache.clear();
