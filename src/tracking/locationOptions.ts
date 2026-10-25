/**
 * 定位任务名称和参数（task.ts、recorder.ts、power.ts 共用，单独放一个模块避免循环引用）。
 */
import * as Location from 'expo-location';
import type { LocationObject, LocationTaskOptions } from 'expo-location';

import { LOCATION_UPDATES, LOW_POWER_UPDATES } from '@/lib/trackingConfig';
import type { PowerMode } from '@/lib/stillness';
import type { TrackPoint } from '@/lib/types';

export const LOCATION_TASK = 'route-location-updates';

export const toTrackPoint = (l: LocationObject): TrackPoint => ({
  lat: l.coords.latitude,
  lng: l.coords.longitude,
  ts: l.timestamp,
  accuracy: l.coords.accuracy,
  speed: l.coords.speed,
});

export const FOREGROUND_SERVICE = {
  notificationTitle: '正在记录行程',
  notificationBody: '锁屏或切到导航时会继续记录。到达后停车太久会自动结束并保存。',
  notificationColor: '#007AFF',
  killServiceOnDestroy: false,
};

/**
 * high：行驶中，高精度 GPS；low：停车时，Wi-Fi / 基站定位（不开 GPS）。
 * withService：是否带前台服务参数。安卓只允许 App 在前台时启动 / 更新前台服务，
 * 后台切换模式时必须不带（已在运行的前台服务不受影响）。
 */
export function locationOptions(mode: PowerMode, withService: boolean): LocationTaskOptions {
  const p = mode === 'high' ? LOCATION_UPDATES : LOW_POWER_UPDATES;
  return {
    accuracy: mode === 'high' ? Location.Accuracy.High : Location.Accuracy.Balanced,
    timeInterval: p.timeIntervalMs,
    distanceInterval: p.distanceIntervalM,
    deferredUpdatesInterval: p.deferredUpdatesIntervalMs,
    pausesUpdatesAutomatically: false,
    ...(withService ? { foregroundService: FOREGROUND_SERVICE } : {}),
  };
}
