/**
 * Excel 里程明细（.xlsx），按 example 样板（2026 September mileage）结构生成：
 *
 *   A1  "2026 September mileage"（粗体，上 / 左 / 右粗边框）
 *   A2:C2  Date | Miles | Cost
 *   A3..  "2026/09/01 From home to … to home" | 里程 | =B3*0.45（£#,##0.00）
 *   费率说明行
 *   Miles in September 2026 | =SUM(B..) | =SUM(C..)
 *   Miles in August 2026    | 往月里程
 *   Takes me to miles this year | =本月+往月
 *
 * 样式（字体 Aptos Narrow 11、边框、£ 数字格式）直接复用样板的 styles.xml 与 theme，
 * 单元格样式编号与样板一致。行数随行程增减，SUM 公式范围、打印区域同步调整。
 */
import type { ClaimSnapshot, SnapshotTrip } from '@/lib/claim';
import { monthTitle } from '@/lib/claim';
import { formatDateSlash, monthNameEn } from '@/lib/dates';
import { rateFactorText } from '@/lib/money';

import { corePropsXml, w3cdtf, XML_HEADER, xmlText, zipPackage } from './ooxml';
import { XLSX_STYLES, XLSX_THEME } from './templateParts';

/** 样板 styles.xml 中的 cellXfs 编号 */
const S = {
  title: 1,
  titleMid: 2,
  titleRight: 3,
  header: 4,
  headerMoney: 5,
  cell: 6,
  money: 7,
  label: 8,
  desc: 9,
} as const;

/** 样板列宽（A 用 9 月样板的 89.36）。B 列在样板中只有 5.27，四位数里程会被 Excel 显示成整数，这里加宽到能完整显示一位小数 */
const COL_WIDTHS = [89.36328125, 8.7265625, 11.08984375];
/** A 列一行大约能放的字符数（Aptos Narrow 11，宽 89 的列），用于估算换行行高 */
const CHARS_PER_LINE = 88;
const LINE_HEIGHT = 14.5;

/** 估算显示宽度：中日韩全角字符约占两个英文字符宽 */
const textWidth = (s: string) => [...s].reduce((w, ch) => w + (/[\u2E80-\uFFEF]/.test(ch) ? 2 : 1), 0);

type Cell =
  | { t: 's'; v: string; s: number }
  | { t: 'n'; v: number; s: number }
  | { t: 'f'; f: string; v: number; s: number }
  | { t: 'e'; s: number };

interface Row {
  cells: (Cell | null)[];
  ht?: number;
}

const colName = (i: number) => String.fromCharCode(65 + i);

/** 行程金额公式：整段落在同一档时与样板一致（=B3*0.45）；跨 10,000 英里时拆成两档 */
export function costFormula(row: number, t: SnapshotTrip): { f: string; v: number } {
  const b = `B${row}`;
  const first = rateFactorText(t.firstPence);
  const after = rateFactorText(t.afterPence);
  const value = t.milliPence / 100000; // 千分之一便士 → 英镑
  if (t.afterTenths === 0) return { f: `${b}*${first}`, v: value };
  if (t.firstTenths === 0) return { f: `${b}*${after}`, v: value };
  const left = t.firstTenths / 10;
  return { f: `MIN(${b},${left})*${first}+MAX(${b}-${left},0)*${after}`, v: value };
}

const num = (v: number) => {
  // 去掉浮点尾差，最多 6 位小数
  const r = Math.round(v * 1e6) / 1e6;
  return String(r);
};

export function buildXlsx(s: ClaimSnapshot): Uint8Array {
  const strings: string[] = [];
  const stringIndex = new Map<string, number>();
  const str = (v: string, style: number): Cell => {
    let i = stringIndex.get(v);
    if (i == null) {
      i = strings.length;
      strings.push(v);
      stringIndex.set(v, i);
    }
    return { t: 's', v: String(i), s: style } as Cell;
  };

  const rows: Row[] = [];
  const title = `${s.month.slice(0, 4)} ${monthNameEn(s.month)} mileage`;
  rows.push({ cells: [str(title, S.title), { t: 'e', s: S.titleMid }, { t: 'e', s: S.titleRight }] });
  rows.push({ cells: [str('Date', S.header), str('Miles', S.header), str('Cost', S.headerMoney)] });

  const firstData = rows.length + 1;
  for (const t of s.trips) {
    const r = rows.length + 1;
    const text = `${formatDateSlash(t.date)} ${t.description}`.trim();
    const lines = Math.max(1, Math.ceil(textWidth(text) / CHARS_PER_LINE));
    const cost = costFormula(r, t);
    rows.push({
      cells: [str(text, S.desc), { t: 'n', v: t.tenths / 10, s: S.cell }, { t: 'f', f: cost.f, v: cost.v, s: S.money }],
      ht: lines > 1 ? lines * LINE_HEIGHT : undefined,
    });
  }
  const lastData = Math.max(rows.length, firstData);
  // 空月份时保留一行空表格，公式仍然有效
  if (!s.trips.length) rows.push({ cells: [{ t: 'e', s: S.desc }, { t: 'e', s: S.cell }, { t: 'e', s: S.money }] });

  rows.push({ cells: [] }); // 空行
  for (const note of s.rateNotes) rows.push({ cells: [str(note, S.label)] });

  const monthRow = rows.length + 1;
  const monthMiles = s.monthTenths / 10;
  rows.push({
    cells: [
      str(`Miles in ${monthTitle(s.month)}`, S.cell),
      { t: 'f', f: `SUM(B${firstData}:B${lastData})`, v: monthMiles, s: S.cell },
      { t: 'f', f: `SUM(C${firstData}:C${lastData})`, v: s.monthMilliPence / 100000, s: S.money },
    ],
  });
  const prevRows: number[] = [];
  for (const m of s.previousMonths) {
    prevRows.push(rows.length + 1);
    rows.push({ cells: [str(`Miles in ${monthTitle(m.month)}`, S.label), { t: 'n', v: m.tenths / 10, s: S.cell }] });
  }
  const yearFormula = [`B${monthRow}`, ...prevRows.map((r) => `B${r}`)].join('+');
  rows.push({
    cells: [str('Takes me to miles this year', S.cell), { t: 'f', f: yearFormula, v: s.yearTenths / 10, s: S.cell }],
  });
  const lastRow = rows.length;

  const sheetRows = rows
    .map((row, i) => {
      const r = i + 1;
      const cells = row.cells
        .map((c, ci) => {
          if (!c) return '';
          const ref = `${colName(ci)}${r}`;
          switch (c.t) {
            case 's':
              return `<c r="${ref}" s="${c.s}" t="s"><v>${c.v}</v></c>`;
            case 'n':
              return `<c r="${ref}" s="${c.s}"><v>${num(c.v)}</v></c>`;
            case 'f':
              return `<c r="${ref}" s="${c.s}"><f>${xmlText(c.f)}</f><v>${num(c.v)}</v></c>`;
            case 'e':
              return `<c r="${ref}" s="${c.s}"/>`;
          }
        })
        .join('');
      const ht = row.ht ? ` ht="${row.ht}"` : '';
      return cells ? `<row r="${r}" spans="1:3"${ht}>${cells}</row>` : '';
    })
    .join('');

  const sheet =
    XML_HEADER +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' +
    `<dimension ref="A1:C${lastRow}"/>` +
    '<sheetViews><sheetView tabSelected="1" workbookViewId="0"/></sheetViews>' +
    '<sheetFormatPr defaultRowHeight="14.5"/>' +
    `<cols>${COL_WIDTHS.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` +
    `<sheetData>${sheetRows}</sheetData>` +
    '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
    '<pageSetup paperSize="9" orientation="portrait" fitToWidth="1" fitToHeight="0"/>' +
    '</worksheet>';

  const workbook =
    XML_HEADER +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<workbookPr defaultThemeVersion="202300"/>' +
    '<bookViews><workbookView xWindow="-110" yWindow="-110" windowWidth="19420" windowHeight="11500"/></bookViews>' +
    '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>' +
    '<definedNames>' +
    `<definedName name="_xlnm.Print_Area" localSheetId="0">Sheet1!$A$1:$C$${lastRow}</definedName>` +
    '<definedName name="_xlnm.Print_Titles" localSheetId="0">Sheet1!$1:$2</definedName>' +
    '</definedNames>' +
    '<calcPr calcId="191029" fullCalcOnLoad="1"/>' +
    '</workbook>';

  const sst =
    XML_HEADER +
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">` +
    strings.map((v) => `<si><t xml:space="preserve">${xmlText(v)}</t></si>`).join('') +
    '</sst>';

  return zipPackage({
    '[Content_Types].xml':
      XML_HEADER +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
      '</Types>',
    '_rels/.rels':
      XML_HEADER +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>',
    'docProps/app.xml':
      XML_HEADER +
      '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Microsoft Excel</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop>' +
      '<HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>1</vt:i4></vt:variant></vt:vector></HeadingPairs>' +
      '<TitlesOfParts><vt:vector size="1" baseType="lpstr"><vt:lpstr>Sheet1</vt:lpstr></vt:vector></TitlesOfParts>' +
      `<Company>${xmlText(s.companyName)}</Company><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged><AppVersion>16.0300</AppVersion></Properties>`,
    'docProps/core.xml': corePropsXml({
      creator: s.employeeName || 'Route Mileage',
      title: title,
      created: w3cdtf(s.generatedAt),
    }),
    'xl/workbook.xml': workbook,
    'xl/_rels/workbook.xml.rels':
      XML_HEADER +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>' +
      '</Relationships>',
    'xl/worksheets/sheet1.xml': sheet,
    'xl/sharedStrings.xml': sst,
    'xl/styles.xml': XLSX_STYLES,
    'xl/theme/theme1.xml': XLSX_THEME,
  });
}
