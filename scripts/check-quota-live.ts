/**
 * 真实调用 Google 检查「只有成功才计数」（App 用的同一套计数代码：src/db/apiUsage.ts callWithQuota）。
 * 使用内存数据库，不影响手机里的计数；不打印 Key。
 *
 *   npx tsx scripts/check-quota-live.ts
 *
 * 会真的调用 Google 2 次成功请求（附近地点 1 次、路线 1 次，计入 Google 的免费额度），
 * 另外 1 次用错误的 Key（Google 拒绝，不计费）、1 次连不上的地址（没有网络响应）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { callWithQuota, googleUsage } from '../src/db/apiUsage';
import { GOOGLE_ROUTES_FIELD_MASK, googleRoutesBody } from '../src/lib/gaps';
import { googlePost } from '../src/lib/googleHttp';
import { appMonthlyLimit } from '../src/lib/googleQuota';
import { GOOGLE_NEARBY_FIELD_MASK, googleNearbyBody } from '../src/lib/nearby';
import { freshDb } from '../tests/helpers/nodeDb';

const file = join(process.cwd(), '.secrets', 'google-api-key.txt');
const key = (existsSync(file) ? readFileSync(file, 'utf8') : '').trim();
if (!key) {
  console.error('没有找到 Key：.secrets/google-api-key.txt');
  process.exit(1);
}
const signing = join(process.cwd(), '.secrets', 'release-signing.properties');
const certSha1 = existsSync(signing) ? (/^certSha1=([0-9A-Fa-f:]+)\s*$/m.exec(readFileSync(signing, 'utf8'))?.[1] ?? '') : '';
const headers = { 'X-Android-Package': 'com.mia.routemileage', 'X-Android-Cert': certSha1.replace(/:/g, '').toUpperCase() };

const FARNBOROUGH = { lat: 51.294492, lng: -0.754688 };
const FRIMLEY_GREEN = { lat: 51.30133, lng: -0.732474 };
const NEARBY = 'https://places.googleapis.com/v1/places:searchNearby';
const ROUTES = 'https://routes.googleapis.com/directions/v2:computeRoutes';

type Step = { name: string; api: 'places.nearby' | 'routes.compute'; url: string; key: string; mask: string; body: unknown };

const steps: Step[] = [
  { name: '附近地点（正确 Key）', api: 'places.nearby', url: NEARBY, key, mask: GOOGLE_NEARBY_FIELD_MASK, body: googleNearbyBody(FARNBOROUGH, 150) },
  { name: '附近地点（错误 Key）', api: 'places.nearby', url: NEARBY, key: 'AIzaInvalidKeyForQuotaTest0000000000000', mask: GOOGLE_NEARBY_FIELD_MASK, body: googleNearbyBody(FARNBOROUGH, 150) },
  { name: '附近地点（连不上：没有网络响应）', api: 'places.nearby', url: 'https://places.googleapis.invalid/v1/places:searchNearby', key, mask: GOOGLE_NEARBY_FIELD_MASK, body: googleNearbyBody(FARNBOROUGH, 150) },
  { name: '路线（正确 Key）', api: 'routes.compute', url: ROUTES, key, mask: GOOGLE_ROUTES_FIELD_MASK, body: googleRoutesBody(FARNBOROUGH, FRIMLEY_GREEN) },
  { name: '路线（错误 Key）', api: 'routes.compute', url: ROUTES, key: 'AIzaInvalidKeyForQuotaTest0000000000000', mask: GOOGLE_ROUTES_FIELD_MASK, body: googleRoutesBody(FARNBOROUGH, FRIMLEY_GREEN) },
];

(async () => {
  freshDb();
  let failed = false;
  for (const s of steps) {
    const before = (await googleUsage(s.api, appMonthlyLimit(s.api))).used;
    const r = await callWithQuota(s.api, appMonthlyLimit(s.api), async () => {
      const res = await googlePost(s.url, { key: s.key, fieldMask: s.mask, body: s.body, headers, timeoutMs: 8000 });
      return { ok: res.ok, value: res };
    });
    const after = (await googleUsage(s.api, appMonthlyLimit(s.api))).used;
    const res = r.status === 'done' ? r.value : null;
    const outcome = !res ? '本月已用完' : res.ok ? `成功 HTTP ${res.httpStatus}` : res.offline ? `没有响应（${res.message}）` : `失败 HTTP ${res.httpStatus}`;
    const expected = res?.ok ? 1 : 0;
    const okCount = after - before === expected;
    if (!okCount) failed = true;
    console.log(`${okCount ? '✔' : '✖'} ${s.name}：${outcome} → 计数 ${before} → ${after}（应 +${expected}）`);
  }
  const p = await googleUsage('places.nearby', appMonthlyLimit('places.nearby'));
  const r = await googleUsage('routes.compute', appMonthlyLimit('routes.compute'));
  console.log(`本月计数：附近地点 ${p.used}/${p.limit}，路线 ${r.used}/${r.limit}`);
  process.exit(failed ? 2 : 0);
})();
