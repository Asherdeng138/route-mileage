import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { buildBackup, restoreBackup, validateBackup } from '../src/db/backupCore';
import { confirmClaim, listMonthMiles, revokeClaim, saveClaimSnapshot, setMonthMiles } from '../src/db/claims';
import { getDb, migrate, MIGRATIONS, registerDb, SCHEMA_VERSION } from '../src/db/core';
import { addRateVersion, listRateVersions } from '../src/db/rates';
import {
  appendPoints,
  createManualTrip,
  createRecordingTrip,
  finishTrip,
  getActiveTrip,
  getPoints,
  getTrip,
  listTrips,
  updateTrip,
} from '../src/db/trips';
import { buildClaimSnapshot } from '../src/lib/claim';
import { pathDistanceM } from '../src/lib/geo';
import { metersToTenths } from '../src/lib/money';
import type { TrackPoint } from '../src/lib/types';
import { M_PER_MILE } from '../src/lib/units';

import { asyncDb, freshDb, migrationDb } from './helpers/nodeDb';

/** 模拟以约 50 km/h 行驶的一串 GPS 点 */
function drivePoints(n: number, t0 = 0, lat0 = 51.3): TrackPoint[] {
  return Array.from({ length: n }, (_, i) => ({
    lat: lat0 + i * 0.0006,
    lng: -0.75,
    ts: t0 + i * 5000,
    accuracy: 8,
    speed: 14,
  }));
}

test('migration v1 → v2 keeps old data, converts manual round trips, moves rates to versions', () => {
  const raw = new DatabaseSync(':memory:');
  const m = migrationDb(raw);
  // 模拟旧版数据库（只执行 v1）
  m.transaction(() => {
    MIGRATIONS[0](m);
    m.exec('PRAGMA user_version = 1');
  });
  const now = Date.now();
  raw.exec(`INSERT INTO trips (date, distance_m, distance_gps_m, round_trip, source, status, category, start_name, end_name, created_at, updated_at)
            VALUES ('2026-09-01', ${20 * M_PER_MILE}, 0, 1, 'manual', 'completed', 'business', 'home', 'Client', ${now}, ${now})`);
  raw.exec(`INSERT INTO trips (date, distance_m, distance_gps_m, source, status, category, created_at, updated_at)
            VALUES ('2026-09-02', 5000, 5000, 'gps', 'completed', 'business', ${now}, ${now})`);
  raw.exec(`INSERT INTO track_points (trip_id, lat, lng, ts) VALUES (2, 51.3, -0.75, 1), (2, 51.31, -0.75, 2)`);
  raw.exec(`INSERT INTO settings (key, value) VALUES ('rateFirstPence','55'),('rateAfterPence','25'),('thresholdMiles','10000'),('employeeName','Mia')`);

  assert.equal(migrate(m), SCHEMA_VERSION);
  const trips = raw.prepare('SELECT * FROM trips ORDER BY id').all() as Record<string, unknown>[];
  assert.equal(trips.length, 2);
  assert.ok(Math.abs((trips[0].one_way_m as number) - 10 * M_PER_MILE) < 1e-6); // 往返 20 → 单程 10
  assert.equal(trips[0].distance_m, 20 * M_PER_MILE); // 申报里程不变
  assert.equal(trips[1].one_way_m, null);
  assert.equal(trips[1].geocode_status, 'ok');
  // v3：旧的已结束 GPS 行程等待补生成路线图；手动行程不需要
  assert.equal(trips[1].route_map_status, 'pending');
  assert.equal(trips[0].route_map_status, 'none');
  assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM track_points').get() as { n: number }).n, 2);
  // 旧版默认的 55p（来源未核实）不保留；改用样板公司费率 45p
  const rates = raw.prepare('SELECT * FROM rate_versions').all() as Record<string, unknown>[];
  assert.deepEqual(rates.map((r) => r.first_pence), [45]);
  const keys = (raw.prepare('SELECT key FROM settings').all() as { key: string }[]).map((r) => r.key);
  assert.deepEqual(keys, ['employeeName']);
  // 再次运行迁移不会重复执行
  assert.equal(migrate(m), SCHEMA_VERSION);
  assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM rate_versions').get() as { n: number }).n, 1);
});

test('migration keeps a user-customised legacy rate as a separate version', () => {
  const raw = new DatabaseSync(':memory:');
  const m = migrationDb(raw);
  m.transaction(() => {
    MIGRATIONS[0](m);
    m.exec('PRAGMA user_version = 1');
  });
  raw.exec(`INSERT INTO settings (key, value) VALUES ('rateFirstPence','40'),('rateAfterPence','20'),('thresholdMiles','10000')`);
  migrate(m);
  const rates = raw.prepare('SELECT first_pence, label FROM rate_versions ORDER BY effective_from').all() as { first_pence: number; label: string }[];
  assert.deepEqual(rates.map((r) => r.first_pence), [45, 40]);
});

test('a failing migration rolls back and leaves the old schema intact', () => {
  const raw = new DatabaseSync(':memory:');
  const m = migrationDb(raw);
  m.transaction(() => {
    MIGRATIONS[0](m);
    m.exec('PRAGMA user_version = 1');
  });
  raw.exec('ALTER TABLE trips ADD COLUMN via TEXT'); // 制造冲突：v2 会重复添加该列
  assert.throws(() => migrate(m));
  assert.equal((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 1);
  assert.equal((raw.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'rate_versions'`).get() as { n: number }).n, 0);
});

test('concurrent GPS batches and finishing a trip: no lost points, nothing written after finish', async () => {
  freshDb();
  const { id } = await createRecordingTrip('2026-10-20', 0);
  const again = await createRecordingTrip('2026-10-20', 0);
  assert.deepEqual(again, { id, existed: true }); // 不会重复开始

  const all = drivePoints(60);
  const batches = [all.slice(0, 20), all.slice(20, 40), all.slice(40, 50)];
  // 三批后台回调与「结束」同时发生；结束之后还有一批迟到的点
  const pending = batches.map((b) => appendPoints(id, b));
  const finishing = finishTrip(id, 999_999);
  const late = appendPoints(id, all.slice(50));
  const written = await Promise.all(pending);
  const finished = await finishing;
  assert.equal(await late, 0);

  assert.deepEqual(written, [20, 20, 10]);
  const pts = await getPoints(id);
  assert.equal(pts.length, 50);
  assert.ok(pts.every((p, i) => i === 0 || p.ts > pts[i - 1].ts));
  assert.equal(finished?.status, 'completed');
  assert.equal(finished?.routeMapStatus, 'pending'); // 结束后在后台生成 OpenStreetMap 路线图
  assert.equal(finished?.endLat, pts[49].lat); // 终点 = 最后一个已保存的点
  // GPS 里程 = 已保存轨迹的长度（逐批累加没有漏算或重复）
  const t = (await getTrip(id))!;
  assert.ok(Math.abs(t.distanceGpsM - pathDistanceM(pts)) < 0.01);
  assert.equal(t.distanceM, t.distanceGpsM);
  assert.equal(await getActiveTrip(), null);
  // 重复的点（相同时间戳）不会重复写入
  assert.equal(await appendPoints(id, all.slice(0, 5)), 0);
});

test('manual edits keep GPS distance; manual trips store one-way and double once', async () => {
  freshDb();
  const { id } = await createRecordingTrip('2026-10-20', 0);
  await appendPoints(id, drivePoints(10));
  await updateTrip(id, { distanceM: 99_999, distanceEdited: true });
  await appendPoints(id, drivePoints(5, 60_000, 51.32));
  const t = (await getTrip(id))!;
  assert.equal(t.distanceM, 99_999); // 人工修正后，后续 GPS 点不覆盖申报里程
  assert.ok(t.distanceGpsM > 0 && t.distanceGpsM !== 99_999);

  const mid = await createManualTrip({
    date: '2026-10-21',
    startName: 'home',
    startAddress: null,
    endName: 'Client',
    endAddress: null,
    oneWayM: 10 * M_PER_MILE,
    roundTrip: true,
    purpose: null,
    client: null,
    notes: null,
    category: 'business',
  });
  const mt = (await getTrip(mid))!;
  assert.equal(metersToTenths(mt.distanceM), 200);
  assert.equal(metersToTenths(mt.oneWayM!), 100);
});

test('claim snapshot is saved, confirmed separately and immune to later rate changes', async () => {
  freshDb();
  const id = await createManualTrip({
    date: '2026-10-05',
    startName: 'home',
    startAddress: null,
    endName: 'Client',
    endAddress: null,
    oneWayM: 50 * M_PER_MILE,
    roundTrip: false,
    purpose: null,
    client: null,
    notes: null,
    category: 'business',
  });
  const trips = await listTrips({});
  const snap = buildClaimSnapshot({
    month: '2026-10',
    selected: trips,
    yearBusinessTrips: trips,
    manualMonths: await listMonthMiles(),
    rateVersions: await listRateVersions(),
    yearBasis: 'tax',
  });
  const claimId = await saveClaimSnapshot(snap);
  assert.equal((await getTrip(id))?.claimedAt, null); // 导出 ≠ 已报销
  await confirmClaim(claimId);
  const claimed = (await getTrip(id))!;
  assert.ok(claimed.claimedAt);
  assert.equal(claimed.claimId, claimId);

  // 之后新增费率版本：已保存的快照不变
  await addRateVersion({ effectiveFrom: '2026-01-01', firstPence: 60, afterPence: 30, thresholdMiles: 10000, label: 'later', source: null });
  const row = (await getDb().getFirstAsync<{ snapshot: string; total_pence: number }>('SELECT snapshot, total_pence FROM claims WHERE id = ?', [claimId]))!;
  assert.equal(row.total_pence, 2250);
  assert.equal(JSON.parse(row.snapshot).trips[0].firstPence, 45);

  await revokeClaim(claimId);
  assert.equal((await getTrip(id))?.claimedAt, null);
});

test('backup: round trip, validation errors, merge de-duplicates, failed restore leaves data intact', async () => {
  const raw = freshDb();
  const { id } = await createRecordingTrip('2026-10-20', 0);
  await appendPoints(id, drivePoints(12));
  await finishTrip(id);
  await updateTrip(id, { startName: 'home', endName: 'Client', via: ['Store A'] });
  await setMonthMiles('2026-07', 6142);
  const backup = await buildBackup(getDb());
  assert.equal(backup.version, 2);
  assert.equal(backup.schemaVersion, SCHEMA_VERSION);
  assert.equal(backup.counts.track_points, 12);
  const json = JSON.parse(JSON.stringify(backup));

  // 结构校验
  assert.equal(validateBackup({ app: 'other' }).ok, false);
  assert.equal(validateBackup({ ...json, version: 99 }).ok, false);
  const orphan = structuredClone(json);
  orphan.tables.track_points[0].trip_id = 12345;
  const bad = validateBackup(orphan);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.ok(bad.errors.some((e) => e.includes('所属行程不存在')));
  const dupe = structuredClone(json);
  dupe.tables.trips.push({ ...dupe.tables.trips[0] });
  assert.equal(validateBackup(dupe).ok, false);

  // 覆盖恢复到一个新数据库
  freshDb();
  await createManualTrip({ date: '2026-01-01', startName: 'x', startAddress: null, endName: 'y', endAddress: null, oneWayM: 1000, roundTrip: false, purpose: null, client: null, notes: null, category: 'personal' });
  const v = validateBackup(json);
  assert.ok(v.ok);
  if (!v.ok) return;
  const r = await restoreBackup(v.data, 'replace');
  assert.equal(r.tripsAdded, 1);
  const restored = await listTrips({});
  assert.equal(restored.length, 1);
  assert.deepEqual(restored[0].via, ['Store A']);
  assert.equal((await getPoints(restored[0].id)).length, 12);
  assert.deepEqual((await listMonthMiles()).map((m) => m.tenths), [6142]);

  // 合并：重复行程跳过，轨迹点重新关联到新 id
  const r2 = await restoreBackup(v.data, 'merge');
  assert.equal(r2.tripsAdded, 0);
  assert.equal(r2.tripsSkipped, 1);
  freshDb();
  await createManualTrip({ date: '2026-01-01', startName: 'x', startAddress: null, endName: 'y', endAddress: null, oneWayM: 1000, roundTrip: false, purpose: null, client: null, notes: null, category: 'personal' });
  const r3 = await restoreBackup(v.data, 'merge');
  assert.equal(r3.tripsAdded, 1);
  assert.equal(r3.pointsAdded, 12);
  const merged = await listTrips({});
  assert.equal(merged.length, 2);
  const gps = merged.find((t) => t.source === 'gps')!;
  assert.equal((await getPoints(gps.id)).length, 12);

  // 恢复中途失败（数据能通过校验但写入时违反 NOT NULL）→ 整体回滚，原数据不变
  const broken = structuredClone(v.data);
  broken.tables.places = [{ id: 1, name: 'ok', radius_m: null, type: 'client' }];
  await assert.rejects(restoreBackup(broken, 'replace'));
  assert.equal((await listTrips({})).length, 2);
  assert.equal((await getPoints(gps.id)).length, 12);
  void raw;
});

test('v1 backup files (tables at top level) are still accepted', () => {
  const now = Date.now();
  const v1 = {
    app: 'route-mileage',
    version: 1,
    exportedAt: '2026-10-01T00:00:00Z',
    trips: [{ id: 1, date: '2026-09-01', distance_m: 1000, source: 'manual', round_trip: 1, created_at: now, updated_at: now }],
    track_points: [],
    places: [],
    settings: [{ key: 'rateFirstPence', value: '55' }, { key: 'unit', value: 'mi' }],
  };
  const v = validateBackup(v1);
  assert.ok(v.ok);
  if (!v.ok) return;
  assert.equal(v.data.tables.trips![0].one_way_m, 500);
  assert.deepEqual(v.data.tables.settings!.map((s) => s.key), ['unit']);
  void registerDb;
  void asyncDb;
});

test('Hanshow office is added once, survives an old-backup restore, and stays deleted if the user deletes it', async () => {
  const { deletePlace, ensureDefaultPlaces, listPlaces } = await import('../src/db/places');
  freshDb();
  assert.equal(await ensureDefaultPlaces(), 1);
  assert.equal(await ensureDefaultPlaces(), 0);
  const places = await listPlaces();
  const h = places.find((p) => p.name === 'Hanshow')!;
  assert.deepEqual([h.type, h.address, h.radiusM], ['office', '85 Uxbridge Rd, London W5 5TH', 150]);
  // 用户删除后不再自动出现
  await deletePlace(h.id);
  assert.equal(await ensureDefaultPlaces(), 0);
  assert.equal((await listPlaces()).length, 0);
  // 覆盖恢复一个旧备份（没有 Hanshow、也没有标记）→ 重新补上
  const old = validateBackup({ app: 'route-mileage', version: 1, trips: [], track_points: [], places: [], settings: [{ key: 'unit', value: 'mi' }] });
  assert.ok(old.ok);
  if (!old.ok) return;
  await restoreBackup(old.data, 'replace');
  assert.equal(await ensureDefaultPlaces(), 1);
  assert.ok((await listPlaces()).some((p) => p.name === 'Hanshow'));
});
