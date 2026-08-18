/**
 * Specimen assembly — the §4 contract, §5 determinism, §8's raw-HTML rule and
 * §18.3's "if a specimen was edited, the artifact says so".
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { countWords, validateSpecimen } from '../../src/core/contracts.js';
import { IdMinter } from '../../src/core/ids.js';
import { encodePng } from '../../src/specimen/png.js';
import { inferKind, inferKindWithEvidence } from '../../src/specimen/kind.js';
import {
  buildSpecimen, extractMeta, markEdited, rawFallbackBlocks, repairHeadings,
  restoreAllBlocks, setRawHtmlOptIn, unrepairHeadings, unresolvedMediaRefs,
} from '../../src/specimen/specimen.js';
import { FIXTURES, loadCorpus, loadFixture, parseFixtureHtml } from '../fixtures/specimen/corpus.mjs';

const CLOCK = () => '2026-02-12T09:00:00.000Z';

/** @param {string} name @param {any} [options] */
function specimenFor(name, options = {}) {
  const fx = loadFixture(name);
  const capture = {
    kind: 'html',
    sourceUrl: fx.url,
    capturedAt: null,
    html: fx.html,
    doc: fx.doc,
    assets: [],
    meta: {},
    strategy: 'fixture',
  };
  return buildSpecimen(capture, { clock: CLOCK, imageQuality: 0.85, ...options });
}

test('§4 every fixture produces a specimen that passes validateSpecimen with zero errors', () => {
  for (const meta of FIXTURES) {
    const specimen = specimenFor(meta.name);
    /** @type {string[]} */
    const errs = [];
    validateSpecimen(specimen, 'specimen', errs);
    assert.deepEqual(errs, [], `${meta.name}: ${errs.join('; ')}`);
    assert.ok(specimen.blocks.length > 0, `${meta.name}: a specimen with no blocks is SPECIMEN_EMPTY`);
    assert.equal(specimen.wordCount, countWords(specimen.blocks));
    assert.equal(specimen.capturedAt, '2026-02-12T09:00:00.000Z', 'time comes from the injected clock (§5)');
  }
});

test('§5 two runs over the same capture produce an identical specimen', () => {
  for (const meta of FIXTURES) {
    const a = specimenFor(meta.name, { idMinter: new IdMinter('project-seed', 'specimen') });
    const b = specimenFor(meta.name, { idMinter: new IdMinter('project-seed', 'specimen') });
    assert.deepEqual(a, b, `${meta.name} is not deterministic`);
  }
  // And without a minter the id is content-derived, so it is stable too.
  assert.equal(specimenFor('article.html').id, specimenFor('article.html').id);
  assert.ok(specimenFor('article.html').id.startsWith('sp_'));
});

test('a different seed changes ids but nothing else about the specimen', () => {
  const a = specimenFor('home.html', { idMinter: new IdMinter('seed-a', 'specimen') });
  const b = specimenFor('home.html', { idMinter: new IdMinter('seed-b', 'specimen') });
  assert.notEqual(a.id, b.id);
  assert.deepEqual({ ...a, id: null }, { ...b, id: null });
});

test('meta carries title, description, canonical, lang and the og namespace', () => {
  const specimen = specimenFor('article.html');
  assert.equal(specimen.meta.title, 'Why retrofit programmes stall in year two | Northwind newsroom');
  assert.ok(specimen.meta.description.startsWith('Nineteen plants'));
  assert.equal(specimen.meta.canonical, 'https://www.northwind-industrial.example/news/retrofit-year-two');
  assert.equal(specimen.meta.lang, 'en');
  assert.equal(specimen.meta['og:type'], 'article');
  assert.equal(specimen.meta['og:locale'], 'en_GB');
  assert.ok(Object.values(specimen.meta).every((v) => typeof v === 'string'), 'meta is Record<string,string>');
  assert.equal(specimen.title, 'Why retrofit programmes stall in year two | Northwind newsroom');
});

test('extractMeta prefers the document but keeps what the importer already knew', () => {
  const doc = parseFixtureHtml('<!doctype html><html lang="fi"><head><title>T</title>'
    + '<meta name="description" content="D"><meta property="og:title" content="OG">'
    + '<link rel="canonical" href="https://x.example/c"></head><body><p>B</p></body></html>');
  const meta = extractMeta(doc, { strategy: 'paste', title: 'ignored — the document wins' });
  assert.equal(meta.title, 'T');
  assert.equal(meta.description, 'D');
  assert.equal(meta.canonical, 'https://x.example/c');
  assert.equal(meta.lang, 'fi');
  assert.equal(meta.strategy, 'paste');

  const noTitle = extractMeta(parseFixtureHtml('<html><head><meta property="og:title" content="Only OG"></head><body>x</body></html>'));
  assert.equal(noTitle.title, 'Only OG', 'og:title stands in when there is no <title>');
});

test('kind inference reads schema.org, og:type, the URL and the page structure', () => {
  assert.equal(specimenFor('article.html').kind, 'article');
  assert.equal(specimenFor('product.html').kind, 'product');
  assert.equal(specimenFor('home.html').kind, 'page');
  assert.equal(specimenFor('landing.html').kind, 'campaign');
  assert.equal(specimenFor('docs.html').kind, 'page');

  const jsonLd = parseFixtureHtml('<!doctype html><html><head>'
    + '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"NX"}</script>'
    + '</head><body><h1>NX</h1><p>Body.</p></body></html>');
  assert.equal(inferKind(jsonLd, 'https://acme.example/thing'), 'product');

  const microdata = parseFixtureHtml('<html><body><div itemscope itemtype="https://schema.org/NewsArticle">'
    + '<h1>Head</h1><p>Body.</p></div></body></html>');
  assert.equal(inferKind(microdata, null), 'article');

  const broken = parseFixtureHtml('<html><head><script type="application/ld+json">{"@type":"BlogPosting",</script>'
    + '</head><body><p>x</p></body></html>');
  assert.equal(inferKind(broken, null), 'article', 'malformed JSON-LD still yields its @type');

  assert.equal(inferKind(null, 'https://acme.example/whitepaper.pdf', { captureKind: 'document' }), 'document');
  assert.equal(inferKind(null, 'https://acme.example/hero.png', { captureKind: 'image' }), 'image');

  const fragment = parseFixtureHtml('<section><h3>Module</h3><p>Pasted markup.</p></section>');
  const evidence = inferKindWithEvidence(fragment, null, { blocks: [1, 2] });
  assert.ok(evidence.evidence.length > 0, 'the evidence is reported, not just the verdict');
  assert.ok(evidence.confidence > 0 && evidence.confidence <= 1);

  assert.equal(specimenFor('article.html', { kind: 'campaign' }).kind, 'campaign', 'an explicit kind always wins');
});

test('§8 raw HTML is kept untouched but never surfaces without a per-specimen opt-in', () => {
  const fx = loadFixture('home.html');
  const specimen = specimenFor('home.html');
  assert.equal(specimen.raw, fx.html, 'the untouched source is kept for fallback rendering');
  assert.deepEqual(specimen.rawOptIn, { allowed: false, by: null, at: null });

  const blocked = rawFallbackBlocks(specimen);
  assert.deepEqual(blocked.blocks, [], 'no raw HTML reaches a scene by default');
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /opt-in/);

  const opted = setRawHtmlOptIn(specimen, { allowed: true, by: 'ada@northwind.example', at: CLOCK() });
  const allowed = rawFallbackBlocks(opted);
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.blocks.length, 1);
  assert.equal(allowed.blocks[0].type, 'raw');
  assert.equal(allowed.blocks[0].html, fx.html);
  assert.equal(specimen.rawOptIn.allowed, false, 'opting in returns a new specimen; the old one is unchanged');

  assert.throws(() => setRawHtmlOptIn(specimen, { allowed: true }), /who opted in/);
  assert.throws(() => setRawHtmlOptIn(specimen, {}), /explicit/);

  const revoked = setRawHtmlOptIn(opted, { allowed: false });
  assert.deepEqual(rawFallbackBlocks(revoked).blocks, []);
});

test('§18.3 a specimen says so when it has been edited', () => {
  const specimen = specimenFor('product.html');
  assert.equal(specimen.edited, false);
  assert.deepEqual(specimen.editNotes, []);

  const trimmed = markEdited(specimen, {
    blocks: specimen.blocks.slice(0, 4),
    note: 'trimmed to the four blocks the scene shows',
    at: CLOCK(),
  });
  assert.equal(trimmed.edited, true);
  assert.equal(trimmed.blocks.length, 4);
  assert.equal(trimmed.wordCount, countWords(trimmed.blocks), 'the word count follows the edit');
  assert.match(trimmed.editNotes[0], /trimmed to the four blocks/);
  assert.equal(specimen.edited, false, 'the original is untouched');
  assert.throws(() => markEdited(specimen, {}), /what was changed/);

  // Restoring stripped chrome is not an edit — it does not change the
  // prospect's own words, it puts back what we took out.
  assert.equal(restoreAllBlocks(specimen).edited, false);
});

test('heading repair on a built specimen is opt-in and reversible', () => {
  const html = '<!doctype html><html lang="en"><head><title>T</title></head><body><main>'
    + '<h1>A</h1><p>Long enough paragraph of prose to look like content on this page.</p>'
    + '<h4>B</h4><p>More prose that keeps this section looking like a real article body.</p>'
    + '</main></body></html>';
  const capture = { kind: 'html', sourceUrl: 'https://acme.example/x', capturedAt: CLOCK(), html, doc: parseFixtureHtml(html), assets: [], meta: {} };

  const plain = buildSpecimen(capture, { clock: CLOCK, imageQuality: 0.85 });
  assert.deepEqual(plain.blocks.filter((b) => b.type === 'heading').map((b) => b.level), [1, 4]);
  assert.equal(plain.headingsRepaired, false);

  const fixed = buildSpecimen(capture, { clock: CLOCK, imageQuality: 0.85, repairHeadings: true });
  assert.deepEqual(fixed.blocks.filter((b) => b.type === 'heading').map((b) => b.level), [1, 2]);
  assert.equal(fixed.headingsRepaired, true);

  const back = unrepairHeadings(fixed);
  assert.deepEqual(back.blocks.filter((b) => b.type === 'heading').map((b) => b.level), [1, 4]);
  assert.equal(back.headingsRepaired, false);
  assert.deepEqual(repairHeadings(back).blocks.map((b) => b.level), fixed.blocks.map((b) => b.level));
});

test('media is inlined, indexed into blocks, and anything unresolved is reported', () => {
  const png = encodePng(new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 9, 9, 9, 255]), 2, 2);
  const html = '<!doctype html><html lang="en"><head><title>Gallery</title></head><body><main>'
    + '<h1>Gallery</h1>'
    + '<figure><img src="/img/panel.png" alt="A panel"><figcaption>Panel detail</figcaption></figure>'
    + '<p>Prose about the panel that runs long enough to be treated as real content by the classifier.</p>'
    + '<img src="/img/never-fetched.png" alt="Missing">'
    + '</main></body></html>';
  const capture = {
    kind: 'html',
    sourceUrl: 'https://acme.example/gallery',
    capturedAt: CLOCK(),
    html,
    doc: parseFixtureHtml(html),
    assets: [{ name: '/img/panel.png', bytes: png, mime: 'image/png' }],
    meta: {},
  };
  const specimen = buildSpecimen(capture, { clock: CLOCK, imageQuality: 0.85 });

  assert.equal(specimen.media.length, 1);
  assert.equal(specimen.media[0].alt, 'A panel', 'alt text comes from the page, not from the file name');
  assert.deepEqual(specimen.media[0].intrinsic, { w: 2, h: 2 });
  assert.ok(specimen.media[0].dataUri.startsWith('data:image/png;base64,'));

  const mediaBlocks = specimen.blocks.filter((b) => b.type === 'media');
  assert.equal(mediaBlocks[0].ref, specimen.media[0].id);
  assert.equal(mediaBlocks[0].caption, 'Panel detail');
  assert.deepEqual(unresolvedMediaRefs(specimen), ['/img/never-fetched.png']);
});

test('a capture whose importer already produced blocks is passed through untouched', () => {
  const blocks = [
    { type: 'heading', level: 1, text: 'Quarterly plant review' },
    { type: 'paragraph', text: 'Extracted from a .docx by the ingest lane.' },
  ];
  const specimen = buildSpecimen({
    kind: 'document',
    sourceUrl: null,
    capturedAt: CLOCK(),
    html: null,
    doc: null,
    blocks,
    assets: [],
    meta: { title: 'Quarterly plant review' },
  }, { clock: CLOCK, imageQuality: 0.85 });

  assert.equal(specimen.kind, 'document');
  assert.deepEqual(specimen.blocks, blocks);
  assert.equal(specimen.chrome.locator, 'importer', 'there is no page chrome in a document');
  assert.deepEqual(specimen.stripped, []);
  assert.equal(specimen.raw, null);
  assert.equal(specimen.locale, null);
  /** @type {string[]} */
  const errs = [];
  validateSpecimen(specimen, 'specimen', errs);
  assert.deepEqual(errs, []);
});

test('buildSpecimen refuses to invent a clock, and parses HTML with L3 rather than its own parser (D8)', () => {
  assert.throws(() => buildSpecimen({ kind: 'html', html: '<p>x</p>', doc: parseFixtureHtml('<p>x</p>'), assets: [] }, {}),
    /clock is required/);

  const html = '<html lang="en"><body><main><h1>Hi</h1><p>Some prose for the body of this page.</p></main></body></html>';
  // A capture that carries only HTML is parsed through `src/ingest` — this
  // lane contains no HTML parser of its own.
  const parsedHere = buildSpecimen(
    { kind: 'html', html, doc: null, assets: [], capturedAt: CLOCK() },
    { clock: CLOCK, imageQuality: 0.85 },
  );
  assert.equal(parsedHere.blocks[0].text, 'Hi');

  // …and an explicitly supplied parser is still honoured, which is how a test
  // or a browser host can substitute one.
  const withParser = buildSpecimen(
    { kind: 'html', html, doc: null, assets: [], capturedAt: CLOCK() },
    { clock: CLOCK, imageQuality: 0.85, parseHtml: parseFixtureHtml },
  );
  assert.deepEqual(withParser.blocks, parsedHere.blocks);
});

test('the chrome report on a specimen says how the root was found and what was removed', () => {
  const corpus = loadCorpus();
  const specimen = specimenFor('product.html', { siblings: corpus.map((o) => o.doc) });
  assert.equal(specimen.chrome.locator, 'main');
  assert.equal(specimen.chrome.root, 'body > main#main');
  assert.ok(specimen.chrome.removedCount >= 5);
  assert.equal(specimen.chrome.siblingPages, corpus.length - 1);
  for (const entry of specimen.stripped) {
    assert.ok(entry.id.startsWith('bl_'));
    assert.ok(typeof entry.reason === 'string' && entry.reason);
    assert.ok(Array.isArray(entry.blocks));
    assert.equal(entry.blocks.length, entry.positions.length);
  }
  // The stripped record is plain data: it must survive a JSON round trip,
  // because a Specimen is stored in IndexedDB and emitted into an artifact.
  const json = JSON.stringify(specimen);
  assert.deepEqual(JSON.parse(json).blocks, specimen.blocks);
  assert.ok(json.length > 0);
});

test('a specimen of a page with no content at all is still contract-valid', () => {
  const html = '<!doctype html><html lang="en"><head><title>Empty</title></head><body><nav><a href="/a">A</a></nav></body></html>';
  const specimen = buildSpecimen(
    { kind: 'html', sourceUrl: 'https://acme.example/empty', capturedAt: CLOCK(), html, doc: parseFixtureHtml(html), assets: [], meta: {} },
    { clock: CLOCK, imageQuality: 0.85 },
  );
  /** @type {string[]} */
  const errs = [];
  validateSpecimen(specimen, 'specimen', errs);
  assert.deepEqual(errs, []);
  assert.equal(specimen.title, 'Empty', 'the title still comes from the page');
  assert.equal(specimen.wordCount, countWords(specimen.blocks));
});
