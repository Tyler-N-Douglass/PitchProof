/**
 * §17.5 — chrome stripping, measured.
 *
 * "Fixture pages with hand-labeled content regions; assert block-level F1 ≥ 0.9."
 *
 * The corpus is seven pages of one hostile enterprise site (`test/fixtures/
 * specimen/`), each carrying hand-written `data-pp-truth` labels the classifier
 * never sees. Precision, recall and F1 are computed per fixture and overall,
 * and printed, so a regression says *which* page and *which* block moved.
 *
 * Four things are asserted, not asserted-about:
 *   1. overall block-level F1 ≥ 0.9 from a single page with no siblings;
 *   2. supplying sibling pages measurably improves F1 on the same corpus;
 *   3. every stripped block can be restored, and the restored specimen is
 *      identical to the never-stripped one;
 *   4. the classifier still works when every class and id is obfuscated, which
 *      is what a modern build pipeline does to a real site.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { fnv1a32 } from '../../src/core/hash.js';
import { toBlocks } from '../../src/specimen/blocks.js';
import {
  classifyChrome, docFingerprint, excludeSelf, locateMainRoot, restoreNode, restoreNodes,
  siblingIndex, stripChrome,
} from '../../src/specimen/chrome.js';
import { attrOf, bodyOf, cloneTree, elements, linkParents, textOf } from '../../src/specimen/dom.js';
import { buildSpecimen, restoreAllBlocks, restoreBlock } from '../../src/specimen/specimen.js';
import {
  FIXTURES, PARSER_SOURCE, blockKey, fixtureHtml, groundTruthBlocks, loadCorpus,
  loadFixture, parseFixtureHtml, pct, scoreBlocks,
} from '../fixtures/specimen/corpus.mjs';

/** §17.5's floor. Not to be lowered — fix the classifier instead. */
const F1_FLOOR = 0.9;

/**
 * Score the whole corpus in one mode.
 * @param {{siblings: boolean, obfuscate?: boolean, label: string}} mode
 */
function runCorpus(mode) {
  const corpus = loadCorpus();
  if (mode.obfuscate) for (const fx of corpus) obfuscateIdentity(fx.doc);

  let tp = 0;
  let fp = 0;
  let fn = 0;
  /** @type {any[]} */
  const rows = [];
  for (const fx of corpus) {
    const siblings = mode.siblings ? corpus.filter((o) => o !== fx).map((o) => o.doc) : [];
    const { root, removed, how } = stripChrome(fx.doc, { siblings });
    const predicted = toBlocks(root, { media: [] });
    const truth = groundTruthBlocks(fx.doc);
    const score = scoreBlocks(predicted, truth);
    tp += score.tp; fp += score.fp; fn += score.fn;
    rows.push({ fixture: fx, score, predicted, truth, removed, how });
  }
  const precision = tp / Math.max(1, tp + fp);
  const recall = tp / Math.max(1, tp + fn);
  const f1 = (precision + recall) === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { rows, precision, recall, f1, tp, fp, fn, label: mode.label };
}

/** Rewrite every class/id/data-* token, leaving tags, roles and aria-* alone. */
function obfuscateIdentity(doc) {
  for (const el of elements(doc)) {
    if (!el.attrs) continue;
    for (const name of ['class', 'id', 'data-testid', 'data-component', 'data-module']) {
      const value = attrOf(el, name);
      if (!value) continue;
      el.attrs[name] = value.trim().split(/\s+/).map((t) => `x${fnv1a32(t).toString(36)}`).join(' ');
    }
  }
  return doc;
}

/** @param {any} result */
function report(result) {
  const lines = [`\n  chrome stripping — ${result.label}   (parser: ${PARSER_SOURCE})`];
  lines.push(`  ${'fixture'.padEnd(20)} ${'root'.padEnd(8)} truth pred  precision  recall  F1`);
  for (const row of result.rows) {
    lines.push(`  ${row.fixture.name.padEnd(20)} ${String(row.how).padEnd(8)} `
      + `${String(row.truth.length).padStart(5)} ${String(row.predicted.length).padStart(4)}  `
      + `${pct(row.score.precision).padStart(9)}  ${pct(row.score.recall).padStart(6)}  ${row.score.f1.toFixed(3)}`);
    for (const k of row.score.falsePositives) lines.push(`      chrome kept:   ${k.slice(0, 96)}`);
    for (const k of row.score.falseNegatives) lines.push(`      content lost:  ${k.slice(0, 96)}`);
  }
  lines.push(`  ${'OVERALL'.padEnd(29)} ${String(result.tp + result.fn).padStart(5)} ${String(result.tp + result.fp).padStart(4)}  `
    + `${pct(result.precision).padStart(9)}  ${pct(result.recall).padStart(6)}  ${result.f1.toFixed(4)}`);
  console.log(lines.join('\n'));
}

test('§17.5 the corpus is six hostile page types plus an adversarial seventh, hand-labelled', () => {
  assert.ok(FIXTURES.length >= 6, 'at least six fixture pages');
  const kinds = FIXTURES.map((f) => f.name);
  assert.deepEqual(kinds, [
    'home.html', 'product.html', 'article.html', 'article-de.html',
    'docs.html', 'adversarial.html', 'landing.html',
  ]);
  for (const meta of FIXTURES) {
    const fx = loadFixture(meta.name);
    const truth = groundTruthBlocks(fx.doc);
    assert.equal(truth.length, meta.contentBlocks,
      `${meta.name}: hand-labelled ground truth changed (${truth.length} blocks, expected ${meta.contentBlocks})`);
    assert.ok(truth.length >= 6, `${meta.name}: a fixture with fewer than six content blocks proves little`);
    // Every fixture must actually be hostile: chrome outnumbering content is
    // the condition §22.3 is about.
    const all = toBlocks(bodyOf(fx.doc), { media: [] });
    assert.ok(all.length > truth.length * 1.5,
      `${meta.name}: only ${all.length} raw blocks against ${truth.length} content blocks — not a hostile page`);
  }
});

test('§17.5 block-level F1 ≥ 0.9 on a single page, with no sibling pages available', () => {
  const result = runCorpus({ siblings: false, label: 'single page (no siblings)' });
  report(result);
  assert.ok(result.f1 >= F1_FLOOR, `overall F1 ${result.f1.toFixed(4)} is below the §17.5 floor of ${F1_FLOOR}`);
  assert.ok(result.recall >= 0.95, `recall ${result.recall.toFixed(4)}: content is being thrown away`);
  for (const row of result.rows) {
    assert.ok(row.score.recall >= 0.8,
      `${row.fixture.name}: recall ${row.score.recall.toFixed(3)} — a specimen missing its own content is worse than one with chrome in it`);
  }
});

test('§17.5 sibling pages measurably improve F1 on the same corpus', () => {
  const alone = runCorpus({ siblings: false, label: 'single page (no siblings)' });
  const together = runCorpus({ siblings: true, label: 'with sibling pages (repeated-across-pages signal live)' });
  report(together);
  console.log(`\n  repeated-across-pages signal: F1 ${alone.f1.toFixed(4)} → ${together.f1.toFixed(4)}`
    + `  (precision ${pct(alone.precision)} → ${pct(together.precision)})\n`);

  assert.ok(together.f1 >= F1_FLOOR, `overall F1 ${together.f1.toFixed(4)} is below the §17.5 floor`);
  assert.ok(together.f1 > alone.f1, 'siblings must improve F1, not merely not hurt it');
  assert.ok(together.precision > alone.precision, 'the gain must come from catching chrome a single page cannot see');
  assert.ok(together.recall >= alone.recall, 'the repeat signal must not cost recall');
});

test('§17.5 the classifier survives obfuscated class and id names', () => {
  const alone = runCorpus({ siblings: false, obfuscate: true, label: 'obfuscated identities, no siblings' });
  const together = runCorpus({ siblings: true, obfuscate: true, label: 'obfuscated identities, with siblings' });
  report(alone);
  report(together);
  // A build pipeline that hashes class names removes signal (c) almost
  // entirely; landmarks, link density, phrases and repetition must carry it.
  assert.ok(alone.f1 >= 0.85, `obfuscated single-page F1 ${alone.f1.toFixed(4)} — the classifier is leaning on class names`);
  assert.ok(together.f1 >= F1_FLOOR, `obfuscated F1 with siblings ${together.f1.toFixed(4)} is below the §17.5 floor`);
});

test('the four signals each catch what they are for', () => {
  const corpus = loadCorpus();
  const home = corpus.find((f) => f.name === 'home.html');
  const siblings = corpus.filter((o) => o !== home).map((o) => o.doc);
  const { removed, root, how } = stripChrome(home.doc, { siblings });
  const bySelector = new Map(removed.map((e) => [e.selector, e]));

  assert.equal(how, 'main', 'the main-content locator should use <main> when the page has one');
  assert.equal(root.tag, 'main');

  const skip = [...bySelector.keys()].find((k) => k.includes('skip-link'));
  assert.ok(skip, 'the skip link is chrome');

  const header = bySelector.get('body > header.site-header');
  assert.ok(header, 'the site header is chrome');
  assert.ok(header.signals.landmark > 0, '(a) landmark');
  assert.ok(header.signals.linkDensity > 0, '(b) link density');
  assert.ok(header.signals.repeated > 0, '(d) repeated across pages');

  const cookie = bySelector.get('body > div.cookie-consent');
  assert.ok(cookie, 'the cookie banner is chrome');
  assert.ok(cookie.signals.boilerplate > 0, '(c) boilerplate lexicon');
  assert.ok(cookie.detail.some((d) => d.startsWith('text:')), 'the banner is caught by what it says as well as what it is called');

  const blurb = [...bySelector.values()].find((e) => e.selector.includes('boilerplate-blurb'));
  assert.ok(blurb, 'the repeated blurb is chrome');
  assert.equal(blurb.reason, 'repeated-across-pages',
    'a block with no landmark, no links and no lexicon hit can only be caught by repetition');

  // And the page keeps its own headline and prose.
  const blocks = toBlocks(root, { media: [] });
  assert.ok(blocks.some((b) => b.type === 'heading' && b.text.startsWith('Industrial automation')));
  assert.ok(blocks.some((b) => b.type === 'table'));
});

test('the short-text guard keeps a one-sentence paragraph that contains a link', () => {
  const doc = loadFixture('article.html').doc;
  const { root } = stripChrome(doc, {});
  const text = textOf(root);
  assert.ok(text.includes('Our privacy policy prevents us naming the plants'),
    'a content sentence that mentions a privacy policy is prose, not a footer');
});

test('the main-content locator finds a root without <main>, and never returns nothing', () => {
  const landing = loadFixture('landing.html');
  const { how, root } = stripChrome(landing.doc, {});
  assert.equal(how, 'density', 'a page with no <main> falls through to the text-density peak');
  assert.ok(textOf(root).length > 0);

  const fragment = loadFixture('home.html');
  const body = bodyOf(linkParents(cloneTree(fragment.doc)));
  const located = locateMainRoot(body);
  assert.ok(located.root, 'the locator always returns a root');
});

test('siblingIndex accepts documents, captures and wrapped roots alike', () => {
  const corpus = loadCorpus();
  const asDocs = siblingIndex(corpus.map((f) => f.doc));
  const asCaptures = siblingIndex(corpus.map((f) => ({ doc: f.doc })));
  assert.equal(asDocs.pages, corpus.length);
  assert.equal(asCaptures.pages, corpus.length);
  assert.equal(asDocs.texts.size, asCaptures.texts.size);
  assert.ok(asDocs.texts.size > 0 && asDocs.structs.size > 0);
});

test('stripping never mutates the caller\'s document', () => {
  const fx = loadFixture('product.html');
  const before = elements(fx.doc).length;
  const beforeText = textOf(fx.doc);
  stripChrome(fx.doc, { siblings: [loadFixture('home.html').doc] });
  assert.equal(elements(fx.doc).length, before);
  assert.equal(textOf(fx.doc), beforeText);
});

test('§8 stripping is reversible at the tree level — restoreNode puts a subtree back exactly', () => {
  const fx = loadFixture('docs.html');
  const { body, removed } = stripChrome(fx.doc, {});
  assert.ok(removed.length > 0);
  const strippedText = textOf(body);
  assert.ok(restoreNode(removed[removed.length - 1]), 'a single removal is restorable on its own');
  assert.equal(restoreNodes(removed.slice(0, -1)), removed.length - 1, 'every removal is restorable');
  const restoredText = textOf(body);
  const originalText = textOf(bodyOf(fx.doc));
  assert.notEqual(strippedText, restoredText, 'the strip actually removed something');
  assert.equal(restoredText, originalText, 'restoring every removal reproduces the original document text');
});

test('§8 stripping is reversible at the block level — a restored specimen equals the unstripped one', () => {
  const clock = () => '2026-02-12T09:00:00.000Z';
  for (const meta of FIXTURES) {
    const fx = loadFixture(meta.name);
    const capture = { kind: 'html', sourceUrl: fx.url, capturedAt: clock(), html: fx.html, doc: fx.doc, assets: [], meta: {}, strategy: 'fixture' };

    const stripped = buildSpecimen(capture, { clock, imageQuality: 0.85 });
    const restored = restoreAllBlocks(stripped);

    // The reference: the same capture built with stripping switched off, so
    // the block stream is the whole page.
    const unstripped = buildSpecimen(capture, { clock, imageQuality: 0.85, strip: false });

    assert.deepEqual(
      restored.blocks.map(blockKey),
      unstripped.blocks.map(blockKey),
      `${meta.name}: restoring every stripped block must reproduce the unstripped block stream`,
    );
    assert.equal(restored.stripped.length, 0, `${meta.name}: nothing left stripped after a full restore`);
    assert.equal(restored.restored.length, stripped.stripped.length, `${meta.name}: every restore is recorded`);
    assert.ok(restored.wordCount > stripped.wordCount, `${meta.name}: restoring puts words back`);
    assert.equal(stripped.edited, false, 'stripping and restoring chrome is not an edit (§18.3)');
  }
});

test('restoreBlock puts one block back in its original position, and is order-independent', () => {
  const clock = () => '2026-02-12T09:00:00.000Z';
  const fx = loadFixture('home.html');
  const capture = { kind: 'html', sourceUrl: fx.url, capturedAt: clock(), html: fx.html, doc: fx.doc, assets: [], meta: {} };
  const specimen = buildSpecimen(capture, { clock, imageQuality: 0.85 });
  const entries = specimen.stripped.filter((e) => e.blocks.length > 0);
  assert.ok(entries.length >= 3);

  const byId = (s0, id) => {
    const entry = s0.stripped.find((e) => e.id === id);
    return entry ? restoreBlock(s0, entry) : s0;
  };
  const forwards = entries.reduce((s0, e) => byId(s0, e.id), specimen);
  const backwards = [...entries].reverse().reduce((s0, e) => byId(s0, e.id), specimen);
  assert.deepEqual(forwards.blocks.map(blockKey), backwards.blocks.map(blockKey),
    'restoring in any order lands on the same block stream');

  const blocksBefore = specimen.blocks.length;
  const strippedBefore = specimen.stripped.length;
  const one = restoreBlock(specimen, entries[0]);
  assert.equal(one.blocks.length, blocksBefore + entries[0].blocks.length);
  assert.equal(one.stripped.length, strippedBefore - 1);
  // The caller's specimen is untouched — the command stack (§15) needs that.
  assert.equal(specimen.blocks.length, blocksBefore);
  assert.equal(specimen.stripped.length, strippedBefore);

  // Restoring by id and by the `stripChrome` entry shape both work.
  assert.equal(restoreBlock(specimen, entries[1].id).blocks.length, blocksBefore + entries[1].blocks.length);
  assert.throws(() => restoreBlock(specimen, { id: 'bl_nosuchblock' }), /not among/);
});

test('every removed entry carries the evidence a reviewer needs', () => {
  const corpus = loadCorpus();
  const fx = corpus.find((f) => f.name === 'article.html');
  const { removed } = stripChrome(fx.doc, { siblings: corpus.filter((o) => o !== fx).map((o) => o.doc) });
  for (const entry of removed) {
    assert.ok(typeof entry.reason === 'string' && entry.reason.length > 0, 'a reason');
    assert.ok(Number.isFinite(entry.score), 'a score');
    assert.ok(entry.selector.includes('>') || entry.selector.length > 0, 'where it came from');
    assert.ok(Array.isArray(entry.path), 'an index path for exact re-insertion');
    assert.ok(entry.signals && typeof entry.signals.landmark === 'number', 'the signal breakdown');
    assert.ok(Array.isArray(entry.detail), 'human-readable detail');
  }
});

test('the page under analysis is excluded from its own sibling set, by identity and by fingerprint', () => {
  const corpus = loadCorpus();
  for (const fx of corpus) {
    // The obvious caller mistake: hand over every page that was captured,
    // including this one. Without self-exclusion every block "repeats" and the
    // specimen comes back empty — a silent, total loss of the prospect's own
    // content, which is the same wound as under-stripping (§22.3).
    const withSelf = stripChrome(fx.doc, { siblings: corpus.map((o) => o.doc) });
    const withoutSelf = stripChrome(fx.doc, { siblings: corpus.filter((o) => o !== fx).map((o) => o.doc) });
    const a = toBlocks(withSelf.root, { media: [] }).map(blockKey);
    const b = toBlocks(withoutSelf.root, { media: [] }).map(blockKey);
    assert.deepEqual(a, b, `${fx.name}: passing the page itself as a sibling must change nothing`);
    assert.equal(withSelf.siblingPages, corpus.length - 1);
    assert.ok(withSelf.notes.some((n) => n.includes('were this page')), 'the exclusion is reported, not silent');
  }

  // A caller who re-parsed the same HTML holds a different object graph, so
  // identity is not enough; the content fingerprint catches it.
  const fx = corpus[0];
  const twin = parseFixtureHtml(fx.html);
  assert.equal(docFingerprint(twin), docFingerprint(fx.doc));
  const reparsed = stripChrome(fx.doc, { siblings: [twin] });
  assert.equal(reparsed.siblingPages, 0);
  assert.deepEqual(
    toBlocks(reparsed.root, { media: [] }).map(blockKey),
    toBlocks(stripChrome(fx.doc, {}).root, { media: [] }).map(blockKey),
  );

  assert.deepEqual(excludeSelf([], fx.doc), []);
  assert.equal(excludeSelf(corpus.map((o) => ({ doc: o.doc })), fx.doc).length, corpus.length - 1,
    'RawCapture-shaped siblings are excluded on the same terms');
});

test('a sibling index that condemns the whole page trips the circuit breaker instead of emptying it', () => {
  const fx = loadFixture('article.html');
  const body = bodyOf(linkParents(cloneTree(fx.doc)));
  // A caller that forces an index built from this very page bypasses
  // self-exclusion; the classifier must still not return an empty specimen.
  const forced = classifyChrome(body, { index: siblingIndex([fx.doc]) });
  assert.ok(forced.notes.some((n) => n.includes('repeat signal disabled')), 'the fallback is reported');

  const plain = classifyChrome(bodyOf(linkParents(cloneTree(fx.doc))), {});
  assert.deepEqual(forced.removed.map((e) => e.selector), plain.removed.map((e) => e.selector),
    'the fallback classification is exactly the single-page one');
});

test('a specimen built with every captured page as siblings keeps its content', () => {
  const clock = () => '2026-02-12T09:00:00.000Z';
  const corpus = loadCorpus();
  const docs = corpus.map((o) => o.doc);
  for (const fx of corpus) {
    const capture = { kind: 'html', sourceUrl: fx.url, capturedAt: clock(), html: fx.html, doc: fx.doc, assets: [], meta: {} };
    const specimen = buildSpecimen(capture, { clock, imageQuality: 0.85, siblings: docs });
    const truth = groundTruthBlocks(fx.doc);
    assert.deepEqual(specimen.blocks.map(blockKey), truth.map(blockKey),
      `${fx.name}: the end-to-end specimen must be exactly the hand-labelled content`);
    assert.ok(specimen.wordCount > 20, `${fx.name}: words survive self-in-siblings`);
    assert.equal(specimen.chrome.siblingPages, corpus.length - 1);
  }
});

test('the measurement does not depend on which parser produced the tree', async () => {
  // The corpus normally runs on L3's parser. The fixture-local builder exists
  // so this lane could be scored before L3 landed; running the corpus through
  // both proves the F1 above is a property of the classifier rather than of one
  // parser's quirks — and keeps the fallback from rotting.
  const { buildDoc } = await import('../fixtures/specimen/doc-builder.mjs');
  const docs = FIXTURES.map((f) => ({ meta: f, doc: buildDoc(fixtureHtml(f.name)) }));
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const entry of docs) {
    const siblings = docs.filter((o) => o !== entry).map((o) => o.doc);
    const { root } = stripChrome(entry.doc, { siblings });
    const score = scoreBlocks(toBlocks(root, { media: [] }), groundTruthBlocks(entry.doc));
    tp += score.tp; fp += score.fp; fn += score.fn;
  }
  const precision = tp / (tp + fp);
  const recall = tp / (tp + fn);
  const f1 = (2 * precision * recall) / (precision + recall);
  console.log(`\n  chrome stripping — fixture-local parser: P=${pct(precision)} R=${pct(recall)} F1=${f1.toFixed(4)}\n`);
  assert.ok(f1 >= F1_FLOOR, `F1 ${f1.toFixed(4)} under the fallback parser is below the §17.5 floor`);
});
