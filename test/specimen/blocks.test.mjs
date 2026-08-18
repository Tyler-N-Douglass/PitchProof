/**
 * Block normalisation — §4's `ContentBlock` union and §8's rules about
 * headings, whitespace, `<br>` and presentational markup.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { validateBlock } from '../../src/core/contracts.js';
import {
  blocksWithTrace, isEmptyBlock, mediaIndex, repairHeadingLevels, splitOnBreaks,
  toBlocks, unrepairHeadingLevels,
} from '../../src/specimen/blocks.js';
import { bodyOf } from '../../src/specimen/dom.js';
import { parseFixtureHtml } from '../fixtures/specimen/corpus.mjs';

/** @param {string} inner @param {any} [options] */
function blocks(inner, options = {}) {
  const doc = parseFixtureHtml(`<!doctype html><html><body>${inner}</body></html>`);
  return toBlocks(bodyOf(doc), { media: [], ...options });
}

test('every emitted block satisfies the frozen ContentBlock contract', () => {
  const out = blocks(`
    <h2>Heading</h2><p>Body text.</p>
    <ul><li>One</li><li>Two</li></ul>
    <ol><li>First</li></ol>
    <blockquote><p>Quoted.</p><cite>Someone</cite></blockquote>
    <table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>
    <a class="btn" href="/x">Get started</a>
    <pre><code>code()</code></pre>`);
  /** @type {string[]} */
  const errs = [];
  out.forEach((b, i) => validateBlock(b, `blocks[${i}]`, errs));
  assert.deepEqual(errs, []);
  assert.deepEqual(out.map((b) => b.type),
    ['heading', 'paragraph', 'list', 'list', 'quote', 'table', 'cta', 'raw']);
});

test('heading hierarchy is preserved exactly, skips included', () => {
  const out = blocks('<h1>A</h1><h3>B</h3><h6>C</h6><h2>D</h2>');
  assert.deepEqual(out.map((b) => b.level), [1, 3, 6, 2]);
});

test('§8 skipped heading levels are repaired only behind the flag, and the repair reverses', () => {
  const html = '<h1>A</h1><h3>B</h3><h6>C</h6><h2>D</h2>';
  const untouched = blocks(html);
  const repaired = blocks(html, { repairHeadings: true });
  assert.deepEqual(untouched.map((b) => b.level), [1, 3, 6, 2], 'no repair without the flag');
  assert.deepEqual(repaired.map((b) => b.level), [1, 2, 3, 2], 'each skip closes by one level');
  assert.deepEqual(repaired.map((b) => b.repairedFrom), [undefined, 3, 6, undefined],
    'the original level is recorded on every block that moved');

  unrepairHeadingLevels(repaired);
  assert.deepEqual(repaired.map((b) => b.level), [1, 3, 6, 2], 'unrepair is an exact inverse');
  assert.deepEqual(repaired.map((b) => b.repairedFrom), [undefined, undefined, undefined, undefined]);

  const again = repairHeadingLevels(repaired);
  assert.equal(again.repaired, 2, 'the repair reports how many levels it moved');
});

test('a document that starts at h3 keeps its first level', () => {
  const out = blocks('<h3>Only heading</h3><p>Text.</p><h4>Sub</h4>', { repairHeadings: true });
  assert.deepEqual(out.filter((b) => b.type === 'heading').map((b) => b.level), [3, 4]);
});

test('whitespace collapses, non-breaking spaces normalise, empty blocks are dropped', () => {
  const out = blocks('<p>  a\n\n  b   c d  </p><p>   </p><p></p><h2> </h2><ul></ul>');
  assert.deepEqual(out, [{ type: 'paragraph', text: 'a b c d' }]);
  assert.equal(isEmptyBlock({ type: 'paragraph', text: '   ' }), true);
  assert.equal(isEmptyBlock({ type: 'list', ordered: false, items: [] }), true);
});

test('<br> breaks a paragraph where it separates sentences, and does not where it wraps a line', () => {
  const address = blocks('<p>Northwind Industrial<br>41 Dock Road<br>Hull HU1 2AB</p>');
  assert.deepEqual(address, [{ type: 'paragraph', text: 'Northwind Industrial 41 Dock Road Hull HU1 2AB' }],
    'a wrapped address is one paragraph');

  const sentences = blocks('<p>The line stopped twice.<br>The cause was the same both times.</p>');
  assert.deepEqual(sentences.map((b) => b.text), [
    'The line stopped twice.',
    'The cause was the same both times.',
  ]);

  const double = blocks('<p>First half<br><br>second half</p>');
  assert.deepEqual(double.map((b) => b.text), ['First half', 'second half'], 'a double <br> always breaks');

  assert.deepEqual(splitOnBreaks('onetwo'), ['one two']);
  assert.deepEqual(splitOnBreaks('Done.Next'), ['Done.', 'Next']);
});

test('presentational spans are unwrapped and inline links stay inside their sentence', () => {
  const out = blocks('<p><span class="x">The <strong>NX-8400</strong> is <em>rated</em> for '
    + '<a href="/sil">SIL 2</a> duty.</span></p>');
  assert.deepEqual(out, [{ type: 'paragraph', text: 'The NX-8400 is rated for SIL 2 duty.' }]);
});

test('a standalone button-like link becomes a cta; an ordinary sentence does not', () => {
  const cta = blocks('<div><a class="btn btn--primary" href="/demo">Request a demo</a></div>');
  assert.deepEqual(cta, [{ type: 'cta', label: 'Request a demo', href: '/demo' }]);

  const byText = blocks('<div><a href="/pricing">See pricing</a></div>');
  assert.deepEqual(byText, [{ type: 'cta', label: 'See pricing', href: '/pricing' }]);

  const button = blocks('<div><button type="button">Add to quote</button></div>');
  assert.deepEqual(button, [{ type: 'cta', label: 'Add to quote', href: null }]);

  const inline = blocks('<p>Read the <a href="/docs">documentation</a> before starting.</p>');
  assert.deepEqual(inline, [{ type: 'paragraph', text: 'Read the documentation before starting.' }]);
});

test('nested lists are flattened into their parent list with a depth marker', () => {
  const out = blocks(`<ul>
    <li>Controller<ul><li>Terminal covers</li><li>Loom<ul><li>Analogue pairs</li></ul></li></ul></li>
    <li>Licence</li>
  </ul>`);
  assert.deepEqual(out, [{
    type: 'list',
    ordered: false,
    items: ['Controller', '— Terminal covers', '— Loom', '— — Analogue pairs', 'Licence'],
  }]);
});

test('definition lists become term — definition items', () => {
  const out = blocks('<dl><dt>Scan time</dt><dd>5 ms</dd><dt>Loops</dt><dd>16</dd></dl>');
  assert.deepEqual(out, [{ type: 'list', ordered: false, items: ['Scan time — 5 ms', 'Loops — 16'] }]);
});

test('tables carry the header flag from thead or an all-th first row, and expand colspan', () => {
  const withHead = blocks('<table><thead><tr><th>A</th><th>B</th></tr></thead>'
    + '<tbody><tr><td>1</td><td>2</td></tr></tbody></table>');
  assert.deepEqual(withHead, [{ type: 'table', header: true, rows: [['A', 'B'], ['1', '2']] }]);

  const impliedHead = blocks('<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>');
  assert.equal(impliedHead[0].header, true);

  const noHead = blocks('<table><tr><td>1</td><td>2</td></tr></table>');
  assert.equal(noHead[0].header, false);

  const spanned = blocks('<table><tr><td colspan="2">Wide</td><td>End</td></tr></table>');
  assert.deepEqual(spanned[0].rows, [['Wide', 'Wide', 'End']]);
});

test('blockquote attribution comes from <cite> or <footer>, and leaves the quote text clean', () => {
  const cited = blocks('<blockquote><p>We swapped forty-two controllers.</p><cite>Maintenance manager</cite></blockquote>');
  assert.deepEqual(cited, [{
    type: 'quote', text: 'We swapped forty-two controllers.', attribution: 'Maintenance manager',
  }]);

  const footed = blocks('<blockquote><p>Counted lines, not conversions.</p><footer>— Operations director</footer></blockquote>');
  assert.deepEqual(footed, [{
    type: 'quote', text: 'Counted lines, not conversions.', attribution: 'Operations director',
  }]);

  const bare = blocks('<blockquote>Just the words.</blockquote>');
  assert.deepEqual(bare, [{ type: 'quote', text: 'Just the words.' }]);
});

test('preformatted text keeps its shape as a raw block', () => {
  const out = blocks('<pre><code>a = 1\n  b = 2</code></pre>');
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'raw');
  assert.ok(out[0].html.includes('a = 1\n  b = 2'), 'newlines and indentation survive');
});

test('images resolve to captured media by src, by basename and through srcset', () => {
  const media = [
    { id: 'md_hero', src: '/assets/hero.png' },
    { id: 'md_panel', src: 'https://cdn.example/img/panel-800.png' },
  ];
  const index = mediaIndex(media);
  assert.equal(index.get('/assets/hero.png'), 'md_hero');
  assert.equal(index.get('hero.png'), 'md_hero');

  const out = blocks(`
    <figure><img src="/assets/hero.png" alt="Hero"><figcaption>The NX-8400 in a panel</figcaption></figure>
    <img srcset="https://cdn.example/img/panel-800.png 800w, /other.png 1600w" alt="Panel">
    <img src="/missing.png" alt="Missing">`, { media });
  assert.deepEqual(out[0], { type: 'media', ref: 'md_hero', caption: 'The NX-8400 in a panel' });
  assert.deepEqual(out[1], { type: 'media', ref: 'md_panel', caption: 'Panel' });
  assert.equal(out[2].ref, '/missing.png');
  assert.equal(out[2].unresolved, true, 'an image with no captured bytes is flagged, not silently dropped');
});

test('a figure with no image keeps its caption as prose', () => {
  const out = blocks('<figure><figcaption>Figure 4 — loop response</figcaption></figure>');
  assert.deepEqual(out, [{ type: 'paragraph', text: 'Figure 4 — loop response' }]);
});

test('blocksWithTrace attributes every block to the node that produced it', () => {
  const doc = parseFixtureHtml('<!doctype html><html><body><section><h2>T</h2><p>Body.</p></section></body></html>');
  const traced = blocksWithTrace(bodyOf(doc), { media: [] });
  assert.equal(traced.length, 2);
  assert.equal(traced[0].node.tag, 'h2');
  assert.equal(traced[1].node.tag, 'p');
  assert.deepEqual(traced.map((t) => t.block), toBlocks(bodyOf(doc), { media: [] }));
});

test('form controls and decorative elements produce nothing', () => {
  const out = blocks('<form><label>Email<input type="email" name="e"></label>'
    + '<select><option>One</option></select><textarea></textarea></form><hr><svg><path/></svg>');
  assert.deepEqual(out.filter((b) => b.type !== 'cta'), [{ type: 'paragraph', text: 'Email' }]);
});
