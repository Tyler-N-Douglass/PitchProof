/**
 * Deterministic text primitives shared by every L7 module.
 *
 * Nothing here invents content. Every function is a pure transformation of a
 * string that was already in the specimen, or a structural classification of
 * one. §18.2 is a property of this file as much as of `facts.js`: the recipe
 * templates can only reach text through these helpers, and none of them can
 * produce a numeral, a brand name or a quotation that was not handed to them.
 *
 * @module recipe/text
 */

/** Characters that open or close a quotation in the corpora we care about. */
export const QUOTE_PAIRS = [
  ['“', '”'], // “ ”
  ['‘', '’'], // ‘ ’
  ['«', '»'], // « »
  ['„', '“'], // „ “  (German)
  ['「', '」'], // 「 」 (Japanese)
  ['"', '"'],
];

/** Currency symbols recognised when classifying a numeric token. */
export const CURRENCY_SYMBOLS = '$€£¥₹₽₩¢₦₪฿₫';

/** ISO 4217 codes common enough in marketing copy to be worth recognising. */
export const CURRENCY_CODES = [
  'USD', 'EUR', 'GBP', 'JPY', 'CNY', 'RUB', 'BRL', 'MXN', 'SAR', 'AED',
  'CAD', 'AUD', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'INR', 'KRW', 'ZAR',
];

/** Unicode spaces that appear as digit-group separators. */
const NUM_SPACES = '   ';

/**
 * Collapse runs of whitespace, normalise line endings, and trim.
 * @param {string} s
 * @returns {string}
 */
export function normalizeWhitespace(s) {
  return String(s == null ? '' : s)
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f   ]+/g, ' ')
    .replace(/[ ]{2,}/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/**
 * Collapse to a single line. Used wherever a block's text must be compared or
 * measured rather than displayed.
 * @param {string} s
 * @returns {string}
 */
export function flatten(s) {
  return normalizeWhitespace(s).replace(/\n+/g, ' ').trim();
}

/**
 * Lowercase word tokens with punctuation stripped. Digits survive as their own
 * tokens so that similarity scoring notices when a number changed.
 * @param {string} s
 * @returns {string[]}
 */
export function tokenize(s) {
  const flat = flatten(s).toLowerCase();
  const out = [];
  const re = /[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu;
  let m;
  while ((m = re.exec(flat)) !== null) out.push(m[0]);
  return out;
}

/**
 * Character bigrams of a token list, joined per token. Used by the alignment
 * similarity to see through small edits ("Pricing" vs "Pricing plans").
 * @param {string[]} tokens
 * @returns {string[]}
 */
export function bigrams(tokens) {
  const out = [];
  for (const t of tokens) {
    if (t.length < 2) { out.push(t); continue; }
    for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
  }
  return out;
}

/**
 * Dice coefficient over two multisets of strings. Symmetric, 0..1, and 1 only
 * for identical multisets.
 * @param {string[]} a
 * @param {string[]} b
 * @returns {number}
 */
export function diceCoefficient(a, b) {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const x of a) counts.set(x, (counts.get(x) || 0) + 1);
  let shared = 0;
  for (const y of b) {
    const n = counts.get(y) || 0;
    if (n > 0) { shared += 1; counts.set(y, n - 1); }
  }
  return (2 * shared) / (a.length + b.length);
}

/**
 * @typedef {object} NumericToken
 * @property {string} text        the token exactly as it appeared
 * @property {number} start       index into the scanned string
 * @property {number} end
 * @property {string} digits      every digit in the token, in order
 * @property {string[]} groups    the token's digit runs, in order
 * @property {'plain'|'percent'|'currency'|'multiplier'} kind
 */

const NUM_CORE = new RegExp(`\\d[\\d.,'’/:\\-${NUM_SPACES}]*\\d|\\d`, 'g');

/**
 * Find every numeric token in a string, with its symbol classification.
 *
 * The classification matters for §18.2: turning `12` into `12%` fabricates a
 * statistic even though the digits are unchanged, so the guard compares the
 * symbol class as well as the digits.
 *
 * @param {string} s
 * @returns {NumericToken[]}
 */
export function numericTokens(s) {
  const text = String(s == null ? '' : s);
  /** @type {NumericToken[]} */
  const out = [];
  NUM_CORE.lastIndex = 0;
  let m;
  while ((m = NUM_CORE.exec(text)) !== null) {
    let start = m.index;
    let end = m.index + m[0].length;
    /** @type {'plain'|'percent'|'currency'|'multiplier'} */
    let kind = 'plain';

    // Look left for a currency symbol or an ISO code, allowing one space.
    let l = start;
    while (l > 0 && text[l - 1] === ' ') l -= 1;
    if (l > 0 && CURRENCY_SYMBOLS.includes(text[l - 1])) { kind = 'currency'; start = l - 1; }
    else {
      const before = text.slice(Math.max(0, l - 3), l).toUpperCase();
      if (CURRENCY_CODES.includes(before) && (l - 3 === 0 || !/[A-Za-z]/.test(text[l - 4] || ''))) {
        kind = 'currency'; start = l - 3;
      }
    }

    // Look right for %, ‰, a currency symbol or code, or a multiplier suffix.
    let r = end;
    while (r < text.length && text[r] === ' ') r += 1;
    if (text[r] === '%' || text[r] === '‰') { kind = 'percent'; end = r + 1; }
    else if (CURRENCY_SYMBOLS.includes(text[r] || '')) { kind = 'currency'; end = r + 1; }
    else if (CURRENCY_CODES.includes(text.slice(r, r + 3).toUpperCase()) && !/[A-Za-z]/.test(text[r + 3] || '')) {
      kind = 'currency'; end = r + 3;
    } else if ((text[r] === 'x' || text[r] === 'X' || text[r] === '×') && !/[A-Za-z0-9]/.test(text[r + 1] || '')) {
      kind = 'multiplier'; end = r + 1;
    }

    const raw = text.slice(start, end);
    const groups = raw.match(/\d+/g) || [];
    out.push({ text: raw, start, end, digits: groups.join(''), groups, kind });
    NUM_CORE.lastIndex = Math.max(NUM_CORE.lastIndex, end);
  }
  return out;
}

/**
 * The order-insensitive key for a numeric token's digit runs.
 *
 * `08/17/2026` and `17.08.2026` share it; `1,234.50` and `1.234,50` do not
 * (their runs regroup), which is why the guard also compares `digits`.
 * @param {string[]} groups
 * @returns {string}
 */
export function groupKey(groups) {
  return groups.slice().sort().join('|');
}

/**
 * Split a paragraph into sentences without a locale table, holding back on the
 * common abbreviations that would otherwise split mid-sentence.
 * @param {string} s
 * @returns {string[]}
 */
export function sentences(s) {
  const flat = flatten(s);
  if (!flat) return [];
  const abbrev = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'inc', 'ltd', 'co', 'vs', 'etc', 'e.g', 'i.e', 'no', 'fig', 'st']);
  /** @type {string[]} */
  const out = [];
  let buf = '';
  for (let i = 0; i < flat.length; i++) {
    const ch = flat[i];
    buf += ch;
    if (ch !== '.' && ch !== '!' && ch !== '?' && ch !== '。') continue;
    let j = i + 1;
    while (j < flat.length && (flat[j] === '"' || flat[j] === '”' || flat[j] === ')' || flat[j] === '’')) { buf += flat[j]; j += 1; }
    if (j < flat.length && flat[j] !== ' ') { i = j - 1; continue; }
    const lastWord = (buf.slice(0, -1).match(/[\p{L}.]+$/u) || [''])[0].toLowerCase().replace(/\.$/, '');
    if (ch === '.' && abbrev.has(lastWord)) { i = j - 1; continue; }
    const next = flat.slice(j + 1, j + 2);
    if (next && !/[\p{Lu}\p{N}"“«「]/u.test(next)) { i = j - 1; continue; }
    out.push(buf.trim());
    buf = '';
    i = j;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/**
 * The first clause of a line: everything before the first comma, colon, dash or
 * pipe that has text on both sides. Used to build the "shortest form" of a
 * governed iteration without inventing words.
 * @param {string} s
 * @returns {string}
 */
export function firstClause(s) {
  const flat = flatten(s);
  const m = flat.match(/^(.{3,}?)\s*[,:;—–|·]\s+\S/);
  return m ? m[1].trim() : flat;
}

/**
 * Truncate on a word boundary, never mid-word, and never silently: the caller
 * always receives the removed tail so it can report it.
 * @param {string} s
 * @param {number} maxChars
 * @returns {{kept: string, removed: string}}
 */
export function splitAtChars(s, maxChars) {
  const text = String(s == null ? '' : s);
  if (maxChars <= 0) return { kept: '', removed: text };
  if (text.length <= maxChars) return { kept: text, removed: '' };
  const head = text.slice(0, maxChars);
  const lastSpace = head.lastIndexOf(' ');
  const cut = lastSpace > Math.floor(maxChars * 0.5) ? lastSpace : maxChars;
  return { kept: text.slice(0, cut).trimEnd(), removed: text.slice(cut).trimStart() };
}

/** Words a title-caser leaves lowercase unless they lead the line. */
const MINOR_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'nor', 'of', 'on', 'or', 'per', 'the', 'to', 'up', 'via', 'with']);

/**
 * Title-case a line drawn from the specimen. Words that are already fully
 * uppercase are left alone (acronyms and the prospect's own styling).
 * @param {string} s
 * @returns {string}
 */
export function titleCase(s) {
  const flat = flatten(s);
  const words = flat.split(' ');
  return words.map((w, i) => {
    if (!w) return w;
    if (w === w.toUpperCase() && /\p{L}/u.test(w)) return w;
    const lower = w.toLowerCase();
    if (i > 0 && i < words.length - 1 && MINOR_WORDS.has(lower.replace(/[^\p{L}]/gu, ''))) return lower;
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  }).join(' ');
}

/**
 * Sentence-case a line: first letter up, the rest untouched.
 * @param {string} s
 * @returns {string}
 */
export function sentenceCase(s) {
  const flat = flatten(s);
  return flat ? flat.charAt(0).toUpperCase() + flat.slice(1) : flat;
}

/**
 * Every quoted span in a string, with its inner text.
 * @param {string} s
 * @returns {{text: string, open: string, close: string}[]}
 */
export function quotedSpans(s) {
  const text = String(s == null ? '' : s);
  /** @type {{text: string, open: string, close: string}[]} */
  const out = [];
  for (const [open, close] of QUOTE_PAIRS) {
    let i = 0;
    for (;;) {
      const a = text.indexOf(open, i);
      if (a < 0) break;
      const b = text.indexOf(close, a + open.length);
      if (b < 0) break;
      const inner = text.slice(a + open.length, b);
      if (inner.trim()) out.push({ text: inner.trim(), open, close });
      i = b + close.length;
    }
  }
  return out;
}

/**
 * A stable, comparison-friendly form of a text run: lowercased, punctuation
 * folded to spaces, whitespace collapsed.
 * @param {string} s
 * @returns {string}
 */
export function foldForCompare(s) {
  return flatten(s)
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟«»]/g, '"')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Number words, for the spelled-out-statistic check in `facts.js`.
 * @type {string[]}
 */
export const NUMBER_WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen',
  'nineteen', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety',
  'hundred', 'thousand', 'million', 'billion', 'trillion', 'half', 'quarter', 'third',
  'double', 'triple', 'quadruple',
];
