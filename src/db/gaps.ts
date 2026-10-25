/**
 * 信号中断补算的存储（规则见 src/lib/gaps.ts，查询 Google 见 src/services/gapFill.ts）。
 *
 * - 每段中断一行（trip_gaps）：pending 等查询；filled 已补算；check 没有合理路线（保持直线，提醒核对）；failed 查询失败。
 * - 行程的 gap_fill_m = 各段（路线 − 直线）之和，计入申报里程 distance_m（手动修正过里程的行程不改申报里程）。
 * - 已报销的行程不再改变里程（报销快照已锁定）。
 */
import type { LatLng } from '@/lib/types';
import type { TrackGapSpan } from '@/lib/gaps';
import { extraMeters } from '@/lib/gaps';

import { getDb, write } from './core';
import { toTrip, type TripRow } from './trips';

export type GapRowStatus = 'pending' | 'filled' | 'check' | 'failed';

export interface GapRow {
  id: number;
  tripId: number;
  startTs: number;
  endTs: number;
  straightM: number;
  status: GapRowStatus;
  routeM: number | null;
  routeS: number | null;
  path: LatLng[];
  reason: string | null;
}

interface Row {
  id: number;
  trip_id: number;
  start_ts: number;
  end_ts: number;
  straight_m: number;
  status: string;
  route_m: number | null;
  route_s: number | null;
  path: string | null;
  reason: string | null;
}

const STATUSES: GapRowStatus[] = ['pending', 'filled', 'check', 'failed'];

function parsePath(v: string | null): LatLng[] {
  if (!v) return [];
  try {
    const a = JSON.parse(v) as [number, number][];
    return Array.isArray(a) ? a.map(([lat, lng]) => ({ lat, lng })) : [];
  } catch {
    return [];
  }
}

const toGap = (r: Row): GapRow => ({
  id: r.id,
  tripId: r.trip_id,
  startTs: r.start_ts,
  endTs: r.end_ts,
  straightM: r.straight_m,
  status: STATUSES.includes(r.status as GapRowStatus) ? (r.status as GapRowStatus) : 'pending',
  routeM: r.route_m,
  routeS: r.route_s,
  path: parsePath(r.path),
  reason: r.reason,
});

export async function listGaps(tripId: number): Promise<GapRow[]> {
  const rows = await getDb().getAllAsync<Row>('SELECT * FROM trip_gaps WHERE trip_id = ? ORDER BY start_ts', [tripId]);
  return rows.map(toGap);
}

/** 记录这条行程需要补算的中断（已有的不重复）。没有中断时标记为 none */
export function saveGapSpans(tripId: number, gaps: TrackGapSpan[]): Promise<void> {
  return write(async (db) => {
    for (const g of gaps) {
      await db.runAsync(
        'INSERT OR IGNORE INTO trip_gaps (trip_id, start_ts, end_ts, straight_m, status) VALUES (?, ?, ?, ?, ?)',
        [tripId, g.startTs, g.endTs, g.straightM, 'pending'],
      );
    }
    const n = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM trip_gaps WHERE trip_id = ?', [tripId]);
    await db.runAsync(`UPDATE trips SET gap_fill_status = ? WHERE id = ? AND gap_fill_status != 'off'`, [
      (n?.n ?? 0) > 0 ? 'pending' : 'none',
      tripId,
    ]);
  });
}

export function setGapResult(
  id: number,
  r: { status: GapRowStatus; routeM?: number | null; routeS?: number | null; path?: LatLng[]; reason?: string | null },
): Promise<void> {
  return write(async (db) => {
    await db.runAsync('UPDATE trip_gaps SET status = ?, route_m = ?, route_s = ?, path = ?, reason = ? WHERE id = ?', [
      r.status,
      r.routeM ?? null,
      r.routeS ?? null,
      r.path?.length ? JSON.stringify(r.path.map((p) => [Math.round(p.lat * 1e5) / 1e5, Math.round(p.lng * 1e5) / 1e5])) : null,
      r.reason ?? null,
      id,
    ]);
  });
}

/**
 * 按已补算的路段更新行程里程和状态。用户撤销过（off）或已报销的行程不改。
 * 返回补算增加的米数。
 */
export function applyGapFill(tripId: number, opts: { force?: boolean } = {}): Promise<number> {
  return write(async (db) => {
    const trip = await db.getFirstAsync<TripRow>('SELECT * FROM trips WHERE id = ?', [tripId]);
    if (!trip || trip.claimed_at != null) return 0;
    if (trip.gap_fill_status === 'off' && !opts.force) return 0;
    const rows = (await db.getAllAsync<Row>('SELECT * FROM trip_gaps WHERE trip_id = ?', [tripId])).map(toGap);
    const filled = rows.filter((g) => g.status === 'filled' && g.routeM != null);
    const extra = extraMeters(filled.map((g) => ({ routeM: g.routeM!, straightM: g.straightM })));
    const status = !rows.length
      ? 'none'
      : rows.some((g) => g.status === 'pending')
        ? 'pending'
        : rows.some((g) => g.status === 'failed')
          ? 'failed'
          : 'done';
    await db.runAsync(
      `UPDATE trips SET gap_fill_m = ?, gap_fill_status = ?,
         distance_m = CASE WHEN distance_edited = 1 THEN distance_m ELSE distance_gps_m + ? END,
         updated_at = ?
       WHERE id = ?`,
      [extra, status, extra, Date.now(), tripId],
    );
    return extra;
  });
}

/** 撤销补算：里程回到 GPS 直线计算（已报销的行程不改） */
export function revertGapFill(tripId: number): Promise<void> {
  return write(async (db) => {
    await db.runAsync(
      `UPDATE trips SET gap_fill_m = 0, gap_fill_status = 'off',
         distance_m = CASE WHEN distance_edited = 1 THEN distance_m ELSE distance_gps_m END,
         updated_at = ?
       WHERE id = ? AND claimed_at IS NULL`,
      [Date.now(), tripId],
    );
  });
}

/** 还没补算完（等联网 / 上次失败）的行程，新的优先 */
export async function listPendingGapTrips(limit = 3) {
  const rows = await getDb().getAllAsync<TripRow>(
    `SELECT * FROM trips WHERE gap_fill_status IN ('pending', 'failed') AND status = 'completed' AND claimed_at IS NULL
       AND deleted_at IS NULL AND purged_at IS NULL ORDER BY id DESC LIMIT ?`,
    [limit],
  );
  return rows.map(toTrip);
}

/** 已补算路段的路线（地图画虚线用）。用户撤销补算后调用方不应再画 */
export async function filledGaps(tripId: number): Promise<{ startTs: number; endTs: number; path: LatLng[] }[]> {
  return (await listGaps(tripId)).filter((g) => g.status === 'filled' && g.path.length > 1).map((g) => ({ startTs: g.startTs, endTs: g.endTs, path: g.path }));
}
