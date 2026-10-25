import { billingMonth, quotaState, type QuotaState } from '@/lib/googleQuota';

import { getDb, write } from './core';

export type GoogleApi = 'places.nearby' | 'routes.compute';

/** 每类接口单独计数（各自的免费额度不同）：places.* 与 routes.* */
const family = (api: GoogleApi) => `${api.split('.')[0]}.%`;

/**
 * 预约一次 Google 调用：本月同类接口的次数未到上限才计数并返回 true。
 * 在写队列的事务里完成「检查 + 计数」，并发调用也不会超过上限。
 */
export function reserveGoogleCall(api: GoogleApi, limit: number, now = new Date()): Promise<boolean> {
  const month = billingMonth(now);
  return write(async (db) => {
    const row = await db.getFirstAsync<{ n: number }>(
      'SELECT COALESCE(SUM(count), 0) AS n FROM api_usage WHERE month = ? AND api LIKE ?',
      [month, family(api)],
    );
    if ((row?.n ?? 0) >= limit) return false;
    await db.runAsync(
      `INSERT INTO api_usage (month, api, count) VALUES (?, ?, 1)
       ON CONFLICT(month, api) DO UPDATE SET count = count + 1`,
      [month, api],
    );
    return true;
  });
}

export async function googleUsage(limit: number, now = new Date(), api: GoogleApi = 'places.nearby'): Promise<QuotaState & { month: string }> {
  const month = billingMonth(now);
  const row = await getDb().getFirstAsync<{ n: number }>(
    'SELECT COALESCE(SUM(count), 0) AS n FROM api_usage WHERE month = ? AND api LIKE ?',
    [month, family(api)],
  );
  return { month, ...quotaState(row?.n ?? 0, limit) };
}
