/**
 * Google Maps Platform 每月调用上限（App 端硬上限）。
 *
 * - 每个收费接口单独计数，上限 = Google 每月免费额度 × 0.7（留 30% 余量：同一个 Key 在别处的用量、
 *   计费月边界、偶发的重复请求都不会让账单超出免费额度）。
 * - **只有调用成功才计数**（收到 Google 的 2xx 响应，包括「附近没有地点」这种成功但为空的结果）；
 *   没有网络、超时、Key 错误、接口未启用等失败都不计数。
 * - 调用前先「占位」：本月成功次数 + 正在进行的调用 < 上限才允许发出，所以同时发出很多请求也不会超过上限；
 *   调用结束后成功则计数，失败则释放占位。
 * - 达到上限后本月不再调用 Google，自动改用免费来源（常用地点、OpenStreetMap、按直线计算）。
 * - Google 的免费额度按「太平洋时间」的自然月重置；这里用 UTC−8 计算月份，只会比 Google 晚重置、不会提前。
 *
 * 免费额度依据（developers.google.com/maps/billing-and-pricing/pricing，2026-10-26 核对）：
 *   Places API (New) Nearby Search Pro 每月 5,000 次（只请求 Pro 字段，见 src/lib/nearby.ts）；
 *   Routes API Compute Routes Essentials 每月 10,000 次（驾车、不考虑实时路况、无途经点，见 src/lib/gaps.ts）；
 *   Maps SDK（App 内原生地图）不限次数、免费，不需要计数。
 */

export const GOOGLE_APIS = {
  'places.nearby': { label: '附近地点识别', sku: 'Places API (New) · Nearby Search Pro', freePerMonth: 5000 },
  'routes.compute': { label: '信号中断补算', sku: 'Routes API · Compute Routes Essentials', freePerMonth: 10000 },
} as const;

export type GoogleApi = keyof typeof GOOGLE_APIS;

/** App 上限 = 免费额度 × 这个比例 */
export const FREE_TIER_SAFETY_RATIO = 0.7;

/** 某个接口的 App 端每月上限（免费额度 × 0.7，向下取整） */
export const appMonthlyLimit = (api: GoogleApi) => Math.floor(GOOGLE_APIS[api].freePerMonth * FREE_TIER_SAFETY_RATIO);

/** 附近地点的默认上限（设置里可以调低，不能高于 appMonthlyLimit） */
export const DEFAULT_GOOGLE_MONTHLY_LIMIT = appMonthlyLimit('places.nearby');

/** 用户设置的上限不能超过 免费额度 × 0.7 */
export const effectiveLimit = (api: GoogleApi, userLimit?: number) =>
  userLimit == null ? appMonthlyLimit(api) : Math.max(0, Math.min(Math.floor(userLimit), appMonthlyLimit(api)));

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
