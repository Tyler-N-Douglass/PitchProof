/**
 * Embedded image extraction from PDFs (D9).
 *
 * D9's line is exact: PitchProof lifts the images a PDF *contains*, and does
 * not render the pages it *describes*. A `DCTDecode` XObject already is a JPEG,
 * so it comes out whole and byte-identical. A `FlateDecode` bitmap is raw
 * samples, so it is re-encoded as a PNG here — including its soft mask, because
 * a logo that loses its transparency is a logo the brand lane cannot use.
 *
 * Anything behind a filter this repo does not decode (`JPXDecode`,
 * `CCITTFaxDecode`, `JBIG2Decode`) is reported as skipped rather than guessed
 * at. §18 forbids implying a capability that was not performed.
 *
 * @module ingest/pdf/image
 */

import { PdfStream, nameOf } from './lexer.js';
import { deflateRaw } from '../../core/deflate.js';
import { crc32 } from '../../core/zip.js';

/** @typedef {import('./document.js').PdfDocument} PdfDocument */

/**
 * @typedef {object} ExtractedImage
 * @property {string} name
 * @property {Uint8Array} bytes
 * @property {string} mime
 * @property {number} width
 * @property {number} height
 * @property {string|null} alt
 * @property {number} page
 * @property {boolean} hasAlpha
 */

/**
 * Every image XObject reachable from a page, in resource order.
 *
 * @param {PdfDocument} doc
 * @param {Record<string, any>} page
 * @param {number} pageNumber
 * @param {{skipped: {name: string, filter: string}[]}} report
 * @returns {ExtractedImage[]}
 */
export function extractPageImages(doc, page, pageNumber, report) {
  /** @type {ExtractedImage[]} */
  const images = [];
  /** @type {Set<any>} */
  const seen = new Set();

  /**
   * @param {Record<string, any>|null} resources
   * @param {number} depth
   */
  const visit = (resources, depth) => {
    if (!resources || depth > 6) return;
    const xobjects = doc.dictGet(resources, 'XObject');
    if (!xobjects || typeof xobjects !== 'object') return;
    for (const key of Object.keys(xobjects)) {
      const raw = xobjects[key];
      const identity = raw && raw.key !== undefined ? raw.key : raw;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const stream = doc.resolve(raw);
      if (!(stream instanceof PdfStream)) continue;
      const subtype = nameOf(doc.dictGet(stream.dict, 'Subtype'));
      if (subtype === 'Form') {
        visit(doc.dictGet(stream.dict, 'Resources'), depth + 1);
        continue;
      }
      if (subtype !== 'Image') continue;
      const extracted = decodeImage(doc, stream, `${key}`, pageNumber, report);
      if (extracted) images.push(extracted);
    }
  };

  visit(doc.dictGet(page, 'Resources'), 0);
  return images;
}

/**
 * @param {PdfDocument} doc
 * @param {PdfStream} stream
 * @param {string} key
 * @param {number} pageNumber
 * @param {{skipped: {name: string, filter: string}[]}} report
 * @returns {ExtractedImage|null}
 */
export function decodeImage(doc, stream, key, pageNumber, report) {
  const dict = stream.dict;
  const width = Number(doc.dictGet(dict, 'Width') ?? doc.dictGet(dict, 'W') ?? 0);
  const height = Number(doc.dictGet(dict, 'Height') ?? doc.dictGet(dict, 'H') ?? 0);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  if (width * height > 40_000_000) {
    report.skipped.push({ name: key, filter: 'oversize' });
    return null;
  }

  const decoded = doc.decodeDetailed(stream);
  if (!decoded) return null;
  const base = `page${String(pageNumber).padStart(3, '0')}-${sanitize(key)}`;

  if (decoded.remaining === 'DCTDecode' || decoded.remaining === 'DCT') {
    return {
      name: `${base}.jpg`,
      bytes: decoded.bytes.slice(),
      mime: 'image/jpeg',
      width,
      height,
      alt: null,
      page: pageNumber,
      hasAlpha: false,
    };
  }
  if (decoded.remaining) {
    report.skipped.push({ name: key, filter: decoded.remaining });
    return null;
  }

  const bpc = Number(doc.dictGet(dict, 'BitsPerComponent') ?? doc.dictGet(dict, 'BPC') ?? 8);
  const isMask = doc.dictGet(dict, 'ImageMask') === true || doc.dictGet(dict, 'IM') === true;
  const decode = doc.dictGet(dict, 'Decode') ?? doc.dictGet(dict, 'D');
  const invert = Array.isArray(decode) && Number(doc.resolve(decode[0])) === 1;

  /** @type {Uint8Array|null} */
  let rgb = null;
  if (isMask) {
    rgb = expandStencil(decoded.bytes, width, height, invert);
  } else {
    const space = resolveColorSpace(doc, doc.dictGet(dict, 'ColorSpace') ?? doc.dictGet(dict, 'CS'));
    rgb = samplesToRgb(decoded.bytes, width, height, bpc, space, invert);
  }
  if (!rgb) {
    report.skipped.push({ name: key, filter: 'unsupported colour space' });
    return null;
  }

  const alpha = softMaskAlpha(doc, dict, width, height);
  const png = alpha ? encodePngRgba(width, height, rgb, alpha) : encodePngRgb(width, height, rgb);
  return {
    name: `${base}.png`,
    bytes: png,
    mime: 'image/png',
    width,
    height,
    alt: null,
    page: pageNumber,
    hasAlpha: Boolean(alpha),
  };
}

/**
 * @param {string} key
 * @returns {string}
 */
function sanitize(key) { return String(key).replace(/[^A-Za-z0-9_-]+/g, '') || 'image'; }

/**
 * @typedef {{kind: 'gray'|'rgb'|'cmyk'|'indexed', components: number,
 *            palette?: Uint8Array, hival?: number, baseComponents?: number}} ColorSpaceInfo
 */

/**
 * Resolve a colour space object into the facts the sample converter needs.
 * @param {PdfDocument} doc
 * @param {any} space
 * @returns {ColorSpaceInfo|null}
 */
export function resolveColorSpace(doc, space) {
  const resolved = doc.resolve(space);
  const name = nameOf(resolved);
  if (name) {
    switch (name) {
      case 'DeviceGray': case 'G': case 'CalGray': return { kind: 'gray', components: 1 };
      case 'DeviceRGB': case 'RGB': case 'CalRGB': return { kind: 'rgb', components: 3 };
      case 'DeviceCMYK': case 'CMYK': return { kind: 'cmyk', components: 4 };
      case 'Pattern': return null;
      default: return { kind: 'gray', components: 1 };
    }
  }
  if (!Array.isArray(resolved) || !resolved.length) return null;
  const family = nameOf(doc.resolve(resolved[0]));
  switch (family) {
    case 'ICCBased': {
      const streamRef = doc.resolve(resolved[1]);
      const n = streamRef instanceof PdfStream ? Number(doc.dictGet(streamRef.dict, 'N') || 3) : 3;
      if (n === 1) return { kind: 'gray', components: 1 };
      if (n === 4) return { kind: 'cmyk', components: 4 };
      return { kind: 'rgb', components: 3 };
    }
    case 'Indexed': case 'I': {
      const base = resolveColorSpace(doc, resolved[1]);
      const hival = Number(doc.resolve(resolved[2]) || 0);
      const lookupValue = doc.resolve(resolved[3]);
      /** @type {Uint8Array|null} */
      let palette = null;
      if (lookupValue instanceof PdfStream) {
        const data = doc.decode(lookupValue);
        if (data) palette = data;
      } else if (lookupValue && lookupValue.bytes instanceof Uint8Array) {
        palette = lookupValue.bytes;
      }
      if (!base || !palette) return null;
      return { kind: 'indexed', components: 1, palette, hival, baseComponents: base.components };
    }
    case 'Separation': case 'DeviceN':
      return { kind: 'gray', components: family === 'Separation' ? 1 : Math.max(1, (doc.resolve(resolved[1]) || []).length || 1) };
    case 'CalRGB': case 'Lab': return { kind: 'rgb', components: 3 };
    case 'CalGray': return { kind: 'gray', components: 1 };
    case 'DeviceGray': return { kind: 'gray', components: 1 };
    case 'DeviceRGB': return { kind: 'rgb', components: 3 };
    case 'DeviceCMYK': return { kind: 'cmyk', components: 4 };
    default: return null;
  }
}

/**
 * Read the `index`-th sample of `bpc` bits.
 * @param {Uint8Array} data
 * @param {number} bitOffset
 * @param {number} bpc
 * @returns {number}
 */
function readSample(data, bitOffset, bpc) {
  if (bpc === 8) return data[bitOffset >> 3] || 0;
  if (bpc === 16) {
    const at = bitOffset >> 3;
    return data[at] || 0;                            // take the high byte
  }
  const byte = data[bitOffset >> 3] || 0;
  const shift = 8 - bpc - (bitOffset & 7);
  return (byte >> shift) & ((1 << bpc) - 1);
}

/**
 * Convert decoded samples into packed 8-bit RGB.
 * @param {Uint8Array} data
 * @param {number} width
 * @param {number} height
 * @param {number} bpc
 * @param {ColorSpaceInfo|null} space
 * @param {boolean} invert
 * @returns {Uint8Array|null}
 */
export function samplesToRgb(data, width, height, bpc, space, invert) {
  if (!space) return null;
  if (![1, 2, 4, 8, 16].includes(bpc)) return null;
  const components = space.components;
  const max = (1 << Math.min(bpc, 8)) - 1;
  const rowBits = width * components * bpc;
  const rowBytes = Math.ceil(rowBits / 8);
  const out = new Uint8Array(width * height * 3);
  const scale = 255 / (max || 1);

  for (let y = 0; y < height; y++) {
    const rowStart = y * rowBytes * 8;
    for (let x = 0; x < width; x++) {
      const at = rowStart + x * components * bpc;
      const o = (y * width + x) * 3;
      if (space.kind === 'indexed') {
        const index = readSample(data, at, bpc);
        const palette = /** @type {Uint8Array} */ (space.palette);
        const n = space.baseComponents || 3;
        const p = index * n;
        if (n === 3) {
          out[o] = palette[p] || 0;
          out[o + 1] = palette[p + 1] || 0;
          out[o + 2] = palette[p + 2] || 0;
        } else if (n === 1) {
          const g = palette[p] || 0;
          out[o] = g; out[o + 1] = g; out[o + 2] = g;
        } else {
          const c = (palette[p] || 0) / 255, m = (palette[p + 1] || 0) / 255;
          const yy = (palette[p + 2] || 0) / 255, k = (palette[p + 3] || 0) / 255;
          out[o] = Math.round(255 * (1 - Math.min(1, c + k)));
          out[o + 1] = Math.round(255 * (1 - Math.min(1, m + k)));
          out[o + 2] = Math.round(255 * (1 - Math.min(1, yy + k)));
        }
        continue;
      }
      if (space.kind === 'gray') {
        let g = readSample(data, at, bpc) * scale;
        if (invert) g = 255 - g;
        const v = clamp255(g);
        out[o] = v; out[o + 1] = v; out[o + 2] = v;
        continue;
      }
      if (space.kind === 'rgb') {
        const step = bpc === 16 ? 16 : bpc;
        out[o] = clamp255(readSample(data, at, bpc) * scale);
        out[o + 1] = clamp255(readSample(data, at + step, bpc) * scale);
        out[o + 2] = clamp255(readSample(data, at + step * 2, bpc) * scale);
        continue;
      }
      // CMYK
      const step = bpc === 16 ? 16 : bpc;
      const c = readSample(data, at, bpc) / max;
      const m = readSample(data, at + step, bpc) / max;
      const yy = readSample(data, at + step * 2, bpc) / max;
      const k = readSample(data, at + step * 3, bpc) / max;
      out[o] = clamp255(255 * (1 - Math.min(1, c + k)));
      out[o + 1] = clamp255(255 * (1 - Math.min(1, m + k)));
      out[o + 2] = clamp255(255 * (1 - Math.min(1, yy + k)));
    }
  }
  return out;
}

/**
 * A 1-bit stencil mask becomes a black-on-white bitmap.
 * @param {Uint8Array} data
 * @param {number} width
 * @param {number} height
 * @param {boolean} invert
 * @returns {Uint8Array}
 */
function expandStencil(data, width, height, invert) {
  const rowBytes = Math.ceil(width / 8);
  const out = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const bit = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
      const on = invert ? bit === 1 : bit === 0;
      const v = on ? 0 : 255;
      const o = (y * width + x) * 3;
      out[o] = v; out[o + 1] = v; out[o + 2] = v;
    }
  }
  return out;
}

/**
 * The alpha channel from an `/SMask`, resampled to the image's dimensions.
 * @param {PdfDocument} doc
 * @param {Record<string, any>} dict
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array|null}
 */
function softMaskAlpha(doc, dict, width, height) {
  const smask = doc.dictGet(dict, 'SMask');
  if (!(smask instanceof PdfStream)) return null;
  const decoded = doc.decodeDetailed(smask);
  if (!decoded || decoded.remaining) return null;
  const mw = Number(doc.dictGet(smask.dict, 'Width') || 0);
  const mh = Number(doc.dictGet(smask.dict, 'Height') || 0);
  const bpc = Number(doc.dictGet(smask.dict, 'BitsPerComponent') || 8);
  if (!mw || !mh) return null;
  const rowBytes = Math.ceil((mw * bpc) / 8);
  const max = (1 << Math.min(bpc, 8)) - 1;
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const my = Math.min(mh - 1, Math.floor((y * mh) / height));
    for (let x = 0; x < width; x++) {
      const mx = Math.min(mw - 1, Math.floor((x * mw) / width));
      const value = readSample(decoded.bytes, my * rowBytes * 8 + mx * bpc, bpc);
      out[y * width + x] = clamp255((value * 255) / (max || 1));
    }
  }
  return out;
}

/**
 * @param {number} n
 * @returns {number}
 */
function clamp255(n) { return n < 0 ? 0 : n > 255 ? 255 : Math.round(n); }

// ---------------------------------------------------------------------------
// PNG encoding
// ---------------------------------------------------------------------------

/**
 * Adler-32, the checksum a zlib stream carries.
 * @param {Uint8Array} data
 * @returns {number}
 */
export function adler32(data) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Wrap raw DEFLATE output in a zlib container. `deflateRaw` is this repo's own
 * deterministic compressor (D5), so the PNG bytes are reproducible.
 * @param {Uint8Array} data
 * @returns {Uint8Array}
 */
export function zlibWrap(data) {
  const compressed = deflateRaw(data);
  const out = new Uint8Array(compressed.length + 6);
  out[0] = 0x78;
  out[1] = 0x01;
  out.set(compressed, 2);
  const sum = adler32(data);
  out[out.length - 4] = (sum >>> 24) & 0xff;
  out[out.length - 3] = (sum >>> 16) & 0xff;
  out[out.length - 2] = (sum >>> 8) & 0xff;
  out[out.length - 1] = sum & 0xff;
  return out;
}

/**
 * @param {string} tag
 * @param {Uint8Array} data
 * @returns {Uint8Array}
 */
function pngChunk(tag, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = tag.charCodeAt(i);
  out.set(data, 8);
  const body = out.subarray(4, 8 + data.length);
  view.setUint32(8 + data.length, crc32(body));
  return out;
}

/**
 * @param {number} width
 * @param {number} height
 * @param {number} colorType   2 = RGB, 6 = RGBA
 * @param {Uint8Array} raw     rows already prefixed with their filter byte
 * @returns {Uint8Array}
 */
function assemblePng(width, height, colorType, raw) {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;              // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0;             // deflate
  ihdr[11] = 0;             // adaptive filtering
  ihdr[12] = 0;             // no interlace
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunks = [signature, pngChunk('IHDR', ihdr), pngChunk('IDAT', zlibWrap(raw)), pngChunk('IEND', new Uint8Array(0))];
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/**
 * Encode packed RGB samples as a PNG.
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgb
 * @returns {Uint8Array}
 */
export function encodePngRgb(width, height, rgb) {
  const stride = width * 3;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return assemblePng(width, height, 2, raw);
}

/**
 * Encode packed RGB samples plus an alpha plane as a PNG.
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgb
 * @param {Uint8Array} alpha
 * @returns {Uint8Array}
 */
export function encodePngRgba(width, height, rgb, alpha) {
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1);
    raw[base] = 0;
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 3;
      const d = base + 1 + x * 4;
      raw[d] = rgb[s];
      raw[d + 1] = rgb[s + 1];
      raw[d + 2] = rgb[s + 2];
      raw[d + 3] = alpha[y * width + x];
    }
  }
  return assemblePng(width, height, 6, raw);
}
