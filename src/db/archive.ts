/**
 * 归档、最近删除、自动永久删除（规则见 src/lib/archive.ts）。
 * 这里只改数据库；永久删除时要删的图片文件由调用方处理（src/services/archive.ts），便于在 Node 中测试。
 */
import { ARCHIVE_DAYS, DAY_MS, keepsLedgerStub, TRASH_DAYS } from '@/lib/archive';

import { getDb, write, type SqlValue } from './core';

const marks = (ids: number[]) => ids.map(() => '?').join(',');

/** 归档已报销的行程；未报销、仍在记录、已删除的会被跳过。返回实际归档的条数 */
export function archiveTrips(ids: number[], now = Date.now()): Promise<number> {
  if (!ids.length) return Promise.resolve(0);
  return write(async (db) => {
    const r = await db.runAsync(
      `UPDATE trips SET archived_at = ?, updated_at = ?
       WHERE id IN (${marks(ids)}) AND claimed_at IS NOT NULL AND status = 'completed'
         AND archived_at IS NULL AND deleted_at IS NULL AND purged_at IS NULL`,
      [now, now, ...ids],
    );
    return r.changes;
  });
}

export function unarchiveTrips(ids: number[], now = Date.now()): Promise<void> {
  if (!ids.length) return Promise.resolve();
  return write(async (db) => {
    await db.runAsync(
      `UPDATE trips SET archived_at = NULL, updated_at = ? WHERE id IN (${marks(ids)}) AND deleted_at IS NULL AND purged_at IS NULL`,
      [now, ...ids],
    );
  });
}

/** 用户删除行程：移到「最近删除」，30 天内可以恢复 */
export function trashTrips(ids: number[], now = Date.now()): Promise<void> {
  if (!ids.length) return Promise.resolve();
  return write(async (db) => {
    await db.runAsync(
      `UPDATE trips SET deleted_at = ?, updated_at = ? WHERE id IN (${marks(ids)}) AND status = 'completed' AND deleted_at IS NULL`,
      [now, now, ...ids],
    );
  });
}

/** 从「最近删除」恢复：回到行程列表（不再是归档状态，需要时可以重新归档） */
export function restoreTrips(ids: number[], now = Date.now()): Promise<void> {
  if (!ids.length) return Promise.resolve();
  return write(async (db) => {
    await db.runAsync(
      `UPDATE trips SET deleted_at = NULL, archived_at = NULL, updated_at = ? WHERE id IN (${marks(ids)}) AND purged_at IS NULL`,
      [now, ...ids],
    );
  });
}

export interface MaintenanceResult {
  /** 归档满 30 天、移到「最近删除」的行程数 */
  trashed: number;
  /** 永久删除的行程数（含只保留里程记录的） */
  purged: number;
  /** 需要删除的图片文件（截图、路线图） */
  files: string[];
}

/**
 * 每次打开 App 时执行：归档满 30 天 → 最近删除；最近删除满 30 天 → 永久删除。
 * 移到「最近删除」的时间记为执行这一步的时间，保证无论多久没打开 App，都有完整 30 天可以恢复。
 */
export function runArchiveMaintenance(now = Date.now()): Promise<MaintenanceResult> {
  return write(async (db) => {
    const moved = await db.runAsync(
      `UPDATE trips SET deleted_at = ?, updated_at = ?
       WHERE archived_at IS NOT NULL AND archived_at <= ? AND deleted_at IS NULL AND purged_at IS NULL`,
      [now, now, now - ARCHIVE_DAYS * DAY_MS],
    );

    const due = await db.getAllAsync<{ id: number; category: string; claimed_at: number | null; map_image: string | null; route_map: string | null }>(
      `SELECT id, category, claimed_at, map_image, route_map FROM trips
       WHERE deleted_at IS NOT NULL AND deleted_at <= ? AND purged_at IS NULL`,
      [now - TRASH_DAYS * DAY_MS],
    );
    const files: string[] = [];
    for (const t of due) {
      if (t.map_image) files.push(t.map_image);
      if (t.route_map) files.push(t.route_map);
    }
    const stub = (t: (typeof due)[number]) => keepsLedgerStub({ category: t.category === 'business' ? 'business' : 'personal', claimedAt: t.claimed_at });
    const stubs = due.filter(stub).map((t) => t.id);
    const gone = due.filter((t) => !stub(t)).map((t) => t.id);
    const all = due.map((t) => t.id);

    // 分批，避免 SQL 参数过多
    for (let i = 0; i < all.length; i += 200) {
      const chunk = all.slice(i, i + 200);
      await db.runAsync(`DELETE FROM track_points WHERE trip_id IN (${marks(chunk)})`, chunk);
      await db.runAsync(`DELETE FROM trip_gaps WHERE trip_id IN (${marks(chunk)})`, chunk);
    }
    for (let i = 0; i < gone.length; i += 200) {
      const chunk = gone.slice(i, i + 200);
      await db.runAsync(`DELETE FROM trips WHERE id IN (${marks(chunk)})`, chunk);
    }
    for (let i = 0; i < stubs.length; i += 200) {
      const chunk = stubs.slice(i, i + 200);
      const params: SqlValue[] = [now, now, ...chunk];
      // 只留下日期、时间、里程、分类、报销状态：年度累计需要；地点、事由、图片全部清除
      await db.runAsync(
        `UPDATE trips SET purged_at = ?, updated_at = ?,
           start_name = NULL, start_address = NULL, start_lat = NULL, start_lng = NULL,
           end_name = NULL, end_address = NULL, end_lat = NULL, end_lng = NULL,
           purpose = NULL, client = NULL, notes = NULL, via = NULL, report_desc = NULL,
           map_image = NULL, map_image_w = NULL, map_image_h = NULL,
           route_map = NULL, route_map_w = NULL, route_map_h = NULL, route_map_status = 'none',
           geocode_status = 'ok'
         WHERE id IN (${marks(chunk)})`,
        params,
      );
    }
    return { trashed: moved.changes, purged: due.length, files };
  });
}

/** 各状态的行程数（设置页 / 行程页入口显示） */
export async function archiveCounts(): Promise<{ archived: number; trash: number }> {
  const r = await getDb().getFirstAsync<{ archived: number; trash: number }>(
    `SELECT
       SUM(CASE WHEN archived_at IS NOT NULL AND deleted_at IS NULL AND purged_at IS NULL THEN 1 ELSE 0 END) AS archived,
       SUM(CASE WHEN deleted_at IS NOT NULL AND purged_at IS NULL THEN 1 ELSE 0 END) AS trash
     FROM trips`,
  );
  return { archived: r?.archived ?? 0, trash: r?.trash ?? 0 };
}
