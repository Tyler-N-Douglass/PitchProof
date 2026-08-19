/**
 * Logo extraction (§7).
 *
 * Preference order, straight from §7: inline SVG, then `<link rel=icon>` SVG,
 * then `og:image`, then the largest raster in the header region. Each tier is
 * strictly better evidence than the one below it — an inline SVG is the mark the
 * designers drew, an og:image is whatever the marketing team pointed the social
 * card at — and the tier a logo came from is what its confidence is built on.
 *
 * Everything about an asset is read from the asset's own bytes, never from the
 * markup that referenced it. `width="200"` on an `<img>` is a layout instruction;
 * the intrinsic size lives in the PNG's IHDR, the JPEG's SOFn, the GIF's logical
 * screen descriptor, the WebP's VP8/VP8L/VP8X header, or the SVG's `viewBox`.
 * Transparency likewise: the PNG colour type and `tRNS` chunk, the WebP alpha
 * flag, the GIF graphic-control extension, and — for SVG — the absence of a
 * full-bleed painted background.
 *
 * The inverse variant is generated **only when the mark is monochrome** (§7).
 * A two-colour logo cannot be inverted correctly by a machine, so the extractor
 * returns null and marks the logo `needsInverseAsset`, which the studio surfaces
 * as "ask the client for the reversed lockup" rather than shipping something
 * wrong into a client meeting.
 *
 * @module brand/logo
 */

import { inflateRaw } from '../core/inflate.js';
import { deflateRaw } from '../core/deflate.js';
import { crc32 } from '../core/zip.js';
import { base64Encode, utf8Encode } from '../core/bytes.js';
import { contentId } from '../core/ids.js';
import { contentHash } from '../core/hash.js';
import { escapeAttr, escapeText, VOID_ELEMENTS } from '../core/vdom.js';
import { hexToOklch, oklchToHex, clampChromaToGamut, relativeLuminance } from './color.js';
import { walkDoc, docText } from './type.js';

// ---------------------------------------------------------------- constants

/**
 * The intrinsic size a replaced element with no intrinsic dimensions gets, from
 * CSS Images 3 §5.4. An SVG with neither `width`/`height` nor a `viewBox` is
 * exactly that case.
 */
export const DEFAULT_REPLACED_SIZE = { w: 300, h: 150 };

/**
 * Assets at or below this size on both axes are favicons regardless of what
 * they are called. 64px is the largest size in the standard favicon ladder
 * (16/32/48/64); 180px `apple-touch-icon` is caught by name instead.
 */
export const FAVICON_MAX_PX = 64;

/** A logotype is wide: a wordmark's aspect ratio starts here. */
export const WORDMARK_ASPECT = 2.5;

/** A symbol is square-ish: a mark's aspect ratio sits inside this band. */
export const MARK_ASPECT_BAND = { min: 0.8, max: 1.25 };

/**
 * Per-channel spread below which a pixel reads as grey rather than as a colour.
 * 12/255 is 4.7% of the channel range — below the point at which a colour is
 * distinguishable from neutral at logo sizes, and comfortably above the ±2/255
 * quantisation noise a lossless resize leaves behind.
 */
export const ACHROMATIC_CHROMA = 12;

/**
 * Hue spread, in degrees, inside which every chromatic pixel is the same ink.
 * 14° is narrower than the ~30° buckets colour-naming studies use for the
 * eleven basic colour terms, so "one hue" here means one ink with tints and
 * shades, not one colour family.
 */
export const MONO_HUE_SPREAD_DEG = 14;

/**
 * The share of opaque pixels that must agree before a raster mark is called
 * monochrome. 0.98 leaves room for anti-aliasing fringes without leaving room
 * for a second colour.
 */
export const MONO_PIXEL_SHARE = 0.98;

/** Alpha at or below which a pixel is treated as not painted. */
export const ALPHA_FLOOR = 16;

/** Names and alt text that identify a variant. */
export const VARIANT_SIGNALS = [
  { variant: 'inverse', re: /\b(inverse|inverted|invert|reverse|reversed|negative|on-?dark|dark-?bg|white|light-?mode-?off|knockout)\b/i },
  { variant: 'favicon', re: /\b(favicon|apple-?touch-?icon|touch-?icon|site-?icon|shortcut-?icon|maskable)\b/i },
  { variant: 'wordmark', re: /\b(wordmark|word-?mark|logotype|type-?logo|lettering|full-?logo|horizontal-?lock-?up)\b/i },
  { variant: 'mark', re: /\b(mark|symbol|glyph|monogram|icon-?only|logo-?mark|brandmark|emblem|bug)\b/i },
  { variant: 'primary', re: /\b(primary|main|default|lock-?up|lockup)\b/i },
];

/** Selector-ish signals that an element is the site's logo. */
export const LOGO_CONTEXT_RE = /\b(logo|brand|wordmark|masthead|identity|site-?title|site-?name)\b/i;

/** Elements that constitute the header region for §7's "largest raster". */
export const HEADER_TAGS = new Set(['header', 'nav']);

/** Attributes whose value marks an element as the page header. */
export const HEADER_CONTEXT_RE = /\b(header|masthead|navbar|nav-?bar|topbar|top-?nav|site-?head|global-?nav|banner)\b/i;

/**
 * Evidence rank per source tier, used by `logosConfidence`. The numbers are the
 * §7 preference order expressed as a scalar: an inline SVG is the mark itself,
 * an og:image is a social card that may be a photograph with the logo in a
 * corner. A `schema.org` declaration outranks all of them because it is the only
 * source where the site states which asset is its logo rather than the extractor
 * inferring it (L5-D23).
 */
export const SOURCE_RANK = {
  'ld-logo': 1,
  'inline-svg': 1,
  'link-icon-svg': 0.85,
  'header-raster': 0.6,
  'link-icon-raster': 0.55,
  'og-image': 0.45,
  supplied: 1,
};

/**
 * How much each signal contributes to being the brand's **primary** asset.
 *
 * §7's preference order answers "where do I look for a logo"; it does not answer
 * "which of the things I found is the logo". Those are different questions, and
 * conflating them is how a 320x180 og:image of an industrial plant ends up as
 * the asset every layout renders by default. Discovery order is untouched;
 * this table decides the role.
 *
 * The penalties matter as much as the bonuses: an og:image nobody else
 * corroborates is a social card until proven otherwise, and a 48px icon is not a
 * lockup.
 */
export const IDENTITY_WEIGHTS = {
  /** The site declared this asset as its logo in schema.org JSON-LD. */
  declared: 3,
  /** The asset's own filename or alt text says "logo"/"brand"/"wordmark". */
  named: 2,
  /** It was found in the page header — where a site puts its identity. */
  inHeader: 1.5,
  /** Vector: the mark itself rather than a rendering of it. */
  vector: 1,
  /** A full lockup or wordmark is the primary; a bare symbol is the secondary. */
  lockupForm: 0.5,
  /** Found only as an og:image: a social card until something corroborates it. */
  ogOnly: -1.5,
  /** Favicon proportions: an icon, not a lockup. */
  faviconForm: -2.5,
};

/**
 * JSON-LD property paths that name an organisation's logo. `logo` may be a URL
 * string or an `ImageObject` with a `url`; both are handled.
 */
export const LD_LOGO_TYPES = new Set(['organization', 'corporation', 'localbusiness', 'ngo', 'educationalorganization', 'governmentorganization', 'website', 'webpage', 'newsmediaorganization', 'onlinebusiness']);

// ------------------------------------------------------------ byte utilities

/** @param {Uint8Array} b @param {number} i @returns {number} */
function u16be(b, i) { return (b[i] << 8) | b[i + 1]; }
/** @param {Uint8Array} b @param {number} i @returns {number} */
function u32be(b, i) { return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0; }
/** @param {Uint8Array} b @param {number} i @returns {number} */
function u16le(b, i) { return b[i] | (b[i + 1] << 8); }
/** @param {Uint8Array} b @param {number} i @returns {number} */
function u24le(b, i) { return b[i] | (b[i + 1] << 8) | (b[i + 2] << 16); }
/** @param {Uint8Array} b @param {number} i @param {number} n @returns {string} */
function ascii(b, i, n) { let s = ''; for (let k = 0; k < n; k++) s += String.fromCharCode(b[i + k]); return s; }

/** @param {Uint8Array} bytes @param {number[]} sig @returns {boolean} */
function startsWith(bytes, sig) {
  if (!bytes || bytes.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[i] !== sig[i]) return false;
  return true;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Identify an image format from its magic bytes, never from its file extension.
 * @param {Uint8Array} bytes
 * @returns {'png'|'jpeg'|'gif'|'webp'|'svg'|'bmp'|'ico'|null}
 */
export function sniffFormat(bytes) {
  if (!bytes || bytes.length < 4) return null;
  if (startsWith(bytes, PNG_SIGNATURE)) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (ascii(bytes, 0, 3) === 'GIF') return 'gif';
  if (ascii(bytes, 0, 4) === 'RIFF' && bytes.length >= 12 && ascii(bytes, 8, 4) === 'WEBP') return 'webp';
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'bmp';
  if (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00) return 'ico';
  // SVG and other XML may be preceded by a BOM, a declaration or a doctype.
  const head = ascii(bytes, 0, Math.min(bytes.length, 512)).replace(/^﻿/, '').trimStart();
  if (/^<\?xml|^<!doctype svg|^<svg[\s>]/i.test(head)) return 'svg';
  if (/<svg[\s>]/i.test(head)) return 'svg';
  return null;
}

// -------------------------------------------------------------------- PNG

/**
 * @typedef {object} PngChunks
 * @property {number} width
 * @property {number} height
 * @property {number} bitDepth
 * @property {number} colorType   0 grey, 2 truecolour, 3 palette, 4 grey+alpha, 6 RGBA
 * @property {number} interlace
 * @property {Uint8Array|null} palette
 * @property {Uint8Array|null} trns
 * @property {Uint8Array} idat
 */

/**
 * Read a PNG's chunk structure. Throws on anything that is not a PNG, because a
 * logo the extractor cannot read is a fact the studio needs, not a default.
 * @param {Uint8Array} bytes
 * @returns {PngChunks}
 */
export function readPng(bytes) {
  if (!startsWith(bytes, PNG_SIGNATURE)) throw new Error('png: bad signature');
  let i = 8;
  let ihdr = null;
  /** @type {Uint8Array|null} */
  let palette = null;
  /** @type {Uint8Array|null} */
  let trns = null;
  /** @type {Uint8Array[]} */
  const idatParts = [];
  while (i + 8 <= bytes.length) {
    const length = u32be(bytes, i);
    const type = ascii(bytes, i + 4, 4);
    const start = i + 8;
    const end = start + length;
    if (end > bytes.length) break;
    if (type === 'IHDR') {
      ihdr = {
        width: u32be(bytes, start),
        height: u32be(bytes, start + 4),
        bitDepth: bytes[start + 8],
        colorType: bytes[start + 9],
        interlace: bytes[start + 12],
      };
    } else if (type === 'PLTE') palette = bytes.subarray(start, end);
    else if (type === 'tRNS') trns = bytes.subarray(start, end);
    else if (type === 'IDAT') idatParts.push(bytes.subarray(start, end));
    else if (type === 'IEND') break;
    i = end + 4;
  }
  if (!ihdr) throw new Error('png: no IHDR');
  let total = 0;
  for (const p of idatParts) total += p.length;
  const idat = new Uint8Array(total);
  let o = 0;
  for (const p of idatParts) { idat.set(p, o); o += p.length; }
  return { ...ihdr, palette, trns, idat };
}

/**
 * Whether a PNG can paint anything less than fully opaque, decided from the
 * header rather than by decoding: colour types 4 and 6 carry an alpha channel,
 * and a `tRNS` chunk makes a palette entry or a single colour transparent.
 *
 * The alpha channel is then *checked* by `pngAlphaUsed` when the pixels are
 * available, because a PNG saved as RGBA with every alpha at 255 has no
 * transparency at all, and reporting that it does would send the studio looking
 * for a background that does not exist.
 *
 * @param {PngChunks} png
 * @returns {boolean}
 */
export function pngMayHaveTransparency(png) {
  if (png.colorType === 4 || png.colorType === 6) return true;
  if (!png.trns || png.trns.length === 0) return false;
  if (png.colorType === 3) { for (const a of png.trns) if (a < 255) return true; return false; }
  return true;    // colour types 0 and 2 with tRNS: a single transparent colour key
}

/**
 * @typedef {object} DecodedImage
 * @property {number} width
 * @property {number} height
 * @property {Uint8Array} data   RGBA, row-major, 4 bytes per pixel
 */

/**
 * Decode a PNG to RGBA. Built on `core/inflate.js`, so the artifact pipeline
 * gains no dependency and the decode is deterministic.
 *
 * Interlaced (Adam7) PNGs throw rather than decode wrongly — they are vanishingly
 * rare for logos, and a silently mis-decoded logo is worse than a reported one.
 *
 * @param {Uint8Array} bytes
 * @returns {DecodedImage}
 */
export function decodePng(bytes) {
  const png = readPng(bytes);
  if (png.interlace !== 0) throw new Error('png: interlaced (Adam7) images are not decoded');
  if (png.idat.length < 3) throw new Error('png: no image data');

  // The IDAT stream is zlib-wrapped: two header bytes, then raw DEFLATE, then a
  // four-byte Adler-32 the inflater does not need.
  const raw = inflateRaw(png.idat.subarray(2, png.idat.length - 4));

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[png.colorType];
  if (channels === undefined) throw new Error(`png: unsupported colour type ${png.colorType}`);
  const bitsPerPixel = channels * png.bitDepth;
  const bytesPerPixel = Math.max(1, Math.ceil(bitsPerPixel / 8));
  const rowBytes = Math.ceil((bitsPerPixel * png.width) / 8);

  const expected = (rowBytes + 1) * png.height;
  if (raw.length < expected) throw new Error(`png: short image data (${raw.length} < ${expected})`);

  // Undo the per-scanline filters in place.
  const lines = new Uint8Array(rowBytes * png.height);
  let prev = new Uint8Array(rowBytes);
  for (let y = 0; y < png.height; y++) {
    const filter = raw[y * (rowBytes + 1)];
    const src = raw.subarray(y * (rowBytes + 1) + 1, y * (rowBytes + 1) + 1 + rowBytes);
    const cur = lines.subarray(y * rowBytes, (y + 1) * rowBytes);
    cur.set(src);
    unfilter(filter, cur, prev, bytesPerPixel);
    prev = cur;
  }

  const out = new Uint8Array(png.width * png.height * 4);
  const maxValue = (1 << png.bitDepth) - 1;
  const scale = png.bitDepth === 8 ? 1 : 255 / maxValue;

  /** @param {Uint8Array} row @param {number} index @returns {number} */
  const sample = (row, index) => {
    if (png.bitDepth === 8) return row[index];
    if (png.bitDepth === 16) return row[index * 2];              // high byte is enough for 8-bit output
    const perByte = 8 / png.bitDepth;
    const byte = row[Math.floor(index / perByte)];
    const shift = 8 - png.bitDepth * ((index % perByte) + 1);
    return (byte >> shift) & maxValue;
  };

  for (let y = 0; y < png.height; y++) {
    const row = lines.subarray(y * rowBytes, (y + 1) * rowBytes);
    for (let x = 0; x < png.width; x++) {
      const o = (y * png.width + x) * 4;
      if (png.colorType === 0 || png.colorType === 4) {
        const g = Math.round(sample(row, x * channels) * (png.bitDepth === 16 ? 1 : scale));
        out[o] = g; out[o + 1] = g; out[o + 2] = g;
        out[o + 3] = png.colorType === 4
          ? Math.round(sample(row, x * channels + 1) * (png.bitDepth === 16 ? 1 : scale))
          : greyKeyAlpha(png, sample(row, x * channels), maxValue);
      } else if (png.colorType === 2 || png.colorType === 6) {
        const r = Math.round(sample(row, x * channels) * (png.bitDepth === 16 ? 1 : scale));
        const g = Math.round(sample(row, x * channels + 1) * (png.bitDepth === 16 ? 1 : scale));
        const b = Math.round(sample(row, x * channels + 2) * (png.bitDepth === 16 ? 1 : scale));
        out[o] = r; out[o + 1] = g; out[o + 2] = b;
        out[o + 3] = png.colorType === 6
          ? Math.round(sample(row, x * channels + 3) * (png.bitDepth === 16 ? 1 : scale))
          : rgbKeyAlpha(png, sample(row, x * channels), sample(row, x * channels + 1), sample(row, x * channels + 2));
      } else {
        const index = sample(row, x);
        const p = png.palette;
        out[o] = p ? p[index * 3] : 0;
        out[o + 1] = p ? p[index * 3 + 1] : 0;
        out[o + 2] = p ? p[index * 3 + 2] : 0;
        out[o + 3] = png.trns && index < png.trns.length ? png.trns[index] : 255;
      }
    }
  }
  return { width: png.width, height: png.height, data: out };
}

/**
 * `tRNS` on a greyscale image names one transparent grey level.
 * @param {PngChunks} png @param {number} value @param {number} maxValue @returns {number}
 */
function greyKeyAlpha(png, value, maxValue) {
  if (!png.trns || png.trns.length < 2) return 255;
  const key = u16be(png.trns, 0) & maxValue;
  return value === key ? 0 : 255;
}

/**
 * `tRNS` on a truecolour image names one transparent RGB triple.
 * @param {PngChunks} png @param {number} r @param {number} g @param {number} b @returns {number}
 */
function rgbKeyAlpha(png, r, g, b) {
  if (!png.trns || png.trns.length < 6) return 255;
  return (u16be(png.trns, 0) & 0xffff) === r && (u16be(png.trns, 2) & 0xffff) === g && (u16be(png.trns, 4) & 0xffff) === b ? 0 : 255;
}

/**
 * PNG scanline filters, from the PNG specification §9.2.
 * @param {number} type @param {Uint8Array} cur @param {Uint8Array} prev @param {number} bpp
 */
function unfilter(type, cur, prev, bpp) {
  const n = cur.length;
  if (type === 0) return;
  if (type === 1) { for (let i = bpp; i < n; i++) cur[i] = (cur[i] + cur[i - bpp]) & 0xff; return; }
  if (type === 2) { for (let i = 0; i < n; i++) cur[i] = (cur[i] + prev[i]) & 0xff; return; }
  if (type === 3) {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      cur[i] = (cur[i] + ((a + prev[i]) >> 1)) & 0xff;
    }
    return;
  }
  if (type === 4) {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const pred = pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
      cur[i] = (cur[i] + pred) & 0xff;
    }
    return;
  }
  throw new Error(`png: unknown filter type ${type}`);
}

/**
 * True when the decoded image actually paints a pixel below full opacity.
 * @param {DecodedImage} image
 * @returns {boolean}
 */
export function alphaUsed(image) {
  const d = image.data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 255) return true;
  return false;
}

/** Adler-32, as the zlib wrapper around a PNG's IDAT stream requires. */
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
 * Encode RGBA pixels as an 8-bit truecolour-with-alpha PNG. Used only to write
 * a generated inverse variant back out; every scanline uses filter 0 so the
 * bytes depend on nothing but the pixels (§5 determinism).
 * @param {DecodedImage} image
 * @returns {Uint8Array}
 */
export function encodePng(image) {
  const { width, height, data } = image;
  const rowBytes = width * 4;
  const rawSize = (rowBytes + 1) * height;
  const raw = new Uint8Array(rawSize);
  for (let y = 0; y < height; y++) {
    raw[y * (rowBytes + 1)] = 0;
    raw.set(data.subarray(y * rowBytes, (y + 1) * rowBytes), y * (rowBytes + 1) + 1);
  }
  const deflated = deflateRaw(raw);
  const zlib = new Uint8Array(deflated.length + 6);
  zlib[0] = 0x78;                 // CMF: deflate, 32K window
  zlib[1] = 0x01;                 // FLG: no dictionary, fastest level; 0x7801 % 31 === 0
  zlib.set(deflated, 2);
  const adler = adler32(raw);
  zlib[zlib.length - 4] = (adler >>> 24) & 0xff;
  zlib[zlib.length - 3] = (adler >>> 16) & 0xff;
  zlib[zlib.length - 2] = (adler >>> 8) & 0xff;
  zlib[zlib.length - 1] = adler & 0xff;

  const ihdr = new Uint8Array(13);
  writeU32(ihdr, 0, width);
  writeU32(ihdr, 4, height);
  ihdr[8] = 8;      // bit depth
  ihdr[9] = 6;      // colour type: RGBA
  ihdr[10] = 0;     // compression
  ihdr[11] = 0;     // filter
  ihdr[12] = 0;     // interlace

  const chunks = [chunk('IHDR', ihdr), chunk('IDAT', zlib), chunk('IEND', new Uint8Array(0))];
  let total = 8;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  out.set(PNG_SIGNATURE, 0);
  let o = 8;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/** @param {Uint8Array} b @param {number} i @param {number} v */
function writeU32(b, i, v) {
  b[i] = (v >>> 24) & 0xff; b[i + 1] = (v >>> 16) & 0xff; b[i + 2] = (v >>> 8) & 0xff; b[i + 3] = v & 0xff;
}

/** @param {string} type @param {Uint8Array} data @returns {Uint8Array} */
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  writeU32(out, 0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  writeU32(out, 8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

// ------------------------------------------------------- other raster formats

/**
 * Intrinsic size of a JPEG, read from its first SOFn frame header. JPEG has no
 * alpha channel in any baseline or progressive profile.
 * @param {Uint8Array} bytes
 * @returns {{w: number, h: number}|null}
 */
export function jpegInfo(bytes) {
  if (!(bytes[0] === 0xff && bytes[1] === 0xd8)) return null;
  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) { i += 1; continue; }
    let marker = bytes[i + 1];
    while (marker === 0xff && i + 2 < bytes.length) { i += 1; marker = bytes[i + 1]; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null;         // end of image / start of scan
    const length = u16be(bytes, i + 2);
    // SOF0..SOF15, excluding DHT (C4), JPG (C8) and DAC (CC), which share the range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: u16be(bytes, i + 5), w: u16be(bytes, i + 7) };
    }
    i += 2 + length;
  }
  return null;
}

/**
 * Intrinsic size and transparency of a GIF. The logical screen descriptor
 * carries the size; transparency is declared per-frame by a graphic-control
 * extension whose packed field sets the transparent-colour flag.
 * @param {Uint8Array} bytes
 * @returns {{w: number, h: number, hasTransparency: boolean}|null}
 */
export function gifInfo(bytes) {
  if (ascii(bytes, 0, 3) !== 'GIF' || bytes.length < 10) return null;
  const w = u16le(bytes, 6);
  const h = u16le(bytes, 8);
  let hasTransparency = false;
  for (let i = 13; i + 3 < bytes.length; i++) {
    if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9 && bytes[i + 2] === 0x04) {
      if ((bytes[i + 3] & 0x01) === 1) { hasTransparency = true; break; }
    }
  }
  return { w, h, hasTransparency };
}

/**
 * Intrinsic size and alpha flag of a WebP, across all three container variants:
 * `VP8 ` (lossy, no alpha), `VP8L` (lossless, alpha bit in the bitstream
 * header), and `VP8X` (extended, alpha bit in the feature flags).
 * @param {Uint8Array} bytes
 * @returns {{w: number, h: number, hasTransparency: boolean}|null}
 */
export function webpInfo(bytes) {
  if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') return null;
  let i = 12;
  let alphaChunk = false;
  while (i + 8 <= bytes.length) {
    const fourcc = ascii(bytes, i, 4);
    const size = (bytes[i + 4] | (bytes[i + 5] << 8) | (bytes[i + 6] << 16) | (bytes[i + 7] * 0x1000000)) >>> 0;
    const body = i + 8;
    if (fourcc === 'VP8X') {
      return {
        w: u24le(bytes, body + 4) + 1,
        h: u24le(bytes, body + 7) + 1,
        hasTransparency: (bytes[body] & 0x10) !== 0,
      };
    }
    if (fourcc === 'VP8 ') {
      // 3-byte frame tag, then the 3-byte start code 9d 01 2a, then two 16-bit
      // fields whose low 14 bits are the dimensions.
      if (bytes[body + 3] === 0x9d && bytes[body + 4] === 0x01 && bytes[body + 5] === 0x2a) {
        return { w: u16le(bytes, body + 6) & 0x3fff, h: u16le(bytes, body + 8) & 0x3fff, hasTransparency: alphaChunk };
      }
    }
    if (fourcc === 'VP8L' && bytes[body] === 0x2f) {
      const bits = (bytes[body + 1] | (bytes[body + 2] << 8) | (bytes[body + 3] << 16) | (bytes[body + 4] << 24)) >>> 0;
      return {
        w: (bits & 0x3fff) + 1,
        h: ((bits >>> 14) & 0x3fff) + 1,
        hasTransparency: ((bits >>> 28) & 1) === 1,
      };
    }
    if (fourcc === 'ALPH') alphaChunk = true;
    i = body + size + (size % 2);      // RIFF chunks are padded to even length
  }
  return null;
}

/**
 * Intrinsic size of a BMP, from either the BITMAPCOREHEADER (12-byte) or the
 * BITMAPINFOHEADER family. A 32-bit BMP may carry alpha.
 * @param {Uint8Array} bytes
 * @returns {{w: number, h: number, hasTransparency: boolean}|null}
 */
export function bmpInfo(bytes) {
  if (!(bytes[0] === 0x42 && bytes[1] === 0x4d) || bytes.length < 26) return null;
  const headerSize = (bytes[14] | (bytes[15] << 8) | (bytes[16] << 16) | (bytes[17] << 24)) >>> 0;
  if (headerSize === 12) {
    return { w: u16le(bytes, 18), h: u16le(bytes, 20), hasTransparency: false };
  }
  const w = (bytes[18] | (bytes[19] << 8) | (bytes[20] << 16) | (bytes[21] << 24)) | 0;
  const h = (bytes[22] | (bytes[23] << 8) | (bytes[24] << 16) | (bytes[25] << 24)) | 0;
  const bpp = u16le(bytes, 28);
  return { w: Math.abs(w), h: Math.abs(h), hasTransparency: bpp === 32 };
}

/**
 * Intrinsic size of an ICO, from its largest directory entry. A zero byte in
 * the width or height field means 256, per the ICO format.
 * @param {Uint8Array} bytes
 * @returns {{w: number, h: number, hasTransparency: boolean}|null}
 */
export function icoInfo(bytes) {
  if (!(bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0)) return null;
  const count = u16le(bytes, 4);
  let best = null;
  for (let n = 0; n < count; n++) {
    const entry = 6 + n * 16;
    if (entry + 16 > bytes.length) break;
    const w = bytes[entry] === 0 ? 256 : bytes[entry];
    const h = bytes[entry + 1] === 0 ? 256 : bytes[entry + 1];
    if (!best || w * h > best.w * best.h) best = { w, h };
  }
  return best ? { ...best, hasTransparency: true } : null;
}

// -------------------------------------------------------------------- SVG

/**
 * Read the root `<svg>` element's attributes out of markup.
 * @param {string} markup
 * @returns {Record<string, string>}
 */
export function svgRootAttrs(markup) {
  const m = /<svg\b([^>]*)>/i.exec(String(markup || ''));
  if (!m) return {};
  return parseTagAttrs(m[1]);
}

/**
 * Parse an element's attribute list from raw markup.
 * @param {string} body
 * @returns {Record<string, string>}
 */
export function parseTagAttrs(body) {
  /** @type {Record<string, string>} */
  const out = {};
  const re = /([:\w-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(String(body || '')))) {
    if (!m[1]) continue;
    out[m[1].toLowerCase()] = decodeXmlEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

/** The five XML predefined entities plus numeric references. */
export function decodeXmlEntities(s) {
  return String(s || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 ? String.fromCodePoint(cp) : whole;
    }
    const map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    return map[body.toLowerCase()] ?? whole;
  });
}

/**
 * The intrinsic size of an SVG, applying the SVG 2 §8.2 rules: an absolute
 * `width`/`height` pair wins; otherwise the `viewBox` supplies the size and the
 * aspect ratio; otherwise the CSS default replaced size.
 * @param {string} markup
 * @returns {{w: number, h: number, source: 'attrs'|'viewBox'|'default'}}
 */
export function svgIntrinsic(markup) {
  const attrs = svgRootAttrs(markup);
  const viewBox = parseViewBox(attrs.viewbox);
  const w = absoluteSvgLength(attrs.width);
  const h = absoluteSvgLength(attrs.height);
  if (w !== null && h !== null) return { w, h, source: 'attrs' };
  if (viewBox) {
    // One absolute axis plus a viewBox gives the other axis by aspect ratio.
    if (w !== null && viewBox.w > 0) return { w, h: round3(w * (viewBox.h / viewBox.w)), source: 'attrs' };
    if (h !== null && viewBox.h > 0) return { w: round3(h * (viewBox.w / viewBox.h)), h, source: 'attrs' };
    return { w: viewBox.w, h: viewBox.h, source: 'viewBox' };
  }
  if (w !== null && h === null) return { w, h: round3(w * (DEFAULT_REPLACED_SIZE.h / DEFAULT_REPLACED_SIZE.w)), source: 'attrs' };
  if (h !== null && w === null) return { w: round3(h * (DEFAULT_REPLACED_SIZE.w / DEFAULT_REPLACED_SIZE.h)), h, source: 'attrs' };
  return { ...DEFAULT_REPLACED_SIZE, source: 'default' };
}

/** @param {string|undefined} value @returns {{x: number, y: number, w: number, h: number}|null} */
export function parseViewBox(value) {
  if (!value) return null;
  const parts = String(value).trim().split(/[\s,]+/).map(Number);
  if (parts.length < 4 || parts.some((n) => !Number.isFinite(n))) return null;
  return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
}

/**
 * An SVG `width`/`height` presentation attribute in absolute units. Percentages
 * are relative to a viewport this extractor does not have, so they yield null
 * and the `viewBox` decides — which is exactly what a browser does.
 * @param {string|undefined} value
 * @returns {number|null}
 */
export function absoluteSvgLength(value) {
  if (value === undefined || value === null) return null;
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+))\s*(px|pt|pc|in|cm|mm|q|em|rem|ex|ch|%)?\s*$/i.exec(String(value));
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] || 'px').toLowerCase();
  const factors = { px: 1, pt: 96 / 72, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6, em: 16, rem: 16, ex: 8, ch: 8 };
  if (unit === '%') return null;
  return round3(n * (factors[unit] ?? 1));
}

/**
 * True when an SVG paints an opaque rectangle over its whole canvas — the only
 * way an SVG stops being transparent.
 *
 * A `<rect>` counts when it starts at the origin (or omits x/y, which means
 * zero) and covers the full viewBox or 100% of the viewport, and its fill is
 * neither `none` nor `transparent` nor fully transparent. A `background` in the
 * root element's inline style counts too.
 *
 * @param {string} markup
 * @returns {boolean}
 */
export function svgHasFullBleedBackground(markup) {
  const src = String(markup || '');
  const root = svgRootAttrs(src);
  const rootStyle = String(root.style || '');
  if (/background(-color)?\s*:\s*(?!none|transparent|rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\))[^;]+/i.test(rootStyle)) return true;

  const viewBox = parseViewBox(root.viewbox);
  const width = viewBox ? viewBox.w : absoluteSvgLength(root.width);
  const height = viewBox ? viewBox.h : absoluteSvgLength(root.height);

  const re = /<rect\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(src))) {
    const a = parseTagAttrs(m[1]);
    const fill = resolveFillFromAttrs(a);
    if (fill === null) continue;
    const x = a.x === undefined ? 0 : Number(a.x);
    const y = a.y === undefined ? 0 : Number(a.y);
    const originX = viewBox ? viewBox.x : 0;
    const originY = viewBox ? viewBox.y : 0;
    if (!(nearly(x, originX) && nearly(y, originY))) continue;
    const w = a.width === undefined ? null : a.width;
    const h = a.height === undefined ? null : a.height;
    if (w === null || h === null) continue;
    const fullW = /^100%$/.test(String(w).trim()) || (width !== null && nearly(Number(w), width));
    const fullH = /^100%$/.test(String(h).trim()) || (height !== null && nearly(Number(h), height));
    if (fullW && fullH) return true;
  }
  return false;
}

/** @param {number} a @param {number} b @returns {boolean} */
function nearly(a, b) { return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= Math.max(0.5, Math.abs(b) * 0.01); }

/**
 * The paint an element's attributes and inline style specify, or null when it
 * paints nothing.
 * @param {Record<string, string>} attrs
 * @returns {string|null}
 */
function resolveFillFromAttrs(attrs) {
  const style = String(attrs.style || '');
  const styleFill = /(?:^|;)\s*fill\s*:\s*([^;]+)/i.exec(style);
  const raw = (styleFill ? styleFill[1] : attrs.fill || '').trim().toLowerCase();
  if (!raw) return null;                       // SVG's initial fill is black, but an
                                               // unstated fill on a background rect is
                                               // not a deliberate background
  if (raw === 'none' || raw === 'transparent') return null;
  const opacity = Number(attrs['fill-opacity'] ?? attrs.opacity ?? 1);
  if (Number.isFinite(opacity) && opacity <= 0.01) return null;
  return raw;
}

// ------------------------------------------------------------- colour tokens

/**
 * The basic colour keywords, with their sRGB values. A logo that names a colour
 * by keyword almost always names one of these; anything outside the table is
 * compared by name, which fails closed — an unrecognised keyword can only make a
 * mark look *less* monochrome, never more.
 */
export const KEYWORD_RGB = {
  black: [0, 0, 0], silver: [192, 192, 192], gray: [128, 128, 128], grey: [128, 128, 128],
  white: [255, 255, 255], maroon: [128, 0, 0], red: [255, 0, 0], purple: [128, 0, 128],
  fuchsia: [255, 0, 255], magenta: [255, 0, 255], green: [0, 128, 0], lime: [0, 255, 0],
  olive: [128, 128, 0], yellow: [255, 255, 0], navy: [0, 0, 128], blue: [0, 0, 255],
  teal: [0, 128, 128], aqua: [0, 255, 255], cyan: [0, 255, 255], orange: [255, 165, 0],
  darkgray: [169, 169, 169], darkgrey: [169, 169, 169], lightgray: [211, 211, 211],
  lightgrey: [211, 211, 211], dimgray: [105, 105, 105], dimgrey: [105, 105, 105],
  whitesmoke: [245, 245, 245], gainsboro: [220, 220, 220],
};

/**
 * Resolve a CSS/SVG paint value to sRGB, or null when it is not a plain colour
 * (a gradient reference, a `var()`, `currentColor`, an unknown keyword).
 * @param {string} value
 * @returns {[number, number, number]|null}
 */
export function paintToRgb(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v || v === 'none' || v === 'transparent' || v === 'currentcolor' || v === 'inherit') return null;
  const hex = /^#([0-9a-f]{3,8})$/.exec(v);
  if (hex) {
    const h = hex[1];
    if (h.length === 3 || h.length === 4) {
      return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
    }
    if (h.length === 6 || h.length === 8) {
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    return null;
  }
  const rgb = /^rgba?\(([^)]*)\)$/.exec(v);
  if (rgb) {
    const parts = rgb[1].split(/[\s,/]+/).filter(Boolean).slice(0, 3).map((p) => (
      p.endsWith('%') ? Math.round((Number(p.slice(0, -1)) / 100) * 255) : Number(p)
    ));
    if (parts.length === 3 && parts.every(Number.isFinite)) return [clamp255(parts[0]), clamp255(parts[1]), clamp255(parts[2])];
    return null;
  }
  const hsl = /^hsla?\(([^)]*)\)$/.exec(v);
  if (hsl) {
    const parts = hsl[1].split(/[\s,/]+/).filter(Boolean);
    const h = Number(String(parts[0]).replace(/deg$/, ''));
    const s = Number(String(parts[1] || '0').replace('%', '')) / 100;
    const l = Number(String(parts[2] || '0').replace('%', '')) / 100;
    if (![h, s, l].every(Number.isFinite)) return null;
    return hslToRgb(h, s, l);
  }
  return KEYWORD_RGB[v] ? /** @type {[number, number, number]} */ (KEYWORD_RGB[v].slice()) : null;
}

/** @param {number} n @returns {number} */
function clamp255(n) { return Math.max(0, Math.min(255, Math.round(n))); }

/**
 * HSL to sRGB, exactly as CSS Color 4 §7.1 defines it.
 * @param {number} h @param {number} s @param {number} l
 * @returns {[number, number, number]}
 */
export function hslToRgb(h, s, l) {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x]
    : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  return [clamp255((r + m) * 255), clamp255((g + m) * 255), clamp255((b + m) * 255)];
}

/** @param {[number, number, number]} rgb @returns {string} */
export function rgbToHexLocal(rgb) {
  return `#${rgb.map((c) => clamp255(c).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * HSV hue of an sRGB triple, in degrees, or null when the colour is neutral.
 * @param {number} r @param {number} g @param {number} b
 * @returns {number|null}
 */
export function hueOf(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const c = max - min;
  if (c === 0) return null;
  let h;
  if (max === r) h = ((g - b) / c) % 6;
  else if (max === g) h = (b - r) / c + 2;
  else h = (r - g) / c + 4;
  h *= 60;
  return ((h % 360) + 360) % 360;
}

/**
 * The mean of a set of angles, computed on the unit circle so 359° and 1° do not
 * average to 180°.
 * @param {number[]} degrees
 * @returns {{mean: number, spread: number}}
 */
export function circularStats(degrees) {
  if (degrees.length === 0) return { mean: 0, spread: 0 };
  let sx = 0;
  let sy = 0;
  for (const d of degrees) { const r = (d * Math.PI) / 180; sx += Math.cos(r); sy += Math.sin(r); }
  const mean = ((Math.atan2(sy, sx) * 180) / Math.PI + 360) % 360;
  const resultant = Math.sqrt(sx * sx + sy * sy) / degrees.length;
  // Circular standard deviation, in degrees (Mardia, Statistics of Directional
  // Data, §2.3): sqrt(-2 ln R).
  const spread = resultant >= 1 ? 0 : (Math.sqrt(-2 * Math.log(Math.max(1e-12, resultant))) * 180) / Math.PI;
  return { mean, spread };
}

// -------------------------------------------------------------- monochrome

/**
 * @typedef {object} MonochromeVerdict
 * @property {boolean} monochrome
 * @property {'achromatic'|'single-hue'|'single-colour'|null} kind
 * @property {string|null} inkHex        the ink, when there is exactly one
 * @property {string} reason
 * @property {string[]} colors           the distinct paints found, for the studio to show
 */

/**
 * Every paint an SVG declares, as written.
 * @param {string} markup
 * @returns {string[]}
 */
export function svgPaints(markup) {
  const src = String(markup || '');
  /** @type {string[]} */
  const out = [];
  const attrRe = /\b(fill|stroke|stop-color|flood-color|lighting-color)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let m;
  while ((m = attrRe.exec(src))) out.push((m[2] ?? m[3] ?? m[4] ?? '').trim());
  const styleRe = /\b(fill|stroke|stop-color|color|background|background-color)\s*:\s*([^;"'}]+)/gi;
  while ((m = styleRe.exec(src))) out.push(m[2].trim());
  return out.filter(Boolean);
}

/**
 * Is this SVG a one-ink mark? Anything the extractor cannot resolve — a
 * gradient, a `var()`, an unknown keyword, an embedded raster — makes the answer
 * no, because a wrong "yes" here ships an incorrectly recoloured logo.
 * @param {string} markup
 * @returns {MonochromeVerdict}
 */
export function svgMonochrome(markup) {
  const src = String(markup || '');
  if (/<image\b/i.test(src)) {
    return { monochrome: false, kind: null, inkHex: null, reason: 'contains an embedded raster image', colors: [] };
  }
  if (/<(linear|radial)gradient\b|url\(\s*#/i.test(src)) {
    return { monochrome: false, kind: null, inkHex: null, reason: 'contains a gradient or paint-server reference', colors: [] };
  }
  const paints = svgPaints(src);
  /** @type {Set<string>} */
  const distinct = new Set();
  /** @type {[number, number, number][]} */
  const rgbs = [];
  let unresolved = 0;
  for (const paint of paints) {
    const lower = paint.toLowerCase();
    if (!lower || lower === 'none' || lower === 'transparent') continue;
    if (lower === 'currentcolor' || lower === 'inherit') continue;   // one inherited ink
    const rgb = paintToRgb(paint);
    if (!rgb) { unresolved += 1; distinct.add(lower); continue; }
    const hex = rgbToHexLocal(rgb);
    distinct.add(hex);
    rgbs.push(rgb);
  }
  if (unresolved > 0) {
    return { monochrome: false, kind: null, inkHex: null, reason: 'contains a paint this build cannot resolve', colors: [...distinct].sort() };
  }
  if (rgbs.length === 0) {
    // No explicit paint at all: SVG's initial fill is black, so the mark is a
    // single black ink.
    return { monochrome: true, kind: 'achromatic', inkHex: '#000000', reason: 'no explicit paint; SVG initial fill is black', colors: [] };
  }
  const verdict = rgbSetMonochrome(rgbs);
  return { ...verdict, colors: [...distinct].sort() };
}

/**
 * Decide whether a set of sRGB colours is one ink.
 * @param {[number, number, number][]} rgbs
 * @returns {{monochrome: boolean, kind: 'achromatic'|'single-hue'|'single-colour'|null, inkHex: string|null, reason: string}}
 */
export function rgbSetMonochrome(rgbs) {
  const distinct = new Set(rgbs.map(rgbToHexLocal));
  if (distinct.size === 1) {
    const only = [...distinct][0];
    return { monochrome: true, kind: 'single-colour', inkHex: only, reason: 'one colour' };
  }
  const chroma = rgbs.map(([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b));
  if (chroma.every((c) => c <= ACHROMATIC_CHROMA)) {
    const darkest = rgbs.slice().sort((a, b) => (a[0] + a[1] + a[2]) - (b[0] + b[1] + b[2]))[0];
    return { monochrome: true, kind: 'achromatic', inkHex: rgbToHexLocal(darkest), reason: 'every paint is neutral' };
  }
  const hues = [];
  for (let i = 0; i < rgbs.length; i++) {
    if (chroma[i] <= ACHROMATIC_CHROMA) continue;      // black/white/grey accompany any ink
    const h = hueOf(rgbs[i][0], rgbs[i][1], rgbs[i][2]);
    if (h !== null) hues.push(h);
  }
  if (hues.length === 0) return { monochrome: false, kind: null, inkHex: null, reason: 'no resolvable hue' };
  const { spread } = circularStats(hues);
  if (spread <= MONO_HUE_SPREAD_DEG) {
    // The ink is the most saturated chromatic colour: tints of one ink read as
    // that ink, and the inverse must keep it.
    let ink = null;
    let bestChroma = -1;
    for (let i = 0; i < rgbs.length; i++) {
      if (chroma[i] > bestChroma) { bestChroma = chroma[i]; ink = rgbs[i]; }
    }
    return { monochrome: true, kind: 'single-hue', inkHex: ink ? rgbToHexLocal(ink) : null, reason: `hue spread ${spread.toFixed(1)}deg` };
  }
  return { monochrome: false, kind: null, inkHex: null, reason: `hue spread ${spread.toFixed(1)}deg exceeds ${MONO_HUE_SPREAD_DEG}deg` };
}

/**
 * Is this decoded raster a one-ink mark? Fully transparent pixels are ignored;
 * anti-aliasing fringes are tolerated by `MONO_PIXEL_SHARE`.
 * @param {DecodedImage} image
 * @returns {MonochromeVerdict}
 */
export function rasterMonochrome(image) {
  const d = image.data;
  let opaque = 0;
  let achromatic = 0;
  /** @type {number[]} */
  const hues = [];
  /** @type {Map<string, number>} */
  const counts = new Map();
  let inkRgb = null;
  let inkChroma = -1;

  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] <= ALPHA_FLOOR) continue;
    opaque += 1;
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    if (chroma <= ACHROMATIC_CHROMA) achromatic += 1;
    else {
      const h = hueOf(r, g, b);
      if (h !== null) hues.push(h);
      if (chroma > inkChroma) { inkChroma = chroma; inkRgb = [r, g, b]; }
    }
    const hex = rgbToHexLocal([r, g, b]);
    counts.set(hex, (counts.get(hex) || 0) + 1);
  }

  if (opaque === 0) {
    return { monochrome: false, kind: null, inkHex: null, reason: 'no opaque pixels', colors: [] };
  }
  const top = [...counts.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0])).slice(0, 8).map(([hex]) => hex);

  if (achromatic / opaque >= MONO_PIXEL_SHARE) {
    // The ink is the darkest colour that occupies a real share of the mark.
    const ink = [...counts.entries()]
      .filter(([, n]) => n / opaque >= 0.01)
      .sort((a, b) => sumHex(a[0]) - sumHex(b[0]))[0];
    return {
      monochrome: true, kind: 'achromatic', inkHex: ink ? ink[0] : '#000000',
      reason: `${((achromatic / opaque) * 100).toFixed(1)}% of opaque pixels are neutral`, colors: top,
    };
  }
  if (hues.length === 0) {
    return { monochrome: false, kind: null, inkHex: null, reason: 'chromatic pixels with no resolvable hue', colors: top };
  }
  const { spread } = circularStats(hues);
  const chromaticShare = hues.length / opaque;
  if (spread <= MONO_HUE_SPREAD_DEG && (achromatic + hues.length) / opaque >= MONO_PIXEL_SHARE) {
    return {
      monochrome: true, kind: 'single-hue', inkHex: inkRgb ? rgbToHexLocal(inkRgb) : null,
      reason: `one hue, spread ${spread.toFixed(1)}deg over ${(chromaticShare * 100).toFixed(1)}% of the mark`, colors: top,
    };
  }
  return { monochrome: false, kind: null, inkHex: null, reason: `hue spread ${spread.toFixed(1)}deg exceeds ${MONO_HUE_SPREAD_DEG}deg`, colors: top };
}

/** @param {string} hex @returns {number} */
function sumHex(hex) {
  return parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16);
}

// --------------------------------------------------------------- image info

/**
 * @typedef {object} ImageInfo
 * @property {'png'|'jpeg'|'gif'|'webp'|'svg'|'bmp'|'ico'|null} format
 * @property {number} w
 * @property {number} h
 * @property {boolean} hasTransparency
 * @property {boolean} transparencyChecked  true when the alpha channel was read, not inferred
 * @property {string} mime
 */

/** MIME types by format. */
export const FORMAT_MIME = {
  png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
};

/**
 * Everything the extractor knows about an asset, read from the asset itself.
 * @param {Uint8Array|string} source  raw bytes, or SVG markup
 * @returns {ImageInfo}
 */
export function imageInfo(source) {
  if (typeof source === 'string') {
    const size = svgIntrinsic(source);
    return {
      format: 'svg', w: size.w, h: size.h,
      hasTransparency: !svgHasFullBleedBackground(source),
      transparencyChecked: true, mime: FORMAT_MIME.svg,
    };
  }
  const bytes = source;
  const format = sniffFormat(bytes);
  const base = { format, w: 0, h: 0, hasTransparency: false, transparencyChecked: false, mime: format ? FORMAT_MIME[format] : 'application/octet-stream' };
  if (format === 'svg') return imageInfo(new TextDecoder().decode(bytes));
  if (format === 'png') {
    const png = readPng(bytes);
    let hasTransparency = pngMayHaveTransparency(png);
    let checked = !hasTransparency || png.colorType === 3;
    if (hasTransparency && (png.colorType === 4 || png.colorType === 6) && png.interlace === 0) {
      try { hasTransparency = alphaUsed(decodePng(bytes)); checked = true; } catch { checked = false; }
    }
    return { ...base, w: png.width, h: png.height, hasTransparency, transparencyChecked: checked };
  }
  if (format === 'jpeg') {
    const info = jpegInfo(bytes);
    return { ...base, w: info ? info.w : 0, h: info ? info.h : 0, hasTransparency: false, transparencyChecked: true };
  }
  if (format === 'gif') {
    const info = gifInfo(bytes);
    return { ...base, w: info ? info.w : 0, h: info ? info.h : 0, hasTransparency: !!(info && info.hasTransparency), transparencyChecked: true };
  }
  if (format === 'webp') {
    const info = webpInfo(bytes);
    return { ...base, w: info ? info.w : 0, h: info ? info.h : 0, hasTransparency: !!(info && info.hasTransparency), transparencyChecked: true };
  }
  if (format === 'bmp') {
    const info = bmpInfo(bytes);
    return { ...base, w: info ? info.w : 0, h: info ? info.h : 0, hasTransparency: !!(info && info.hasTransparency), transparencyChecked: true };
  }
  if (format === 'ico') {
    const info = icoInfo(bytes);
    return { ...base, w: info ? info.w : 0, h: info ? info.h : 0, hasTransparency: true, transparencyChecked: false };
  }
  return base;
}

// ------------------------------------------------------------ classification

/**
 * Classify a logo asset into one of the five §4 variants.
 *
 * Named signals win over shape, because a file called `logo-inverse.svg` is
 * telling the truth and a 3:1 aspect ratio is only evidence. Shape decides the
 * rest: a favicon is small, a wordmark is wide, a mark is square-ish, and
 * everything else is the primary lockup.
 *
 * @param {{w: number, h: number, name?: string, alt?: string, context?: string, source?: string}} input
 * @returns {'primary'|'mark'|'wordmark'|'inverse'|'favicon'}
 */
export function classifyVariant(input) {
  const text = [input.name, input.alt, input.context].filter(Boolean).join(' ');
  for (const signal of VARIANT_SIGNALS) {
    if (signal.re.test(text)) return /** @type {any} */ (signal.variant);
  }
  if (input.source === 'link-icon-svg' || input.source === 'link-icon-raster') return 'favicon';
  const w = Number(input.w) || 0;
  const h = Number(input.h) || 0;
  if (w > 0 && h > 0 && w <= FAVICON_MAX_PX && h <= FAVICON_MAX_PX) return 'favicon';
  if (h > 0) {
    const aspect = w / h;
    if (aspect >= WORDMARK_ASPECT) return 'wordmark';
    if (aspect >= MARK_ASPECT_BAND.min && aspect <= MARK_ASPECT_BAND.max) return 'mark';
  }
  return 'primary';
}

// ------------------------------------------------------------- doc traversal

/**
 * Serialize a DocNode subtree back to markup. Used to lift an inline `<svg>` out
 * of a captured page without a second parser.
 * @param {any} node
 * @returns {string}
 */
export function serializeNode(node) {
  if (!node || typeof node !== 'object') return '';
  if (node.type === 'text') return escapeText(String(node.text ?? ''));
  if (node.type === 'comment') return '';
  const tag = String(node.tag || 'div').toLowerCase();
  const attrs = node.attrs || {};
  const parts = Object.keys(attrs).sort().map((k) => ` ${k}="${escapeAttr(String(attrs[k]))}"`).join('');
  if (VOID_ELEMENTS.has(tag)) return `<${tag}${parts}/>`;
  const inner = (node.children || []).map(serializeNode).join('');
  return `<${tag}${parts}>${inner}</${tag}>`;
}

/**
 * True when this element, or an ancestor, is the page header region (§7's
 * "largest raster in the header region").
 * @param {any} node
 * @param {any[]} ancestors
 * @returns {boolean}
 */
export function inHeaderRegion(node, ancestors) {
  for (const n of ancestors.concat([node])) {
    if (n.type !== 'element') continue;
    const tag = String(n.tag || '').toLowerCase();
    if (HEADER_TAGS.has(tag)) return true;
    const attrs = n.attrs || {};
    const role = String(attrs.role || '').toLowerCase();
    if (role === 'banner' || role === 'navigation') return true;
    const bag = `${attrs.class || ''} ${attrs.id || ''} ${attrs['data-testid'] || ''}`;
    if (HEADER_CONTEXT_RE.test(bag)) return true;
  }
  return false;
}

/**
 * The logo-ish descriptive text around an element: its own class/id/alt plus
 * those of its ancestors, which is where `<a class="site-logo">` lives.
 * @param {any} node
 * @param {any[]} ancestors
 * @returns {string}
 */
export function contextText(node, ancestors) {
  const bits = [];
  for (const n of ancestors.concat([node])) {
    if (n.type !== 'element') continue;
    const a = n.attrs || {};
    bits.push(a.class || '', a.id || '', a['aria-label'] || '', a.alt || '', a.title || '', a['data-testid'] || '');
  }
  return bits.filter(Boolean).join(' ');
}

/**
 * The identity words that belong to *this element* — its own class, id and
 * aria-label — plus those of the nearest ancestor `<a>`, because
 * `<a class="site-logo"><svg/></a>` is the link that *is* the logo.
 *
 * Deliberately narrower than `contextText`: the full ancestor chain makes every
 * image inside a `.masthead` look equally logo-like, which is how a partner
 * badge and the real logo become indistinguishable.
 *
 * @param {any} node
 * @param {any[]} ancestors
 * @returns {string}
 */
export function ownIdentityText(node, ancestors) {
  const bits = [];
  const own = node.attrs || {};
  bits.push(own.class || '', own.id || '', own['aria-label'] || '');
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i];
    if (a.type !== 'element') continue;
    if (String(a.tag || '').toLowerCase() !== 'a') continue;
    const attrs = a.attrs || {};
    bits.push(attrs.class || '', attrs.id || '', attrs['aria-label'] || '', attrs.title || '');
    break;                       // only the innermost link wrapper
  }
  return bits.filter(Boolean).join(' ');
}

/**
 * Index an asset list by every name it can be found under: the full name, the
 * name without a query string, and the basename. Captured pages reference the
 * same file all three ways.
 * @param {{name?: string, url?: string, bytes?: Uint8Array, mime?: string}[]} assets
 * @returns {Map<string, {name: string, bytes: Uint8Array, mime: string}>}
 */
export function indexAssets(assets) {
  /** @type {Map<string, any>} */
  const index = new Map();
  for (const asset of assets || []) {
    if (!asset || !asset.bytes) continue;
    const name = String(asset.name ?? asset.url ?? '');
    const record = { name, bytes: asset.bytes, mime: asset.mime || '' };
    for (const key of assetKeys(name)) if (!index.has(key)) index.set(key, record);
  }
  return index;
}

/** @param {string} name @returns {string[]} */
export function assetKeys(name) {
  const raw = String(name || '');
  if (!raw) return [];
  const noQuery = raw.split('#')[0].split('?')[0];
  const base = noQuery.split('/').pop() || noQuery;
  return [...new Set([raw, noQuery, base, base.toLowerCase()])].filter(Boolean);
}

/**
 * Find the asset a markup reference points at.
 * @param {Map<string, any>} index
 * @param {string} href
 * @returns {{name: string, bytes: Uint8Array, mime: string}|null}
 */
export function lookupAsset(index, href) {
  for (const key of assetKeys(href)) {
    const hit = index.get(key);
    if (hit) return hit;
  }
  return null;
}

// ---------------------------------------------------------------- extraction

/**
 * Every URL a page's schema.org JSON-LD declares as an organisation's logo.
 *
 * This is the one place on a page where a site says, unambiguously and in its
 * own words, *this asset is my logo*. Every other signal in this module is an
 * inference from placement, filename or proportions. The URLs are read and
 * matched against the assets the caller supplied; nothing is fetched.
 *
 * @param {any} doc   an L3 DocNode tree, or null
 * @returns {string[]}   declared logo URLs, in document order, deduplicated
 */
export function declaredLogoUrls(doc) {
  /** @type {string[]} */
  const out = [];
  if (!doc) return out;
  walkDoc(doc, (node) => {
    if (node.type !== 'element') return;
    if (String(node.tag || '').toLowerCase() !== 'script') return;
    const type = String((node.attrs || {}).type || '').toLowerCase();
    if (!type.includes('ld+json')) return;
    const text = docText(node).trim();
    if (!text) return;
    let parsed;
    try { parsed = JSON.parse(text); } catch { return; }      // malformed LD is not an error
    collectLdLogos(parsed, out, 0);
  });
  return [...new Set(out)];
}

/**
 * Walk a parsed JSON-LD value for `logo` properties on organisation-like nodes,
 * following `@graph`, arrays, and the `publisher` chain a `WebSite` or
 * `NewsArticle` hangs its organisation off.
 * @param {any} value @param {string[]} out @param {number} depth
 */
function collectLdLogos(value, out, depth) {
  if (depth > 8 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const item of value) collectLdLogos(item, out, depth + 1); return; }

  const types = [];
  const rawType = value['@type'];
  if (typeof rawType === 'string') types.push(rawType.toLowerCase());
  else if (Array.isArray(rawType)) for (const t of rawType) if (typeof t === 'string') types.push(t.toLowerCase());

  // `logo` is only meaningful on a node that could own one. An untyped node in a
  // `publisher` slot counts, because sites routinely omit the type there.
  if (value.logo !== undefined && (types.length === 0 || types.some((t) => LD_LOGO_TYPES.has(t)))) {
    const url = ldImageUrl(value.logo);
    if (url) out.push(url);
  }
  for (const key of ['@graph', 'publisher', 'sourceOrganization', 'brand', 'provider', 'parentOrganization', 'mainEntity', 'about', 'author']) {
    if (value[key] !== undefined) collectLdLogos(value[key], out, depth + 1);
  }
}

/**
 * A JSON-LD image value: either a URL string or an `ImageObject` carrying one.
 * @param {any} value @returns {string|null}
 */
function ldImageUrl(value) {
  if (typeof value === 'string') return value.trim() || null;
  if (Array.isArray(value)) { for (const item of value) { const url = ldImageUrl(item); if (url) return url; } return null; }
  if (value && typeof value === 'object') {
    for (const key of ['url', 'contentUrl', '@id']) {
      if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
    }
  }
  return null;
}

/**
 * @typedef {object} LogoCandidate
 * @property {'ld-logo'|'inline-svg'|'link-icon-svg'|'link-icon-raster'|'og-image'|'header-raster'|'supplied'} source
 * @property {number} rank            §7 preference order, 1 is best
 * @property {'svg'|'raster'} kind
 * @property {string} data            inline SVG markup, or a data URI
 * @property {ImageInfo} info
 * @property {string} name
 * @property {string} alt
 * @property {string} context
 * @property {boolean} [declared]     named by schema.org JSON-LD as the logo
 * @property {string[]} [sources]     every source that found this same asset
 * @property {boolean} [inHeader]     found inside the page header region
 * @property {string} [ownContext]    identity words belonging to the element itself
 */

/**
 * §7's preference order as an integer rank, with the schema.org declaration
 * ahead of it (L5-D23): the site naming its own logo is not an inference.
 */
const SOURCE_ORDER = { supplied: 0, 'ld-logo': 0, 'inline-svg': 1, 'link-icon-svg': 2, 'og-image': 3, 'header-raster': 4, 'link-icon-raster': 4 };

/**
 * Collect every logo candidate in a document, in §7 preference order.
 * @param {any} doc
 * @param {{name?: string, url?: string, bytes?: Uint8Array, mime?: string}[]} assets
 * @returns {LogoCandidate[]}
 */
export function collectLogoCandidates(doc, assets) {
  const index = indexAssets(assets);
  /** @type {LogoCandidate[]} */
  const out = [];
  /** @type {{node: any, ancestors: any[]}[]} */
  const rasters = [];
  /** @type {string[]} */
  const iconHrefs = [];
  /** @type {string[]} */
  const ogHrefs = [];

  if (doc) {
    walkDoc(doc, (node, ancestors) => {
      if (node.type !== 'element') return;
      const tag = String(node.tag || '').toLowerCase();
      const attrs = node.attrs || {};
      if (tag === 'svg') {
        // Only an SVG the page presents as its identity, not every icon glyph.
        const context = contextText(node, ancestors);
        if (!LOGO_CONTEXT_RE.test(context) && !inHeaderRegion(node, ancestors)) return;
        const markup = serializeNode(node);
        out.push({
          source: 'inline-svg', rank: SOURCE_ORDER['inline-svg'], kind: 'svg', data: markup,
          info: imageInfo(markup), name: String(attrs.id || ''), alt: String(attrs['aria-label'] || docText(node).trim()),
          context, inHeader: inHeaderRegion(node, ancestors), ownContext: ownIdentityText(node, ancestors),
        });
        return;
      }
      if (tag === 'link') {
        const rel = String(attrs.rel || '').toLowerCase();
        const href = String(attrs.href || '');
        if (href && /\b(icon|shortcut icon|apple-touch-icon|mask-icon)\b/.test(rel)) iconHrefs.push(href);
        return;
      }
      if (tag === 'meta') {
        const prop = String(attrs.property || attrs.name || '').toLowerCase();
        const content = String(attrs.content || '');
        if (content && (prop === 'og:image' || prop === 'og:image:url' || prop === 'og:image:secure_url' || prop === 'twitter:image')) ogHrefs.push(content);
        return;
      }
      if (tag === 'img' || tag === 'image') rasters.push({ node, ancestors });
    });
  }

  for (const href of iconHrefs) {
    const asset = lookupAsset(index, href);
    if (!asset) continue;
    const info = imageInfo(asset.bytes);
    const isSvg = info.format === 'svg';
    const source = isSvg ? 'link-icon-svg' : 'link-icon-raster';
    out.push({
      source, rank: SOURCE_ORDER[source], kind: isSvg ? 'svg' : 'raster',
      data: isSvg ? new TextDecoder().decode(asset.bytes) : dataUri(asset.bytes, info.mime),
      info, name: asset.name, alt: '', context: href,
    });
  }

  for (const href of ogHrefs) {
    const asset = lookupAsset(index, href);
    if (!asset) continue;
    const info = imageInfo(asset.bytes);
    out.push({
      source: 'og-image', rank: SOURCE_ORDER['og-image'],
      kind: info.format === 'svg' ? 'svg' : 'raster',
      data: info.format === 'svg' ? new TextDecoder().decode(asset.bytes) : dataUri(asset.bytes, info.mime),
      info, name: asset.name, alt: '', context: href,
    });
  }

  /** @type {LogoCandidate[]} */
  const headerRasters = [];
  for (const { node, ancestors } of rasters) {
    const attrs = node.attrs || {};
    const src = String(attrs.src || attrs['xlink:href'] || attrs.href || '');
    if (!src) continue;
    const context = contextText(node, ancestors);
    const looksLikeLogo = LOGO_CONTEXT_RE.test(`${context} ${src}`);
    if (!inHeaderRegion(node, ancestors) && !looksLikeLogo) continue;
    const asset = lookupAsset(index, src);
    if (!asset) continue;
    const info = imageInfo(asset.bytes);
    headerRasters.push({
      source: 'header-raster', rank: SOURCE_ORDER['header-raster'],
      kind: info.format === 'svg' ? 'svg' : 'raster',
      data: info.format === 'svg' ? new TextDecoder().decode(asset.bytes) : dataUri(asset.bytes, info.mime),
      info, name: asset.name || src, alt: String(attrs.alt || ''),
      context, inHeader: inHeaderRegion(node, ancestors), ownContext: ownIdentityText(node, ancestors),
    });
  }
  // §7 asks for the *largest* raster in the header region; a named logo beats a
  // merely-large hero image at equal size.
  // The name and alt belong to the image itself; the surrounding context does
  // not, because every image inside a `.masthead` inherits the same words and
  // the tie-break would stop discriminating.
  headerRasters.sort((a, b) => {
    const named = (c) => (LOGO_CONTEXT_RE.test(`${c.name} ${c.alt} ${c.ownContext || ''}`) ? 1 : 0);
    return (named(b) - named(a)) || ((b.info.w * b.info.h) - (a.info.w * a.info.h)) || a.name.localeCompare(b.name);
  });
  out.push(...headerRasters);

  // The site's own declaration. It never displaces anything §7 names — the same
  // assets are still found — it only records which of them the site called its
  // logo, and adds the declared asset when no other tier reached it.
  const declared = declaredLogoUrls(doc);
  if (declared.length) {
    const declaredKeys = new Set();
    for (const url of declared) for (const key of assetKeys(url)) declaredKeys.add(key);
    const isDeclared = (candidate) => assetKeys(candidate.name).some((k) => declaredKeys.has(k))
      || assetKeys(candidate.context).some((k) => declaredKeys.has(k));
    for (const candidate of out) if (isDeclared(candidate)) candidate.declared = true;

    for (const url of declared) {
      if (out.some((c) => c.declared && assetKeys(c.name).concat(assetKeys(c.context)).some((k) => assetKeys(url).includes(k)))) continue;
      const asset = lookupAsset(index, url);
      if (!asset) continue;
      const info = imageInfo(asset.bytes);
      out.push({
        source: 'ld-logo', rank: SOURCE_ORDER['ld-logo'],
        kind: info.format === 'svg' ? 'svg' : 'raster',
        data: info.format === 'svg' ? new TextDecoder().decode(asset.bytes) : dataUri(asset.bytes, info.mime),
        info, name: asset.name, alt: '', context: url, declared: true, inHeader: false,
      });
    }
  }

  return out;
}

/** @param {Uint8Array} bytes @param {string} mime @returns {string} */
export function dataUri(bytes, mime) {
  return `data:${mime || 'application/octet-stream'};base64,${base64Encode(bytes)}`;
}

/**
 * Extract the brand's logo assets (§7).
 *
 * @param {any} doc              an L3 DocNode tree, or null
 * @param {{name?: string, url?: string, bytes?: Uint8Array, mime?: string}[]} assets
 * @param {{idMinter: {next: (kind: string) => string}, maxLogos?: number}} deps
 * @returns {object[]}   §4 LogoAsset records, with optional lane extensions
 */
export function extractLogos(doc, assets, deps) {
  if (!deps || !deps.idMinter || typeof deps.idMinter.next !== 'function') {
    throw new Error('extractLogos: an injected idMinter is required (determinism, §5)');
  }
  const maxLogos = deps.maxLogos ?? 8;
  const { selected } = selectLogos(collectLogoCandidates(doc, assets), { maxLogos });
  return selected.map((entry) => logoFromCandidate(entry.candidate, deps.idMinter, entry.variant));
}

/**
 * Merge candidates that are the same asset found more than once, keeping every
 * source that found it. Two tiers agreeing on one file is the strongest evidence
 * available without a human, and dropping the duplicate used to throw it away.
 * @param {LogoCandidate[]} candidates
 * @returns {LogoCandidate[]}
 */
export function mergeCandidates(candidates) {
  /** @type {Map<string, LogoCandidate>} */
  const byContent = new Map();
  // §7 preference tier first, so the survivor keeps the best source.
  const ordered = candidates.slice().sort((a, b) =>
    (a.rank - b.rank)
    || ((b.info.w * b.info.h) - (a.info.w * a.info.h))
    || String(a.name).localeCompare(String(b.name)));

  for (const candidate of ordered) {
    const fingerprint = contentHash({ kind: candidate.kind, data: candidate.data });
    const hit = byContent.get(fingerprint);
    if (!hit) {
      byContent.set(fingerprint, { ...candidate, sources: [candidate.source] });
      continue;
    }
    if (!hit.sources.includes(candidate.source)) hit.sources.push(candidate.source);
    hit.declared = hit.declared || candidate.declared === true;
    hit.inHeader = hit.inHeader || candidate.inHeader === true;
    if (!hit.alt && candidate.alt) hit.alt = candidate.alt;
    if (!hit.name && candidate.name) hit.name = candidate.name;
    if (!hit.ownContext && candidate.ownContext) hit.ownContext = candidate.ownContext;
  }
  return [...byContent.values()];
}

/**
 * How strongly a candidate claims to be the brand's **primary** asset.
 *
 * §7's preference order says where to look; it does not say which of the things
 * found is the logo, and treating "first tier that produced something" as the
 * answer promotes an og:image over the SVG sitting in the site header. Every
 * term is named in `IDENTITY_WEIGHTS` and returned alongside the score so the
 * studio can show why an asset was chosen.
 *
 * @param {LogoCandidate} candidate
 * @returns {{score: number, terms: Record<string, number>}}
 */
export function identityScore(candidate) {
  const w = IDENTITY_WEIGHTS;
  const sources = candidate.sources || [candidate.source];
  const form = classifyVariant({
    w: candidate.info.w, h: candidate.info.h,
    name: candidate.name, alt: candidate.alt, context: candidate.context, source: candidate.source,
  });
  /** @type {Record<string, number>} */
  const terms = {};
  if (candidate.declared) terms.declared = w.declared;
  // The asset's own filename, alt text and element identity — never the whole
  // inherited context: every image inside a `.masthead` shares the same
  // surrounding words, and the term would stop discriminating.
  if (LOGO_CONTEXT_RE.test(`${candidate.name} ${candidate.alt} ${candidate.ownContext || ''}`)) terms.named = w.named;
  if (candidate.inHeader || sources.includes('inline-svg') || sources.includes('header-raster')) terms.inHeader = w.inHeader;
  if (candidate.kind === 'svg') terms.vector = w.vector;
  if (form === 'primary' || form === 'wordmark') terms.lockupForm = w.lockupForm;
  if (sources.length === 1 && sources[0] === 'og-image') terms.ogOnly = w.ogOnly;
  if (form === 'favicon') terms.faviconForm = w.faviconForm;

  let score = 0;
  for (const value of Object.values(terms)) score += value;
  return { score: Math.round(score * 1e6) / 1e6, terms };
}

/**
 * Decide which candidates are logo assets and which one is the primary.
 *
 * Three rules, in order:
 *
 *  1. **Exactly one asset is `primary`** — the highest `identityScore`. A
 *     non-empty result always has one, because `logoFor(brand)` defaults to it
 *     and a layout that asks for the brand's logo must get the brand's logo.
 *  2. **Every other asset keeps its shape-and-name variant** — favicon,
 *     wordmark, mark or inverse.
 *  3. **An asset that is neither the primary nor recognisably a variant is not a
 *     logo** and is rejected with a reason. That is the og:image case: a
 *     320x180 photograph that is not square, not wide, not small and not named,
 *     sitting beside a real header logo, is a social card. Rejecting it is what
 *     keeps a picture of an industrial plant out of every layout.
 *
 * @param {LogoCandidate[]} candidates
 * @param {{maxLogos?: number}} [options]
 * @returns {{selected: {candidate: LogoCandidate, variant: string, score: number, terms: Record<string, number>}[], rejected: {candidate: LogoCandidate, reason: string}[]}}
 */
export function selectLogos(candidates, options = {}) {
  const maxLogos = options.maxLogos ?? 8;
  const merged = mergeCandidates(candidates || []);
  if (merged.length === 0) return { selected: [], rejected: [] };

  const scored = merged.map((candidate) => {
    const { score, terms } = identityScore(candidate);
    const variant = classifyVariant({
      w: candidate.info.w, h: candidate.info.h,
      name: candidate.name, alt: candidate.alt, context: candidate.context, source: candidate.source,
    });
    return { candidate, variant, score, terms };
  });

  // Highest identity score wins the primary role; ties fall back to §7's own
  // preference order, then painted area, then name, so the choice never depends
  // on iteration order (§5).
  const ranked = scored.slice().sort((a, b) =>
    (b.score - a.score)
    || (a.candidate.rank - b.candidate.rank)
    || ((b.candidate.info.w * b.candidate.info.h) - (a.candidate.info.w * a.candidate.info.h))
    || String(a.candidate.name).localeCompare(String(b.candidate.name)));
  const primary = ranked[0];

  /** @type {{candidate: LogoCandidate, variant: string, score: number, terms: Record<string, number>}[]} */
  const selected = [];
  /** @type {{candidate: LogoCandidate, reason: string}[]} */
  const rejected = [];

  for (const entry of scored) {
    if (entry === primary) { selected.push({ ...entry, variant: 'primary' }); continue; }
    if (entry.variant === 'primary') {
      // No shape or name signal, and it is not the identity: not a logo.
      rejected.push({
        candidate: entry.candidate,
        reason: `no variant signal and not the primary identity (score ${entry.score} against ${primary.score})`,
      });
      continue;
    }
    selected.push(entry);
  }

  // Emit in §7 preference order, primary first, so the artifact's asset list
  // reads the way the studio presents it.
  selected.sort((a, b) => {
    const rank = (e) => (e.variant === 'primary' ? -1 : e.candidate.rank);
    return (rank(a) - rank(b))
      || ((b.candidate.info.w * b.candidate.info.h) - (a.candidate.info.w * a.candidate.info.h))
      || String(a.candidate.name).localeCompare(String(b.candidate.name));
  });
  return { selected: selected.slice(0, maxLogos), rejected };
}

/**
 * Build a §4 `LogoAsset` from a candidate, including the monochrome verdict that
 * decides whether an inverse can be generated at all.
 * @param {LogoCandidate} candidate
 * @param {{next: (kind: string) => string}} idMinter
 * @param {string} [assignedVariant]  the role `selectLogos` gave it, if any
 * @returns {object}
 */
export function logoFromCandidate(candidate, idMinter, assignedVariant) {
  const verdict = monochromeOf(candidate);
  const formVariant = classifyVariant({
    w: candidate.info.w, h: candidate.info.h,
    name: candidate.name, alt: candidate.alt, context: candidate.context, source: candidate.source,
  });
  const variant = assignedVariant || formVariant;
  return {
    id: idMinter.next('logo'),
    kind: candidate.kind,
    data: candidate.data,
    variant,
    intrinsic: { w: candidate.info.w, h: candidate.info.h },
    hasTransparency: candidate.info.hasTransparency,
    // --- optional lane extensions (§4 permits added optional fields) --------
    source: candidate.source,
    sources: (candidate.sources || [candidate.source]).slice().sort(),
    declared: candidate.declared === true,
    inHeader: candidate.inHeader === true,
    formVariant,
    format: candidate.info.format,
    mime: candidate.info.mime,
    transparencyChecked: candidate.info.transparencyChecked,
    monochrome: verdict.monochrome,
    monochromeKind: verdict.kind,
    inkHex: verdict.inkHex,
    monochromeReason: verdict.reason,
    // §7: an inverse is only generated for a monochrome mark. Anything else
    // needs a real reversed asset from the client, and says so.
    needsInverseAsset: variant !== 'inverse' && !verdict.monochrome,
    alt: candidate.alt || null,
  };
}

/**
 * The monochrome verdict for a candidate, whatever its format.
 * @param {LogoCandidate|{kind: string, data: string, info?: ImageInfo}} candidate
 * @returns {MonochromeVerdict}
 */
export function monochromeOf(candidate) {
  if (candidate.kind === 'svg') return svgMonochrome(candidate.data);
  const parsed = parseLogoDataUri(candidate.data);
  if (!parsed) return { monochrome: false, kind: null, inkHex: null, reason: 'no decodable pixel data', colors: [] };
  if (sniffFormat(parsed.bytes) !== 'png') {
    return { monochrome: false, kind: null, inkHex: null, reason: `pixels of a ${sniffFormat(parsed.bytes) || 'unknown'} image are not decoded by this build`, colors: [] };
  }
  try {
    return rasterMonochrome(decodePng(parsed.bytes));
  } catch (error) {
    return { monochrome: false, kind: null, inkHex: null, reason: `png could not be decoded: ${error.message}`, colors: [] };
  }
}

/**
 * Decode a `data:` URI into bytes. Kept here rather than taken from
 * `core/bytes.js` `parseDataUri` because a logo's URI may be percent-encoded
 * rather than base64.
 * @param {string} uri
 * @returns {{mime: string, bytes: Uint8Array}|null}
 */
export function parseLogoDataUri(uri) {
  const m = /^data:([^;,]*)((?:;[^,]*)*),([\s\S]*)$/.exec(String(uri || ''));
  if (!m) return null;
  const mime = m[1] || 'text/plain';
  const isBase64 = /;base64/i.test(m[2] || '');
  try {
    if (isBase64) {
      const clean = m[3].replace(/\s+/g, '');
      const binary = base64ToBytes(clean);
      return { mime, bytes: binary };
    }
    return { mime, bytes: utf8Encode(decodeURIComponent(m[3])) };
  } catch {
    return null;
  }
}

/**
 * Base64 to bytes. `core/bytes.js` owns the encoder; the decoder is inlined here
 * so this module does not depend on the platform `atob` in Node.
 * @param {string} b64
 * @returns {Uint8Array}
 */
function base64ToBytes(b64) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  /** @type {Record<string, number>} */
  const lookup = {};
  for (let i = 0; i < alphabet.length; i++) lookup[alphabet[i]] = i;
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = lookup[clean[i]] ?? 0;
    const b = lookup[clean[i + 1]] ?? 0;
    const c = lookup[clean[i + 2]] ?? 0;
    const d = lookup[clean[i + 3]] ?? 0;
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    if (o < out.length) out[o++] = (n >> 16) & 0xff;
    if (o < out.length) out[o++] = (n >> 8) & 0xff;
    if (o < out.length) out[o++] = n & 0xff;
  }
  return out;
}

// ----------------------------------------------------------------- inversion

/**
 * The luminance at which black and white contrast equally against a colour:
 * the solution of (Y + 0.05)/0.05 = 1.05/(Y + 0.05), which is
 * sqrt(1.05 x 0.05) - 0.05 = 0.17912878... Published as the "contrast pivot" and
 * used here as the definition of a light ink.
 */
export const WCAG_CONTRAST_PIVOT = Math.sqrt(1.05 * 0.05) - 0.05;

/** Bisection steps used to hit a target luminance. 24 steps resolve L to 6e-8. */
export const INVERT_BISECT_STEPS = 24;

/**
 * Invert one ink by **luminance inversion**, which is what §7 asks for: the
 * ink's WCAG relative luminance Y is reflected to 1 - Y, its hue is held, and
 * its chroma is clamped back into the sRGB gamut at the new lightness.
 *
 * Reflecting OKLab lightness instead would be a different operation and a worse
 * one: a near-black mark would come back mid-grey rather than white, and a
 * reversed lockup that is grey on black is a defect, not an inverse.
 *
 * The lightness that hits the target luminance is found by bisection, because
 * relative luminance is monotonic in OKLab L at a fixed hue and clamped chroma
 * but has no closed form through the gamut clamp.
 *
 * Colour science is L4's (`brand/color.js`); this module decides *what* to
 * invert and *to what*, never *how* a colour converts.
 *
 * @param {string} hex
 * @returns {string}
 */
export function invertInk(hex) {
  const rgb = paintToRgb(hex);
  if (!rgb) return hex;
  const target = 1 - relativeLuminance(rgb);
  const [, chroma, hue] = hexToOklch(hex);

  /** @param {number} l @returns {string} */
  const at = (l) => oklchToHex(clampChromaToGamut([l, chroma, hue]));
  /** @param {number} l @returns {number} */
  const luminanceAt = (l) => {
    const out = paintToRgb(at(l));
    return out ? relativeLuminance(out) : 0;
  };

  let lo = 0;
  let hi = 1;
  if (luminanceAt(hi) <= target) return at(hi);
  if (luminanceAt(lo) >= target) return at(lo);
  for (let i = 0; i < INVERT_BISECT_STEPS; i++) {
    const mid = (lo + hi) / 2;
    if (luminanceAt(mid) < target) lo = mid;
    else hi = mid;
  }
  return at((lo + hi) / 2);
}

/**
 * Whether an ink reads as light: its WCAG relative luminance sits above the
 * contrast pivot, the luminance at which black and white contrast equally
 * against it. Used to label a generated inverse for the studio.
 * @param {string} hex
 * @returns {boolean}
 */
export function isLightInk(hex) {
  const rgb = paintToRgb(hex);
  if (!rgb) return false;
  return relativeLuminance(rgb) > WCAG_CONTRAST_PIVOT;
}

/**
 * Generate an inverse variant by luminance inversion — **only** when the logo is
 * monochrome (§7). Anything else returns null, and the source logo carries
 * `needsInverseAsset: true` so the studio can ask for the real reversed asset
 * instead of shipping a machine-recoloured one into a client meeting.
 *
 * The generated asset's id is content-derived (`contentId`), so regenerating it
 * from the same logo produces the same id — no minter, no clock, no drift (§5).
 *
 * @param {object} logo   a §4 LogoAsset, optionally carrying this module's extensions
 * @returns {object|null}
 */
export function inverseVariant(logo) {
  if (!logo || typeof logo.data !== 'string') return null;
  if (logo.variant === 'inverse') return null;
  const verdict = logo.monochrome === undefined ? monochromeOf(logo) : {
    monochrome: logo.monochrome, kind: logo.monochromeKind ?? null,
    inkHex: logo.inkHex ?? null, reason: logo.monochromeReason ?? '', colors: [],
  };
  if (!verdict.monochrome) return null;

  if (logo.kind === 'svg') {
    const data = invertSvgPaints(logo.data);
    if (data === null) return null;
    return {
      id: contentId('logo', { inverseOf: logo.id, data }),
      kind: 'svg',
      data,
      variant: 'inverse',
      intrinsic: { ...logo.intrinsic },
      hasTransparency: logo.hasTransparency,
      source: 'generated-inverse',
      generatedFrom: logo.id,
      monochrome: true,
      monochromeKind: verdict.kind,
      inkHex: verdict.inkHex ? invertInk(verdict.inkHex) : null,
      monochromeReason: verdict.reason,
      needsInverseAsset: false,
      alt: logo.alt ?? null,
    };
  }

  const parsed = parseLogoDataUri(logo.data);
  if (!parsed || sniffFormat(parsed.bytes) !== 'png') return null;
  let decoded;
  try { decoded = decodePng(parsed.bytes); } catch { return null; }
  const inverted = invertPixels(decoded);
  const bytes = encodePng(inverted);
  const data = dataUri(bytes, FORMAT_MIME.png);
  return {
    id: contentId('logo', { inverseOf: logo.id, data }),
    kind: 'raster',
    data,
    variant: 'inverse',
    intrinsic: { ...logo.intrinsic },
    hasTransparency: alphaUsed(inverted),
    source: 'generated-inverse',
    format: 'png',
    mime: FORMAT_MIME.png,
    generatedFrom: logo.id,
    monochrome: true,
    monochromeKind: verdict.kind,
    inkHex: verdict.inkHex ? invertInk(verdict.inkHex) : null,
    monochromeReason: verdict.reason,
    needsInverseAsset: false,
    alt: logo.alt ?? null,
  };
}

/**
 * Rewrite every resolvable paint in an SVG through `invertInk`. Returns null
 * when a paint cannot be resolved, which cannot happen for a mark
 * `svgMonochrome` has already approved but is checked again rather than assumed.
 * @param {string} markup
 * @returns {string|null}
 */
export function invertSvgPaints(markup) {
  const src = String(markup || '');
  let failed = false;
  /** @param {string} value @returns {string} */
  const map = (value) => {
    const v = value.trim();
    const lower = v.toLowerCase();
    if (!v || lower === 'none' || lower === 'transparent' || lower === 'currentcolor' || lower === 'inherit') return v;
    const rgb = paintToRgb(v);
    if (!rgb) { failed = true; return v; }
    return invertInk(rgbToHexLocal(rgb));
  };

  let out = src.replace(
    /\b(fill|stroke|stop-color|flood-color|lighting-color)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi,
    (whole, prop, dq, sq) => `${prop}="${map(dq ?? sq ?? '')}"`,
  );
  out = out.replace(
    /\b(fill|stroke|stop-color|color|background-color)\s*:\s*([^;"'}]+)/gi,
    (whole, prop, value) => `${prop}:${map(value)}`,
  );
  if (failed) return null;
  // An SVG with no explicit paint is black by SVG's initial value; the inverse
  // has to state the white explicitly or it would come back black.
  if (!/\b(fill|stroke)\s*[=:]/i.test(src)) {
    const attrs = svgRootAttrs(src);
    if (!attrs.fill) out = out.replace(/<svg\b/i, `<svg fill="${invertInk('#000000')}"`);
  }
  return out;
}

/**
 * Invert every opaque pixel through `invertInk`, preserving alpha. Colours are
 * memoised, so a two-colour mark costs two conversions rather than a million.
 * @param {DecodedImage} image
 * @returns {DecodedImage}
 */
export function invertPixels(image) {
  const src = image.data;
  const out = new Uint8Array(src.length);
  /** @type {Map<number, [number, number, number]>} */
  const cache = new Map();
  for (let i = 0; i < src.length; i += 4) {
    const key = (src[i] << 16) | (src[i + 1] << 8) | src[i + 2];
    let rgb = cache.get(key);
    if (!rgb) {
      const hex = invertInk(rgbToHexLocal([src[i], src[i + 1], src[i + 2]]));
      rgb = paintToRgb(hex) || [255 - src[i], 255 - src[i + 1], 255 - src[i + 2]];
      cache.set(key, rgb);
    }
    out[i] = rgb[0];
    out[i + 1] = rgb[1];
    out[i + 2] = rgb[2];
    out[i + 3] = src[i + 3];
  }
  return { width: image.width, height: image.height, data: out };
}

// ---------------------------------------------------------------- confidence

/**
 * Confidence in the extracted logo set (§7: sample size, agreement across
 * sources, never hardcoded).
 *
 *   evidence  — the best source tier found, from `SOURCE_RANK`. An inline SVG
 *               is the mark; an og:image is a social card that might be a
 *               photograph.
 *   agreement — a schema.org declaration naming the asset, or failing that,
 *               whether a second independent source produced a mark of the same
 *               proportions. Two sources agreeing on the aspect ratio is the
 *               strongest signal available when the site declares nothing.
 *   read      — the share of logos whose transparency was read from the pixels
 *               rather than inferred from a header, because an unverified
 *               transparency flag is the field most likely to be wrong.
 *
 * @param {object[]} logos
 * @returns {number}
 */
export function logosConfidence(logos) {
  if (!logos || logos.length === 0) return 0;

  /** @type {Set<string>} */
  const sources = new Set();
  let best = 0;
  let declared = false;
  for (const l of logos) {
    for (const source of (l.sources && l.sources.length ? l.sources : [l.source])) {
      sources.add(source);
      best = Math.max(best, SOURCE_RANK[source] ?? 0.4);
    }
    if (l.declared) declared = true;
  }

  const aspects = logos
    .filter((l) => l.intrinsic && l.intrinsic.h > 0 && l.variant !== 'favicon')
    .map((l) => l.intrinsic.w / l.intrinsic.h);
  let agreement = 0;
  // A schema.org declaration is not corroboration, it is the site saying which
  // asset is its logo — nothing else available without a human is stronger.
  if (declared) agreement = 1;
  else if (sources.size >= 2) {
    agreement = 0.5;
    for (let i = 0; i < aspects.length && agreement < 1; i++) {
      for (let j = i + 1; j < aspects.length; j++) {
        if (Math.abs(aspects[i] - aspects[j]) / Math.max(aspects[i], aspects[j]) <= 0.1) { agreement = 1; break; }
      }
    }
  }
  const checked = logos.filter((l) => l.transparencyChecked).length / logos.length;

  const score = 0.55 * best + 0.25 * agreement + 0.2 * checked;
  return round6(Math.max(0, Math.min(1, score)));
}

/** @param {number} n @returns {number} */
function round3(n) { return Math.round(n * 1000) / 1000; }
/** @param {number} n @returns {number} */
function round6(n) { return Math.round(n * 1e6) / 1e6; }
