/**
 * The `RawCapture` shape and the small services every strategy shares: URL
 * resolution, MIME sniffing, intrinsic image size, and page metadata.
 *
 * Capture hygiene (§6) is enforced here rather than in each importer: nothing
 * builds a capture without a `capturedAt`, and `capturedAt` comes from the
 * injected clock, never from a wall-clock read (§5).
 *
 * @module ingest/capture
 */

import { base64Encode } from '../core/bytes.js';
import { parseHtml, textContent, attr, firstElement, walk } from './html-parse.js';
import { querySelectorAll } from './select.js';

/**
 * @typedef {import('./html-parse.js').DocNode} DocNode
 */

/**
 * @typedef {object} CaptureAsset
 * @property {string} name    the reference by which the document points at it
 * @property {Uint8Array} bytes
 * @property {string} mime
 * @property {string[]} [aliases]  other references that resolve to this asset
 */

/**
 * @typedef {object} RawCapture
 * @property {'html'|'document'|'image'} kind
 * @property {string|null} sourceUrl
 * @property {string} capturedAt
 * @property {string|null} html
 * @property {DocNode|null} doc
 * @property {import('../core/contracts.js').ContentBlock[]|null} blocks
 * @property {CaptureAsset[]} assets
 * @property {Record<string,string>} meta
 * @property {string} strategy
 */

/** Thrown when a lane forgets to inject the clock. Loud, and only ever once. */
export class ClockRequiredError extends Error {}

/**
 * Read the injected clock. §5: no lane calls `Date.now()`; the clock is a
 * parameter so a test can pin capture time and two runs agree.
 * @param {{clock?: () => string}} deps
 * @returns {string}
 */
export function now(deps) {
  const clock = deps && deps.clock;
  if (typeof clock !== 'function') {
    throw new ClockRequiredError('ingest: a clock must be injected — capturedAt may never come from a wall-clock read (§5)');
  }
  const value = clock();
  if (typeof value !== 'string' || !value) {
    throw new ClockRequiredError('ingest: the injected clock must return an ISO 8601 string');
  }
  return value;
}

/**
 * Build a `RawCapture` with every field present, so no consumer has to guard.
 * @param {Partial<RawCapture> & {capturedAt: string, strategy: string}} parts
 * @returns {RawCapture}
 */
export function makeCapture(parts) {
  return {
    kind: parts.kind || 'html',
    sourceUrl: parts.sourceUrl === undefined ? null : parts.sourceUrl,
    capturedAt: parts.capturedAt,
    html: parts.html === undefined ? null : parts.html,
    doc: parts.doc === undefined ? null : parts.doc,
    blocks: parts.blocks === undefined ? null : parts.blocks,
    assets: parts.assets || [],
    meta: parts.meta || {},
    strategy: parts.strategy,
  };
}

/**
 * Build an HTML capture from source text: parse once, read metadata once.
 * @param {string} html
 * @param {{sourceUrl?: string|null, capturedAt: string, strategy: string, assets?: CaptureAsset[], meta?: Record<string,string>}} options
 * @returns {RawCapture}
 */
export function htmlCapture(html, options) {
  const doc = parseHtml(html);
  const meta = { ...documentMeta(doc, options.sourceUrl || null), ...(options.meta || {}) };
  return makeCapture({
    kind: 'html',
    sourceUrl: options.sourceUrl === undefined ? null : options.sourceUrl,
    capturedAt: options.capturedAt,
    html,
    doc,
    blocks: null,
    assets: options.assets || [],
    meta,
    strategy: options.strategy,
  });
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

/** `<meta name=…>` values worth keeping. Everything `og:` and `twitter:` is kept. */
const NAMED_META = new Set([
  'description', 'keywords', 'author', 'robots', 'viewport', 'generator',
  'application-name', 'theme-color', 'referrer', 'rating',
]);

/**
 * Page metadata: title, description, canonical, lang, `og:*`, `twitter:*`,
 * declared alternates. These drive locale scenarios (§8) and the specimen
 * title, so they are read from the tree rather than regexed out of the source.
 *
 * @param {DocNode} doc
 * @param {string|null} [sourceUrl]
 * @returns {Record<string,string>}
 */
export function documentMeta(doc, sourceUrl = null) {
  /** @type {Record<string,string>} */
  const meta = {};
  if (!doc) return meta;

  const html = firstElement(doc, 'html');
  const lang = html ? attr(html, 'lang') : null;
  if (lang) meta.lang = lang.trim();
  const dir = html ? attr(html, 'dir') : null;
  if (dir) meta.dir = dir.trim();

  const title = firstElement(doc, 'title');
  if (title) {
    const t = textContent(title).replace(/\s+/g, ' ').trim();
    if (t) meta.title = t;
  }

  for (const node of querySelectorAll(doc, 'meta')) {
    const charset = attr(node, 'charset');
    if (charset) meta.charset = charset.trim().toLowerCase();
    const httpEquiv = (attr(node, 'http-equiv') || '').toLowerCase();
    const content = attr(node, 'content');
    if (httpEquiv === 'content-type' && content) {
      const m = content.match(/charset=([\w-]+)/i);
      if (m && !meta.charset) meta.charset = m[1].toLowerCase();
    }
    if (httpEquiv === 'content-language' && content && !meta.lang) meta.lang = content.trim();
    const name = (attr(node, 'name') || '').toLowerCase();
    const property = (attr(node, 'property') || '').toLowerCase();
    const key = property || name;
    if (!key || content === null) continue;
    const value = content.replace(/\s+/g, ' ').trim();
    if (!value) continue;
    if (key.startsWith('og:') || key.startsWith('twitter:') || key.startsWith('article:') || key.startsWith('product:')) {
      if (!(key in meta)) meta[key] = value;
      continue;
    }
    if (NAMED_META.has(key) && !(key in meta)) meta[key] = value;
  }

  for (const link of querySelectorAll(doc, 'link')) {
    const rel = (attr(link, 'rel') || '').toLowerCase().split(/\s+/);
    const href = attr(link, 'href');
    if (!href) continue;
    if (rel.includes('canonical') && !meta.canonical) meta.canonical = resolveUrl(sourceUrl, href) || href;
    if (rel.includes('alternate')) {
      const hreflang = attr(link, 'hreflang');
      if (hreflang) meta[`hreflang.${hreflang.toLowerCase()}`] = resolveUrl(sourceUrl, href) || href;
    }
    if (rel.includes('amphtml') && !meta.amphtml) meta.amphtml = resolveUrl(sourceUrl, href) || href;
  }

  if (!meta.title) {
    const h1 = firstElement(doc, 'h1');
    if (h1) {
      const t = textContent(h1).replace(/\s+/g, ' ').trim();
      if (t) meta.title = t;
    }
  }
  if (!meta.description && meta['og:description']) meta.description = meta['og:description'];
  if (sourceUrl) meta.sourceUrl = sourceUrl;
  return meta;
}

/**
 * Every URL the document points at, by attribute, resolved against the base.
 * Saved-page and HAR imports use it to decide which assets matter.
 * @param {DocNode} doc
 * @param {string|null} [base]
 * @returns {{node: DocNode, attribute: string, raw: string, url: string|null}[]}
 */
export function documentReferences(doc, base = null) {
  /** @type {{node: DocNode, attribute: string, raw: string, url: string|null}[]} */
  const out = [];
  if (!doc) return out;
  const ATTRS = ['src', 'href', 'poster', 'data-src', 'data-lazy-src', 'srcset', 'data-srcset', 'content'];
  walk(doc, (node) => {
    if (node.type !== 'element' || !node.attrs) return undefined;
    for (const a of ATTRS) {
      const raw = node.attrs[a];
      if (!raw) continue;
      if (a === 'content') {
        const property = (node.attrs.property || node.attrs.name || '').toLowerCase();
        if (!/image|url|logo/.test(property)) continue;
      }
      if (a === 'srcset' || a === 'data-srcset') {
        for (const candidate of raw.split(',')) {
          const url = candidate.trim().split(/\s+/)[0];
          if (url) out.push({ node, attribute: a, raw: url, url: resolveUrl(base, url) });
        }
        continue;
      }
      out.push({ node, attribute: a, raw, url: resolveUrl(base, raw) });
    }
    return undefined;
  });
  return out;
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/**
 * Resolve a reference against a base, returning null rather than throwing —
 * a malformed `src` on a prospect's page is data, not an exception.
 * @param {string|null|undefined} base
 * @param {string} ref
 * @returns {string|null}
 */
export function resolveUrl(base, ref) {
  const r = String(ref == null ? '' : ref).trim();
  if (!r) return null;
  if (/^(data|blob|javascript|mailto|tel|about):/i.test(r)) return r;
  try {
    return base ? new URL(r, base).href : new URL(r).href;
  } catch {
    return null;
  }
}

/**
 * The scheme+host of a URL, or null.
 * @param {string} url
 * @returns {string|null}
 */
export function originOf(url) {
  try { return new URL(String(url)).origin; } catch { return null; }
}

/**
 * The path of a URL, with the query and fragment removed.
 * @param {string} url
 * @returns {string}
 */
export function pathOf(url) {
  try { return new URL(String(url)).pathname; } catch { return String(url).split(/[?#]/)[0]; }
}

/**
 * Normalize a reference so a document's `src` and a saved asset's filename can
 * be matched: percent-decoded where safe, query and fragment dropped, leading
 * `./` removed, backslashes turned into slashes.
 * @param {string} ref
 * @returns {string}
 */
export function normalizeAssetRef(ref) {
  let s = String(ref == null ? '' : ref).trim().split('#')[0];
  s = s.replace(/\\/g, '/');
  try { s = decodeURI(s); } catch { /* leave as-is when the escape sequence is broken */ }
  s = s.replace(/^\.\//, '');
  return s;
}

// ---------------------------------------------------------------------------
// Bytes
// ---------------------------------------------------------------------------

/** Extension → MIME, for the file types ingest actually accepts. */
const EXT_MIME = new Map(Object.entries({
  html: 'text/html', htm: 'text/html', xhtml: 'application/xhtml+xml',
  css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json',
  xml: 'application/xml', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', ico: 'image/x-icon',
  bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  har: 'application/json', mhtml: 'multipart/related', mht: 'multipart/related',
  zip: 'application/zip',
}));

/**
 * @param {string} name
 * @returns {string}
 */
export function mimeForName(name) {
  const clean = String(name || '').split(/[?#]/)[0];
  const ext = (clean.split('.').pop() || '').toLowerCase();
  return EXT_MIME.get(ext) || 'application/octet-stream';
}

/**
 * Identify a byte buffer by its magic number, falling back to the filename.
 * A user who renames a `.jpg` to `.png` should still get a working import.
 * @param {Uint8Array} bytes
 * @param {string} [name]
 * @returns {string}
 */
export function sniffMime(bytes, name = '') {
  if (bytes && bytes.length >= 4) {
    const b = bytes;
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
    if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
    if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf';
    if (b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5 || b[2] === 7)) {
      const byName = mimeForName(name);
      return byName.includes('officedocument') ? byName : 'application/zip';
    }
    if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
    if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
      const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
      if (brand === 'avif' || brand === 'avis') return 'image/avif';
    }
    if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) return 'image/x-icon';
    if (b[0] === 0x77 && b[1] === 0x4f && b[2] === 0x46 && b[3] === 0x46) return 'font/woff';
    if (b[0] === 0x77 && b[1] === 0x4f && b[2] === 0x46 && b[3] === 0x32) return 'font/woff2';
    const head = asciiHead(bytes, 512).trimStart();
    if (/^<\?xml/i.test(head) && /<svg[\s>]/i.test(head)) return 'image/svg+xml';
    if (/^<svg[\s>]/i.test(head)) return 'image/svg+xml';
    if (/^(<!doctype html|<html[\s>]|<head[\s>]|<body[\s>])/i.test(head)) return 'text/html';
  }
  return mimeForName(name);
}

/**
 * The first `n` bytes decoded as Latin-1, for sniffing only.
 * @param {Uint8Array} bytes
 * @param {number} n
 * @returns {string}
 */
export function asciiHead(bytes, n) {
  const len = Math.min(bytes.length, n);
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/**
 * A `data:` URI for a byte buffer. §8 inlines every asset by emit time; this is
 * the encoder both the specimen capture and the PDF image extractor use.
 * @param {Uint8Array} bytes
 * @param {string} mime
 * @returns {string}
 */
export function toDataUri(bytes, mime) {
  return `data:${mime || 'application/octet-stream'};base64,${base64Encode(bytes)}`;
}

/**
 * Intrinsic pixel dimensions from the encoded bytes, without a decoder and
 * without a browser. Returns null when the format is not one we can measure.
 * @param {Uint8Array} bytes
 * @param {string} [mime]
 * @returns {{w: number, h: number}|null}
 */
export function imageSize(bytes, mime = '') {
  if (!bytes || bytes.length < 8) return null;
  const kind = mime || sniffMime(bytes);
  const be32 = (o) => (bytes[o] << 24 | bytes[o + 1] << 16 | bytes[o + 2] << 8 | bytes[o + 3]) >>> 0;
  const le16 = (o) => bytes[o] | (bytes[o + 1] << 8);
  const le32 = (o) => (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0;

  if (kind === 'image/png') {
    if (bytes.length < 24) return null;
    return { w: be32(16), h: be32(20) };
  }
  if (kind === 'image/gif') {
    return { w: le16(6), h: le16(8) };
  }
  if (kind === 'image/bmp') {
    if (bytes.length < 26) return null;
    return { w: le32(18) | 0, h: Math.abs(le32(22) | 0) };
  }
  if (kind === 'image/jpeg') {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) { i += 1; continue; }
      const marker = bytes[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const length = (bytes[i + 2] << 8) | bytes[i + 3];
      const isSof = (marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { h: (bytes[i + 5] << 8) | bytes[i + 6], w: (bytes[i + 7] << 8) | bytes[i + 8] };
      if (length <= 0) return null;
      i += 2 + length;
    }
    return null;
  }
  if (kind === 'image/webp') {
    if (bytes.length < 30) return null;
    const fourcc = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    if (fourcc === 'VP8 ') return { w: le16(26) & 0x3fff, h: le16(28) & 0x3fff };
    if (fourcc === 'VP8L') {
      const b0 = bytes[21], b1 = bytes[22], b2 = bytes[23], b3 = bytes[24];
      const w = 1 + (((b1 & 0x3f) << 8) | b0);
      const h = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
      return { w, h };
    }
    if (fourcc === 'VP8X') {
      const w = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
      const h = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
      return { w, h };
    }
    return null;
  }
  if (kind === 'image/svg+xml') {
    const head = asciiHead(bytes, 4096);
    const tag = head.match(/<svg\b[^>]*>/i);
    if (!tag) return null;
    const num = (name) => {
      const m = tag[0].match(new RegExp(`${name}\\s*=\\s*["']?\\s*([0-9.]+)`, 'i'));
      return m ? Number(m[1]) : null;
    };
    const w = num('width');
    const h = num('height');
    if (w && h) return { w: Math.round(w), h: Math.round(h) };
    const vb = tag[0].match(/viewBox\s*=\s*["']([^"']+)["']/i);
    if (vb) {
      const parts = vb[1].trim().split(/[\s,]+/).map(Number);
      if (parts.length === 4 && parts.every((x) => Number.isFinite(x))) {
        return { w: Math.round(parts[2]), h: Math.round(parts[3]) };
      }
    }
    return null;
  }
  return null;
}
