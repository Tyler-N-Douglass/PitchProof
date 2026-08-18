/**
 * The text primitives the jump index is built out of (§11).
 *
 * A presenter searching the jump index is standing in front of a room, mid
 * sentence, with a client's objection still in the air. The search has to land
 * on three characters, tolerate a typo made at speed, and never make them look
 * at the keyboard. That is only possible if every expensive thing — folding,
 * tokenizing, n-grams, the acronym form — happens once at emit and the
 * keystroke path is pure comparison.
 *
 * Two properties matter here and are tested directly:
 *
 *   - **Offsets survive folding.** Matching happens on a folded string
 *     (diacritics stripped, lower-cased) but highlighting happens on the text
 *     the presenter reads, so every folded index carries a map back to the
 *     original one.
 *   - **Everything is pure.** No clock, no randomness, no document: the same
 *     index and query always produce the same ranking (§5).
 *
 * @module branch/text
 */

/** Text that needs no Unicode decomposition. */
const ASCII_ONLY = /^[\x00-\x7f]*$/;

/** Characters that make up a token: any letter or number, in any script. */
const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Words that carry no discriminating power in an objection, so the acronym
 * form ignores them: "our approvals process would never allow this" is best
 * remembered as "apa", not "oapwnat".
 */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'do', 'does',
  'every', 'for', 'from', 'had', 'has', 'have', 'how', 'i', 'if', 'in', 'is',
  'it', 'its', 'just', 'me', 'my', 'no', 'not', 'of', 'on', 'or', 'our', 'out',
  'over', 'own', 're', 's', 'so', 't', 'than', 'that', 'the', 'their', 'them',
  'then', 'there', 'these', 'they', 'this', 'to', 'too', 'up', 'us', 've',
  'was', 'we', 'were', 'what', 'when', 'which', 'who', 'will', 'with', 'would',
  'you', 'your',
]);

/**
 * Fold one character for matching: decomposed, combining marks dropped,
 * lower-cased. Returns a string because a single character can fold to more
 * than one (and to none, for a bare combining mark).
 * @param {string} ch
 * @returns {string}
 */
export function foldChar(ch) {
  const code = ch.charCodeAt(0);
  // ASCII is the overwhelmingly common case and `String.prototype.normalize`
  // is expensive enough per character to show up in an index build, so it is
  // only reached by text that could actually decompose.
  if (code < 128) return code >= 65 && code <= 90 ? ch.toLowerCase() : ch;
  return ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/**
 * @typedef {object} Folded
 * @property {string} text     the folded string, matched against
 * @property {number[]} map    folded index → index in the source string
 * @property {string} source   the original text, highlighted against
 */

/**
 * Fold a string while keeping a map back to the original indices.
 * @param {string} input
 * @returns {Folded}
 */
export function fold(input) {
  const source = String(input == null ? '' : input);
  // Pure-ASCII text folds one-to-one, so the index map is the identity and the
  // whole string can be lower-cased in one call.
  if (ASCII_ONLY.test(source)) {
    const text = source.toLowerCase();
    const map = new Array(text.length);
    for (let i = 0; i < text.length; i++) map[i] = i;
    return { text, map, source };
  }
  let text = '';
  /** @type {number[]} */
  const map = [];
  for (let i = 0; i < source.length; i++) {
    const folded = foldChar(source[i]);
    for (let k = 0; k < folded.length; k++) {
      text += folded[k];
      map.push(i);
    }
  }
  return { text, map, source };
}

/**
 * Translate a half-open range in folded coordinates into a half-open range in
 * the source string, so a highlight lands on the characters the presenter sees.
 * @param {Folded} folded
 * @param {number} start
 * @param {number} end
 * @returns {{start: number, end: number}}
 */
export function sourceRange(folded, start, end) {
  if (end <= start || folded.map.length === 0) return { start: 0, end: 0 };
  const s = folded.map[Math.max(0, Math.min(folded.map.length - 1, start))];
  const e = folded.map[Math.max(0, Math.min(folded.map.length - 1, end - 1))] + 1;
  return { start: s, end: Math.max(s + 1, e) };
}

/**
 * @typedef {object} Token
 * @property {string} text    folded
 * @property {number} start   index into the folded string
 * @property {number} end     exclusive
 * @property {boolean} strong not a stopword
 */

/**
 * Split a folded string into tokens with their offsets.
 * @param {string} foldedText
 * @returns {Token[]}
 */
export function tokenize(foldedText) {
  /** @type {Token[]} */
  const out = [];
  let start = -1;
  for (let i = 0; i <= foldedText.length; i++) {
    const isWord = i < foldedText.length && WORD_CHAR.test(foldedText[i]);
    if (isWord && start < 0) start = i;
    else if (!isWord && start >= 0) {
      const text = foldedText.slice(start, i);
      out.push({ text, start, end: i, strong: !STOPWORDS.has(text) });
      start = -1;
    }
  }
  return out;
}

/**
 * Character n-grams over a folded string, used only as a cheap prefilter in
 * front of edit distance. Padded so short terms still produce grams.
 * @param {string} foldedText
 * @param {number} [n]
 * @returns {Set<string>}
 */
export function charGrams(foldedText, n = 3) {
  const padded = ` ${foldedText.replace(/\s+/g, ' ').trim()} `;
  /** @type {Set<string>} */
  const out = new Set();
  if (padded.length < n) { if (padded.trim()) out.add(padded.trim()); return out; }
  for (let i = 0; i + n <= padded.length; i++) out.add(padded.slice(i, i + n));
  return out;
}

/**
 * How many grams two sets share.
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {number}
 */
export function gramOverlap(a, b) {
  let n = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const g of small) if (large.has(g)) n++;
  return n;
}

/**
 * The acronym forms of a tokenized string: every initial, and the initials of
 * the words that carry meaning.
 * @param {Token[]} tokens
 * @returns {{all: string, strong: string, allTokens: Token[], strongTokens: Token[]}}
 */
export function acronyms(tokens) {
  const strongTokens = tokens.filter((t) => t.strong);
  return {
    all: tokens.map((t) => t.text[0]).join(''),
    strong: strongTokens.map((t) => t.text[0]).join(''),
    allTokens: tokens,
    strongTokens,
  };
}

/**
 * Damerau–Levenshtein distance (optimal string alignment), bounded. Returns
 * `max + 1` as soon as the distance is known to exceed `max`, which is what
 * keeps a 200-branch index inside a millisecond: a typo search never pays for a
 * full DP over a long objection.
 *
 * Transpositions count as one edit rather than two, because a transposition is
 * the typo a presenter actually makes — "sacle" for "scale" — and treating it
 * as two edits means the search fails exactly when it is needed most.
 *
 * @param {string} a
 * @param {string} b
 * @param {number} max
 * @returns {number}
 */
export function boundedEditDistance(a, b, max) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a.length === 0) return b.length <= max ? b.length : max + 1;
  if (b.length === 0) return a.length <= max ? a.length : max + 1;

  const width = b.length;
  let prev2 = new Array(width + 1).fill(max + 1);
  let prev = new Array(width + 1);
  let curr = new Array(width + 1);
  for (let j = 0; j <= width; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr.fill(max + 1);
    curr[0] = i;
    const lo = Math.max(1, i - max);
    const hi = Math.min(width, i + max);
    let rowBest = curr[0] <= max ? curr[0] : max + 1;
    for (let j = lo; j <= hi; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      curr[j] = v;
      if (v < rowBest) rowBest = v;
    }
    if (rowBest > max) return max + 1;
    const t = prev2; prev2 = prev; prev = curr; curr = t;
  }
  return prev[width] <= max ? prev[width] : max + 1;
}

/**
 * Distance from `query` to the best *prefix* of `text`, bounded, with the same
 * transposition rule. This is the typo-tolerant form the jump index actually
 * needs: a presenter typing "aprovals" is typing the front of "approvals
 * process", not the whole of it, so the suffix must be free.
 * @param {string} query
 * @param {string} text
 * @param {number} max
 * @returns {{distance: number, end: number}}   `end` is the prefix length matched
 */
export function boundedPrefixDistance(query, text, max) {
  if (query.length === 0) return { distance: 0, end: 0 };
  if (text.length === 0) return { distance: query.length <= max ? query.length : max + 1, end: 0 };

  const width = Math.min(text.length, query.length + max);
  let prev2 = new Array(width + 1).fill(max + 1);
  let prev = new Array(width + 1);
  let curr = new Array(width + 1);
  for (let j = 0; j <= width; j++) prev[j] = j;

  for (let i = 1; i <= query.length; i++) {
    curr[0] = i;
    let rowBest = i;
    for (let j = 1; j <= width; j++) {
      const cost = query[i - 1] === text[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && query[i - 1] === text[j - 2] && query[i - 2] === text[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      curr[j] = v;
      if (v < rowBest) rowBest = v;
    }
    if (rowBest > max) return { distance: max + 1, end: 0 };
    const t = prev2; prev2 = prev; prev = curr; curr = t;
  }

  let best = max + 1;
  let end = 0;
  for (let j = Math.max(0, query.length - max); j <= width; j++) {
    if (prev[j] < best) { best = prev[j]; end = j; }
  }
  return best <= max ? { distance: best, end } : { distance: max + 1, end: 0 };
}

/**
 * Match every character of `query` in order inside `text`, greedily and as
 * early as possible. Returns the matched positions, or null.
 * @param {string} query
 * @param {string} text
 * @returns {number[]|null}
 */
export function subsequenceMatch(query, text) {
  /** @type {number[]} */
  const hits = [];
  let at = 0;
  for (let i = 0; i < query.length; i++) {
    const ch = query[i];
    if (ch === ' ') continue;
    const found = text.indexOf(ch, at);
    if (found < 0) return null;
    hits.push(found);
    at = found + 1;
  }
  return hits.length ? hits : null;
}

/**
 * Collapse a sorted list of positions into contiguous half-open ranges.
 * @param {number[]} positions
 * @returns {{start: number, end: number}[]}
 */
export function positionsToRanges(positions) {
  /** @type {{start: number, end: number}[]} */
  const out = [];
  for (const p of positions) {
    const last = out[out.length - 1];
    if (last && last.end === p) last.end = p + 1;
    else out.push({ start: p, end: p + 1 });
  }
  return out;
}

/**
 * How far a typo search may reach. Three characters is the §11 acceptance
 * case and must stay exact — at that length every objection in a deck is
 * within one edit of every other, and a fuzzy hit would be noise, not help.
 * @param {string} query   folded
 * @returns {number}
 */
export function typoBudget(query) {
  const n = query.replace(/\s+/g, '').length;
  if (n < 4) return 0;
  if (n < 7) return 1;
  return 2;
}
