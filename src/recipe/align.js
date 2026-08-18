/**
 * Block-level alignment between a source specimen and pasted output (§9).
 *
 * The paste surface is only excellent if the studio can put the two sides
 * beside each other and be *right* about which block corresponds to which. A
 * naive index-for-index pairing lies the moment the rendition drops a nav
 * paragraph or splits one section into two, and a lie here becomes a lie on a
 * slide in front of a client.
 *
 * So this is a real sequence alignment: Needleman–Wunsch global alignment over a
 * block similarity score, followed by a bounded move-recovery pass that repairs
 * the one thing a global alignment structurally cannot see — a block that was
 * moved rather than deleted and re-added.
 *
 * Everything here is deterministic. Ties in the traceback resolve in a fixed
 * order (diagonal, then deletion, then insertion) and move recovery sorts its
 * candidates by score and then by index, so the same two inputs always produce
 * the same pairing.
 *
 * @module recipe/align
 */

import { blockText } from '../core/contracts.js';
import { tokenize, bigrams, diceCoefficient, flatten } from './text.js';

/** Gap penalty in the Needleman–Wunsch matrix, in the same units as `substitution`. */
export const GAP_PENALTY = -0.55;

/** Similarity at or above which an unmatched pair is recovered as a move. */
export const MOVE_THRESHOLD = 0.62;

/**
 * The similarity at which pairing two blocks is score-neutral.
 *
 * It is high on purpose. Two unrelated paragraphs of similar length already
 * score 0.50 from the type and length terms alone, before a single word is
 * shared, so a low threshold would pair every paragraph with every paragraph and
 * never report an insertion. At 0.78 the break-even against a pair of gaps falls
 * at similarity 0.538 — comfortably below a reworded version of the same block
 * (typically 0.65–0.80) and comfortably above two blocks that merely share a
 * shape.
 */
export const MATCH_THRESHOLD = 0.78;

/** Weights of the three similarity components. They sum to 1. */
export const SIMILARITY_WEIGHTS = { type: 0.30, length: 0.20, tokens: 0.50 };

/** Block types that read as prose, for the partial type-credit rule. */
const TEXTUAL = new Set(['heading', 'paragraph', 'quote', 'cta']);

/**
 * The comparable text of a block, flattened to one line.
 * @param {import('../core/contracts.d.ts').ContentBlock} block
 * @returns {string}
 */
export function alignText(block) {
  if (!block || typeof block.type !== 'string') return '';
  const text = flatten(blockText(block).join(' '));
  if (block.type === 'media') {
    const ref = String(block.ref || '');
    const short = ref.startsWith('data:') ? ref.slice(0, ref.indexOf(',') + 1 || 24) : ref;
    return flatten(`${text} ${short}`);
  }
  if (block.type === 'cta' && block.href) return flatten(`${text} ${block.href}`);
  return text;
}

/**
 * Type similarity: identical types score 1; two prose types score 0.6; a prose
 * type against a structural one scores 0.15; otherwise 0.
 * @param {import('../core/contracts.d.ts').ContentBlock} a
 * @param {import('../core/contracts.d.ts').ContentBlock} b
 * @returns {number}
 */
export function typeSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a.type === b.type) {
    if (a.type === 'heading') {
      // Heading level is part of the type for alignment: an h1 and an h4 are
      // not the same structural slot, but they are closer than an h1 and a list.
      const d = Math.abs(a.level - /** @type {any} */(b).level);
      return d === 0 ? 1 : Math.max(0.6, 1 - d * 0.12);
    }
    if (a.type === 'list') {
      return a.ordered === /** @type {any} */(b).ordered ? 1 : 0.8;
    }
    return 1;
  }
  if (TEXTUAL.has(a.type) && TEXTUAL.has(b.type)) return 0.6;
  return 0.15;
}

/**
 * Length similarity: the ratio of the shorter text to the longer, so a block
 * that kept its words but lost half of them still scores.
 * @param {string} ta
 * @param {string} tb
 * @returns {number}
 */
export function lengthSimilarity(ta, tb) {
  const a = ta.length; const b = tb.length;
  if (a === 0 && b === 0) return 1;
  if (a === 0 || b === 0) return 0;
  return Math.min(a, b) / Math.max(a, b);
}

/**
 * Token similarity: the mean of word-level and character-bigram Dice, which
 * keeps near-duplicates apart (two paragraphs sharing a topic but not a
 * sentence) while tolerating re-wording.
 * @param {string} ta
 * @param {string} tb
 * @returns {number}
 */
export function tokenSimilarity(ta, tb) {
  const wa = tokenize(ta); const wb = tokenize(tb);
  if (wa.length === 0 && wb.length === 0) return 1;
  const words = diceCoefficient(wa, wb);
  const chars = diceCoefficient(bigrams(wa), bigrams(wb));
  return (words + chars) / 2;
}

/**
 * Similarity of two blocks in [0, 1], combining type match, length ratio and
 * token overlap under `SIMILARITY_WEIGHTS`.
 * @param {import('../core/contracts.d.ts').ContentBlock} a
 * @param {import('../core/contracts.d.ts').ContentBlock} b
 * @returns {number}
 */
export function blockSimilarity(a, b) {
  if (!a || !b) return 0;
  const ta = alignText(a);
  const tb = alignText(b);
  const t = typeSimilarity(a, b);
  const l = lengthSimilarity(ta, tb);
  const k = tokenSimilarity(ta, tb);
  const score = SIMILARITY_WEIGHTS.type * t + SIMILARITY_WEIGHTS.length * l + SIMILARITY_WEIGHTS.tokens * k;
  return Math.max(0, Math.min(1, score));
}

/**
 * Map similarity into the Needleman–Wunsch substitution scale: +1 for identical
 * content, negative below `MATCH_THRESHOLD`, so a poor pairing loses to a pair
 * of gaps exactly when it should.
 * @param {number} similarity
 * @returns {number}
 */
export function substitutionScore(similarity) {
  return (similarity - MATCH_THRESHOLD) / (1 - MATCH_THRESHOLD);
}

/**
 * @typedef {object} AlignmentDetail
 * @property {[number|null, number|null][]} pairs   source index, pasted index
 * @property {number} score                        confidence in [0, 1]
 * @property {number[]} similarities               per-pair similarity, aligned with `pairs`
 * @property {boolean[]} moved                     true where the pair was recovered as a move
 * @property {number} matched                      count of pairs with both sides present
 * @property {number} inserted                     pasted blocks with no source
 * @property {number} deleted                      source blocks with no pasted counterpart
 */

/**
 * Needleman–Wunsch alignment with deterministic tie-breaking, plus move
 * recovery. Returns the full detail; `alignBlocks` narrows it to the API shape.
 *
 * @param {import('../core/contracts.d.ts').ContentBlock[]} sourceBlocks
 * @param {import('../core/contracts.d.ts').ContentBlock[]} pastedBlocks
 * @param {{recoverMoves?: boolean, moveThreshold?: number}} [options]
 * @returns {AlignmentDetail}
 */
export function alignBlocksDetailed(sourceBlocks, pastedBlocks, options = {}) {
  const src = Array.isArray(sourceBlocks) ? sourceBlocks : [];
  const dst = Array.isArray(pastedBlocks) ? pastedBlocks : [];
  const recoverMoves = options.recoverMoves !== false;
  const moveThreshold = typeof options.moveThreshold === 'number' ? options.moveThreshold : MOVE_THRESHOLD;
  const m = src.length; const n = dst.length;

  if (m === 0 && n === 0) {
    return { pairs: [], score: 1, similarities: [], moved: [], matched: 0, inserted: 0, deleted: 0 };
  }

  // Similarity matrix, computed once.
  /** @type {number[][]} */
  const sim = [];
  for (let i = 0; i < m; i++) {
    const row = new Array(n);
    for (let j = 0; j < n; j++) row[j] = blockSimilarity(src[i], dst[j]);
    sim.push(row);
  }

  // Score matrix. `(m+1) x (n+1)`, row 0 and column 0 are pure gaps.
  /** @type {number[][]} */
  const f = [];
  for (let i = 0; i <= m; i++) f.push(new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) f[i][0] = f[i - 1][0] + GAP_PENALTY;
  for (let j = 1; j <= n; j++) f[0][j] = f[0][j - 1] + GAP_PENALTY;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const diag = f[i - 1][j - 1] + substitutionScore(sim[i - 1][j - 1]);
      const up = f[i - 1][j] + GAP_PENALTY;
      const left = f[i][j - 1] + GAP_PENALTY;
      f[i][j] = Math.max(diag, up, left);
    }
  }

  // Traceback. Ties resolve diagonal → deletion → insertion, always, so the
  // pairing is a function of the inputs and nothing else.
  /** @type {[number|null, number|null][]} */
  const rev = [];
  /** @type {number[]} */
  const revSim = [];
  let i = m; let j = n;
  const EPS = 1e-12;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const diag = f[i - 1][j - 1] + substitutionScore(sim[i - 1][j - 1]);
      if (Math.abs(f[i][j] - diag) < EPS) {
        rev.push([i - 1, j - 1]);
        revSim.push(sim[i - 1][j - 1]);
        i -= 1; j -= 1;
        continue;
      }
    }
    if (i > 0 && Math.abs(f[i][j] - (f[i - 1][j] + GAP_PENALTY)) < EPS) {
      rev.push([i - 1, null]);
      revSim.push(0);
      i -= 1;
      continue;
    }
    if (j > 0) {
      rev.push([null, j - 1]);
      revSim.push(0);
      j -= 1;
      continue;
    }
    // Unreachable for a well-formed matrix; guarded so a NaN can never spin.
    break;
  }
  rev.reverse();
  revSim.reverse();

  /** @type {[number|null, number|null][]} */
  let pairs = rev;
  /** @type {number[]} */
  let sims = revSim;
  /** @type {boolean[]} */
  let moved = pairs.map(() => false);

  if (recoverMoves) {
    const recovered = recoverMovedBlocks(pairs, sims, sim, moveThreshold);
    pairs = recovered.pairs; sims = recovered.similarities; moved = recovered.moved;
  }

  let matched = 0; let inserted = 0; let deleted = 0; let total = 0;
  pairs.forEach((p, k) => {
    if (p[0] !== null && p[1] !== null) { matched += 1; total += sims[k]; }
    else if (p[0] === null) inserted += 1;
    else deleted += 1;
  });

  // Confidence: mean matched similarity discounted by coverage. A perfect
  // pairing of every block scores 1; matching half the blocks perfectly cannot.
  const denom = Math.max(m, n, 1);
  const score = Math.max(0, Math.min(1, total / denom));

  return { pairs, score, similarities: sims, moved, matched, inserted, deleted };
}

/**
 * Repair moved blocks: a source block the alignment deleted and a pasted block
 * it inserted are the same block relocated when they are similar enough.
 *
 * Greedy over candidates sorted by descending similarity, then by source index,
 * then by pasted index — a total order, so the result is deterministic.
 *
 * @param {[number|null, number|null][]} pairs
 * @param {number[]} similarities
 * @param {number[][]} sim
 * @param {number} threshold
 * @returns {{pairs: [number|null, number|null][], similarities: number[], moved: boolean[]}}
 */
function recoverMovedBlocks(pairs, similarities, sim, threshold) {
  /** @type {number[]} */
  const deletedAt = [];
  /** @type {number[]} */
  const insertedAt = [];
  pairs.forEach((p, k) => {
    if (p[0] !== null && p[1] === null) deletedAt.push(k);
    else if (p[0] === null && p[1] !== null) insertedAt.push(k);
  });
  if (deletedAt.length === 0 || insertedAt.length === 0) {
    return { pairs, similarities, moved: pairs.map(() => false) };
  }

  /** @type {{d: number, ins: number, s: number, si: number, di: number}[]} */
  const candidates = [];
  for (const d of deletedAt) {
    const si = /** @type {number} */(pairs[d][0]);
    for (const ins of insertedAt) {
      const di = /** @type {number} */(pairs[ins][1]);
      const s = sim[si][di];
      if (s >= threshold) candidates.push({ d, ins, s, si, di });
    }
  }
  candidates.sort((a, b) => (b.s - a.s) || (a.si - b.si) || (a.di - b.di));

  const usedDel = new Set();
  const usedIns = new Set();
  /** @type {Map<number, {di: number, s: number}>} */
  const merge = new Map();
  for (const c of candidates) {
    if (usedDel.has(c.d) || usedIns.has(c.ins)) continue;
    usedDel.add(c.d); usedIns.add(c.ins);
    merge.set(c.d, { di: c.di, s: c.s });
  }
  if (merge.size === 0) return { pairs, similarities, moved: pairs.map(() => false) };

  /** @type {[number|null, number|null][]} */
  const outPairs = [];
  /** @type {number[]} */
  const outSims = [];
  /** @type {boolean[]} */
  const outMoved = [];
  pairs.forEach((p, k) => {
    if (usedIns.has(k)) return;              // folded into its moved partner
    const merged = merge.get(k);
    if (merged) {
      outPairs.push([p[0], merged.di]);
      outSims.push(merged.s);
      outMoved.push(true);
      return;
    }
    outPairs.push(p);
    outSims.push(similarities[k]);
    outMoved.push(false);
  });
  return { pairs: outPairs, similarities: outSims, moved: outMoved };
}

/**
 * Block-level alignment of pasted output to the source specimen.
 *
 * `pairs` walks the alignment in source order: `[i, j]` pairs source block `i`
 * with pasted block `j`, `[i, null]` is a source block the paste dropped, and
 * `[null, j]` is a block the paste added. `score` is the confidence in [0, 1] —
 * mean similarity across matched pairs, discounted by how much of each side went
 * unmatched — so the studio can show "aligned with 0.91 confidence" rather than
 * pretending the pairing is certain.
 *
 * @param {import('../core/contracts.d.ts').ContentBlock[]} sourceBlocks
 * @param {import('../core/contracts.d.ts').ContentBlock[]} pastedBlocks
 * @returns {{pairs: [number|null, number|null][], score: number}}
 */
export function alignBlocks(sourceBlocks, pastedBlocks) {
  const detail = alignBlocksDetailed(sourceBlocks, pastedBlocks);
  return { pairs: detail.pairs, score: detail.score };
}
