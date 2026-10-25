/**
 * OpenStreetMap 图块下载与缓存（按 OSM 图块使用政策实现，见 src/lib/osm.ts）：
 *  - User-Agent 标明本 App，不冒充浏览器；
 *  - 遵守 Cache-Control / Expires，读不到时至少缓存 7 天；过期后用 If-None-Match / If-Modified-Since 条件请求；
 *  - 只下载当前看到的范围，不预先下载区域、不做离线地图；
 *  - 同时最多 4 个请求，相同图块只请求一次。
 * 图块缓存在 App 的 cache 目录，系统空间不足时可能被清掉，属正常现象。
 */
import Constants from 'expo-constants';
import { Directory, File, Paths } from 'expo-file-system';

import { OSM, tileUrl } from '@/lib/osm';

export const OSM_USER_AGENT = `RouteMileage/${Constants.expoConfig?.version ?? '1.0'} (Android; personal business-mileage log app)`;

const MAX_CONCURRENT = 4;
const TIMEOUT_MS = 15000;

interface TileMeta {
  fetchedAt: number;
  expiresAt: number;
  etag?: string;
  lastModified?: string;
}

function cacheDir(): Directory {
  const d = new Directory(Paths.cache, 'osm-tiles');
  if (!d.exists) d.create({ intermediates: true });
  return d;
}

const tileFile = (z: number, x: number, y: number) => new File(cacheDir(), `${z}-${x}-${y}.png`);
const metaFile = (z: number, x: number, y: number) => new File(cacheDir(), `${z}-${x}-${y}.json`);

function readMeta(z: number, x: number, y: number): TileMeta | null {
  try {
    const f = metaFile(z, x, y);
    return f.exists ? (JSON.parse(f.textSync()) as TileMeta) : null;
  } catch {
    return null;
  }
}

function writeMeta(z: number, x: number, y: number, m: TileMeta) {
  const f = metaFile(z, x, y);
  if (!f.exists) f.create();
  f.writeSync(JSON.stringify(m));
}

/** 根据响应头计算过期时间；至少 7 天 */
function expiry(res: Response, now: number): number {
  const cc = res.headers.get('cache-control') ?? '';
  const maxAge = /max-age=(\d+)/.exec(cc);
  let fromHeaders = 0;
  if (maxAge) fromHeaders = now + Number(maxAge[1]) * 1000;
  else {
    const exp = Date.parse(res.headers.get('expires') ?? '');
    if (Number.isFinite(exp)) fromHeaders = exp;
  }
  return Math.max(fromHeaders, now + OSM.minCacheMs);
}

let running = 0;
const waiting: (() => void)[] = [];
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

const inflight = new Map<string, Promise<File | null>>();

async function download(z: number, x: number, y: number): Promise<File | null> {
  const file = tileFile(z, x, y);
  const meta = readMeta(z, x, y);
  const now = Date.now();
  if (file.exists && meta && meta.expiresAt > now) return file;

  const headers: Record<string, string> = { 'User-Agent': OSM_USER_AGENT };
  if (file.exists && meta?.etag) headers['If-None-Match'] = meta.etag;
  if (file.exists && meta?.lastModified) headers['If-Modified-Since'] = meta.lastModified;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await limited(() => fetch(tileUrl({ z, x, y }), { headers, signal: ctrl.signal }));
    if (res.status === 304 && file.exists) {
      writeMeta(z, x, y, { ...meta!, fetchedAt: now, expiresAt: expiry(res, now) });
      return file;
    }
    if (!res.ok) return file.exists ? file : null; // 服务器出错：继续用旧图块
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!file.exists) file.create();
    file.writeSync(bytes);
    writeMeta(z, x, y, {
      fetchedAt: now,
      expiresAt: expiry(res, now),
      etag: res.headers.get('etag') ?? undefined,
      lastModified: res.headers.get('last-modified') ?? undefined,
    });
    return file;
  } catch {
    return file.exists ? file : null; // 没有网络：有旧图块就用
  } finally {
    clearTimeout(timer);
  }
}

/** 取图块文件（缓存优先）。失败返回 null */
export function getTileFile(z: number, x: number, y: number): Promise<File | null> {
  const key = `${z}/${x}/${y}`;
  let p = inflight.get(key);
  if (!p) {
    p = download(z, x, y).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

/** 取图块字节（生成 Word 路线图用） */
export async function getTileBytes(z: number, x: number, y: number): Promise<Uint8Array | null> {
  const f = await getTileFile(z, x, y);
  try {
    return f ? await f.bytes() : null;
  } catch {
    return null;
  }
}
