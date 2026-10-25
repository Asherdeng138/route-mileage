/**
 * 月度报销导出：生成快照 → 用同一快照写出 Word / Excel（以及补充的 PDF / CSV）→ 分享或保存。
 * 导出只保存快照（状态「已导出」），不会把行程标记为已报销；报销状态由用户单独确认。
 */
import { Directory, File, Paths } from 'expo-file-system';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';

import { listMonthMiles, saveClaimSnapshot } from '@/db/claims';
import { countPoints, getPoints, listBusinessTrips, listTrips } from '@/db/trips';
import { listRateVersions } from '@/db/rates';
import { listPlaces } from '@/db/places';
import { buildDocx, type DocxImage } from '@/export/docx';
import { generateRouteMap, routeMapFileExists } from '@/services/routeMap';
import { renderTrackPng, TRACK_IMAGE_SIZE } from '@/export/trackImage';
import { buildXlsx } from '@/export/xlsx';
import { buildClaimSnapshot, exportFileName, validateTrip, type ClaimSnapshot } from '@/lib/claim';
import { monthRange, yearRangeOf } from '@/lib/dates';
import { snapshotToCsv, snapshotToHtml } from '@/lib/report';
import type { AppSettings, Trip } from '@/lib/types';

export const MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
  csv: 'text/csv',
} as const;

export interface ExportFiles {
  word: File;
  excel: File;
}

function exportDir(claimId: number): Directory {
  const dir = new Directory(Paths.cache, 'exports', `claim-${claimId}`);
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

async function writeBytes(dir: Directory, name: string, data: Uint8Array | string): Promise<File> {
  const f = new File(dir, name);
  if (f.exists) f.delete();
  f.create();
  await f.write(data);
  return f;
}

async function loadImages(s: ClaimSnapshot): Promise<Map<string, DocxImage>> {
  const images = new Map<string, DocxImage>();
  for (const t of s.trips) {
    const img = t.image;
    if (!img || images.has(img.key)) continue;
    try {
      if (img.kind === 'attachment' || img.kind === 'map') {
        const f = new File(img.key);
        if (!f.exists) continue;
        images.set(img.key, { bytes: await f.bytes(), mime: img.mime, width: img.width, height: img.height });
      } else {
        const png = renderTrackPng(await getPoints(t.tripId));
        if (png) images.set(img.key, { bytes: png, mime: 'image/png', width: img.width, height: img.height });
      }
    } catch (e) {
      console.warn('[route] image skipped', img.key, e);
    }
  }
  return images;
}

/** 根据快照写出 Word 与 Excel（同一份数据） */
export async function renderClaimFiles(s: ClaimSnapshot, claimId: number, group: boolean): Promise<ExportFiles> {
  const dir = exportDir(claimId);
  const docx = buildDocx(s, { group, images: await loadImages(s) });
  const xlsx = buildXlsx(s);
  return {
    word: await writeBytes(dir, exportFileName('Word', s.month), docx),
    excel: await writeBytes(dir, exportFileName('Excel', s.month), xlsx),
  };
}

export class ExportBlockedError extends Error {}

/**
 * 生成本次导出的快照并保存（状态：已导出）。
 * selectedIds 中有错误级问题（缺起终点、仍在记录…）时拒绝导出。
 */
export async function createMonthlyClaim(
  month: string,
  selectedIds: number[],
  settings: AppSettings,
): Promise<{ claimId: number; snapshot: ClaimSnapshot; files: ExportFiles }> {
  if (!selectedIds.length) throw new ExportBlockedError('没有选择任何行程');
  const [from, to] = monthRange(month);
  const [yearStart] = yearRangeOf(from, settings.yearBasis);
  const [monthTrips, yearTrips, manualMonths, rateVersions, places] = await Promise.all([
    listTrips({ from, to, includeRecording: true }),
    listBusinessTrips(yearStart, to),
    listMonthMiles(),
    listRateVersions(),
    listPlaces(),
  ]);
  let selected = monthTrips.filter((t) => selectedIds.includes(t.id));
  if (selected.length !== selectedIds.length) throw new ExportBlockedError('部分行程已被删除，请刷新后重试');
  const errors = selected.flatMap((t) => validateTrip(t, places)).filter((i) => i.level === 'error');
  if (errors.length) throw new ExportBlockedError(`还有 ${errors.length} 个必填问题需要先修正`);

  // 还没有路线图（行程结束时没网）或图片文件丢失的 GPS 行程：导出前再生成一次，失败则用轨迹预览
  if (settings.onlineMaps && settings.embedTrackPreview) {
    let regenerated = false;
    for (const t of selected) {
      if (t.source !== 'gps' || t.mapImageUri) continue;
      if (t.routeMapStatus === 'ok' && routeMapFileExists(t)) continue;
      if ((await countPoints(t.id)) < 2) continue;
      await generateRouteMap(t.id);
      regenerated = true;
    }
    if (regenerated) {
      const fresh = await listTrips({ from, to, includeRecording: true });
      selected = fresh.filter((t) => selectedIds.includes(t.id));
    }
  }
  selected = selected.map((t) => (t.routeMapStatus === 'ok' && !routeMapFileExists(t) ? { ...t, routeMapStatus: 'failed' } : t));

  const previewable = new Set<number>();
  if (settings.embedTrackPreview) {
    for (const t of selected) {
      if (t.source === 'gps' && !t.mapImageUri && t.routeMapStatus !== 'ok' && (await countPoints(t.id)) >= 2) previewable.add(t.id);
    }
  }
  const snapshot = buildClaimSnapshot({
    month,
    selected,
    yearBusinessTrips: yearTrips,
    manualMonths,
    rateVersions,
    yearBasis: settings.yearBasis,
    employeeName: settings.employeeName,
    companyName: settings.companyName,
    trackPreview: (t: Trip) =>
      previewable.has(t.id) ? { kind: 'track', key: `track:${t.id}`, mime: 'image/png', ...TRACK_IMAGE_SIZE } : null,
  });
  const claimId = await saveClaimSnapshot(snapshot);
  const files = await renderClaimFiles(snapshot, claimId, settings.groupSameRoutes);
  return { claimId, snapshot, files };
}

export async function shareFile(file: File, mimeType: string, title: string): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new Error('这台设备不支持分享文件');
  await Sharing.shareAsync(file.uri, { mimeType, dialogTitle: title });
}

/** 让用户选择一个文件夹（例如「下载」或 Google Drive），把 Word 和 Excel 一起保存进去 */
export async function saveFilesToFolder(files: File[]): Promise<number> {
  const dir = await Directory.pickDirectoryAsync();
  let n = 0;
  for (const f of files) {
    const mime = f.name.endsWith('.docx') ? MIME.docx : f.name.endsWith('.xlsx') ? MIME.xlsx : null;
    const target = dir.createFile(f.name, mime);
    await target.write(await f.bytes());
    n++;
  }
  return n;
}

export async function sharePdf(s: ClaimSnapshot, claimId: number): Promise<void> {
  const { uri } = await Print.printToFileAsync({ html: snapshotToHtml(s), width: 595, height: 842 });
  const target = new File(exportDir(claimId), exportFileName('PDF', s.month));
  if (target.exists) target.delete();
  await new File(uri).move(target);
  await shareFile(target, MIME.pdf, '分享 PDF（补充格式）');
}

export async function shareCsv(s: ClaimSnapshot, claimId: number): Promise<void> {
  const f = await writeBytes(exportDir(claimId), exportFileName('CSV', s.month), snapshotToCsv(s));
  await shareFile(f, MIME.csv, '分享 CSV（补充格式）');
}
