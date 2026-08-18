/**
 * PDF character encodings and `ToUnicode` CMaps (D9).
 *
 * A PDF does not store text; it stores glyph codes plus enough information to
 * find the glyphs. Turning that back into characters is where naive extractors
 * produce mojibake, so the resolution order here is the one the specification
 * sets out and the one viewers actually follow:
 *
 *   1. the font's `/ToUnicode` CMap, when present — authoritative;
 *   2. `/Encoding` with `/Differences`, glyph name → Unicode through the
 *      Adobe Glyph List;
 *   3. the named base encoding: WinAnsi, MacRoman or Standard;
 *   4. Standard, which is the specification's default.
 *
 * Type 0 (composite) fonts are handled through their CMap's codespace ranges,
 * which is what makes two-byte Identity-H text come out as words rather than as
 * pairs of Latin-1 characters.
 *
 * @module ingest/pdf/encoding
 */

import { Lexer, Name, PdfString, Operator, nameOf } from './lexer.js';

/**
 * Adobe Glyph List subset: every name reachable from the three base encodings,
 * plus the names real documents use in `/Differences`. `name:codepoint`, and a
 * name may map to more than one codepoint (`fi` → `fi`).
 */
const GLYPH_SOURCE = [
  'space:32 exclam:33 quotedbl:34 numbersign:35 dollar:36 percent:37 ampersand:38 quotesingle:39',
  'quoteright:8217 parenleft:40 parenright:41 asterisk:42 plus:43 comma:44 hyphen:45 period:46 slash:47',
  'zero:48 one:49 two:50 three:51 four:52 five:53 six:54 seven:55 eight:56 nine:57',
  'colon:58 semicolon:59 less:60 equal:61 greater:62 question:63 at:64',
  'bracketleft:91 backslash:92 bracketright:93 asciicircum:94 underscore:95 quoteleft:8216 grave:96',
  'braceleft:123 bar:124 braceright:125 asciitilde:126',
  'exclamdown:161 cent:162 sterling:163 fraction:8260 yen:165 florin:402 section:167 currency:164',
  'quotedblleft:8220 guillemotleft:171 guilsinglleft:8249 guilsinglright:8250 fi:64257 fl:64258',
  'endash:8211 dagger:8224 daggerdbl:8225 periodcentered:183 paragraph:182 bullet:8226',
  'quotesinglbase:8218 quotedblbase:8222 quotedblright:8221 guillemotright:187 ellipsis:8230',
  'perthousand:8240 questiondown:191 acute:180 circumflex:710 tilde:732 macron:175 breve:728',
  'dotaccent:729 dieresis:168 ring:730 cedilla:184 hungarumlaut:733 ogonek:731 caron:711 emdash:8212',
  'AE:198 ordfeminine:170 Lslash:321 Oslash:216 OE:338 ordmasculine:186 ae:230 dotlessi:305',
  'lslash:322 oslash:248 oe:339 germandbls:223 trademark:8482 Euro:8364 Scaron:352 scaron:353',
  'Zcaron:381 zcaron:382 Ydieresis:376 brokenbar:166 copyright:169 logicalnot:172 registered:174',
  'degree:176 plusminus:177 twosuperior:178 threesuperior:179 mu:181 onesuperior:185',
  'onequarter:188 onehalf:189 threequarters:190 multiply:215 divide:247 minus:8722 nbspace:160',
  'Agrave:192 Aacute:193 Acircumflex:194 Atilde:195 Adieresis:196 Aring:197 Ccedilla:199',
  'Egrave:200 Eacute:201 Ecircumflex:202 Edieresis:203 Igrave:204 Iacute:205 Icircumflex:206',
  'Idieresis:207 Eth:208 Ntilde:209 Ograve:210 Oacute:211 Ocircumflex:212 Otilde:213 Odieresis:214',
  'Ugrave:217 Uacute:218 Ucircumflex:219 Udieresis:220 Yacute:221 Thorn:222',
  'agrave:224 aacute:225 acircumflex:226 atilde:227 adieresis:228 aring:229 ccedilla:231',
  'egrave:232 eacute:233 ecircumflex:234 edieresis:235 igrave:236 iacute:237 icircumflex:238',
  'idieresis:239 eth:240 ntilde:241 ograve:242 oacute:243 ocircumflex:244 otilde:245 odieresis:246',
  'ugrave:249 uacute:250 ucircumflex:251 udieresis:252 yacute:253 thorn:254 ydieresis:255',
  'Delta:8710 Omega:8486 pi:960 summation:8721 product:8719 radical:8730 infinity:8734',
  'notequal:8800 lessequal:8804 greaterequal:8805 partialdiff:8706 integral:8747 approxequal:8776',
  'lozenge:9674 apple:63743 Lcaron:317 lcaron:318 Dcaron:270 dcaron:271 Tcaron:356 tcaron:357',
  'Scedilla:350 scedilla:351 Racute:340 racute:341 Sacute:346 sacute:347 Zacute:377 zacute:378',
  'Zdotaccent:379 zdotaccent:380 Ccaron:268 ccaron:269 Ecaron:282 ecaron:283 Ncaron:327 ncaron:328',
  'Rcaron:344 rcaron:345 Uring:366 uring:367 Aogonek:260 aogonek:261 Eogonek:280 eogonek:281',
  'Amacron:256 amacron:257 Emacron:274 emacron:275 Imacron:298 imacron:299 Omacron:332 omacron:333',
  'Umacron:362 umacron:363 Gbreve:286 gbreve:287 Idotaccent:304 Scommaaccent:536 scommaaccent:537',
  'Tcommaaccent:538 tcommaaccent:539 Abreve:258 abreve:259 Lacute:313 lacute:314 Nacute:323 nacute:324',
  'Ohungarumlaut:336 ohungarumlaut:337 Uhungarumlaut:368 uhungarumlaut:369 Tcedilla:354 tcedilla:355',
  'Dcroat:272 dcroat:273 Eurosign:8364 arrowleft:8592 arrowup:8593 arrowright:8594 arrowdown:8595',
  'arrowboth:8596 heart:9829 club:9827 diamond:9830 spade:9824 checkmark:10003',
].join(' ');

/** @type {Map<string, string>} glyph name → the characters it represents */
export const GLYPH_TO_UNICODE = (() => {
  /** @type {Map<string, string>} */
  const map = new Map();
  for (const token of GLYPH_SOURCE.split(/\s+/)) {
    if (!token) continue;
    const at = token.lastIndexOf(':');
    if (at < 0) continue;
    const name = token.slice(0, at);
    const cp = Number(token.slice(at + 1));
    if (!name || !Number.isFinite(cp)) continue;
    if (!map.has(name)) map.set(name, String.fromCodePoint(cp));
  }
  return map;
})();

/**
 * Resolve a glyph name to text, including the algorithmic `uniXXXX`, `uXXXXXX`,
 * `gNN` and `cidNN` forms real subsetted fonts use.
 * @param {string} name
 * @returns {string|null}
 */
export function glyphNameToUnicode(name) {
  if (!name) return null;
  const direct = GLYPH_TO_UNICODE.get(name);
  if (direct !== undefined) return direct;
  const uni = name.match(/^uni([0-9A-Fa-f]{4,6})$/);
  if (uni) {
    let out = '';
    for (let i = 0; i + 4 <= uni[1].length; i += 4) out += String.fromCharCode(parseInt(uni[1].slice(i, i + 4), 16));
    return out;
  }
  const u = name.match(/^u([0-9A-Fa-f]{4,6})$/);
  if (u) {
    const cp = parseInt(u[1], 16);
    return Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : null;
  }
  // `A.sc`, `one.oldstyle`: the base name carries the meaning.
  const dot = name.indexOf('.');
  if (dot > 0) return glyphNameToUnicode(name.slice(0, dot));
  if (/^(g|cid|glyph|index)\d+$/i.test(name)) return null;
  if (name.length === 1) return name;
  return null;
}

/** Windows-1252's C1 block, which is the only place WinAnsi differs from Latin-1. */
const CP1252_C1 = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
  0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f,
  0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
];

/** MacRoman's upper half. */
const MACROMAN_HIGH = [
  0x00c4, 0x00c5, 0x00c7, 0x00c9, 0x00d1, 0x00d6, 0x00dc, 0x00e1,
  0x00e0, 0x00e2, 0x00e4, 0x00e3, 0x00e5, 0x00e7, 0x00e9, 0x00e8,
  0x00ea, 0x00eb, 0x00ed, 0x00ec, 0x00ee, 0x00ef, 0x00f1, 0x00f3,
  0x00f2, 0x00f4, 0x00f6, 0x00f5, 0x00fa, 0x00f9, 0x00fb, 0x00fc,
  0x2020, 0x00b0, 0x00a2, 0x00a3, 0x00a7, 0x2022, 0x00b6, 0x00df,
  0x00ae, 0x00a9, 0x2122, 0x00b4, 0x00a8, 0x2260, 0x00c6, 0x00d8,
  0x221e, 0x00b1, 0x2264, 0x2265, 0x00a5, 0x00b5, 0x2202, 0x2211,
  0x220f, 0x03c0, 0x222b, 0x00aa, 0x00ba, 0x03a9, 0x00e6, 0x00f8,
  0x00bf, 0x00a1, 0x00ac, 0x221a, 0x0192, 0x2248, 0x2206, 0x00ab,
  0x00bb, 0x2026, 0x00a0, 0x00c0, 0x00c3, 0x00d5, 0x0152, 0x0153,
  0x2013, 0x2014, 0x201c, 0x201d, 0x2018, 0x2019, 0x00f7, 0x25ca,
  0x00ff, 0x0178, 0x2044, 0x20ac, 0x2039, 0x203a, 0xfb01, 0xfb02,
  0x2021, 0x00b7, 0x201a, 0x201e, 0x2030, 0x00c2, 0x00ca, 0x00c1,
  0x00cb, 0x00c8, 0x00cd, 0x00ce, 0x00cf, 0x00cc, 0x00d3, 0x00d4,
  0xf8ff, 0x00d2, 0x00da, 0x00db, 0x00d9, 0x0131, 0x02c6, 0x02dc,
  0x00af, 0x02d8, 0x02d9, 0x02da, 0x00b8, 0x02dd, 0x02db, 0x02c7,
];

/** StandardEncoding's upper half, as `code:glyphname`. */
const STANDARD_HIGH = ('161:exclamdown 162:cent 163:sterling 164:fraction 165:yen 166:florin 167:section '
  + '168:currency 169:quotesingle 170:quotedblleft 171:guillemotleft 172:guilsinglleft 173:guilsinglright '
  + '174:fi 175:fl 177:endash 178:dagger 179:daggerdbl 180:periodcentered 182:paragraph 183:bullet '
  + '184:quotesinglbase 185:quotedblbase 186:quotedblright 187:guillemotright 188:ellipsis 189:perthousand '
  + '191:questiondown 193:grave 194:acute 195:circumflex 196:tilde 197:macron 198:breve 199:dotaccent '
  + '200:dieresis 202:ring 203:cedilla 205:hungarumlaut 206:ogonek 207:caron 208:emdash 225:AE '
  + '227:ordfeminine 232:Lslash 233:Oslash 234:OE 235:ordmasculine 241:ae 245:dotlessi 248:lslash '
  + '249:oslash 250:oe 251:germandbls');

/**
 * Build a 256-entry code → text table.
 * @param {'WinAnsiEncoding'|'MacRomanEncoding'|'StandardEncoding'|'PDFDocEncoding'} which
 * @returns {(string|null)[]}
 */
function buildEncoding(which) {
  /** @type {(string|null)[]} */
  const table = new Array(256).fill(null);
  for (let c = 32; c <= 126; c++) table[c] = String.fromCharCode(c);
  if (which === 'StandardEncoding') {
    table[39] = '’';                          // quoteright
    table[96] = '‘';                          // quoteleft
    for (const pair of STANDARD_HIGH.split(/\s+/)) {
      const [code, glyph] = pair.split(':');
      const value = glyphNameToUnicode(glyph);
      if (value) table[Number(code)] = value;
    }
    return table;
  }
  if (which === 'MacRomanEncoding') {
    for (let i = 0; i < MACROMAN_HIGH.length; i++) table[128 + i] = String.fromCharCode(MACROMAN_HIGH[i]);
    return table;
  }
  // WinAnsi and PDFDoc agree with Latin-1 above 160.
  for (let i = 0; i < CP1252_C1.length; i++) table[128 + i] = String.fromCharCode(CP1252_C1[i]);
  for (let c = 160; c <= 255; c++) table[c] = String.fromCharCode(c);
  return table;
}

export const WIN_ANSI_ENCODING = buildEncoding('WinAnsiEncoding');
export const MAC_ROMAN_ENCODING = buildEncoding('MacRomanEncoding');
export const STANDARD_ENCODING = buildEncoding('StandardEncoding');

/**
 * @param {string|null} name
 * @returns {(string|null)[]}
 */
export function baseEncodingByName(name) {
  switch (name) {
    case 'WinAnsiEncoding': return WIN_ANSI_ENCODING;
    case 'MacRomanEncoding': return MAC_ROMAN_ENCODING;
    case 'MacExpertEncoding': return STANDARD_ENCODING;
    case 'StandardEncoding': return STANDARD_ENCODING;
    default: return STANDARD_ENCODING;
  }
}

// ---------------------------------------------------------------------------
// ToUnicode CMaps
// ---------------------------------------------------------------------------

/**
 * @typedef {object} CMap
 * @property {Map<number, string>} single      code → text
 * @property {{low: number, high: number, dst: number|string[], bytes: number}[]} ranges
 * @property {Set<number>} codeLengths         byte widths declared by the codespace
 */

/**
 * Convert a UTF-16BE byte string (the CMap destination form) into text.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function utf16beToString(bytes) {
  let s = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
  if (bytes.length === 1) s = String.fromCharCode(bytes[0]);
  return s;
}

/**
 * @param {Uint8Array} bytes
 * @returns {number}
 */
function bytesToInt(bytes) {
  let value = 0;
  for (let i = 0; i < bytes.length; i++) value = value * 256 + bytes[i];
  return value;
}

/**
 * Parse a `ToUnicode` CMap stream.
 * @param {Uint8Array} data
 * @returns {CMap}
 */
export function parseCMap(data) {
  /** @type {CMap} */
  const cmap = { single: new Map(), ranges: [], codeLengths: new Set() };
  const lexer = new Lexer(data, 0);
  /** @type {any[]} */
  let stack = [];
  let guard = 0;

  while (!lexer.atEnd && guard < 2_000_000) {
    guard += 1;
    const before = lexer.pos;
    const token = lexer.parseObject({ allowOperators: true });
    if (lexer.pos === before) { lexer.pos += 1; continue; }
    if (token === undefined) continue;

    if (!(token instanceof Operator)) {
      stack.push(token);
      if (stack.length > 4096) stack = stack.slice(-1024);
      continue;
    }

    switch (token.op) {
      case 'begincodespacerange': {
        /** @type {any[]} */
        const items = readUntil(lexer, 'endcodespacerange');
        for (let i = 0; i + 1 < items.length; i += 2) {
          if (items[i] instanceof PdfString) cmap.codeLengths.add(items[i].bytes.length);
        }
        stack = [];
        break;
      }
      case 'beginbfchar': {
        const items = readUntil(lexer, 'endbfchar');
        for (let i = 0; i + 1 < items.length; i += 2) {
          const src = items[i];
          const dst = items[i + 1];
          if (!(src instanceof PdfString)) continue;
          cmap.codeLengths.add(src.bytes.length);
          const code = bytesToInt(src.bytes);
          if (dst instanceof PdfString) cmap.single.set(code, utf16beToString(dst.bytes));
          else if (dst instanceof Name) {
            const value = glyphNameToUnicode(dst.name);
            if (value) cmap.single.set(code, value);
          }
        }
        stack = [];
        break;
      }
      case 'beginbfrange': {
        const items = readUntil(lexer, 'endbfrange');
        for (let i = 0; i + 2 < items.length; i += 3) {
          const low = items[i];
          const high = items[i + 1];
          const dst = items[i + 2];
          if (!(low instanceof PdfString) || !(high instanceof PdfString)) continue;
          cmap.codeLengths.add(low.bytes.length);
          const lowValue = bytesToInt(low.bytes);
          const highValue = bytesToInt(high.bytes);
          if (Array.isArray(dst)) {
            dst.forEach((entry, k) => {
              if (entry instanceof PdfString) cmap.single.set(lowValue + k, utf16beToString(entry.bytes));
              else if (entry instanceof Name) {
                const value = glyphNameToUnicode(entry.name);
                if (value) cmap.single.set(lowValue + k, value);
              }
            });
            continue;
          }
          if (dst instanceof PdfString) {
            // The destination increments in its last code unit.
            const base = dst.bytes;
            const prefix = utf16beToString(base.subarray(0, Math.max(0, base.length - 2)));
            const lastUnit = base.length >= 2 ? (base[base.length - 2] << 8) | base[base.length - 1] : base[0] || 0;
            const span = Math.min(highValue - lowValue, 65535);
            for (let k = 0; k <= span; k++) {
              cmap.single.set(lowValue + k, prefix + String.fromCharCode((lastUnit + k) & 0xffff));
            }
          }
        }
        stack = [];
        break;
      }
      case 'usecmap':
      case 'endcmap':
        stack = [];
        break;
      default:
        stack = [];
        break;
    }
  }
  return cmap;
}

/**
 * Read objects until an operator is seen.
 * @param {Lexer} lexer
 * @param {string} stop
 * @returns {any[]}
 */
function readUntil(lexer, stop) {
  /** @type {any[]} */
  const items = [];
  let guard = 0;
  while (!lexer.atEnd && guard < 200000) {
    guard += 1;
    const before = lexer.pos;
    const token = lexer.parseObject({ allowOperators: true });
    if (lexer.pos === before) { lexer.pos += 1; continue; }
    if (token instanceof Operator) {
      if (token.op === stop) break;
      continue;
    }
    if (token !== undefined) items.push(token);
  }
  return items;
}

// ---------------------------------------------------------------------------
// Font decoders
// ---------------------------------------------------------------------------

/**
 * Decodes the byte strings inside a content stream's text-showing operators
 * into characters, for one font.
 */
export class FontDecoder {
  /**
   * @param {object} options
   * @param {(string|null)[]} [options.table]        code → text, for simple fonts
   * @param {CMap|null} [options.cmap]               a `ToUnicode` CMap
   * @param {number} [options.codeBytes]             1 for simple fonts, 2 for Identity-H
   * @param {string} [options.name]
   * @param {boolean} [options.identity]
   */
  constructor(options = {}) {
    this.table = options.table || STANDARD_ENCODING;
    this.cmap = options.cmap || null;
    this.codeBytes = options.codeBytes || 1;
    this.name = options.name || '';
    this.identity = options.identity === true;
  }

  /**
   * @param {Uint8Array} bytes
   * @returns {string}
   */
  decode(bytes) {
    let out = '';
    const width = this.codeBytes;
    for (let i = 0; i < bytes.length; i += width) {
      let code = bytes[i];
      if (width === 2) code = (bytes[i] << 8) | (bytes[i + 1] || 0);
      out += this.decodeCode(code);
    }
    return out;
  }

  /**
   * @param {number} code
   * @returns {string}
   */
  decodeCode(code) {
    if (this.cmap) {
      const mapped = this.cmap.single.get(code);
      if (mapped !== undefined) return mapped;
    }
    if (this.codeBytes === 1) {
      const mapped = this.table[code];
      if (mapped) return mapped;
      if (code >= 32 && code < 127) return String.fromCharCode(code);
      return '';
    }
    // A composite font with no usable ToUnicode: Identity CID values are glyph
    // indices, and guessing at them would invent text that is not in the file.
    if (this.identity) return '';
    return code >= 32 && code < 0x110000 ? String.fromCodePoint(code) : '';
  }
}

/**
 * Build a decoder for one font dictionary.
 *
 * @param {import('./document.js').PdfDocument} doc
 * @param {Record<string, any>} font
 * @returns {FontDecoder}
 */
export function buildFontDecoder(doc, font) {
  const subtype = nameOf(doc.dictGet(font, 'Subtype'));
  const baseFont = nameOf(doc.dictGet(font, 'BaseFont')) || '';

  /** @type {CMap|null} */
  let cmap = null;
  const toUnicode = doc.dictGet(font, 'ToUnicode');
  if (toUnicode && toUnicode.raw !== undefined) {
    const data = doc.decode(toUnicode);
    if (data && data.length) {
      try { cmap = parseCMap(data); } catch { cmap = null; }
    }
  }

  if (subtype === 'Type0') {
    const encoding = doc.dictGet(font, 'Encoding');
    const encodingName = nameOf(encoding) || '';
    let codeBytes = 2;
    if (cmap && cmap.codeLengths.size === 1) codeBytes = /** @type {number} */ (Array.from(cmap.codeLengths)[0]);
    else if (/Identity/.test(encodingName)) codeBytes = 2;
    else if (encoding && encoding.raw !== undefined) {
      const data = doc.decode(encoding);
      if (data) {
        const embedded = parseCMap(data);
        if (embedded.codeLengths.size === 1) codeBytes = /** @type {number} */ (Array.from(embedded.codeLengths)[0]);
      }
    }
    return new FontDecoder({
      cmap,
      codeBytes: codeBytes === 1 ? 1 : 2,
      name: baseFont,
      identity: /Identity/.test(encodingName),
    });
  }

  // Simple font: base encoding, then Differences on top.
  const encoding = doc.dictGet(font, 'Encoding');
  /** @type {(string|null)[]} */
  let table;
  const symbolic = isSymbolic(doc, font);
  if (encoding instanceof Name) {
    table = baseEncodingByName(encoding.name).slice();
  } else if (encoding && typeof encoding === 'object' && !Array.isArray(encoding)) {
    const base = nameOf(doc.dictGet(encoding, 'BaseEncoding'));
    table = (base ? baseEncodingByName(base) : (symbolic ? STANDARD_ENCODING : WIN_ANSI_ENCODING)).slice();
    const differences = doc.dictGet(encoding, 'Differences');
    if (Array.isArray(differences)) {
      let code = 0;
      for (const entry of differences) {
        const value = doc.resolve(entry);
        if (typeof value === 'number') { code = Math.floor(value); continue; }
        const glyph = nameOf(value);
        if (glyph === null) continue;
        if (code >= 0 && code < 256) table[code] = glyphNameToUnicode(glyph);
        code += 1;
      }
    }
  } else {
    table = (symbolic ? STANDARD_ENCODING : WIN_ANSI_ENCODING).slice();
  }

  return new FontDecoder({ table, cmap, codeBytes: 1, name: baseFont });
}

/**
 * @param {import('./document.js').PdfDocument} doc
 * @param {Record<string, any>} font
 * @returns {boolean}
 */
function isSymbolic(doc, font) {
  const descriptor = doc.dictGet(font, 'FontDescriptor');
  const flags = descriptor ? Number(doc.dictGet(descriptor, 'Flags') || 0) : 0;
  // Bit 3 (value 4) is the symbolic flag; bit 6 (value 32) is non-symbolic.
  return (flags & 4) !== 0 && (flags & 32) === 0;
}
