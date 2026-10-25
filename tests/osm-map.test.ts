import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { strFromU8, unzipSync } from 'fflate';

import { mockPath, mockTrip, sampleSnapshot } from '../scripts/generate-samples';
import { buildDocx } from '../src/export/docx';
import { decodePng, encodePng } from '../src/export/raster';
import { renderRouteMapPng, TRACK_IMAGE_SIZE } from '../src/export/trackImage';
import { buildClaimSnapshot, wordLines } from '../src/lib/claim';
import { boundsCenter, fitZoom, OSM, project, tileUrl, viewTiles } from '../src/lib/osm';
import { COMPANY_TEMPLATE_RATE } from '../src/lib/rates';

test('Web Mercator projection and tile numbers', () => {
  assert.deepEqual(project({ lat: 0, lng: 0 }, 0), { x: 128, y: 128 });
  const london = project({ lat: 51.5074, lng: -0.1278 }, 10);
  assert.equal(Math.floor(london.x / 256), 511);
  assert.equal(Math.floor(london.y / 256), 340);
  assert.equal(tileUrl({ z: 10, x: 511, y: 340 }), 'https://tile.openstreetmap.org/10/511/340.png');
});

test('view tiles cover the whole view and nothing more than needed', () => {
  const center = project({ lat: 51.3, lng: -0.75 }, 14);
  const tiles = viewTiles(center, 14, 960, 720);
  assert.ok(tiles.length <= 5 * 4, `${tiles.length} tiles`);
  // 视图的每个角都被某个图块覆盖
  for (const [x, y] of [[0, 0], [959, 0], [0, 719], [959, 719], [480, 360]]) {
    assert.ok(tiles.some((t) => x >= t.left && x < t.left + 256 && y >= t.top && y < t.top + 256), `${x},${y}`);
  }
  assert.ok(tiles.every((t) => t.left > -256 && t.top > -256 && t.left < 960 && t.top < 720));
});

test('fitZoom keeps the whole route inside the image', () => {
  const pts = mockPath(3);
  const z = fitZoom(pts, 960, 720, 56, 16);
  const c = boundsCenter(pts, z);
  for (const p of pts) {
    const q = project(p, z);
    assert.ok(Math.abs(q.x - c.x) <= 480 - 56 + 1 && Math.abs(q.y - c.y) <= 360 - 56 + 1);
  }
  assert.ok(fitZoom(pts.slice(0, 20), 960, 720, 56, 16) > z); // 短路线放得更大
});

test('PNG decoder matches Pillow for RGB, RGBA, palette and grayscale images', () => {
  const fixtures = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'pillow-pngs.json'), 'utf8')) as Record<
    string,
    { png: string; width: number; height: number; sha256: string }
  >;
  for (const [mode, f] of Object.entries(fixtures)) {
    const img = decodePng(new Uint8Array(Buffer.from(f.png, 'base64')));
    assert.equal(img.width, f.width, mode);
    assert.equal(img.height, f.height, mode);
    assert.equal(createHash('sha256').update(img.rgba).digest('hex'), f.sha256, `${mode} pixels differ`);
  }
  // 自己编码的 PNG 也能解回原样
  const rgb = new Uint8Array(5 * 4 * 3).map((_, i) => (i * 37) % 256);
  const back = decodePng(encodePng(5, 4, rgb));
  for (let i = 0; i < 20; i++) assert.deepEqual([...back.rgba.slice(i * 4, i * 4 + 3)], [...rgb.slice(i * 3, i * 3 + 3)]);
  assert.throws(() => decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])));
});

test('route map: requests only the visible tiles, draws track and attribution, null when offline', async () => {
  const tile = encodePng(256, 256, new Uint8Array(256 * 256 * 3).fill(200));
  const asked: string[] = [];
  const r = await renderRouteMapPng(mockPath(5), async (z, x, y) => {
    asked.push(`${z}/${x}/${y}`);
    return tile;
  });
  assert.ok(r);
  assert.equal(r.tilesLoaded, r.tilesTotal);
  assert.equal(new Set(asked).size, asked.length); // 每块只请求一次
  assert.ok(asked.length <= 20);
  const img = decodePng(r.png);
  assert.deepEqual([img.width, img.height], [TRACK_IMAGE_SIZE.width, TRACK_IMAGE_SIZE.height]);
  const px = (x: number, y: number) => [...img.rgba.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 3)];
  // 右下角署名区是白底
  assert.ok(px(img.width - 3, img.height - 3).every((v) => v > 230));
  // 图中有轨迹蓝色像素
  let blue = 0;
  for (let i = 0; i < img.rgba.length; i += 4) if (img.rgba[i] < 60 && img.rgba[i + 2] > 130) blue++;
  assert.ok(blue > 1000, `blue pixels ${blue}`);

  assert.equal(await renderRouteMapPng(mockPath(5), async () => null), null);
  assert.equal(await renderRouteMapPng([{ lat: 51, lng: 0 }], async () => tile), null);
});

test('Word uses the OpenStreetMap route map with attribution; map trips are not merged', () => {
  const a = mockTrip({ date: '2026-10-01', miles: 51.5, endName: 'home', via: ['Store'], routeMapUri: 'map:a', routeMapW: 960, routeMapH: 720, routeMapStatus: 'ok' });
  const b = mockTrip({ date: '2026-10-02', miles: 51.5, endName: 'home', via: ['Store'], routeMapUri: 'map:b', routeMapW: 960, routeMapH: 720, routeMapStatus: 'ok' });
  const m = mockTrip({ date: '2026-10-03', miles: 51.5, endName: 'home', via: ['Store'], source: 'manual' });
  const s = buildClaimSnapshot({
    month: '2026-10',
    selected: [a, b, m],
    yearBusinessTrips: [a, b, m],
    manualMonths: [],
    rateVersions: [{ id: 1, ...COMPANY_TEMPLATE_RATE }],
    yearBasis: 'tax',
  });
  assert.deepEqual(s.trips.map((t) => t.image?.kind ?? null), ['map', 'map', null]);
  const lines = wordLines(s, true);
  assert.equal(lines.length, 2); // a、b 各自保留地图；无图的手动行程并入 a
  assert.deepEqual(lines.map((l) => l.trips.length), [2, 1]);

  const png = encodePng(4, 3, new Uint8Array(36).fill(128));
  const images = new Map([
    ['map:a', { bytes: png, mime: 'image/png' as const, width: 960, height: 720 }],
    ['map:b', { bytes: png, mime: 'image/png' as const, width: 960, height: 720 }],
  ]);
  const doc = strFromU8(unzipSync(buildDocx(s, { group: true, images }))['word/document.xml']);
  assert.equal((doc.match(/Map data © OpenStreetMap contributors/g) ?? []).length, 2);
  assert.ok(doc.includes('Route recorded by phone GPS (51.5 miles). Map data © OpenStreetMap contributors'));
  assert.ok(!doc.includes('not a map route'));
});

test('sample snapshot with maps marks every GPS trip for a route map', () => {
  const { snapshot } = sampleSnapshot({ maps: true });
  for (const t of snapshot.trips) assert.equal(t.image?.kind ?? 'none', t.source === 'gps' ? 'map' : 'none');
  assert.equal(OSM.attribution, '© OpenStreetMap contributors');
});
