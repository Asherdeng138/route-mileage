/**
 * 行程结束后自动生成「OpenStreetMap 底图 + 手机 GPS 实际轨迹」路线图，保存在 App 私有目录，
 * 导出 Word 时放在这条行程下面（附有截图时优先用截图）。
 * 没有网络时状态为 pending，之后打开 App 或导出时会再试；仍失败则 Word 使用轨迹预览图。
 */
import { Directory, File, Paths } from 'expo-file-system';

import { filledGaps } from '@/db/gaps';
import { getAppSettings } from '@/db/settings';
import { getPoints, getTrip, listPendingRouteMaps, updateTrip } from '@/db/trips';
import { renderRouteMapPng, TRACK_IMAGE_SIZE } from '@/export/trackImage';
import type { RouteMapStatus, Trip } from '@/lib/types';

import { getTileBytes } from './osmTiles';

function removeFile(uri: string | null) {
  if (!uri) return;
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    // 已不存在
  }
}

export function routeMapFileExists(t: Pick<Trip, 'routeMapUri'>): boolean {
  if (!t.routeMapUri) return false;
  try {
    return new File(t.routeMapUri).exists;
  } catch {
    return false;
  }
}

/** 生成（或重新生成）一条 GPS 行程的路线图，返回新状态 */
export async function generateRouteMap(tripId: number): Promise<RouteMapStatus> {
  const [trip, settings] = await Promise.all([getTrip(tripId), getAppSettings()]);
  if (!trip || trip.source !== 'gps' || trip.status !== 'completed') return 'none';
  if (!settings.onlineMaps) return trip.routeMapStatus;
  const points = await getPoints(tripId);
  if (points.length < 2) {
    await updateTrip(tripId, { routeMapStatus: 'none' });
    return 'none';
  }
  const fills = trip.gapFillStatus === 'done' ? await filledGaps(tripId) : [];
  const result = await renderRouteMapPng(points, getTileBytes, undefined, fills).catch(() => null);
  if (!result) {
    await updateTrip(tripId, { routeMapStatus: 'failed' });
    return 'failed';
  }
  const dir = new Directory(Paths.document, 'route-maps');
  if (!dir.exists) dir.create({ intermediates: true });
  const file = new File(dir, `trip-${tripId}-${Date.now()}.png`);
  file.create();
  file.writeSync(result.png);
  // 已确认报销的快照可能引用旧图，保留旧文件
  if (!trip.claimId) removeFile(trip.routeMapUri);
  await updateTrip(tripId, {
    routeMapUri: file.uri,
    routeMapW: TRACK_IMAGE_SIZE.width,
    routeMapH: TRACK_IMAGE_SIZE.height,
    routeMapStatus: 'ok',
  });
  return 'ok';
}

/** 补生成之前没网时没生成的路线图（每次最多几条，避免集中下载大量图块） */
export async function retryPendingRouteMaps(limit = 3): Promise<number> {
  if (!(await getAppSettings()).onlineMaps) return 0;
  let ok = 0;
  for (const t of await listPendingRouteMaps(limit)) {
    if ((await generateRouteMap(t.id)) === 'ok') ok++;
    else break; // 大概率没网，下次再试
  }
  return ok;
}
