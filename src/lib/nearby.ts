/**
 * 「附近地点」：开始点 / 终点附近有名字的地方（门店、办公楼、机场…），用来自动填写或一键选择起终点。
 * 来源按优先级：常用地点（免费、离线）→ Google Places（每月限额内）→ OpenStreetMap（免费）→ 手机地址解析。
 * 本文件只做纯数据处理（解析、去重、排序），网络请求在 src/services/nearby.ts。
 */
import { haversineM } from './geo';
import type { LatLng, Place } from './types';

export type NearbySource = 'saved' | 'google' | 'osm' | 'address';

export interface NearbyPlace extends LatLng {
  key: string;
  name: string;
  address: string | null;
  /** 类型说明，例如 "Hardware store" / "shop: doityourself" */
  kind: string | null;
  distanceM: number;
  source: NearbySource;
}

// ---------- Google Places API (New) Nearby Search ----------

/** 只请求 Pro 级字段（不含评分、营业时间、电话等 Enterprise 字段），保持在每月 5,000 次免费额度的档位 */
export const GOOGLE_NEARBY_FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.shortFormattedAddress',
  'places.location',
  'places.primaryTypeDisplayName',
].join(',');

export function googleNearbyBody(center: LatLng, radiusM: number, max = 10) {
  return {
    maxResultCount: max,
    rankPreference: 'DISTANCE',
    languageCode: 'en',
    locationRestriction: { circle: { center: { latitude: center.lat, longitude: center.lng }, radius: radiusM } },
  };
}

interface GooglePlaceJson {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  shortFormattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  primaryTypeDisplayName?: { text?: string };
}

export function parseGoogleNearby(json: unknown, center: LatLng): NearbyPlace[] {
  const places = (json as { places?: GooglePlaceJson[] })?.places ?? [];
  const out: NearbyPlace[] = [];
  for (const p of places) {
    const name = p.displayName?.text?.trim();
    const lat = p.location?.latitude;
    const lng = p.location?.longitude;
    if (!name || lat == null || lng == null) continue;
    out.push({
      key: `google:${p.id ?? `${lat},${lng}`}`,
      name,
      address: p.shortFormattedAddress ?? p.formattedAddress ?? null,
      kind: p.primaryTypeDisplayName?.text ?? null,
      lat,
      lng,
      distanceM: haversineM(center, { lat, lng }),
      source: 'google',
    });
  }
  return out;
}

// ---------- OpenStreetMap（Overpass API） ----------

/** 附近有名字的门店 / 设施 / 办公楼等 */
export function overpassQuery(center: LatLng, radiusM: number): string {
  const around = `around:${Math.round(radiusM)},${center.lat.toFixed(6)},${center.lng.toFixed(6)}`;
  const keys = ['shop', 'amenity', 'office', 'tourism', 'leisure', 'aeroway', 'building', 'craft', 'healthcare'];
  const parts = keys.flatMap((k) => [`node(${around})["name"]["${k}"];`, `way(${around})["name"]["${k}"];`]);
  return `[out:json][timeout:10];(${parts.join('')});out center tags 40;`;
}

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

function osmAddress(t: Record<string, string>): string | null {
  const street = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
  const s = [street, t['addr:city'] ?? t['addr:town'], t['addr:postcode']].filter(Boolean).join(', ');
  return s || null;
}

export function parseOverpass(json: unknown, center: LatLng): NearbyPlace[] {
  const els = (json as { elements?: OverpassElement[] })?.elements ?? [];
  const out: NearbyPlace[] = [];
  for (const e of els) {
    const t = e.tags ?? {};
    const name = t.name?.trim();
    const lat = e.lat ?? e.center?.lat;
    const lng = e.lon ?? e.center?.lon;
    if (!name || lat == null || lng == null) continue;
    const kindKey = ['shop', 'amenity', 'office', 'tourism', 'leisure', 'aeroway', 'craft', 'healthcare', 'building'].find((k) => t[k]);
    out.push({
      key: `osm:${e.type}/${e.id}`,
      name,
      address: osmAddress(t),
      kind: kindKey ? `${kindKey}: ${t[kindKey]}` : null,
      lat,
      lng,
      distanceM: haversineM(center, { lat, lng }),
      source: 'osm',
    });
  }
  return out;
}

// ---------- 常用地点 ----------

export function savedNearby(places: Place[], center: LatLng, radiusM: number): NearbyPlace[] {
  const out: NearbyPlace[] = [];
  for (const p of places) {
    if (p.lat == null || p.lng == null) continue;
    const d = haversineM(center, { lat: p.lat, lng: p.lng });
    if (d > Math.max(radiusM, p.radiusM)) continue;
    out.push({ key: `saved:${p.id}`, name: p.name, address: p.address, kind: '常用地点', lat: p.lat, lng: p.lng, distanceM: d, source: 'saved' });
  }
  return out;
}

/** 合并：常用地点在最前，其余按距离；同名且相距 < 60 米的只保留一个 */
export function mergeNearby(lists: NearbyPlace[][], limit = 15): NearbyPlace[] {
  const all = lists.flat();
  const rank = (p: NearbyPlace) => (p.source === 'saved' ? 0 : 1);
  all.sort((a, b) => rank(a) - rank(b) || a.distanceM - b.distanceM);
  const out: NearbyPlace[] = [];
  for (const p of all) {
    const dup = out.some((q) => q.name.toLowerCase() === p.name.toLowerCase() && haversineM(p, q) < 60);
    if (!dup) out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}

/** 自动命名用：最近的一个地点，距离不超过 maxM */
export function bestMatch(list: NearbyPlace[], maxM: number): NearbyPlace | null {
  const saved = list.find((p) => p.source === 'saved' && p.distanceM <= maxM * 3);
  if (saved) return saved;
  const near = list.filter((p) => p.distanceM <= maxM).sort((a, b) => a.distanceM - b.distanceM);
  return near[0] ?? null;
}

/** 坐标取整到约 30 米格子，用作会话内缓存键（不长期保存 Google 内容） */
export const nearbyCacheKey = (p: LatLng) => `${(p.lat * 3700).toFixed(0)}:${(p.lng * 2300).toFixed(0)}`;
