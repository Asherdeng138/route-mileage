import { yearKeyOf, type YearBasis } from './dates';
import { penceToCentiPence } from './money';

/** 一套分档费率：每个累计年度前 thresholdMiles 英里按 firstPence，超出部分按 afterPence */
export interface RateBands {
  firstPence: number;
  afterPence: number;
  thresholdMiles: number;
}

/** 费率版本：从 effectiveFrom（YYYY-MM-DD）起生效，直到下一个版本 */
export interface RateVersion extends RateBands {
  id: number;
  effectiveFrom: string;
  label: string;
  source: string | null;
}

/**
 * 公司报销费率（默认值）。依据 example 样板：Word 与 Excel 均写明
 * "First 10,000 miles paid at £0.45, mileage after 10,000 paid at £0.25 per mile"，
 * Excel 单元格公式为 =B3*0.45。
 */
export const COMPANY_TEMPLATE_RATE: Omit<RateVersion, 'id'> = {
  effectiveFrom: '2000-01-01',
  firstPence: 45,
  afterPence: 25,
  thresholdMiles: 10000,
  label: '公司费率（依据 example 报销样板）',
  source: 'example 样板：First 10,000 miles paid at £0.45, mileage after 10,000 paid at £0.25 per mile',
};

/**
 * HMRC 免税里程津贴（AMAP）参考标准——仅供参考，不是公司报销费率。
 * 来源：gov.uk「Travel – mileage and fuel rates and allowances」，
 * 表格 "Approved mileage rates from tax year 2026 to 2027"（页面更新于 2026-05-21），
 * 2026-10-21 核对。只覆盖汽车 / 厢式货车（Cars and vans）。
 */
export const HMRC_AMAP_CARS = {
  sourceUrl:
    'https://www.gov.uk/government/publications/rates-and-allowances-travel-mileage-and-fuel-allowances/travel-mileage-and-fuel-rates-and-allowances',
  checkedOn: '2026-10-21',
  periods: [
    { taxYears: '2011/12 – 2025/26', from: '2011-04-06', firstPence: 45, afterPence: 25, thresholdMiles: 10000 },
    { taxYears: '2026/27 起', from: '2026-04-06', firstPence: 55, afterPence: 25, thresholdMiles: 10000 },
  ],
} as const;

export function hmrcReferenceFor(date: string) {
  const ps = HMRC_AMAP_CARS.periods.filter((p) => p.from <= date);
  return ps.length ? ps[ps.length - 1] : null;
}

/** 行程日期适用的费率版本（生效日 ≤ 日期的最新一版）；没有任何版本时用公司样板费率 */
export function rateForDate(versions: RateVersion[], date: string): RateVersion {
  let best: RateVersion | null = null;
  for (const v of versions) {
    if (v.effectiveFrom <= date && (!best || v.effectiveFrom > best.effectiveFrom || (v.effectiveFrom === best.effectiveFrom && v.id > best.id))) {
      best = v;
    }
  }
  return best ?? { id: 0, ...COMPANY_TEMPLATE_RATE };
}

export interface BandSplit {
  /** 落在第一档的 0.1 英里数 */
  firstTenths: number;
  afterTenths: number;
}

/** 按累计年度内已有里程拆分两档（单位：0.1 英里整数） */
export function splitBands(tenths: number, cumulativeBeforeTenths: number, r: RateBands): BandSplit {
  const thresholdTenths = Math.round(r.thresholdMiles * 10);
  const left = Math.max(0, thresholdTenths - cumulativeBeforeTenths);
  const firstTenths = Math.min(tenths, left);
  return { firstTenths, afterTenths: tenths - firstTenths };
}

/** 精确金额（千分之一便士） */
export function amountMilliPence(split: BandSplit, r: RateBands): number {
  return split.firstTenths * penceToCentiPence(r.firstPence) + split.afterTenths * penceToCentiPence(r.afterPence);
}

export interface LedgerTrip {
  id: number;
  date: string;
  startTime: number | null;
  /** 报销里程（0.1 英里整数） */
  tenths: number;
}

/** 某月手工录入的里程（App 之前的月份），参与累计 */
export interface MonthMiles {
  month: string;
  tenths: number;
}

export interface TripAmount {
  tenths: number;
  /** 累计年度内此行程之前的里程（0.1 英里） */
  cumulativeBeforeTenths: number;
  split: BandSplit;
  rate: RateVersion;
  milliPence: number;
}

const byDateThenTime = (a: LedgerTrip, b: LedgerTrip) =>
  a.date.localeCompare(b.date) || (a.startTime ?? 0) - (b.startTime ?? 0) || a.id - b.id;

/**
 * 按累计年度计算每条公务行程的金额。
 * - trips 应包含所涉及累计年度内全部公务行程，否则累计会偏小。
 * - 某月有手工录入里程时，该月对累计的贡献以手工值为准（该月内的行程仍按顺序算金额）。
 */
export function computeLedger(
  trips: LedgerTrip[],
  manualMonths: MonthMiles[],
  versions: RateVersion[],
  basis: YearBasis,
): Map<number, TripAmount> {
  const result = new Map<number, TripAmount>();
  const manual = new Map(manualMonths.map((m) => [m.month, m.tenths]));
  const sorted = [...trips].sort(byDateThenTime);

  // 按「累计年度 → 月份」分组
  const months = new Map<string, LedgerTrip[]>();
  for (const t of sorted) {
    const key = t.date.slice(0, 7);
    const list = months.get(key);
    if (list) list.push(t);
    else months.set(key, [t]);
  }
  const allMonths = [...new Set([...months.keys(), ...manual.keys()])].sort();

  // 累计按「累计年度」分开；税年从 4 月 6 日开始，所以同一个 4 月的行程可能分属两个年度，按行程日期判断
  const cumulative = new Map<string, number>();
  for (const month of allMonths) {
    const m = manual.get(month);
    const pending = new Map<string, number>(); // 有手工值的月份：行程只在月内滚动，不计入年度累计
    for (const t of months.get(month) ?? []) {
      const yk = yearKeyOf(t.date, basis);
      const before = (cumulative.get(yk) ?? 0) + (m != null ? (pending.get(yk) ?? 0) : 0);
      const rate = rateForDate(versions, t.date);
      const split = splitBands(t.tenths, before, rate);
      result.set(t.id, {
        tenths: t.tenths,
        cumulativeBeforeTenths: before,
        split,
        rate,
        milliPence: amountMilliPence(split, rate),
      });
      if (m != null) pending.set(yk, (pending.get(yk) ?? 0) + t.tenths);
      else cumulative.set(yk, before + t.tenths);
    }
    if (m != null) {
      // 手工月份计入该月最后一天所在的累计年度
      const yk = yearKeyOf(monthEnd(month), basis);
      cumulative.set(yk, (cumulative.get(yk) ?? 0) + m);
    }
  }
  return result;
}

function monthEnd(month: string): string {
  const [y, mo] = month.split('-').map(Number);
  const last = new Date(y, mo, 0).getDate();
  return `${month}-${String(last).padStart(2, '0')}`;
}
