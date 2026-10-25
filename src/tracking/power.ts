/**
 * 省电：停车时切到低功耗定位、停留提醒、自动结束（省电优化 #1、#2）。
 * 由后台定位任务（task.ts）每收到一批点调用一次；状态只保存在内存里（进程重启后重新判断）。
 */
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { AndroidImportance } from 'expo-notifications';
import { AppState } from 'react-native';

import { initialStillState, updateStillness, type PowerMode, type StillAction, type StillState } from '@/lib/stillness';
import type { TrackPoint } from '@/lib/types';

import { LOCATION_TASK, locationOptions } from './locationOptions';

let still: StillState = initialStillState();
let stillTripId: number | null = null;
/** 最近一次收到原始定位的时间：停车时的点会被里程过滤掉、不入库，记录页用它判断定位是否正常 */
let lastFixTs = 0;

export function resetPowerState(tripId: number | null = null) {
  still = initialStillState();
  stillTripId = tripId;
}

export const currentPowerMode = (): PowerMode => still.mode;
export const lastRawFixTs = (): number => lastFixTs;

/**
 * 切换定位模式。App 在前台时带上前台服务参数（同时更新通知设置）；
 * 在后台时不带（安卓不允许后台启动前台服务，已运行的服务不受影响），这需要「始终允许」定位权限，
 * 没有该权限时保持原模式（不省电，但也不影响记录）。
 */
export async function applyPowerMode(mode: PowerMode): Promise<boolean> {
  const foreground = AppState.currentState === 'active';
  try {
    if (!foreground) {
      const bg = await Location.getBackgroundPermissionsAsync();
      if (bg.status !== 'granted') return false;
    }
    await Location.startLocationUpdatesAsync(LOCATION_TASK, locationOptions(mode, foreground));
    return true;
  } catch (e) {
    console.warn('[route] power mode switch failed', mode, (e as Error).message);
    return false;
  }
}

const CHANNEL = 'trip-status';
let channelReady = false;

// App 开着时也弹出停留提醒 / 自动结束通知（默认前台不显示）
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

async function notify(title: string, body: string) {
  try {
    if (!channelReady) {
      await Notifications.setNotificationChannelAsync(CHANNEL, {
        name: '行程状态',
        importance: AndroidImportance.DEFAULT,
      });
      channelReady = true;
    }
    await Notifications.scheduleNotificationAsync({ content: { title, body }, trigger: { channelId: CHANNEL } });
  } catch (e) {
    console.warn('[route] notification failed', (e as Error).message);
  }
}

export interface PowerOutcome {
  autoEnd: { endTime: number } | null;
}

/** 后台任务每批点调用：更新停车状态，执行切换模式 / 提醒；需要自动结束时返回结束时间，由调用方结束行程 */
export async function onLocationBatch(tripId: number, fixes: TrackPoint[], autoEndMin: number): Promise<PowerOutcome> {
  if (stillTripId !== tripId) resetPowerState(tripId);
  for (const f of fixes) lastFixTs = Math.max(lastFixTs, f.ts);
  const { state, actions } = updateStillness(still, fixes, autoEndMin);
  still = state;
  let autoEnd: PowerOutcome['autoEnd'] = null;
  for (const a of actions as StillAction[]) {
    if (a.type === 'to-low' || a.type === 'to-high') {
      const ok = await applyPowerMode(a.type === 'to-low' ? 'low' : 'high');
      if (!ok) still = { ...still, mode: a.type === 'to-low' ? 'high' : still.mode };
    } else if (a.type === 'remind') {
      await notify(
        '看起来已经到达',
        autoEndMin > 0
          ? `已停留 ${a.stillMin} 分钟。到达后请在 App 里结束记录；停留满 ${autoEndMin} 分钟会自动结束并保存。`
          : `已停留 ${a.stillMin} 分钟。到达后请在 App 里结束记录。`,
      );
    } else if (a.type === 'auto-end') {
      autoEnd = { endTime: a.endTime };
    }
  }
  return { autoEnd };
}

export async function notifyAutoEnded(miles: string, minutes: number) {
  await notify('行程已自动结束', `停留 ${minutes} 分钟以上，已自动结束并保存（${miles}）。请打开 App 确认起点和终点。`);
}
