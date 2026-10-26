import assert from 'node:assert/strict';
import { test } from 'node:test';

import { amountsForRange } from '../src/db/amounts';
import { archiveCounts, archiveTrips, restoreTrips, runArchiveMaintenance, trashTrips, unarchiveTrips } from '../src/db/archive';
import { buildBackup, restoreBackup, validateBackup } from '../src/db/backupCore';
import { confirmClaim, listPendingClaims, revokeClaim, saveClaimSnapshot } from '../src/db/claims';
import { getDb } from '../src/db/core';
import { listRateVersions } from '../src/db/rates';
import { getAppSettings } from '../src/db/settings';
import { createManualTrip, getPoints, getTrip, listBusinessTrips, listTrips, setClaimed, updateTrip } from '../src/db/trips';
import { ARCHIVE_DAYS, DAY_MS, lifecycleOf, TRASH_DAYS } from '../src/lib/archive';
import { buildClaimSnapshot } from '../src/lib/claim';
import type { Category } from '../src/lib/types';
import { M_PER_MILE } from '../src/lib/units';

import { freshDb } from './helpers/nodeDb';

const T0 = Date.UTC(2026, 10, 1, 9);

function trip(date: string, miles: number, category: Category = 'business', name = 'Client') {
  return createManualTrip({
    date,
    startName: 'home',
    startAddress: null,
    endName: name,
    endAddress: '1 High St',
    oneWayM: miles * M_PER_MILE,
    roundTrip: false,
    purpose: 'visit',
    client: name,
    notes: 'secret note',
    category,
  });
}

const ids = (list: { id: number }[]) => list.map((t) => t.id).sort((a, b) => a - b);

test('archive: reimbursed trips move to the archive at once; only reimbursed trips can be archived; ledger unchanged', async () => {
  freshDb();
  const claimed = await trip('2026-09-10', 9_990);
  const unclaimed = await trip('2026-09-12', 5);
  const personal = await trip('2026-09-13', 3, 'personal');
  const october = await trip('2026-10-05', 30);
  const settings = await getAppSettings();
  const before = (await amountsForRange('2026-10-01', '2026-10-31', settings)).get(october);

  await setClaimed([claimed], true); // 标记已报销 = 立即移到「归档」
  assert.ok((await getTrip(claimed))?.archivedAt);
  assert.equal(await archiveTrips([claimed, unclaimed, personal]), 0); // 未报销的不能归档；已报销的已经在归档里
  assert.deepEqual(ids(await listTrips({ from: '2026-09-01', to: '2026-09-30' })), [unclaimed, personal].sort((a, b) => a - b));
  assert.deepEqual(ids(await listTrips({ view: 'archived' })), [claimed]);
  assert.deepEqual(await archiveCounts(), { archived: 1, trash: 0 });
  assert.ok(ids(await listBusinessTrips('2026-04-06', '2027-04-05')).includes(claimed));

  const after = (await amountsForRange('2026-10-01', '2026-10-31', settings)).get(october);
  assert.deepEqual(after, before);
  assert.equal(after?.cumulativeBeforeTenths, 99_950); // 9,990 + 5 英里（未报销但仍在列表里的也算）

  // 撤销已报销：回到行程列表（和报表）
  await setClaimed([claimed], false);
  assert.equal((await getTrip(claimed))?.archivedAt, null);
  assert.ok(ids(await listTrips({ from: '2026-09-01', to: '2026-09-30' })).includes(claimed));
  // unarchiveTrips 仍可用（例如数据修复）
  await setClaimed([claimed], true);
  await unarchiveTrips([claimed]);
  assert.ok(ids(await listTrips({ from: '2026-09-01', to: '2026-09-30' })).includes(claimed));
});

test('archive: confirming a claim archives its trips; maintenance archives older reimbursed trips still in the list', async () => {
  freshDb();
  const settings = await getAppSettings();
  const rateVersions = await listRateVersions();
  const a = await trip('2026-10-01', 10);
  const b = await trip('2026-10-02', 20);
  const sel = await listBusinessTrips('2026-04-06', '2026-10-31');
  const claimId = await saveClaimSnapshot(
    buildClaimSnapshot({ month: '2026-10', selected: sel, yearBusinessTrips: sel, manualMonths: [], rateVersions, yearBasis: settings.yearBasis }),
  );
  await confirmClaim(claimId);
  assert.deepEqual(ids(await listTrips({ view: 'archived' })), [a, b].sort((x, y) => x - y));
  assert.deepEqual(ids(await listTrips()), []); // 报表 / 行程列表里不再出现

  // 1.7.0 「只确认」留下的：已报销但没归档 → 打开 App 时归档
  await revokeClaim(claimId);
  await getDb().runAsync('UPDATE trips SET claimed_at = ?, archived_at = NULL WHERE id = ?', [T0, a]);
  assert.deepEqual(ids(await listTrips()), [a, b].sort((x, y) => x - y));
  await runArchiveMaintenance(T0 + DAY_MS);
  assert.equal((await getTrip(a))?.archivedAt, T0 + DAY_MS);
  assert.equal((await getTrip(b))?.archivedAt, null); // 未报销的不动
});

test('archive: 30 days archived → recently deleted → 30 more days → purged, keeping only the mileage of claimed trips', async () => {
  freshDb();
  const claimed = await trip('2026-09-10', 9_990);
  const october = await trip('2026-10-05', 30);
  // 手动行程不经 appendPoints 接受轨迹点（不是记录中），这里直接写入一条，检查永久删除会清掉
  await getDb().runAsync('INSERT INTO track_points (trip_id, lat, lng, ts) VALUES (?, 51.3, -0.75, 1)', [claimed]);
  await updateTrip(claimed, { mapImageUri: 'file:///shot.jpg', mapImageW: 10, mapImageH: 10 });
  await setClaimed([claimed], true);
  const settings = await getAppSettings();
  const before = (await amountsForRange('2026-10-01', '2026-10-31', settings)).get(october);

  await getDb().runAsync('UPDATE trips SET archived_at = ? WHERE id = ?', [T0, claimed]); // 归档时间固定为 T0
  assert.deepEqual(await runArchiveMaintenance(T0 + (ARCHIVE_DAYS - 1) * DAY_MS), { trashed: 0, purged: 0, files: [] });

  const moveAt = T0 + ARCHIVE_DAYS * DAY_MS + 1;
  assert.deepEqual(await runArchiveMaintenance(moveAt), { trashed: 1, purged: 0, files: [] });
  const trashed = await getTrip(claimed);
  assert.equal(trashed?.deletedAt, moveAt);
  assert.deepEqual(lifecycleOf(trashed!, moveAt), { state: 'trash', daysLeft: TRASH_DAYS });
  assert.deepEqual(ids(await listTrips({ view: 'trash' })), [claimed]);
  assert.deepEqual(ids(await listTrips({ view: 'archived' })), []);

  // 最近删除满 30 天：永久删除，只留里程记录
  const r = await runArchiveMaintenance(moveAt + TRASH_DAYS * DAY_MS);
  assert.deepEqual(r, { trashed: 0, purged: 1, files: ['file:///shot.jpg'] });
  const stub = await getTrip(claimed);
  assert.ok(stub?.purgedAt);
  assert.equal(stub?.startName, null);
  assert.equal(stub?.endAddress, null);
  assert.equal(stub?.notes, null);
  assert.equal(stub?.purpose, null);
  assert.equal(stub?.mapImageUri, null);
  assert.ok(Math.abs((stub?.distanceM ?? 0) - 9_990 * M_PER_MILE) < 1e-6);
  assert.equal((await getPoints(claimed)).length, 0);
  assert.deepEqual(ids(await listTrips({ view: 'trash' })), []);
  assert.deepEqual(ids(await listTrips()), [october]);

  // 年度累计和 10,000 英里分档完全不变
  assert.deepEqual((await amountsForRange('2026-10-01', '2026-10-31', settings)).get(october), before);
  // 再次执行不会重复处理
  assert.deepEqual(await runArchiveMaintenance(moveAt + 100 * DAY_MS), { trashed: 0, purged: 0, files: [] });
});

test('archive: deleted trips can be restored within 30 days; unclaimed deleted trips leave the ledger and are fully removed', async () => {
  freshDb();
  const a = await trip('2026-10-01', 12);
  const b = await trip('2026-10-02', 8, 'personal');
  await trashTrips([a, b], T0);
  assert.deepEqual(ids(await listTrips()), []);
  assert.deepEqual(ids(await listBusinessTrips('2026-10-01', '2026-10-31')), []); // 未报销就删除：不计入累计

  await restoreTrips([b]);
  assert.deepEqual(ids(await listTrips()), [b]);

  const r = await runArchiveMaintenance(T0 + TRASH_DAYS * DAY_MS);
  assert.equal(r.purged, 1);
  assert.equal(await getTrip(a), null); // 整条删除
  assert.ok(await getTrip(b));
});

test('archive: revoking a claim un-archives its trips but never un-claims purged mileage', async () => {
  freshDb();
  const x = await trip('2026-10-01', 10);
  const y = await trip('2026-10-02', 20);
  const settings = await getAppSettings();
  const businessTrips = await listBusinessTrips('2026-04-06', '2026-10-31');
  const rateVersions = await listRateVersions();
  const snap = buildClaimSnapshot({
    month: '2026-10',
    selected: businessTrips,
    yearBusinessTrips: businessTrips,
    manualMonths: [],
    rateVersions,
    yearBasis: settings.yearBasis,
  });
  const claimId = await saveClaimSnapshot(snap);
  await confirmClaim(claimId);
  await archiveTrips([x, y], T0);
  await trashTrips([x], T0);
  await runArchiveMaintenance(T0 + TRASH_DAYS * DAY_MS); // x 永久删除（留里程），y 移到最近删除

  await revokeClaim(claimId);
  const stub = await getTrip(x);
  assert.ok(stub?.purgedAt && stub.claimedAt, 'purged mileage stays claimed');
  const yy = await getTrip(y);
  assert.equal(yy?.claimedAt, null);
  assert.equal(yy?.archivedAt, null);
});

test('archive: lifecycle state and days left', () => {
  const base = { status: 'completed' as const, claimedAt: null, archivedAt: null, deletedAt: null, purgedAt: null };
  assert.deepEqual(lifecycleOf(base, T0), { state: 'active', canArchive: false });
  assert.deepEqual(lifecycleOf({ ...base, claimedAt: T0 }, T0), { state: 'active', canArchive: true });
  assert.deepEqual(lifecycleOf({ ...base, claimedAt: T0, archivedAt: T0 }, T0 + 12 * DAY_MS + 1), { state: 'archived', daysLeft: 18 });
  assert.deepEqual(lifecycleOf({ ...base, deletedAt: T0 }, T0 + 40 * DAY_MS), { state: 'trash', daysLeft: 0 });
  assert.deepEqual(lifecycleOf({ ...base, deletedAt: T0, purgedAt: T0 }, T0), { state: 'purged' });
});

test('archive: backup round trip keeps archive state', async () => {
  freshDb();
  const a = await trip('2026-10-01', 12);
  await setClaimed([a], true);
  await getDb().runAsync('UPDATE trips SET archived_at = ? WHERE id = ?', [T0, a]);
  const backup = await buildBackup(getDb());
  freshDb();
  const v = validateBackup(JSON.parse(JSON.stringify(backup)));
  assert.ok(v.ok);
  await restoreBackup(v.data, 'replace');
  assert.equal((await getTrip(a))?.archivedAt, T0);
});

test('pending claims: all months, newest of identical re-exports, gone once confirmed or all trips deleted', async () => {
  freshDb();
  const settings = await getAppSettings();
  const rateVersions = await listRateVersions();
  const snap = async (month: string, ids: number[]) => {
    const trips = (await listBusinessTrips('2026-04-06', '2027-04-05')).filter((t) => ids.includes(t.id));
    return saveClaimSnapshot(
      buildClaimSnapshot({ month, selected: trips, yearBusinessTrips: trips, manualMonths: [], rateVersions, yearBasis: settings.yearBasis }),
    );
  };
  const sep = [await trip('2026-09-03', 10), await trip('2026-09-04', 12)];
  const oct = [await trip('2026-10-02', 8)];
  const sepOld = await snap('2026-09', sep);
  const sepNew = await snap('2026-09', sep); // 同一个月重新导出了一次
  const octClaim = await snap('2026-10', oct);

  assert.deepEqual((await listPendingClaims()).map((c) => c.id), [octClaim, sepNew]);

  await confirmClaim(sepNew); // 9 月报销了：旧的那份也不再提醒（行程都已报销）
  assert.deepEqual((await listPendingClaims()).map((c) => c.id), [octClaim]);
  assert.ok(!(await listPendingClaims()).some((c) => c.id === sepOld));

  await trashTrips(oct); // 10 月的行程都删了：这份导出不再等待报销
  assert.deepEqual(await listPendingClaims(), []);
});
