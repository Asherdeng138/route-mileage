import assert from 'node:assert/strict';
import { test } from 'node:test';

import { googleUsage, reserveGoogleCall } from '../src/db/apiUsage';
import { billingMonth, quotaState } from '../src/lib/googleQuota';
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

test('monthly cap: reservations stop at the limit, also under concurrency, and reset next month', async () => {
  freshDb();
  const oct = new Date('2026-10-15T12:00:00Z');
  const results = await Promise.all(Array.from({ length: 12 }, () => reserveGoogleCall('places.nearby', 5, oct)));
  assert.equal(results.filter(Boolean).length, 5);
  assert.deepEqual(
    { used: (await googleUsage(5, oct)).used, exhausted: (await googleUsage(5, oct)).exhausted },
    { used: 5, exhausted: true },
  );
  assert.equal(await reserveGoogleCall('places.nearby', 5, oct), false);
  // 提高上限后可以继续
  assert.equal(await reserveGoogleCall('places.nearby', 6, oct), true);
  // 下个月重新计数
  const nov = new Date('2026-11-02T12:00:00Z');
  assert.equal((await googleUsage(5, nov)).used, 0);
  assert.equal(await reserveGoogleCall('places.nearby', 5, nov), true);
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
