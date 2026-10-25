/**
 * 补充格式（PDF / CSV）。与 Word、Excel 使用同一个报销快照，数字完全一致。
 * 正式报销以 Word / Excel 为准。
 */
import type { ClaimSnapshot } from './claim';
import { monthTitle } from './claim';
import { formatDateSlash } from './dates';
import { formatPence, formatTenths, milliPenceToPence } from './money';

export { placeLabel } from './claim';

const csvCell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** CSV（带 BOM，Excel 打开中文不乱码） */
export function snapshotToCsv(s: ClaimSnapshot): string {
  const lines: string[][] = [
    ['Date', 'Journey', 'Miles', 'Cost', 'Purpose', 'Client', 'Source'],
    ...s.trips.map((t) => [
      formatDateSlash(t.date),
      t.description,
      formatTenths(t.tenths),
      (t.milliPence / 100000).toFixed(3),
      t.purpose,
      t.client,
      t.source === 'gps' ? (t.distanceEdited ? 'GPS (adjusted)' : 'GPS') : 'Manual',
    ]),
    ['', `Miles in ${monthTitle(s.month)}`, formatTenths(s.monthTenths), (s.monthPence / 100).toFixed(2), '', '', ''],
    ['', 'Takes me to miles this year', formatTenths(s.yearTenths), '', '', '', ''],
  ];
  return '﻿' + lines.map((l) => l.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A4 PDF 用的 HTML（版式参照 Excel 样板） */
export function snapshotToHtml(s: ClaimSnapshot): string {
  const rows = s.trips
    .map(
      (t) => `<tr><td>${esc(`${formatDateSlash(t.date)} ${t.description}`)}</td>
  <td class="num">${formatTenths(t.tenths)}</td><td class="num">${esc(formatPence(milliPenceToPence(t.milliPence)))}</td></tr>`,
    )
    .join('');
  const prev = s.previousMonths
    .map((m) => `<tr><td>Miles in ${esc(monthTitle(m.month))}</td><td class="num">${formatTenths(m.tenths)}</td><td></td></tr>`)
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 19mm 18mm; }
  body { font-family: Aptos, Calibri, Roboto, "Noto Sans SC", sans-serif; font-size: 11px; color: #000; }
  table { width: 100%; border-collapse: collapse; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  td, th { border: 1px solid #000; padding: 2px 4px; vertical-align: middle; }
  th { text-align: left; }
  .title td { font-weight: 700; border: none; border-top: 2px solid #000; }
  .num { text-align: right; white-space: nowrap; width: 70px; }
  .gap td { border: none; height: 12px; }
  .note { margin-top: 10px; color: #444; font-size: 10px; }
</style></head><body>
<table>
  <thead>
    <tr class="title"><td colspan="3">${esc(`${s.month.slice(0, 4)} ${monthTitle(s.month).split(' ')[0]} mileage`)}</td></tr>
    <tr><th>Date</th><th class="num">Miles</th><th class="num">Cost</th></tr>
  </thead>
  <tbody>${rows || '<tr><td colspan="3">No business journeys</td></tr>'}
  <tr class="gap"><td colspan="3"></td></tr>
  ${s.rateNotes.map((n) => `<tr><td colspan="3">${esc(n)}</td></tr>`).join('')}
  <tr><td>Miles in ${esc(monthTitle(s.month))}</td><td class="num">${formatTenths(s.monthTenths)}</td><td class="num">${esc(formatPence(s.monthPence))}</td></tr>
  ${prev}
  <tr><td>Takes me to miles this year</td><td class="num">${formatTenths(s.yearTenths)}</td><td></td></tr>
  </tbody>
</table>
<div class="note">Generated ${esc(s.generatedAt.slice(0, 10))} from the same snapshot as the Word / Excel files.</div>
</body></html>`;
}
