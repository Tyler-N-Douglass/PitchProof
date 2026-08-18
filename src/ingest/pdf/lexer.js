/**
 * The PDF object lexer and parser (D9).
 *
 * PDF's object syntax is small — booleans, numbers, names, strings, arrays,
 * dictionaries, streams, indirect references and `null` — and everything else
 * in the format is built out of it: the cross-reference table, the page tree,
 * font descriptors, `ToUnicode` CMaps, and the content streams themselves. One
 * parser serves all of them.
 *
 * It works over bytes rather than a decoded string, because PDF strings are
 * byte strings with their own escapes and a UTF-16 convention, and decoding the
 * file as text first corrupts them.
 *
 * @module ingest/pdf/lexer
 */

/** A PDF name object (`/Type`). Wrapped so a name is never confused with a string. */
export class Name {
  /** @param {string} name */
  constructor(name) { this.name = name; }
  toString() { return `/${this.name}`; }
}

/** A PDF string object, kept as bytes until something asks for text. */
export class PdfString {
  /** @param {Uint8Array} bytes */
  constructor(bytes) { this.bytes = bytes; }

  /**
   * Decode per the PDF text-string convention: UTF-16BE when the BOM is
   * present, otherwise PDFDocEncoding, which agrees with Latin-1 for every
   * codepoint a document title actually uses.
   * @returns {string}
   */
  asText() {
    const b = this.bytes;
    if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
      let s = '';
      for (let i = 2; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
      return s;
    }
    let s = '';
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return s;
  }
}

/** An indirect reference (`12 0 R`). */
export class Ref {
  /** @param {number} num @param {number} gen */
  constructor(num, gen) { this.num = num; this.gen = gen; }
  /** @returns {string} */
  get key() { return `${this.num}R${this.gen}`; }
}

/** A stream object: its dictionary plus the still-encoded bytes. */
export class PdfStream {
  /** @param {Record<string, any>} dict @param {Uint8Array} raw */
  constructor(dict, raw) { this.dict = dict; this.raw = raw; }
}

/** An operator token inside a content stream (`Tj`, `BT`, `Do`). */
export class Operator {
  /** @param {string} op */
  constructor(op) { this.op = op; }
}

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

/**
 * @param {number} c
 * @returns {boolean}
 */
export function isWhitespaceByte(c) { return WHITESPACE.has(c); }

/**
 * @param {number} c
 * @returns {boolean}
 */
export function isDelimiterByte(c) { return DELIMITERS.has(c); }

/**
 * A dictionary object with no prototype, so a PDF key named `constructor` or
 * `__proto__` cannot reach anything it should not.
 * @returns {Record<string, any>}
 */
export function emptyDict() { return Object.create(null); }

/** A cursor over PDF syntax. */
export class Lexer {
  /**
   * @param {Uint8Array} bytes
   * @param {number} [pos]
   */
  constructor(bytes, pos = 0) {
    this.bytes = bytes;
    this.pos = pos;
  }

  /** Skip whitespace and `%` comments. */
  skipWhitespace() {
    const b = this.bytes;
    while (this.pos < b.length) {
      const c = b[this.pos];
      if (WHITESPACE.has(c)) { this.pos += 1; continue; }
      if (c === 0x25) {                            // '%'
        while (this.pos < b.length && b[this.pos] !== 0x0a && b[this.pos] !== 0x0d) this.pos += 1;
        continue;
      }
      return;
    }
  }

  /** @returns {boolean} */
  get atEnd() { return this.pos >= this.bytes.length; }

  /**
   * Read the next regular token as a string, without interpreting it.
   * @returns {string}
   */
  readKeyword() {
    this.skipWhitespace();
    const b = this.bytes;
    const start = this.pos;
    while (this.pos < b.length && !WHITESPACE.has(b[this.pos]) && !DELIMITERS.has(b[this.pos])) this.pos += 1;
    if (this.pos === start) this.pos += 1;
    return latin1(b, start, this.pos);
  }

  /**
   * Peek at the next keyword without consuming it.
   * @returns {string}
   */
  peekKeyword() {
    const save = this.pos;
    const word = this.readKeyword();
    this.pos = save;
    return word;
  }

  /**
   * Parse the next object.
   *
   * @param {{ resolveLength?: (value: any) => number|null, allowOperators?: boolean }} [options]
   * @returns {any}
   */
  parseObject(options = {}) {
    this.skipWhitespace();
    if (this.atEnd) return undefined;
    const b = this.bytes;
    const c = b[this.pos];

    if (c === 0x2f) return this.parseName();                       // '/'
    if (c === 0x28) return this.parseLiteralString();              // '('
    if (c === 0x5b) return this.parseArray(options);               // '['
    if (c === 0x5d) { this.pos += 1; return undefined; }           // ']' — stray
    if (c === 0x3c) {
      if (b[this.pos + 1] === 0x3c) return this.parseDictionaryOrStream(options);
      return this.parseHexString();
    }
    if (c === 0x3e) { this.pos += 2; return undefined; }           // '>>' — stray
    if (c === 0x7b || c === 0x7d) { this.pos += 1; return undefined; }   // PostScript braces

    if ((c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e) {
      return this.parseNumberOrRef();
    }

    const word = this.readKeyword();
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    if (options.allowOperators) return new Operator(word);
    return new Operator(word);
  }

  /** @returns {Name} */
  parseName() {
    const b = this.bytes;
    this.pos += 1;
    let out = '';
    while (this.pos < b.length) {
      const c = b[this.pos];
      if (WHITESPACE.has(c) || DELIMITERS.has(c)) break;
      if (c === 0x23 && this.pos + 2 < b.length) {                 // '#' escape
        const hex = latin1(b, this.pos + 1, this.pos + 3);
        const value = parseInt(hex, 16);
        if (Number.isFinite(value)) { out += String.fromCharCode(value); this.pos += 3; continue; }
      }
      out += String.fromCharCode(c);
      this.pos += 1;
    }
    return new Name(out);
  }

  /** @returns {number|Ref} */
  parseNumberOrRef() {
    const first = this.readNumber();
    const save = this.pos;
    this.skipWhitespace();
    const b = this.bytes;
    // `n g R` is the only three-token form; anything else rewinds.
    if (Number.isInteger(first) && first >= 0 && this.pos < b.length && b[this.pos] >= 0x30 && b[this.pos] <= 0x39) {
      const gen = this.readNumber();
      this.skipWhitespace();
      if (Number.isInteger(gen) && gen >= 0 && this.bytes[this.pos] === 0x52
        && (this.pos + 1 >= b.length || WHITESPACE.has(b[this.pos + 1]) || DELIMITERS.has(b[this.pos + 1]))) {
        this.pos += 1;
        return new Ref(first, gen);
      }
    }
    this.pos = save;
    return first;
  }

  /** @returns {number} */
  readNumber() {
    this.skipWhitespace();
    const b = this.bytes;
    const start = this.pos;
    if (b[this.pos] === 0x2b || b[this.pos] === 0x2d) this.pos += 1;
    while (this.pos < b.length) {
      const c = b[this.pos];
      if ((c >= 0x30 && c <= 0x39) || c === 0x2e || c === 0x2d || c === 0x2b || c === 0x45 || c === 0x65) this.pos += 1;
      else break;
    }
    const text = latin1(b, start, this.pos);
    const value = Number(text.replace(/(?!^)[+-]/g, ''));
    return Number.isFinite(value) ? value : 0;
  }

  /** @returns {PdfString} */
  parseLiteralString() {
    const b = this.bytes;
    this.pos += 1;
    /** @type {number[]} */
    const out = [];
    let depth = 1;
    while (this.pos < b.length) {
      let c = b[this.pos++];
      if (c === 0x5c) {                                            // backslash
        const e = b[this.pos++];
        switch (e) {
          case 0x6e: out.push(0x0a); break;                        // n
          case 0x72: out.push(0x0d); break;                        // r
          case 0x74: out.push(0x09); break;                        // t
          case 0x62: out.push(0x08); break;                        // b
          case 0x66: out.push(0x0c); break;                        // f
          case 0x28: out.push(0x28); break;
          case 0x29: out.push(0x29); break;
          case 0x5c: out.push(0x5c); break;
          case 0x0d: if (b[this.pos] === 0x0a) this.pos += 1; break;   // line continuation
          case 0x0a: break;
          default:
            if (e >= 0x30 && e <= 0x37) {
              let value = e - 0x30;
              for (let k = 0; k < 2; k++) {
                const d = b[this.pos];
                if (d >= 0x30 && d <= 0x37) { value = value * 8 + (d - 0x30); this.pos += 1; }
                else break;
              }
              out.push(value & 0xff);
            } else if (e !== undefined) {
              out.push(e);
            }
        }
        continue;
      }
      if (c === 0x28) { depth += 1; out.push(c); continue; }
      if (c === 0x29) {
        depth -= 1;
        if (depth === 0) break;
        out.push(c);
        continue;
      }
      out.push(c);
    }
    return new PdfString(new Uint8Array(out));
  }

  /** @returns {PdfString} */
  parseHexString() {
    const b = this.bytes;
    this.pos += 1;
    /** @type {number[]} */
    const out = [];
    let high = -1;
    while (this.pos < b.length) {
      const c = b[this.pos++];
      if (c === 0x3e) break;
      let v = -1;
      if (c >= 0x30 && c <= 0x39) v = c - 0x30;
      else if (c >= 0x41 && c <= 0x46) v = c - 0x37;
      else if (c >= 0x61 && c <= 0x66) v = c - 0x57;
      else continue;
      if (high < 0) high = v;
      else { out.push((high << 4) | v); high = -1; }
    }
    if (high >= 0) out.push(high << 4);
    return new PdfString(new Uint8Array(out));
  }

  /**
   * @param {object} options
   * @returns {any[]}
   */
  parseArray(options) {
    const b = this.bytes;
    this.pos += 1;
    /** @type {any[]} */
    const out = [];
    for (;;) {
      this.skipWhitespace();
      if (this.pos >= b.length) break;
      if (b[this.pos] === 0x5d) { this.pos += 1; break; }
      const before = this.pos;
      const value = this.parseObject(options);
      if (this.pos === before) { this.pos += 1; continue; }
      if (value instanceof Operator) continue;
      out.push(value);
    }
    return out;
  }

  /**
   * @param {{resolveLength?: (value: any) => number|null}} options
   * @returns {Record<string, any>|PdfStream}
   */
  parseDictionaryOrStream(options) {
    const b = this.bytes;
    this.pos += 2;
    const dict = emptyDict();
    for (;;) {
      this.skipWhitespace();
      if (this.pos >= b.length) break;
      if (b[this.pos] === 0x3e && b[this.pos + 1] === 0x3e) { this.pos += 2; break; }
      if (b[this.pos] !== 0x2f) {
        // Junk between entries: step over it rather than abandoning the dict.
        const before = this.pos;
        this.parseObject(options);
        if (this.pos === before) this.pos += 1;
        continue;
      }
      const key = this.parseName().name;
      const value = this.parseObject(options);
      if (!(value instanceof Operator)) dict[key] = value;
    }

    // `stream` may follow.
    const save = this.pos;
    this.skipWhitespace();
    if (latin1(b, this.pos, this.pos + 6) === 'stream') {
      this.pos += 6;
      if (b[this.pos] === 0x0d) this.pos += 1;
      if (b[this.pos] === 0x0a) this.pos += 1;
      const start = this.pos;
      let length = null;
      if (typeof options.resolveLength === 'function') length = options.resolveLength(dict.Length);
      else if (typeof dict.Length === 'number') length = dict.Length;

      let end = -1;
      if (length !== null && Number.isFinite(length) && length >= 0 && start + length <= b.length) {
        const candidate = start + length;
        const after = latin1(b, candidate, candidate + 20).replace(/^[\r\n \t]+/, '');
        if (after.startsWith('endstream')) end = candidate;
      }
      if (end < 0) end = findKeyword(b, start, 'endstream');
      if (end < 0) end = b.length;
      // A stream written with a trailing EOL before `endstream` does not carry
      // that EOL as data.
      let dataEnd = end;
      if (b[dataEnd - 1] === 0x0a) dataEnd -= 1;
      if (b[dataEnd - 1] === 0x0d) dataEnd -= 1;
      const raw = b.subarray(start, length !== null && start + length === end ? end : dataEnd);
      this.pos = end;
      const closing = findKeyword(b, this.pos, 'endstream');
      this.pos = closing < 0 ? b.length : closing + 9;
      return new PdfStream(dict, raw);
    }
    this.pos = save;
    return dict;
  }
}

/**
 * Decode a byte range as Latin-1. Used for keywords only.
 * @param {Uint8Array} b
 * @param {number} start
 * @param {number} end
 * @returns {string}
 */
export function latin1(b, start, end) {
  let s = '';
  const stop = Math.min(end, b.length);
  for (let i = Math.max(0, start); i < stop; i++) s += String.fromCharCode(b[i]);
  return s;
}

/**
 * Find a keyword's byte offset at or after `from`, or -1.
 * @param {Uint8Array} b
 * @param {number} from
 * @param {string} keyword
 * @returns {number}
 */
export function findKeyword(b, from, keyword) {
  const first = keyword.charCodeAt(0);
  const n = keyword.length;
  for (let i = Math.max(0, from); i + n <= b.length; i++) {
    if (b[i] !== first) continue;
    let match = true;
    for (let k = 1; k < n; k++) {
      if (b[i + k] !== keyword.charCodeAt(k)) { match = false; break; }
    }
    if (match) return i;
  }
  return -1;
}

/**
 * Find the last occurrence of a keyword at or before `from`, or -1.
 * @param {Uint8Array} b
 * @param {number} from
 * @param {string} keyword
 * @returns {number}
 */
export function findKeywordBackwards(b, from, keyword) {
  const n = keyword.length;
  for (let i = Math.min(from, b.length - n); i >= 0; i--) {
    let match = true;
    for (let k = 0; k < n; k++) {
      if (b[i + k] !== keyword.charCodeAt(k)) { match = false; break; }
    }
    if (match) return i;
  }
  return -1;
}

/**
 * True when the value is a `Name` with this name.
 * @param {any} value
 * @param {string} name
 * @returns {boolean}
 */
export function isName(value, name) { return value instanceof Name && value.name === name; }

/**
 * The name of a `Name` value, or null.
 * @param {any} value
 * @returns {string|null}
 */
export function nameOf(value) { return value instanceof Name ? value.name : null; }
