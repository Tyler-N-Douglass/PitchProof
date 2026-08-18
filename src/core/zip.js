/**
 * A ZIP reader, and the OOXML container reader built on it (§6.5).
 *
 * `.docx` and `.pptx` are ZIP archives of XML parts. Reading them needs exactly
 * two things: the central directory, and raw DEFLATE — both of which this repo
 * already owns, so importing a deck costs no dependency and works identically
 * in Node and the browser.
 *
 * Reading only. PitchProof never writes an OOXML file.
 *
 * @module core/zip
 */

import { inflateRaw } from './inflate.js';
import { utf8Decode } from './bytes.js';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;

/**
 * @typedef {object} ZipEntry
 * @property {string} name
 * @property {number} method            0 stored, 8 deflate
 * @property {number} compressedSize
 * @property {number} uncompressedSize
 * @property {number} crc32
 * @property {number} localHeaderOffset
 * @property {boolean} isDirectory
 * @property {boolean} utf8             name was flagged UTF-8
 */

/**
 * @param {Uint8Array} b @param {number} o @returns {number}
 */
function u16(b, o) { return b[o] | (b[o + 1] << 8); }
/**
 * @param {Uint8Array} b @param {number} o @returns {number}
 */
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000; }
/**
 * @param {Uint8Array} b @param {number} o @returns {number}
 */
function u64(b, o) { return u32(b, o) + u32(b, o + 4) * 0x100000000; }

/** CRC-32 table, built once. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/**
 * CRC-32 of a byte range, used to verify every extracted entry. A corrupt
 * import that silently produces half a document is worse than a refused one.
 * @param {Uint8Array} data
 * @returns {number}
 */
export function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Parse an archive's central directory.
 * @param {Uint8Array} bytes
 * @returns {ZipEntry[]}
 */
export function readCentralDirectory(bytes) {
  const eocd = findEocd(bytes);
  if (eocd < 0) throw new Error('zip: end-of-central-directory record not found');

  let count = u16(bytes, eocd + 10);
  let cdOffset = u32(bytes, eocd + 16);
  let cdSize = u32(bytes, eocd + 12);

  // ZIP64: the 32-bit fields saturate and the real values live in the ZIP64
  // record the locator points at.
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    const locator = eocd - 20;
    if (locator >= 0 && u32(bytes, locator) === SIG_EOCD64_LOCATOR) {
      const z64 = u64(bytes, locator + 8);
      if (z64 >= 0 && z64 + 56 <= bytes.length && u32(bytes, z64) === SIG_EOCD64) {
        count = u64(bytes, z64 + 32);
        cdSize = u64(bytes, z64 + 40);
        cdOffset = u64(bytes, z64 + 48);
      }
    }
  }

  /** @type {ZipEntry[]} */
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || u32(bytes, p) !== SIG_CENTRAL) break;
    const flags = u16(bytes, p + 8);
    const method = u16(bytes, p + 10);
    const crc = u32(bytes, p + 16);
    let compressedSize = u32(bytes, p + 20);
    let uncompressedSize = u32(bytes, p + 24);
    const nameLen = u16(bytes, p + 28);
    const extraLen = u16(bytes, p + 30);
    const commentLen = u16(bytes, p + 32);
    let localOffset = u32(bytes, p + 42);
    const nameBytes = bytes.subarray(p + 46, p + 46 + nameLen);
    const name = utf8Decode(nameBytes);

    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      let e = p + 46 + nameLen;
      const end = e + extraLen;
      while (e + 4 <= end) {
        const hid = u16(bytes, e);
        const hsz = u16(bytes, e + 2);
        if (hid === 0x0001) {
          let q = e + 4;
          if (uncompressedSize === 0xffffffff) { uncompressedSize = u64(bytes, q); q += 8; }
          if (compressedSize === 0xffffffff) { compressedSize = u64(bytes, q); q += 8; }
          if (localOffset === 0xffffffff) { localOffset = u64(bytes, q); q += 8; }
          break;
        }
        e += 4 + hsz;
      }
    }

    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      crc32: crc,
      localHeaderOffset: localOffset,
      isDirectory: name.endsWith('/'),
      utf8: (flags & 0x0800) !== 0,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Scan backwards for the EOCD signature, tolerating a trailing comment.
 * @param {Uint8Array} bytes
 * @returns {number}
 */
function findEocd(bytes) {
  const min = Math.max(0, bytes.length - 0xffff - 22);
  for (let i = bytes.length - 22; i >= min; i--) {
    if (u32(bytes, i) === SIG_EOCD) return i;
  }
  return -1;
}

/**
 * Extract one entry's bytes.
 * @param {Uint8Array} bytes
 * @param {ZipEntry} entry
 * @returns {Uint8Array}
 */
export function readEntry(bytes, entry) {
  const p = entry.localHeaderOffset;
  if (u32(bytes, p) !== SIG_LOCAL) throw new Error(`zip: bad local header for ${entry.name}`);
  const nameLen = u16(bytes, p + 26);
  const extraLen = u16(bytes, p + 28);
  const start = p + 30 + nameLen + extraLen;
  const raw = bytes.subarray(start, start + entry.compressedSize);

  let out;
  if (entry.method === 0) out = raw.slice();
  else if (entry.method === 8) out = inflateRaw(raw, entry.uncompressedSize);
  else throw new Error(`zip: unsupported compression method ${entry.method} for ${entry.name}`);

  if (entry.uncompressedSize && out.length !== entry.uncompressedSize) {
    throw new Error(`zip: ${entry.name} inflated to ${out.length} bytes, expected ${entry.uncompressedSize}`);
  }
  if (entry.crc32 !== 0 && crc32(out) !== entry.crc32) {
    throw new Error(`zip: CRC mismatch for ${entry.name}`);
  }
  return out;
}

/** A read-only view over a ZIP archive held in memory. */
export class ZipArchive {
  /** @param {Uint8Array} bytes */
  constructor(bytes) {
    this.bytes = bytes;
    /** @type {ZipEntry[]} */
    this.entries = readCentralDirectory(bytes);
    /** @type {Map<string, ZipEntry>} */
    this.index = new Map(this.entries.map((e) => [e.name, e]));
  }

  /** @param {string} name @returns {boolean} */
  has(name) { return this.index.has(name); }

  /** @param {string} name @returns {Uint8Array|null} */
  bytesOf(name) {
    const e = this.index.get(name);
    return e ? readEntry(this.bytes, e) : null;
  }

  /** @param {string} name @returns {string|null} */
  textOf(name) {
    const b = this.bytesOf(name);
    return b ? utf8Decode(b) : null;
  }

  /**
   * Every entry whose name matches a predicate, in central-directory order.
   * @param {(name: string) => boolean} pred
   * @returns {ZipEntry[]}
   */
  match(pred) { return this.entries.filter((e) => !e.isDirectory && pred(e.name)); }
}

// ---------------------------------------------------------------------------
// OOXML
// ---------------------------------------------------------------------------

/**
 * MIME type for a media part, from its extension. OOXML stores images with
 * ordinary extensions inside `word/media/` and `ppt/media/`.
 * @param {string} name
 * @returns {string}
 */
export function mimeForPart(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  switch (ext) {
    case 'png': return 'image/png';
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'svg': return 'image/svg+xml';
    case 'webp': return 'image/webp';
    case 'bmp': return 'image/bmp';
    case 'tif': case 'tiff': return 'image/tiff';
    case 'emf': return 'image/emf';
    case 'wmf': return 'image/wmf';
    default: return 'application/octet-stream';
  }
}

/**
 * Detect which OOXML flavour an archive is, from `[Content_Types].xml` and the
 * presence of the main document part.
 * @param {ZipArchive} zip
 * @returns {'docx'|'pptx'|'xlsx'|'unknown'}
 */
export function ooxmlKind(zip) {
  if (zip.has('word/document.xml')) return 'docx';
  if (zip.has('ppt/presentation.xml')) return 'pptx';
  if (zip.has('xl/workbook.xml')) return 'xlsx';
  const ct = zip.textOf('[Content_Types].xml') || '';
  if (ct.includes('wordprocessingml')) return 'docx';
  if (ct.includes('presentationml')) return 'pptx';
  if (ct.includes('spreadsheetml')) return 'xlsx';
  return 'unknown';
}

/**
 * Relationship entries for a part, from its `_rels` sidecar.
 * @param {ZipArchive} zip
 * @param {string} partName  e.g. `word/document.xml`
 * @returns {Map<string, {type: string, target: string, external: boolean}>}
 */
export function readRelationships(zip, partName) {
  const slash = partName.lastIndexOf('/');
  const dir = slash < 0 ? '' : partName.slice(0, slash + 1);
  const base = slash < 0 ? partName : partName.slice(slash + 1);
  const relsName = `${dir}_rels/${base}.rels`;
  /** @type {Map<string, {type: string, target: string, external: boolean}>} */
  const out = new Map();
  const xml = zip.textOf(relsName);
  if (!xml) return out;
  const re = /<Relationship\b([^>]*)\/?>/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = parseXmlAttrs(m[1]);
    if (!attrs.Id) continue;
    const external = (attrs.TargetMode || '').toLowerCase() === 'external';
    out.set(attrs.Id, {
      type: attrs.Type || '',
      target: external ? (attrs.Target || '') : resolvePart(dir, attrs.Target || ''),
      external,
    });
  }
  return out;
}

/**
 * Resolve a relationship target against the part's directory.
 * @param {string} dir
 * @param {string} target
 * @returns {string}
 */
export function resolvePart(dir, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = (dir + target).split('/');
  /** @type {string[]} */
  const stack = [];
  for (const seg of parts) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') { stack.pop(); continue; }
    stack.push(seg);
  }
  return stack.join('/');
}

/**
 * Parse the attributes of one XML tag body. Deliberately small: OOXML parts are
 * machine-generated and well-formed, and the parts this reader touches never
 * carry CDATA or DTD constructs.
 * @param {string} body
 * @returns {Record<string, string>}
 */
export function parseXmlAttrs(body) {
  /** @type {Record<string, string>} */
  const out = {};
  const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(body))) out[m[1]] = decodeXmlEntities(m[3] !== undefined ? m[3] : m[4]);
  return out;
}

/**
 * @param {string} s
 * @returns {string}
 */
export function decodeXmlEntities(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, ent) => {
    if (ent[0] === '#') {
      const cp = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 ? String.fromCodePoint(cp) : whole;
    }
    switch (ent) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      case 'nbsp': return ' ';
      default: return whole;
    }
  });
}

/**
 * Strip tags from an XML fragment, keeping the text of `<w:t>`/`<a:t>` runs and
 * inserting nothing where the markup implied nothing.
 * @param {string} xml
 * @returns {string}
 */
export function xmlText(xml) {
  return decodeXmlEntities(String(xml).replace(/<[^>]*>/g, ''));
}
