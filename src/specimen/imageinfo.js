/**
 * Format sniffing and intrinsic dimensions, read from the bytes rather than
 * from the file name or the declared MIME type — saved pages and HAR files lie
 * about both, and `MediaRef.intrinsic` has to be right or every layout that
 * reserves space for an image reserves the wrong space.
 */

import { utf8Decode } from '../core/bytes.js';
import { isPng, pngSize } from './png.js';

/**
 * @typedef {object} ImageInfo
 * @property {'png'|'jpeg'|'gif'|'webp'|'bmp'|'svg'|'ico'|'unknown'} format
 * @property {string} mime
 * @property {number} w
 * @property {number} h
 * @property {boolean} known  whether the dimensions were actually read
 */

const MIME = {
  png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon', unknown: 'application/octet-stream',
};

/** @param {Uint8Array} b @param {number} i @returns {number} */
const u16be = (b, i) => (b[i] << 8) | b[i + 1];
/** @param {Uint8Array} b @param {number} i @returns {number} */
const u16le = (b, i) => b[i] | (b[i + 1] << 8);
/** @param {Uint8Array} b @param {number} i @returns {number} */
const u32le = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;

/** @param {Uint8Array} bytes @param {number} start @param {string} ascii @returns {boolean} */
function matches(bytes, start, ascii) {
  if (bytes.length < start + ascii.length) return false;
  for (let i = 0; i < ascii.length; i++) if (bytes[start + i] !== ascii.charCodeAt(i)) return false;
  return true;
}

/**
 * @param {Uint8Array} bytes
 * @param {string} [hint] declared MIME type or file name, used only for SVG,
 *   which has no magic number worth trusting
 * @returns {ImageInfo}
 */
export function imageInfo(bytes, hint = '') {
  if (!bytes || bytes.length === 0) return { format: 'unknown', mime: MIME.unknown, w: 0, h: 0, known: false };

  if (isPng(bytes)) {
    const size = pngSize(bytes);
    return { format: 'png', mime: MIME.png, w: size ? size.w : 0, h: size ? size.h : 0, known: Boolean(size) };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    const size = jpegSize(bytes);
    return { format: 'jpeg', mime: MIME.jpeg, w: size ? size.w : 0, h: size ? size.h : 0, known: Boolean(size) };
  }
  if (matches(bytes, 0, 'GIF8')) {
    return { format: 'gif', mime: MIME.gif, w: u16le(bytes, 6), h: u16le(bytes, 8), known: true };
  }
  if (matches(bytes, 0, 'RIFF') && matches(bytes, 8, 'WEBP')) {
    const size = webpSize(bytes);
    return { format: 'webp', mime: MIME.webp, w: size ? size.w : 0, h: size ? size.h : 0, known: Boolean(size) };
  }
  if (bytes[0] === 0x42 && bytes[1] === 0x4d && bytes.length > 26) {
    const w = u32le(bytes, 18) | 0;
    const h = u32le(bytes, 22) | 0;
    return { format: 'bmp', mime: MIME.bmp, w: Math.abs(w), h: Math.abs(h), known: true };
  }
  if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0 && bytes.length > 8) {
    // ICO: the first directory entry, where 0 means 256.
    return { format: 'ico', mime: MIME.ico, w: bytes[6] || 256, h: bytes[7] || 256, known: true };
  }

  const head = utf8Decode(bytes.subarray(0, Math.min(bytes.length, 2048)));
  if (/<svg[\s>]/i.test(head) || /svg/i.test(hint)) {
    const size = svgSize(utf8Decode(bytes));
    return { format: 'svg', mime: MIME.svg, w: size.w, h: size.h, known: size.known };
  }
  return { format: 'unknown', mime: MIME.unknown, w: 0, h: 0, known: false };
}

/**
 * JPEG intrinsic size from the frame header. Every SOFn except the four that
 * are not frame markers carries height then width as 16-bit big-endian.
 * @param {Uint8Array} bytes
 * @returns {{w: number, h: number}|null}
 */
export function jpegSize(bytes) {
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) { i += 1; continue; }
    let marker = bytes[i + 1];
    while (marker === 0xff && i + 2 < bytes.length) { i += 1; marker = bytes[i + 1]; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null; // end of header section
    const length = u16be(bytes, i + 2);
    const isFrame = marker >= 0xc0 && marker <= 0xcf
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) return { h: u16be(bytes, i + 5), w: u16be(bytes, i + 7) };
    if (length < 2) return null;
    i += 2 + length;
  }
  return null;
}

/**
 * WebP intrinsic size for the three container forms.
 * @param {Uint8Array} bytes
 * @returns {{w: number, h: number}|null}
 */
export function webpSize(bytes) {
  let i = 12;
  while (i + 8 <= bytes.length) {
    const type = String.fromCharCode(bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]);
    const size = u32le(bytes, i + 4);
    const body = i + 8;
    if (type === 'VP8X' && bytes.length >= body + 10) {
      const w = 1 + (bytes[body + 4] | (bytes[body + 5] << 8) | (bytes[body + 6] << 16));
      const h = 1 + (bytes[body + 7] | (bytes[body + 8] << 8) | (bytes[body + 9] << 16));
      return { w, h };
    }
    if (type === 'VP8 ' && bytes.length >= body + 10) {
      // Key frame: 3-byte tag, the 3-byte start code 9d 01 2a, then 16-bit
      // width and height with the top two bits carrying the scale.
      if (bytes[body + 3] === 0x9d && bytes[body + 4] === 0x01 && bytes[body + 5] === 0x2a) {
        return { w: u16le(bytes, body + 6) & 0x3fff, h: u16le(bytes, body + 8) & 0x3fff };
      }
    }
    if (type === 'VP8L' && bytes.length >= body + 5 && bytes[body] === 0x2f) {
      const b = u32le(bytes, body + 1);
      return { w: (b & 0x3fff) + 1, h: ((b >>> 14) & 0x3fff) + 1 };
    }
    i = body + size + (size % 2);
  }
  return null;
}

/**
 * SVG intrinsic size: explicit width/height in px when present, otherwise the
 * viewBox, which is what a browser uses to establish the intrinsic ratio.
 * @param {string} text
 * @returns {{w: number, h: number, known: boolean}}
 */
export function svgSize(text) {
  const open = /<svg\b[^>]*>/i.exec(text);
  const tag = open ? open[0] : '';
  const attr = (name) => {
    const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
    return m ? (m[2] !== undefined ? m[2] : m[3]) : null;
  };
  const px = (v) => {
    if (v == null) return null;
    const m = /^\s*([0-9]*\.?[0-9]+)\s*(px)?\s*$/i.exec(v);
    return m ? Number(m[1]) : null;
  };
  const w = px(attr('width'));
  const h = px(attr('height'));
  if (w !== null && h !== null) return { w: Math.round(w), h: Math.round(h), known: true };
  const vb = attr('viewBox');
  if (vb) {
    const parts = vb.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
      return { w: Math.round(Math.abs(parts[2])), h: Math.round(Math.abs(parts[3])), known: true };
    }
  }
  return { w: w === null ? 0 : Math.round(w), h: h === null ? 0 : Math.round(h), known: false };
}

/** MIME type for a sniffed format. @param {string} format @returns {string} */
export function mimeForFormat(format) { return MIME[format] || MIME.unknown; }
