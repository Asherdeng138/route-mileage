import type { DistanceUnit } from './types';

export const M_PER_MILE = 1609.344;
export const M_PER_KM = 1000;

export const unitLabel = (u: DistanceUnit) => (u === 'mi' ? '英里' : '公里');
export const unitShort = (u: DistanceUnit) => (u === 'mi' ? 'mi' : 'km');

export const metersToMiles = (m: number) => m / M_PER_MILE;

export function metersToUnit(m: number, u: DistanceUnit): number {
  return u === 'mi' ? m / M_PER_MILE : m / M_PER_KM;
}

export function unitToMeters(v: number, u: DistanceUnit): number {
  return u === 'mi' ? v * M_PER_MILE : v * M_PER_KM;
}

/** 四舍五入到 0.1 */
export const round1 = (v: number) => Math.round(v * 10) / 10;

export function formatDistance(m: number, u: DistanceUnit, digits = 1): string {
  return `${metersToUnit(m, u).toFixed(digits)} ${unitShort(u)}`;
}

/** 便士 → "£12.34" */
export function formatPounds(pence: number): string {
  const pounds = Math.round(pence) / 100;
  return `£${pounds.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** 解析用户输入的数字（支持逗号小数点），无效返回 null */
export function parseNumber(text: string): number | null {
  const v = Number(text.trim().replace(',', '.'));
  return Number.isFinite(v) ? v : null;
}
