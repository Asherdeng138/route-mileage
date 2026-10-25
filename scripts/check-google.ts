/**
 * 检查 Google Places API (New) Key 是否可用：只发 1 次 Nearby Search（Pro 字段），不打印 Key。
 *
 * Key 放在 .secrets/google-api-key.txt（已在 .gitignore 中排除），或环境变量 GOOGLE_PLACES_TEST_KEY。
 * 运行：npx tsx scripts/check-google.ts [纬度] [经度]
 * 注意：这 1 次调用会计入 Google 的用量（不计入手机 App 里的计数）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { GOOGLE_NEARBY_FIELD_MASK, googleNearbyBody, parseGoogleNearby } from '../src/lib/nearby';

const file = join(process.cwd(), '.secrets', 'google-api-key.txt');
const key = (process.env.GOOGLE_PLACES_TEST_KEY ?? (existsSync(file) ? readFileSync(file, 'utf8') : '')).trim();
if (!key) {
  console.error('没有找到 Key：请把 Key 粘贴到 .secrets/google-api-key.txt（只放 Key 本身，一行）');
  process.exit(1);
}
// 与 App 发出的请求一致：带上包名和签名证书 SHA-1（Key 限制为「Android 应用」时需要）
const signing = join(process.cwd(), '.secrets', 'release-signing.properties');
const certSha1 =
  process.env.ANDROID_CERT_SHA1 ??
  (existsSync(signing) ? /^certSha1=([0-9A-Fa-f:]+)\s*$/m.exec(readFileSync(signing, 'utf8'))?.[1] : undefined) ??
  '5E8F16062EA3CD2C4A0D547876BAA6F38CABF625';
const ANDROID_HEADERS = {
  'X-Android-Package': 'com.mia.routemileage',
  'X-Android-Cert': certSha1.replace(/:/g, '').toUpperCase(),
};
const masked = key.length > 10 ? `${key.slice(0, 6)}…${key.slice(-4)}` : '…';
const center = { lat: Number(process.argv[2] ?? 51.2943), lng: Number(process.argv[3] ?? -0.7546) };

(async () => {
  const res = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': GOOGLE_NEARBY_FIELD_MASK, ...ANDROID_HEADERS },
    body: JSON.stringify(googleNearbyBody(center, 150)),
  });
  const json = await res.json().catch(() => null);
  console.log(`Key ${masked} → HTTP ${res.status}`);
  if (!res.ok) {
    const err = (json as { error?: { status?: string; message?: string; details?: { reason?: string; metadata?: Record<string, string> }[] } } | null)?.error;
    console.log(`错误：${err?.status ?? ''} ${err?.message ?? ''}`);
    for (const d of err?.details ?? []) {
      if (!d.reason) continue;
      console.log(`原因：${d.reason}`);
      // SERVICE_DISABLED：Key 所属项目没有启用这个 API，metadata 里有启用链接
      if (d.metadata?.activationUrl) console.log(`启用链接：${d.metadata.activationUrl}`);
    }
    process.exit(2);
  }
  const places = parseGoogleNearby(json, center);
  console.log(`附近 ${places.length} 个地点（${center.lat}, ${center.lng}，150 米内，按距离）：`);
  for (const p of places) console.log(`  ${Math.round(p.distanceM)} m\t${p.name}\t${p.kind ?? ''}\t${p.address ?? ''}`);
})();
