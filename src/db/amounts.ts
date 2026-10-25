import { yearRangeOf } from '@/lib/dates';
import { metersToTenths, milliPenceToPence } from '@/lib/money';
import { computeLedger, type TripAmount } from '@/lib/rates';
import type { AppSettings } from '@/lib/types';

import { listMonthMiles } from './claims';
import { listRateVersions } from './rates';
import { listBusinessTrips } from './trips';

async function ledgerFor(from: string, to: string, s: AppSettings) {
  const [yearStart] = yearRangeOf(from, s.yearBasis);
  const [trips, manual, versions] = await Promise.all([listBusinessTrips(yearStart, to), listMonthMiles(), listRateVersions()]);
  const amounts = computeLedger(
    trips.map((t) => ({ id: t.id, date: t.date, startTime: t.startTime, tenths: metersToTenths(t.distanceM) })),
    manual,
    versions,
    s.yearBasis,
  );
  return { trips, manual, amounts };
}

/**
 * 计算 [from, to] 区间内公务行程的金额。为保证 10,000 英里分档准确，
 * 会从区间所在累计年度的第一天开始，把全部公务行程和手工录入的往月里程一起算。
 */
export async function amountsForRange(from: string, to: string, s: AppSettings): Promise<Map<number, TripAmount>> {
  return (await ledgerFor(from, to, s)).amounts;
}

/** 累计年度内的公务里程（手工录入的月份以手工值为准）与 App 内行程金额 */
export async function yearTotals(date: string, s: AppSettings) {
  const [from, to] = yearRangeOf(date, s.yearBasis);
  const { trips, manual, amounts } = await ledgerFor(from, to, s);
  const manualInYear = manual.filter((m) => m.month >= from.slice(0, 7) && m.month <= to.slice(0, 7));
  const manualMonths = new Set(manualInYear.map((m) => m.month));
  let tenths = manualInYear.reduce((sum, m) => sum + m.tenths, 0);
  let milli = 0;
  for (const t of trips) {
    const a = amounts.get(t.id);
    if (!a) continue;
    milli += a.milliPence;
    if (!manualMonths.has(t.date.slice(0, 7))) tenths += a.tenths;
  }
  return {
    tenths,
    manualTenths: manualInYear.reduce((sum, m) => sum + m.tenths, 0),
    pence: milliPenceToPence(milli),
    count: trips.length,
  };
}
