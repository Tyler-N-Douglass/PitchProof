/**
 * A dependency-free PNG codec, for the size budgeter (§13, §17.10, §22.5).
 *
 * §13 requires the emitter to "downscale progressively until under budget" and
 * to "report exactly what was degraded and by how much — never silently". A
 * report of bytes saved is only honest if the bytes were actually saved, which
 * means the emitter has to genuinely re-encode the image rather than estimate
 * what a re-encode would cost. In Node there is no canvas to borrow, and D3
 * rules out an npm decoder, so the codec lives here.
 *
 * Scope, chosen so that what it does it does exactly:
 *   - decodes non-interlaced PNG at bit depths 8 and 16, colour types 0/2/3/4/6;
 *   - resamples with a box filter over the source pixels covered by each
 *     destination pixel, which is the correct area average for downscaling and
 *     is deterministic to the last unit;
 *   - re-encodes 8-bit RGB or RGBA with per-row adaptive filtering and our own
 *     DEFLATE, so two emits of the same project produce the same bytes (§5).
 *
 * Formats it cannot re-encode — JPEG, WebP, AVIF, interlaced PNG — are reported
 * as not degradable rather than silently left alone; `budgetAssets` says so in
 * the plan and, if the budget still cannot be met, raises `SIZE_BUDGET_EXCEEDED`
 * instead of shipping something over budget.
 *
 * @module emit/png
 */

import { deflateRaw } from '../core/deflate.js';
import { inflateRaw } from '../core/inflate.js';
import { crc32 } from '../core/zip.js';
import { concatBytes } from '../core/bytes.js';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** @typedef {{width: number, height: number, rgba: Uint8Array}} RasterImage */

/**
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
export function isPng(bytes) {
  if (!bytes || bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  return true;
}

/**
 * Read the chunk list.
 * @param {Uint8Array} bytes
 * @returns {{type: string, data: Uint8Array}[]}
 */
export function readChunks(bytes) {
  /** @type {{type: string, data: Uint8Array}[]} */
  const out = [];
  let i = 8;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (i + 8 <= bytes.length) {
    const length = view.getUint32(i);
    const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
    const start = i + 8;
    const end = start + length;
    if (end > bytes.length) break;
    out.push({ type, data: bytes.subarray(start, end) });
    i = end + 4;
    if (type === 'IEND') break;
  }
  return out;
}

/**
 * Decode a PNG to straight RGBA8.
 * @param {Uint8Array} bytes
 * @returns {RasterImage|null} null when the file is not a PNG this codec handles
 */
export function decodePng(bytes) {
  if (!isPng(bytes)) return null;
  const chunks = readChunks(bytes);
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  if (!ihdr || ihdr.data.length < 13) return null;
  const dv = new DataView(ihdr.data.buffer, ihdr.data.byteOffset, ihdr.data.byteLength);
  const width = dv.getUint32(0);
  const height = dv.getUint32(4);
  const bitDepth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const compression = ihdr.data[10];
  const filterMethod = ihdr.data[11];
  const interlace = ihdr.data[12];
  if (compression !== 0 || filterMethod !== 0 || interlace !== 0) return null;
  if (![8, 16].includes(bitDepth) && !(colorType === 3 && [1, 2, 4, 8].includes(bitDepth))) return null;
  if (![0, 2, 3, 4, 6].includes(colorType)) return null;
  if (width <= 0 || height <= 0 || width * height > 64_000_000) return null;

  const idat = concatBytes(...chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
  if (idat.length < 3) return null;
  /** @type {Uint8Array} */
  let raw;
  try {
    raw = inflateRaw(idat.subarray(2));       // strip the 2-byte zlib header
  } catch {
    return null;
  }

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const bpp = Math.max(1, Math.ceil((channels * bitDepth) / 8));
  const rowBytes = Math.ceil((channels * bitDepth * width) / 8);
  if (raw.length < (rowBytes + 1) * height) return null;

  const lines = new Uint8Array(rowBytes * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const rowStart = y * rowBytes;
    const prevStart = (y - 1) * rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const rawByte = raw[pos + x];
      const a = x >= bpp ? lines[rowStart + x - bpp] : 0;
      const b = y > 0 ? lines[prevStart + x] : 0;
      const c = x >= bpp && y > 0 ? lines[prevStart + x - bpp] : 0;
      let value;
      switch (filter) {
        case 0: value = rawByte; break;
        case 1: value = rawByte + a; break;
        case 2: value = rawByte + b; break;
        case 3: value = rawByte + ((a + b) >> 1); break;
        case 4: value = rawByte + paeth(a, b, c); break;
        default: return null;
      }
      lines[rowStart + x] = value & 0xff;
    }
    pos += rowBytes;
  }

  const palette = chunks.find((c) => c.type === 'PLTE');
  const trns = chunks.find((c) => c.type === 'tRNS');
  const rgba = new Uint8Array(width * height * 4);

  const sample = (row, index) => {
    if (bitDepth === 8) return lines[row * rowBytes + index];
    if (bitDepth === 16) return lines[row * rowBytes + index * 2];       // take the high byte
    const bitsPerSample = bitDepth;
    const bitIndex = index * bitsPerSample;
    const byte = lines[row * rowBytes + (bitIndex >> 3)];
    const shift = 8 - bitsPerSample - (bitIndex & 7);
    const max = (1 << bitsPerSample) - 1;
    return (byte >> shift) & max;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (colorType === 0) {
        const g = bitDepth < 8 ? Math.round((sample(y, x) * 255) / ((1 << bitDepth) - 1)) : sample(y, x);
        rgba[o] = g; rgba[o + 1] = g; rgba[o + 2] = g; rgba[o + 3] = 255;
      } else if (colorType === 2) {
        rgba[o] = sample(y, x * 3); rgba[o + 1] = sample(y, x * 3 + 1); rgba[o + 2] = sample(y, x * 3 + 2); rgba[o + 3] = 255;
      } else if (colorType === 3) {
        const idx = sample(y, x);
        const p = palette ? palette.data : new Uint8Array(0);
        rgba[o] = p[idx * 3] ?? 0; rgba[o + 1] = p[idx * 3 + 1] ?? 0; rgba[o + 2] = p[idx * 3 + 2] ?? 0;
        rgba[o + 3] = trns && idx < trns.data.length ? trns.data[idx] : 255;
      } else if (colorType === 4) {
        const g = sample(y, x * 2);
        rgba[o] = g; rgba[o + 1] = g; rgba[o + 2] = g; rgba[o + 3] = sample(y, x * 2 + 1);
      } else {
        rgba[o] = sample(y, x * 4); rgba[o + 1] = sample(y, x * 4 + 1);
        rgba[o + 2] = sample(y, x * 4 + 2); rgba[o + 3] = sample(y, x * 4 + 3);
      }
    }
  }
  return { width, height, rgba };
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
 * Area-average downscale. Exact for any ratio, and deterministic: every
 * destination pixel is the mean of the source pixels its box covers, with alpha
 * pre-multiplied so transparent pixels do not drag colour into their neighbours.
 *
 * @param {RasterImage} image
 * @param {number} targetW
 * @param {number} targetH
 * @returns {RasterImage}
 */
export function resample(image, targetW, targetH) {
  const w = Math.max(1, Math.round(targetW));
  const h = Math.max(1, Math.round(targetH));
  if (w === image.width && h === image.height) return { width: w, height: h, rgba: image.rgba.slice() };
  const out = new Uint8Array(w * h * 4);
  const sx = image.width / w;
  const sy = image.height / h;

  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.min(image.height, Math.ceil((y + 1) * sy)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.min(image.width, Math.ceil((x + 1) * sx)));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const o = (yy * image.width + xx) * 4;
          const alpha = image.rgba[o + 3];
          r += image.rgba[o] * alpha;
          g += image.rgba[o + 1] * alpha;
          b += image.rgba[o + 2] * alpha;
          a += alpha;
          n++;
        }
      }
      const o = (y * w + x) * 4;
      if (a === 0) { out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0; continue; }
      out[o] = Math.round(r / a);
      out[o + 1] = Math.round(g / a);
      out[o + 2] = Math.round(b / a);
      out[o + 3] = Math.round(a / n);
    }
  }
  return { width: w, height: h, rgba: out };
}

/**
 * Adler-32, for the zlib wrapper PNG requires around its DEFLATE stream.
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

/**
 * @param {string} type
 * @param {Uint8Array} data
 * @returns {Uint8Array}
 */
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crcInput = out.subarray(4, 8 + data.length);
  dv.setUint32(8 + data.length, crc32(crcInput) >>> 0);
  return out;
}

/**
 * Encode RGBA8 as a PNG. Drops the alpha channel when every pixel is opaque,
 * which is a real saving on the common case and changes nothing on screen.
 *
 * @param {RasterImage} image
 * @returns {Uint8Array}
 */
export function encodePng(image) {
  const { width, height, rgba } = image;
  let opaque = true;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) { opaque = false; break; }
  const channels = opaque ? 3 : 4;
  const colorType = opaque ? 2 : 6;
  const rowBytes = width * channels;

  const raw = new Uint8Array((rowBytes + 1) * height);
  const current = new Uint8Array(rowBytes);
  const previous = new Uint8Array(rowBytes);
  const candidate = new Uint8Array(rowBytes);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const dst = x * channels;
      current[dst] = rgba[src];
      current[dst + 1] = rgba[src + 1];
      current[dst + 2] = rgba[src + 2];
      if (channels === 4) current[dst + 3] = rgba[src + 3];
    }
    // Adaptive filtering: pick the filter whose output has the smallest sum of
    // absolute differences, the heuristic the PNG specification recommends.
    let bestFilter = 0;
    let bestScore = Infinity;
    /** @type {Uint8Array} */
    let bestRow = candidate;
    const rowOut = raw.subarray(y * (rowBytes + 1) + 1, (y + 1) * (rowBytes + 1));
    for (let f = 0; f <= 4; f++) {
      let score = 0;
      for (let i = 0; i < rowBytes; i++) {
        const a = i >= channels ? current[i - channels] : 0;
        const b = previous[i];
        const c = i >= channels ? previous[i - channels] : 0;
        let v;
        switch (f) {
          case 0: v = current[i]; break;
          case 1: v = current[i] - a; break;
          case 2: v = current[i] - b; break;
          case 3: v = current[i] - ((a + b) >> 1); break;
          default: v = current[i] - paeth(a, b, c); break;
        }
        v &= 0xff;
        candidate[i] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        bestFilter = f;
        bestRow = candidate.slice();
      }
    }
    raw[y * (rowBytes + 1)] = bestFilter;
    rowOut.set(bestRow);
    previous.set(current);
  }

  const deflated = deflateRaw(raw);
  const zlib = new Uint8Array(2 + deflated.length + 4);
  zlib[0] = 0x78;
  zlib[1] = 0x01;
  zlib.set(deflated, 2);
  new DataView(zlib.buffer).setUint32(2 + deflated.length, adler32(raw));

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return concatBytes(
    new Uint8Array(PNG_SIGNATURE),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib),
    chunk('IEND', new Uint8Array(0)),
  );
}

/**
 * Decode, resample and re-encode in one step.
 * @param {Uint8Array} bytes
 * @param {number} scale  0 < scale <= 1
 * @returns {{bytes: Uint8Array, width: number, height: number}|null}
 */
export function rescalePng(bytes, scale) {
  const image = decodePng(bytes);
  if (!image) return null;
  const w = Math.max(1, Math.round(image.width * scale));
  const h = Math.max(1, Math.round(image.height * scale));
  const scaled = scale === 1 ? image : resample(image, w, h);
  return { bytes: encodePng(scaled), width: scaled.width, height: scaled.height };
}

/**
 * Dimensions without a full decode, for the budgeter's ranking pass.
 * @param {Uint8Array} bytes
 * @returns {{w: number, h: number}|null}
 */
export function pngSize(bytes) {
  if (!isPng(bytes) || bytes.length < 24) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { w: dv.getUint32(16), h: dv.getUint32(20) };
}
