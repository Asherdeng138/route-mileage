import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildBackup, restoreBackup, validateBackup } from '../src/db/backupCore';
import { getDb } from '../src/db/core';
import { applyGapFill, filledGaps, listGaps, revertGapFill, saveGapSpans, setGapResult } from '../src/db/gaps';
import { appendPoints, createRecordingTrip, finishTrip, getPoints, getTrip, setClaimed, updateTrip } from '../src/db/trips';
import { chooseRoute, decodePolyline, extraMeters, findGaps, routeSegments, type RouteCandidate } from '../src/lib/gaps';
import type { TrackPoint } from '../src/lib/types';

import { freshDb } from './helpers/nodeDb';

const p = (lat: number, ts: number): TrackPoint => ({ lat, lng: -0.75, ts: ts * 1000, accuracy: 8, speed: 13 });
const route = (km: number, min: number, isDefault = false): RouteCandidate => ({
  distanceM: km * 1000,
  durationSec: min * 60,
  isDefault,
  path: [
    { lat: 51, lng: -0.75 },
    { lat: 51.01, lng: -0.75 },
  ],
});

test('gaps: only long-and-far gaps are filled', () => {
  const pts = [
    p(51.3, 0),
    p(51.301, 8), // 正常
    p(51.302, 120), // 断开 112 秒但只有约 111 米：不补（直线误差小，多半是停车 / 慢行）
    p(51.312, 200), // 断开 80 秒、约 1.1 km：补
    p(51.316, 230), // 30 秒：不补
  ];
  const gaps = findGaps(pts);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].startTs, 120_000);
  assert.equal(gaps[0].gapSec, 80);
  assert.ok(Math.abs(gaps[0].straightM - 1112) < 5);
});

test('gaps: picks the route whose drive time is closest to the time the signal was lost', () => {
  // 例子：断开 9 分钟，三条路线 7 / 9 / 13 分钟 → 选 9 分钟那条（13 分钟开不完）
  const choice = chooseRoute({ gapSec: 9 * 60, straightM: 5000 }, [route(6.6, 7, true), route(8.5, 9), route(10.9, 13)]);
  assert.equal(choice.kind, 'filled');
  assert.ok(choice.kind === 'filled' && choice.route.distanceM === 8500 && choice.reason === 'time-match');

  // 断开 15 分钟：三条都开得完，13 分钟那条最接近
  const longer = chooseRoute({ gapSec: 15 * 60, straightM: 5000 }, [route(6.6, 7, true), route(8.5, 9), route(10.9, 13)]);
  assert.ok(longer.kind === 'filled' && longer.route.distanceM === 10_900);
});

test('gaps: a much longer gap than any route means a stop on the way → use the recommended route, not the longest', () => {
  const c = chooseRoute({ gapSec: 40 * 60, straightM: 5000 }, [route(10.9, 13), route(6.6, 7, true), route(8.5, 9)]);
  assert.ok(c.kind === 'filled' && c.reason === 'stopped-default' && c.route.isDefault);
});

test('gaps: impossible routes are rejected and the trip is flagged for checking', () => {
  // 断开 60 秒却要开 20 km：任何路线都来不及
  assert.deepEqual(chooseRoute({ gapSec: 60, straightM: 1500 }, [route(20, 15, true)]), { kind: 'check', reason: 'too-fast' });
  assert.deepEqual(chooseRoute({ gapSec: 600, straightM: 1500 }, []), { kind: 'check', reason: 'no-route' });
  // 允许比 Google 预计开快一点（7 分钟路线、断开 6 分钟）
  assert.equal(chooseRoute({ gapSec: 360, straightM: 4000 }, [route(6, 7, true)]).kind, 'filled');
});

test('gaps: extra mileage is route minus the straight line already counted', () => {
  assert.equal(extraMeters([{ routeM: 8500, straightM: 5000 }, { routeM: 900, straightM: 1000 }]), 3500);
});

test('gaps: decodes Google encoded polylines', () => {
  // Google 文档示例
  const pts = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  assert.deepEqual(pts, [
    { lat: 38.5, lng: -120.2 },
    { lat: 40.7, lng: -120.95 },
    { lat: 43.252, lng: -126.453 },
  ]);
});

test('gaps: map segments break at filled gaps so no straight line is drawn there', () => {
  const pts = [p(51.3, 0), p(51.301, 8), p(51.312, 200), p(51.313, 208)];
  const fill = { startTs: 8000, endTs: 200_000, path: [{ lat: 51.301, lng: -0.75 }, { lat: 51.306, lng: -0.76 }, { lat: 51.312, lng: -0.75 }] };
  const seg = routeSegments(pts, [fill]);
  assert.equal(seg.solid.length, 2);
  assert.deepEqual(seg.solid.map((s) => s.length), [2, 2]);
  assert.equal(seg.filled.length, 1);
  assert.deepEqual(routeSegments(pts, []).solid, [pts]);
});

// ---------- 数据库：补算计入里程、撤销、已报销锁定、备份 ----------

/** 行驶 → 信号中断 3 分钟（约 2.2 km 直线）→ 继续行驶 */
async function tripWithGap() {
  freshDb();
  const { id } = await createRecordingTrip('2026-10-20', 0);
  const drive = (lat0: number, t0: number, n: number) =>
    Array.from({ length: n }, (_, i) => ({ lat: lat0 + i * 0.0006, lng: -0.75, ts: (t0 + i * 5) * 1000, accuracy: 8, speed: 14 }));
  await appendPoints(id, [...drive(51.3, 0, 20), ...drive(51.3114 + 0.02, 95 + 180, 20)]);
  await finishTrip(id, 600_000);
  return id;
}

test('gaps db: filled gaps add (route − straight) to the claimed mileage; revert restores GPS mileage', async () => {
  const id = await tripWithGap();
  const pts = await getPoints(id);
  const gaps = findGaps(pts);
  assert.equal(gaps.length, 1);
  await saveGapSpans(id, gaps);
  await saveGapSpans(id, gaps); // 重复保存不会重复
  const [row] = await listGaps(id);
  assert.equal((await listGaps(id)).length, 1);
  assert.equal((await getTrip(id))?.gapFillStatus, 'pending');

  const before = (await getTrip(id))!;
  await setGapResult(row.id, { status: 'filled', routeM: row.straightM + 1500, routeS: 170, path: [gaps[0].from, { lat: 51.32, lng: -0.76 }, gaps[0].to], reason: 'time-match' });
  assert.equal(Math.round(await applyGapFill(id)), 1500);
  const after = (await getTrip(id))!;
  assert.equal(after.gapFillStatus, 'done');
  assert.ok(Math.abs(after.distanceM - (before.distanceGpsM + 1500)) < 0.01);
  assert.equal(after.distanceGpsM, before.distanceGpsM); // GPS 实测不变
  assert.equal((await filledGaps(id))[0].path.length, 3);

  await revertGapFill(id);
  const reverted = (await getTrip(id))!;
  assert.equal(reverted.gapFillStatus, 'off');
  assert.equal(reverted.distanceM, reverted.distanceGpsM);
  assert.equal(await applyGapFill(id), 0); // 撤销后自动补算不再生效
  assert.ok(Math.abs((await applyGapFill(id, { force: true })) - 1500) < 0.01); // 用户手动「重新补算」
});

test('gaps db: manual distance edits and claimed trips are never changed', async () => {
  const id = await tripWithGap();
  await saveGapSpans(id, findGaps(await getPoints(id)));
  const [row] = await listGaps(id);
  await setGapResult(row.id, { status: 'filled', routeM: row.straightM + 1000, routeS: 170 });

  await updateTrip(id, { distanceM: 12_345, distanceEdited: true });
  await applyGapFill(id);
  assert.equal((await getTrip(id))?.distanceM, 12_345);
  assert.ok(Math.abs(((await getTrip(id))?.gapFillM ?? 0) - 1000) < 0.01);

  const id2 = await tripWithGap();
  await saveGapSpans(id2, findGaps(await getPoints(id2)));
  const [r2] = await listGaps(id2);
  await setGapResult(r2.id, { status: 'filled', routeM: r2.straightM + 1000, routeS: 170 });
  await setClaimed([id2], true);
  const locked = (await getTrip(id2))!;
  await applyGapFill(id2);
  await revertGapFill(id2);
  assert.equal((await getTrip(id2))?.distanceM, locked.distanceM);
});

test('gaps db: unfillable gaps keep the straight line; backup keeps gap rows', async () => {
  const id = await tripWithGap();
  await saveGapSpans(id, findGaps(await getPoints(id)));
  const [row] = await listGaps(id);
  await setGapResult(row.id, { status: 'check', reason: 'too-fast' });
  assert.equal(await applyGapFill(id), 0);
  const t = (await getTrip(id))!;
  assert.equal(t.gapFillStatus, 'done');
  assert.equal(t.distanceM, t.distanceGpsM);

  const backup = await buildBackup(getDb());
  assert.equal(backup.counts.trip_gaps, 1);
  freshDb();
  const v = validateBackup(JSON.parse(JSON.stringify(backup)));
  assert.ok(v.ok);
  await restoreBackup(v.data, 'replace');
  assert.equal((await listGaps(id))[0].status, 'check');
});
