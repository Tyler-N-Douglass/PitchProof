/**
 * Block-level alignment (§9): "a side-by-side paste surface with block-level
 * alignment to the source specimen".
 *
 * The alignment is asserted, not merely exercised. Each case names the exact
 * pairing the algorithm must produce for an insertion, a deletion, a move and a
 * pair of near-duplicates, because "it ran" is not evidence that a side-by-side
 * view will be telling the truth.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  alignBlocks, alignBlocksDetailed, blockSimilarity, typeSimilarity,
  lengthSimilarity, tokenSimilarity, substitutionScore, alignText,
  MATCH_THRESHOLD, MOVE_THRESHOLD, GAP_PENALTY, SIMILARITY_WEIGHTS, parsePasted,
} from '../../src/recipe/index.js';
import { retailSpecimen, PASTED } from '../fixtures/recipe/specimens.mjs';

const P = (text) => ({ type: 'paragraph', text });
const H = (level, text) => ({ type: 'heading', level, text });
const L = (...items) => ({ type: 'list', ordered: false, items });
const CTA = (label, href) => ({ type: 'cta', label, href });

const SOURCE = [
  H(1, 'Retail media, unified across every market'),
  P('Northwind connects brands and retailers in one plan, launched across nine markets.'),
  P('Onsite, offsite and in-store inventory is planned together and reported once.'),
  L('Onsite retail media', 'Offsite audience extension', 'In-store screens'),
  CTA('Book a demo', '/book-a-demo'),
];

test('identical block lists align one to one with full confidence', () => {
  const { pairs, score } = alignBlocks(SOURCE, SOURCE.map((b) => ({ ...b })));
  assert.deepEqual(pairs, [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]]);
  assert.equal(score, 1);
});

test('an INSERTION is reported as a pasted block with no source', () => {
  const pasted = SOURCE.slice(0, 2)
    .concat([P('A wholly new sentence about governance that the source page never carried.')])
    .concat(SOURCE.slice(2));
  const { pairs, score } = alignBlocks(SOURCE, pasted);
  assert.deepEqual(pairs, [[0, 0], [1, 1], [null, 2], [2, 3], [3, 4], [4, 5]]);
  assert.ok(score < 1 && score > 0.75, `score ${score}`);
});

test('a DELETION is reported as a source block with no pasted counterpart', () => {
  const pasted = [SOURCE[0], SOURCE[1], SOURCE[3], SOURCE[4]].map((b) => ({ ...b }));
  const { pairs, score } = alignBlocks(SOURCE, pasted);
  assert.deepEqual(pairs, [[0, 0], [1, 1], [2, null], [3, 2], [4, 3]]);
  assert.ok(score < 1);

  const detail = alignBlocksDetailed(SOURCE, pasted);
  assert.equal(detail.deleted, 1);
  assert.equal(detail.inserted, 0);
  assert.equal(detail.matched, 4);
});

test('a MOVE is recovered as a pair rather than reported as a delete plus an insert', () => {
  const pasted = [SOURCE[4], SOURCE[0], SOURCE[1], SOURCE[2], SOURCE[3]].map((b) => ({ ...b }));
  const detail = alignBlocksDetailed(SOURCE, pasted);
  assert.deepEqual(detail.pairs, [[0, 1], [1, 2], [2, 3], [3, 4], [4, 0]]);
  assert.deepEqual(detail.moved, [false, false, false, false, true]);
  assert.equal(detail.inserted, 0);
  assert.equal(detail.deleted, 0);
  assert.equal(detail.score, 1);

  const raw = alignBlocksDetailed(SOURCE, pasted, { recoverMoves: false });
  assert.equal(raw.deleted, 1, 'without move recovery a global alignment can only see a gap pair');
  assert.equal(raw.inserted, 1);
});

test('NEAR-DUPLICATES pair with the right counterpart, not the nearest index', () => {
  const source = [
    P('Plans start with onboarding and a shared workspace for every team.'),
    P('Support answers within one business day, every day of the week.'),
  ];
  const pasted = [P('Support answers within one business day, every single day of the week.')];
  const detail = alignBlocksDetailed(source, pasted);
  assert.deepEqual(detail.pairs, [[0, null], [1, 0]]);
  assert.ok(detail.similarities[1] > 0.9);
});

test('two blocks that merely share a shape are not paired', () => {
  const source = [P('Onsite, offsite and in-store inventory in one plan.')];
  const pasted = [P('Quarterly board papers are circulated by the programme office.')];
  const { pairs, score } = alignBlocks(source, pasted);
  assert.deepEqual(pairs, [[0, null], [null, 0]]);
  assert.equal(score, 0);
});

test('a reworded version of the same block still pairs', () => {
  const source = [P('Northwind connects brands and retailers in one plan, launched across nine markets.')];
  const pasted = [P('Northwind connects brands and retailers in a single plan across nine markets.')];
  const { pairs, score } = alignBlocks(source, pasted);
  assert.deepEqual(pairs, [[0, 0]]);
  assert.ok(score > 0.6, `score ${score}`);
});

test('a block that changed type is paired when its words survived', () => {
  const source = [P('Onsite retail media, offsite audience extension, in-store screens.')];
  const pasted = [L('Onsite retail media', 'offsite audience extension', 'in-store screens')];
  const { pairs } = alignBlocks(source, pasted);
  assert.deepEqual(pairs, [[0, 0]]);
});

test('a reordering plus an edit produces a truthful, deterministic pairing', () => {
  const pasted = [
    SOURCE[0],
    SOURCE[3],
    P('Northwind connects brands and retailers in one plan, now across nine markets.'),
    CTA('Book a demo', '/book-a-demo'),
  ];
  const detail = alignBlocksDetailed(SOURCE, pasted);
  // The list moved up, one paragraph was edited and one was dropped. Every
  // source and pasted index appears exactly once, the edited paragraph is
  // recovered as the moved pair, and the dropped one is reported as a deletion.
  assert.deepEqual(detail.pairs, [[0, 0], [1, 2], [2, null], [3, 1], [4, 3]]);
  assert.deepEqual(detail.moved, [false, true, false, false, false]);
  assert.equal(detail.deleted, 1);
  assert.equal(detail.inserted, 0);
  assert.deepEqual(alignBlocksDetailed(SOURCE, pasted).pairs, detail.pairs, 'and it is deterministic');
});

test('empty inputs are handled without a special case at the call site', () => {
  assert.deepEqual(alignBlocks([], []), { pairs: [], score: 1 });
  assert.deepEqual(alignBlocks(SOURCE.slice(0, 1), []), { pairs: [[0, null]], score: 0 });
  assert.deepEqual(alignBlocks([], SOURCE.slice(0, 1)), { pairs: [[null, 0]], score: 0 });
  assert.deepEqual(alignBlocks(null, null), { pairs: [], score: 1 });
});

test('every source and pasted index appears exactly once across the pairing', () => {
  const specimen = retailSpecimen();
  for (const source of Object.values(PASTED)) {
    const pasted = parsePasted(source);
    const { pairs } = alignBlocks(specimen.blocks, pasted);
    const left = pairs.map((p) => p[0]).filter((i) => i !== null);
    const right = pairs.map((p) => p[1]).filter((i) => i !== null);
    assert.equal(new Set(left).size, left.length, 'no source block is paired twice');
    assert.equal(new Set(right).size, right.length, 'no pasted block is paired twice');
    assert.deepEqual(left.slice().sort((a, b) => a - b), specimen.blocks.map((_, i) => i).filter((i) => left.includes(i)));
    assert.equal(right.length + left.length, pairs.length + pairs.filter((p) => p[0] !== null && p[1] !== null).length);
  }
});

test('the real paste fixtures align to the real specimen with usable confidence', () => {
  const specimen = retailSpecimen();
  const markdown = alignBlocks(specimen.blocks, parsePasted(PASTED.markdown));
  assert.ok(markdown.score > 0.4, `markdown score ${markdown.score}`);
  assert.ok(markdown.pairs.some(([i, j]) => i === 0 && j === 0), 'the headings pair');

  const html = alignBlocks(specimen.blocks, parsePasted(PASTED.html));
  assert.ok(html.score > 0.3, `html score ${html.score}`);
});

test('the similarity components behave as their names claim', () => {
  assert.equal(typeSimilarity(P('a'), P('b')), 1);
  assert.equal(typeSimilarity(H(1, 'a'), H(1, 'b')), 1);
  assert.ok(typeSimilarity(H(1, 'a'), H(4, 'b')) < 1);
  assert.ok(typeSimilarity(H(1, 'a'), H(4, 'b')) >= 0.6);
  assert.equal(typeSimilarity(P('a'), L('b')), 0.15);
  assert.equal(typeSimilarity(P('a'), H(2, 'b')), 0.6);

  assert.equal(lengthSimilarity('abcd', 'ab'), 0.5);
  assert.equal(lengthSimilarity('', ''), 1);
  assert.equal(lengthSimilarity('a', ''), 0);

  assert.equal(tokenSimilarity('one two three', 'one two three'), 1);
  assert.ok(tokenSimilarity('one two three', 'four five six') < 0.2);

  const weights = SIMILARITY_WEIGHTS.type + SIMILARITY_WEIGHTS.length + SIMILARITY_WEIGHTS.tokens;
  assert.ok(Math.abs(weights - 1) < 1e-12, 'the weights are a partition of 1');

  assert.equal(blockSimilarity(P('x'), P('x')), 1);
  assert.equal(blockSimilarity(null, P('x')), 0);
});

test('the substitution scale places the break-even where the documentation says', () => {
  assert.ok(Math.abs(substitutionScore(1) - 1) < 1e-12);
  assert.ok(Math.abs(substitutionScore(MATCH_THRESHOLD)) < 1e-12);
  // Two unrelated blocks of the same type and length score 0.50 from type and
  // length alone; a pair of gaps must beat that, or nothing is ever an insertion.
  const shapeOnly = SIMILARITY_WEIGHTS.type + SIMILARITY_WEIGHTS.length;
  assert.ok(substitutionScore(shapeOnly) < 2 * GAP_PENALTY, 'shape alone must not buy a pairing');
  assert.ok(MOVE_THRESHOLD > MATCH_THRESHOLD - (Math.abs(2 * GAP_PENALTY) * (1 - MATCH_THRESHOLD)),
    'move recovery is stricter than ordinary matching');
});

test('alignText distinguishes media and cta blocks that carry no visible text', () => {
  assert.notEqual(
    alignText({ type: 'media', ref: 'md_a' }),
    alignText({ type: 'media', ref: 'md_b' }),
  );
  assert.ok(alignText({ type: 'cta', label: 'Go', href: '/x' }).includes('/x'));
  assert.equal(alignText(null), '');
});
