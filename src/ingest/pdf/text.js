/**
 * Text extraction from PDF content streams (D9).
 *
 * A content stream places glyphs, not words: there is no space character in a
 * PDF unless the author put one there, and most typesetters do not. Getting
 * readable text back therefore means running the text-positioning machinery for
 * real — the text matrix, the line matrix, the CTM, per-glyph advance widths —
 * and inferring word and line breaks from geometry.
 *
 * That is what this module does. It walks the operators, tracks the state, and
 * emits positioned runs; a second pass groups runs into lines, lines into
 * paragraphs, and paragraphs into `ContentBlock`s, promoting a line to a
 * heading when its type is measurably larger than the page's body size.
 *
 * @module ingest/pdf/text
 */

import { Lexer, Name, PdfString, PdfStream, Operator, nameOf, findKeyword } from './lexer.js';
import { buildFontDecoder } from './encoding.js';
import { metricsFor, advanceOfString, normalizeFamily } from '../../core/text-metrics.js';

/** @typedef {import('./document.js').PdfDocument} PdfDocument */
/** @typedef {import('../../core/contracts.js').ContentBlock} ContentBlock */

/**
 * @typedef {object} TextRun
 * @property {string} text
 * @property {number} x        device x of the run's origin
 * @property {number} y        device y of the run's origin
 * @property {number} width    device width of the run
 * @property {number} size     effective font size in device units
 * @property {string} font
 * @property {number} page
 */

const IDENTITY = [1, 0, 0, 1, 0, 0];

/**
 * Matrix product `a` then `b`.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number[]}
 */
export function multiply(a, b) {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

/**
 * The uniform scale a matrix applies, used to turn a text-space font size into
 * a device-space one.
 * @param {number[]} m
 * @returns {number}
 */
function scaleOf(m) {
  const sx = Math.hypot(m[0], m[1]);
  const sy = Math.hypot(m[2], m[3]);
  const scale = (sx + sy) / 2;
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/**
 * Per-code advance widths for one font, in 1/1000 text-space units.
 */
class WidthTable {
  /**
   * @param {PdfDocument} doc
   * @param {Record<string, any>} font
   */
  constructor(doc, font) {
    /** @type {Map<number, number>} */
    this.widths = new Map();
    this.defaultWidth = 500;
    /** @type {import('../../core/text-metrics.js').ResolvedMetrics|null} */
    this.metrics = null;

    const subtype = nameOf(doc.dictGet(font, 'Subtype'));
    const baseFont = (nameOf(doc.dictGet(font, 'BaseFont')) || '').replace(/^[A-Z]{6}\+/, '');

    if (subtype === 'Type0') {
      const descendants = doc.dictGet(font, 'DescendantFonts');
      const descendant = Array.isArray(descendants) ? doc.resolve(descendants[0]) : null;
      if (descendant) {
        const dw = doc.dictGet(descendant, 'DW');
        this.defaultWidth = typeof dw === 'number' ? dw : 1000;
        const w = doc.dictGet(descendant, 'W');
        if (Array.isArray(w)) this.readCidWidths(doc, w);
      } else {
        this.defaultWidth = 1000;
      }
      return;
    }

    const firstChar = Number(doc.dictGet(font, 'FirstChar'));
    const widths = doc.dictGet(font, 'Widths');
    if (Array.isArray(widths) && Number.isFinite(firstChar)) {
      widths.forEach((entry, i) => {
        const value = doc.resolve(entry);
        if (typeof value === 'number') this.widths.set(firstChar + i, value);
      });
    }
    const descriptor = doc.dictGet(font, 'FontDescriptor');
    const missing = descriptor ? doc.dictGet(descriptor, 'MissingWidth') : null;
    if (typeof missing === 'number') this.defaultWidth = missing;

    if (!this.widths.size) {
      // A standard-14 font carries no `/Widths`. `core/text-metrics.js` owns the
      // published advance tables (D7), so the measurement is the same one the
      // rest of the product uses rather than a second guess.
      this.metrics = metricsFor(normalizeFamily(baseFont || 'Helvetica'), /Bold/i.test(baseFont) ? 700 : 400);
      if (/Courier|Mono/i.test(baseFont)) this.defaultWidth = 600;
    }
  }

  /**
   * `/W` is `[ c [w1 w2 …] cFirst cLast w … ]`.
   * @param {PdfDocument} doc
   * @param {any[]} w
   */
  readCidWidths(doc, w) {
    let i = 0;
    while (i < w.length) {
      const first = Number(doc.resolve(w[i]));
      const second = doc.resolve(w[i + 1]);
      if (Array.isArray(second)) {
        second.forEach((entry, k) => {
          const value = Number(doc.resolve(entry));
          if (Number.isFinite(value)) this.widths.set(first + k, value);
        });
        i += 2;
        continue;
      }
      const last = Number(second);
      const value = Number(doc.resolve(w[i + 2]));
      if (Number.isFinite(first) && Number.isFinite(last) && Number.isFinite(value) && last - first < 65536) {
        for (let c = first; c <= last; c++) this.widths.set(c, value);
      }
      i += 3;
    }
  }

  /**
   * @param {number} code
   * @param {string} text  the characters the code produced, for the metric path
   * @returns {number}
   */
  advance(code, text) {
    const known = this.widths.get(code);
    if (known !== undefined) return known;
    if (this.metrics && text) return advanceOfString(text, this.metrics);
    return this.defaultWidth;
  }
}

/**
 * One font resource, resolved once per page.
 */
class ResolvedFont {
  /**
   * @param {PdfDocument} doc
   * @param {Record<string, any>} font
   */
  constructor(doc, font) {
    this.decoder = buildFontDecoder(doc, font);
    this.widths = new WidthTable(doc, font);
    this.name = (nameOf(doc.dictGet(font, 'BaseFont')) || '').replace(/^[A-Z]{6}\+/, '');
  }
}

/**
 * Extract positioned text runs from one page.
 *
 * @param {PdfDocument} doc
 * @param {Record<string, any>} page
 * @param {number} pageNumber
 * @returns {TextRun[]}
 */
export function extractPageRuns(doc, page, pageNumber) {
  const content = doc.pageContent(page);
  if (!content.length) return [];
  const resources = doc.dictGet(page, 'Resources') || null;
  /** @type {TextRun[]} */
  const runs = [];
  runContentStream(doc, content, resources, IDENTITY, pageNumber, runs, 0, new Map());
  return runs;
}

/**
 * @param {PdfDocument} doc
 * @param {Uint8Array} content
 * @param {Record<string, any>|null} resources
 * @param {number[]} baseCtm
 * @param {number} pageNumber
 * @param {TextRun[]} out
 * @param {number} depth
 * @param {Map<any, ResolvedFont>} fontCache
 */
function runContentStream(doc, content, resources, baseCtm, pageNumber, out, depth, fontCache) {
  if (depth > 8) return;
  const lexer = new Lexer(content, 0);
  /** @type {any[]} */
  let operands = [];
  /** @type {number[][]} */
  const ctmStack = [];
  let ctm = baseCtm.slice();

  let tm = IDENTITY.slice();
  let tlm = IDENTITY.slice();
  /** @type {ResolvedFont|null} */
  let font = null;
  let fontSize = 0;
  let charSpacing = 0;
  let wordSpacing = 0;
  let horizontalScale = 1;
  let leading = 0;
  let rise = 0;
  let renderMode = 0;

  const fontResources = resources ? doc.dictGet(resources, 'Font') : null;
  const xobjectResources = resources ? doc.dictGet(resources, 'XObject') : null;

  /**
   * @param {string} name
   * @returns {ResolvedFont|null}
   */
  const lookupFont = (name) => {
    if (!fontResources) return null;
    const raw = fontResources[name];
    if (raw === undefined) return null;
    const key = raw && raw.key !== undefined ? raw.key : raw;
    const cached = fontCache.get(key);
    if (cached) return cached;
    const dict = doc.resolve(raw);
    if (!dict || typeof dict !== 'object') return null;
    const resolved = new ResolvedFont(doc, dict);
    fontCache.set(key, resolved);
    return resolved;
  };

  /**
   * Show one string, advancing the text matrix exactly as a viewer would.
   * @param {Uint8Array} bytes
   */
  const show = (bytes) => {
    if (!font || !bytes.length) {
      return;
    }
    const width = font.decoder.codeBytes;
    const trm = multiply(multiply([fontSize * horizontalScale, 0, 0, fontSize, 0, rise], tm), ctm);
    const startX = trm[4];
    const startY = trm[5];
    const size = fontSize * scaleOf(multiply(tm, ctm));

    let text = '';
    let advance = 0;
    for (let i = 0; i < bytes.length; i += width) {
      const code = width === 2 ? ((bytes[i] << 8) | (bytes[i + 1] || 0)) : bytes[i];
      const glyph = font.decoder.decodeCode(code);
      text += glyph;
      const w = font.widths.advance(code, glyph) / 1000;
      let step = w * fontSize + charSpacing;
      if (width === 1 && code === 32) step += wordSpacing;
      advance += step * horizontalScale;
    }
    tm = multiply([1, 0, 0, 1, advance, 0], tm);

    if (renderMode === 3 || renderMode === 7) return;    // invisible text (OCR layers)
    if (!text) return;
    const endTrm = multiply(multiply([fontSize * horizontalScale, 0, 0, fontSize, 0, rise], tm), ctm);
    out.push({
      text,
      x: startX,
      y: startY,
      width: Math.hypot(endTrm[4] - startX, endTrm[5] - startY),
      size: size || fontSize,
      font: font.name,
      page: pageNumber,
    });
  };

  let guard = 0;
  while (!lexer.atEnd && guard < 5_000_000) {
    guard += 1;
    const before = lexer.pos;
    const token = lexer.parseObject({ allowOperators: true });
    if (lexer.pos === before) { lexer.pos += 1; continue; }
    if (token === undefined) continue;
    if (!(token instanceof Operator)) {
      operands.push(token);
      if (operands.length > 64) operands = operands.slice(-32);
      continue;
    }

    const op = token.op;
    const num = (i) => {
      const value = operands[operands.length - i];
      return typeof value === 'number' && Number.isFinite(value) ? value : 0;
    };

    switch (op) {
      case 'q': ctmStack.push(ctm.slice()); break;
      case 'Q': ctm = ctmStack.pop() || ctm; break;
      case 'cm':
        if (operands.length >= 6) {
          ctm = multiply([num(6), num(5), num(4), num(3), num(2), num(1)], ctm);
        }
        break;
      case 'BT': tm = IDENTITY.slice(); tlm = IDENTITY.slice(); break;
      case 'ET': break;
      case 'Tf': {
        const size = num(1);
        const nameToken = operands[operands.length - 2];
        const resolved = nameToken instanceof Name ? lookupFont(nameToken.name) : null;
        if (resolved) font = resolved;
        fontSize = size;
        break;
      }
      case 'Td':
        tlm = multiply([1, 0, 0, 1, num(2), num(1)], tlm);
        tm = tlm.slice();
        break;
      case 'TD':
        leading = -num(1);
        tlm = multiply([1, 0, 0, 1, num(2), num(1)], tlm);
        tm = tlm.slice();
        break;
      case 'Tm':
        if (operands.length >= 6) {
          tlm = [num(6), num(5), num(4), num(3), num(2), num(1)];
          tm = tlm.slice();
        }
        break;
      case 'T*':
        tlm = multiply([1, 0, 0, 1, 0, -leading], tlm);
        tm = tlm.slice();
        break;
      case 'TL': leading = num(1); break;
      case 'Tc': charSpacing = num(1); break;
      case 'Tw': wordSpacing = num(1); break;
      case 'Tz': horizontalScale = num(1) / 100 || 1; break;
      case 'Ts': rise = num(1); break;
      case 'Tr': renderMode = num(1); break;
      case 'Tj': {
        const value = operands[operands.length - 1];
        if (value instanceof PdfString) show(value.bytes);
        break;
      }
      case "'": {
        tlm = multiply([1, 0, 0, 1, 0, -leading], tlm);
        tm = tlm.slice();
        const value = operands[operands.length - 1];
        if (value instanceof PdfString) show(value.bytes);
        break;
      }
      case '"': {
        wordSpacing = num(3);
        charSpacing = num(2);
        tlm = multiply([1, 0, 0, 1, 0, -leading], tlm);
        tm = tlm.slice();
        const value = operands[operands.length - 1];
        if (value instanceof PdfString) show(value.bytes);
        break;
      }
      case 'TJ': {
        const array = operands[operands.length - 1];
        if (Array.isArray(array)) {
          for (const entry of array) {
            if (entry instanceof PdfString) { show(entry.bytes); continue; }
            if (typeof entry === 'number' && Number.isFinite(entry)) {
              const shift = (-entry / 1000) * fontSize * horizontalScale;
              tm = multiply([1, 0, 0, 1, shift, 0], tm);
            }
          }
        }
        break;
      }
      case 'Do': {
        const nameToken = operands[operands.length - 1];
        const key = nameOf(nameToken);
        if (key && xobjectResources) {
          const xobject = doc.resolve(xobjectResources[key]);
          if (xobject instanceof PdfStream && nameOf(doc.dictGet(xobject.dict, 'Subtype')) === 'Form') {
            const data = doc.decode(xobject);
            if (data && data.length) {
              const matrix = doc.dictGet(xobject.dict, 'Matrix');
              const formCtm = Array.isArray(matrix) && matrix.length === 6
                ? multiply(matrix.map(Number), ctm)
                : ctm;
              const formResources = doc.dictGet(xobject.dict, 'Resources') || resources;
              runContentStream(doc, data, formResources, formCtm, pageNumber, out, depth + 1, fontCache);
            }
          }
        }
        break;
      }
      case 'BI': {
        // Inline image: its binary data is not object syntax, so skip past `EI`
        // rather than letting the lexer try to read it.
        const at = findKeyword(content, lexer.pos, 'EI');
        lexer.pos = at < 0 ? content.length : at + 2;
        break;
      }
      default:
        break;
    }
    operands = [];
  }
}

// ---------------------------------------------------------------------------
// Runs → lines → blocks
// ---------------------------------------------------------------------------

/**
 * @typedef {object} TextLine
 * @property {string} text
 * @property {number} x
 * @property {number} y
 * @property {number} size
 * @property {number} page
 */

/**
 * Group runs into lines. Runs on the same baseline join; a horizontal gap wider
 * than a quarter of the type size becomes a space, which is how a PDF's missing
 * spaces are recovered.
 *
 * @param {TextRun[]} runs
 * @returns {TextLine[]}
 */
export function groupLines(runs) {
  if (!runs.length) return [];
  const sorted = runs.slice().sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    if (Math.abs(a.y - b.y) > lineTolerance(a, b)) return b.y - a.y;   // PDF y grows upward
    return a.x - b.x;
  });

  /** @type {TextLine[]} */
  const lines = [];
  /** @type {TextRun[]} */
  let current = [];

  const flush = () => {
    if (!current.length) return;
    const ordered = current.slice().sort((a, b) => a.x - b.x);
    let text = '';
    let previousEnd = null;
    let maxSize = 0;
    for (const run of ordered) {
      if (previousEnd !== null) {
        const gap = run.x - previousEnd;
        const threshold = Math.max(0.18 * (run.size || 10), 0.5);
        if (gap > threshold && !/\s$/.test(text) && !/^\s/.test(run.text)) text += ' ';
      }
      text += run.text;
      previousEnd = run.x + run.width;
      if (run.size > maxSize) maxSize = run.size;
    }
    const trimmed = text.replace(/\s+/g, ' ').trim();
    if (trimmed) {
      lines.push({ text: trimmed, x: ordered[0].x, y: ordered[0].y, size: maxSize, page: ordered[0].page });
    }
    current = [];
  };

  for (const run of sorted) {
    if (!current.length) { current.push(run); continue; }
    const previous = current[current.length - 1];
    if (run.page !== previous.page || Math.abs(run.y - previous.y) > lineTolerance(run, previous)) flush();
    current.push(run);
  }
  flush();
  return lines;
}

/**
 * @param {TextRun|TextLine} a
 * @param {TextRun|TextLine} b
 * @returns {number}
 */
function lineTolerance(a, b) {
  return Math.max(0.35 * Math.max(a.size || 0, b.size || 0), 1.2);
}

/**
 * Turn lines into content blocks: headings by relative type size, list items by
 * their marker, paragraphs by vertical rhythm.
 *
 * @param {TextLine[]} lines
 * @returns {ContentBlock[]}
 */
export function linesToBlocks(lines) {
  /** @type {ContentBlock[]} */
  const blocks = [];
  if (!lines.length) return blocks;

  const bodySize = modalSize(lines);
  const headingSizes = Array.from(new Set(
    lines.map((l) => round(l.size)).filter((s) => s > bodySize * 1.14),
  )).sort((a, b) => b - a).slice(0, 6);

  /** @type {TextLine[]} */
  let paragraph = [];
  /** @type {{items: string[], ordered: boolean}|null} */
  let list = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const text = joinLines(paragraph.map((l) => l.text));
    if (text) blocks.push({ type: 'paragraph', text });
    paragraph = [];
  };
  const flushList = () => {
    if (list && list.items.length) blocks.push({ type: 'list', ordered: list.ordered, items: list.items });
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const previous = lines[i - 1];
    const size = round(line.size);
    const headingIndex = headingSizes.indexOf(size);

    if (headingIndex >= 0 && line.text.length <= 160) {
      flushParagraph();
      flushList();
      blocks.push({ type: 'heading', level: /** @type {1|2|3|4|5|6} */ (Math.min(6, headingIndex + 1)), text: line.text });
      continue;
    }

    const bullet = line.text.match(/^([•·▪◦‣*•●-])\s+(.+)$/);
    const numbered = line.text.match(/^(\d{1,2})[.)]\s+(.+)$/);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = Boolean(numbered);
      if (list && list.ordered !== ordered) flushList();
      if (!list) list = { items: [], ordered };
      list.items.push((bullet ? bullet[2] : /** @type {RegExpMatchArray} */ (numbered)[2]).trim());
      continue;
    }

    // A continuation line under a list item belongs to it.
    if (list && previous && line.page === previous.page && line.x > previous.x + 2
      && Math.abs(previous.y - line.y) < 2.2 * Math.max(line.size, 1)) {
      list.items[list.items.length - 1] = `${list.items[list.items.length - 1]} ${line.text}`;
      continue;
    }
    flushList();

    if (previous && startsNewParagraph(previous, line)) flushParagraph();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return blocks;
}

/**
 * @param {TextLine} previous
 * @param {TextLine} line
 * @returns {boolean}
 */
function startsNewParagraph(previous, line) {
  if (line.page !== previous.page) return true;
  const gap = previous.y - line.y;
  const leading = Math.max(previous.size, line.size, 1);
  if (gap > leading * 1.75) return true;
  if (gap < 0) return true;                                   // a new column
  if (Math.abs(line.x - previous.x) > leading * 1.5) return true;
  if (/[.!?:;]["')\]]?$/.test(previous.text) && line.x > previous.x + 1) return true;
  return false;
}

/**
 * Join wrapped lines, repairing hyphenation.
 * @param {string[]} lines
 * @returns {string}
 */
export function joinLines(lines) {
  let out = '';
  for (const line of lines) {
    if (!out) { out = line; continue; }
    if (/[‐-]$/.test(out) && /^[a-z]/.test(line)) out = `${out.slice(0, -1)}${line}`;
    else out = `${out} ${line}`;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * The most common type size, weighted by how much text is set in it — a page
 * with one giant headline still has a body size.
 * @param {TextLine[]} lines
 * @returns {number}
 */
export function modalSize(lines) {
  /** @type {Map<number, number>} */
  const weights = new Map();
  for (const line of lines) {
    const size = round(line.size);
    weights.set(size, (weights.get(size) || 0) + Math.max(1, line.text.length));
  }
  let best = 0;
  let bestWeight = -1;
  for (const [size, weight] of weights) {
    if (weight > bestWeight || (weight === bestWeight && size < best)) { best = size; bestWeight = weight; }
  }
  return best || 10;
}

/**
 * @param {number} n
 * @returns {number}
 */
function round(n) { return Math.round((Number.isFinite(n) ? n : 0) * 10) / 10; }

/**
 * Drop running heads and folios: lines that repeat verbatim at the same
 * position on three or more pages are furniture, not content.
 * @param {TextLine[]} lines
 * @param {number} pageCount
 * @returns {TextLine[]}
 */
export function stripRunningHeads(lines, pageCount) {
  if (pageCount < 3) return lines;
  /** @type {Map<string, Set<number>>} */
  const byKey = new Map();
  for (const line of lines) {
    const key = `${Math.round(line.y)}|${line.text.replace(/\d+/g, '#')}`;
    const pages = byKey.get(key) || new Set();
    pages.add(line.page);
    byKey.set(key, pages);
  }
  const threshold = Math.max(3, Math.ceil(pageCount * 0.6));
  return lines.filter((line) => {
    const key = `${Math.round(line.y)}|${line.text.replace(/\d+/g, '#')}`;
    const pages = byKey.get(key);
    return !pages || pages.size < threshold;
  });
}
