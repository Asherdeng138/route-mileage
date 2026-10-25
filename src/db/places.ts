import type { Place, PlaceType } from '@/lib/types';

import { getDb, write } from './core';

interface PlaceRow {
  id: number;
  name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  radius_m: number;
  type: string;
}

const TYPES: PlaceType[] = ['home', 'office', 'client', 'other'];

const toPlace = (r: PlaceRow): Place => ({
  id: r.id,
  name: r.name,
  address: r.address,
  lat: r.lat,
  lng: r.lng,
  radiusM: r.radius_m,
  type: TYPES.includes(r.type as PlaceType) ? (r.type as PlaceType) : 'other',
});

export const PLACE_TYPE_LABEL: Record<PlaceType, string> = {
  home: '家',
  office: '固定办公室',
  client: '客户 / 门店',
  other: '其他',
};

export async function listPlaces(): Promise<Place[]> {
  const rows = await getDb().getAllAsync<PlaceRow>(
    `SELECT * FROM places ORDER BY CASE type WHEN 'home' THEN 0 WHEN 'office' THEN 1 ELSE 2 END, name`,
  );
  return rows.map(toPlace);
}

export async function getPlace(id: number): Promise<Place | null> {
  const r = await getDb().getFirstAsync<PlaceRow>('SELECT * FROM places WHERE id = ?', [id]);
  return r ? toPlace(r) : null;
}

export function savePlace(p: Omit<Place, 'id'> & { id?: number }): Promise<number> {
  return write(async (db) => {
    if (p.id) {
      await db.runAsync(
        'UPDATE places SET name = ?, address = ?, lat = ?, lng = ?, radius_m = ?, type = ? WHERE id = ?',
        [p.name, p.address, p.lat, p.lng, p.radiusM, p.type, p.id],
      );
      return p.id;
    }
    const res = await db.runAsync(
      'INSERT INTO places (name, address, lat, lng, radius_m, type) VALUES (?, ?, ?, ?, ?, ?)',
      [p.name, p.address, p.lat, p.lng, p.radiusM, p.type],
    );
    return res.lastInsertRowId;
  });
}

export function deletePlace(id: number): Promise<void> {
  return write(async (db) => {
    await db.runAsync('DELETE FROM places WHERE id = ?', [id]);
  });
}

/**
 * 预置地点：公司办公室 Hanshow（85 Uxbridge Rd, London W5 5TH，Ealing Cross 大楼）。
 * 坐标用 OpenStreetMap Nominatim 查得（2026-10-24），与邮编中心相距约 15 米。
 * 类型为「固定办公室」：直接「家 ↔ Hanshow」的行程会提示可能是通勤，由用户确认，不会自动删除或改类型。
 */
export const DEFAULT_PLACES: Omit<Place, 'id'>[] = [
  {
    name: 'Hanshow',
    address: '85 Uxbridge Rd, London W5 5TH',
    lat: 51.511794,
    lng: -0.311451,
    radiusM: 150,
    type: 'office',
  },
];

const SEEDED_KEY = 'defaultPlacesSeeded';

/**
 * 打开 App 时补上预置地点（同名地点已存在就不动）。用设置里的标记保证只补一次：
 * 用户自己删掉后不会再出现；用旧备份「覆盖」恢复后（标记随之被替换）会重新补上。
 */
export function ensureDefaultPlaces(): Promise<number> {
  return write(async (db) => {
    const flag = await db.getFirstAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', [SEEDED_KEY]);
    if (flag?.value === '1') return 0;
    let added = 0;
    for (const p of DEFAULT_PLACES) {
      const exists = await db.getFirstAsync<{ id: number }>('SELECT id FROM places WHERE lower(name) = lower(?)', [p.name]);
      if (exists) continue;
      await db.runAsync('INSERT INTO places (name, address, lat, lng, radius_m, type) VALUES (?, ?, ?, ?, ?, ?)', [
        p.name,
        p.address,
        p.lat,
        p.lng,
        p.radiusM,
        p.type,
      ]);
      added++;
    }
    await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [SEEDED_KEY, '1']);
    return added;
  });
}
