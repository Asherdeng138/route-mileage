/**
 * 开始 / 结束 / 恢复 GPS 记录。
 *
 * 后台机制：expo-location 的 startLocationUpdatesAsync + 安卓前台服务（常驻通知「正在记录行程」）。
 * 锁屏、切到导航 App 时，前台服务让系统继续提供定位，点由 src/tracking/task.ts 写入数据库。
 *
 * 支持边界（实际情况，不承诺永远后台运行）：
 *  - 用户在系统设置里「强制停止」App：前台服务和定位都会被系统终止，直到再次打开 App。
 *  - 手机重启：定位不会自动恢复；再次打开 App 时会提示「继续记录 / 结束并保存」。
 *  - 部分厂商（华为、小米、OPPO、vivo、三星等）的省电策略可能杀掉后台服务，
 *    需要把本 App 的电池设置改为「不受限制」并允许自启动。
 *  - 已记录的点都已落库；被中断期间没有点，恢复后两点之间按直线计入（间隔 >2 分钟不做跳点检查）。
 */
import * as Location from 'expo-location';
import { PermissionsAndroid, Platform } from 'react-native';

import { listPlaces } from '@/db/places';
import {
  appendPoints,
  countPoints,
  createRecordingTrip,
  deleteTrip,
  finishTrip,
  getActiveTrip,
  getTrip,
  listPendingGeocode,
  updateTrip,
} from '@/db/trips';
import { todayISO } from '@/lib/dates';
import { CURRENT_FIX_TIMEOUT_MS } from '@/lib/trackingConfig';
import type { Trip } from '@/lib/types';
import { resolvePlace } from '@/services/geocoding';
import { afterTripFinished } from '@/services/gapFill';

import { LOCATION_TASK, locationOptions, toTrackPoint } from './locationOptions';
import { currentPowerMode, resetPowerState } from './power';

export type StartResult =
  | { ok: true; tripId: number; resumed: boolean; background: boolean; precise: boolean }
  | { ok: false; code: 'services-off' | 'permission-denied' | 'permission-blocked' | 'start-failed'; message: string };

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

/** 开始 / 结束 / 继续同一时间只允许一个在执行，避免连点导致重复启动 */
let busy: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = busy.then(fn, fn);
  busy = run.catch(() => undefined);
  return run;
}

async function currentPoint() {
  try {
    const loc = await withTimeout(
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
      CURRENT_FIX_TIMEOUT_MS,
    );
    return loc ? toTrackPoint(loc) : null;
  } catch {
    return null;
  }
}

/**
 * 本进程是否启动过定位。expo-task-manager 会把已注册的任务持久保存：App 被强制停止、被系统杀掉
 * 或手机重启后，hasStartedLocationUpdatesAsync 仍可能返回 true，但定位服务其实已经停了
 * （模拟器冒烟测试发现）。所以「正在运行」必须同时满足：本进程启动过，且任务已注册。
 */
let startedInThisProcess = false;

async function taskRegistered(): Promise<boolean> {
  try {
    return await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK);
  } catch {
    return false;
  }
}

/** 后台定位是否真的在运行 */
export async function isUpdating(): Promise<boolean> {
  return startedInThisProcess && (await taskRegistered());
}

async function startUpdates() {
  if (await isUpdating()) return;
  // 进程重启后残留的注册先清掉，再重新启动前台定位服务
  if (await taskRegistered()) await Location.stopLocationUpdatesAsync(LOCATION_TASK).catch(() => undefined);
  resetPowerState();
  await Location.startLocationUpdatesAsync(LOCATION_TASK, locationOptions('high', true));
  startedInThisProcess = true;
}

/**
 * App 回到前台时调用：重新带上前台服务参数应用当前定位模式。
 * （后台切换省电模式时不能带前台服务参数，这里补上，保证通知设置一直保存在任务里。）
 */
export async function refreshServiceOnForeground(): Promise<void> {
  if (!(await isUpdating())) return;
  try {
    await Location.startLocationUpdatesAsync(LOCATION_TASK, locationOptions(currentPowerMode(), true));
  } catch (e) {
    console.warn('[route] refresh service failed', (e as Error).message);
  }
}

async function stopUpdates() {
  startedInThisProcess = false;
  resetPowerState();
  if (!(await taskRegistered())) return;
  try {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  } catch {
    // 已停止
  }
}

// ---------- 权限 ----------

export interface PermissionState {
  servicesEnabled: boolean;
  foreground: Location.PermissionStatus;
  foregroundCanAskAgain: boolean;
  background: Location.PermissionStatus;
  /** 安卓 12+ 用户可能只给「大致位置」：精度几百米到几公里，点会被过滤掉，路线变成直线 */
  precise: boolean;
  notifications: 'granted' | 'denied' | 'not-required';
}

async function notificationStatus(): Promise<PermissionState['notifications']> {
  if (Platform.OS !== 'android' || Number(Platform.Version) < 33) return 'not-required';
  const ok = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
  return ok ? 'granted' : 'denied';
}

export async function getPermissionState(): Promise<PermissionState> {
  const [servicesEnabled, fg, bg, notifications] = await Promise.all([
    Location.hasServicesEnabledAsync().catch(() => false),
    Location.getForegroundPermissionsAsync(),
    Location.getBackgroundPermissionsAsync(),
    notificationStatus(),
  ]);
  return {
    servicesEnabled,
    foreground: fg.status,
    foregroundCanAskAgain: fg.canAskAgain,
    background: bg.status,
    precise: fg.status !== 'granted' || fg.android?.accuracy !== 'coarse',
    notifications,
  };
}

/** 安卓 13+ 前台服务通知需要通知权限；拒绝时仍能记录，但通知栏看不到状态 */
export async function requestNotificationPermission(): Promise<boolean> {
  if ((await notificationStatus()) !== 'denied') return true;
  const r = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
  return r === PermissionsAndroid.RESULTS.GRANTED;
}

/** 安卓 11+ 会跳到系统设置页，需要用户选择「始终允许」。调用前应先向用户说明原因 */
export async function requestBackgroundPermission(): Promise<boolean> {
  try {
    const r = await Location.requestBackgroundPermissionsAsync();
    return r.status === 'granted';
  } catch {
    return false;
  }
}

/** 定位服务关闭时，弹出系统对话框请用户打开（Google Play 服务）；失败返回 false */
export async function askToEnableLocationServices(): Promise<boolean> {
  try {
    await Location.enableNetworkProviderAsync();
  } catch {
    // 用户拒绝或设备不支持
  }
  return Location.hasServicesEnabledAsync().catch(() => false);
}

async function ensureForeground(): Promise<StartResult | null> {
  if (!(await Location.hasServicesEnabledAsync()) && !(await askToEnableLocationServices())) {
    return { ok: false, code: 'services-off', message: '手机定位服务没有打开。请在系统设置里打开「位置信息」后再试。' };
  }
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== 'granted') {
    return fg.canAskAgain
      ? { ok: false, code: 'permission-denied', message: '需要定位权限才能记录路线。' }
      : {
          ok: false,
          code: 'permission-blocked',
          message: '定位权限已被拒绝。请在 系统设置 → 应用 → 里程记录 → 权限 中允许「位置信息」。',
        };
  }
  return null;
}

// ---------- 开始 / 结束 ----------

/** 开始记录：检查权限 → 新建行程（已有则继续）→ 启动后台定位 */
export function startRecording(): Promise<StartResult> {
  return exclusive(async () => {
    const denied = await ensureForeground();
    if (denied) return denied;
    await requestNotificationPermission().catch(() => false);
    const background = (await Location.getBackgroundPermissionsAsync()).status === 'granted';

    const { id, existed } = await createRecordingTrip(todayISO());
    if (!existed) {
      const first = await currentPoint();
      if (first) {
        await appendPoints(id, [first]);
        // 出发时就识别起点附近的地点（Google 限额内，否则免费来源），结束时只需再识别终点
        resolveTripPlaces(id).catch(() => undefined);
      }
    }
    try {
      await startUpdates();
    } catch (e) {
      if (!existed) await deleteTrip(id);
      return { ok: false, code: 'start-failed', message: `无法启动定位：${(e as Error).message}` };
    }
    const precise = (await Location.getForegroundPermissionsAsync()).android?.accuracy !== 'coarse';
    return { ok: true, tripId: id, resumed: existed, background, precise };
  });
}

/** 有未结束的行程，但本进程没有在记录（App 被杀、强制停止、手机重启）→ 交给界面询问用户 */
export async function findInterruptedTrip(): Promise<{ trip: Trip; points: number } | null> {
  const active = await getActiveTrip();
  if (!active || (await isUpdating())) return null;
  return { trip: active, points: await countPoints(active.id) };
}

/** 继续记录被中断的行程 */
export function resumeRecording(): Promise<StartResult> {
  return startRecording();
}

/** 解析起终点名称；失败时保留坐标并标记 failed，之后可重试或手动填写 */
export async function resolveTripPlaces(tripId: number): Promise<Trip | null> {
  const trip = await getTrip(tripId);
  if (!trip) return null;
  const places = await listPlaces();
  const patch: Partial<Trip> = {};
  let ok = true;
  const resolveEnd = async (which: 'start' | 'end') => {
    const lat = which === 'start' ? trip.startLat : trip.endLat;
    const lng = which === 'start' ? trip.startLng : trip.endLng;
    const hasName = which === 'start' ? trip.startName || trip.startAddress : trip.endName || trip.endAddress;
    if (hasName || lat == null || lng == null) return;
    const r = await resolvePlace({ lat, lng }, places);
    if (!r) {
      ok = false;
      return;
    }
    if (which === 'start') Object.assign(patch, { startName: r.name, startAddress: r.address });
    else Object.assign(patch, { endName: r.name, endAddress: r.address });
  };
  await resolveEnd('start');
  await resolveEnd('end');
  patch.geocodeStatus = ok ? 'ok' : 'failed';
  await updateTrip(tripId, patch);
  return getTrip(tripId);
}

/** 网络恢复后重试之前失败的地址解析（App 打开时调用） */
export async function retryPendingGeocodes(): Promise<number> {
  let fixed = 0;
  for (const t of await listPendingGeocode()) {
    const r = await resolveTripPlaces(t.id);
    if (r?.geocodeStatus === 'ok') fixed++;
  }
  return fixed;
}

/**
 * 结束记录：停止定位 → 补最后一个点 → 在写队列里标记完成（之后迟到的点会被丢弃）→ 解析起终点。
 * 返回行程 id。
 */
export function stopRecording(): Promise<number | null> {
  return exclusive(async () => {
    const trip = await getActiveTrip();
    if (!trip) {
      await stopUpdates();
      return null;
    }
    await stopUpdates();
    const last = await currentPoint();
    if (last) await appendPoints(trip.id, [last]);
    await finishTrip(trip.id);
    // 没有网络时地址解析可能很慢：最多等 7 秒，之后在后台继续，行程页会显示「地址解析中 / 重试」
    const resolving = resolveTripPlaces(trip.id).catch(() => null);
    await withTimeout(resolving, 7000);
    // 信号中断补算最多等 8 秒（没网时之后再补）；路线图（OpenStreetMap 底图 + 实际轨迹）在后台生成，不阻塞保存
    await afterTripFinished(trip.id, 8000).catch(() => undefined);
    return trip.id;
  });
}

/**
 * 停留太久自动结束（省电优化 #1）：后台任务调用。结束时间取开始停留的时刻，终点取最后一个有效点，
 * 不再取当前位置（可能在后台，也不需要）。
 */
export function autoEndTrip(tripId: number, endTime: number): Promise<Trip | null> {
  return exclusive(async () => {
    const active = await getActiveTrip();
    if (!active || active.id !== tripId) return null;
    await stopUpdates();
    await finishTrip(tripId, endTime);
    await resolveTripPlaces(tripId).catch(() => null);
    afterTripFinished(tripId).catch(() => undefined);
    return getTrip(tripId);
  });
}

/** 放弃当前记录（不保存） */
export function discardRecording(): Promise<void> {
  return exclusive(async () => {
    await stopUpdates();
    const trip = await getActiveTrip();
    if (trip) await deleteTrip(trip.id);
  });
}
