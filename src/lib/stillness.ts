/**
 * 停车判定（纯函数，可测试）：根据原始定位点判断是否一直停在同一个地方，给出要做的动作：
 *  - to-low：停住超过 2 分钟 → 切到低功耗定位（省电优化 #2）
 *  - to-high：低功耗模式下检测到移动 → 切回高精度
 *  - remind：停住到提醒时间 → 发一次「是否已到达」通知（省电优化 #1）
 *  - auto-end：停住到自动结束时间 → 自动结束并保存，结束时间取开始停留的时刻
 * 与里程过滤（geo.ts）分开：这里只看「是否在移动」，不影响里程计算。
 */
import { haversineM } from './geo';
import { STILL } from './trackingConfig';
import type { LatLng, TrackPoint } from './types';

export type PowerMode = 'high' | 'low';

export interface StillState {
  /** 当前停留位置；离开它足够远才算移动 */
  anchor: LatLng | null;
  /** 开始停留的时间（毫秒） */
  stillSince: number | null;
  mode: PowerMode;
  reminded: boolean;
  ended: boolean;
}

export type StillAction =
  | { type: 'to-low' }
  | { type: 'to-high' }
  | { type: 'remind'; stillMin: number }
  | { type: 'auto-end'; endTime: number; anchor: LatLng };

export const initialStillState = (): StillState => ({ anchor: null, stillSince: null, mode: 'high', reminded: false, ended: false });

export function remindAfterMin(autoEndMin: number): number {
  return autoEndMin > 0 ? Math.min(STILL.remindAfterMin, Math.max(1, Math.floor(autoEndMin / 2))) : STILL.remindAfterMin;
}

/** autoEndMin = 0 表示不自动结束（仍会提醒一次） */
export function updateStillness(prev: StillState, fixes: TrackPoint[], autoEndMin: number): { state: StillState; actions: StillAction[] } {
  const state: StillState = { ...prev };
  const actions: StillAction[] = [];
  if (state.ended) return { state, actions };
  const sorted = [...fixes].sort((a, b) => a.ts - b.ts);

  for (const f of sorted) {
    if (!state.anchor || state.stillSince == null) {
      state.anchor = { lat: f.lat, lng: f.lng };
      state.stillSince = f.ts;
      continue;
    }
    const acc = f.accuracy ?? 0;
    const radius = state.mode === 'high' ? Math.max(STILL.moveRadiusM, acc) : Math.max(STILL.lowPowerMoveRadiusM, 2 * acc);
    const moving = haversineM(state.anchor, f) > radius || (f.speed ?? 0) > STILL.moveSpeedMps;
    if (moving) {
      state.anchor = { lat: f.lat, lng: f.lng };
      state.stillSince = f.ts;
      state.reminded = false;
      if (state.mode === 'low') {
        state.mode = 'high';
        actions.push({ type: 'to-high' });
      }
    }
  }

  const last = sorted[sorted.length - 1];
  if (!last || state.stillSince == null || !state.anchor) return { state, actions };
  const stillSec = (last.ts - state.stillSince) / 1000;

  if (state.mode === 'high' && stillSec >= STILL.lowPowerAfterSec) {
    state.mode = 'low';
    actions.push({ type: 'to-low' });
  }
  if (!state.reminded && stillSec >= remindAfterMin(autoEndMin) * 60) {
    state.reminded = true;
    actions.push({ type: 'remind', stillMin: Math.floor(stillSec / 60) });
  }
  if (autoEndMin > 0 && stillSec >= autoEndMin * 60) {
    state.ended = true;
    actions.push({ type: 'auto-end', endTime: state.stillSince, anchor: state.anchor });
  }
  return { state, actions };
}
