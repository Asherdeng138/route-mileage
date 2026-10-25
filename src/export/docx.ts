/**
 * Word 报销文件（.docx），按 example 样板（Mileage for September 2026）结构生成：
 *
 *   Mileage for September 2026                         （粗体）
 *   First 10,000 miles paid at £0.45, mileage after …  （费率说明）
 *   Miles total 1234.5 miles                            （粗体）
 *   Amount to claim £574.25                             （粗体）
 *   Takes me to 2785.1 miles this year
 *   （空行）
 *   2026/09/01 From home to B&Q Farnborough to home 66.5 miles
 *   [路线截图 / OpenStreetMap 路线图 / 轨迹预览] + 图注（地图注明 © OpenStreetMap contributors）
 *   …
 *
 * 纸张 A4 纵向、页边距 1440 twip（2.54 cm）、样式 / 字体 / 主题 / 段落间距直接复用样板部件。
 * 行程描述段落设置「与下段同页」，避免描述和下面的图片被分页拆开；图片宽度不超过版心，
 * 高度限制在一页以内，跨页时不会被截断。
 */
import type { ClaimSnapshot, WordLine } from '@/lib/claim';
import { lineDateText, monthTitle, wordLines } from '@/lib/claim';
import { formatPence, formatTenths } from '@/lib/money';
import { OSM } from '@/lib/osm';

import { corePropsXml, w3cdtf, XML_HEADER, xmlText, zipPackage } from './ooxml';
import { DOCX_FONT_TABLE, DOCX_SETTINGS, DOCX_STYLES, DOCX_THEME, DOCX_WEB_SETTINGS } from './templateParts';

/** 版心宽度（A4 21 cm − 左右各 2.54 cm），EMU */
const MAX_IMAGE_W = 5731510;
/** 图片最大高度约 16.5 cm，保证描述 + 图片能放在同一页 */
const MAX_IMAGE_H = 5940000;

const NS =
  'xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:w10="urn:schemas-microsoft-com:office:word" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup" xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk" xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" mc:Ignorable="w14 w15 wp14"';

const BOLD = '<w:b/><w:bCs/>';

const run = (text: string, rPr = '') =>
  `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${xmlText(text)}</w:t></w:r>`;

/** 段落：markBold 对应样板里段落标记的粗体设置 */
const para = (runs: string, opts: { markBold?: boolean; keepNext?: boolean } = {}) => {
  const ppr = (opts.keepNext ? '<w:keepNext/>' : '') + (opts.markBold ? `<w:rPr>${BOLD}</w:rPr>` : '');
  return `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}${runs}</w:p>`;
};

export interface DocxImage {
  bytes: Uint8Array;
  mime: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
}

export interface DocxOptions {
  /** 相同路线、相同里程的行程合并一段 */
  group: boolean;
  /** 按快照中图片的 key 取图片字节；取不到的图片会被跳过 */
  images: Map<string, DocxImage>;
}

export function lineText(l: WordLine): string {
  const each = l.trips.length > 1 ? ' each' : '';
  return `${lineDateText(l.dates)} ${l.description} ${formatTenths(l.tenths)} miles${each}`.replace(/\s+/g, ' ').trim();
}

export function buildDocx(s: ClaimSnapshot, opts: DocxOptions): Uint8Array {
  const media: { name: string; rid: string; bytes: Uint8Array }[] = [];
  const mediaByKey = new Map<string, { rid: string }>();
  let drawingId = 1;

  const imageParagraph = (key: string, img: DocxImage, keepNext: boolean): string => {
    let ref = mediaByKey.get(key);
    if (!ref) {
      const n = media.length + 1;
      const ext = img.mime === 'image/png' ? 'png' : 'jpeg';
      ref = { rid: `rIdImg${n}` };
      media.push({ name: `media/image${n}.${ext}`, rid: ref.rid, bytes: img.bytes });
      mediaByKey.set(key, ref);
    }
    let cx = MAX_IMAGE_W;
    let cy = Math.round((img.height / img.width) * cx);
    if (cy > MAX_IMAGE_H) {
      cx = Math.round((MAX_IMAGE_H / cy) * cx);
      cy = MAX_IMAGE_H;
    }
    const id = drawingId++;
    const drawing =
      `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>` +
      `<wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${id}" name="Picture ${id}"/>` +
      '<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
      '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${id}" name="route${id}"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="${ref.rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
      '</a:graphicData></a:graphic></wp:inline></w:drawing>';
    return `<w:p>${keepNext ? '<w:pPr><w:keepNext/></w:pPr>' : ''}<w:r><w:rPr><w:noProof/></w:rPr>${drawing}</w:r></w:p>`;
  };

  const caption = (text: string) =>
    `<w:p><w:pPr><w:spacing w:after="240"/></w:pPr>${run(text, '<w:color w:val="5D6670"/><w:sz w:val="18"/><w:szCs w:val="18"/>')}</w:p>`;

  const body: string[] = [];
  body.push(para(run('Mileage for ', BOLD) + run(monthTitle(s.month), BOLD), { markBold: true }));
  for (const note of s.rateNotes) body.push(para(run(note), { markBold: true }));
  body.push(para(run(`Miles total ${formatTenths(s.monthTenths)} miles`, BOLD), { markBold: true }));
  body.push(para(run(`Amount to claim ${formatPence(s.monthPence)}`, BOLD), { markBold: true }));
  body.push(para(run(`Takes me to ${formatTenths(s.yearTenths)} miles this year`)));
  body.push('<w:p/>');

  const lines = wordLines(s, opts.group);
  if (!lines.length) body.push(para(run('No business journeys selected for this month.')));
  for (const l of lines) {
    const img = l.image ? opts.images.get(l.image.key) : undefined;
    const t0 = l.trips[0];
    let cap: string | null = null;
    const gapFill = t0.gapFillTenths
      ? `; plus ${formatTenths(t0.gapFillTenths)} miles for GPS signal gaps, measured along the Google Maps driving route`
      : '';
    if (img && (l.image?.kind === 'track' || l.image?.kind === 'map')) {
      const gps = t0.gpsTenths != null ? `${formatTenths(t0.gpsTenths)} miles recorded by phone GPS` : '';
      const edited =
        t0.distanceEdited && t0.gpsTenths != null && t0.gpsTenths !== t0.tenths
          ? `; claimed distance ${formatTenths(t0.tenths)} miles (adjusted manually)`
          : '';
      cap =
        l.image.kind === 'map'
          ? `Route recorded by phone GPS${t0.gpsTenths != null ? ` (${formatTenths(t0.gpsTenths)} miles)` : ''}${gapFill ? `${gapFill} (dashed line)` : ''}${edited}. Map data ${OSM.attribution}`
          : `Track preview from phone GPS (not a map route)${gps ? ` – ${gps}` : ''}${gapFill}${edited}`;
    } else if (gapFill && l.trips.length === 1) {
      cap = `Includes ${formatTenths(t0.gapFillTenths!)} miles for GPS signal gaps, measured along the Google Maps driving route`;
    }
    body.push(para(run(lineText(l)), { keepNext: !!img }));
    if (img) body.push(imageParagraph(l.image!.key, img, !!cap));
    if (cap) body.push(caption(cap));
  }

  body.push(
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/><w:cols w:space="708"/><w:docGrid w:linePitch="360"/></w:sectPr>',
  );
  const document = `${XML_HEADER}<w:document ${NS}><w:body>${body.join('')}</w:body></w:document>`;

  const rels =
    XML_HEADER +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/webSettings" Target="webSettings.xml"/>' +
    '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable" Target="fontTable.xml"/>' +
    '<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>' +
    media
      .map((m) => `<Relationship Id="${m.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${m.name}"/>`)
      .join('') +
    '</Relationships>';

  const parts: Record<string, string | Uint8Array> = {
    '[Content_Types].xml':
      XML_HEADER +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
      '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>' +
      '<Override PartName="/word/webSettings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.webSettings+xml"/>' +
      '<Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/>' +
      '<Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
      '</Types>',
    '_rels/.rels':
      XML_HEADER +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>',
    'docProps/app.xml':
      XML_HEADER +
      '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
      `<Template>Normal.dotm</Template><Application>Microsoft Office Word</Application><DocSecurity>0</DocSecurity><Company>${xmlText(s.companyName)}</Company>` +
      '<LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged><AppVersion>16.0000</AppVersion></Properties>',
    'docProps/core.xml': corePropsXml({
      creator: s.employeeName || 'Route Mileage',
      title: `Mileage for ${monthTitle(s.month)}`,
      created: w3cdtf(s.generatedAt),
    }),
    'word/document.xml': document,
    'word/_rels/document.xml.rels': rels,
    'word/styles.xml': DOCX_STYLES,
    'word/settings.xml': DOCX_SETTINGS,
    'word/webSettings.xml': DOCX_WEB_SETTINGS,
    'word/fontTable.xml': DOCX_FONT_TABLE,
    'word/theme/theme1.xml': DOCX_THEME,
  };
  for (const m of media) parts[`word/${m.name}`] = m.bytes;
  return zipPackage(parts);
}

