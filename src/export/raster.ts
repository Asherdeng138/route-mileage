/**
 * 纯 JS 位图工具：RGB 画布、PNG 编码 / 解码、简单绘图和小号点阵字。
 * 用于在手机上生成轨迹预览图和 OpenStreetMap 路线图，不依赖原生模块或网络地图 API。
 */
import { unzlibSync, zlibSync } from 'fflate';

// ---------- PNG ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

/** RGB 像素 → PNG 字节 */
export function encodePng(width: number, height: number, rgb: Uint8Array): Uint8Array {
  const stride = width * 3;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const parts = [new Uint8Array(PNG_SIG), chunk('IHDR', ihdr), chunk('IDAT', zlibSync(raw, { level: 6 })), chunk('IEND', new Uint8Array(0))];
  const png = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    png.set(p, o);
    o += p.length;
  }
  return png;
}

export interface DecodedImage {
  width: number;
  height: number;
  /** RGBA，每像素 4 字节 */
  rgba: Uint8Array;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * PNG → RGBA。支持非隔行扫描的灰度 / RGB / 调色板 / 带透明度格式（位深 8，调色板 1–8），
 * 足够解码 OpenStreetMap 图块；不支持的格式抛出错误。
 */
export function decodePng(bytes: Uint8Array): DecodedImage {
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIG[i]) throw new Error('不是 PNG 文件');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let o = 8;
  while (o + 8 <= bytes.length) {
    const len = dv.getUint32(o);
    const type = String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7]);
    const data = bytes.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      width = dv.getUint32(o + 8);
      height = dv.getUint32(o + 12);
      depth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('不支持隔行扫描 PNG');
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  const channels = CHANNELS[colorType];
  if (!channels || !width || !height) throw new Error('PNG 格式不支持');
  if (colorType !== 3 && depth !== 8) throw new Error(`不支持位深 ${depth}`);
  if (colorType === 3 && !palette) throw new Error('调色板 PNG 缺少 PLTE');

  const compressed = new Uint8Array(idat.reduce((s, c) => s + c.length, 0));
  let p = 0;
  for (const c of idat) {
    compressed.set(c, p);
    p += c.length;
  }
  const raw = unzlibSync(compressed);
  const bitsPerPixel = channels * depth;
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));
  const cur = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  const rgba = new Uint8Array(width * height * 4);

  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    for (let i = 0; i < stride; i++) {
      const x = raw[rowStart + 1 + i];
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v: number;
      switch (filter) {
        case 0:
          v = x;
          break;
        case 1:
          v = x + a;
          break;
        case 2:
          v = x + b;
          break;
        case 3:
          v = x + ((a + b) >> 1);
          break;
        case 4: {
          const pa = Math.abs(b - c);
          const pb = Math.abs(a - c);
          const pc = Math.abs(a + b - 2 * c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`PNG 过滤类型 ${filter} 无效`);
      }
      cur[i] = v & 0xff;
    }
    for (let xPix = 0; xPix < width; xPix++) {
      const out = (y * width + xPix) * 4;
      if (colorType === 3) {
        const perByte = 8 / depth;
        const byte = cur[Math.floor(xPix / perByte)];
        const shift = 8 - depth * ((xPix % perByte) + 1);
        const idx = (byte >> shift) & ((1 << depth) - 1);
        rgba[out] = palette![idx * 3];
        rgba[out + 1] = palette![idx * 3 + 1];
        rgba[out + 2] = palette![idx * 3 + 2];
        rgba[out + 3] = trns && idx < trns.length ? trns[idx] : 255;
      } else {
        const i = xPix * channels;
        if (colorType === 0 || colorType === 4) {
          rgba[out] = rgba[out + 1] = rgba[out + 2] = cur[i];
          rgba[out + 3] = colorType === 4 ? cur[i + 1] : 255;
        } else {
          rgba[out] = cur[i];
          rgba[out + 1] = cur[i + 1];
          rgba[out + 2] = cur[i + 2];
          rgba[out + 3] = colorType === 6 ? cur[i + 3] : 255;
        }
      }
    }
    prev.set(cur);
  }
  return { width, height, rgba };
}

// ---------- 画布 ----------

export type RGB = [number, number, number];

export const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

export class Canvas {
  readonly px: Uint8Array;

  constructor(
    readonly width: number,
    readonly height: number,
    bg: RGB,
  ) {
    this.px = new Uint8Array(width * height * 3);
    for (let i = 0; i < width * height; i++) this.px.set(bg, i * 3);
  }

  blend(x: number, y: number, c: RGB, a: number) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height || a <= 0) return;
    const i = (y * this.width + x) * 3;
    const px = this.px;
    px[i] += (c[0] - px[i]) * a;
    px[i + 1] += (c[1] - px[i + 1]) * a;
    px[i + 2] += (c[2] - px[i + 2]) * a;
  }

  /** 抗锯齿实心圆 */
  disc(cx: number, cy: number, r: number, c: RGB, alpha = 1) {
    for (let y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r + 1); y++) {
      for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++) {
        const d = Math.hypot(x - cx, y - cy);
        this.blend(x, y, c, alpha * Math.min(1, Math.max(0, r + 0.5 - d)));
      }
    }
  }

  /** 粗折线（沿线段连续盖圆点） */
  polyline(pts: { x: number; y: number }[], r: number, c: RGB) {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 1.5));
      for (let s = 0; s <= steps; s++) this.disc(a.x + ((b.x - a.x) * s) / steps, a.y + ((b.y - a.y) * s) / steps, r, c);
    }
    if (pts.length === 1) this.disc(pts[0].x, pts[0].y, r, c);
  }

  /** 虚线折线：每 dash 像素画、gap 像素空（沿整条线连续计算，不在拐点重新开始） */
  dashedPolyline(pts: { x: number; y: number }[], r: number, c: RGB, dash = 14, gap = 10) {
    let run = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const steps = Math.max(1, Math.ceil(len / 1.5));
      for (let s = 0; s <= steps; s++) {
        if ((run + (len * s) / steps) % (dash + gap) < dash) this.disc(a.x + ((b.x - a.x) * s) / steps, a.y + ((b.y - a.y) * s) / steps, r, c);
      }
      run += len;
    }
  }

  rect(x0: number, y0: number, w: number, h: number, c: RGB, a = 1) {
    for (let y = Math.max(0, y0); y < Math.min(this.height, y0 + h); y++) {
      for (let x = Math.max(0, x0); x < Math.min(this.width, x0 + w); x++) this.blend(x, y, c, a);
    }
  }

  /** 把 RGBA 图像贴到 (left, top) */
  blit(img: DecodedImage, left: number, top: number) {
    for (let y = 0; y < img.height; y++) {
      const ty = top + y;
      if (ty < 0 || ty >= this.height) continue;
      for (let x = 0; x < img.width; x++) {
        const tx = left + x;
        if (tx < 0 || tx >= this.width) continue;
        const s = (y * img.width + x) * 4;
        const a = img.rgba[s + 3] / 255;
        if (a >= 1) {
          const d = (ty * this.width + tx) * 3;
          this.px[d] = img.rgba[s];
          this.px[d + 1] = img.rgba[s + 1];
          this.px[d + 2] = img.rgba[s + 2];
        } else this.blend(tx, ty, [img.rgba[s], img.rgba[s + 1], img.rgba[s + 2]], a);
      }
    }
  }

  /** 点阵字（只包含地图署名需要的字符），返回文字宽度 */
  text(s: string, x: number, y: number, scale: number, c: RGB, draw = true): number {
    let cx = x;
    for (const ch of s) {
      const g = GLYPHS[ch] ?? GLYPHS[' '];
      const w = g[0].length;
      if (draw) {
        for (let row = 0; row < g.length; row++) {
          for (let col = 0; col < w; col++) {
            if (g[row][col] === '1') this.rect(cx + col * scale, y + row * scale, scale, scale, c);
          }
        }
      }
      cx += (w + 1) * scale;
    }
    return cx - x - scale;
  }

  toPng(): Uint8Array {
    return encodePng(this.width, this.height, this.px);
  }
}

/** 5×7 点阵（© 为 7 宽）。只覆盖 "© OpenStreetMap contributors" */
const GLYPHS: Record<string, string[]> = {
  ' ': ['000', '000', '000', '000', '000', '000', '000'],
  '©': ['0011100', '0100010', '1011101', '1010001', '1011101', '0100010', '0011100'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  p: ['00000', '00000', '11110', '10001', '11110', '10000', '10000'],
  e: ['00000', '00000', '01110', '10001', '11111', '10000', '01110'],
  n: ['00000', '00000', '10110', '11001', '10001', '10001', '10001'],
  t: ['01000', '01000', '11100', '01000', '01000', '01001', '00110'],
  r: ['00000', '00000', '10110', '11001', '10000', '10000', '10000'],
  a: ['00000', '00000', '01110', '00001', '01111', '10001', '01111'],
  c: ['00000', '00000', '01110', '10000', '10000', '10001', '01110'],
  o: ['00000', '00000', '01110', '10001', '10001', '10001', '01110'],
  i: ['00100', '00000', '01100', '00100', '00100', '00100', '01110'],
  b: ['10000', '10000', '10110', '11001', '10001', '10001', '11110'],
  u: ['00000', '00000', '10001', '10001', '10001', '10011', '01101'],
  s: ['00000', '00000', '01111', '10000', '01110', '00001', '11110'],
};
