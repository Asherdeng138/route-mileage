/** 手动检查：OpenStreetMap 附近地点（Overpass）查询是否正常（免费，一次请求） */
import { mergeNearby, overpassQuery, parseOverpass } from '../src/lib/nearby';

const center = { lat: Number(process.argv[2] ?? 51.2943), lng: Number(process.argv[3] ?? -0.7546) };
(async () => {
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'RouteMileage/1.0 (manual check script)' },
    body: `data=${encodeURIComponent(overpassQuery(center, 150))}`,
  });
  console.log('HTTP', res.status);
  const places = mergeNearby([parseOverpass(await res.json(), center)]);
  for (const p of places) console.log(`${Math.round(p.distanceM)}m\t${p.name}\t${p.kind ?? ''}\t${p.address ?? ''}`);
})();
