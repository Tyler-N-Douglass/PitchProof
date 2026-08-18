/**
 * The jump index and its search (§11).
 *
 * §11 states the acceptance case in one sentence: "The presenter types three
 * characters of 'approvals' and lands in the approval-chain branch in under a
 * second." Everything in this file is built backwards from that sentence.
 *
 * The index is built once, at emit, over every branch's objection and aliases.
 * A query then costs comparisons only: prefix, token-prefix, substring,
 * acronym, all-tokens, subsequence, and — last, and only when nothing better
 * was found — a bounded edit distance for the typo a presenter makes while
 * talking. Every strategy returns the ranges it matched, because a result list
 * that does not show *why* it matched makes a presenter read instead of press
 * Enter.
 *
 * Ranking rules, in order:
 *   1. exact and prefix matches always outrank fuzzy ones;
 *   2. the objection outranks an alias at equal quality (it is the wording the
 *      client actually used);
 *   3. ties break deterministically — deck order, then branch id — so the same
 *      query always produces the same list, which is what makes muscle memory
 *      possible (§5).
 *
 * @module branch/jump-index
 */

import { allBranches } from '../runtime/deck.js';
import {
  fold, tokenize, charGrams, gramOverlap, acronyms, sourceRange,
  boundedEditDistance, boundedPrefixDistance, subsequenceMatch, positionsToRanges, typoBudget,
} from './text.js';

/** Field weights. The objection is the client's own words; an alias is ours. */
export const FIELD_WEIGHT = { objection: 1, alias: 0.94 };

/** Base scores per strategy. Tiers are far enough apart that no coverage bonus can cross one. */
export const STRATEGY_SCORE = {
  exact: 1000,
  prefix: 900,
  tokenPrefix: 800,
  substring: 700,
  acronym: 640,
  allTokens: 600,
  subsequence: 420,
  fuzzy: 500,
};

/** Results at or below this score are noise and are not shown. */
const MIN_SCORE = 1;

/** Default result count: what fits on screen without scrolling under pressure. */
export const DEFAULT_LIMIT = 8;

/**
 * @typedef {object} JumpTerm
 * @property {'objection'|'alias'} field
 * @property {number} index            alias index, or 0 for the objection
 * @property {string} text             the text as the presenter reads it
 * @property {import('./text.js').Folded} folded
 * @property {import('./text.js').Token[]} tokens
 * @property {string} squeezed         folded text with whitespace removed
 * @property {{all: string, strong: string, allTokens: any[], strongTokens: any[]}} acronym
 * @property {Set<string>} grams
 * @property {number} weight
 */

/**
 * @typedef {object} JumpEntry
 * @property {string} branchId
 * @property {string} objection
 * @property {string[]} aliases
 * @property {number} order            deck order, the deterministic tie-break
 * @property {boolean} anchored
 * @property {string[]} anchorScenes
 * @property {number} sceneCount
 * @property {JumpTerm[]} terms
 * @property {boolean} searchable      has at least one term with a token in it
 */

/**
 * @typedef {object} JumpIndex
 * @property {JumpEntry[]} entries
 * @property {Map<string, JumpEntry>} byBranchId
 * @property {Map<string, number[]>} postings
 *   The candidate index: token prefixes (`p:`), character trigrams (`g:`) and
 *   acronym prefixes (`a:`) to the entries that contain them. A query scores
 *   the handful of branches that could possibly match instead of all of them,
 *   which is the difference between a search that feels instant and one a
 *   presenter notices.
 * @property {number} termCount
 * @property {number} postingCount
 * @property {string} deckFingerprint
 */

/** How many leading characters of a token are indexed as prefixes. */
export const PREFIX_DEPTH = 5;

/**
 * Build the jump index over every branch in a deck.
 *
 * Branch ids are deliberately **not** indexed. A branch findable only by its
 * minted id is not findable in a room, and counting an id as a search term
 * would make `BRANCH_UNREACHABLE` unraisable (§11 coverage rule).
 *
 * @param {import('../runtime/deck.js').Deck} deck
 * @returns {JumpIndex}
 */
export function buildJumpIndex(deck) {
  /** @type {JumpEntry[]} */
  const entries = [];
  const branches = allBranches(deck);

  branches.forEach((seq, order) => {
    /** @type {JumpTerm[]} */
    const terms = [];
    const push = (field, index, text, weight) => {
      const raw = typeof text === 'string' ? text.trim() : '';
      if (!raw) return;
      const folded = fold(raw);
      const tokens = tokenize(folded.text);
      if (tokens.length === 0) return;
      terms.push({
        field,
        index,
        text: raw,
        folded,
        tokens,
        squeezed: folded.text.replace(/\s+/g, ''),
        acronym: acronyms(tokens),
        grams: charGrams(folded.text),
        weight: FIELD_WEIGHT[field],
      });
    };

    push('objection', 0, seq.objection, FIELD_WEIGHT.objection);
    (seq.aliases || []).forEach((alias, i) => push('alias', i, alias, FIELD_WEIGHT.alias));

    /** @type {string[]} */
    const anchorScenes = [];
    for (const [sceneId, branchIds] of deck.anchorsByScene) {
      if (branchIds.includes(seq.id)) anchorScenes.push(sceneId);
    }

    entries.push({
      branchId: seq.id,
      objection: seq.objection || '',
      aliases: (seq.aliases || []).slice(),
      order,
      anchored: anchorScenes.length > 0,
      anchorScenes,
      sceneCount: seq.scenes.length,
      terms,
      searchable: terms.length > 0,
    });
  });

  const postings = buildPostings(entries);
  let postingCount = 0;
  for (const list of postings.values()) postingCount += list.length;

  return {
    entries,
    byBranchId: new Map(entries.map((e) => [e.branchId, e])),
    postings,
    termCount: entries.reduce((n, e) => n + e.terms.length, 0),
    postingCount,
    deckFingerprint: deck.fingerprint,
  };
}

/**
 * The candidate index. Every key an entry could be found by, mapped to the
 * entries that carry it, built once so a keystroke never scans the deck.
 * @param {JumpEntry[]} entries
 * @returns {Map<string, number[]>}
 */
function buildPostings(entries) {
  /** @type {Map<string, number[]>} */
  const postings = new Map();
  entries.forEach((entry, i) => {
    /** @type {Set<string>} */
    const keys = new Set();
    for (const term of entry.terms) {
      for (const token of term.tokens) {
        const depth = Math.min(PREFIX_DEPTH, token.text.length);
        for (let n = 1; n <= depth; n++) keys.add(`p:${token.text.slice(0, n)}`);
      }
      for (const gram of term.grams) keys.add(`g:${gram}`);
      for (const form of [term.acronym.strong, term.acronym.all]) {
        const depth = Math.min(PREFIX_DEPTH, form.length);
        for (let n = 2; n <= depth; n++) keys.add(`a:${form.slice(0, n)}`);
      }
    }
    for (const key of keys) {
      const list = postings.get(key);
      if (list) list.push(i);
      else postings.set(key, [i]);
    }
  });
  return postings;
}

/**
 * The entries a query could possibly match, in index order.
 *
 * Anything reachable by a solid strategy — exact, prefix, word prefix, acronym,
 * every-word — is reachable through a token-prefix or acronym posting. Anything
 * reachable by substring or bounded edit distance shares a character trigram
 * with the query by construction. What this filter does drop is a *subsequence*
 * hit with no trigram in common with the query — the loosest signal the scorer
 * has, and the one whose absence a presenter reads as "it didn't match" rather
 * than "it matched the wrong thing".
 *
 * @param {JumpIndex} index
 * @param {string} q          folded query
 * @param {import('./text.js').Token[]} qTokens
 * @param {string} qSqueezed
 * @param {Set<string>} qGrams
 * @returns {number[]}
 */
function candidateEntries(index, q, qTokens, qSqueezed, qGrams) {
  const seen = new Uint8Array(index.entries.length);
  /** @type {number[]} */
  const out = [];
  const take = (key) => {
    const list = index.postings.get(key);
    if (!list) return;
    for (const i of list) {
      if (seen[i]) continue;
      seen[i] = 1;
      out.push(i);
    }
  };

  for (const token of qTokens) take(`p:${token.text.slice(0, PREFIX_DEPTH)}`);
  if (qSqueezed.length >= 2) take(`a:${qSqueezed.slice(0, PREFIX_DEPTH)}`);
  for (const gram of qGrams) take(`g:${gram}`);
  // A one- or two-character query has no trigram of its own; the prefix
  // postings above are the whole candidate set, which is exactly right — at
  // that length anything looser is noise.
  out.sort((a, b) => a - b);
  return out;
}

/**
 * @typedef {object} JumpMatch
 * @property {string} branchId
 * @property {string} objection
 * @property {number} score
 * @property {{start: number, end: number, field: string, text: string}[]} matched
 *   Highlight ranges in the text of the field that matched, in source (not
 *   folded) coordinates.
 * @property {'objection'|'alias'|null} matchedField
 * @property {string} matchedText
 * @property {string} kind      which strategy produced the match
 * @property {boolean} anchored
 * @property {number} sceneCount
 */

/**
 * Search the index.
 *
 * An empty query lists every branch in deck order — opening `/` and seeing the
 * whole objection set is how a presenter remembers what they wired.
 *
 * @param {JumpIndex} index
 * @param {string} query
 * @param {{limit?: number}} [options]
 * @returns {JumpMatch[]}
 */
export function searchJump(index, query, options = {}) {
  const limit = options.limit === undefined ? DEFAULT_LIMIT : Math.max(0, options.limit | 0);
  if (!index || !index.entries) return [];
  const folded = fold(typeof query === 'string' ? query : '');
  const q = folded.text.trim().replace(/\s+/g, ' ');

  if (!q) {
    return index.entries.slice(0, limit).map((entry) => ({
      branchId: entry.branchId,
      objection: entry.objection,
      score: 0,
      matched: [],
      matchedField: null,
      matchedText: entry.objection,
      kind: 'all',
      anchored: entry.anchored,
      sceneCount: entry.sceneCount,
    }));
  }

  const qTokens = tokenize(q);
  const qSqueezed = q.replace(/\s+/g, '');
  const qGrams = charGrams(q);
  const budget = typoBudget(q);

  /** @type {JumpMatch[]} */
  const hits = [];
  for (const candidate of candidateEntries(index, q, qTokens, qSqueezed, qGrams)) {
    const entry = index.entries[candidate];
    let best = null;
    for (const term of entry.terms) {
      const scored = scoreTerm(term, { q, qTokens, qSqueezed, qGrams, budget });
      if (!scored) continue;
      const weighted = scored.score * term.weight;
      if (!best || weighted > best.score
        || (weighted === best.score && fieldRank(term.field) < fieldRank(best.field))) {
        best = { score: weighted, kind: scored.kind, ranges: scored.ranges, term, field: term.field };
      }
    }
    if (!best || best.score < MIN_SCORE) continue;
    hits.push({
      branchId: entry.branchId,
      objection: entry.objection,
      score: best.score,
      matched: best.ranges.map((r) => ({
        ...sourceRange(best.term.folded, r.start, r.end),
        field: best.term.field,
        text: best.term.text,
      })),
      matchedField: best.term.field,
      matchedText: best.term.text,
      kind: best.kind,
      anchored: entry.anchored,
      sceneCount: entry.sceneCount,
      order: entry.order,
    });
  }

  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const fr = fieldRank(a.matchedField) - fieldRank(b.matchedField);
    if (fr !== 0) return fr;
    if (a.order !== b.order) return a.order - b.order;
    return a.branchId < b.branchId ? -1 : a.branchId > b.branchId ? 1 : 0;
  });

  return hits.slice(0, limit).map(({ order, ...rest }) => rest);
}

/**
 * @param {string|null} field
 * @returns {number}
 */
function fieldRank(field) {
  return field === 'objection' ? 0 : 1;
}

/**
 * Score one term against one query, taking the best strategy that fires.
 * @param {JumpTerm} term
 * @param {{q: string, qTokens: any[], qSqueezed: string, qGrams: Set<string>, budget: number}} ctx
 * @returns {{score: number, kind: string, ranges: {start: number, end: number}[]}|null}
 */
function scoreTerm(term, ctx) {
  const { q, qTokens, qSqueezed, qGrams, budget } = ctx;
  const text = term.folded.text;

  // 1. Exact.
  if (text === q) {
    return { score: STRATEGY_SCORE.exact, kind: 'exact', ranges: [{ start: 0, end: text.length }] };
  }

  // 2. The whole term starts with the whole query.
  if (text.startsWith(q)) {
    const coverage = q.length / text.length;
    return {
      score: STRATEGY_SCORE.prefix + 60 * coverage,
      kind: 'prefix',
      ranges: [{ start: 0, end: q.length }],
    };
  }

  /** @type {{score: number, kind: string, ranges: {start: number, end: number}[]}|null} */
  let best = null;
  const consider = (candidate) => {
    if (candidate && (!best || candidate.score > best.score)) best = candidate;
  };

  // 3. A word in the term starts with the query. This is the §11 case: three
  //    characters of "approvals" against "Our approvals process…".
  if (qTokens.length === 1) {
    const qt = qTokens[0].text;
    for (let i = 0; i < term.tokens.length; i++) {
      const tok = term.tokens[i];
      if (!tok.text.startsWith(qt)) continue;
      const coverage = qt.length / tok.text.length;
      consider({
        score: STRATEGY_SCORE.tokenPrefix + 60 * coverage - Math.min(i, 8) * 6,
        kind: 'token-prefix',
        ranges: [{ start: tok.start, end: tok.start + qt.length }],
      });
      break;
    }
  }

  // 4. The query appears inside the term but not at a word boundary.
  if (!best || best.score < STRATEGY_SCORE.tokenPrefix) {
    const at = text.indexOf(q);
    if (at > 0) {
      const coverage = q.length / text.length;
      consider({
        score: STRATEGY_SCORE.substring + 40 * coverage - Math.min(at, 60) * 0.5,
        kind: 'substring',
        ranges: [{ start: at, end: at + q.length }],
      });
    }
  }

  // 5. Initials — how a presenter remembers a long objection they wrote.
  if (qSqueezed.length >= 2) {
    const acro = term.acronym;
    for (const [form, tokens] of [[acro.strong, acro.strongTokens], [acro.all, acro.allTokens]]) {
      if (!form.startsWith(qSqueezed)) continue;
      const coverage = qSqueezed.length / form.length;
      consider({
        score: STRATEGY_SCORE.acronym + 40 * coverage,
        kind: 'acronym',
        ranges: tokens.slice(0, qSqueezed.length).map((t) => ({ start: t.start, end: t.start + 1 })),
      });
      break;
    }
  }

  // 6. Every word of the query is the start of some word of the term, in any
  //    order: "legal claim" finds "Legal has to see every claim".
  if (qTokens.length > 1) {
    const used = new Set();
    /** @type {{start: number, end: number}[]} */
    const ranges = [];
    let coverage = 0;
    let inOrder = true;
    let lastIndex = -1;
    let all = true;
    for (const qt of qTokens) {
      let found = -1;
      for (let i = 0; i < term.tokens.length; i++) {
        if (used.has(i)) continue;
        if (term.tokens[i].text.startsWith(qt.text)) { found = i; break; }
      }
      if (found < 0) { all = false; break; }
      used.add(found);
      const tok = term.tokens[found];
      ranges.push({ start: tok.start, end: tok.start + qt.text.length });
      coverage += qt.text.length / tok.text.length;
      if (found < lastIndex) inOrder = false;
      lastIndex = found;
    }
    if (all) {
      ranges.sort((a, b) => a.start - b.start);
      consider({
        score: STRATEGY_SCORE.allTokens + 50 * (coverage / qTokens.length) - (inOrder ? 0 : 15),
        kind: 'all-tokens',
        ranges,
      });
    }
  }

  // 7. The letters appear in order. Loose, and scored well below anything above.
  if (!best || best.score < STRATEGY_SCORE.allTokens) {
    const hits = subsequenceMatch(qSqueezed, text);
    if (hits) {
      const span = hits[hits.length - 1] - hits[0] + 1;
      const density = qSqueezed.length / Math.max(1, span);
      consider({
        score: STRATEGY_SCORE.subsequence + 60 * density,
        kind: 'subsequence',
        ranges: positionsToRanges(hits),
      });
    }
  }

  // 8. The typo path, gated: only when nothing solid fired, only when the query
  //    is long enough for an edit to be meaningful, and only when the term
  //    shares character n-grams with it. That gate is why a 200-branch index
  //    still answers in microseconds.
  if (budget > 0 && (!best || best.score < STRATEGY_SCORE.allTokens) && gramOverlap(qGrams, term.grams) > 0) {
    let bestDist = budget + 1;
    /** @type {{start: number, end: number}[]} */
    let bestRanges = [];
    let bestCoverage = 0;
    if (qTokens.length === 1) {
      const qt = qTokens[0].text;
      for (const tok of term.tokens) {
        if (Math.abs(tok.text.length - qt.length) > budget && tok.text.length < qt.length) continue;
        const { distance, end } = boundedPrefixDistance(qt, tok.text, budget);
        if (distance < bestDist && distance > 0) {
          bestDist = distance;
          bestRanges = [{ start: tok.start, end: tok.start + Math.max(1, end) }];
          bestCoverage = Math.max(1, end) / tok.text.length;
        }
      }
    }
    if (bestDist > budget) {
      const distance = boundedEditDistance(q, text, budget);
      if (distance > 0 && distance <= budget) {
        bestDist = distance;
        bestRanges = [{ start: 0, end: text.length }];
        bestCoverage = 1;
      }
    }
    if (bestDist <= budget) {
      consider({
        score: STRATEGY_SCORE.fuzzy - 100 * (bestDist - 1) + 40 * bestCoverage,
        kind: `fuzzy-${bestDist}`,
        ranges: bestRanges,
      });
    }
  }

  return best;
}

/**
 * Split a string into highlighted and plain runs, for a renderer that cannot
 * hand out DOM. Pure string work: the overlay stays a VNode function.
 * @param {string} text
 * @param {{start: number, end: number}[]} ranges
 * @returns {{text: string, hit: boolean}[]}
 */
export function highlightRuns(text, ranges) {
  const src = String(text == null ? '' : text);
  const sorted = (ranges || [])
    .filter((r) => r && r.end > r.start)
    .map((r) => ({ start: Math.max(0, r.start), end: Math.min(src.length, r.end) }))
    .sort((a, b) => a.start - b.start);
  /** @type {{text: string, hit: boolean}[]} */
  const out = [];
  let at = 0;
  for (const r of sorted) {
    if (r.start < at) {
      if (r.end > at) { // overlapping ranges merge rather than duplicating text
        const last = out[out.length - 1];
        if (last && last.hit) last.text += src.slice(at, r.end);
        else out.push({ text: src.slice(at, r.end), hit: true });
        at = r.end;
      }
      continue;
    }
    if (r.start > at) out.push({ text: src.slice(at, r.start), hit: false });
    out.push({ text: src.slice(r.start, r.end), hit: true });
    at = r.end;
  }
  if (at < src.length) out.push({ text: src.slice(at), hit: false });
  return out.filter((run) => run.text.length > 0);
}
