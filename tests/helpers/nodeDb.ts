/**
 * 测试用：用 Node 自带的 node:sqlite 实现 App 的 Db 接口（内存数据库）。
 * 每个异步调用之间插入一次事件循环让步，模拟 expo-sqlite 的异步交错，暴露并发问题。
 */
import { DatabaseSync } from 'node:sqlite';

import { migrate, registerDb, type Db, type MigrationDb, type SqlValue } from '../../src/db/core';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

export function migrationDb(raw: DatabaseSync): MigrationDb {
  return {
    exec: (sql) => raw.exec(sql),
    all: <T>(sql: string, params: SqlValue[] = []) => raw.prepare(sql).all(...params) as T[],
    run: (sql, params = []) => {
      raw.prepare(sql).run(...params);
    },
    transaction: (fn) => {
      raw.exec('BEGIN');
      try {
        fn();
        raw.exec('COMMIT');
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

export function asyncDb(raw: DatabaseSync): Db {
  return {
    async execAsync(sql) {
      await tick();
      raw.exec(sql);
    },
    async runAsync(sql, params = []) {
      await tick();
      const r = raw.prepare(sql).run(...params);
      return { lastInsertRowId: Number(r.lastInsertRowid), changes: Number(r.changes) };
    },
    async getFirstAsync<T>(sql: string, params: SqlValue[] = []) {
      await tick();
      return (raw.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    async getAllAsync<T>(sql: string, params: SqlValue[] = []) {
      await tick();
      return raw.prepare(sql).all(...params) as T[];
    },
    async withTransactionAsync(fn) {
      raw.exec('BEGIN');
      try {
        await fn();
        raw.exec('COMMIT');
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

/** 新建一个已迁移到最新版本的内存数据库并注册为 App 数据库 */
export function freshDb(): DatabaseSync {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  migrate(migrationDb(raw));
  registerDb(() => asyncDb(raw));
  return raw;
}
