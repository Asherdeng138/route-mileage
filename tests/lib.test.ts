import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  addMonths,
  formatDateLong,
  monthRange,
  taxYearLabel,
  taxYearRange,
  taxYearStartYear,
} from '../src/lib/dates';
import { acceptPoint, filterPoints, haversineM, matchPlace, projectToBox } from '../src/lib/geo';
import type { Place, TrackPoint } from '../src/lib/types';
import { formatPounds, metersToUnit, parseNumber } from '../src/lib/units';

test('haversine: London Charing Cross → Brighton Palace Pier ≈ 75 km', () => {
  const d = haversineM({ lat: 51.5073, lng: -0.1276 }, { lat: 50.8164, lng: -0.1367 });
  assert.ok(Math.abs(d - 76_850) < 1500, `got ${d}`);
});

test('acceptPoint filters inaccurate, jittery and jumping points', () => {
  const p0: TrackPoint = { lat: 51.5, lng: -0.1, ts: 0, accuracy: 5, speed: null };
  assert.equal(acceptPoint(null, { ...p0, accuracy: 80 }).reason, 'accuracy');
  assert.equal(acceptPoint(null, p0).accept, true);
  // 5 米外 → 太近
  assert.equal(acceptPoint(p0, { ...p0, lat: 51.500045, ts: 5000 }).reason, 'too-close');
  // 5 秒跳 1.1 公里 → 跳点
  assert.equal(acceptPoint(p0, { ...p0, lat: 51.51, ts: 5000 }).reason, 'jump');
  // 5 秒 111 米（约 50 mph）→ 接受
  const r = acceptPoint(p0, { ...p0, lat: 51.501, ts: 5000 });
  assert.equal(r.accept, true);
  assert.ok(Math.abs(r.stepM - 111) < 2);
  // 长时间断信号后恢复 → 不做速度检查
  assert.equal(acceptPoint(p0, { ...p0, lat: 51.52, ts: 300_000 }).accept, true);
});

test('filterPoints accumulates distance along a straight drive', () => {
  const pts: TrackPoint[] = Array.from({ length: 11 }, (_, i) => ({
    lat: 51.5 + i * 0.001,
    lng: -0.1,
    ts: i * 5000,
    accuracy: 8,
    speed: 20,
  }));
  const { accepted, addedM } = filterPoints(null, pts);
  assert.equal(accepted.length, 11);
  assert.ok(Math.abs(addedM - 1112) < 5, `got ${addedM}`);
});

test('matchPlace picks nearest place within radius', () => {
  const places: Place[] = [
    { id: 1, name: '家', address: null, lat: 51.5, lng: -0.1, radiusM: 150, type: 'home' },
    { id: 2, name: '客户', address: null, lat: 51.6, lng: -0.1, radiusM: 150, type: 'client' },
  ];
  assert.equal(matchPlace({ lat: 51.5005, lng: -0.1 }, places)?.id, 1);
  assert.equal(matchPlace({ lat: 51.55, lng: -0.1 }, places), null);
});

test('projectToBox keeps points inside the box', () => {
  const xy = projectToBox(
    [
      { lat: 51.5, lng: -0.2 },
      { lat: 51.6, lng: 0 },
    ],
    300,
    200,
    10,
  );
  for (const p of xy) {
    assert.ok(p.x >= 10 && p.x <= 290 && p.y >= 10 && p.y <= 190, JSON.stringify(p));
  }
});

test('tax year boundaries (6 April)', () => {
  assert.equal(taxYearStartYear('2026-04-05'), 2025);
  assert.equal(taxYearStartYear('2026-04-06'), 2026);
  assert.equal(taxYearStartYear('2027-01-15'), 2026);
  assert.deepEqual(taxYearRange('2026-10-17'), ['2026-04-06', '2027-04-05']);
  assert.equal(taxYearLabel('2026-10-17'), '2026/27');
});

test('month helpers', () => {
  assert.equal(addMonths('2026-01', -1), '2025-12');
  assert.equal(addMonths('2026-12', 1), '2027-01');
  assert.deepEqual(monthRange('2028-02'), ['2028-02-01', '2028-02-29']);
  assert.equal(formatDateLong('2026-10-17'), '2026年10月17日 周六');
});

test('units and formatting', () => {
  assert.equal(metersToUnit(1609.344, 'mi'), 1);
  assert.equal(formatPounds(123456), '£1,234.56');
  assert.equal(parseNumber('12,5'), 12.5);
  assert.equal(parseNumber('abc'), null);
});

test('track quality: dense track has no gaps; a 5-minute GPS outage is reported as a straight segment', async () => {
  const { trackQuality } = await import('../src/lib/trackQuality');
  const pts: TrackPoint[] = Array.from({ length: 60 }, (_, i) => ({ lat: 51.3 + i * 0.0005, lng: -0.75, ts: i * 5000, accuracy: 8, speed: 12 }));
  const dense = trackQuality(pts);
  assert.equal(dense.gaps.length, 0);
  assert.equal(Math.round(dense.avgIntervalSec!), 5);
  const withGap = [...pts.slice(0, 30), ...pts.slice(30).map((p) => ({ ...p, ts: p.ts + 300_000, lat: p.lat + 0.02 }))];
  const q = trackQuality(withGap);
  assert.equal(q.gaps.length, 1);
  assert.ok(q.gaps[0].seconds > 300);
  assert.ok(Math.abs(q.straightShare - 0.41) < 0.02, `share ${q.straightShare}`); // 2.2 km 断点 ÷ 全程约 5.3 km
});
