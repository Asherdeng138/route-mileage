import assert from 'node:assert/strict';
import { test } from 'node:test';

import { initialStillState, remindAfterMin, updateStillness, type StillAction, type StillState } from '../src/lib/stillness';
import type { TrackPoint } from '../src/lib/types';

const T0 = Date.UTC(2026, 9, 24, 8, 0, 0);
const HOME = { lat: 51.511794, lng: -0.311451 };

/** 在 HOME 附近停着：每 interval 秒一个点，带几米漂移 */
function parked(fromSec: number, toSec: number, intervalSec = 8, at = HOME): TrackPoint[] {
  const out: TrackPoint[] = [];
  for (let s = fromSec; s <= toSec; s += intervalSec) {
    const jitter = ((s * 7) % 11) - 5; // ±5 米左右
    out.push({ lat: at.lat + jitter * 0.000009, lng: at.lng, ts: T0 + s * 1000, accuracy: 10, speed: 0 });
  }
  return out;
}

/** 向北行驶：每 8 秒约 110 米（约 30 mph） */
function driving(fromSec: number, toSec: number, start = HOME): TrackPoint[] {
  const out: TrackPoint[] = [];
  for (let s = fromSec; s <= toSec; s += 8) {
    out.push({ lat: start.lat + ((s - fromSec) / 8) * 0.001, lng: start.lng, ts: T0 + s * 1000, accuracy: 8, speed: 13 });
  }
  return out;
}

/** 按 60 秒一批喂给判定（模拟后台批量回调），收集全部动作 */
function run(fixes: TrackPoint[], autoEndMin: number, state: StillState = initialStillState()) {
  const actions: StillAction[] = [];
  for (let i = 0; i < fixes.length; ) {
    const batchEnd = fixes[i].ts + 60_000;
    const batch: TrackPoint[] = [];
    while (i < fixes.length && fixes[i].ts < batchEnd) batch.push(fixes[i++]);
    const r = updateStillness(state, batch, autoEndMin);
    state = r.state;
    actions.push(...r.actions);
  }
  return { state, actions, types: actions.map((a) => a.type) };
}

test('stillness: driving never switches mode or reminds', () => {
  const { types, state } = run(driving(0, 1800), 20);
  assert.deepEqual(types, []);
  assert.equal(state.mode, 'high');
});

test('stillness: parked 2 min → low power; moving again → high accuracy', () => {
  const fixes = [...driving(0, 300), ...parked(308, 600, 8, { lat: HOME.lat + 0.0375, lng: HOME.lng })];
  const parkedRun = run(fixes, 20);
  assert.deepEqual(parkedRun.types, ['to-low']);
  assert.equal(parkedRun.state.mode, 'low');

  // 低功耗下 30 秒一个点、精度差一些，漂移 60 米以内不算移动
  const drift: TrackPoint = { lat: HOME.lat + 0.0375 + 0.0005, lng: HOME.lng, ts: T0 + 630_000, accuracy: 40, speed: null };
  const still = updateStillness(parkedRun.state, [drift], 20);
  assert.deepEqual(still.actions, []);

  const off = run(driving(660, 900, { lat: HOME.lat + 0.0375, lng: HOME.lng }), 20, still.state);
  assert.equal(off.types[0], 'to-high');
  assert.equal(off.state.mode, 'high');
});

test('stillness: reminder once at 10 min, auto-end at 20 min with end time = when the stop began', () => {
  const stopStart = 400;
  const fixes = [...driving(0, 392), ...parked(stopStart, stopStart + 25 * 60, 30)];
  const { actions, state } = run(fixes, 20);
  const types = actions.map((a) => a.type);
  assert.deepEqual(types, ['to-low', 'remind', 'auto-end']);
  const remind = actions.find((a) => a.type === 'remind');
  assert.ok(remind && remind.type === 'remind' && remind.stillMin >= 10 && remind.stillMin < 12);
  const end = actions.find((a) => a.type === 'auto-end');
  assert.ok(end && end.type === 'auto-end');
  // 第一个停车点之前的那个行驶点就是停住的位置（离停车点 < 40 米），所以停留从它开始算
  assert.ok(end.endTime <= T0 + stopStart * 1000 && end.endTime >= T0 + (stopStart - 8) * 1000, `endTime ${end.endTime - T0}`);
  assert.equal(state.ended, true);

  // 结束后不再产生动作
  assert.deepEqual(updateStillness(state, parked(stopStart + 1600, stopStart + 1700, 30), 20).actions, []);
});

test('stillness: auto-end off (0) still reminds once, never ends', () => {
  const { types } = run([...driving(0, 200), ...parked(208, 208 + 90 * 60, 30)], 0);
  assert.deepEqual(types, ['to-low', 'remind']);
});

test('stillness: a short stop (traffic light, 90 s) does nothing', () => {
  const { types } = run([...driving(0, 200), ...parked(208, 298), ...driving(306, 600, { lat: HOME.lat + 0.025, lng: HOME.lng })], 20);
  assert.deepEqual(types, []);
});

test('stillness: reminder resets after moving to the next stop', () => {
  const a = run([...driving(0, 200), ...parked(208, 208 + 12 * 60, 30)], 0);
  assert.deepEqual(a.types, ['to-low', 'remind']);
  const b = run([...driving(1000, 1300, { lat: HOME.lat + 0.03, lng: HOME.lng }), ...parked(1308, 1308 + 12 * 60, 30, { lat: HOME.lat + 0.07, lng: HOME.lng })], 0, a.state);
  assert.deepEqual(b.types, ['to-high', 'to-low', 'remind']);
});

test('stillness: reminder time follows a short auto-end setting', () => {
  assert.equal(remindAfterMin(20), 10);
  assert.equal(remindAfterMin(15), 7);
  assert.equal(remindAfterMin(60), 10);
  assert.equal(remindAfterMin(0), 10);
  assert.equal(remindAfterMin(1), 1);
});
