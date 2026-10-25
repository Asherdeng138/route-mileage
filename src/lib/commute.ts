import { matchPlace } from './geo';
import type { Place, Trip } from './types';

/**
 * HMRC：家 ↔ 固定办公室属于通勤，不能作为公务里程报销。
 * 根据起终点坐标或名称匹配常用地点判断。
 */
export function isLikelyCommute(trip: Trip, places: Place[]): boolean {
  const typeAt = (lat: number | null, lng: number | null, name: string | null) => {
    if (lat != null && lng != null) {
      const p = matchPlace({ lat, lng }, places);
      if (p) return p.type;
    }
    if (name) {
      const p = places.find((pl) => pl.name === name);
      if (p) return p.type;
    }
    return null;
  };
  const a = typeAt(trip.startLat, trip.startLng, trip.startName);
  const b = typeAt(trip.endLat, trip.endLng, trip.endName);
  return (a === 'home' && b === 'office') || (a === 'office' && b === 'home');
}
