/**
 * 用明确标注的「模拟数据」生成示例 Word / Excel，供与 example 样板对照。
 * 不读写 App 数据库。输出到 samples/。
 *
 * 运行：npm run samples
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildDocx, type DocxImage } from '../src/export/docx';
import { renderRouteMapPng, renderTrackPng, TRACK_IMAGE_SIZE, type TileFetcher } from '../src/export/trackImage';
import { buildXlsx } from '../src/export/xlsx';
import { buildClaimSnapshot, exportFileName, type ClaimSnapshot } from '../src/lib/claim';
import { OSM, tileUrl } from '../src/lib/osm';
import { COMPANY_TEMPLATE_RATE } from '../src/lib/rates';
import type { LatLng, Trip } from '../src/lib/types';
import { M_PER_MILE } from '../src/lib/units';

export const SAMPLE_LABEL = 'SAMPLE DATA 模拟数据';

let nextId = 1;
export function mockTrip({ miles, ...p }: Partial<Trip> & { date: string; miles: number }): Trip {
  const id = nextId++;
  const m = miles * M_PER_MILE;
  return {
    id,
    startTime: Date.parse(`${p.date}T08:30:00Z`) + id,
    endTime: null,
    startName: 'home',
    startAddress: null,
    startLat: 51.29,
    startLng: -0.75,
    endName: 'Sample Store A',
    endAddress: null,
    endLat: 51.3,
    endLng: -0.7,
    distanceGpsM: p.source === 'manual' ? 0 : m,
    distanceM: m,
    distanceEdited: false,
    purpose: 'Store visit (sample)',
    client: 'Sample Client',
    notes: null,
    category: 'business',
    source: 'gps',
    status: 'completed',
    roundTrip: false,
    oneWayM: null,
    via: [],
    reportDesc: null,
    geocodeStatus: 'ok',
    commuteConfirmed: false,
    mapImageUri: null,
    mapImageW: null,
    mapImageH: null,
    routeMapUri: null,
    routeMapW: null,
    routeMapH: null,
    routeMapStatus: 'none',
    claimedAt: null,
    claimId: null,
    archivedAt: null,
    deletedAt: null,
    purgedAt: null,
    gapFillM: 0,
    gapFillStatus: 'none',
    createdAt: 0,
    updatedAt: 0,
    ...p,
  };
}

/** 生成一条看起来像驾车的弯曲轨迹（模拟） */
export function mockPath(seed: number, n = 400): LatLng[] {
  const pts: LatLng[] = [];
  let lat = 51.29;
  let lng = -0.75;
  let heading = seed;
  for (let i = 0; i < n; i++) {
    heading += Math.sin(i / 23 + seed) * 0.08;
    lat += Math.cos(heading) * 0.0009;
    lng += Math.sin(heading) * 0.0014;
    pts.push({ lat, lng });
  }
  // 原路返回，形成环线
  return [...pts, ...pts.slice().reverse().map((p) => ({ lat: p.lat + 0.002, lng: p.lng + 0.002 }))];
}

export function sampleTrips(): Trip[] {
  nextId = 1;
  const loop = (via: string[]) => ({ via, endName: 'home' });
  return [
    mockTrip({ date: '2026-10-01', miles: 66.5, ...loop(['Sample Store A (Farnborough)', 'Sample Office']) }),
    mockTrip({ date: '2026-10-02', miles: 51.5, ...loop(['Sample Store A (Farnborough)']) }),
    mockTrip({ date: '2026-10-05', miles: 51.5, ...loop(['Sample Store A (Farnborough)']) }),
    mockTrip({ date: '2026-10-06', miles: 56.3, ...loop(['Sample Store A (Farnborough)', 'Sample Store B (Yeading)']) }),
    mockTrip({
      date: '2026-10-07',
      miles: 84.5,
      ...loop([
        'Sample Store A (Farnborough)',
        'Sample Hotel, Fleet Road, Fleet GU51 (long address to test wrapping in Excel and Word)',
        '444 Sample Great West Road, Brentford TW8',
        'Sample Office',
      ]),
    }),
    mockTrip({ date: '2026-10-08', miles: 12.3, source: 'manual', distanceGpsM: 0, roundTrip: true, oneWayM: 6.15 * M_PER_MILE, endName: '示例客户 · 伦敦办公室', via: [] }),
    mockTrip({ date: '2026-10-09', miles: 68, distanceGpsM: 64.2 * M_PER_MILE, distanceEdited: true, ...loop(['Sample Store B (Yeading)', 'Sample Office', 'Sample Store A (Farnborough)']) }),
    mockTrip({ date: '2026-10-12', miles: 51.5, ...loop(['Sample Store A (Farnborough)']) }),
    mockTrip({ date: '2026-10-13', miles: 53.3, ...loop(['Heathrow T5 (sample)', 'Sample Store A (Farnborough)']) }),
    mockTrip({ date: '2026-10-14', miles: 64.7, ...loop(['Sample Store A (Farnborough)', 'Sample Restaurant', 'Sample Inn West', 'Sample Inn Town Centre']) }),
    mockTrip({ date: '2026-10-15', miles: 68.3, ...loop(['Sample Store A (Farnborough)', 'Sample Store B (Yeading)', 'Heathrow T4 (sample)']) }),
    mockTrip({ date: '2026-10-16', miles: 51.5, ...loop(['Sample Store A (Farnborough)']) }),
    mockTrip({ date: '2026-10-19', miles: 53.6, ...loop(['Sample Store A (Farnborough)']) }),
    mockTrip({ date: '2026-10-20', miles: 75.9, ...loop(['Sample Store A (Farnborough)', 'Sample Hotel Fleet']) }),
    mockTrip({ date: '2026-10-21', miles: 73.5, ...loop(['Sample Store A (Farnborough)', 'Sample Office']) }),
    mockTrip({ date: '2026-10-22', miles: 68.6, ...loop(['Sample Office', 'Sample Store A (Farnborough)']) }),
    mockTrip({ date: '2026-10-23', miles: 56.8, ...loop(['Sample Store A (Farnborough)', 'Heathrow T4 (sample)']) }),
    mockTrip({ date: '2026-10-26', miles: 61.1, ...loop(['Sample Store A (Farnborough)']) }),
    mockTrip({ date: '2026-10-27', miles: 51.5, ...loop(['Sample Store A (Farnborough)']) }),
    mockTrip({ date: '2026-10-28', miles: 70.8, ...loop(['Sample Store A (Farnborough)', 'Sample Office']) }),
    mockTrip({ date: '2026-10-29', miles: 21.8, startName: 'Sample Office', endName: 'home', via: ['Heathrow T5 (sample)'] }),
    mockTrip({ date: '2026-10-30', miles: 72.9, ...loop(['Sample Supermarket HQ', 'Sample Office']) }),
  ];
}

export function sampleSnapshot(opts: { maps?: boolean } = {}): { snapshot: ClaimSnapshot; trips: Trip[] } {
  const trips = sampleTrips().map((t) =>
    opts.maps && t.source === 'gps'
      ? { ...t, routeMapUri: `map:${t.id}`, routeMapW: TRACK_IMAGE_SIZE.width, routeMapH: TRACK_IMAGE_SIZE.height, routeMapStatus: 'ok' as const }
      : t,
  );
  const snapshot = buildClaimSnapshot({
    month: '2026-10',
    selected: trips,
    yearBusinessTrips: trips,
    manualMonths: [
      { month: '2026-07', tenths: 6142 },
      { month: '2026-08', tenths: 9702 },
      { month: '2026-09', tenths: 12761 },
    ],
    rateVersions: [{ id: 1, ...COMPANY_TEMPLATE_RATE }],
    yearBasis: 'tax',
    employeeName: SAMPLE_LABEL,
    trackPreview: (t) =>
      t.source === 'gps'
        ? { kind: 'track', key: `track:${t.id}`, mime: 'image/png', ...TRACK_IMAGE_SIZE }
        : null,
    now: new Date('2026-11-02T10:00:00Z'),
  });
  return { snapshot, trips };
}

/** 轨迹预览图（离线） */
export function sampleImages(snapshot: ClaimSnapshot): Map<string, DocxImage> {
  const images = new Map<string, DocxImage>();
  for (const t of snapshot.trips) {
    if (t.image?.kind !== 'track') continue;
    const png = renderTrackPng(mockPath(t.tripId));
    if (png) images.set(t.image.key, { bytes: png, mime: 'image/png', ...TRACK_IMAGE_SIZE });
  }
  return images;
}

/**
 * Node 版图块下载：使用 OpenStreetMap 图块（App 标识 User-Agent，本地缓存 7 天），
 * 只下载样例路线图实际需要的图块。
 */
export function nodeTileFetcher(cacheDir: string): TileFetcher {
  mkdirSync(cacheDir, { recursive: true });
  return async (z, x, y) => {
    const f = join(cacheDir, `${z}-${x}-${y}.png`);
    if (existsSync(f) && Date.now() - statSync(f).mtimeMs < OSM.minCacheMs) return new Uint8Array(readFileSync(f));
    try {
      const res = await fetch(tileUrl({ z, x, y }), {
        headers: { 'User-Agent': 'RouteMileage/1.0 (sample generation script for a personal business-mileage app)' },
      });
      if (!res.ok) return null;
      const bytes = new Uint8Array(await res.arrayBuffer());
      writeFileSync(f, bytes);
      return bytes;
    } catch {
      return null;
    }
  };
}

/** OpenStreetMap 路线图（需要网络）；取不到图块的行程退回轨迹预览 */
export async function sampleMapImages(snapshot: ClaimSnapshot, getTile: TileFetcher): Promise<Map<string, DocxImage>> {
  const images = new Map<string, DocxImage>();
  for (const t of snapshot.trips) {
    if (t.image?.kind !== 'map') continue;
    const r = await renderRouteMapPng(mockPath(t.tripId), getTile);
    const png = r?.png ?? renderTrackPng(mockPath(t.tripId));
    if (png) images.set(t.image.key, { bytes: png, mime: 'image/png', ...TRACK_IMAGE_SIZE });
  }
  return images;
}

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/generate-samples.ts');
if (isMain) {
  (async () => {
    const out = join(process.cwd(), 'samples');
    mkdirSync(out, { recursive: true });
    const offline = process.argv.includes('--offline');
    const { snapshot } = sampleSnapshot({ maps: !offline });
    const images = offline
      ? sampleImages(snapshot)
      : await sampleMapImages(snapshot, nodeTileFetcher(join(tmpdir(), 'route-osm-tile-cache')));
    const docx = buildDocx(snapshot, { group: true, images });
    const xlsx = buildXlsx(snapshot);
    const docName = `SAMPLE-${exportFileName('Word', snapshot.month)}`;
    const xlsName = `SAMPLE-${exportFileName('Excel', snapshot.month)}`;
    writeFileSync(join(out, docName), docx);
    writeFileSync(join(out, xlsName), xlsx);
    writeFileSync(join(out, 'SAMPLE-snapshot-2026-10.json'), JSON.stringify(snapshot, null, 2));
    const first = [...images.values()][0];
    if (first) writeFileSync(join(out, 'SAMPLE-route-map.png'), first.bytes);
    console.log(`${docName} ${docx.length} bytes (${offline ? 'track previews' : 'OpenStreetMap route maps'})`);
    console.log(`${xlsName} ${xlsx.length} bytes`);
    console.log(`trips=${snapshot.trips.length} miles=${snapshot.monthTenths / 10} pence=${snapshot.monthPence} year=${snapshot.yearTenths / 10}`);
  })();
}
