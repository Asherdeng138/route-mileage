/** Office Open XML 打包的公共工具（纯 JS，App 与 Node 测试共用） */
import { strToU8, zipSync, type Zippable } from 'fflate';

/** XML 文本转义，并去掉 XML 1.0 不允许的控制字符 */
export function xmlText(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

/** 把 { 路径: 字符串 | 字节 } 打成 zip（[Content_Types].xml 放第一个） */
export function zipPackage(parts: Record<string, string | Uint8Array>): Uint8Array {
  const files: Zippable = {};
  const names = Object.keys(parts).sort((a, b) =>
    a === '[Content_Types].xml' ? -1 : b === '[Content_Types].xml' ? 1 : 0,
  );
  for (const name of names) {
    const v = parts[name];
    const data = typeof v === 'string' ? strToU8(v) : v;
    // 图片本身已压缩，存储即可
    files[name] = [data, { level: /\.(png|jpe?g)$/i.test(name) ? 0 : 6 }];
  }
  return zipSync(files, { mtime: new Date('2026-01-01T00:00:00Z') });
}

export function corePropsXml(opts: { creator: string; title: string; created: string }): string {
  const c = xmlText(opts.creator);
  return (
    XML_HEADER +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${xmlText(opts.title)}</dc:title><dc:creator>${c}</dc:creator><cp:lastModifiedBy>${c}</cp:lastModifiedBy>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${opts.created}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${opts.created}</dcterms:modified>` +
    '</cp:coreProperties>'
  );
}

/** ISO 时间去掉毫秒（W3CDTF） */
export const w3cdtf = (iso: string) => iso.replace(/\.\d{3}Z$/, 'Z');
