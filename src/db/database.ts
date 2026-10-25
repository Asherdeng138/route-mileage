/**
 * 用 expo-sqlite 打开数据库并注册到 core。App 入口（index.js）最先导入本文件，
 * 前台页面和后台定位任务共用同一个连接。
 */
import * as SQLite from 'expo-sqlite';

import { migrate, registerDb, type Db, type MigrationDb, type SqlValue } from './core';

export const DB_NAME = 'route.db';

function open(): Db {
  const db = SQLite.openDatabaseSync(DB_NAME);
  db.execSync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const m: MigrationDb = {
    exec: (sql) => db.execSync(sql),
    all: <T>(sql: string, params: SqlValue[] = []) => db.getAllSync<T>(sql, params),
    run: (sql, params = []) => {
      db.runSync(sql, params);
    },
    transaction: (fn) => db.withTransactionSync(fn),
  };
  migrate(m);
  return {
    execAsync: (sql) => db.execAsync(sql),
    runAsync: (sql, params = []) => db.runAsync(sql, params),
    getFirstAsync: <T>(sql: string, params: SqlValue[] = []) => db.getFirstAsync<T>(sql, params),
    getAllAsync: <T>(sql: string, params: SqlValue[] = []) => db.getAllAsync<T>(sql, params),
    withTransactionAsync: (fn) => db.withTransactionAsync(fn),
  };
}

registerDb(open);

export { getDb } from './core';
