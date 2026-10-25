/** 生成一个模拟「旧版 App 导出的备份」（用于在模拟器上演练切换签名后的恢复） */
import { writeFileSync } from 'node:fs';

import { buildBackup } from '../../src/db/backupCore';
import { getDb } from '../../src/db/core';
import { appendPoints, createRecordingTrip, finishTrip, updateTrip } from '../../src/db/trips';
import { setMonthMiles } from '../../src/db/claims';

import { freshDb } from './nodeDb';

(async () => {
  freshDb();
  const t0 = Date.parse('2026-10-20T08:00:00Z');
  for (let k = 0; k < 2; k++) {
    const { id } = await createRecordingTrip(`2026-10-2${k}`, t0 + k * 86400000);
    await appendPoints(id, Array.from({ length: 40 }, (_, i) => ({ lat: 51.29 + i * 0.0007, lng: -0.75 + k * 0.01, ts: t0 + k * 86400000 + i * 5000, accuracy: 8, speed: 14 })));
    await finishTrip(id, t0 + k * 86400000 + 200000);
    await updateTrip(id, {
      startName: 'home', endName: k ? 'B&Q Farnborough' : 'Test Client', geocodeStatus: 'ok', purpose: 'SWITCH TEST',
      routeMapUri: `file:///data/user/0/com.mia.routemileage/files/route-maps/trip-${id}-old.png`, routeMapW: 960, routeMapH: 720, routeMapStatus: 'ok',
      ...(k ? { mapImageUri: `file:///data/user/0/com.mia.routemileage/files/route-images/trip-${id}-old.jpg`, mapImageW: 800, mapImageH: 600 } : {}),
    });
  }
  await setMonthMiles('2026-09', 12761);
  writeFileSync(process.argv[2], JSON.stringify(await buildBackup(getDb())));
  console.log('written', process.argv[2]);
})();
