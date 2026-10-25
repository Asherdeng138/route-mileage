/**
 * 路线图（PNG），纯 JS 绘制：
 *  - renderRouteMapPng：OpenStreetMap 底图 + 手机 GPS 实际轨迹，右下角注明 "© OpenStreetMap contributors"。
 *  - renderTrackPng：没有网络 / 关闭在线地图时的轨迹预览（无底图，Word 中注明不是地图路线）。
 */
import { routeSegments, type FilledGap } from '@/lib/gaps';
import { decimate, projectToBox } from '@/lib/geo';
import { boundsCenter, fitZoom, OSM, project, toView, viewTiles } from '@/lib/osm';
import type { LatLng } from '@/lib/types';

import { Canvas, decodePng, hex } from './raster';

export { decodePng, encodePng } from './raster';

export const TRACK_IMAGE_SIZE = { width: 960, height: 720 };

const LINE = hex('#1F4E9C');
/** 信号中断补算的路段（Google 驾车路线）：浅一些的蓝色虚线 */
const FILL_LINE = hex('#5B8DEF');
const START = hex('#1E8A4C');
const END = hex('#D93B3B');
const WHITE = hex('#FFFFFF');

type XY = { x: number; y: number };

function drawRoute(c: Canvas, xy: XY[], segments?: { solid: XY[][]; filled: XY[][] }) {
  const solid = segments?.solid ?? [xy];
  const filled = segments?.filled ?? [];
  for (const seg of [...solid, ...filled]) c.polyline(seg, 6.5, WHITE); // 白色描边，在地图上更醒目
  for (const seg of filled) c.dashedPolyline(seg, 4, FILL_LINE);
  for (const seg of solid) c.polyline(seg, 4, LINE);
  const s = xy[0];
  const e = xy[xy.length - 1];
  c.disc(s.x, s.y, 13, WHITE);
  c.disc(s.x, s.y, 10, START);
  c.disc(e.x, e.y, 13, WHITE);
  c.disc(e.x, e.y, 10, END);
}

/** 轨迹预览（无底图）。点少于 2 个返回 null */
export function renderTrackPng(points: LatLng[], size = TRACK_IMAGE_SIZE): Uint8Array | null {
  if (points.length < 2) return null;
  const { width: W, height: H } = size;
  const c = new Canvas(W, H, hex('#F4F6F9'));
  const grid = hex('#E1E5EA');
  for (const g of [0.25, 0.5, 0.75]) {
    c.rect(0, Math.round(H * g), W, 1, grid);
    c.rect(Math.round(W * g), 0, 1, H, grid);
  }
  drawRoute(c, projectToBox(decimate(points, 1500), W, H, 48));
  return c.toPng();
}

/** 取图块字节；失败返回 null */
export type TileFetcher = (z: number, x: number, y: number) => Promise<Uint8Array | null>;

export interface RouteMapResult {
  png: Uint8Array;
  zoom: number;
  tilesLoaded: number;
  tilesTotal: number;
}

/**
 * OpenStreetMap 路线图。只请求覆盖这张图所需的图块（960×720 约 20 块），不做批量下载。
 * 一个图块都取不到（例如没有网络）时返回 null，调用方改用轨迹预览。
 */
export async function renderRouteMapPng(
  points: (LatLng & { ts?: number })[],
  getTile: TileFetcher,
  size = TRACK_IMAGE_SIZE,
  fills: FilledGap[] = [],
): Promise<RouteMapResult | null> {
  if (points.length < 2) return null;
  const { width: W, height: H } = size;
  const pts = decimate(points, 1500);
  // 补算路段可能绕出 GPS 点的范围，一起算进取景
  const frame = fills.length ? [...pts, ...fills.flatMap((f) => f.path)] : pts;
  const zoom = fitZoom(frame, W, H, 56, 16);
  const center = boundsCenter(frame, zoom);
  const tiles = viewTiles(center, zoom, W, H);
  const c = new Canvas(W, H, hex('#E8E4DC'));

  let loaded = 0;
  for (const t of tiles) {
    try {
      const bytes = await getTile(t.z, t.x, t.y);
      if (!bytes) continue;
      c.blit(decodePng(bytes), t.left, t.top);
      loaded++;
    } catch {
      // 单个图块失败：保留底色
    }
  }
  if (!loaded) return null;

  const view = (p: LatLng) => toView(project(p, zoom), center, W, H);
  // 分段要用完整的点（带时间），decimate 后的点可能缺少中断两端
  const seg = fills.length ? routeSegments(points, fills) : null;
  drawRoute(
    c,
    pts.map(view),
    seg ? { solid: seg.solid.map((s) => decimate(s, 1500).map(view)), filled: seg.filled.map((s) => s.map(view)) } : undefined,
  );

  // 署名：右下角白底文字
  const scale = 2;
  const textW = c.text(OSM.attribution, 0, 0, scale, WHITE, false);
  const boxW = textW + 16;
  const boxH = 7 * scale + 12;
  c.rect(W - boxW, H - boxH, boxW, boxH, WHITE, 0.85);
  c.text(OSM.attribution, W - boxW + 8, H - boxH + 6, scale, hex('#333333'));

  return { png: c.toPng(), zoom, tilesLoaded: loaded, tilesTotal: tiles.length };
}
