import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mockTrip } from '../scripts/generate-samples';
import { buildClaimSnapshot } from '../src/lib/claim';
import { yearKeyOf } from '../src/lib/dates';
import { acceptPoint, driftThresholdM, filterPoints, haversineM, pathDistanceM } from '../src/lib/geo';
import {
  formatPence,
  formatRatePounds,
  metersToTenths,
  milesToTenths,
  milliPenceToPence,
  rateFactorText,
} from '../src/lib/money';
import {
  amountMilliPence,
  COMPANY_TEMPLATE_RATE,
  computeLedger,
  hmrcReferenceFor,
  rateForDate,
  splitBands,
  type RateVersion,
} from '../src/lib/rates';
import type { TrackPoint } from '../src/lib/types';
import { M_PER_MILE } from '../src/lib/units';

const company: RateVersion = { id: 1, ...COMPANY_TEMPLATE_RATE };

test('mileage rounds to 0.1 mile half-up without float drift', () => {
  assert.equal(milesToTenths(61.5), 615);
  assert.equal(milesToTenths(61.45), 615); // 61.45*10 = 614.4999… in floating point
  assert.equal(milesToTenths(0.04), 0);
  assert.equal(milesToTenths(-3), 0);
  assert.equal(metersToTenths(61.5 * M_PER_MILE), 615);
  assert.equal(metersToTenths(67.1 * M_PER_MILE), 671);
});

test('money: exact milli-pence, single half-up rounding, display', () => {
  // 66.5 × 45p = 2992.5p 精确值；与 Excel =B3*0.45 的 29.925 相同
  const split = splitBands(665, 0, company);
  assert.equal(amountMilliPence(split, company), 2992500);
  assert.equal(milliPenceToPence(2992500), 2993); // £29.93（与 Excel £#,##0.00 显示一致）
  assert.equal(milliPenceToPence(2992499), 2992);
  assert.equal(formatPence(57888), '£578.88');
  assert.equal(formatPence(123456789), '£1,234,567.89');
  assert.equal(formatPence(5), '£0.05');
  assert.equal(rateFactorText(45), '0.45');
  assert.equal(rateFactorText(42.5), '0.425');
  assert.equal(formatRatePounds(45), '£0.45');
  assert.equal(formatRatePounds(25), '£0.25');
  assert.equal(formatRatePounds(42.5), '£0.425');
});

test('template September total: sum of exact amounts rounded once equals Excel display', () => {
  // example 样板 2026 年 9 月的 20 条里程
  const miles = [66.5, 51.5, 51.5, 56.3, 51.5, 68, 66.9, 51.5, 53.3, 64.7, 83.8, 68.3, 68.3, 53.6, 84.5, 75.9, 73.5, 68.6, 56.8, 61.1];
  const tenths = miles.map(milesToTenths);
  const total = tenths.reduce((a, b) => a + b, 0);
  const milli = tenths.reduce((s, t) => s + amountMilliPence(splitBands(t, 0, company), company), 0);
  assert.equal(total, 12761); // 样板 SUM(B3:B23) = 1276.1
  assert.equal(milliPenceToPence(milli), 57425); // 样板 SUM(C3:C23) = 574.245 → £574.25
});

test('bands split across the 10,000 mile threshold', () => {
  assert.deepEqual(splitBands(1000, 0, company), { firstTenths: 1000, afterTenths: 0 });
  assert.deepEqual(splitBands(1000, 99_500, company), { firstTenths: 500, afterTenths: 500 });
  assert.deepEqual(splitBands(1000, 120_000, company), { firstTenths: 0, afterTenths: 1000 });
  // 100 英里，其中 50 @45p + 50 @25p = 3500p
  assert.equal(milliPenceToPence(amountMilliPence(splitBands(1000, 99_500, company), company)), 3500);
});

test('rate versions apply by trip date; HMRC reference is separate', () => {
  const v2: RateVersion = { ...company, id: 2, effectiveFrom: '2027-01-01', firstPence: 50 };
  assert.equal(rateForDate([company, v2], '2026-12-31').firstPence, 45);
  assert.equal(rateForDate([company, v2], '2027-01-01').firstPence, 50);
  assert.equal(rateForDate([], '2026-01-01').firstPence, 45); // 无版本时用样板费率
  assert.equal(hmrcReferenceFor('2026-04-05')?.firstPence, 45);
  assert.equal(hmrcReferenceFor('2026-04-06')?.firstPence, 55);
});

test('ledger: tax year boundary resets cumulative; April splits by date', () => {
  const t = (id: number, date: string, miles: number) => ({ id, date, startTime: 0, tenths: milesToTenths(miles) });
  const ledger = computeLedger(
    [t(1, '2026-04-05', 9990), t(2, '2026-04-06', 9990), t(3, '2026-05-01', 20), t(4, '2026-04-04', 20)],
    [],
    [company],
    'tax',
  );
  assert.equal(ledger.get(4)?.cumulativeBeforeTenths, 0);
  assert.equal(ledger.get(1)?.cumulativeBeforeTenths, 200); // 4/4 的 20 英里在同一税年
  assert.equal(ledger.get(1)?.split.afterTenths, 100); // 20 + 9990 跨过 10,000：10 英里按第二档
  assert.equal(ledger.get(2)?.cumulativeBeforeTenths, 0); // 新税年重新累计
  assert.deepEqual(ledger.get(3)?.split, { firstTenths: 100, afterTenths: 100 });
  assert.equal(yearKeyOf('2026-04-05', 'tax'), 'tax-2025');
  assert.equal(yearKeyOf('2026-04-05', 'calendar'), 'cal-2026');
});

test('ledger: manual months count towards cumulative; exporting one month keeps earlier months', () => {
  const trips = [{ id: 1, date: '2026-10-02', startTime: 0, tenths: 1000 }];
  const ledger = computeLedger(trips, [{ month: '2026-07', tenths: 95_000 }, { month: '2026-09', tenths: 4_500 }], [company], 'tax');
  assert.equal(ledger.get(1)?.cumulativeBeforeTenths, 99_500);
  assert.deepEqual(ledger.get(1)?.split, { firstTenths: 500, afterTenths: 500 });
  // 3 月的手工值属于上一税年，不影响
  const other = computeLedger(trips, [{ month: '2026-03', tenths: 99_999 }], [company], 'tax');
  assert.equal(other.get(1)?.cumulativeBeforeTenths, 0);
  // 自然年口径：3 月计入
  const cal = computeLedger(trips, [{ month: '2026-03', tenths: 99_999 }], [company], 'calendar');
  assert.equal(cal.get(1)?.cumulativeBeforeTenths, 99_999);
});

test('snapshot: previous months, year total and tiered cost crossing the threshold', () => {
  const before = mockTrip({ date: '2026-09-10', miles: 9_900 });
  const a = mockTrip({ date: '2026-10-01', miles: 80 });
  const b = mockTrip({ date: '2026-10-02', miles: 50 });
  const s = buildClaimSnapshot({
    month: '2026-10',
    selected: [b, a],
    yearBusinessTrips: [before, a, b],
    manualMonths: [],
    rateVersions: [company],
    yearBasis: 'tax',
  });
  assert.deepEqual(s.trips.map((x) => x.date), ['2026-10-01', '2026-10-02']);
  assert.deepEqual(s.previousMonths, [{ month: '2026-09', tenths: 99_000, source: 'trips' }]);
  assert.equal(s.yearTenths, 99_000 + 1_300);
  // a：80 英里全部在第一档（累计 9,900 → 9,980）；b：20 @45p + 30 @25p
  assert.deepEqual([s.trips[1].firstTenths, s.trips[1].afterTenths], [200, 300]);
  assert.equal(s.monthPence, 80 * 45 + 20 * 45 + 30 * 25);
});

// ---------- GPS 过滤 ----------

function drive(opts: { n: number; stepM: number; noiseM: number; acc: number; seed: number; dtSec?: number }): { pts: TrackPoint[]; truthM: number } {
  let s = opts.seed;
  const rnd = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647 - 0.5;
  };
  const truth: { lat: number; lng: number }[] = [];
  let lat = 51.3;
  let lng = -0.75;
  let heading = 0.4;
  for (let i = 0; i < opts.n; i++) {
    heading += Math.sin(i / 15) * 0.12;
    lat += (Math.cos(heading) * opts.stepM) / 111_320;
    lng += (Math.sin(heading) * opts.stepM) / (111_320 * Math.cos((lat * Math.PI) / 180));
    truth.push({ lat, lng });
  }
  const pts = truth.map((p, i) => ({
    lat: p.lat + (rnd() * 2 * opts.noiseM) / 111_320,
    lng: p.lng + (rnd() * 2 * opts.noiseM) / 70_000,
    ts: i * (opts.dtSec ?? 5) * 1000,
    accuracy: opts.acc,
    speed: null,
  }));
  return { pts, truthM: pathDistanceM(truth) };
}

test('filter keeps normal driving distance (no over-filtering)', () => {
  // 约 48 km/h，5 秒一个点，GPS 噪声 ±4 米
  const { pts, truthM } = drive({ n: 600, stepM: 67, noiseM: 4, acc: 8, seed: 7 });
  const { addedM } = filterPoints(null, pts);
  const ratio = addedM / truthM;
  assert.ok(ratio > 0.97 && ratio < 1.03, `ratio ${ratio}`);
});

test('filter keeps slow traffic distance (points closer than the threshold are merged, not lost)', () => {
  // 拥堵：约 7 km/h，每 5 秒 10 米
  const { pts, truthM } = drive({ n: 400, stepM: 10, noiseM: 2, acc: 6, seed: 3 });
  const { addedM } = filterPoints(null, pts);
  const ratio = addedM / truthM;
  assert.ok(ratio > 0.93 && ratio < 1.05, `ratio ${ratio}`);
});

test('filter ignores stationary drift and jumps', () => {
  let s = 11;
  const rnd = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647 - 0.5;
  };
  // 停车 30 分钟，精度 25 米，位置在 ±12 米内漂移
  const parked: TrackPoint[] = Array.from({ length: 360 }, (_, i) => ({
    lat: 51.3 + (rnd() * 24) / 111_320,
    lng: -0.75 + (rnd() * 24) / 70_000,
    ts: i * 5000,
    accuracy: 25,
    speed: 0,
  }));
  const { addedM } = filterPoints(null, parked);
  assert.ok(addedM < 50, `drift added ${addedM} m`);
  // 有些设备不报告速度：靠「与上一有效点的平均速度」判断
  const noSpeed = filterPoints(null, parked.map((p) => ({ ...p, speed: null })));
  assert.ok(noSpeed.addedM < 100, `drift (no speed) added ${noSpeed.addedM} m`);
  assert.equal(driftThresholdM({ ...parked[0], accuracy: 25 }), 20);
  assert.equal(driftThresholdM({ ...parked[0], accuracy: 5 }), 15);
  assert.equal(driftThresholdM({ ...parked[0], accuracy: 49 }), 35);

  // 跳点：5 秒内跳出 2 公里，然后回到原路线
  const p0: TrackPoint = { lat: 51.3, lng: -0.75, ts: 0, accuracy: 8, speed: null };
  const jump: TrackPoint = { ...p0, lat: 51.318, ts: 5000 };
  assert.equal(acceptPoint(p0, jump).reason, 'jump');
  const back: TrackPoint = { ...p0, lat: 51.3006, ts: 10_000 };
  const r = filterPoints(p0, [jump, back]);
  assert.equal(r.accepted.length, 1);
  assert.ok(Math.abs(r.addedM - haversineM(p0, back)) < 0.01);
});
