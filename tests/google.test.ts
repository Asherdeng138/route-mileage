import assert from 'node:assert/strict';
import { test } from 'node:test';

import { callWithQuota, finishGoogleCall, googleUsage, reserveGoogleCall } from '../src/db/apiUsage';
import { googlePost } from '../src/lib/googleHttp';
import { appMonthlyLimit, billingMonth, DEFAULT_GOOGLE_MONTHLY_LIMIT, effectiveLimit, quotaState } from '../src/lib/googleQuota';
import {
  bestMatch,
  GOOGLE_NEARBY_FIELD_MASK,
  googleNearbyBody,
  mergeNearby,
  overpassQuery,
  parseGoogleNearby,
  parseOverpass,
  savedNearby,
} from '../src/lib/nearby';
import { project, unproject } from '../src/lib/osm';
import type { Place } from '../src/lib/types';

import { freshDb } from './helpers/nodeDb';

const C = { lat: 51.2905, lng: -0.7523 };

test('billing month follows Pacific time (never resets before Google does)', () => {
  assert.equal(billingMonth(new Date('2026-11-01T05:00:00Z')), '2026-10'); // 太平洋时间仍是 10 月 31 日
  assert.equal(billingMonth(new Date('2026-11-01T09:00:00Z')), '2026-11');
  assert.equal(billingMonth(new Date('2027-01-01T07:59:00Z')), '2026-12');
  const q = quotaState(800, 1000);
  assert.deepEqual([q.remaining, q.exhausted, q.warning], [200, false, true]);
  assert.equal(quotaState(1000, 1000).exhausted, true);
  assert.equal(quotaState(0, 0).exhausted, true); // 上限 0 = 完全不用 Google
});

test('limits are 70% of each Google free tier; user setting can only lower it', () => {
  assert.equal(appMonthlyLimit('places.nearby'), 3500); // Nearby Search Pro 免费 5,000 × 0.7
  assert.equal(appMonthlyLimit('routes.compute'), 7000); // Compute Routes Essentials 免费 10,000 × 0.7
  assert.equal(DEFAULT_GOOGLE_MONTHLY_LIMIT, 3500);
  assert.equal(effectiveLimit('places.nearby', 1000), 1000);
  assert.equal(effectiveLimit('places.nearby', 9999), 3500); // 不能超过 70%
  assert.equal(effectiveLimit('places.nearby', -5), 0);
  assert.equal(effectiveLimit('routes.compute'), 7000);
});

/** 模拟 Google：按顺序返回给定的结果（数字 = HTTP 状态码，'net' = 没网 / 超时） */
function fakeGoogle(seq: (number | 'net')[]) {
  let i = 0;
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(String(url));
    const r = seq[i++ % seq.length];
    await new Promise((res) => setTimeout(res, 5));
    if (r === 'net') throw new Error('Network request failed');
    const body = r >= 200 && r < 300 ? { places: [] } : { error: { message: `HTTP ${r} from Google` } };
    return new Response(JSON.stringify(body), { status: r, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const nearbyCall = (impl: typeof fetch) => async () => {
  const res = await googlePost('https://places.googleapis.com/v1/places:searchNearby', { key: 'test', fieldMask: 'places.id', body: {} }, impl);
  return { ok: res.ok, value: res };
};

test('only successful Google calls are counted: errors, no network and timeouts are not', async () => {
  freshDb();
  const oct = new Date('2026-10-15T12:00:00Z');
  const g = fakeGoogle([200, 403, 'net', 500, 200, 400]);
  const results = [];
  for (let i = 0; i < 6; i++) results.push(await callWithQuota('places.nearby', 3500, nearbyCall(g.impl), oct));
  assert.equal(g.calls.length, 6); // 6 次真的发出去了
  assert.deepEqual(
    results.map((r) => (r.status === 'done' ? (r.value.ok ? 'ok' : r.value.offline ? 'offline' : `http ${r.value.httpStatus}`) : r.status)),
    ['ok', 'http 403', 'offline', 'http 500', 'ok', 'http 400'],
  );
  assert.equal((await googleUsage('places.nearby', 3500, oct)).used, 2); // 只有 2 次成功
  assert.equal((await googleUsage('routes.compute', 7000, oct)).used, 0); // 各接口分开计数

  // call 自己抛错（例如解析代码出错）也不计数，占位会释放
  await assert.rejects(callWithQuota('places.nearby', 3500, async () => { throw new Error('boom'); }, oct));
  assert.equal((await googleUsage('places.nearby', 3500, oct)).used, 2);

  // 成功但 Google 返回内容无法解析：Google 已经计费，所以也计数
  const odd = (async () => new Response('not json', { status: 200 })) as unknown as typeof fetch;
  const r = await callWithQuota('places.nearby', 3500, nearbyCall(odd), oct);
  assert.ok(r.status === 'done' && r.value.ok);
  assert.equal((await googleUsage('places.nearby', 3500, oct)).used, 3);
});

test('monthly cap: never exceeded under concurrency; failed calls free their slot; resets next month', async () => {
  freshDb();
  const oct = new Date('2026-10-15T12:00:00Z');
  // 12 个请求同时发出、全部成功、上限 5：只会真的发出 5 个
  const ok = fakeGoogle([200]);
  const burst = await Promise.all(Array.from({ length: 12 }, () => callWithQuota('places.nearby', 5, nearbyCall(ok.impl), oct)));
  assert.equal(ok.calls.length, 5);
  assert.equal(burst.filter((r) => r.status === 'quota').length, 7);
  assert.deepEqual(
    { used: (await googleUsage('places.nearby', 5, oct)).used, exhausted: (await googleUsage('places.nearby', 5, oct)).exhausted },
    { used: 5, exhausted: true },
  );
  assert.equal((await callWithQuota('places.nearby', 5, nearbyCall(ok.impl), oct)).status, 'quota');

  // 失败的调用不占用额度：上限 6 时，连续失败 10 次后仍然可以成功 1 次
  const bad = fakeGoogle([403]);
  for (let i = 0; i < 10; i++) assert.equal((await callWithQuota('places.nearby', 6, nearbyCall(bad.impl), oct)).status, 'done');
  assert.equal((await googleUsage('places.nearby', 6, oct)).used, 5);
  assert.equal((await callWithQuota('places.nearby', 6, nearbyCall(ok.impl), oct)).status, 'done');
  assert.equal((await googleUsage('places.nearby', 6, oct)).used, 6);

  // 同时进行中的调用也占位：上限 7、已用 6，两个同时发出且第一个还没结束时，第二个被拒绝
  const slow = fakeGoogle([200]);
  const [a, b] = await Promise.all([
    callWithQuota('places.nearby', 7, nearbyCall(slow.impl), oct),
    callWithQuota('places.nearby', 7, nearbyCall(slow.impl), oct),
  ]);
  assert.deepEqual([a.status, b.status].sort(), ['done', 'quota']);

  // 下个月重新计数
  const nov = new Date('2026-11-02T12:00:00Z');
  assert.equal((await googleUsage('places.nearby', 5, nov)).used, 0);
  assert.equal((await callWithQuota('places.nearby', 5, nearbyCall(ok.impl), nov)).status, 'done');
});

test('reservations: a ticket is finished once; low-level reserve respects in-flight calls', async () => {
  freshDb();
  const oct = new Date('2026-10-15T12:00:00Z');
  const t1 = await reserveGoogleCall('routes.compute', 2, oct);
  const t2 = await reserveGoogleCall('routes.compute', 2, oct);
  assert.ok(t1 && t2);
  assert.equal(await reserveGoogleCall('routes.compute', 2, oct), null); // 两个进行中，已满
  await finishGoogleCall(t1!, true);
  await finishGoogleCall(t1!, true); // 重复结束不会重复计数
  await finishGoogleCall(t2!, false);
  assert.equal((await googleUsage('routes.compute', 2, oct)).used, 1);
  assert.ok(await reserveGoogleCall('routes.compute', 2, oct)); // 失败的那个位置释放了
});

test('Google Nearby Search request stays in the Pro tier (5,000 free per month)', () => {
  const enterpriseOrAtmosphere = ['rating', 'userRatingCount', 'OpeningHours', 'PhoneNumber', 'priceLevel', 'websiteUri', 'reviews', 'editorialSummary'];
  for (const f of enterpriseOrAtmosphere) assert.ok(!GOOGLE_NEARBY_FIELD_MASK.includes(f), f);
  assert.equal(GOOGLE_NEARBY_FIELD_MASK.split(',').length, 6);
  const body = googleNearbyBody(C, 150);
  assert.equal(body.rankPreference, 'DISTANCE');
  assert.equal(body.locationRestriction.circle.radius, 150);
  assert.ok(body.maxResultCount <= 20);
});

test('parse Google and OpenStreetMap results; merge keeps saved places first and removes duplicates', () => {
  const google = parseGoogleNearby(
    {
      places: [
        { id: 'a', displayName: { text: 'B&Q Farnborough' }, shortFormattedAddress: 'Ively Rd, Farnborough', location: { latitude: 51.2906, longitude: -0.7521 }, primaryTypeDisplayName: { text: 'Hardware store' } },
        { id: 'b', displayName: { text: 'Costa Coffee' }, location: { latitude: 51.2912, longitude: -0.7530 } },
        { id: 'bad', location: { latitude: 51.29, longitude: -0.75 } },
      ],
    },
    C,
  );
  assert.equal(google.length, 2);
  assert.equal(google[0].kind, 'Hardware store');
  assert.ok(google[0].distanceM < 20);

  const osm = parseOverpass(
    {
      elements: [
        { type: 'way', id: 1, center: { lat: 51.29061, lon: -0.75211 }, tags: { name: 'B&Q Farnborough', shop: 'doityourself', 'addr:street': 'Ively Road' } },
        { type: 'node', id: 2, lat: 51.2899, lon: -0.7519, tags: { name: 'Farnborough Gate Retail Park', amenity: 'parking' } },
        { type: 'node', id: 3, lat: 51.29, lon: -0.75, tags: { shop: 'bakery' } },
      ],
    },
    C,
  );
  assert.equal(osm.length, 2);
  assert.equal(osm[0].kind, 'shop: doityourself');
  assert.equal(osm[0].address, 'Ively Road');
  assert.match(overpassQuery(C, 150), /around:150,51\.290500,-0\.752300/);

  const places: Place[] = [{ id: 7, name: 'home', address: null, lat: 51.2907, lng: -0.7524, radiusM: 150, type: 'home' }];
  const merged = mergeNearby([savedNearby(places, C, 150), google, osm]);
  assert.equal(merged[0].source, 'saved');
  assert.equal(merged.filter((p) => p.name === 'B&Q Farnborough').length, 1); // Google 与 OSM 同名同位置只保留一个
  assert.equal(bestMatch(merged, 60)?.name, 'home');
  assert.equal(bestMatch(google, 10), null);
  assert.equal(bestMatch(google, 60)?.name, 'B&Q Farnborough');
});

test('unproject is the inverse of project (map drag → coordinates)', () => {
  for (const z of [5, 12, 17]) {
    const back = unproject(project(C, z), z);
    assert.ok(Math.abs(back.lat - C.lat) < 1e-9 && Math.abs(back.lng - C.lng) < 1e-9);
  }
});
