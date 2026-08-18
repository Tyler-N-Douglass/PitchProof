/**
 * The PDF object graph (D9): cross-reference tables, cross-reference streams,
 * object streams, the trailer, and the page tree.
 *
 * Real-world PDFs are frequently wrong in ways their viewer forgives: byte
 * offsets shifted by a re-save, a `Length` that does not match the stream, a
 * cross-reference chain with a loop. Every one of those defects appears in
 * documents a seller will actually drop into the studio, so this reader repairs
 * rather than refuses — a full-file object scan backstops the cross-reference
 * table, and any object the table misses is looked up in the scan.
 *
 * @module ingest/pdf/document
 */

import {
  Lexer, Name, PdfStream, PdfString, Ref, Operator,
  latin1, findKeyword, findKeywordBackwards, emptyDict, nameOf,
} from './lexer.js';
import { decodeStream } from './filters.js';

/**
 * @typedef {{type: 1, offset: number, gen: number} | {type: 2, streamNum: number, index: number}} XrefEntry
 */

/** A parsed PDF file. */
export class PdfDocument {
  /** @param {Uint8Array} bytes */
  constructor(bytes) {
    this.bytes = bytes;
    /** @type {Map<number, XrefEntry>} */
    this.xref = new Map();
    /** @type {Record<string, any>} */
    this.trailer = emptyDict();
    /** @type {Map<number, any>} */
    this.cache = new Map();
    /** @type {Map<number, number>|null} object number → offset, from a full scan */
    this.scanned = null;
    /** @type {Map<number, any[]>} */
    this.objectStreams = new Map();
    /** @type {string[]} */
    this.warnings = [];
    /** @type {Set<number>} guards against a self-referential object graph */
    this.resolving = new Set();
    this.encrypted = false;
  }

  /**
   * Parse the cross-reference chain and the trailer. Never throws.
   * @returns {PdfDocument}
   */
  parse() {
    const start = this.findStartXref();
    /** @type {Set<number>} */
    const seen = new Set();
    let offset = start;
    let guard = 0;
    while (offset !== null && offset >= 0 && offset < this.bytes.length && !seen.has(offset) && guard < 64) {
      seen.add(offset);
      guard += 1;
      const result = this.readXrefSection(offset);
      if (!result) break;
      for (const [key, value] of Object.entries(result.trailer)) {
        if (!(key in this.trailer)) this.trailer[key] = value;
      }
      if (result.hybrid !== null && !seen.has(result.hybrid)) {
        seen.add(result.hybrid);
        const hybrid = this.readXrefSection(result.hybrid);
        if (hybrid) {
          for (const [key, value] of Object.entries(hybrid.trailer)) {
            if (!(key in this.trailer)) this.trailer[key] = value;
          }
        }
      }
      const prev = result.trailer.Prev;
      offset = typeof prev === 'number' ? prev : null;
    }

    if (this.trailer.Encrypt) {
      this.encrypted = true;
      this.warnings.push('the document is encrypted; only unencrypted objects will be readable');
    }
    if (!this.xref.size || !this.trailer.Root) {
      this.warnings.push('the cross-reference table was unusable; the file was scanned for objects instead');
      this.scanObjects();
      if (!this.trailer.Root) this.recoverTrailer();
    }
    return this;
  }

  /**
   * @returns {number|null}
   */
  findStartXref() {
    const at = findKeywordBackwards(this.bytes, this.bytes.length - 9, 'startxref');
    if (at < 0) return null;
    const lexer = new Lexer(this.bytes, at + 9);
    const value = lexer.readNumber();
    return Number.isFinite(value) ? value : null;
  }

  /**
   * Read one cross-reference section, classic or stream.
   * @param {number} offset
   * @returns {{trailer: Record<string, any>, hybrid: number|null}|null}
   */
  readXrefSection(offset) {
    const lexer = new Lexer(this.bytes, offset);
    lexer.skipWhitespace();
    if (latin1(this.bytes, lexer.pos, lexer.pos + 4) === 'xref') {
      lexer.pos += 4;
      return this.readXrefTable(lexer);
    }
    return this.readXrefStream(offset);
  }

  /**
   * A classic `xref` table plus its `trailer` dictionary.
   * @param {Lexer} lexer
   * @returns {{trailer: Record<string, any>, hybrid: number|null}|null}
   */
  readXrefTable(lexer) {
    for (;;) {
      lexer.skipWhitespace();
      const word = lexer.peekKeyword();
      if (word === 'trailer') {
        lexer.readKeyword();
        const trailer = lexer.parseObject({ resolveLength: (v) => (typeof v === 'number' ? v : null) });
        const dict = trailer && typeof trailer === 'object' && !(trailer instanceof Operator) ? trailer : emptyDict();
        const hybrid = typeof dict.XRefStm === 'number' ? dict.XRefStm : null;
        return { trailer: dict, hybrid };
      }
      if (!/^\d/.test(word)) return { trailer: emptyDict(), hybrid: null };
      const first = lexer.readNumber();
      const count = lexer.readNumber();
      if (!Number.isFinite(first) || !Number.isFinite(count) || count < 0) return { trailer: emptyDict(), hybrid: null };
      for (let i = 0; i < count; i++) {
        lexer.skipWhitespace();
        const entryOffset = lexer.readNumber();
        const gen = lexer.readNumber();
        lexer.skipWhitespace();
        const kind = String.fromCharCode(this.bytes[lexer.pos]);
        lexer.pos += 1;
        const num = first + i;
        if (kind === 'n' && !this.xref.has(num)) {
          this.xref.set(num, { type: 1, offset: entryOffset, gen });
        }
      }
    }
  }

  /**
   * A cross-reference stream (`/Type /XRef`), which is how every PDF written
   * since 1.5 stores its table.
   * @param {number} offset
   * @returns {{trailer: Record<string, any>, hybrid: number|null}|null}
   */
  readXrefStream(offset) {
    const lexer = new Lexer(this.bytes, offset);
    lexer.skipWhitespace();
    lexer.readNumber();                 // object number
    lexer.readNumber();                 // generation
    const keyword = lexer.readKeyword();
    if (keyword !== 'obj') return null;
    const object = lexer.parseObject({ resolveLength: (v) => (typeof v === 'number' ? v : null) });
    if (!(object instanceof PdfStream)) return null;

    const dict = object.dict;
    const data = this.decode(object);
    if (!data) return { trailer: dict, hybrid: null };

    const w = Array.isArray(dict.W) ? dict.W.map(Number) : null;
    if (!w || w.length < 3) return { trailer: dict, hybrid: null };
    const size = Number(dict.Size || 0);
    /** @type {number[]} */
    const index = Array.isArray(dict.Index) ? dict.Index.map(Number) : [0, size];

    const rowLength = w.reduce((a, b) => a + b, 0);
    let p = 0;
    for (let s = 0; s + 1 < index.length; s += 2) {
      const first = index[s];
      const count = index[s + 1];
      for (let i = 0; i < count; i++) {
        if (p + rowLength > data.length) break;
        /** @type {number[]} */
        const fields = [];
        for (const width of w) {
          let value = 0;
          for (let k = 0; k < width; k++) value = value * 256 + data[p++];
          fields.push(value);
        }
        const type = w[0] === 0 ? 1 : fields[0];
        const num = first + i;
        if (this.xref.has(num)) continue;
        if (type === 1) this.xref.set(num, { type: 1, offset: fields[1], gen: fields[2] });
        else if (type === 2) this.xref.set(num, { type: 2, streamNum: fields[1], index: fields[2] });
      }
    }
    return { trailer: dict, hybrid: null };
  }

  /**
   * Scan the whole file for `N G obj`, building a repair table. Later
   * definitions win, which matches how an incrementally-updated file works.
   */
  scanObjects() {
    if (this.scanned) return;
    /** @type {Map<number, number>} */
    const map = new Map();
    const b = this.bytes;
    for (let i = 0; i + 3 < b.length; i++) {
      if (b[i] !== 0x6f || b[i + 1] !== 0x62 || b[i + 2] !== 0x6a) continue;    // 'obj'
      const after = b[i + 3];
      if (after !== undefined && !(after === 0x20 || after === 0x0a || after === 0x0d || after === 0x09
        || after === 0x3c || after === 0x5b || after === 0x2f || after === 0x25)) continue;
      // Walk back over `G` and `N`.
      let k = i - 1;
      while (k >= 0 && (b[k] === 0x20 || b[k] === 0x0d || b[k] === 0x0a || b[k] === 0x09)) k -= 1;
      const genEnd = k + 1;
      while (k >= 0 && b[k] >= 0x30 && b[k] <= 0x39) k -= 1;
      const genStart = k + 1;
      if (genStart === genEnd) continue;
      while (k >= 0 && (b[k] === 0x20 || b[k] === 0x0d || b[k] === 0x0a || b[k] === 0x09)) k -= 1;
      const numEnd = k + 1;
      while (k >= 0 && b[k] >= 0x30 && b[k] <= 0x39) k -= 1;
      const numStart = k + 1;
      if (numStart === numEnd) continue;
      const num = Number(latin1(b, numStart, numEnd));
      if (!Number.isFinite(num)) continue;
      map.set(num, numStart);
    }
    this.scanned = map;
  }

  /**
   * Rebuild a trailer when the file has none we can read, by finding the
   * catalog object directly.
   */
  recoverTrailer() {
    this.scanObjects();
    if (!this.scanned) return;
    for (const num of Array.from(this.scanned.keys()).sort((a, b) => a - b)) {
      const value = this.get(num);
      const dict = value instanceof PdfStream ? value.dict : value;
      if (dict && typeof dict === 'object' && nameOf(dict.Type) === 'Catalog') {
        this.trailer.Root = new Ref(num, 0);
        return;
      }
    }
    // No catalog: fall back to any Pages node, then to raw page objects.
    for (const num of Array.from(this.scanned.keys()).sort((a, b) => a - b)) {
      const value = this.get(num);
      const dict = value instanceof PdfStream ? value.dict : value;
      if (dict && typeof dict === 'object' && nameOf(dict.Type) === 'Pages' && !dict.Parent) {
        const catalog = emptyDict();
        catalog.Type = new Name('Catalog');
        catalog.Pages = new Ref(num, 0);
        this.trailer.Root = catalog;
        return;
      }
    }
  }

  /**
   * Fetch an object by number.
   * @param {number} num
   * @returns {any}
   */
  get(num) {
    if (this.cache.has(num)) return this.cache.get(num);
    if (this.resolving.has(num)) return null;
    this.resolving.add(num);
    let value = null;
    try {
      value = this.load(num);
    } catch (e) {
      this.warnings.push(`object ${num} could not be read: ${e instanceof Error ? e.message : String(e)}`);
      value = null;
    } finally {
      this.resolving.delete(num);
    }
    this.cache.set(num, value);
    return value;
  }

  /**
   * @param {number} num
   * @returns {any}
   */
  load(num) {
    const entry = this.xref.get(num);
    if (entry && entry.type === 1) {
      const value = this.parseObjectAt(entry.offset, num);
      if (value !== undefined) return value;
    }
    if (entry && entry.type === 2) {
      const value = this.fromObjectStream(entry.streamNum, entry.index, num);
      if (value !== undefined) return value;
    }
    // Repair path: the table was wrong, so use the scan.
    this.scanObjects();
    const offset = this.scanned ? this.scanned.get(num) : undefined;
    if (offset !== undefined) {
      const value = this.parseObjectAt(offset, num);
      if (value !== undefined) return value;
    }
    return null;
  }

  /**
   * Parse `N G obj … endobj` at a byte offset, verifying the object number.
   * @param {number} offset
   * @param {number} expected
   * @returns {any}
   */
  parseObjectAt(offset, expected) {
    if (!Number.isFinite(offset) || offset < 0 || offset >= this.bytes.length) return undefined;
    const lexer = new Lexer(this.bytes, offset);
    lexer.skipWhitespace();
    const num = lexer.readNumber();
    lexer.readNumber();
    const keyword = lexer.readKeyword();
    if (keyword !== 'obj') return undefined;
    if (Number.isFinite(expected) && num !== expected) return undefined;
    const value = lexer.parseObject({ resolveLength: (v) => this.resolveNumber(v) });
    return value instanceof Operator ? undefined : value;
  }

  /**
   * @param {any} value
   * @returns {number|null}
   */
  resolveNumber(value) {
    const resolved = this.resolve(value);
    return typeof resolved === 'number' && Number.isFinite(resolved) ? resolved : null;
  }

  /**
   * Objects packed inside an `/ObjStm`.
   * @param {number} streamNum
   * @param {number} index
   * @param {number} expected
   * @returns {any}
   */
  fromObjectStream(streamNum, index, expected) {
    let entries = this.objectStreams.get(streamNum);
    if (!entries) {
      entries = [];
      const container = this.get(streamNum);
      if (container instanceof PdfStream) {
        const data = this.decode(container);
        if (data) {
          const n = Number(this.resolve(container.dict.N) || 0);
          const first = Number(this.resolve(container.dict.First) || 0);
          const header = new Lexer(data, 0);
          /** @type {{num: number, offset: number}[]} */
          const pairs = [];
          for (let i = 0; i < n; i++) {
            const objNum = header.readNumber();
            const objOffset = header.readNumber();
            if (!Number.isFinite(objNum) || !Number.isFinite(objOffset)) break;
            pairs.push({ num: objNum, offset: objOffset });
          }
          for (const pair of pairs) {
            const lexer = new Lexer(data, first + pair.offset);
            const value = lexer.parseObject({ resolveLength: (v) => this.resolveNumber(v) });
            entries.push({ num: pair.num, value: value instanceof Operator ? null : value });
          }
        }
      }
      this.objectStreams.set(streamNum, entries);
    }
    const byIndex = entries[index];
    if (byIndex && byIndex.num === expected) return byIndex.value;
    const byNum = entries.find((e) => e.num === expected);
    return byNum ? byNum.value : undefined;
  }

  /**
   * Follow an indirect reference. Anything else is returned unchanged.
   * @param {any} value
   * @returns {any}
   */
  resolve(value) {
    let current = value;
    let guard = 0;
    while (current instanceof Ref && guard < 32) {
      current = this.get(current.num);
      guard += 1;
    }
    return current;
  }

  /**
   * A resolved dictionary entry.
   * @param {Record<string, any>|null|undefined} dict
   * @param {string} key
   * @returns {any}
   */
  dictGet(dict, key) {
    if (!dict || typeof dict !== 'object') return undefined;
    return this.resolve(dict[key]);
  }

  /**
   * Decode a stream's bytes through its filter chain.
   * @param {PdfStream|null|undefined} stream
   * @returns {Uint8Array|null}
   */
  decode(stream) {
    if (!(stream instanceof PdfStream)) return null;
    const result = this.decodeDetailed(stream);
    return result ? result.bytes : null;
  }

  /**
   * Decode a stream, reporting the filter that was left in place (a JPEG, say).
   * @param {PdfStream} stream
   * @returns {{bytes: Uint8Array, remaining: string|null, applied: string[]}|null}
   */
  decodeDetailed(stream) {
    if (!(stream instanceof PdfStream)) return null;
    const filters = this.filterNames(stream.dict);
    const parms = this.filterParms(stream.dict, filters.length);
    try {
      return decodeStream(stream.raw, filters, parms);
    } catch (e) {
      this.warnings.push(`a stream could not be decoded: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /**
   * @param {Record<string, any>} dict
   * @returns {string[]}
   */
  filterNames(dict) {
    const filter = this.dictGet(dict, 'Filter') ?? this.dictGet(dict, 'F');
    if (!filter) return [];
    if (filter instanceof Name) return [filter.name];
    if (Array.isArray(filter)) {
      return filter.map((f) => nameOf(this.resolve(f))).filter((n) => typeof n === 'string');
    }
    return [];
  }

  /**
   * @param {Record<string, any>} dict
   * @param {number} count
   * @returns {object[]}
   */
  filterParms(dict, count) {
    const parms = this.dictGet(dict, 'DecodeParms') ?? this.dictGet(dict, 'DP');
    /** @type {object[]} */
    const out = new Array(count).fill(null).map(() => ({}));
    const plain = (value) => {
      const resolved = this.resolve(value);
      if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved)) return {};
      /** @type {Record<string, any>} */
      const flat = {};
      for (const key of Object.keys(resolved)) flat[key] = this.resolve(resolved[key]);
      return flat;
    };
    if (Array.isArray(parms)) {
      parms.forEach((entry, i) => { if (i < count) out[i] = plain(entry); });
    } else if (parms) {
      out[0] = plain(parms);
    }
    return out;
  }

  /**
   * The document catalog.
   * @returns {Record<string, any>|null}
   */
  catalog() {
    const root = this.resolve(this.trailer.Root);
    return root && typeof root === 'object' && !Array.isArray(root) ? root : null;
  }

  /**
   * Every page, in order, with inheritable attributes already merged.
   * @returns {Record<string, any>[]}
   */
  pages() {
    const catalog = this.catalog();
    const root = catalog ? this.dictGet(catalog, 'Pages') : null;
    /** @type {Record<string, any>[]} */
    const out = [];
    /** @type {Set<any>} */
    const seen = new Set();

    /**
     * @param {any} node
     * @param {Record<string, any>} inherited
     * @param {number} depth
     */
    const visit = (node, inherited, depth) => {
      const dict = this.resolve(node);
      if (!dict || typeof dict !== 'object' || Array.isArray(dict) || seen.has(dict) || depth > 64) return;
      seen.add(dict);
      /** @type {Record<string, any>} */
      const merged = { ...inherited };
      for (const key of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) {
        if (dict[key] !== undefined) merged[key] = dict[key];
      }
      const type = nameOf(this.dictGet(dict, 'Type'));
      const kids = this.dictGet(dict, 'Kids');
      if (type === 'Page' || (!kids && dict.Contents !== undefined)) {
        /** @type {Record<string, any>} */
        const page = Object.create(null);
        for (const key of Object.keys(dict)) page[key] = dict[key];
        for (const key of Object.keys(merged)) if (page[key] === undefined) page[key] = merged[key];
        out.push(page);
        return;
      }
      if (Array.isArray(kids)) {
        for (const kid of kids) visit(kid, merged, depth + 1);
      }
    };

    visit(root, Object.create(null), 0);

    if (!out.length) {
      // Repair: a damaged page tree still leaves `/Type /Page` objects behind.
      this.scanObjects();
      if (this.scanned) {
        for (const num of Array.from(this.scanned.keys()).sort((a, b) => a - b)) {
          const value = this.get(num);
          if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof PdfStream)
            && nameOf(this.resolve(value.Type)) === 'Page') {
            out.push(value);
          }
        }
        if (out.length) this.warnings.push('the page tree was damaged; pages were recovered by scanning');
      }
    }
    return out;
  }

  /**
   * A page's content stream bytes, concatenated when `/Contents` is an array.
   * @param {Record<string, any>} page
   * @returns {Uint8Array}
   */
  pageContent(page) {
    const contents = this.dictGet(page, 'Contents');
    /** @type {Uint8Array[]} */
    const parts = [];
    const push = (value) => {
      const stream = this.resolve(value);
      if (stream instanceof PdfStream) {
        const data = this.decode(stream);
        if (data && data.length) parts.push(data);
      }
    };
    if (Array.isArray(contents)) for (const entry of contents) push(entry);
    else push(contents);
    if (!parts.length) return new Uint8Array(0);
    let total = 0;
    for (const part of parts) total += part.length + 1;
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
      out[at++] = 0x0a;                 // streams concatenate with a separator
    }
    return out;
  }

  /**
   * Document information dictionary, as plain strings.
   * @returns {Record<string, string>}
   */
  info() {
    /** @type {Record<string, string>} */
    const out = {};
    const info = this.resolve(this.trailer.Info);
    if (!info || typeof info !== 'object' || Array.isArray(info)) return out;
    for (const key of ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate', 'ModDate']) {
      const value = this.resolve(info[key]);
      if (value instanceof PdfString) {
        const text = value.asText().trim();
        if (text) out[key] = text;
      }
    }
    return out;
  }

  /**
   * The document's declared language, if any.
   * @returns {string|null}
   */
  language() {
    const catalog = this.catalog();
    const lang = catalog ? this.dictGet(catalog, 'Lang') : null;
    if (lang instanceof PdfString) {
      const text = lang.asText().trim();
      return text || null;
    }
    return null;
  }
}

/**
 * Parse a PDF from bytes. Returns null when the file is not a PDF at all.
 * @param {Uint8Array} bytes
 * @returns {PdfDocument|null}
 */
export function readPdf(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 8) return null;
  const head = latin1(bytes, 0, Math.min(1024, bytes.length));
  if (!head.includes('%PDF-')) {
    // Some files carry junk before the header; the spec allows up to 1024 bytes.
    if (findKeyword(bytes, 0, '%PDF-') < 0) return null;
  }
  return new PdfDocument(bytes).parse();
}
