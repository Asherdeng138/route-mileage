/**
 * Google Maps Platform 接口。
 *
 * 已接入：Places API (New) Nearby Search —— 起点 / 终点附近有名字的地点（每月限额内）；
 * Routes API Compute Routes —— 信号中断两端之间的驾车路线（补算里程，每月限额内）。
 * 计费：只请求 Pro 级字段，见 src/lib/nearby.ts 的 GOOGLE_NEARBY_FIELD_MASK。
 * 每次调用前先在 src/db/apiUsage.ts 预约计数；本月达到上限就不再调用，由调用方改用免费来源。
 *
 * 地图底图、路线图、地址解析都不需要 Google（OpenStreetMap + 手机自带解析），不产生费用。
 */
import { callWithQuota, googleUsage } from '@/db/apiUsage';
import { getAppSettings } from '@/db/settings';
import { GOOGLE_ROUTES_FIELD_MASK, googleRoutesBody, parseGoogleRoutes, type RouteCandidate } from '@/lib/gaps';
import { appMonthlyLimit, effectiveLimit } from '@/lib/googleQuota';
import { googlePost } from '@/lib/googleHttp';
import { GOOGLE_NEARBY_FIELD_MASK, googleNearbyBody, parseGoogleNearby, type NearbyPlace } from '@/lib/nearby';
import type { LatLng } from '@/lib/types';

import { androidIdentityHeaders, currentGoogleKey, loadGoogleKey } from './config';

export { hasBuildTimeMapsKey, isGoogleConfigured, loadGoogleKey, maskKey, saveGoogleKey } from './config';

const TIMEOUT_MS = 8000;

export type GoogleNearbyResult =
  | { status: 'ok'; places: NearbyPlace[] }
  | { status: 'disabled' | 'no-key' | 'quota' | 'error' | 'offline'; places: []; message?: string };

/** 本月是否还能调用 Google 附近地点（不计数） */
export async function googleAvailable(): Promise<{ ok: boolean; reason?: 'disabled' | 'no-key' | 'quota' }> {
  const s = await getAppSettings();
  if (!s.googleEnabled) return { ok: false, reason: 'disabled' };
  if (!(await loadGoogleKey())) return { ok: false, reason: 'no-key' };
  const u = await googleUsage('places.nearby', effectiveLimit('places.nearby', s.googleMonthlyLimit));
  return u.exhausted ? { ok: false, reason: 'quota' } : { ok: true };
}

export async function googleNearby(center: LatLng, radiusM: number): Promise<GoogleNearbyResult> {
  const s = await getAppSettings();
  if (!s.googleEnabled) return { status: 'disabled', places: [] };
  const key = (await loadGoogleKey()) || currentGoogleKey();
  if (!key) return { status: 'no-key', places: [] };
  // 只有 Google 返回成功才计入本月次数（上限 = 免费额度 × 0.7，见 src/lib/googleQuota.ts）
  const r = await callWithQuota('places.nearby', effectiveLimit('places.nearby', s.googleMonthlyLimit), async () => {
    const res = await googlePost('https://places.googleapis.com/v1/places:searchNearby', {
      key,
      fieldMask: GOOGLE_NEARBY_FIELD_MASK,
      body: googleNearbyBody(center, radiusM),
      headers: androidIdentityHeaders(),
      timeoutMs: TIMEOUT_MS,
    });
    return { ok: res.ok, value: res };
  });
  if (r.status === 'quota') return { status: 'quota', places: [] };
  const res = r.value;
  if (res.offline) return { status: 'offline', places: [], message: res.message };
  if (!res.ok) return { status: 'error', places: [], message: res.message };
  return { status: 'ok', places: parseGoogleNearby(res.json, center) };
}

export type GoogleRoutesResult =
  | { status: 'ok'; routes: RouteCandidate[] }
  | { status: 'no-key' | 'quota' | 'error' | 'offline'; routes: []; message?: string };

/** 两点之间的驾车路线（含备选）。没有网络返回 offline（调用方下次再试），其他错误返回 error */
export async function googleRoutes(from: LatLng, to: LatLng): Promise<GoogleRoutesResult> {
  const key = (await loadGoogleKey()) || currentGoogleKey();
  if (!key) return { status: 'no-key', routes: [] };
  const r = await callWithQuota('routes.compute', appMonthlyLimit('routes.compute'), async () => {
    const res = await googlePost('https://routes.googleapis.com/directions/v2:computeRoutes', {
      key,
      fieldMask: GOOGLE_ROUTES_FIELD_MASK,
      body: googleRoutesBody(from, to),
      headers: androidIdentityHeaders(),
      timeoutMs: TIMEOUT_MS,
    });
    return { ok: res.ok, value: res };
  });
  if (r.status === 'quota') return { status: 'quota', routes: [] };
  const res = r.value;
  if (res.offline) return { status: 'offline', routes: [], message: res.message };
  if (!res.ok) return { status: 'error', routes: [], message: res.message };
  return { status: 'ok', routes: parseGoogleRoutes(res.json) };
}
