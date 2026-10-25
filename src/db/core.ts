/**
 * 数据库抽象与迁移（不依赖 expo-sqlite，App 与 Node 测试共用）。
 *
 * App 运行时由 src/db/database.ts 注册 expo-sqlite 连接；测试时注册 node:sqlite 连接。
 * 所有写操作都经过 write() 串行执行：后台定位回调、结束行程、编辑、导入备份不会交错，
 * 一个写事务失败会整体回滚。
 */
import { COMPANY_TEMPLATE_RATE } from '@/lib/rates';

export type SqlValue = string | number | null;

export interface RunResult {
  lastInsertRowId: number;
  changes: number;
}

/** 本项目用到的 SQLite 异步接口（expo-sqlite SQLiteDatabase 的子集） */
export interface Db {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, params?: SqlValue[]): Promise<RunResult>;
  getFirstAsync<T>(sql: string, params?: SqlValue[]): Promise<T | null>;
  getAllAsync<T>(sql: string, params?: SqlValue[]): Promise<T[]>;
  /** 在同一连接上执行事务（调用方必须已经在 write() 队列里） */
  withTransactionAsync(fn: () => Promise<void>): Promise<void>;
}

/** 迁移用的同步接口（打开数据库时执行） */
export interface MigrationDb {
  exec(sql: string): void;
  all<T>(sql: string, params?: SqlValue[]): T[];
  run(sql: string, params?: SqlValue[]): void;
  transaction(fn: () => void): void;
}

let provider: (() => Db) | null = null;
let instance: Db | null = null;

export function registerDb(open: () => Db) {
  provider = open;
  instance = null;
}

export function getDb(): Db {
  if (!instance) {
    if (!provider) throw new Error('数据库尚未初始化');
    instance = provider();
  }
  return instance;
}

let queue: Promise<unknown> = Promise.resolve();

/** 串行执行写操作，fn 在一个事务里运行，出错整体回滚 */
export function write<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const db = getDb();
    let result!: T;
    await db.withTransactionAsync(async () => {
      result = await fn(db);
    });
    return result;
  });
  queue = run.catch(() => undefined);
  return run;
}

/** 等待已排队的写操作全部完成 */
export function flushWrites(): Promise<void> {
  return queue.then(() => undefined);
}

// ---------- 迁移 ----------

const V1 = `
  CREATE TABLE IF NOT EXISTS trips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    start_time INTEGER,
    end_time INTEGER,
    start_name TEXT, start_address TEXT, start_lat REAL, start_lng REAL,
    end_name TEXT, end_address TEXT, end_lat REAL, end_lng REAL,
    distance_gps_m REAL NOT NULL DEFAULT 0,
    distance_m REAL NOT NULL DEFAULT 0,
    distance_edited INTEGER NOT NULL DEFAULT 0,
    purpose TEXT, client TEXT, notes TEXT,
    category TEXT NOT NULL DEFAULT 'business',
    source TEXT NOT NULL DEFAULT 'manual',
    status TEXT NOT NULL DEFAULT 'completed',
    round_trip INTEGER NOT NULL DEFAULT 0,
    claimed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_trips_date ON trips(date);
  CREATE INDEX IF NOT EXISTS idx_trips_status ON trips(status);

  CREATE TABLE IF NOT EXISTS track_points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    ts INTEGER NOT NULL,
    accuracy REAL,
    speed REAL
  );
  CREATE INDEX IF NOT EXISTS idx_points_trip ON track_points(trip_id, ts);

  CREATE TABLE IF NOT EXISTS places (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    address TEXT,
    lat REAL,
    lng REAL,
    radius_m REAL NOT NULL DEFAULT 150,
    type TEXT NOT NULL DEFAULT 'client'
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`;

const V2 = `
  ALTER TABLE trips ADD COLUMN one_way_m REAL;
  ALTER TABLE trips ADD COLUMN via TEXT;
  ALTER TABLE trips ADD COLUMN report_desc TEXT;
  ALTER TABLE trips ADD COLUMN geocode_status TEXT NOT NULL DEFAULT 'ok';
  ALTER TABLE trips ADD COLUMN commute_confirmed INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE trips ADD COLUMN map_image TEXT;
  ALTER TABLE trips ADD COLUMN map_image_w INTEGER;
  ALTER TABLE trips ADD COLUMN map_image_h INTEGER;
  ALTER TABLE trips ADD COLUMN claim_id INTEGER;
  CREATE INDEX IF NOT EXISTS idx_trips_category_date ON trips(category, date);

  -- 旧版手动补录：distance_m 已经是往返合计，单程 = 合计 / 2
  UPDATE trips SET one_way_m = CASE WHEN round_trip = 1 THEN distance_m / 2 ELSE distance_m END
    WHERE source = 'manual';

  CREATE TABLE IF NOT EXISTS rate_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    effective_from TEXT NOT NULL,
    first_pence REAL NOT NULL,
    after_pence REAL NOT NULL,
    threshold_miles REAL NOT NULL,
    label TEXT NOT NULL,
    source TEXT,
    created_at INTEGER NOT NULL
  );

  -- 报销快照：导出时保存完整计算结果，确认报销后不再随设置变化
  CREATE TABLE IF NOT EXISTS claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'exported',
    created_at INTEGER NOT NULL,
    confirmed_at INTEGER,
    trip_ids TEXT NOT NULL,
    total_tenths INTEGER NOT NULL,
    total_pence INTEGER NOT NULL,
    snapshot TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_claims_month ON claims(month);

  -- 使用 App 之前月份的公务里程（用于「本年累计」和 10,000 英里分档）
  CREATE TABLE IF NOT EXISTS month_miles (
    month TEXT PRIMARY KEY,
    tenths INTEGER NOT NULL,
    note TEXT,
    updated_at INTEGER NOT NULL
  );
`;

function migrateV2(d: MigrationDb) {
  d.exec(V2);
  // 费率：旧版把费率存在 settings（默认 55p，来源未核实）。
  // 用户曾手动保存过且与公司样板不同 → 保留为一个版本并提示核对；否则使用样板费率。
  const old = new Map(
    d.all<{ key: string; value: string }>(
      `SELECT key, value FROM settings WHERE key IN ('rateFirstPence','rateAfterPence','thresholdMiles')`,
    ).map((r) => [r.key, Number(r.value)]),
  );
  const now = Date.now();
  const insert = (v: typeof COMPANY_TEMPLATE_RATE) =>
    d.run(
      `INSERT INTO rate_versions (effective_from, first_pence, after_pence, threshold_miles, label, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [v.effectiveFrom, v.firstPence, v.afterPence, v.thresholdMiles, v.label, v.source, now],
    );
  insert(COMPANY_TEMPLATE_RATE);
  const first = old.get('rateFirstPence');
  const after = old.get('rateAfterPence');
  const threshold = old.get('thresholdMiles');
  if (
    old.size === 3 &&
    [first, after, threshold].every((v) => Number.isFinite(v)) &&
    !(first === 45 && after === 25 && threshold === 10000) &&
    !(first === 55 && after === 25 && threshold === 10000) // 旧版默认值，非用户设定
  ) {
    insert({
      effectiveFrom: '2000-01-02',
      firstPence: first!,
      afterPence: after!,
      thresholdMiles: threshold!,
      label: '旧版设置中的费率（请核对）',
      source: '从 v1 设置迁移',
    });
  }
  d.run(`DELETE FROM settings WHERE key IN ('rateFirstPence','rateAfterPence','thresholdMiles')`);
}

const V3 = `
  -- 行程结束后自动生成的 OpenStreetMap 路线图
  ALTER TABLE trips ADD COLUMN route_map TEXT;
  ALTER TABLE trips ADD COLUMN route_map_w INTEGER;
  ALTER TABLE trips ADD COLUMN route_map_h INTEGER;
  ALTER TABLE trips ADD COLUMN route_map_status TEXT NOT NULL DEFAULT 'none';
  -- 旧的已结束 GPS 行程：联网时补生成（每次打开 App 只处理少量，避免集中下载图块）
  UPDATE trips SET route_map_status = 'pending' WHERE source = 'gps' AND status = 'completed';
`;

const V4 = `
  -- Google Maps Platform 每月调用次数（App 端上限，见 src/lib/googleQuota.ts）
  CREATE TABLE IF NOT EXISTS api_usage (
    month TEXT NOT NULL,
    api TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (month, api)
  );
`;

const V5 = `
  -- 归档与自动删除（见 src/lib/archive.ts）：
  -- archived_at 已报销后归档；deleted_at 移到「最近删除」（可恢复）；purged_at 永久删除后只留日期和里程（用于年度累计）
  ALTER TABLE trips ADD COLUMN archived_at INTEGER;
  ALTER TABLE trips ADD COLUMN deleted_at INTEGER;
  ALTER TABLE trips ADD COLUMN purged_at INTEGER;
  CREATE INDEX IF NOT EXISTS idx_trips_lifecycle ON trips(archived_at, deleted_at, purged_at);
`;

const V6 = `
  -- 信号中断补算（见 src/lib/gaps.ts、src/db/gaps.ts）
  CREATE TABLE IF NOT EXISTS trip_gaps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    start_ts INTEGER NOT NULL,
    end_ts INTEGER NOT NULL,
    straight_m REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    route_m REAL,
    route_s REAL,
    path TEXT,
    reason TEXT,
    UNIQUE (trip_id, start_ts)
  );
  -- gap_fill_m：补算增加的里程（路线 − 直线）；gap_fill_status：none / pending / done / off（已撤销）/ failed
  ALTER TABLE trips ADD COLUMN gap_fill_m REAL NOT NULL DEFAULT 0;
  ALTER TABLE trips ADD COLUMN gap_fill_status TEXT NOT NULL DEFAULT 'none';
`;

export const MIGRATIONS: ((d: MigrationDb) => void)[] = [
  (d) => d.exec(V1),
  migrateV2,
  (d) => d.exec(V3),
  (d) => d.exec(V4),
  (d) => d.exec(V5),
  (d) => d.exec(V6),
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** 逐个执行未完成的迁移，每一步在事务中完成；失败时回滚该步，旧数据保持不变 */
export function migrate(d: MigrationDb): number {
  let version = d.all<{ user_version: number }>('PRAGMA user_version')[0]?.user_version ?? 0;
  if (version > MIGRATIONS.length) {
    throw new Error(`数据库版本 ${version} 比 App 支持的 ${MIGRATIONS.length} 新，请升级 App`);
  }
  while (version < MIGRATIONS.length) {
    const step = MIGRATIONS[version];
    const next = version + 1;
    d.transaction(() => {
      step(d);
      d.exec(`PRAGMA user_version = ${next}`);
    });
    version = next;
  }
  return version;
}
