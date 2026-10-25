import assert from 'node:assert/strict';
import { test } from 'node:test';

import { strFromU8, unzipSync } from 'fflate';

import { mockTrip, sampleImages, sampleSnapshot } from '../scripts/generate-samples';
import { buildDocx, lineText } from '../src/export/docx';
import { renderTrackPng } from '../src/export/trackImage';
import { buildXlsx, costFormula } from '../src/export/xlsx';
import { DOCX_STYLES, XLSX_STYLES } from '../src/export/templateParts';
import {
  buildClaimSnapshot,
  exportFileName,
  routeDescription,
  validateTrip,
  wordLines,
  type ClaimSnapshot,
} from '../src/lib/claim';
import { formatDateSlash } from '../src/lib/dates';
import { formatPence, formatTenths } from '../src/lib/money';
import { COMPANY_TEMPLATE_RATE } from '../src/lib/rates';
import type { Place } from '../src/lib/types';

const unzip = (bytes: Uint8Array) => {
  const files = unzipSync(bytes);
  return { names: Object.keys(files), text: (n: string) => strFromU8(files[n]) };
};

const decode = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

/** 读取 xlsx：共享字符串 + 每个单元格（值 / 公式 / 样式） */
function readXlsx(bytes: Uint8Array) {
  const z = unzip(bytes);
  const sst = [...z.text('xl/sharedStrings.xml').matchAll(/<si><t[^>]*>([\s\S]*?)<\/t><\/si>/g)].map((m) => decode(m[1]));
  const sheet = z.text('xl/worksheets/sheet1.xml');
  const cells = new Map<string, { v?: string; f?: string; s?: string; text?: string }>();
  for (const m of sheet.matchAll(/<c r="([A-Z]+\d+)"( s="(\d+)")?( t="s")?(\/>|>([\s\S]*?)<\/c>)/g)) {
    const inner = m[6] ?? '';
    const f = inner.match(/<f>([\s\S]*?)<\/f>/)?.[1];
    const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
    cells.set(m[1], { s: m[3], f: f && decode(f), v, text: m[4] && v != null ? sst[Number(v)] : undefined });
  }
  return { z, sheet, cells, workbook: z.text('xl/workbook.xml') };
}

/** 读取 docx 段落文本（按段） */
function readDocx(bytes: Uint8Array) {
  const z = unzip(bytes);
  const doc = z.text('word/document.xml');
  const paras = [...doc.matchAll(/<w:p>([\s\S]*?)<\/w:p>|<w:p\/>/g)].map((m) =>
    decode([...(m[1] ?? '').matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((x) => x[1]).join('')),
  );
  return { z, doc, paras };
}

test('xlsx follows the template: sheet, title, headers, formulas, styles, print setup', () => {
  const { snapshot } = sampleSnapshot();
  const { z, cells, workbook, sheet } = readXlsx(buildXlsx(snapshot));
  assert.match(workbook, /<sheet name="Sheet1" sheetId="1"/);
  assert.equal(z.text('xl/styles.xml'), XLSX_STYLES); // 样板样式原样复用
  assert.equal(cells.get('A1')?.text, '2026 October mileage');
  assert.equal(cells.get('A1')?.s, '1');
  assert.deepEqual(['A2', 'B2', 'C2'].map((r) => cells.get(r)?.text), ['Date', 'Miles', 'Cost']);
  assert.deepEqual(['A2', 'B2', 'C2'].map((r) => cells.get(r)?.s), ['4', '4', '5']);

  const n = snapshot.trips.length;
  for (let i = 0; i < n; i++) {
    const r = 3 + i;
    const t = snapshot.trips[i];
    assert.equal(cells.get(`A${r}`)?.text, `${formatDateSlash(t.date)} ${t.description}`);
    assert.equal(Number(cells.get(`B${r}`)?.v), t.tenths / 10);
    assert.equal(cells.get(`C${r}`)?.f, `B${r}*0.45`);
    assert.equal(cells.get(`C${r}`)?.s, '7');
    assert.ok(Math.abs(Number(cells.get(`C${r}`)?.v) - t.milliPence / 100000) < 1e-9);
  }
  const last = 2 + n;
  // 汇总区：说明行、本月合计（SUM 范围随行数调整）、往月、年累计
  const labels = [...cells.entries()].filter(([, c]) => c.text).map(([ref, c]) => [ref, c.text] as const);
  const find = (text: string) => labels.find(([, t]) => t === text)?.[0];
  assert.ok(find('First 10,000 miles paid at £0.45, mileage after 10,000 paid at £0.25 per mile'));
  const monthRow = Number(find('Miles in October 2026')!.slice(1));
  assert.equal(cells.get(`B${monthRow}`)?.f, `SUM(B3:B${last})`);
  assert.equal(cells.get(`C${monthRow}`)?.f, `SUM(C3:C${last})`);
  assert.equal(Number(cells.get(`B${monthRow}`)?.v), snapshot.monthTenths / 10);
  assert.ok(Math.abs(Number(cells.get(`C${monthRow}`)?.v) - snapshot.monthPence / 100) < 0.005);
  assert.equal(find('Miles in September 2026'), `A${monthRow + 1}`);
  assert.equal(find('Miles in August 2026'), `A${monthRow + 2}`);
  assert.equal(find('Miles in July 2026'), `A${monthRow + 3}`);
  const yearRef = find('Takes me to miles this year')!;
  const yearRow = Number(yearRef.slice(1));
  assert.equal(cells.get(`B${yearRow}`)?.f, `B${monthRow}+B${monthRow + 1}+B${monthRow + 2}+B${monthRow + 3}`);
  assert.equal(Number(cells.get(`B${yearRow}`)?.v), snapshot.yearTenths / 10);
  // 打印区域、重复表头、A4 适合页宽，与行数同步
  assert.match(workbook, new RegExp(`_xlnm.Print_Area" localSheetId="0">Sheet1!\\$A\\$1:\\$C\\$${yearRow}<`));
  assert.match(workbook, /_xlnm.Print_Titles" localSheetId="0">Sheet1!\$1:\$2</);
  assert.match(workbook, /fullCalcOnLoad="1"/);
  assert.match(sheet, /<pageSetup paperSize="9" orientation="portrait" fitToWidth="1" fitToHeight="0"\/>/);
  assert.match(sheet, new RegExp(`<dimension ref="A1:C${yearRow}"/>`));
  // 长描述换行：行高按行数估算
  const ht7 = Number(sheet.match(/<row r="7" spans="1:3" ht="([\d.]+)">/)?.[1]);
  assert.ok(ht7 >= 29, `row 7 height ${ht7}`);
  assert.match(sheet, /<row r="3" spans="1:3">/); // 短描述保持默认行高
});

test('cost formula splits bands when a trip crosses 10,000 miles', () => {
  const before = mockTrip({ date: '2026-09-01', miles: 9_990 });
  const t = mockTrip({ date: '2026-10-01', miles: 30 });
  const s = buildClaimSnapshot({
    month: '2026-10',
    selected: [t],
    yearBusinessTrips: [before, t],
    manualMonths: [],
    rateVersions: [{ id: 1, ...COMPANY_TEMPLATE_RATE }],
    yearBasis: 'tax',
  });
  const c = costFormula(3, s.trips[0]);
  assert.equal(c.f, 'MIN(B3,10)*0.45+MAX(B3-10,0)*0.25');
  assert.equal(c.v, 10 * 0.45 + 20 * 0.25);
  assert.equal(s.monthPence, 950);
});

test('docx follows the template: page setup, paragraphs, styles, images', () => {
  const { snapshot } = sampleSnapshot();
  const images = sampleImages(snapshot);
  const { z, doc, paras } = readDocx(buildDocx(snapshot, { group: true, images }));
  assert.equal(z.text('word/styles.xml'), DOCX_STYLES);
  assert.match(doc, /<w:pgSz w:w="11906" w:h="16838"\/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/);
  assert.deepEqual(paras.slice(0, 5), [
    'Mileage for October 2026',
    'First 10,000 miles paid at £0.45, mileage after 10,000 paid at £0.25 per mile',
    `Miles total ${formatTenths(snapshot.monthTenths)} miles`,
    `Amount to claim ${formatPence(snapshot.monthPence)}`,
    `Takes me to ${formatTenths(snapshot.yearTenths)} miles this year`,
  ]);
  // 前四段的段落标记是粗体，与样板一致
  assert.match(doc, /<w:p><w:pPr><w:rPr><w:b\/><w:bCs\/><\/w:rPr><\/w:pPr><w:r><w:rPr><w:b\/><w:bCs\/><\/w:rPr><w:t xml:space="preserve">Mileage for <\/w:t>/);
  // 合并：相同路线 51.5 英里的 6 天合成一段
  assert.ok(paras.includes('2026/10/02&2026/10/05&2026/10/12&2026/10/16&2026/10/27 From home to Sample Store A (Farnborough) to home 51.5 miles each'));
  // 每张图片都有关系和媒体文件；描述段落「与下段同页」
  const media = z.names.filter((n) => n.startsWith('word/media/'));
  const rels = z.text('word/_rels/document.xml.rels');
  assert.equal(media.length, [...rels.matchAll(/relationships\/image"/g)].length);
  assert.ok(media.length > 0);
  for (const m of [...doc.matchAll(/r:embed="(rIdImg\d+)"/g)]) assert.ok(rels.includes(`Id="${m[1]}"`));
  assert.ok((doc.match(/<w:keepNext\/>/g) ?? []).length >= media.length);
  assert.ok(paras.some((p) => p.startsWith('Track preview from phone GPS (not a map route)')));
  // GPS 里程被人工修正时，图注说明报表采用的是申报里程
  assert.ok(paras.some((p) => p.includes('64.2 miles recorded by phone GPS; claimed distance 68.0 miles (adjusted manually)')));
  // 图片不超过版心宽度和一页高度
  for (const m of doc.matchAll(/<wp:extent cx="(\d+)" cy="(\d+)"\/>/g)) {
    assert.ok(Number(m[1]) <= 5731510 && Number(m[2]) <= 5940000);
  }
});

test('Word and Excel from one snapshot agree on dates, count, miles and amount', () => {
  const { snapshot } = sampleSnapshot();
  const x = readXlsx(buildXlsx(snapshot));
  const w = readDocx(buildDocx(snapshot, { group: false, images: new Map() }));
  const n = snapshot.trips.length;
  const xlsRows = Array.from({ length: n }, (_, i) => ({
    text: x.cells.get(`A${3 + i}`)!.text!,
    miles: Number(x.cells.get(`B${3 + i}`)!.v),
  }));
  const wordTrips = w.paras.slice(6).filter((p) => /^\d{4}\/\d{2}\/\d{2} /.test(p));
  assert.equal(wordTrips.length, n);
  for (let i = 0; i < n; i++) {
    assert.equal(wordTrips[i], `${xlsRows[i].text} ${xlsRows[i].miles.toFixed(1)} miles`);
  }
  const xlsMiles = xlsRows.reduce((s, r) => s + Math.round(r.miles * 10), 0);
  assert.equal(xlsMiles, snapshot.monthTenths);
  assert.ok(w.paras.includes(`Miles total ${formatTenths(xlsMiles)} miles`));
  const xlsCost = Array.from({ length: n }, (_, i) => Number(x.cells.get(`C${3 + i}`)!.v)).reduce((a, b) => a + b, 0);
  assert.ok(w.paras.includes(`Amount to claim ${formatPence(Math.round(xlsCost * 100))}`));
  // 分组后 Word 段落数减少，但日期和里程完全覆盖
  const grouped = wordLines(snapshot, true);
  assert.equal(grouped.reduce((s, l) => s + l.trips.length, 0), n);
  assert.equal(grouped.reduce((s, l) => s + l.tenths * l.trips.length, 0), snapshot.monthTenths);
});

test('long and Chinese text, XML-special characters and control chars are escaped', () => {
  const t = mockTrip({
    date: '2026-10-03',
    miles: 10,
    startName: 'home',
    endName: '客户 <A&B> "总部"\u0007',
    via: ['Very long stop name '.repeat(12).trim()],
  });
  const s = buildClaimSnapshot({
    month: '2026-10',
    selected: [t],
    yearBusinessTrips: [t],
    manualMonths: [],
    rateVersions: [{ id: 1, ...COMPANY_TEMPLATE_RATE }],
    yearBasis: 'tax',
  });
  const xlsx = buildXlsx(s);
  const docx = buildDocx(s, { group: true, images: new Map() });
  const sst = unzip(xlsx).text('xl/sharedStrings.xml');
  assert.ok(sst.includes('客户 &lt;A&amp;B&gt; &quot;总部&quot;'));
  assert.ok(!sst.includes('\u0007'));
  const { sheet } = readXlsx(xlsx);
  const ht = Number(sheet.match(/<row r="3" spans="1:3" ht="([\d.]+)">/)?.[1]);
  assert.ok(ht >= 43.5, `row height ${ht}`);
  const { paras } = readDocx(docx);
  assert.ok(paras.some((p) => p.includes('客户 <A&B> "总部"')));
});

test('empty selection still produces valid files with zero totals', () => {
  const s = buildClaimSnapshot({
    month: '2026-11',
    selected: [],
    yearBusinessTrips: [],
    manualMonths: [{ month: '2026-10', tenths: 1000 }],
    rateVersions: [{ id: 1, ...COMPANY_TEMPLATE_RATE }],
    yearBasis: 'tax',
  });
  assert.equal(s.monthPence, 0);
  assert.equal(s.yearTenths, 1000);
  const { cells } = readXlsx(buildXlsx(s));
  assert.equal(cells.get('A1')?.text, '2026 November mileage');
  const { paras } = readDocx(buildDocx(s, { group: true, images: new Map() }));
  assert.ok(paras.includes('No business journeys selected for this month.'));
});

test('route description, round trips and required-field validation', () => {
  const places: Place[] = [
    { id: 1, name: 'home', address: null, lat: 51.29, lng: -0.75, radiusM: 150, type: 'home' },
    { id: 2, name: 'Office', address: null, lat: 51.5, lng: -0.1, radiusM: 150, type: 'office' },
  ];
  const rt = mockTrip({ date: '2026-10-01', miles: 20, source: 'manual', roundTrip: true, endName: 'Client', via: [] });
  assert.equal(routeDescription(rt), 'From home to Client to home');
  assert.equal(routeDescription({ ...rt, reportDesc: '  custom   text ' }), 'custom text');

  const noEnd = mockTrip({ date: '2026-10-01', miles: 5, endName: null, endAddress: null, geocodeStatus: 'failed' });
  const codes = validateTrip(noEnd, places).map((i) => `${i.level}:${i.code}`);
  assert.ok(codes.includes('error:no-end'));
  const coords = mockTrip({ date: '2026-10-01', miles: 5, endName: '51.50000, -0.10000' });
  assert.ok(validateTrip(coords, places).some((i) => i.code === 'coords-only'));
  const recording = mockTrip({ date: '2026-10-01', miles: 5, status: 'recording' });
  assert.ok(validateTrip(recording, places).some((i) => i.code === 'recording'));

  const commute = mockTrip({ date: '2026-10-01', miles: 30, startLat: 51.29, startLng: -0.75, endName: 'Office', endLat: 51.5, endLng: -0.1 });
  assert.ok(validateTrip(commute, places).some((i) => i.code === 'commute' && i.level === 'warning'));
  assert.ok(!validateTrip({ ...commute, commuteConfirmed: true }, places).some((i) => i.code === 'commute'));
});

test('file names include report type and year-month', () => {
  assert.equal(exportFileName('Word', '2026-09'), 'Mileage-Claim-2026-09.docx');
  assert.equal(exportFileName('Excel', '2026-09'), 'Mileage-Details-2026-09.xlsx');
});

test('track preview PNG is a valid PNG and needs at least two points', () => {
  assert.equal(renderTrackPng([{ lat: 51, lng: 0 }]), null);
  const png = renderTrackPng([
    { lat: 51.3, lng: -0.75 },
    { lat: 51.31, lng: -0.74 },
    { lat: 51.32, lng: -0.76 },
  ])!;
  assert.deepEqual([...png.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(new DataView(png.buffer).getUint32(16), 960);
});

test('word line text uses "each" for grouped dates', () => {
  const { snapshot } = sampleSnapshot();
  const lines = wordLines(snapshot as ClaimSnapshot, true);
  const grouped = lines.find((l) => l.trips.length > 1)!;
  assert.match(lineText(grouped), / miles each$/);
});
