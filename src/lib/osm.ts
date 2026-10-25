/**
 * OpenStreetMap 图块的坐标计算（Web Mercator，纯函数，可测试）。
 *
 * 使用条件（https://operations.osmfoundation.org/policies/tiles/ ，2026-10-21 核对）：
 *  - 只用 https://tile.openstreetmap.org/{z}/{x}/{y}.png
 *  - 请求带上能识别本 App 的 User-Agent
 *  - 地图上清楚标注 "© OpenStreetMap contributors"（通常在右下角）
 *  - 遵守缓存头，读不到时每个图块至少缓存 7 天
 *  - 不批量下载、不预先下载区域做离线地图
 */
import type { LatLng } from './types';

export const OSM = {
  /** 图块地址集中在这里，需要换成自建 / 其他服务时只改这一处 */
  tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  tileSize: 256,
  minZoom: 3,
  maxZoom: 17,
  attribution: '© OpenStreetMap contributors',
  copyrightUrl: 'https://www.openstreetmap.org/copyright',
  /** 读不到缓存头时的最短缓存时间 */
  minCacheMs: 7 * 24 * 3600 * 1000,
} as const;

export interface Px {
  x: number;
  y: number;
}

const MAX_LAT = 85.05112878;

/** 经纬度 → 第 z 级的世界像素坐标 */
export function project(p: LatLng, z: number): Px {
  const scale = OSM.tileSize * 2 ** z;
  const lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, p.lat));
  const s = Math.sin((lat * Math.PI) / 180);
  return {
    x: ((p.lng + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale,
  };
}

/** 能把所有点放进 width × height（四周留 padding）的最大缩放级别 */
export function fitZoom(points: LatLng[], width: number, height: number, padding: number, maxZoom: number = OSM.maxZoom): number {
  if (points.length < 2) return maxZoom;
  for (let z = maxZoom; z > OSM.minZoom; z--) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of points) {
      const q = project(p, z);
      minX = Math.min(minX, q.x);
      maxX = Math.max(maxX, q.x);
      minY = Math.min(minY, q.y);
      maxY = Math.max(maxY, q.y);
    }
    if (maxX - minX <= width - 2 * padding && maxY - minY <= height - 2 * padding) return z;
  }
  return OSM.minZoom;
}

/** 点集外接框中心（世界像素） */
export function boundsCenter(points: LatLng[], z: number): Px {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    const q = project(p, z);
    minX = Math.min(minX, q.x);
    maxX = Math.max(maxX, q.x);
    minY = Math.min(minY, q.y);
    maxY = Math.max(maxY, q.y);
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

export interface TileRef {
  z: number;
  x: number;
  y: number;
  /** 图块左上角在视图中的位置（像素） */
  left: number;
  top: number;
}

/** 覆盖视图（以世界像素 center 为中心，width × height）所需的图块 */
export function viewTiles(center: Px, z: number, width: number, height: number): TileRef[] {
  const size = OSM.tileSize;
  const n = 2 ** z;
  const originX = center.x - width / 2;
  const originY = center.y - height / 2;
  const tiles: TileRef[] = [];
  for (let ty = Math.floor(originY / size); ty * size < originY + height; ty++) {
    if (ty < 0 || ty >= n) continue;
    for (let tx = Math.floor(originX / size); tx * size < originX + width; tx++) {
      tiles.push({
        z,
        x: ((tx % n) + n) % n,
        y: ty,
        left: Math.round(tx * size - originX),
        top: Math.round(ty * size - originY),
      });
    }
  }
  return tiles;
}

/** 第 z 级世界像素 → 经纬度（project 的逆运算） */
export function unproject(p: Px, z: number): LatLng {
  const scale = OSM.tileSize * 2 ** z;
  const lng = (p.x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * p.y) / scale;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lat, lng };
}

/** 世界像素 → 视图像素 */
export const toView = (p: Px, center: Px, width: number, height: number): Px => ({
  x: p.x - center.x + width / 2,
  y: p.y - center.y + height / 2,
});

export const tileUrl = (t: { z: number; x: number; y: number }) =>
  OSM.tileUrl.replace('{z}', String(t.z)).replace('{x}', String(t.x)).replace('{y}', String(t.y));
