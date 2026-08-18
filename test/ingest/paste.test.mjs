/**
 * Strategies 4 and 6 (§6) — paste HTML and manual entry.
 *
 * Manual entry is the strategy that cannot fail, and §6 requires ingest never
 * to dead-end, so the assertions here are as much about *refusing to refuse* as
 * about parsing: pasted plain text is accepted rather than rejected, and typed
 * shorthand becomes real `ContentBlock`s rather than one grey paragraph.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { importHtmlText, importManual, parseTextBlocks } from '../../src/ingest/paste.js';
import { firstElement, normalizedText, elementsByTag } from '../../src/ingest/html-parse.js';
import { fixedClock, SAMPLE_PAGE } from './helpers.mjs';

const clock = fixedClock();

// ---------------------------------------------------------------------------
// Paste HTML
// ---------------------------------------------------------------------------

test('pasted source is parsed, and the capture is stamped from the clock', () => {
  const result = importHtmlText(SAMPLE_PAGE, { clock, sourceUrl: 'https://northwind.example/approvals' });
  assert.equal(result.ok, true);
  const capture = result.value;
  assert.equal(capture.strategy, 'paste-html');
  assert.equal(capture.kind, 'html');
  assert.equal(capture.capturedAt, '2026-03-04T09:15:00.000Z');
  assert.equal(capture.sourceUrl, 'https://northwind.example/approvals');
  assert.equal(capture.meta.title, 'Northwind — Approval chains');
  assert.equal(normalizedText(firstElement(capture.doc, 'h1')), 'Approval chains');
});

test('a pasted fragment works as well as a whole document', () => {
  const result = importHtmlText('<h2>Just a section</h2><p>with a paragraph.</p>', { clock });
  assert.equal(result.ok, true);
  assert.equal(normalizedText(firstElement(result.value.doc, 'h2')), 'Just a section');
  assert.equal(result.value.sourceUrl, null);
});

test('pasted plain text is accepted and wrapped, never refused', () => {
  const result = importHtmlText('First paragraph.\n\nSecond paragraph.', { clock });
  assert.equal(result.ok, true);
  assert.equal(result.value.meta['paste.wrapped'], 'true');
  assert.equal(elementsByTag(result.value.doc, 'p').length, 2);
  assert.equal(result.value.blocks.length, 2, 'the plain-text path also produces blocks directly');
});

test('an empty paste is the one refusal, and it says what to paste', () => {
  const result = importHtmlText('   \n  ', { clock });
  assert.equal(result.ok, false);
  assert.match(result.error, /Nothing was pasted/);
  assert.match(result.error, /Ctrl-U/);
});

test('pasting without a clock refuses rather than inventing a capture time', () => {
  const result = importHtmlText('<p>x</p>', {});
  assert.equal(result.ok, false);
  assert.match(result.error, /clock/);
});

// ---------------------------------------------------------------------------
// The typed-text block parser
// ---------------------------------------------------------------------------

test('headings, both hash and setext', () => {
  assert.deepEqual(parseTextBlocks('# One\n\n## Two ##\n\nThree\n=====\n\nFour\n----'), [
    { type: 'heading', level: 1, text: 'One' },
    { type: 'heading', level: 2, text: 'Two' },
    { type: 'heading', level: 1, text: 'Three' },
    { type: 'heading', level: 2, text: 'Four' },
  ]);
});

test('paragraphs join their wrapped lines', () => {
  assert.deepEqual(parseTextBlocks('A sentence that\nwraps across lines.\n\nA second one.'), [
    { type: 'paragraph', text: 'A sentence that wraps across lines.' },
    { type: 'paragraph', text: 'A second one.' },
  ]);
});

test('bulleted and numbered lists, with continuation lines', () => {
  assert.deepEqual(parseTextBlocks('- one\n* two\n+ three'), [
    { type: 'list', ordered: false, items: ['one', 'two', 'three'] },
  ]);
  assert.deepEqual(parseTextBlocks('1. first\n2) second\n   continued'), [
    { type: 'list', ordered: true, items: ['first', 'second continued'] },
  ]);
  assert.deepEqual(parseTextBlocks('- bullet\n\n1. number'), [
    { type: 'list', ordered: false, items: ['bullet'] },
    { type: 'list', ordered: true, items: ['number'] },
  ]);
});

test('quotes, with an attribution when one is offered', () => {
  assert.deepEqual(parseTextBlocks('> The proof has to be theirs.\n> — Head of Brand'), [
    { type: 'quote', text: 'The proof has to be theirs.', attribution: 'Head of Brand' },
  ]);
  assert.deepEqual(parseTextBlocks('> A quote with no attribution.'), [
    { type: 'quote', text: 'A quote with no attribution.' },
  ]);
});

test('pipe tables, with and without a header rule', () => {
  assert.deepEqual(parseTextBlocks('| Plan | Seats |\n| --- | --- |\n| Team | 25 |'), [
    { type: 'table', rows: [['Plan', 'Seats'], ['Team', '25']], header: true },
  ]);
  assert.deepEqual(parseTextBlocks('| a | b |\n| c | d |'), [
    { type: 'table', rows: [['a', 'b'], ['c', 'd']], header: false },
  ]);
});

test('a link on its own line becomes a call to action', () => {
  assert.deepEqual(parseTextBlocks('[Book a working session](https://northwind.example/demo)'), [
    { type: 'cta', label: 'Book a working session', href: 'https://northwind.example/demo' },
  ]);
  assert.deepEqual(parseTextBlocks('Text with a [link](https://x.example) inside it.'), [
    { type: 'paragraph', text: 'Text with a [link](https://x.example) inside it.' },
  ]);
});

test('every non-empty line lands in exactly one block', () => {
  const source = [
    '# Title', '', 'Body copy.', '', '- a', '- b', '', '> quote', '', '| x | y |', '',
    '[Go](https://x.example)', '', '---', '', 'Tail paragraph.',
  ].join('\n');
  const blocks = parseTextBlocks(source);
  assert.deepEqual(blocks.map((b) => b.type), ['heading', 'paragraph', 'list', 'quote', 'table', 'cta', 'paragraph']);
});

test('the block parser never throws and never loses everything', () => {
  for (const source of ['', '   ', '#', '- ', '>', '|', '||', '1.', '[](', '\n\n\n']) {
    assert.doesNotThrow(() => parseTextBlocks(source));
  }
  assert.deepEqual(parseTextBlocks(''), []);
});

// ---------------------------------------------------------------------------
// Manual entry
// ---------------------------------------------------------------------------

test('manual entry produces a document capture with a title and blocks', () => {
  const result = importManual({
    title: 'Northwind pricing',
    text: '# Pricing that survives procurement\n\nThree plans. One contract.\n\n- Audit trail\n- Approval chains',
    sourceUrl: 'https://northwind.example/pricing',
  }, { clock });
  assert.equal(result.ok, true);
  const capture = result.value;
  assert.equal(capture.kind, 'document');
  assert.equal(capture.strategy, 'manual-entry');
  assert.equal(capture.capturedAt, '2026-03-04T09:15:00.000Z');
  assert.equal(capture.meta.title, 'Northwind pricing');
  assert.equal(capture.sourceUrl, 'https://northwind.example/pricing');
  assert.deepEqual(capture.blocks.map((b) => b.type), ['heading', 'paragraph', 'list']);
  assert.deepEqual(capture.assets, []);
  assert.equal(capture.doc, null);
});

test('manual entry takes its title from the first heading when none is given', () => {
  const result = importManual({ text: '# Inferred title\n\nBody.' }, { clock });
  assert.equal(result.value.meta.title, 'Inferred title');
});

test('manual entry accepts pre-built blocks unchanged', () => {
  const blocks = [{ type: 'paragraph', text: 'Already structured.' }];
  const result = importManual({ blocks, title: 'Given' }, { clock });
  assert.deepEqual(result.value.blocks, blocks);
});

test('manual entry with nothing in it says so rather than producing an empty specimen', () => {
  const result = importManual({ title: 'Empty', text: '   ' }, { clock });
  assert.equal(result.ok, false);
  assert.match(result.error, /type or paste some content/);
});

test('manual entry is deterministic', () => {
  const input = { title: 'T', text: '# H\n\nBody.\n\n- a\n- b' };
  assert.deepEqual(importManual(input, { clock }).value, importManual(input, { clock }).value);
});
