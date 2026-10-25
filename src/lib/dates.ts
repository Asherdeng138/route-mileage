const pad = (n: number) => String(n).padStart(2, '0');
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** Date → 本地 YYYY-MM-DD */
export function toISODate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const todayISO = () => toISODate(new Date());

/** YYYY-MM-DD → 本地时间当天 00:00 的 Date */
export function parseISODate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** 2026-10-17 → 2026年10月17日 周六 */
export function formatDateLong(s: string): string {
  const d = parseISODate(s);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]}`;
}

/** 2026-10-17 → 10月17日 周六 */
export function formatDateShort(s: string): string {
  const d = parseISODate(s);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]}`;
}

/** 2026-10-17 → 17/10/2026（英国格式，报表用） */
export function formatDateUK(s: string): string {
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

export function formatTime(ms: number | null): string {
  if (ms == null) return '';
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatDuration(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h} 小时 ${m} 分` : `${m} 分钟`;
}

export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** YYYY-MM-DD → YYYY-MM */
export const monthKeyOf = (s: string) => s.slice(0, 7);

/** 2026-10 → 2026年10月 */
export function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return `${y}年${m}月`;
}

export function addMonths(key: string, n: number): string {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/** 月份的第一天和最后一天 */
export function monthRange(key: string): [string, string] {
  const [y, m] = key.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return [`${key}-01`, `${key}-${pad(last)}`];
}

/** 英国税年从 4 月 6 日开始。返回包含该日期的税年起始年份 */
export function taxYearStartYear(s: string): number {
  const [y, m, d] = s.split('-').map(Number);
  return m > 4 || (m === 4 && d >= 6) ? y : y - 1;
}

/** 税年的起止日期 [YYYY-04-06, YYYY+1-04-05] */
export function taxYearRange(s: string): [string, string] {
  const y = taxYearStartYear(s);
  return [`${y}-04-06`, `${y + 1}-04-05`];
}

/** 2026/27 */
export function taxYearLabel(s: string): string {
  const y = taxYearStartYear(s);
  return `${y}/${String((y + 1) % 100).padStart(2, '0')}`;
}

/**
 * 「本年累计」（10,000 英里分档、报表 "Takes me to … miles this year"）的年度口径：
 * - tax：英国税年，4 月 6 日 – 次年 4 月 5 日（默认，与 HMRC 分档口径一致）
 * - calendar：自然年 1 月 1 日 – 12 月 31 日
 */
export type YearBasis = 'tax' | 'calendar';

/** 日期所在累计年度的唯一键：tax-2026 / cal-2026 */
export function yearKeyOf(s: string, basis: YearBasis): string {
  return basis === 'tax' ? `tax-${taxYearStartYear(s)}` : `cal-${s.slice(0, 4)}`;
}

/** 累计年度的起止日期 */
export function yearRangeOf(s: string, basis: YearBasis): [string, string] {
  if (basis === 'tax') return taxYearRange(s);
  const y = s.slice(0, 4);
  return [`${y}-01-01`, `${y}-12-31`];
}

export function yearLabelOf(s: string, basis: YearBasis): string {
  return basis === 'tax' ? `${taxYearLabel(s)} 税年` : `${s.slice(0, 4)} 年`;
}

const MONTHS_EN = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** 2026-09 → September */
export function monthNameEn(key: string): string {
  return MONTHS_EN[Number(key.slice(5, 7)) - 1] ?? key;
}

/** 2026-09-01 → 2026/09/01（与样板一致的日期写法） */
export const formatDateSlash = (s: string) => s.replace(/-/g, '/');

/** [from, to] 之间的所有月份键（含两端） */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let k = from.slice(0, 7); k <= to.slice(0, 7); k = addMonths(k, 1)) out.push(k);
  return out;
}
