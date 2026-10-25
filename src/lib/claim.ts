/**
 * 月度报销快照：Word、Excel（以及补充的 PDF / CSV）都只从同一个快照生成，
 * 保证日期、行程数、里程、金额完全一致；快照存进数据库后，之后修改费率或行程也不会改变已导出的报表。
 */
import { isLikelyCommute } from './commute';
import { formatDateSlash, monthNameEn, yearLabelOf, yearRangeOf, type YearBasis } from './dates';
import { formatRatePounds, metersToTenths, milliPenceToPence } from './money';
import { computeLedger, rateForDate, type LedgerTrip, type MonthMiles, type RateBands, type RateVersion } from './rates';
import type { Place, Trip } from './types';

export const CLAIM_SCHEMA = 1;

export interface SnapshotImage {
  /**
   * attachment：用户附加的路线截图；
   * map：行程结束后自动生成的 OpenStreetMap 底图 + GPS 实际轨迹；
   * track：没有地图时由 GPS 点生成的轨迹预览（不是地图路线）
   */
  kind: 'attachment' | 'map' | 'track';
  /** 生成文件时用来取图片字节的键（附件为文件 URI，轨迹预览为 "track:<tripId>"） */
  key: string;
  width: number;
  height: number;
  mime: 'image/png' | 'image/jpeg';
}

export interface SnapshotTrip {
  tripId: number;
  date: string;
  startTime: number | null;
  description: string;
  /** 报销里程（0.1 英里） */
  tenths: number;
  /** GPS 原始里程（0.1 英里），手动补录为 null */
  gpsTenths: number | null;
  /** 信号中断按 Google 驾车路线补算的里程（0.1 英里，已含在 tenths 中）；旧快照没有此字段 */
  gapFillTenths?: number;
  source: 'gps' | 'manual';
  distanceEdited: boolean;
  roundTrip: boolean;
  purpose: string;
  client: string;
  rateVersionId: number;
  firstPence: number;
  afterPence: number;
  thresholdMiles: number;
  cumulativeBeforeTenths: number;
  firstTenths: number;
  afterTenths: number;
  /** 精确金额（千分之一便士），与 Excel 公式精确值一致 */
  milliPence: number;
  image: SnapshotImage | null;
}

export interface PreviousMonth {
  month: string;
  tenths: number;
  source: 'trips' | 'manual';
}

export interface ClaimSnapshot {
  schema: number;
  month: string;
  generatedAt: string;
  yearBasis: YearBasis;
  yearLabel: string;
  trips: SnapshotTrip[];
  monthTenths: number;
  monthMilliPence: number;
  /** 报销总额（便士）：精确金额之和四舍五入一次 */
  monthPence: number;
  /** 本累计年度内、本月之前各月的里程（新的在前，和样板顺序一致） */
  previousMonths: PreviousMonth[];
  yearTenths: number;
  rateNotes: string[];
  employeeName: string;
  companyName: string;
}

// ---------- 路线描述 ----------

export const placeLabel = (name: string | null | undefined, address: string | null | undefined) =>
  (name ?? '').trim() || (address ?? '').trim();

/** "From home to B&Q Farnborough to home"（与样板写法一致） */
export function routeDescription(t: Pick<Trip, 'reportDesc' | 'startName' | 'startAddress' | 'endName' | 'endAddress' | 'via' | 'roundTrip'>): string {
  if (t.reportDesc?.trim()) return t.reportDesc.trim().replace(/\s+/g, ' ');
  const start = placeLabel(t.startName, t.startAddress);
  const end = placeLabel(t.endName, t.endAddress);
  const stops = [start, ...t.via.map((v) => v.trim()), end].filter(Boolean);
  if (t.roundTrip && start) stops.push(start);
  if (stops.length < 2) return '';
  return `From ${stops.join(' to ')}`.replace(/\s+/g, ' ');
}

export function rateNote(r: RateBands): string {
  const n = r.thresholdMiles.toLocaleString('en-GB');
  return `First ${n} miles paid at ${formatRatePounds(r.firstPence)}, mileage after ${n} paid at ${formatRatePounds(r.afterPence)} per mile`;
}

// ---------- 导出前检查 ----------

export type IssueLevel = 'error' | 'warning';

export interface ClaimIssue {
  tripId: number;
  level: IssueLevel;
  code: 'recording' | 'no-distance' | 'no-start' | 'no-end' | 'coords-only' | 'commute' | 'no-purpose';
  message: string;
}

const COORDS_RE = /^\s*-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+\s*$/;

/** 名称 / 地址是否只是坐标文本（地址解析失败时的旧数据） */
export const isCoordsText = (s: string) => COORDS_RE.test(s);

export function validateTrip(trip: Trip, places: Place[]): ClaimIssue[] {
  const out: ClaimIssue[] = [];
  const add = (level: IssueLevel, code: ClaimIssue['code'], message: string) =>
    out.push({ tripId: trip.id, level, code, message });

  if (trip.status === 'recording') add('error', 'recording', '仍在记录中，结束后才能报销');
  if (metersToTenths(trip.distanceM) <= 0) add('error', 'no-distance', '里程为 0');
  const start = placeLabel(trip.startName, trip.startAddress);
  const end = placeLabel(trip.endName, trip.endAddress);
  if (!trip.reportDesc?.trim()) {
    if (!start) add('error', 'no-start', trip.geocodeStatus === 'ok' ? '缺少起点' : '起点地址未解析，请重试或手动填写');
    if (!end) add('error', 'no-end', trip.geocodeStatus === 'ok' ? '缺少终点' : '终点地址未解析，请重试或手动填写');
    if ((start && isCoordsText(start)) || (end && isCoordsText(end))) {
      add('error', 'coords-only', '起点 / 终点只有坐标，请填写地点名称');
    }
  }
  if (trip.category === 'business' && !trip.commuteConfirmed && isLikelyCommute(trip, places)) {
    add('warning', 'commute', '看起来是「家 ↔ 固定办公室」，请确认不是通勤');
  }
  if (trip.category === 'business' && !trip.purpose?.trim()) add('warning', 'no-purpose', '没有填写出差事由（样板不需要，可选）');
  return out;
}

// ---------- 生成快照 ----------

export interface SnapshotInput {
  month: string;
  /** 本次导出选中的行程 */
  selected: Trip[];
  /** 累计年度内（到本月月底）的全部公务行程，用于分档累计和往月里程 */
  yearBusinessTrips: Trip[];
  manualMonths: MonthMiles[];
  rateVersions: RateVersion[];
  yearBasis: YearBasis;
  employeeName?: string;
  companyName?: string;
  /** 行程是否有可用的轨迹预览（GPS 点 ≥ 2） */
  trackPreview?: (trip: Trip) => SnapshotImage | null;
  now?: Date;
}

const toLedger = (t: Trip): LedgerTrip => ({
  id: t.id,
  date: t.date,
  startTime: t.startTime,
  tenths: metersToTenths(t.distanceM),
});

export function buildClaimSnapshot(input: SnapshotInput): ClaimSnapshot {
  const { month, yearBasis } = input;
  const monthStart = `${month}-01`;
  const [yearFrom] = yearRangeOf(monthStart, yearBasis);

  // 已选行程也要参与累计（防止调用方遗漏）
  const all = new Map<number, Trip>();
  for (const t of input.yearBusinessTrips) if (t.category === 'business') all.set(t.id, t);
  for (const t of input.selected) all.set(t.id, t);
  const ledger = computeLedger([...all.values()].map(toLedger), input.manualMonths, input.rateVersions, yearBasis);

  const selected = [...input.selected].sort(
    (a, b) => a.date.localeCompare(b.date) || (a.startTime ?? 0) - (b.startTime ?? 0) || a.id - b.id,
  );
  const trips: SnapshotTrip[] = selected.map((t) => {
    const a = ledger.get(t.id)!;
    const image: SnapshotImage | null =
      t.mapImageUri && t.mapImageW && t.mapImageH
        ? {
            kind: 'attachment',
            key: t.mapImageUri,
            width: t.mapImageW,
            height: t.mapImageH,
            mime: /\.png$/i.test(t.mapImageUri) ? 'image/png' : 'image/jpeg',
          }
        : t.routeMapStatus === 'ok' && t.routeMapUri && t.routeMapW && t.routeMapH
          ? { kind: 'map', key: t.routeMapUri, width: t.routeMapW, height: t.routeMapH, mime: 'image/png' }
          : (input.trackPreview?.(t) ?? null);
    return {
      tripId: t.id,
      date: t.date,
      startTime: t.startTime,
      description: routeDescription(t),
      tenths: a.tenths,
      gpsTenths: t.source === 'gps' ? metersToTenths(t.distanceGpsM) : null,
      gapFillTenths: t.source === 'gps' && t.gapFillM > 0 ? metersToTenths(t.gapFillM) : 0,
      source: t.source,
      distanceEdited: t.distanceEdited,
      roundTrip: t.roundTrip,
      purpose: t.purpose ?? '',
      client: t.client ?? '',
      rateVersionId: a.rate.id,
      firstPence: a.rate.firstPence,
      afterPence: a.rate.afterPence,
      thresholdMiles: a.rate.thresholdMiles,
      cumulativeBeforeTenths: a.cumulativeBeforeTenths,
      firstTenths: a.split.firstTenths,
      afterTenths: a.split.afterTenths,
      milliPence: a.milliPence,
      image,
    };
  });

  const monthTenths = trips.reduce((s, t) => s + t.tenths, 0);
  const monthMilliPence = trips.reduce((s, t) => s + t.milliPence, 0);

  // 往月里程：累计年度起点到上个月；手工录入优先，否则用 App 内公务行程
  const manual = new Map(input.manualMonths.map((m) => [m.month, m.tenths]));
  const byMonth = new Map<string, number>();
  for (const t of all.values()) {
    if (t.date < yearFrom || t.date >= monthStart) continue;
    const k = t.date.slice(0, 7);
    byMonth.set(k, (byMonth.get(k) ?? 0) + metersToTenths(t.distanceM));
  }
  const previousMonths: PreviousMonth[] = [];
  for (const k of new Set([...byMonth.keys(), ...manual.keys()])) {
    if (k < yearFrom.slice(0, 7) || k >= month) continue;
    const m = manual.get(k);
    const tenths = m ?? byMonth.get(k) ?? 0;
    if (tenths > 0) previousMonths.push({ month: k, tenths, source: m != null ? 'manual' : 'trips' });
  }
  previousMonths.sort((a, b) => b.month.localeCompare(a.month));

  // 费率说明：本月用到的费率版本（通常只有一个）
  const usedVersions = new Map<number, RateBands>();
  for (const t of trips) usedVersions.set(t.rateVersionId, t);
  if (!usedVersions.size) {
    const r = rateForDate(input.rateVersions, monthStart);
    usedVersions.set(r.id, r);
  }

  return {
    schema: CLAIM_SCHEMA,
    month,
    generatedAt: (input.now ?? new Date()).toISOString(),
    yearBasis,
    yearLabel: yearLabelOf(monthStart, yearBasis),
    trips,
    monthTenths,
    monthMilliPence,
    monthPence: milliPenceToPence(monthMilliPence),
    previousMonths,
    yearTenths: monthTenths + previousMonths.reduce((s, m) => s + m.tenths, 0),
    rateNotes: [...new Set([...usedVersions.values()].map(rateNote))],
    employeeName: input.employeeName ?? '',
    companyName: input.companyName ?? '',
  };
}

// ---------- Word 段落分组 ----------

export interface WordLine {
  trips: SnapshotTrip[];
  dates: string[];
  description: string;
  tenths: number;
  image: SnapshotImage | null;
}

/**
 * Word 正文每段一条行程；开启合并时，路线描述和里程都相同的多次行程合并为一段
 * （样板写法："2026/09/02&2026/09/04 From home to B&Q Farnborough to home 51.5 miles each"）。
 * 只是排版合并，金额和合计不变。
 */
export function wordLines(s: ClaimSnapshot, group: boolean): WordLine[] {
  const lines: WordLine[] = [];
  const index = new Map<string, WordLine>();
  for (const t of s.trips) {
    const key = `${t.description}\u0000${t.tenths}`;
    const existing = group ? index.get(key) : undefined;
    // 每次实际路线的地图 / 截图都是独立凭证：两边都有时不合并，免得只剩一张图
    const distinct = (k?: SnapshotImage['kind']) => k === 'attachment' || k === 'map';
    if (existing && !(distinct(existing.image?.kind) && distinct(t.image?.kind))) {
      existing.trips.push(t);
      existing.dates.push(t.date);
      if (!existing.image || (existing.image.kind === 'track' && distinct(t.image?.kind))) existing.image = t.image;
      continue;
    }
    const line: WordLine = { trips: [t], dates: [t.date], description: t.description, tenths: t.tenths, image: t.image };
    lines.push(line);
    if (group && !index.has(key)) index.set(key, line);
  }
  return lines;
}

export const monthTitle = (month: string) => `${monthNameEn(month)} ${month.slice(0, 4)}`;

export const lineDateText = (dates: string[]) => dates.map(formatDateSlash).join('&');

/** 文件名：报表类型 + 年月 */
export function exportFileName(kind: 'Word' | 'Excel' | 'PDF' | 'CSV', month: string): string {
  const ext = { Word: 'docx', Excel: 'xlsx', PDF: 'pdf', CSV: 'csv' }[kind];
  const type = kind === 'Excel' ? 'Mileage-Details' : kind === 'Word' ? 'Mileage-Claim' : 'Mileage-Summary';
  return `${type}-${month}.${ext}`;
}
