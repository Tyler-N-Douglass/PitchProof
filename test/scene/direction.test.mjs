/**
 * A right-to-left rendition renders right to left (CRITIQUE-2 C8).
 *
 * §9.1 asks `locale-fanout` for *"locale-appropriate structure, not just
 * translated strings"*. The critic found the ar-SA rendition arriving correctly
 * marked and being thrown away: every one of its blocks came through as `raw`
 * HTML carrying `dir="rtl" lang="ar-SA"`, and `blocks.js` flattened every `raw`
 * block to plain text under the caption "Source markup, shown as text". The
 * artifact contained no `dir="rtl"` anywhere, and the Arabic-market rendition
 * was labelled as if it were the prospect's own captured page source.
 *
 * Two rules had collided and the wrong one won. §8's "raw source is never
 * presented as markup by a layout" is about *captured* source — the prospect's
 * HTML, which a layout must not execute or trust. A rendition L7 produced from
 * a seed recipe is not captured source, and direction is not markup.
 *
 * L7's half of the fix is to stop encoding structure inside escaped HTML and to
 * carry it on the optional `dir`/`lang` extensions instead. This file is the
 * other half, and it is written so that it would fail on the code as it stood
 * even with L7's half in place: these tests hand the layouts an RTL-marked block
 * directly and assert the direction reaches the rendered tree.
 *
 * §4's `ContentBlock` and `Rendition` carry neither field. The objection to that
 * is filed in `docs/disputes/L8-scenes.md`; the fields are read where present
 * and nothing is invented where they are absent, which is the property the last
 * test here pins down.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { toHtml } from '../../src/core/vdom.js';
import { buildScene, renderSceneTree } from '../../src/scene/index.js';
import { renderBlock, summarize, blockBody } from '../../src/scene/blocks.js';
import { flowOf, flowAttrs, resolveFlow, firstFlow, isRtl } from '../../src/scene/direction.js';
import { layoutCases, contextFor, specimen, rendition, PIXEL } from '../fixtures/scene/content.mjs';

const SCENES_CSS = readFileSync(new URL('../../src/scene/scenes.css', import.meta.url).pathname, 'utf8');

/**
 * The layouts that put a rendition's *own words* on screen. Each one has to
 * carry the direction those words were written to be read in.
 */
const PROSE_LAYOUTS = ['splitBeforeAfter', 'fanOut', 'stack', 'fullBleed', 'sideNote', 'quoteCard'];

/**
 * The two that do not, and why they are not a gap.
 *
 * `contentsIndex` lists a rendition by its `label` ("ar-SA") with
 * `renditionMeta` beneath it ("pasted by the team") — a name and the tool's own
 * English sentence about how the rendition was produced, neither of which is
 * the rendition's copy. `systemMap` draws the same label into an SVG node.
 * Marking either `dir="rtl"` would be this deck claiming a direction for words
 * that are not the market's, which is the §18.2 mistake read backwards. The
 * test below pins the claim down rather than leaving it as a comment: it
 * asserts that no text from the rendition's blocks reaches either layout.
 */
const LABEL_ONLY_LAYOUTS = ['contentsIndex', 'systemMap'];

/**
 * The ar-SA rendition as L7 produces it: locale-appropriate structure, the
 * source's language, the market's direction. The text is deliberately the
 * source's own English — §18.2 and L7's D-L7-18 both say a `locale-fanout`
 * rendition reformats rather than translates, so claiming `lang="ar-SA"` over
 * English words would be a false statement about the content.
 * @param {string} id
 * @returns {any}
 */
function arabicRendition(id = 'rd_ar') {
  const mark = (block) => ({ ...block, dir: 'rtl', lang: 'en-GB' });
  return {
    ...rendition({
      id,
      label: 'ar-SA',
      blocks: [
        { type: 'heading', level: 2, text: 'Locale format contract — Saudi Arabia' },
        { type: 'paragraph', text: 'The fouling factor is the margin you design in before the exchanger is dirty.' },
        { type: 'list', ordered: false, items: ['Date 1446/07/12', 'Number 1,250.75', 'Legal line in the footer'] },
        { type: 'table', header: true, rows: [['Field', 'Pattern'], ['Date', 'YYYY/MM/DD']] },
        { type: 'quote', text: 'The layout is the market’s; the words are still the source’s.', attribution: 'Locale fan-out' },
        { type: 'media', ref: 'md_ar_hero', caption: 'Hero assembled for the Saudi market' },
      ].map(mark),
      media: [{ id: 'md_ar_hero', dataUri: PIXEL, alt: 'Hero', intrinsic: { w: 1600, h: 900 }, bytes: 68 }],
    }),
    dir: 'rtl',
  };
}

/** The words the rendition's blocks actually carry, for the label-only check. */
const RENDITION_PROSE = [
  'The fouling factor is the margin',
  'Legal line in the footer',
  'the words are still the source',
  'Hero assembled for the Saudi market',
];

/** Every `dir` attribute in a serialized tree. */
function dirsIn(html) {
  return [...html.matchAll(/\sdir="([^"]*)"/g)].map((m) => m[1]);
}

/** Every `lang` attribute in a serialized tree. */
function langsIn(html) {
  return [...html.matchAll(/\slang="([^"]*)"/g)].map((m) => m[1]);
}

test('a block that declares its direction renders with it, for every block type', () => {
  const blocks = arabicRendition().blocks;
  assert.ok(blocks.length >= 5, 'the case has to cover more than one block type');
  for (const block of blocks) {
    const html = toHtml(renderBlock(block));
    assert.match(html, /\sdir="rtl"/, `${block.type} lost its direction`);
    assert.match(html, /\slang="en-GB"/, `${block.type} lost its language`);
  }
});

test('a raw block keeps its direction, and still refuses to render as markup (§8)', () => {
  const block = {
    type: 'raw',
    html: '<h1 dir="rtl" lang="ar-SA">Designing fouling margin you will actually use</h1>',
    dir: 'rtl',
    lang: 'ar-SA',
  };
  const html = toHtml(renderBlock(block));
  // §8 still holds: the source is text, not markup.
  assert.ok(!/<h1/.test(html), 'raw HTML was rendered as markup');
  assert.match(html, /Designing fouling margin you will actually use/);
  // …and the direction survives the flattening.
  assert.match(html, /\sdir="rtl"/);
  // The caption is the tool's own English sentence about the block, so it is
  // marked as such rather than being dragged into the block's direction.
  assert.match(html, /dir="ltr" lang="en"[^>]*>Source markup, shown as text/);
});

/** Render one layout with the ar-SA rendition attached. */
function renderWithArabic(layout) {
  const spec = specimen();
  const rend = arabicRendition();
  const scene = buildScene({
    layout,
    specimen: spec,
    renditions: [rend],
    headline: 'One page, every market',
    subhead: 'Structure adapted per market.',
  });
  return {
    rend,
    html: toHtml(renderSceneTree(scene, contextFor(scene, { specimen: spec, renditions: [rend] }))),
  };
}

test('every layout that shows a rendition\'s own words shows them right to left', () => {
  /** @type {string[]} */
  const silent = [];
  for (const layout of PROSE_LAYOUTS) {
    if (!dirsIn(renderWithArabic(layout).html).includes('rtl')) silent.push(layout);
  }
  assert.deepEqual(silent, [],
    `these layouts render an ar-SA rendition left to right: ${silent.join(', ')}`);
});

test('the two layouts that carry no direction carry no rendition copy either', () => {
  for (const layout of LABEL_ONLY_LAYOUTS) {
    const { html } = renderWithArabic(layout);
    for (const phrase of RENDITION_PROSE) {
      assert.ok(!html.includes(phrase),
        `${layout} renders the rendition's copy ("${phrase}") but not its direction`);
    }
    // What it does render is the label, which is a name and not prose.
    assert.match(html, /ar-SA/, `${layout} does not list the rendition at all`);
  }
});

test('the direction reaches the summary a layout lifts out of a rendition', () => {
  const rend = arabicRendition();
  const summary = summarize(rend.blocks);
  assert.equal(summary.dir, 'rtl');
  assert.equal(summary.lang, 'en-GB');

  // `stack` and `fanOut` render that summary as their own elements rather than
  // through `renderBlock`, which is exactly where the direction used to stop.
  for (const layout of ['stack', 'fanOut']) {
    const scene = buildScene({ layout, specimen: specimen(), renditions: [rend], headline: 'h', subhead: 's' });
    const html = toHtml(renderSceneTree(scene, contextFor(scene, { specimen: specimen(), renditions: [rend] })));
    assert.ok(dirsIn(html).includes('rtl'), `${layout} dropped the direction from its summary`);
  }
});

test('a rendition that declares a direction lends it to blocks that declare none', () => {
  const rend = {
    ...rendition({
      id: 'rd_bare',
      label: 'ar-SA',
      blocks: [
        { type: 'heading', level: 2, text: 'Locale format contract' },
        { type: 'paragraph', text: 'The fouling factor is the margin you design in.' },
      ],
    }),
    dir: 'rtl',
  };
  const scene = buildScene({ layout: 'splitBeforeAfter', specimen: specimen(), renditions: [rend], headline: 'h' });
  const html = toHtml(renderSceneTree(scene, contextFor(scene, { specimen: specimen(), renditions: [rend] })));
  assert.ok(dirsIn(html).includes('rtl'), 'the rendition-level direction never reached the markup');
});

test('a block wins over its rendition, because a rendition mixes languages', () => {
  const flow = resolveFlow({ dir: 'ltr', lang: 'de-DE' }, { dir: 'rtl', lang: 'ar-SA' });
  assert.deepEqual(flow, { dir: 'ltr', lang: 'de-DE' });
  assert.deepEqual(resolveFlow({}, { dir: 'rtl', lang: 'ar-SA' }), { dir: 'rtl', lang: 'ar-SA' });
  assert.deepEqual(resolveFlow({ dir: 'rtl' }, { lang: 'ar-SA' }), { dir: 'rtl', lang: 'ar-SA' });
});

test('nothing is invented: a deck that declares no direction emits none', () => {
  for (const testCase of layoutCases()) {
    const scene = buildScene(testCase);
    const html = toHtml(renderSceneTree(scene, contextFor(scene, { specimen: testCase.specimen, renditions: testCase.renditions })));
    const dirs = dirsIn(html);
    const langs = langsIn(html);
    // The only direction any of these may carry is the `raw` caption's own,
    // which is a statement about the tool's sentence and not about the content.
    assert.deepEqual([...new Set(dirs)].filter((d) => d !== 'ltr'), [],
      `${testCase.layout} invented a direction`);
    assert.deepEqual([...new Set(langs)].filter((l) => l !== 'en'), [],
      `${testCase.layout} invented a language`);
  }
});

test('malformed direction and language values are ignored rather than passed through', () => {
  assert.deepEqual(flowOf({ dir: 'sideways', lang: 42 }), { dir: null, lang: null });
  assert.deepEqual(flowOf(null), { dir: null, lang: null });
  assert.deepEqual(flowAttrs({ dir: 'sideways' }), {});
  assert.deepEqual(flowAttrs({ dir: 'rtl', lang: '  ar-SA ' }), { dir: 'rtl', lang: 'ar-SA' });
  assert.equal(isRtl({ dir: 'rtl' }), true);
  assert.equal(isRtl({ dir: 'ltr' }), false);
  assert.deepEqual(firstFlow([{}, { dir: 'rtl' }, { lang: 'ar-SA' }]), { dir: 'rtl', lang: 'ar-SA' });
  assert.deepEqual(firstFlow('not a list'), { dir: null, lang: null });
});

test('the stylesheet lays content out logically, so a direction has something to act on', () => {
  // A `dir="rtl"` attribute that every rule then overrides with a physical
  // side is direction honoured on paper only. The rules that dress *content* —
  // the quote rule, the raw-source rule, the table's alignment — are written
  // with logical properties, and this asserts they stay that way.
  const src = SCENES_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  /** The declaration body of the first rule whose selector list contains one. */
  const rule = (selector) => {
    for (const m of src.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const selectors = m[1].split(',').map((x) => x.trim());
      if (selectors.includes(selector)) return m[2];
    }
    return null;
  };
  const quote = rule('.pp-quote');
  assert.ok(quote && /border-inline-start/.test(quote) && /padding-inline-start/.test(quote),
    '.pp-quote dresses the prospect\'s pulled quote with a physical side');
  const raw = rule('.pp-raw');
  assert.ok(raw && /border-inline-start/.test(raw) && /padding-inline-start/.test(raw),
    '.pp-raw dresses flattened source with a physical side');
  assert.ok(!/text-align:\s*(left|right)/.test(src),
    'a content rule aligns text to a physical side, which a right-to-left rendition cannot override');
});

test('an ar-SA rendition is shown, not described', () => {
  // The distinction §9.1 draws, as an assertion. Before the fix the only
  // surviving trace of the market's direction was a table row reading "Writing
  // direction · right to left" — the deck telling the room about a difference
  // instead of showing it. A rendered scene has to carry the fact structurally.
  const rend = arabicRendition();
  // A specimen with no captured source of its own, so the only thing that could
  // put the caption on screen is the rendition. (§8 still applies to the
  // specimen's own `raw` block, which is why it is taken out of the way here
  // rather than asserted about.)
  const base = specimen();
  const spec = { ...base, blocks: base.blocks.filter((b) => b.type !== 'raw') };
  const scene = buildScene({ layout: 'splitBeforeAfter', specimen: spec, renditions: [rend], headline: 'h' });
  const html = toHtml(renderSceneTree(scene, contextFor(scene, { specimen: spec, renditions: [rend] })));

  assert.ok(dirsIn(html).filter((d) => d === 'rtl').length >= rend.blocks.length,
    'not every block of the rendition carries its direction');
  assert.ok(!/Source markup, shown as text/.test(html),
    'a rendition L7 produced is being presented as the prospect\'s captured source');
});

test('a flattened raw block is still not styled as the rendition\'s own prose', () => {
  // The other half of C8: the caption was the visible symptom. A rendition that
  // still arrives as `raw` — an older proof, a hand-written one — is rendered as
  // text under the caption, because §8 is about what a layout may *execute*, and
  // that has not changed. What changed is that direction survives it.
  const html = toHtml(blockBody({ type: 'raw', html: '<p>x</p>', dir: 'rtl' }, {}));
  assert.match(html, /Source markup, shown as text/);
});
