/**
 * The manual paste surface (§9): "This path must be excellent, not a fallback."
 *
 * Excellent means faithful. These tests check the three things that actually
 * arrive on a clipboard — plain text, Markdown-ish text, and the HTML a browser
 * copies out of a rendered page — and assert the resulting blocks, not merely
 * that something came back.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parsePasted, blocksFromText, blocksFromFragment, parseFragment,
  looksLikeHtml, looksLikeCta, decodeEntities, stripInlineMarkdown, nodeText, parseAttrs,
} from '../../src/recipe/index.js';
import { validateBlock } from '../../src/core/contracts.js';
import { PASTED } from '../fixtures/recipe/specimens.mjs';

/** @param {import('../../src/core/contracts.d.ts').ContentBlock[]} blocks */
function assertContractValid(blocks) {
  /** @type {string[]} */
  const errs = [];
  blocks.forEach((b, i) => validateBlock(b, `blocks[${i}]`, errs));
  assert.deepEqual(errs, []);
}

test('parsePasted on plain text: paragraphs, and a standalone short line as a heading', () => {
  const blocks = parsePasted(PASTED.plain);
  assertContractValid(blocks);
  assert.deepEqual(blocks, [
    { type: 'heading', level: 1, text: 'Retail media, unified' },
    { type: 'paragraph', text: 'Northwind connects brands and retailers in one plan. It launched across nine markets.' },
    { type: 'heading', level: 2, text: 'What the platform covers' },
    { type: 'paragraph', text: 'Onsite, offsite and in-store inventory, planned together and reported once.' },
  ]);
});

test('parsePasted on plain text keeps a punctuated or multi-line run as a paragraph', () => {
  assert.deepEqual(parsePasted('We connect brands and retailers.'), [
    { type: 'paragraph', text: 'We connect brands and retailers.' },
  ]);
  assert.deepEqual(parsePasted('One line\nand a second line'), [
    { type: 'paragraph', text: 'One line and a second line' },
  ]);
  assert.deepEqual(parsePasted('ONSITE AND OFFSITE'), [
    { type: 'heading', level: 1, text: 'ONSITE AND OFFSITE' },
  ]);
});

test('parsePasted on Markdown-ish text', () => {
  const blocks = parsePasted(PASTED.markdown);
  assertContractValid(blocks);
  assert.deepEqual(blocks.map((b) => b.type), [
    'heading', 'paragraph', 'heading', 'list', 'quote', 'table', 'cta', 'raw',
  ]);

  assert.deepEqual(blocks[0], { type: 'heading', level: 1, text: 'Retail media, unified across every market' });
  assert.deepEqual(blocks[2], { type: 'heading', level: 2, text: 'What the platform covers' });
  assert.deepEqual(blocks[3], {
    type: 'list',
    ordered: false,
    items: ['Onsite retail media', '  Sponsored product', 'Offsite audience extension', 'In-store screens'],
  });
  assert.deepEqual(blocks[4], {
    type: 'quote',
    text: 'We moved a full quarter of planning into one workspace in a fortnight.',
    attribution: 'Head of Digital',
  });
  assert.deepEqual(blocks[5], {
    type: 'table',
    header: true,
    rows: [['Plan', 'Seats', 'Price'], ['Team', '10', '$400']],
  });
  assert.deepEqual(blocks[6], { type: 'cta', label: 'Book a demo', href: '/book-a-demo' });
  assert.match(blocks[7].html, /^<pre><code>plan --market all<\/code><\/pre>$/);
});

test('Markdown: setext headings, ordered lists, and a table without a rule row', () => {
  assert.deepEqual(parsePasted('Pricing\n=======\n\nText here, with a full stop.'), [
    { type: 'heading', level: 1, text: 'Pricing' },
    { type: 'paragraph', text: 'Text here, with a full stop.' },
  ]);
  assert.deepEqual(parsePasted('Steps\n-----\n\n1. Plan\n2. Buy\n3. Report'), [
    { type: 'heading', level: 2, text: 'Steps' },
    { type: 'list', ordered: true, items: ['Plan', 'Buy', 'Report'] },
  ]);
  assert.deepEqual(parsePasted('| a | b |\n| c | d |'), [
    { type: 'table', header: false, rows: [['a', 'b'], ['c', 'd']] },
  ]);
});

test('Markdown: inline emphasis is stripped, images become media, prose links stay prose', () => {
  assert.deepEqual(parsePasted('Some **bold** and *italic* and `code` in a sentence.'), [
    { type: 'paragraph', text: 'Some bold and italic and code in a sentence.' },
  ]);
  assert.deepEqual(parsePasted('![Planning board](/hero.png)'), [
    { type: 'media', ref: '/hero.png', caption: 'Planning board' },
  ]);
  // A link that does not read as an action stays text rather than becoming a cta.
  assert.deepEqual(parsePasted('[the full methodology and its limitations](/method)'), [
    { type: 'paragraph', text: 'the full methodology and its limitations' },
  ]);
  assert.equal(stripInlineMarkdown('**a** _b_ `c` [d](/e)'), 'a b c d');
});

test('parsePasted on pasted HTML', () => {
  const blocks = parsePasted(PASTED.html);
  assertContractValid(blocks);
  assert.deepEqual(blocks.map((b) => b.type), ['heading', 'paragraph', 'list', 'quote', 'table', 'media', 'cta']);

  assert.deepEqual(blocks[0], { type: 'heading', level: 1, text: 'Retail media, unified across every market' });
  assert.deepEqual(blocks[1], {
    type: 'paragraph',
    text: 'Northwind connects brands & retailers in one plan. Launched across nine markets.',
  });
  assert.deepEqual(blocks[2], {
    type: 'list',
    ordered: false,
    items: ['Onsite retail media', '  Sponsored product', 'Offsite audience extension'],
  });
  assert.deepEqual(blocks[3], {
    type: 'quote',
    text: 'We moved a full quarter of planning into one workspace.',
    attribution: 'Head of Digital',
  });
  assert.deepEqual(blocks[4], { type: 'table', header: true, rows: [['Plan', 'Seats'], ['Team', '10']] });
  assert.deepEqual(blocks[5], { type: 'media', ref: '/hero.png', caption: 'The unified planning board' });
  assert.deepEqual(blocks[6], { type: 'cta', label: 'Book a demo', href: '/book-a-demo' });
});

test('pasted HTML: script, style and comments are dropped, never rendered as text', () => {
  const blocks = parsePasted(PASTED.html);
  const text = JSON.stringify(blocks);
  assert.ok(!/window\.track/.test(text));
  assert.ok(!/color:red/.test(text));
  assert.deepEqual(parsePasted('<p>Kept</p><!-- <p>dropped</p> --><script>alert(1)</script>'), [
    { type: 'paragraph', text: 'Kept' },
  ]);
});

test('pasted HTML survives the malformed markup a clipboard actually produces', () => {
  assert.deepEqual(parsePasted('<div><p>One<p>Two<ul><li>A<li>B</ul>'), [
    { type: 'paragraph', text: 'One' },
    { type: 'paragraph', text: 'Two' },
    { type: 'list', ordered: false, items: ['A', 'B'] },
  ]);
  assert.deepEqual(parsePasted('<p>Unclosed and truncated <b>bold'), [
    { type: 'paragraph', text: 'Unclosed and truncated bold' },
  ]);
  assert.doesNotThrow(() => parsePasted('<<<>>><p class=unquoted data-x>Text</p></div></div>'));
});

test('pasted HTML: a table header is detected, not assumed', () => {
  const withThead = parsePasted('<table><thead><tr><td>H</td></tr></thead><tbody><tr><td>v</td></tr></tbody></table>');
  assert.equal(withThead[0].header, true);
  const allTh = parsePasted('<table><tr><th>H</th></tr><tr><td>v</td></tr></table>');
  assert.equal(allTh[0].header, true);
  const neither = parsePasted('<table><tr><td>a</td></tr><tr><td>b</td></tr></table>');
  assert.equal(neither[0].header, false);
});

test('a link becomes a cta only when it reads like one', () => {
  assert.equal(looksLikeCta('Book a demo'), true);
  assert.equal(looksLikeCta('Get started'), true);
  assert.equal(looksLikeCta('Read the report →'), true);
  assert.equal(looksLikeCta('Anything', { class: 'btn btn-primary' }), true);
  assert.equal(looksLikeCta('an in-depth account of how the platform reconciles spend across markets'), false);
  assert.equal(looksLikeCta(''), false);
  assert.deepEqual(parsePasted('<a href="/pricing" class="cta">Pricing</a>'), [
    { type: 'cta', label: 'Pricing', href: '/pricing' },
  ]);
});

test('entities are decoded, including numeric and hex forms', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &#8212; &#x2014; &nbsp;&euro;&unknownref;'), 'a & b <c> — —  €&unknownref;');
  assert.deepEqual(parsePasted('<p>Caf&eacute; &#8212; open</p>'), [
    { type: 'paragraph', text: 'Café — open' },
  ]);
});

test('looksLikeHtml distinguishes markup from prose that contains an angle bracket', () => {
  assert.equal(looksLikeHtml(PASTED.html), true);
  assert.equal(looksLikeHtml('<p>a</p><p>b</p>'), true);
  assert.equal(looksLikeHtml('Latency < 5ms and throughput > 1k'), false);
  assert.equal(looksLikeHtml(PASTED.markdown), false);
  assert.equal(looksLikeHtml(PASTED.plain), false);
});

test('parseFragment, nodeText and parseAttrs are usable on their own', () => {
  const root = parseFragment('<section id="a" data-x=\'1\' hidden><p>One<br>Two</p></section>');
  assert.equal(root.children.length, 1);
  assert.equal(root.children[0].tag, 'section');
  assert.deepEqual(root.children[0].attrs, { id: 'a', 'data-x': '1', hidden: '' });
  assert.equal(nodeText(root.children[0]), 'One\nTwo');
  assert.deepEqual(parseAttrs(' href="/x" target=_blank disabled'), { href: '/x', target: '_blank', disabled: '' });
});

test('parsePasted is deterministic and total', () => {
  assert.deepEqual(parsePasted(''), []);
  assert.deepEqual(parsePasted('   \n\n  '), []);
  assert.deepEqual(parsePasted(null), []);
  assert.deepEqual(parsePasted(undefined), []);
  for (const source of Object.values(PASTED)) {
    assert.deepEqual(parsePasted(source), parsePasted(source));
  }
});

test('blocksFromText and blocksFromFragment are reachable directly', () => {
  assert.deepEqual(blocksFromText('# Title'), [{ type: 'heading', level: 1, text: 'Title' }]);
  assert.deepEqual(blocksFromFragment(parseFragment('<h2>Title</h2>')), [{ type: 'heading', level: 2, text: 'Title' }]);
});
