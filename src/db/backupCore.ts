/**
 * 备份 / 恢复的数据处理（不涉及文件和界面，可在 Node 测试）。
 *
 * - 备份带格式版本和数据库结构版本。
 * - 导入前完整校验结构和关联（轨迹点必须属于备份里的行程、id 不重复、日期格式正确…）。
 * - 导入在一个事务中完成：任何一步失败都会整体回滚，不会留下半套数据。
 * - 支持「覆盖」（清空后恢复）和「合并」（保留现有数据，只添加备份里没有的行程 / 地点）。
 */
import { SCHEMA_VERSION, write, type Db, type SqlValue } from './core';

export const BACKUP_APP = 'route-mileage';
export const BACKUP_VERSION = 2;

export const BACKUP_TABLES = [
  'trips',
  'track_points',
  'trip_gaps',
  'places',
  'settings',
  'rate_versions',
  'claims',
  'month_miles',
] as const;
export type BackupTable = (typeof BACKUP_TABLES)[number];

type Row = Record<string, unknown>;

export interface BackupFile {
  app: typeof BACKUP_APP;
  version: number;
  schemaVersion: number;
  exportedAt: string;
  counts: Partial<Record<BackupTable, number>>;
  tables: Partial<Record<BackupTable, Row[]>>;
}

export async function buildBackup(db: Db, now = new Date()): Promise<BackupFile> {
  const tables: BackupFile['tables'] = {};
  const counts: BackupFile['counts'] = {};
  for (const t of BACKUP_TABLES) {
    const rows = await db.getAllAsync<Row>(`SELECT * FROM ${t}`);
    tables[t] = rows;
    counts[t] = rows.length;
  }
  return { app: BACKUP_APP, version: BACKUP_VERSION, schemaVersion: SCHEMA_VERSION, exportedAt: now.toISOString(), counts, tables };
}

export interface ValidatedBackup {
  version: number;
  exportedAt: string | null;
  tables: Partial<Record<BackupTable, Row[]>>;
  counts: Record<BackupTable, number>;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v);
const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const RATE_SETTING_KEYS = ['rateFirstPence', 'rateAfterPence', 'thresholdMiles'];

/** 校验并规范化备份内容。返回错误列表（为空表示可以导入） */
export function validateBackup(raw: unknown): { ok: true; data: ValidatedBackup } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['文件内容不是 JSON 对象'] };
  const o = raw as Record<string, unknown>;
  if (o.app !== BACKUP_APP) return { ok: false, errors: ['这不是本 App 导出的备份文件'] };
  const version = Number(o.version);
  if (!Number.isInteger(version) || version < 1) return { ok: false, errors: ['备份缺少版本信息'] };
  if (version > BACKUP_VERSION) return { ok: false, errors: [`备份格式版本 ${version} 比当前 App 新，请先升级 App`] };
  if (version >= 2 && Number(o.schemaVersion) > SCHEMA_VERSION) {
    return { ok: false, errors: ['备份来自更新版本的 App，请先升级 App'] };
  }

  // v1：各表直接放在顶层
  const src = (version === 1 ? o : (o.tables as Record<string, unknown>)) ?? {};
  const tables: ValidatedBackup['tables'] = {};
  for (const t of BACKUP_TABLES) {
    const v = (src as Record<string, unknown>)[t];
    if (v == null) continue;
    if (!Array.isArray(v) || v.some((r) => !r || typeof r !== 'object' || Array.isArray(r))) {
      errors.push(`表 ${t} 的格式不正确`);
      continue;
    }
    tables[t] = v as Row[];
  }
  if (!tables.trips) errors.push('备份里没有行程数据（trips）');

  const tripIds = new Set<number>();
  (tables.trips ?? []).forEach((r, i) => {
    const at = `行程第 ${i + 1} 条`;
    if (!isInt(r.id)) errors.push(`${at}：id 无效`);
    else if (tripIds.has(r.id as number)) errors.push(`${at}：id ${r.id} 重复`);
    else tripIds.add(r.id as number);
    if (typeof r.date !== 'string' || !DATE_RE.test(r.date)) errors.push(`${at}：日期格式不正确`);
    if (!isNum(r.distance_m) || (r.distance_m as number) < 0) errors.push(`${at}：里程无效`);
    if (!isInt(r.created_at) || !isInt(r.updated_at)) errors.push(`${at}：缺少创建 / 更新时间`);
  });
  (tables.trip_gaps ?? []).forEach((r, i) => {
    const at = `补算路段第 ${i + 1} 条`;
    if (!isInt(r.trip_id) || !tripIds.has(r.trip_id as number)) errors.push(`${at}：所属行程不存在`);
    if (!isInt(r.start_ts) || !isInt(r.end_ts) || !isNum(r.straight_m)) errors.push(`${at}：字段无效`);
  });
  const pointIds = new Set<number>();
  (tables.track_points ?? []).forEach((r, i) => {
    const at = `轨迹点第 ${i + 1} 条`;
    if (!isInt(r.trip_id) || !tripIds.has(r.trip_id as number)) errors.push(`${at}：所属行程不存在`);
    if (!isNum(r.lat) || !isNum(r.lng) || !isInt(r.ts)) errors.push(`${at}：坐标或时间无效`);
    if (r.id != null) {
      if (!isInt(r.id) || pointIds.has(r.id as number)) errors.push(`${at}：id 无效或重复`);
      else pointIds.add(r.id as number);
    }
  });
  (tables.places ?? []).forEach((r, i) => {
    if (typeof r.name !== 'string' || !r.name.trim()) errors.push(`常用地点第 ${i + 1} 条：缺少名称`);
  });
  (tables.settings ?? []).forEach((r, i) => {
    if (typeof r.key !== 'string') errors.push(`设置第 ${i + 1} 条：缺少 key`);
  });
  (tables.rate_versions ?? []).forEach((r, i) => {
    if (typeof r.effective_from !== 'string' || !DATE_RE.test(r.effective_from) || !isNum(r.first_pence) || !isNum(r.after_pence) || !isNum(r.threshold_miles)) {
      errors.push(`费率版本第 ${i + 1} 条：字段无效`);
    }
  });
  (tables.claims ?? []).forEach((r, i) => {
    let ids: unknown;
    try {
      ids = JSON.parse(String(r.trip_ids));
      JSON.parse(String(r.snapshot));
    } catch {
      errors.push(`报销记录第 ${i + 1} 条：内容损坏`);
      return;
    }
    if (!Array.isArray(ids)) errors.push(`报销记录第 ${i + 1} 条：行程列表无效`);
  });
  (tables.month_miles ?? []).forEach((r, i) => {
    if (typeof r.month !== 'string' || !/^\d{4}-\d{2}$/.test(r.month) || !isInt(r.tenths)) {
      errors.push(`往月里程第 ${i + 1} 条：字段无效`);
    }
  });

  if (errors.length) return { ok: false, errors: errors.slice(0, 12) };

  // 规范化 v1：旧设置里的费率已迁到 rate_versions，旧手动行程补上单程里程
  if (tables.settings) tables.settings = tables.settings.filter((r) => !RATE_SETTING_KEYS.includes(String(r.key)));
  if (version === 1 && tables.trips) {
    tables.trips = tables.trips.map((r) =>
      r.source === 'manual' && r.one_way_m == null
        ? { ...r, one_way_m: r.round_trip ? (r.distance_m as number) / 2 : r.distance_m }
        : r,
    );
  }

  const counts = Object.fromEntries(BACKUP_TABLES.map((t) => [t, tables[t]?.length ?? 0])) as Record<BackupTable, number>;
  return { ok: true, data: { version, exportedAt: typeof o.exportedAt === 'string' ? o.exportedAt : null, tables, counts } };
}

async function tableColumns(db: Db, table: string): Promise<Set<string>> {
  const rows = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`);
  return new Set(rows.map((r) => r.name));
}

async function insertRow(db: Db, table: string, cols: Set<string>, row: Row, omit: string[] = []): Promise<number> {
  const keys = Object.keys(row).filter((k) => cols.has(k) && !omit.includes(k));
  if (!keys.length) return 0;
  const values = keys.map((k) => {
    const v = row[k];
    return v == null ? null : typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'object' ? JSON.stringify(v) : (v as SqlValue);
  });
  const res = await db.runAsync(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, values);
  return res.lastInsertRowId;
}

export interface RestoreResult {
  mode: 'replace' | 'merge';
  tripsAdded: number;
  tripsSkipped: number;
  pointsAdded: number;
  placesAdded: number;
}

/**
 * 恢复备份。replace：清空备份中包含的表再写入；merge：保留现有数据，只添加新的行程 / 地点 / 往月里程。
 * 整个过程是一个事务，失败自动回滚。
 */
export function restoreBackup(data: ValidatedBackup, mode: 'replace' | 'merge'): Promise<RestoreResult> {
  return write(async (db) => {
    const result: RestoreResult = { mode, tripsAdded: 0, tripsSkipped: 0, pointsAdded: 0, placesAdded: 0 };
    const cols = new Map<string, Set<string>>();
    for (const t of BACKUP_TABLES) cols.set(t, await tableColumns(db, t));
    const T = data.tables;

    if (mode === 'replace') {
      // 子表先删；备份中没有的表（例如 v1 备份没有费率版本）保持现状
      for (const t of [...BACKUP_TABLES].reverse()) if (T[t]) await db.runAsync(`DELETE FROM ${t}`);
      // 旧备份没有补算路段表：行程被替换后，旧的补算路段也必须清掉（否则会挂到新行程上）
      if (T.trips && !T.trip_gaps) await db.runAsync('DELETE FROM trip_gaps');
      for (const t of BACKUP_TABLES) {
        for (const row of T[t] ?? []) await insertRow(db, t, cols.get(t)!, row);
      }
      result.tripsAdded = T.trips?.length ?? 0;
      result.pointsAdded = T.track_points?.length ?? 0;
      result.placesAdded = T.places?.length ?? 0;
    } else {
      const existing = await db.getAllAsync<{ date: string; start_time: number | null; source: string; distance_m: number }>(
        'SELECT date, start_time, source, distance_m FROM trips',
      );
      const key = (r: { date: unknown; start_time: unknown; source: unknown; distance_m: unknown }) =>
        `${r.date}|${r.start_time ?? ''}|${r.source}|${Math.round(Number(r.distance_m))}`;
      const seen = new Set(existing.map(key));
      const idMap = new Map<number, number>();
      for (const row of T.trips ?? []) {
        if (seen.has(key(row as never))) {
          result.tripsSkipped++;
          continue;
        }
        // 合并时不带入旧的报销快照关联；「已报销」时间保留
        const newId = await insertRow(db, 'trips', cols.get('trips')!, { ...row, claim_id: null }, ['id']);
        idMap.set(row.id as number, newId);
        seen.add(key(row as never));
        result.tripsAdded++;
      }
      for (const row of T.track_points ?? []) {
        const tripId = idMap.get(row.trip_id as number);
        if (tripId == null) continue;
        await insertRow(db, 'track_points', cols.get('track_points')!, { ...row, trip_id: tripId }, ['id']);
        result.pointsAdded++;
      }
      for (const row of T.trip_gaps ?? []) {
        const tripId = idMap.get(row.trip_id as number);
        if (tripId != null) await insertRow(db, 'trip_gaps', cols.get('trip_gaps')!, { ...row, trip_id: tripId }, ['id']);
      }
      const placeNames = new Set((await db.getAllAsync<{ name: string }>('SELECT name FROM places')).map((r) => r.name));
      for (const row of T.places ?? []) {
        if (placeNames.has(String(row.name))) continue;
        await insertRow(db, 'places', cols.get('places')!, row, ['id']);
        placeNames.add(String(row.name));
        result.placesAdded++;
      }
      const months = new Set((await db.getAllAsync<{ month: string }>('SELECT month FROM month_miles')).map((r) => r.month));
      for (const row of T.month_miles ?? []) {
        if (!months.has(String(row.month))) await insertRow(db, 'month_miles', cols.get('month_miles')!, row);
      }
      const rates = await db.getAllAsync<Row>('SELECT effective_from, first_pence, after_pence, threshold_miles FROM rate_versions');
      const rateKey = (r: Row) => `${r.effective_from}|${r.first_pence}|${r.after_pence}|${r.threshold_miles}`;
      const rateKeys = new Set(rates.map(rateKey));
      for (const row of T.rate_versions ?? []) {
        if (!rateKeys.has(rateKey(row))) await insertRow(db, 'rate_versions', cols.get('rate_versions')!, row, ['id']);
      }
    }

    const broken = await db.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM track_points WHERE trip_id NOT IN (SELECT id FROM trips)',
    );
    if ((broken?.n ?? 0) > 0) throw new Error('恢复后发现轨迹点没有对应的行程，已取消恢复');
    const rateCount = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM rate_versions');
    if ((rateCount?.n ?? 0) === 0) throw new Error('恢复后没有任何费率版本，已取消恢复');
    return result;
  });
}
