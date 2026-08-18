/**
 * Graceful degradation (§6).
 *
 * "Ingest must degrade gracefully and never dead-end." That is a testable
 * claim, and this file is the test: every strategy is driven with every kind of
 * garbage a real drop can contain, and the requirements are absolute —
 *
 *   1. no strategy throws at its caller, ever;
 *   2. a failure is a `Result` with a message a seller can act on;
 *   3. when every other strategy has failed, manual entry still works.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { fetchStrategies, ingestUrl, ingestFile, ingestFiles } from '../../src/ingest/fetch.js';
import { discoverSitemap, rankCandidates, parseSitemap } from '../../src/ingest/sitemap.js';
import { importManual } from '../../src/ingest/paste.js';
import { parseHtml } from '../../src/ingest/html-parse.js';
import { fixedClock, corsBlockedHttp, makeHttp, tinyPng } from './helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '..', 'fixtures', 'ingest');
const clock = fixedClock();

/** Inputs chosen to break a parser that trusts its arguments. */
const GARBAGE = [
  undefined,
  null,
  '',
  '   ',
  'plain text with no structure at all',
  '{"almost":"json"',
  '<html>',
  new Uint8Array(0),
  new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]),
  new Uint8Array(1024),
  0,
  -1,
  [],
  {},
  { name: 'x' },
  { name: 'x.docx', bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9, 9, 9, 9]) },
  { name: 'x.pdf', bytes: new TextEncoder().encode('%PDF-1.7 truncated') },
  [{ name: 'a.html' }],
  [{ name: 'a.html', text: '' }],
];

/**
 * Run a value through a strategy and assert only that it behaved.
 * @param {import('../../src/ingest/fetch.js').Strategy} strategy
 * @param {unknown} input
 */
async function drive(strategy, input, deps) {
  let result;
  try {
    result = await strategy.run(input, deps);
  } catch (e) {
    assert.fail(`${strategy.id} threw on ${describe(input)}: ${e && e.stack ? e.stack : e}`);
  }
  assert.ok(result && typeof result.ok === 'boolean', `${strategy.id} must return a Result for ${describe(input)}`);
  if (!result.ok) assertUsableMessage(result.error, `${strategy.id} / ${describe(input)}`);
  return result;
}

/** @param {unknown} value */
function describe(value) {
  if (value instanceof Uint8Array) return `Uint8Array(${value.length})`;
  if (Array.isArray(value)) return `Array(${value.length})`;
  const text = typeof value === 'string' ? JSON.stringify(value.slice(0, 24)) : String(value);
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

/**
 * A failure message a person under time pressure can act on.
 * @param {string} message
 * @param {string} where
 */
function assertUsableMessage(message, where) {
  assert.equal(typeof message, 'string', `${where}: the error must be a string`);
  assert.ok(message.length >= 12, `${where}: "${message}" is too terse to act on`);
  assert.ok(/[.!?]$|:$/.test(message.trim()), `${where}: "${message}" should read as a sentence`);
  assert.equal(/\bat [A-Za-z$_][\w.]*\s*\(/.test(message), false, `${where}: a stack frame leaked into the message`);
  assert.equal(/undefined|\[object |NaN|TypeError:/.test(message), false, `${where}: "${message}" leaks an internal`);
}

// ---------------------------------------------------------------------------

test('no strategy throws, whatever it is handed', async () => {
  const strategies = fetchStrategies();
  for (const strategy of strategies) {
    for (const input of GARBAGE) {
      await drive(strategy, input, { clock, http: corsBlockedHttp(), proxyBase: '' });
    }
  }
});

test('no strategy throws when its dependencies are missing entirely', async () => {
  for (const strategy of fetchStrategies()) {
    for (const deps of [{}, { clock: null }, { http: 'not a function', clock }]) {
      let result;
      try {
        result = await strategy.run('anything', deps);
      } catch (e) {
        assert.fail(`${strategy.id} threw with deps ${JSON.stringify(deps)}: ${e}`);
      }
      assert.ok(result && typeof result.ok === 'boolean');
    }
  }
});

test('a network transport that misbehaves in every way still yields a Result', async () => {
  const misbehaving = [
    async () => { throw new TypeError('Failed to fetch'); },
    async () => null,
    async () => ({ ok: true }),                                   // no text() and no bytes()
    async () => ({ ok: true, status: 200, async text() { throw new Error('stream closed'); } }),
    async () => ({ ok: false, status: 500, async text() { return ''; } }),
    async () => ({ ok: true, status: 200, async text() { return ''; } }),
  ];
  for (const http of misbehaving) {
    const result = await ingestUrl('https://a.example/x', { http, clock });
    assert.ok(result && typeof result.ok === 'boolean');
    if (!result.ok) assertUsableMessage(result.error, 'ingestUrl');
  }
});

test('a sitemap fetch that misbehaves still yields a Result', async () => {
  const misbehaving = [
    async () => { throw new Error('boom'); },
    async () => ({ ok: true, status: 200, async text() { return '<not a sitemap>'; } }),
    async () => ({ ok: true, status: 200, async text() { return ''; } }),
    async () => ({ ok: false, status: 404, async text() { return ''; } }),
  ];
  for (const http of misbehaving) {
    const result = await discoverSitemap('https://a.example', { http });
    assert.ok(result && typeof result.ok === 'boolean');
    if (!result.ok) assertUsableMessage(result.error, 'discoverSitemap');
  }
});

test('an infinite sitemap index does not loop forever', async () => {
  const http = makeHttp({
    'https://a.example/sitemap.xml': {
      body: '<sitemapindex><sitemap><loc>https://a.example/sitemap.xml</loc></sitemap></sitemapindex>',
    },
  });
  const result = await discoverSitemap('https://a.example', { http });
  assert.equal(result.ok, false);
  assert.ok(http.calls.length < 20, 'the crawl is bounded');
});

test('file dispatch survives a mislabelled, truncated or empty file', async () => {
  const cases = [
    { name: 'deck.pptx', bytes: new Uint8Array(readFileSync(join(FIXTURES, 'sample.docx'))) },
    { name: 'doc.docx', bytes: new Uint8Array(readFileSync(join(FIXTURES, 'sample.pdf'))) },
    { name: 'image.png', bytes: new TextEncoder().encode('<html><p>actually html</p></html>') },
    { name: 'truncated.pdf', bytes: new Uint8Array(readFileSync(join(FIXTURES, 'sample.pdf'))).subarray(0, 120) },
    { name: 'truncated.docx', bytes: new Uint8Array(readFileSync(join(FIXTURES, 'sample.docx'))).subarray(0, 120) },
    { name: 'nameless', bytes: tinyPng() },
  ];
  for (const file of cases) {
    let result;
    try {
      result = await ingestFile(file, { clock });
    } catch (e) {
      assert.fail(`ingestFile threw on ${file.name}: ${e}`);
    }
    assert.ok(result && typeof result.ok === 'boolean', file.name);
    if (!result.ok) assertUsableMessage(result.error, file.name);
  }
});

test('a drop where every file is unusable reports what went wrong, per file', async () => {
  const result = await ingestFiles([
    { name: 'a.bin', bytes: new Uint8Array([1, 2, 3, 4]) },
    { name: 'b.bin', bytes: new Uint8Array([5, 6, 7, 8]) },
  ], { clock });
  assert.equal(result.ok, false);
  assert.equal(result.detail.problems.length, 2);
  for (const problem of result.detail.problems) assert.match(problem, /^[ab]\.bin: /);
});

test('a partly-broken drop still yields the parts that worked', async () => {
  const result = await ingestFiles([
    { name: 'broken.bin', bytes: new Uint8Array([1, 2, 3, 4]) },
    { name: 'good.pdf', bytes: new Uint8Array(readFileSync(join(FIXTURES, 'sample.pdf'))) },
  ], { clock });
  assert.equal(result.ok, true, 'one bad file does not lose the good one');
  assert.equal(result.value.length, 1);
});

test('when every automatic strategy fails, manual entry still succeeds', async () => {
  const url = 'https://locked-down.example/pricing';
  const network = await ingestUrl(url, { http: corsBlockedHttp(), clock, proxyBase: 'https://proxy.invalid/' });
  assert.equal(network.ok, false);

  const files = await ingestFiles([{ name: 'nope.bin', bytes: new Uint8Array([9, 9, 9]) }], { clock });
  assert.equal(files.ok, false);

  const typed = importManual({
    title: 'Locked Down Ltd — pricing',
    text: '# Pricing\n\nThree plans.\n\n- Team\n- Business\n- Regulated',
    sourceUrl: url,
  }, { clock });
  assert.equal(typed.ok, true, '§6: ingest never dead-ends');
  assert.equal(typed.value.blocks.length, 3);
  assert.equal(typed.value.sourceUrl, url);
});

test('the failure messages point at a next step rather than describing an internal', async () => {
  const network = await ingestUrl('https://a.example/x', { http: corsBlockedHttp(), clock });
  assert.match(network.error, /Still available:/);

  const unsupported = await ingestFile({ name: 'a.7z', bytes: new Uint8Array([0x37, 0x7a, 0xbc, 0xaf]) }, { clock });
  assert.match(unsupported.error, /Supported:/);

  const noSitemap = await discoverSitemap('https://a.example', { http: makeHttp({}) });
  assert.match(noSitemap.error, /add pages by URL/);
});

test('pathological inputs do not hang the parsers', () => {
  const deep = `${'<div>'.repeat(4000)}text${'</div>'.repeat(4000)}`;
  assert.doesNotThrow(() => parseHtml(deep));
  const wide = '<p>x</p>'.repeat(20000);
  assert.doesNotThrow(() => parseHtml(wide));
  const attrs = `<div ${'a="1" '.repeat(5000)}>x</div>`;
  assert.doesNotThrow(() => parseHtml(attrs));
  const entities = '&amp;'.repeat(50000);
  assert.doesNotThrow(() => parseHtml(entities));
});

test('the sitemap parser and ranker survive nonsense without throwing', () => {
  for (const input of ['', '<urlset>', '<urlset><url></url></urlset>', 'not xml at all', '<sitemapindex>']) {
    assert.doesNotThrow(() => parseSitemap(input, ''));
  }
  assert.doesNotThrow(() => rankCandidates([{ url: '' }, {}, null]));
  assert.doesNotThrow(() => rankCandidates([{ url: 'not-a-url', alternates: [] }]));
});
