/**
 * 检查 Google Routes API（信号中断补算）是否可用：发 1 次 computeRoutes（Essentials，含备选路线），不打印 Key。
 * 并演示补算规则会选哪一条（src/lib/gaps.ts chooseRoute）。
 *
 * Key 放在 .secrets/google-api-key.txt。运行：
 *   npx tsx scripts/check-routes.ts [起点纬度 起点经度 终点纬度 终点经度 断开秒数]
 * 注意：这 1 次调用会计入 Google 的用量（每月免费 10,000 次）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { chooseRoute, GOOGLE_ROUTES_FIELD_MASK, googleRoutesBody, parseGoogleRoutes } from '../src/lib/gaps';
import { haversineM } from '../src/lib/geo';

const file = join(process.cwd(), '.secrets', 'google-api-key.txt');
const key = (process.env.GOOGLE_PLACES_TEST_KEY ?? (existsSync(file) ? readFileSync(file, 'utf8') : '')).trim();
if (!key) {
  console.error('没有找到 Key：请把 Key 粘贴到 .secrets/google-api-key.txt');
  process.exit(1);
}
const signing = join(process.cwd(), '.secrets', 'release-signing.properties');
const certSha1 =
  process.env.ANDROID_CERT_SHA1 ??
  (existsSync(signing) ? /^certSha1=([0-9A-Fa-f:]+)\s*$/m.exec(readFileSync(signing, 'utf8'))?.[1] : undefined) ??
  '5E8F16062EA3CD2C4A0D547876BAA6F38CABF625';
const masked = key.length > 10 ? `${key.slice(0, 6)}…${key.slice(-4)}` : '…';

// 默认：Farnborough 市中心 → Frimley Green（模拟器测试用的真实道路），断开 6 分钟
const a = process.argv.slice(2).map(Number);
const from = { lat: a[0] || 51.294492, lng: a[1] || -0.754688 };
const to = { lat: a[2] || 51.30133, lng: a[3] || -0.732474 };
const gapSec = a[4] || 360;

(async () => {
  const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': GOOGLE_ROUTES_FIELD_MASK,
      'X-Android-Package': 'com.mia.routemileage',
      'X-Android-Cert': certSha1.replace(/:/g, '').toUpperCase(),
    },
    body: JSON.stringify(googleRoutesBody(from, to)),
  });
  const json = await res.json().catch(() => null);
  console.log(`Key ${masked} → HTTP ${res.status}`);
  if (!res.ok) {
    const err = (json as { error?: { status?: string; message?: string; details?: { reason?: string; metadata?: Record<string, string> }[] } } | null)?.error;
    console.log(`错误：${err?.status ?? ''} ${err?.message ?? ''}`);
    for (const d of err?.details ?? []) {
      if (d.reason) console.log(`原因：${d.reason}`);
      if (d.metadata?.activationUrl) console.log(`启用链接：${d.metadata.activationUrl}`);
    }
    process.exit(2);
  }
  const routes = parseGoogleRoutes(json);
  const straightM = haversineM(from, to);
  console.log(`直线 ${(straightM / 1609.344).toFixed(2)} mi，断开 ${gapSec} 秒；Google 给出 ${routes.length} 条路线：`);
  for (const r of routes) {
    console.log(`  ${(r.distanceM / 1609.344).toFixed(2)} mi\t${Math.round(r.durationSec / 60)} 分钟\t${r.isDefault ? '推荐' : '备选'}\t${r.path.length} 个折线点`);
  }
  const c = chooseRoute({ gapSec, straightM }, routes);
  console.log(
    c.kind === 'filled'
      ? `→ 选用 ${(c.route.distanceM / 1609.344).toFixed(2)} mi（${c.reason}），补算 +${((c.route.distanceM - straightM) / 1609.344).toFixed(2)} mi`
      : `→ 不补算（${c.reason}），保持直线`,
  );
})();
