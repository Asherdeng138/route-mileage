/**
 * 后台定位任务。必须在 App 入口（index.js）的全局作用域里加载，
 * 这样 App 被系统放到后台甚至界面被关掉时，前台服务仍能把 GPS 点交给这里。
 * 每批点都在写队列中落库；行程已结束时迟到的点会被丢弃（见 appendPoints）。
 */
import type { LocationObject } from 'expo-location';
import * as TaskManager from 'expo-task-manager';

import { getAppSettings } from '@/db/settings';
import { appendPoints, getActiveTrip } from '@/db/trips';
import { formatDistance } from '@/lib/units';

import { LOCATION_TASK, toTrackPoint } from './locationOptions';
import { notifyAutoEnded, onLocationBatch } from './power';
import { autoEndTrip } from './recorder';

export { LOCATION_TASK, toTrackPoint } from './locationOptions';

if (!TaskManager.isTaskDefined(LOCATION_TASK)) {
  TaskManager.defineTask<{ locations: LocationObject[] }>(LOCATION_TASK, async ({ data, error }) => {
    if (error) {
      console.warn('[route] location task error', error.message);
      return;
    }
    const locations = data?.locations ?? [];
    if (!locations.length) return;
    try {
      const trip = await getActiveTrip();
      if (!trip) return;
      const fixes = locations.map(toTrackPoint);
      await appendPoints(trip.id, fixes);
      // 停车判定：切换低功耗 / 停留提醒 / 自动结束（省电优化 #1、#2）
      const settings = await getAppSettings();
      const { autoEnd } = await onLocationBatch(trip.id, fixes, settings.autoEndMinutes);
      if (autoEnd) {
        const ended = await autoEndTrip(trip.id, autoEnd.endTime);
        if (ended) await notifyAutoEnded(formatDistance(ended.distanceM, settings.unit), settings.autoEndMinutes);
      }
    } catch (e) {
      console.warn('[route] failed to save points', e);
    }
  });
}
