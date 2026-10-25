import type { ClaimSnapshot } from '@/lib/claim';
import type { MonthMiles } from '@/lib/rates';

import { getDb, write } from './core';

export type ClaimStatus = 'exported' | 'claimed';

export interface ClaimRecord {
  id: number;
  month: string;
  status: ClaimStatus;
  createdAt: number;
  confirmedAt: number | null;
  tripIds: number[];
  totalTenths: number;
  totalPence: number;
  snapshot: ClaimSnapshot;
}

interface ClaimRow {
  id: number;
  month: string;
  status: string;
  created_at: number;
  confirmed_at: number | null;
  trip_ids: string;
  total_tenths: number;
  total_pence: number;
  snapshot: string;
}

const toClaim = (r: ClaimRow): ClaimRecord => ({
  id: r.id,
  month: r.month,
  status: r.status === 'claimed' ? 'claimed' : 'exported',
  createdAt: r.created_at,
  confirmedAt: r.confirmed_at,
  tripIds: JSON.parse(r.trip_ids) as number[],
  totalTenths: r.total_tenths,
  totalPence: r.total_pence,
  snapshot: JSON.parse(r.snapshot) as ClaimSnapshot,
});

/** 保存导出快照（状态 exported：已生成文件，但还没有确认报销） */
export function saveClaimSnapshot(s: ClaimSnapshot): Promise<number> {
  return write(async (db) => {
    const res = await db.runAsync(
      `INSERT INTO claims (month, status, created_at, trip_ids, total_tenths, total_pence, snapshot)
       VALUES (?, 'exported', ?, ?, ?, ?, ?)`,
      [s.month, Date.now(), JSON.stringify(s.trips.map((t) => t.tripId)), s.monthTenths, s.monthPence, JSON.stringify(s)],
    );
    return res.lastInsertRowId;
  });
}

/** 用户确认已报销：快照锁定，快照内的行程标记为已报销 */
export function confirmClaim(claimId: number): Promise<void> {
  return write(async (db) => {
    const row = await db.getFirstAsync<ClaimRow>('SELECT * FROM claims WHERE id = ?', [claimId]);
    if (!row) throw new Error('找不到这次导出记录');
    const ids = JSON.parse(row.trip_ids) as number[];
    const now = Date.now();
    await db.runAsync(`UPDATE claims SET status = 'claimed', confirmed_at = ? WHERE id = ?`, [now, claimId]);
    if (ids.length) {
      await db.runAsync(
        `UPDATE trips SET claimed_at = ?, claim_id = ?, updated_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`,
        [now, claimId, now, ...ids],
      );
    }
  });
}

/** 撤销确认：快照记录保留（状态回到 exported），行程取消已报销 */
export function revokeClaim(claimId: number): Promise<void> {
  return write(async (db) => {
    await db.runAsync(`UPDATE claims SET status = 'exported', confirmed_at = NULL WHERE id = ?`, [claimId]);
    // 已归档的行程一并取消归档；已永久删除的行程只剩里程记录，保持已报销（否则年度累计会变少）
    await db.runAsync(
      `UPDATE trips SET claimed_at = NULL, claim_id = NULL, archived_at = NULL, updated_at = ? WHERE claim_id = ? AND purged_at IS NULL`,
      [Date.now(), claimId],
    );
  });
}

export async function listClaims(month?: string): Promise<ClaimRecord[]> {
  const rows = month
    ? await getDb().getAllAsync<ClaimRow>('SELECT * FROM claims WHERE month = ? ORDER BY id DESC', [month])
    : await getDb().getAllAsync<ClaimRow>('SELECT * FROM claims ORDER BY id DESC LIMIT 50');
  return rows.map(toClaim);
}

export async function getClaim(id: number): Promise<ClaimRecord | null> {
  const r = await getDb().getFirstAsync<ClaimRow>('SELECT * FROM claims WHERE id = ?', [id]);
  return r ? toClaim(r) : null;
}

// ---------- 手工录入的往月里程 ----------

export async function listMonthMiles(): Promise<(MonthMiles & { note: string | null })[]> {
  return getDb().getAllAsync<MonthMiles & { note: string | null }>('SELECT month, tenths, note FROM month_miles ORDER BY month');
}

export function setMonthMiles(month: string, tenths: number | null, note: string | null = null): Promise<void> {
  return write(async (db) => {
    if (tenths == null) await db.runAsync('DELETE FROM month_miles WHERE month = ?', [month]);
    else
      await db.runAsync('INSERT OR REPLACE INTO month_miles (month, tenths, note, updated_at) VALUES (?, ?, ?, ?)', [
        month,
        tenths,
        note,
        Date.now(),
      ]);
  });
}
