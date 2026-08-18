/**
 * A PNG decoder and encoder built on the repository's own DEFLATE codecs
 * (`core/inflate.js`, `core/deflate.js`), because §8 requires media to be
 * inlined *downscaled and recompressed* and Node has no canvas (D-L6-6).
 *
 * Decoder support: bit depths 1/2/4/8/16, colour types 0 (grey), 2 (truecolour),
 * 3 (palette), 4 (grey+alpha) and 6 (truecolour+alpha), all five filter types,
 * `tRNS` transparency for palette/grey/truecolour, and both interlace methods
 * (none and Adam7). Everything decodes to straight 8-bit RGBA.
 *
 * Not honoured: `gAMA`, `cHRM`, `iCCP`, `sRGB`. There is no colour management
 * in this pipeline; pixels are treated as sRGB as authored, which is what the
 * browser does for an untagged image anyway.
 *
 * Encoder output: 8-bit, colour type 2 (opaque), 6 (with alpha) or 3 (palette,
 * with `tRNS` when the palette carries alpha), non-interlaced, adaptive
 * per-scanline filtering chosen by the standard minimum-sum-of-absolute-
 * differences heuristic. Deterministic: the same pixels always produce the same
 * bytes.
 */

import { deflateRaw } from '../core/deflate.js';
import { inflateRaw } from '../core/inflate.js';
import { crc32 } from '../core/zip.js';
import { concatBytes } from '../core/bytes.js';

export const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Adam7 pass geometry: [xStart, yStart, xStep, yStep]. */
const ADAM7 = [
  [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
  [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2],
];

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** @param {Uint8Array} bytes @param {number} i @returns {number} */
function u32(bytes, i) {
  return ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
}

/** @param {number} v @returns {Uint8Array} */
function be32(v) {
  return Uint8Array.from([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);
}

/**
 * Adler-32 over a byte range — the zlib stream checksum PNG requires.
 * @param {Uint8Array} bytes
 * @returns {number}
 */
export function adler32(bytes) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** @param {Uint8Array} bytes @returns {boolean} */
export function isPng(bytes) {
  if (!bytes || bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  return true;
}

/**
 * Wrap a raw DEFLATE stream in the zlib container PNG's IDAT expects.
 * @param {Uint8Array} raw
 * @param {Uint8Array} uncompressed
 * @returns {Uint8Array}
 */
function zlibWrap(raw, uncompressed) {
  // CMF=0x78 (deflate, 32K window), FLG chosen so (CMF<<8|FLG) % 31 === 0.
  const header = Uint8Array.from([0x78, 0x01]);
  return concatBytes(header, raw, be32(adler32(uncompressed)));
}

/**
 * @param {Uint8Array} bytes zlib stream
 * @param {number} expectedSize
 * @returns {Uint8Array}
 */
function zlibUnwrap(bytes, expectedSize) {
  if (bytes.length < 2) throw new Error('png: empty zlib stream');
  const cmf = bytes[0];
  if ((cmf & 0x0f) !== 8) throw new Error(`png: unsupported compression method ${cmf & 0x0f}`);
  const flg = bytes[1];
  if ((flg & 0x20) !== 0) throw new Error('png: preset dictionaries are not supported');
  return inflateRaw(bytes.subarray(2, bytes.length - 4), expectedSize);
}

/**
 * Split a PNG into its chunks.
 * @param {Uint8Array} bytes
 * @returns {{type: string, data: Uint8Array}[]}
 */
export function pngChunks(bytes) {
  if (!isPng(bytes)) throw new Error('png: bad signature');
  /** @type {{type: string, data: Uint8Array}[]} */
  const out = [];
  let i = 8;
  while (i + 8 <= bytes.length) {
    const len = u32(bytes, i);
    const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
    const start = i + 8;
    if (start + len + 4 > bytes.length) throw new Error(`png: truncated chunk ${type}`);
    out.push({ type, data: bytes.subarray(start, start + len) });
    i = start + len + 4;
    if (type === 'IEND') break;
  }
  return out;
}

/**
 * Reverse the per-scanline filters of one (sub)image.
 * @param {Uint8Array} data filtered rows, each prefixed by its filter byte
 * @param {number} width
 * @param {number} height
 * @param {number} bitDepth
 * @param {number} channels
 * @returns {Uint8Array} raw sample bytes, `height * rowBytes`
 */
function unfilter(data, width, height, bitDepth, channels) {
  const bitsPerPixel = bitDepth * channels;
  const rowBytes = Math.ceil((bitsPerPixel * width) / 8);
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));
  const out = new Uint8Array(rowBytes * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = data[pos];
    pos += 1;
    const row = out.subarray(y * rowBytes, (y + 1) * rowBytes);
    const prev = y > 0 ? out.subarray((y - 1) * rowBytes, y * rowBytes) : null;
    for (let x = 0; x < rowBytes; x++) {
      const raw = data[pos + x] ?? 0;
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let value;
      switch (filter) {
        case 0: value = raw; break;
        case 1: value = raw + a; break;
        case 2: value = raw + b; break;
        case 3: value = raw + ((a + b) >> 1); break;
        case 4: value = raw + paeth(a, b, c); break;
        default: throw new Error(`png: unknown filter type ${filter}`);
      }
      row[x] = value & 255;
    }
    pos += rowBytes;
  }
  return out;
}

/** @param {number} a @param {number} b @param {number} c @returns {number} */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Read one sample of `bitDepth` bits at sample index `i` from a row.
 * @param {Uint8Array} row
 * @param {number} i
 * @param {number} bitDepth
 * @returns {number}
 */
function sampleAt(row, i, bitDepth) {
  switch (bitDepth) {
    case 8: return row[i];
    case 16: return row[i * 2]; // high byte: 16-bit input is reduced to 8-bit
    case 4: return (row[i >> 1] >> (i % 2 === 0 ? 4 : 0)) & 0x0f;
    case 2: return (row[i >> 2] >> (6 - 2 * (i % 4))) & 0x03;
    case 1: return (row[i >> 3] >> (7 - (i % 8))) & 0x01;
    default: throw new Error(`png: unsupported bit depth ${bitDepth}`);
  }
}

/** Scale a sample of `bitDepth` bits up to 0..255. */
function scaleTo8(v, bitDepth) {
  switch (bitDepth) {
    case 8: case 16: return v;
    case 4: return v * 17;
    case 2: return v * 85;
    case 1: return v * 255;
    default: return v;
  }
}

/**
 * Decode a PNG to straight 8-bit RGBA.
 * @param {Uint8Array} bytes
 * @returns {{width: number, height: number, rgba: Uint8Array, colorType: number, bitDepth: number, interlace: number, hasAlpha: boolean}}
 */
export function decodePng(bytes) {
  const chunks = pngChunks(bytes);
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  if (!ihdr) throw new Error('png: missing IHDR');
  const width = u32(ihdr.data, 0);
  const height = u32(ihdr.data, 4);
  const bitDepth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const compression = ihdr.data[10];
  const filterMethod = ihdr.data[11];
  const interlace = ihdr.data[12];
  if (compression !== 0) throw new Error(`png: unsupported compression ${compression}`);
  if (filterMethod !== 0) throw new Error(`png: unsupported filter method ${filterMethod}`);
  if (CHANNELS[colorType] === undefined) throw new Error(`png: unsupported colour type ${colorType}`);
  if (width <= 0 || height <= 0) throw new Error('png: zero-sized image');

  const channels = CHANNELS[colorType];
  const palette = chunks.find((c) => c.type === 'PLTE');
  const trns = chunks.find((c) => c.type === 'tRNS');
  const idat = concatBytes(...chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
  if (idat.length === 0) throw new Error('png: missing IDAT');

  const expected = interlace === 1
    ? adam7Size(width, height, bitDepth, channels)
    : height * (1 + Math.ceil((bitDepth * channels * width) / 8));
  const inflated = zlibUnwrap(idat, expected);

  const rgba = new Uint8Array(width * height * 4);
  const emit = (x, y, row, sampleIndex) => {
    const o = (y * width + x) * 4;
    writePixel(rgba, o, row, sampleIndex, colorType, bitDepth, palette, trns);
  };

  if (interlace === 1) {
    let offset = 0;
    for (const [xStart, yStart, xStep, yStep] of ADAM7) {
      const passW = Math.ceil((width - xStart) / xStep);
      const passH = Math.ceil((height - yStart) / yStep);
      if (passW <= 0 || passH <= 0) continue;
      const rowBytes = Math.ceil((bitDepth * channels * passW) / 8);
      const size = passH * (rowBytes + 1);
      const raw = unfilter(inflated.subarray(offset, offset + size), passW, passH, bitDepth, channels);
      offset += size;
      for (let y = 0; y < passH; y++) {
        const row = raw.subarray(y * rowBytes, (y + 1) * rowBytes);
        for (let x = 0; x < passW; x++) emit(xStart + x * xStep, yStart + y * yStep, row, x);
      }
    }
  } else {
    const rowBytes = Math.ceil((bitDepth * channels * width) / 8);
    const raw = unfilter(inflated, width, height, bitDepth, channels);
    for (let y = 0; y < height; y++) {
      const row = raw.subarray(y * rowBytes, (y + 1) * rowBytes);
      for (let x = 0; x < width; x++) emit(x, y, row, x);
    }
  }

  let hasAlpha = false;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) { hasAlpha = true; break; }
  return { width, height, rgba, colorType, bitDepth, interlace, hasAlpha };
}

/** Total filtered byte count of an Adam7 image, used to size the inflate buffer. */
function adam7Size(width, height, bitDepth, channels) {
  let total = 0;
  for (const [xStart, yStart, xStep, yStep] of ADAM7) {
    const passW = Math.ceil((width - xStart) / xStep);
    const passH = Math.ceil((height - yStart) / yStep);
    if (passW <= 0 || passH <= 0) continue;
    total += passH * (1 + Math.ceil((bitDepth * channels * passW) / 8));
  }
  return total;
}

/** Write one decoded pixel into the RGBA buffer. */
function writePixel(rgba, o, row, i, colorType, bitDepth, palette, trns) {
  switch (colorType) {
    case 0: { // greyscale
      const raw = sampleAt(row, i, bitDepth);
      const g = scaleTo8(raw, bitDepth);
      rgba[o] = g; rgba[o + 1] = g; rgba[o + 2] = g;
      rgba[o + 3] = trns && trnsGrey(trns, bitDepth) === raw ? 0 : 255;
      return;
    }
    case 2: { // truecolour
      const r = sampleAt(row, i * 3, bitDepth);
      const g = sampleAt(row, i * 3 + 1, bitDepth);
      const b = sampleAt(row, i * 3 + 2, bitDepth);
      rgba[o] = scaleTo8(r, bitDepth); rgba[o + 1] = scaleTo8(g, bitDepth); rgba[o + 2] = scaleTo8(b, bitDepth);
      let alpha = 255;
      if (trns && trns.data.length >= 6) {
        const kr = bitDepth === 16 ? trns.data[0] : trns.data[1];
        const kg = bitDepth === 16 ? trns.data[2] : trns.data[3];
        const kb = bitDepth === 16 ? trns.data[4] : trns.data[5];
        if (r === kr && g === kg && b === kb) alpha = 0;
      }
      rgba[o + 3] = alpha;
      return;
    }
    case 3: { // palette
      const idx = sampleAt(row, i, bitDepth);
      const p = palette ? palette.data : new Uint8Array(0);
      rgba[o] = p[idx * 3] ?? 0;
      rgba[o + 1] = p[idx * 3 + 1] ?? 0;
      rgba[o + 2] = p[idx * 3 + 2] ?? 0;
      rgba[o + 3] = trns && idx < trns.data.length ? trns.data[idx] : 255;
      return;
    }
    case 4: { // greyscale + alpha
      const g = scaleTo8(sampleAt(row, i * 2, bitDepth), bitDepth);
      const a = scaleTo8(sampleAt(row, i * 2 + 1, bitDepth), bitDepth);
      rgba[o] = g; rgba[o + 1] = g; rgba[o + 2] = g; rgba[o + 3] = a;
      return;
    }
    default: { // 6 — truecolour + alpha
      rgba[o] = scaleTo8(sampleAt(row, i * 4, bitDepth), bitDepth);
      rgba[o + 1] = scaleTo8(sampleAt(row, i * 4 + 1, bitDepth), bitDepth);
      rgba[o + 2] = scaleTo8(sampleAt(row, i * 4 + 2, bitDepth), bitDepth);
      rgba[o + 3] = scaleTo8(sampleAt(row, i * 4 + 3, bitDepth), bitDepth);
    }
  }
}

/** The grey transparency key, at the image's bit depth. */
function trnsGrey(trns, bitDepth) {
  if (!trns || trns.data.length < 2) return -1;
  const v = (trns.data[0] << 8) | trns.data[1];
  return bitDepth === 16 ? trns.data[0] : v;
}

/** @param {string} type @param {Uint8Array} data @returns {Uint8Array} */
function chunk(type, data) {
  const typeBytes = Uint8Array.from([...type].map((c) => c.charCodeAt(0)));
  const body = concatBytes(typeBytes, data);
  return concatBytes(be32(data.length), body, be32(crc32(body)));
}

/**
 * Filter one scanline with every filter type and keep the one with the smallest
 * sum of absolute signed differences — the heuristic the PNG specification
 * itself recommends, and deterministic.
 */
function filterRow(row, prev, bpp, out, outOffset) {
  const n = row.length;
  let bestType = 0;
  let bestScore = Infinity;
  /** @type {Uint8Array} */
  let best = new Uint8Array(n);
  const candidate = new Uint8Array(n);
  for (let type = 0; type <= 4; type++) {
    let score = 0;
    for (let x = 0; x < n; x++) {
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v;
      switch (type) {
        case 0: v = row[x]; break;
        case 1: v = row[x] - a; break;
        case 2: v = row[x] - b; break;
        case 3: v = row[x] - ((a + b) >> 1); break;
        default: v = row[x] - paeth(a, b, c);
      }
      v &= 255;
      candidate[x] = v;
      score += v < 128 ? v : 256 - v;
    }
    if (score < bestScore) {
      bestScore = score;
      bestType = type;
      best = candidate.slice();
    }
  }
  out[outOffset] = bestType;
  out.set(best, outOffset + 1);
}

/**
 * Encode 8-bit RGBA pixels as a PNG.
 * @param {Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 * @param {{palette?: {colors: number[][], indices: Uint8Array}}} [options]
 * @returns {Uint8Array}
 */
export function encodePng(rgba, width, height, options = {}) {
  if (rgba.length < width * height * 4) throw new Error('png: pixel buffer too small');
  const palette = options.palette || null;

  /** @type {Uint8Array} */
  let samples;
  let colorType;
  let channels;
  if (palette) {
    colorType = 3;
    channels = 1;
    samples = palette.indices;
  } else {
    let hasAlpha = false;
    for (let i = 3; i < width * height * 4; i += 4) if (rgba[i] !== 255) { hasAlpha = true; break; }
    colorType = hasAlpha ? 6 : 2;
    channels = hasAlpha ? 4 : 3;
    samples = new Uint8Array(width * height * channels);
    let o = 0;
    for (let i = 0; i < width * height; i++) {
      samples[o] = rgba[i * 4];
      samples[o + 1] = rgba[i * 4 + 1];
      samples[o + 2] = rgba[i * 4 + 2];
      if (hasAlpha) samples[o + 3] = rgba[i * 4 + 3];
      o += channels;
    }
  }

  const rowBytes = width * channels;
  const filtered = new Uint8Array(height * (rowBytes + 1));
  for (let y = 0; y < height; y++) {
    const row = samples.subarray(y * rowBytes, (y + 1) * rowBytes);
    const prev = y > 0 ? samples.subarray((y - 1) * rowBytes, y * rowBytes) : null;
    filterRow(row, prev, channels, filtered, y * (rowBytes + 1));
  }

  const ihdr = new Uint8Array(13);
  ihdr.set(be32(width), 0);
  ihdr.set(be32(height), 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  /** @type {Uint8Array[]} */
  const parts = [PNG_SIGNATURE, chunk('IHDR', ihdr)];
  if (palette) {
    const plte = new Uint8Array(palette.colors.length * 3);
    let alphaCount = 0;
    palette.colors.forEach((c, i) => {
      plte[i * 3] = c[0]; plte[i * 3 + 1] = c[1]; plte[i * 3 + 2] = c[2];
      if (c[3] < 255) alphaCount = i + 1;
    });
    parts.push(chunk('PLTE', plte));
    if (alphaCount > 0) {
      const trns = new Uint8Array(alphaCount);
      for (let i = 0; i < alphaCount; i++) trns[i] = palette.colors[i][3];
      parts.push(chunk('tRNS', trns));
    }
  }
  parts.push(chunk('IDAT', zlibWrap(deflateRaw(filtered), filtered)));
  parts.push(chunk('IEND', new Uint8Array(0)));
  return concatBytes(...parts);
}

/**
 * Intrinsic size of a PNG without decoding its pixels.
 * @param {Uint8Array} bytes
 * @returns {{w: number, h: number}|null}
 */
export function pngSize(bytes) {
  if (!isPng(bytes) || bytes.length < 24) return null;
  return { w: u32(bytes, 16), h: u32(bytes, 20) };
}
