import { DEFAULT_GOOGLE_MONTHLY_LIMIT } from '@/lib/googleQuota';
import { DEFAULT_AUTO_END_MIN } from '@/lib/trackingConfig';
import type { AppSettings } from '@/lib/types';

import { getDb, write } from './core';

export const DEFAULT_SETTINGS: AppSettings = {
  unit: 'mi',
  employeeName: '',
  companyName: '',
  yearBasis: 'tax',
  groupSameRoutes: true,
  embedTrackPreview: true,
  onlineMaps: true,
  googleEnabled: true,
  googleMonthlyLimit: DEFAULT_GOOGLE_MONTHLY_LIMIT,
  autoEndMinutes: DEFAULT_AUTO_END_MIN,
  gapFill: true,
  mapProvider: 'google',
};

export async function getAppSettings(): Promise<AppSettings> {
  const rows = await getDb().getAllAsync<{ key: string; value: string }>('SELECT key, value FROM settings');
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const bool = (k: keyof AppSettings, d: boolean) => (map.has(k) ? map.get(k) === 'true' : d);
  return {
    unit: map.get('unit') === 'km' ? 'km' : 'mi',
    employeeName: map.get('employeeName') ?? '',
    companyName: map.get('companyName') ?? '',
    yearBasis: map.get('yearBasis') === 'calendar' ? 'calendar' : 'tax',
    groupSameRoutes: bool('groupSameRoutes', DEFAULT_SETTINGS.groupSameRoutes),
    embedTrackPreview: bool('embedTrackPreview', DEFAULT_SETTINGS.embedTrackPreview),
    onlineMaps: bool('onlineMaps', DEFAULT_SETTINGS.onlineMaps),
    googleEnabled: bool('googleEnabled', DEFAULT_SETTINGS.googleEnabled),
    googleMonthlyLimit: (() => {
      const v = Number(map.get('googleMonthlyLimit'));
      return map.has('googleMonthlyLimit') && Number.isFinite(v) && v >= 0 ? Math.floor(v) : DEFAULT_SETTINGS.googleMonthlyLimit;
    })(),
    autoEndMinutes: (() => {
      const v = Number(map.get('autoEndMinutes'));
      return map.has('autoEndMinutes') && Number.isFinite(v) && v >= 0 ? Math.floor(v) : DEFAULT_SETTINGS.autoEndMinutes;
    })(),
    mapProvider: map.get('mapProvider') === 'osm' ? 'osm' : 'google',
    gapFill: bool('gapFill', DEFAULT_SETTINGS.gapFill),
  };
}

export function saveAppSettings(patch: Partial<AppSettings>): Promise<void> {
  return write(async (db) => {
    for (const [k, v] of Object.entries(patch)) {
      await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [k, String(v)]);
    }
  });
}
