/**
 * Google Maps Platform 每月调用上限（App 端硬上限）。
 *
 * - 每次调用 Google 之前先「预约」一次：本月已用次数 < 上限才允许，并立即计数（失败的请求也算，偏保守）。
 * - 达到上限后本月不再调用 Google，自动改用免费来源（常用地点、OpenStreetMap、手机自带地址解析）。
 * - Google 的免费额度按「太平洋时间」的自然月重置；这里用 UTC−8 计算月份，只会比 Google 晚重置、不会提前。
 *
 * 价格依据（developers.google.com/maps/billing-and-pricing/pricing，2026-10-24 核对）：
 * Places API (New) Nearby Search Pro 每月免费 5,000 次，之后 $32 / 1000 次；
 * 只请求 Pro 字段（名称、地址、坐标、类型）。默认上限 1,000 次，远低于免费额度。
 */

export const DEFAULT_GOOGLE_MONTHLY_LIMIT = 1000;
/**
 * 信号中断补算（Routes API Compute Routes Essentials：每月免费 10,000 次，之后 $5 / 1000 次；
 * 只用基本功能：驾车、不考虑实时路况、无途经点）。每段中断查 1 次，上限 1,000 次。
 */
export const ROUTES_MONTHLY_LIMIT = 1000;
/** 达到上限的这个比例时提醒 */
export const GOOGLE_WARN_RATIO = 0.8;

/** 计费月份键（太平洋标准时间 UTC−8），例如 "2026-10" */
export function billingMonth(now: Date = new Date()): string {
  const shifted = new Date(now.getTime() - 8 * 3600 * 1000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface QuotaState {
  used: number;
  limit: number;
  remaining: number;
  exhausted: boolean;
  warning: boolean;
}

export function quotaState(used: number, limit: number): QuotaState {
  const lim = Math.max(0, Math.floor(limit));
  return {
    used,
    limit: lim,
    remaining: Math.max(0, lim - used),
    exhausted: used >= lim,
    warning: lim > 0 && used >= lim * GOOGLE_WARN_RATIO,
  };
}
