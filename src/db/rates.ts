import type { RateVersion } from '@/lib/rates';

import { getDb, write } from './core';

interface RateRow {
  id: number;
  effective_from: string;
  first_pence: number;
  after_pence: number;
  threshold_miles: number;
  label: string;
  source: string | null;
}

const toVersion = (r: RateRow): RateVersion => ({
  id: r.id,
  effectiveFrom: r.effective_from,
  firstPence: r.first_pence,
  afterPence: r.after_pence,
  thresholdMiles: r.threshold_miles,
  label: r.label,
  source: r.source,
});

export async function listRateVersions(): Promise<RateVersion[]> {
  const rows = await getDb().getAllAsync<RateRow>('SELECT * FROM rate_versions ORDER BY effective_from, id');
  return rows.map(toVersion);
}

/**
 * 新增费率版本（从 effectiveFrom 起生效）。旧版本保留，生效日之前的行程仍按旧费率计算；
 * 已确认报销的月份使用保存的快照，不受影响。
 */
export function addRateVersion(v: Omit<RateVersion, 'id'>): Promise<number> {
  return write(async (db) => {
    const res = await db.runAsync(
      `INSERT INTO rate_versions (effective_from, first_pence, after_pence, threshold_miles, label, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [v.effectiveFrom, v.firstPence, v.afterPence, v.thresholdMiles, v.label, v.source, Date.now()],
    );
    return res.lastInsertRowId;
  });
}

/** 删除费率版本（至少保留一个）。被已确认报销快照引用的版本也可以删，快照里保存了当时的费率 */
export function deleteRateVersion(id: number): Promise<void> {
  return write(async (db) => {
    const n = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM rate_versions');
    if ((n?.n ?? 0) <= 1) throw new Error('至少需要保留一个费率版本');
    await db.runAsync('DELETE FROM rate_versions WHERE id = ?', [id]);
  });
}
