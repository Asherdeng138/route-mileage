import { billingMonth, quotaState, type GoogleApi, type QuotaState } from '@/lib/googleQuota';

import { getDb, write } from './core';

export type { GoogleApi } from '@/lib/googleQuota';

/**
 * 正在进行中的调用（占位）。只存在内存里：App 被杀时占位自然消失，不会留下错误的计数。
 * 后台定位任务和界面在同一个 JS 运行环境里，共用这份状态。
 */
const inFlight = new Map<GoogleApi, number>();

export interface GoogleCallTicket {
  api: GoogleApi;
  /** 占位时的计费月份（调用跨过月底也记在发出时的月份） */
  month: string;
  done: boolean;
}

/**
 * 占一个位置：本月成功次数 + 进行中的调用 < 上限才允许，返回凭证；否则返回 null（本月已用完）。
 * 检查和占位在写队列里串行完成，同时发出很多请求也不会超过上限。
 */
export function reserveGoogleCall(api: GoogleApi, limit: number, now = new Date()): Promise<GoogleCallTicket | null> {
  const month = billingMonth(now);
  return write(async (db) => {
    const row = await db.getFirstAsync<{ n: number }>('SELECT COALESCE(SUM(count), 0) AS n FROM api_usage WHERE month = ? AND api = ?', [month, api]);
    if ((row?.n ?? 0) + (inFlight.get(api) ?? 0) >= limit) return null;
    inFlight.set(api, (inFlight.get(api) ?? 0) + 1);
    return { api, month, done: false };
  });
}

/** 调用结束：成功才计数，失败只释放占位。同一个凭证只处理一次 */
export async function finishGoogleCall(ticket: GoogleCallTicket, success: boolean): Promise<void> {
  if (ticket.done) return;
  ticket.done = true;
  const release = () => inFlight.set(ticket.api, Math.max(0, (inFlight.get(ticket.api) ?? 0) - 1));
  if (!success) {
    release();
    return;
  }
  // 计数和释放占位在同一步完成：中间不会出现「既不算进行中、也还没计数」的空档被别的调用钻空子
  await write(async (db) => {
    await db.runAsync(
      `INSERT INTO api_usage (month, api, count) VALUES (?, ?, 1)
       ON CONFLICT(month, api) DO UPDATE SET count = count + 1`,
      [ticket.month, ticket.api],
    );
    release();
  });
}

export type QuotaCallResult<T> = { status: 'quota' } | { status: 'done'; value: T };

/**
 * 在上限内调用一次 Google：先占位，执行 call，call 返回 ok=true（收到 2xx 响应）才计数；
 * call 抛错（没网、超时）或返回 ok=false（Key 错误、接口未启用…）都不计数。
 */
export async function callWithQuota<T>(
  api: GoogleApi,
  limit: number,
  call: () => Promise<{ ok: boolean; value: T }>,
  now = new Date(),
): Promise<QuotaCallResult<T>> {
  const ticket = await reserveGoogleCall(api, limit, now);
  if (!ticket) return { status: 'quota' };
  let ok = false;
  try {
    const r = await call();
    ok = r.ok;
    return { status: 'done', value: r.value };
  } finally {
    await finishGoogleCall(ticket, ok);
  }
}

/** 本月某个接口的成功调用次数 */
export async function googleUsage(api: GoogleApi, limit: number, now = new Date()): Promise<QuotaState & { month: string }> {
  const month = billingMonth(now);
  const row = await getDb().getFirstAsync<{ n: number }>(
    'SELECT COALESCE(SUM(count), 0) AS n FROM api_usage WHERE month = ? AND api = ?',
    [month, api],
  );
  return { month, ...quotaState(row?.n ?? 0, limit) };
}
