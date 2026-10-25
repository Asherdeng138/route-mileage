/**
 * 归档与自动删除的规则（纯函数，可测试）：
 *
 *   已报销 ──归档──▶ 已归档 ──30 天──▶ 最近删除（可恢复） ──30 天──▶ 永久删除
 *
 * - 只有已报销的行程可以归档。归档后从行程列表、首页、报表的选择列表隐藏。
 * - 用户手动删除的行程也先进「最近删除」，30 天内可以恢复。
 * - 永久删除：轨迹点、地址、事由、截图、路线图全部删除。已报销的公务行程只保留
 *   日期、时间、里程（不含任何地点），用于本年累计和 10,000 英里分档，界面上不再显示；
 *   其他行程整条删除。
 * - 报销快照（报表里的「导出记录」）不删除，可以随时重新生成当月的 Word / Excel（已删除的路线图不再附带）。
 */
import type { Trip } from './types';

export const DAY_MS = 24 * 60 * 60 * 1000;
/** 归档多少天后移到「最近删除」 */
export const ARCHIVE_DAYS = 30;
/** 在「最近删除」保留多少天后永久删除 */
export const TRASH_DAYS = 30;

export type Lifecycle =
  | { state: 'active'; canArchive: boolean }
  | { state: 'archived'; daysLeft: number }
  | { state: 'trash'; daysLeft: number }
  | { state: 'purged' };

/** 剩余天数（向上取整，最少 0） */
const daysUntil = (due: number, now: number) => Math.max(0, Math.ceil((due - now) / DAY_MS));

export function lifecycleOf(t: Pick<Trip, 'status' | 'claimedAt' | 'archivedAt' | 'deletedAt' | 'purgedAt'>, now = Date.now()): Lifecycle {
  if (t.purgedAt != null) return { state: 'purged' };
  if (t.deletedAt != null) return { state: 'trash', daysLeft: daysUntil(t.deletedAt + TRASH_DAYS * DAY_MS, now) };
  if (t.archivedAt != null) return { state: 'archived', daysLeft: daysUntil(t.archivedAt + ARCHIVE_DAYS * DAY_MS, now) };
  return { state: 'active', canArchive: t.status === 'completed' && t.claimedAt != null };
}

/** 永久删除后是否保留里程记录（已报销的公务行程才保留，保证年度累计不变） */
export const keepsLedgerStub = (t: Pick<Trip, 'category' | 'claimedAt'>) => t.category === 'business' && t.claimedAt != null;
