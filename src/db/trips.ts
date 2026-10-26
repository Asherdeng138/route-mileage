import { filterPoints } from '@/lib/geo';
import type { Category, GapFillStatus, GeocodeStatus, RouteMapStatus, TrackPoint, Trip } from '@/lib/types';

import { getDb, write, type Db, type SqlValue } from './core';

export interface TripRow {
  id: number;
  date: string;
  start_time: number | null;
  end_time: number | null;
  start_name: string | null;
  start_address: string | null;
  start_lat: number | null;
  start_lng: number | null;
  end_name: string | null;
  end_address: string | null;
  end_lat: number | null;
  end_lng: number | null;
  distance_gps_m: number;
  distance_m: number;
  distance_edited: number;
  purpose: string | null;
  client: string | null;
  notes: string | null;
  category: string;
  source: string;
  status: string;
  round_trip: number;
  claimed_at: number | null;
  created_at: number;
  updated_at: number;
  one_way_m: number | null;
  via: string | null;
  report_desc: string | null;
  geocode_status: string | null;
  commute_confirmed: number | null;
  map_image: string | null;
  map_image_w: number | null;
  map_image_h: number | null;
  claim_id: number | null;
  route_map: string | null;
  route_map_w: number | null;
  route_map_h: number | null;
  route_map_status: string | null;
  archived_at?: number | null;
  deleted_at?: number | null;
  purged_at?: number | null;
  gap_fill_m?: number | null;
  gap_fill_status?: string | null;
}

function parseVia(v: string | null): string[] {
  if (!v) return [];
  try {
    const a = JSON.parse(v);
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
  } catch {
    return [];
  }
}

const GEOCODE: GeocodeStatus[] = ['ok', 'pending', 'failed'];
const ROUTE_MAP: RouteMapStatus[] = ['none', 'pending', 'ok', 'failed'];
const GAP_STATUS: GapFillStatus[] = ['none', 'pending', 'done', 'off', 'failed'];

export const toTrip = (r: TripRow): Trip => ({
  id: r.id,
  date: r.date,
  startTime: r.start_time,
  endTime: r.end_time,
  startName: r.start_name,
  startAddress: r.start_address,
  startLat: r.start_lat,
  startLng: r.start_lng,
  endName: r.end_name,
  endAddress: r.end_address,
  endLat: r.end_lat,
  endLng: r.end_lng,
  distanceGpsM: r.distance_gps_m,
  distanceM: r.distance_m,
  distanceEdited: !!r.distance_edited,
  purpose: r.purpose,
  client: r.client,
  notes: r.notes,
  category: r.category === 'personal' ? 'personal' : 'business',
  source: r.source === 'gps' ? 'gps' : 'manual',
  status: r.status === 'recording' ? 'recording' : 'completed',
  roundTrip: !!r.round_trip,
  oneWayM: r.one_way_m,
  via: parseVia(r.via),
  reportDesc: r.report_desc,
  geocodeStatus: GEOCODE.includes(r.geocode_status as GeocodeStatus) ? (r.geocode_status as GeocodeStatus) : 'ok',
  commuteConfirmed: !!r.commute_confirmed,
  mapImageUri: r.map_image,
  mapImageW: r.map_image_w,
  mapImageH: r.map_image_h,
  routeMapUri: r.route_map,
  routeMapW: r.route_map_w,
  routeMapH: r.route_map_h,
  routeMapStatus: ROUTE_MAP.includes(r.route_map_status as RouteMapStatus) ? (r.route_map_status as RouteMapStatus) : 'none',
  claimedAt: r.claimed_at,
  claimId: r.claim_id,
  archivedAt: r.archived_at ?? null,
  deletedAt: r.deleted_at ?? null,
  purgedAt: r.purged_at ?? null,
  gapFillM: r.gap_fill_m ?? 0,
  gapFillStatus: GAP_STATUS.includes(r.gap_fill_status as GapFillStatus) ? (r.gap_fill_status as GapFillStatus) : 'none',
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** 可编辑字段 → 数据库列 */
const COLUMN: Partial<Record<keyof Trip, string>> = {
  date: 'date',
  startTime: 'start_time',
  endTime: 'end_time',
  startName: 'start_name',
  startAddress: 'start_address',
  startLat: 'start_lat',
  startLng: 'start_lng',
  endName: 'end_name',
  endAddress: 'end_address',
  endLat: 'end_lat',
  endLng: 'end_lng',
  distanceM: 'distance_m',
  distanceEdited: 'distance_edited',
  purpose: 'purpose',
  client: 'client',
  notes: 'notes',
  category: 'category',
  roundTrip: 'round_trip',
  oneWayM: 'one_way_m',
  via: 'via',
  reportDesc: 'report_desc',
  geocodeStatus: 'geocode_status',
  commuteConfirmed: 'commute_confirmed',
  mapImageUri: 'map_image',
  mapImageW: 'map_image_w',
  mapImageH: 'map_image_h',
  routeMapUri: 'route_map',
  routeMapW: 'route_map_w',
  routeMapH: 'route_map_h',
  routeMapStatus: 'route_map_status',
};

const toSql = (v: unknown): SqlValue =>
  typeof v === 'boolean'
    ? v
      ? 1
      : 0
    : Array.isArray(v)
      ? JSON.stringify(v)
      : v === undefined
        ? null
        : (v as SqlValue);

export interface TripQuery {
  from?: string;
  to?: string;
  category?: Category;
  includeRecording?: boolean;
  limit?: number;
  /** active：行程列表（默认）；archived：已归档；trash：最近删除 */
  view?: TripView;
}

export type TripView = 'active' | 'archived' | 'trash';

const VIEW_WHERE: Record<TripView, string> = {
  active: 'archived_at IS NULL AND deleted_at IS NULL AND purged_at IS NULL',
  archived: 'archived_at IS NOT NULL AND deleted_at IS NULL AND purged_at IS NULL',
  trash: 'deleted_at IS NOT NULL AND purged_at IS NULL',
};

/**
 * 计入年度累计（10,000 英里分档）的公务行程：包括已归档、已删除但已报销、永久删除后留下的里程记录；
 * 不包括还没报销就被删除的行程。
 */
const LEDGER_WHERE = `category = 'business' AND status = 'completed' AND (deleted_at IS NULL OR claimed_at IS NOT NULL)`;

export async function listTrips(q: TripQuery = {}): Promise<Trip[]> {
  const where: string[] = [VIEW_WHERE[q.view ?? 'active']];
  const params: SqlValue[] = [];
  if (!q.includeRecording) where.push(`status = 'completed'`);
  if (q.from) {
    where.push('date >= ?');
    params.push(q.from);
  }
  if (q.to) {
    where.push('date <= ?');
    params.push(q.to);
  }
  if (q.category) {
    where.push('category = ?');
    params.push(q.category);
  }
  const sql = `SELECT * FROM trips WHERE ${where.join(' AND ')}
    ORDER BY date DESC, COALESCE(start_time, created_at) DESC, id DESC
    ${q.limit ? `LIMIT ${Math.floor(q.limit)}` : ''}`;
  const rows = await getDb().getAllAsync<TripRow>(sql, params);
  return rows.map(toTrip);
}

export async function getTrip(id: number): Promise<Trip | null> {
  const r = await getDb().getFirstAsync<TripRow>('SELECT * FROM trips WHERE id = ?', [id]);
  return r ? toTrip(r) : null;
}

export async function getActiveTrip(): Promise<Trip | null> {
  const r = await getDb().getFirstAsync<TripRow>(
    `SELECT * FROM trips WHERE status = 'recording' ORDER BY id DESC LIMIT 1`,
  );
  return r ? toTrip(r) : null;
}

/** 新建正在记录的行程；已有未结束的行程时直接返回它（避免重复启动） */
export function createRecordingTrip(date: string, now = Date.now()): Promise<{ id: number; existed: boolean }> {
  return write(async (db) => {
    const active = await db.getFirstAsync<{ id: number }>(`SELECT id FROM trips WHERE status = 'recording' LIMIT 1`);
    if (active) return { id: active.id, existed: true };
    const res = await db.runAsync(
      `INSERT INTO trips (date, start_time, source, status, category, geocode_status, created_at, updated_at)
       VALUES (?, ?, 'gps', 'recording', 'business', 'pending', ?, ?)`,
      [date, now, now, now],
    );
    return { id: res.lastInsertRowId, existed: false };
  });
}

export interface ManualTripInput {
  date: string;
  startName: string | null;
  startAddress: string | null;
  startLat?: number | null;
  startLng?: number | null;
  endName: string | null;
  endAddress: string | null;
  endLat?: number | null;
  endLng?: number | null;
  via?: string[];
  /** 单程里程（米）。往返时申报里程 = 单程 × 2 */
  oneWayM: number;
  roundTrip: boolean;
  purpose: string | null;
  client: string | null;
  notes: string | null;
  category: Category;
}

/** 手动补录的申报里程：只在这里乘 2，输入始终是单程 */
export const manualDistanceM = (oneWayM: number, roundTrip: boolean) => (roundTrip ? oneWayM * 2 : oneWayM);

export function createManualTrip(t: ManualTripInput): Promise<number> {
  const now = Date.now();
  return write(async (db) => {
    const res = await db.runAsync(
      `INSERT INTO trips (date, start_name, start_address, start_lat, start_lng,
         end_name, end_address, end_lat, end_lng, via, distance_gps_m, distance_m, distance_edited,
         one_way_m, round_trip, purpose, client, notes, category, source, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 1, ?, ?, ?, ?, ?, ?, 'manual', 'completed', ?, ?)`,
      [
        t.date,
        t.startName,
        t.startAddress,
        t.startLat ?? null,
        t.startLng ?? null,
        t.endName,
        t.endAddress,
        t.endLat ?? null,
        t.endLng ?? null,
        JSON.stringify(t.via ?? []),
        manualDistanceM(t.oneWayM, t.roundTrip),
        t.oneWayM,
        t.roundTrip ? 1 : 0,
        t.purpose,
        t.client,
        t.notes,
        t.category,
        now,
        now,
      ],
    );
    return res.lastInsertRowId;
  });
}

export function updateTrip(id: number, patch: Partial<Trip>): Promise<void> {
  const sets: string[] = [];
  const params: SqlValue[] = [];
  for (const [k, v] of Object.entries(patch)) {
    const col = COLUMN[k as keyof Trip];
    if (!col) continue;
    sets.push(`${col} = ?`);
    params.push(toSql(v));
  }
  if (!sets.length) return Promise.resolve();
  sets.push('updated_at = ?');
  params.push(Date.now(), id);
  return write(async (db) => {
    await db.runAsync(`UPDATE trips SET ${sets.join(', ')} WHERE id = ?`, params);
  });
}

/** 彻底删除（只用于放弃正在记录的行程；用户删除行程走「最近删除」，见 src/db/archive.ts） */
export function deleteTrip(id: number): Promise<void> {
  return write(async (db) => {
    await db.runAsync('DELETE FROM track_points WHERE trip_id = ?', [id]);
    await db.runAsync('DELETE FROM trip_gaps WHERE trip_id = ?', [id]);
    await db.runAsync('DELETE FROM trips WHERE id = ?', [id]);
  });
}

/** 标记 / 取消已报销。已报销的行程同时移到「归档」；取消已报销时回到行程列表和报表 */
export function setClaimed(ids: number[], claimed: boolean, claimId: number | null = null): Promise<void> {
  if (!ids.length) return Promise.resolve();
  const marks = ids.map(() => '?').join(',');
  const now = Date.now();
  return write(async (db) => {
    await db.runAsync(
      `UPDATE trips SET claimed_at = ?, claim_id = ?, updated_at = ?, archived_at = ${claimed ? 'COALESCE(archived_at, ?)' : 'NULL'}
       WHERE id IN (${marks})`,
      claimed ? [now, claimId, now, now, ...ids] : [null, null, now, ...ids],
    );
  });
}

// ---------- 轨迹点 ----------

interface PointRow {
  lat: number;
  lng: number;
  ts: number;
  accuracy: number | null;
  speed: number | null;
}

export async function getPoints(tripId: number): Promise<TrackPoint[]> {
  return getDb().getAllAsync<PointRow>(
    'SELECT lat, lng, ts, accuracy, speed FROM track_points WHERE trip_id = ? ORDER BY ts',
    [tripId],
  );
}

/** 增量读取：只取 ts 之后的新点（记录页刷新用，不再每次读全部轨迹） */
export async function getPointsSince(tripId: number, afterTs: number): Promise<TrackPoint[]> {
  return getDb().getAllAsync<PointRow>(
    'SELECT lat, lng, ts, accuracy, speed FROM track_points WHERE trip_id = ? AND ts > ? ORDER BY ts',
    [tripId, afterTs],
  );
}

export async function countPoints(tripId: number): Promise<number> {
  const r = await getDb().getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM track_points WHERE trip_id = ?', [tripId]);
  return r?.n ?? 0;
}

async function lastPoint(db: Db, tripId: number): Promise<PointRow | null> {
  return db.getFirstAsync<PointRow>(
    'SELECT lat, lng, ts, accuracy, speed FROM track_points WHERE trip_id = ? ORDER BY ts DESC LIMIT 1',
    [tripId],
  );
}

/**
 * 写入一批 GPS 点：过滤误差点后保存，并累加行程的 GPS 里程。
 * 只接受仍在记录中的行程——行程结束后迟到的定位回调会被丢弃，不会改动已保存的里程。
 * 返回实际写入的点数。
 */
export function appendPoints(tripId: number, incoming: TrackPoint[]): Promise<number> {
  if (!incoming.length) return Promise.resolve(0);
  return write(async (db) => {
    const trip = await db.getFirstAsync<{ status: string }>('SELECT status FROM trips WHERE id = ?', [tripId]);
    if (!trip || trip.status !== 'recording') return 0;
    const prev = await lastPoint(db, tripId);
    const fresh = prev ? incoming.filter((p) => p.ts > prev.ts) : incoming;
    const { accepted, addedM } = filterPoints(prev, fresh);
    if (!accepted.length) return 0;
    for (const p of accepted) {
      await db.runAsync(
        'INSERT INTO track_points (trip_id, lat, lng, ts, accuracy, speed) VALUES (?, ?, ?, ?, ?, ?)',
        [tripId, p.lat, p.lng, p.ts, p.accuracy, p.speed],
      );
    }
    const first = accepted[0];
    await db.runAsync(
      `UPDATE trips SET
         distance_gps_m = distance_gps_m + ?,
         distance_m = CASE WHEN distance_edited = 1 THEN distance_m ELSE distance_gps_m + ? + gap_fill_m END,
         start_lat = COALESCE(start_lat, ?),
         start_lng = COALESCE(start_lng, ?),
         updated_at = ?
       WHERE id = ?`,
      [addedM, addedM, first.lat, first.lng, Date.now(), tripId],
    );
    return accepted.length;
  });
}

/**
 * 结束记录：在写队列中把行程标记为完成，起终点坐标取自已保存的首末点。
 * 排在它之前的定位批次都已写入；之后到达的批次会因状态不是 recording 被丢弃。
 */
export function finishTrip(tripId: number, endTime = Date.now()): Promise<Trip | null> {
  return write(async (db) => {
    const row = await db.getFirstAsync<TripRow>('SELECT * FROM trips WHERE id = ?', [tripId]);
    if (!row) return null;
    if (row.status !== 'recording') return toTrip(row);
    const first = await db.getFirstAsync<PointRow>(
      'SELECT lat, lng, ts, accuracy, speed FROM track_points WHERE trip_id = ? ORDER BY ts LIMIT 1',
      [tripId],
    );
    const last = await lastPoint(db, tripId);
    await db.runAsync(
      `UPDATE trips SET status = 'completed', end_time = ?,
         start_lat = ?, start_lng = ?, end_lat = ?, end_lng = ?,
         geocode_status = 'pending',
         route_map_status = CASE WHEN (SELECT COUNT(*) FROM track_points WHERE trip_id = trips.id) >= 2 THEN 'pending' ELSE 'none' END,
         updated_at = ?
       WHERE id = ?`,
      [endTime, first?.lat ?? null, first?.lng ?? null, last?.lat ?? null, last?.lng ?? null, Date.now(), tripId],
    );
    const updated = await db.getFirstAsync<TripRow>('SELECT * FROM trips WHERE id = ?', [tripId]);
    return updated ? toTrip(updated) : null;
  });
}

/** 已结束但地址还没解析成功的 GPS 行程（网络恢复后重试） */
export async function listPendingGeocode(): Promise<Trip[]> {
  const rows = await getDb().getAllAsync<TripRow>(
    `SELECT * FROM trips WHERE status = 'completed' AND source = 'gps' AND geocode_status != 'ok'
       AND deleted_at IS NULL AND purged_at IS NULL ORDER BY id DESC LIMIT 20`,
  );
  return rows.map(toTrip);
}

/** 等待生成 / 生成失败的路线图（联网后补生成，新的优先，每次只取少量） */
export async function listPendingRouteMaps(limit = 5): Promise<Trip[]> {
  const rows = await getDb().getAllAsync<TripRow>(
    `SELECT * FROM trips WHERE status = 'completed' AND source = 'gps' AND route_map_status IN ('pending', 'failed')
       AND deleted_at IS NULL AND purged_at IS NULL ORDER BY id DESC LIMIT ?`,
    [limit],
  );
  return rows.map(toTrip);
}

/** 某段日期内计入年度累计的公务行程（含已归档 / 已报销后删除的，见 LEDGER_WHERE；只读行程表，不读轨迹） */
export async function listBusinessTrips(from: string, to: string): Promise<Trip[]> {
  const rows = await getDb().getAllAsync<TripRow>(
    `SELECT * FROM trips WHERE ${LEDGER_WHERE} AND date >= ? AND date <= ?
     ORDER BY date DESC, COALESCE(start_time, created_at) DESC, id DESC`,
    [from, to],
  );
  return rows.map(toTrip);
}

/** 历史上用过的事由 / 客户（用于快速填写） */
export async function recentValues(field: 'purpose' | 'client', limit = 8): Promise<string[]> {
  const rows = await getDb().getAllAsync<{ v: string }>(
    `SELECT ${field} AS v, MAX(updated_at) AS u FROM trips
     WHERE ${field} IS NOT NULL AND ${field} != '' GROUP BY ${field} ORDER BY u DESC LIMIT ?`,
    [limit],
  );
  return rows.map((r) => r.v);
}

/** 用过的途经点名称 */
export async function recentStops(limit = 12): Promise<string[]> {
  const rows = await getDb().getAllAsync<{ via: string }>(
    `SELECT via FROM trips WHERE via IS NOT NULL AND via != '[]' ORDER BY updated_at DESC LIMIT 50`,
  );
  const seen: string[] = [];
  for (const r of rows) for (const v of parseVia(r.via)) if (!seen.includes(v)) seen.push(v);
  return seen.slice(0, limit);
}
