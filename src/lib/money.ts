/**
 * 里程与金额的整数运算，避免浮点误差。
 *
 * 规则（Word、Excel、App 三处一致）：
 *  - 每条行程的报销里程先四舍五入到 0.1 英里（tenths，整数）。
 *  - 费率以「百分之一便士」整数保存（45p → 4500）。
 *  - 行程金额 = tenths × 费率 / 1000 便士，用「千分之一便士」整数（milliPence）精确表示，
 *    与 Excel 样板公式 `=B3*0.45` 的精确值相同，不在行内取整。
 *  - 月度合计金额 = 各行精确金额之和，只在最后四舍五入一次到便士（等同 Excel SUM 后按 £0.00 显示）。
 */
import { M_PER_MILE } from './units';

/** 英里 → 0.1 英里整数（四舍五入，容忍浮点尾差） */
export function milesToTenths(miles: number): number {
  if (!Number.isFinite(miles) || miles <= 0) return 0;
  return Math.round(miles * 10 + 1e-7);
}

export const metersToTenths = (m: number) => milesToTenths(m / M_PER_MILE);

export const tenthsToMiles = (t: number) => t / 10;

/** 0.1 英里整数 → "61.5" */
export const formatTenths = (t: number) => (t / 10).toFixed(1);

/** 便士（可带两位小数，如 45、42.5）→ 百分之一便士整数 */
export const penceToCentiPence = (p: number) => Math.round(p * 100);

/** 千分之一便士 → 便士（四舍五入，0.5 进位） */
export function milliPenceToPence(mp: number): number {
  return mp >= 0 ? Math.floor((mp + 500) / 1000) : -Math.floor((-mp + 500) / 1000);
}

/** 便士 → "£1,234.56" */
export function formatPence(pence: number): string {
  const neg = pence < 0;
  const abs = Math.abs(Math.round(pence));
  const pounds = Math.floor(abs / 100);
  const p = String(abs % 100).padStart(2, '0');
  return `${neg ? '-' : ''}£${pounds.toLocaleString('en-GB')}.${p}`;
}

/** 费率（便士）→ Excel 公式里的英镑系数文本："0.45" */
export function rateFactorText(pence: number): string {
  const s = (pence / 100).toFixed(4);
  return s.replace(/0+$/, '').replace(/\.$/, '');
}

/** 费率（便士）→ "£0.45" */
export function formatRatePounds(pence: number): string {
  const v = pence / 100;
  const digits = Math.round(pence * 100) % 100 === 0 ? 2 : 4;
  return `£${v.toFixed(digits).replace(/(\.\d\d\d*?)0+$/, '$1')}`;
}
