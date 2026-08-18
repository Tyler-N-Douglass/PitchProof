/**
 * PDF stream filters (D9).
 *
 * Everything a PDF holds — page content, cross-reference streams, object
 * streams, `ToUnicode` CMaps, embedded bitmaps — arrives behind one or more of
 * these filters. `FlateDecode` covers the overwhelming majority and is served
 * by `src/core/inflate.js`; the rest are here because a document that uses
 * `ASCII85Decode` for one object should not fail the whole import.
 *
 * Image filters (`DCTDecode`, `JPXDecode`, `CCITTFaxDecode`, `JBIG2Decode`) are
 * deliberately *not* decoded: `DCTDecode` data is already a JPEG and is lifted
 * out whole, and the others are handed back untouched so the caller can say so
 * honestly rather than produce a wrong picture.
 *
 * @module ingest/pdf/filters
 */

import { inflateRaw } from '../../core/inflate.js';

/** Filters whose output is image data this module does not decode. */
export const IMAGE_FILTERS = new Set(['DCTDecode', 'DCT', 'JPXDecode', 'CCITTFaxDecode', 'JBIG2Decode']);

/** Thrown when a stream cannot be decoded at all. */
export class FilterError extends Error {}

/**
 * Inflate a zlib-wrapped or raw DEFLATE stream. PDF says zlib; plenty of real
 * writers emit raw, and a few prepend whitespace, so all three are handled.
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
export function inflatePdf(bytes) {
  let data = bytes;
  // Some producers leave the EOL after `stream` in the data.
  let start = 0;
  while (start < data.length && (data[start] === 0x0a || data[start] === 0x0d || data[start] === 0x20 || data[start] === 0x09)) start += 1;
  if (start > 0) data = data.subarray(start);
  if (!data.length) return new Uint8Array(0);

  const cmf = data[0];
  const flg = data[1];
  const looksZlib = (cmf & 0x0f) === 8 && data.length > 2 && ((cmf << 8) | flg) % 31 === 0;
  const attempts = looksZlib ? [data.subarray(2), data] : [data, data.subarray(2)];
  /** @type {Error|null} */
  let firstError = null;
  for (const attempt of attempts) {
    try {
      return inflateRaw(attempt);
    } catch (e) {
      if (!firstError) firstError = e instanceof Error ? e : new Error(String(e));
    }
  }
  // A truncated stream is common in the wild; salvage what inflated cleanly
  // rather than losing the object.
  const salvaged = salvageInflate(looksZlib ? data.subarray(2) : data);
  if (salvaged) return salvaged;
  throw new FilterError(`FlateDecode failed: ${firstError ? firstError.message : 'unknown'}`);
}

/**
 * Inflate as much of a damaged stream as decodes cleanly, by retrying against
 * progressively shorter prefixes. Returns null when nothing decodes.
 * @param {Uint8Array} bytes
 * @returns {Uint8Array|null}
 */
function salvageInflate(bytes) {
  for (let cut = bytes.length - 1; cut > 16; cut -= Math.max(1, Math.floor(bytes.length / 32))) {
    try {
      const out = inflateRaw(bytes.subarray(0, cut));
      if (out.length) return out;
    } catch { /* keep shortening */ }
  }
  return null;
}

/**
 * `ASCIIHexDecode`.
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
export function asciiHexDecode(bytes) {
  /** @type {number[]} */
  const out = [];
  let high = -1;
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    if (c === 0x3e) break;                       // '>'
    let v = -1;
    if (c >= 0x30 && c <= 0x39) v = c - 0x30;
    else if (c >= 0x41 && c <= 0x46) v = c - 0x37;
    else if (c >= 0x61 && c <= 0x66) v = c - 0x57;
    else continue;                               // whitespace and junk
    if (high < 0) high = v;
    else { out.push((high << 4) | v); high = -1; }
  }
  if (high >= 0) out.push(high << 4);
  return new Uint8Array(out);
}

/**
 * `ASCII85Decode`.
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
export function ascii85Decode(bytes) {
  /** @type {number[]} */
  const out = [];
  /** @type {number[]} */
  let group = [];
  let i = 0;
  if (bytes[0] === 0x3c && bytes[1] === 0x7e) i = 2;   // leading `<~`
  for (; i < bytes.length; i++) {
    const c = bytes[i];
    if (c === 0x7e) break;                              // `~>`
    if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00) continue;
    if (c === 0x7a && group.length === 0) { out.push(0, 0, 0, 0); continue; }   // 'z'
    if (c < 0x21 || c > 0x75) continue;
    group.push(c - 0x21);
    if (group.length === 5) {
      let value = 0;
      for (const g of group) value = value * 85 + g;
      out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
      group = [];
    }
  }
  if (group.length > 1) {
    const n = group.length;
    for (let k = n; k < 5; k++) group.push(84);
    let value = 0;
    for (const g of group) value = value * 85 + g;
    const full = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
    for (let k = 0; k < n - 1; k++) out.push(full[k]);
  }
  return new Uint8Array(out);
}

/**
 * `RunLengthDecode`.
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
export function runLengthDecode(bytes) {
  /** @type {number[]} */
  const out = [];
  let i = 0;
  while (i < bytes.length) {
    const length = bytes[i++];
    if (length === 128) break;
    if (length < 128) {
      for (let k = 0; k <= length && i < bytes.length; k++) out.push(bytes[i++]);
    } else {
      const value = bytes[i++];
      for (let k = 0; k < 257 - length; k++) out.push(value);
    }
  }
  return new Uint8Array(out);
}

/**
 * `LZWDecode`, with the `EarlyChange` parameter PDF adds to the TIFF variant.
 * Older Distiller output and many scanner PDFs still use it.
 * @param {Uint8Array} bytes
 * @param {number} [earlyChange]
 * @returns {Uint8Array}
 */
export function lzwDecode(bytes, earlyChange = 1) {
  /** @type {number[]} */
  const out = [];
  /** @type {number[][]} */
  let dict = [];
  const resetDict = () => {
    dict = new Array(256);
    for (let i = 0; i < 256; i++) dict[i] = [i];
    dict.length = 258;
  };
  resetDict();

  let codeWidth = 9;
  let next = 258;
  /** @type {number[]|null} */
  let previous = null;
  let bitBuffer = 0;
  let bitCount = 0;

  for (let i = 0; i <= bytes.length; i++) {
    if (i < bytes.length) { bitBuffer = (bitBuffer << 8) | bytes[i]; bitCount += 8; }
    else if (bitCount < codeWidth) break;
    while (bitCount >= codeWidth) {
      const code = (bitBuffer >> (bitCount - codeWidth)) & ((1 << codeWidth) - 1);
      bitCount -= codeWidth;
      if (code === 256) { resetDict(); codeWidth = 9; next = 258; previous = null; continue; }
      if (code === 257) { bitCount = 0; i = bytes.length; break; }
      /** @type {number[]} */
      let entry;
      if (code < next && dict[code]) entry = dict[code];
      else if (previous) entry = previous.concat(previous[0]);
      else continue;
      for (const b of entry) out.push(b);
      if (previous) {
        dict[next] = previous.concat(entry[0]);
        next += 1;
      }
      previous = entry;
      const limit = next + (earlyChange ? 1 : 0);
      if (limit >= 512 && codeWidth === 9) codeWidth = 10;
      else if (limit >= 1024 && codeWidth === 10) codeWidth = 11;
      else if (limit >= 2048 && codeWidth === 11) codeWidth = 12;
    }
  }
  return new Uint8Array(out);
}

/**
 * Undo a predictor pass. PNG predictors (10–15) are what every modern writer
 * uses on cross-reference streams; TIFF predictor 2 turns up on images.
 *
 * @param {Uint8Array} data
 * @param {{predictor?: number, colors?: number, bitsPerComponent?: number, columns?: number}} params
 * @returns {Uint8Array}
 */
export function applyPredictor(data, params) {
  const predictor = Number(params.predictor || 1);
  if (predictor <= 1) return data;
  const colors = Number(params.colors || 1);
  const bpc = Number(params.bitsPerComponent || 8);
  const columns = Number(params.columns || 1);
  const bpp = Math.ceil((colors * bpc) / 8);
  const rowLength = Math.ceil((colors * bpc * columns) / 8);

  if (predictor === 2) {
    if (bpc !== 8) return data;    // sub-byte TIFF prediction is vanishingly rare
    const out = data.slice();
    const rows = Math.floor(out.length / rowLength);
    for (let r = 0; r < rows; r++) {
      const base = r * rowLength;
      for (let i = bpp; i < rowLength; i++) out[base + i] = (out[base + i] + out[base + i - bpp]) & 0xff;
    }
    return out;
  }

  // PNG predictors: each row is prefixed with its filter type.
  const stride = rowLength + 1;
  const rows = Math.floor(data.length / stride);
  const out = new Uint8Array(rows * rowLength);
  let previous = new Uint8Array(rowLength);
  for (let r = 0; r < rows; r++) {
    const type = data[r * stride];
    const row = data.subarray(r * stride + 1, r * stride + 1 + rowLength);
    const current = new Uint8Array(rowLength);
    for (let i = 0; i < rowLength; i++) {
      const raw = row[i];
      const left = i >= bpp ? current[i - bpp] : 0;
      const up = previous[i];
      const upLeft = i >= bpp ? previous[i - bpp] : 0;
      let value;
      switch (type) {
        case 0: value = raw; break;
        case 1: value = raw + left; break;
        case 2: value = raw + up; break;
        case 3: value = raw + ((left + up) >> 1); break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          value = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
          break;
        }
        default: value = raw; break;
      }
      current[i] = value & 0xff;
    }
    out.set(current, r * rowLength);
    previous = current;
  }
  return out;
}

/**
 * Run a filter chain over stream bytes.
 *
 * Returns the decoded bytes plus the name of the first filter that was left
 * undecoded, which is how the image extractor knows it is holding a JPEG rather
 * than a bitmap.
 *
 * @param {Uint8Array} bytes
 * @param {string[]} filters
 * @param {object[]} parms   one entry per filter, possibly empty
 * @returns {{bytes: Uint8Array, remaining: string|null, applied: string[]}}
 */
export function decodeStream(bytes, filters, parms) {
  let data = bytes;
  /** @type {string[]} */
  const applied = [];
  for (let i = 0; i < filters.length; i++) {
    const name = filters[i];
    const params = parms[i] || {};
    if (IMAGE_FILTERS.has(name)) return { bytes: data, remaining: name, applied };
    switch (name) {
      case 'FlateDecode':
      case 'Fl':
        data = inflatePdf(data);
        break;
      case 'LZWDecode':
      case 'LZW':
        data = lzwDecode(data, params.EarlyChange === undefined ? 1 : Number(params.EarlyChange));
        break;
      case 'ASCIIHexDecode':
      case 'AHx':
        data = asciiHexDecode(data);
        break;
      case 'ASCII85Decode':
      case 'A85':
        data = ascii85Decode(data);
        break;
      case 'RunLengthDecode':
      case 'RL':
        data = runLengthDecode(data);
        break;
      case 'Crypt':
        break;                                   // identity Crypt filter
      default:
        return { bytes: data, remaining: name, applied };
    }
    applied.push(name);
    if (params && Number(params.Predictor || 1) > 1) {
      data = applyPredictor(data, {
        predictor: Number(params.Predictor),
        colors: Number(params.Colors || 1),
        bitsPerComponent: Number(params.BitsPerComponent || 8),
        columns: Number(params.Columns || 1),
      });
    }
  }
  return { bytes: data, remaining: null, applied };
}
