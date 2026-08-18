/**
 * Strategy 3c (§6) — MHTML / MIME web archive import.
 *
 * Chrome and Edge write `.mhtml` from "Save page as → Single file", and it is
 * the one saved format that survives being emailed around a prospect's org
 * before it reaches the seller. One file, every asset inside it, no folder to
 * lose.
 *
 * This is a real MIME reader — headers, `multipart/related` boundaries,
 * `Content-Transfer-Encoding` of base64 / quoted-printable / 7bit / 8bit /
 * binary, per-part charsets — because MHTML written by different browsers
 * differs in every one of those dimensions.
 *
 * @module ingest/mhtml
 */

import { ok, err } from '../core/result.js';
import { base64Decode } from '../core/bytes.js';
import { htmlCapture, now, sniffMime, normalizeAssetRef } from './capture.js';

/**
 * @typedef {import('./capture.js').RawCapture} RawCapture
 * @typedef {{headers: Map<string,string>, body: string}} MimePart
 */

/**
 * Split a header block into a case-insensitive map, unfolding continuation
 * lines as RFC 5322 requires.
 * @param {string} block
 * @returns {Map<string,string>}
 */
export function parseHeaders(block) {
  /** @type {Map<string,string>} */
  const headers = new Map();
  const lines = String(block || '').split(/\r?\n/);
  /** @type {string[]} */
  const unfolded = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && unfolded.length) unfolded[unfolded.length - 1] += ` ${line.trim()}`;
    else unfolded.push(line);
  }
  for (const line of unfolded) {
    const at = line.indexOf(':');
    if (at < 0) continue;
    const name = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();
    if (name && !headers.has(name)) headers.set(name, value);
  }
  return headers;
}

/**
 * Read a parameter out of a structured header value (`; boundary="x"`).
 * @param {string} value
 * @param {string} name
 * @returns {string|null}
 */
export function headerParam(value, name) {
  if (!value) return null;
  const re = new RegExp(`;\\s*${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^;\\s]+))`, 'i');
  const m = String(value).match(re);
  if (!m) return null;
  return m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
}

/**
 * Decode a quoted-printable body to bytes.
 * @param {string} body
 * @returns {Uint8Array}
 */
export function decodeQuotedPrintable(body) {
  const s = String(body).replace(/=\r?\n/g, '');
  /** @type {number[]} */
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '=' && i + 2 < s.length && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 1, i + 3))) {
      out.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
      continue;
    }
    const cp = s.codePointAt(i) || 0;
    if (cp < 0x100) { out.push(cp); continue; }
    // A part declared 8bit but carrying real Unicode: re-encode it.
    for (const b of new TextEncoder().encode(String.fromCodePoint(cp))) out.push(b);
    if (cp > 0xffff) i += 1;
  }
  return new Uint8Array(out);
}

/**
 * Interpret a raw part body as bytes.
 * @param {string} body
 * @param {string} encoding
 * @returns {Uint8Array}
 */
export function decodePartBytes(body, encoding) {
  const enc = String(encoding || '').trim().toLowerCase();
  if (enc === 'base64') {
    try { return base64Decode(body); } catch { return new Uint8Array(0); }
  }
  if (enc === 'quoted-printable') return decodeQuotedPrintable(body);
  // 7bit / 8bit / binary / absent: the characters are the bytes.
  const out = new Uint8Array(body.length);
  let n = 0;
  for (let i = 0; i < body.length; i++) {
    const cp = body.codePointAt(i) || 0;
    if (cp < 0x100) { out[n++] = cp; continue; }
    const encoded = new TextEncoder().encode(String.fromCodePoint(cp));
    if (n + encoded.length > out.length) break;
    for (const b of encoded) out[n++] = b;
    if (cp > 0xffff) i += 1;
  }
  return out.subarray(0, n);
}

/**
 * Decode bytes with a declared charset, falling back to UTF-8.
 * @param {Uint8Array} bytes
 * @param {string|null} charset
 * @returns {string}
 */
export function decodeWithCharset(bytes, charset) {
  const label = (charset || 'utf-8').toLowerCase();
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    try { return new TextDecoder('utf-8').decode(bytes); } catch { return ''; }
  }
}

/**
 * Split a multipart body on its boundary.
 * @param {string} body
 * @param {string} boundary
 * @returns {string[]}
 */
function splitParts(body, boundary) {
  const marker = `--${boundary}`;
  /** @type {string[]} */
  const parts = [];
  let i = body.indexOf(marker);
  if (i < 0) return parts;
  while (i >= 0) {
    const afterMarker = i + marker.length;
    if (body.startsWith('--', afterMarker)) break;   // closing delimiter
    const start = skipEol(body, afterMarker);
    const next = body.indexOf(marker, start);
    const end = next < 0 ? body.length : next;
    parts.push(trimTrailingEol(body.slice(start, end)));
    if (next < 0) break;
    i = next;
  }
  return parts;
}

/**
 * @param {string} s @param {number} i @returns {number}
 */
function skipEol(s, i) {
  if (s[i] === '\r' && s[i + 1] === '\n') return i + 2;
  if (s[i] === '\n') return i + 1;
  return i;
}

/**
 * @param {string} s @returns {string}
 */
function trimTrailingEol(s) { return s.replace(/\r?\n$/, ''); }

/**
 * Split one part into headers and body.
 * @param {string} part
 * @returns {MimePart}
 */
function splitPart(part) {
  const blank = part.search(/\r?\n\r?\n/);
  if (blank < 0) return { headers: parseHeaders(part), body: '' };
  const headerBlock = part.slice(0, blank);
  const body = part.slice(blank).replace(/^\r?\n\r?\n/, '');
  return { headers: parseHeaders(headerBlock), body };
}

/**
 * Import an MHTML archive.
 *
 * @param {string} text
 * @param {{clock: () => string}} deps
 * @returns {import('../core/result.js').Result<RawCapture[]>}
 */
export function importMhtml(text, deps = /** @type {any} */ ({})) {
  let capturedAt;
  try { capturedAt = now(deps); } catch (e) { return err(e instanceof Error ? e.message : String(e)); }

  const source = String(text || '');
  if (!source.trim()) return err('That archive is empty.');

  const top = splitPart(source);
  const contentType = top.headers.get('content-type') || '';
  const boundary = headerParam(contentType, 'boundary');
  const snapshotLocation = top.headers.get('snapshot-content-location')
    || top.headers.get('content-location')
    || null;
  const subject = top.headers.get('subject') || null;

  /** @type {MimePart[]} */
  let parts;
  if (boundary) {
    parts = splitParts(top.body, boundary).map(splitPart);
  } else if (/^text\/html/i.test(contentType)) {
    parts = [top];
  } else {
    return err('That file is not a MIME web archive — no multipart boundary and no HTML part. Save the page again with "Webpage, Single File".');
  }
  if (!parts.length) return err('That archive declares a boundary but contains no parts.');

  const start = headerParam(contentType, 'start');
  /** @type {RawCapture[]} */
  const captures = [];
  /** @type {import('./capture.js').CaptureAsset[]} */
  const assets = [];
  /** @type {{part: MimePart, location: string|null, mime: string, text: string}[]} */
  const htmlParts = [];

  for (const part of parts) {
    const partType = part.headers.get('content-type') || '';
    const mime = partType.split(';')[0].trim().toLowerCase() || 'application/octet-stream';
    const encoding = part.headers.get('content-transfer-encoding') || '';
    const location = part.headers.get('content-location') || null;
    const contentId = part.headers.get('content-id') || null;
    const bytes = decodePartBytes(part.body, encoding);

    if (mime === 'text/html' || mime === 'application/xhtml+xml') {
      const charset = headerParam(partType, 'charset');
      htmlParts.push({ part, location, mime, text: decodeWithCharset(bytes, charset) });
      continue;
    }
    if (!bytes.length) continue;
    const name = location ? normalizeAssetRef(location) : (contentId || `part-${assets.length + 1}`);
    assets.push({
      name,
      bytes,
      mime: mime === 'application/octet-stream' ? sniffMime(bytes, name) : mime,
      aliases: dedupe([location || '', contentId || '', lastSegment(name)]).filter((a) => a && a !== name),
    });
  }

  if (!htmlParts.length) return err('That archive contains no HTML part, so there is no page to capture.');

  // The `start` parameter, then the snapshot location, then the first part.
  let mainIndex = 0;
  if (start) {
    const found = htmlParts.findIndex((p) => {
      const id = p.part.headers.get('content-id') || '';
      return id === start || id === `<${start}>` || `<${id}>` === start;
    });
    if (found >= 0) mainIndex = found;
  }
  if (snapshotLocation) {
    const found = htmlParts.findIndex((p) => p.location === snapshotLocation);
    if (found >= 0) mainIndex = found;
  }

  htmlParts.forEach((page, index) => {
    const capture = htmlCapture(page.text, {
      sourceUrl: page.location || (index === mainIndex ? snapshotLocation : null),
      capturedAt,
      strategy: 'mhtml',
      meta: {
        'mhtml.part': String(index + 1),
        'mhtml.main': String(index === mainIndex),
      },
    });
    if (subject && !capture.meta.title) capture.meta.title = subject;
    if (index === mainIndex) {
      capture.assets = assets;
      capture.meta['mhtml.assets'] = String(assets.length);
    }
    captures.push(capture);
  });

  // The main document first: a consumer that takes `[0]` gets the page, not a
  // tracking iframe that happened to be serialised earlier.
  if (mainIndex !== 0) {
    const [main] = captures.splice(mainIndex, 1);
    captures.unshift(main);
  }
  return ok(captures);
}

/**
 * @param {string} name @returns {string}
 */
function lastSegment(name) {
  const parts = String(name).split('/');
  return parts[parts.length - 1] || name;
}

/**
 * @template T
 * @param {T[]} items
 * @returns {T[]}
 */
function dedupe(items) { return Array.from(new Set(items)); }
