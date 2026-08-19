/**
 * Fetch strategies (§6.1–§6.2, §6.5 dispatch).
 *
 * The behaviour under test is the product law, not just the code path: a CORS
 * refusal is a normal outcome that must degrade quietly and point at the next
 * strategy, and no strategy may throw at its caller.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  fetchStrategies, strategyById, nextStepsMessage, proxyUrl,
  fetchDirect, fetchViaProxy, ingestUrl, ingestFile, ingestFiles,
} from '../../src/ingest/fetch.js';
import { fixedClock, makeHttp, corsBlockedHttp, SAMPLE_PAGE, tinyPng, bytesOf } from './helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '..', 'fixtures', 'ingest');
const clock = fixedClock();
const URL_UNDER_TEST = 'https://northwind.example/approvals';

// ---------------------------------------------------------------------------
// The strategy table
// ---------------------------------------------------------------------------

test('the strategies are exactly §6, in §6 order', () => {
  const strategies = fetchStrategies();
  assert.deepEqual(strategies.map((s) => s.id), [
    'direct-fetch', 'cors-proxy', 'saved-page', 'har', 'mhtml', 'paste-html', 'file-import', 'manual-entry',
  ]);
  assert.deepEqual(strategies.map((s) => s.order), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(strategies.map((s) => s.specOrder), [1, 2, 3, 3, 3, 4, 5, 6]);
  for (const strategy of strategies) {
    assert.equal(typeof strategy.run, 'function', `${strategy.id} must be runnable`);
    assert.ok(strategy.label && strategy.describe, `${strategy.id} must describe itself`);
    assert.ok(strategy.requires.includes('clock'), 'every strategy stamps capturedAt from the injected clock');
  }
});

test('only the two network strategies are automatic', () => {
  const automatic = fetchStrategies().filter((s) => s.automatic).map((s) => s.id);
  assert.deepEqual(automatic, ['direct-fetch', 'cors-proxy']);
});

test('no third-party proxy is shipped anywhere in the strategy table', () => {
  const serialized = JSON.stringify(fetchStrategies().map((s) => ({ ...s, run: undefined })));
  assert.equal(/https?:\/\//.test(serialized), false, '§6.2: never ship a hardcoded third-party proxy');
});

test('strategyById resolves and nextStepsMessage names what is left', () => {
  assert.equal(strategyById('mhtml').label, 'MHTML archive');
  assert.equal(strategyById('nope'), null);
  const message = nextStepsMessage(['direct-fetch', 'cors-proxy']);
  assert.match(message, /Saved page/);
  assert.match(message, /Type it in/);
  assert.equal(nextStepsMessage(fetchStrategies().map((s) => s.id)), 'Enter the content by hand — that path is always open.');
});

// ---------------------------------------------------------------------------
// Proxy URL shapes
// ---------------------------------------------------------------------------

test('proxyUrl handles the three shapes a self-hosted proxy takes', () => {
  const target = 'https://a.example/x?y=1';
  assert.equal(proxyUrl('https://p.example/fetch?url={url}', target), `https://p.example/fetch?url=${encodeURIComponent(target)}`);
  assert.equal(proxyUrl('https://p.example/fetch?url=', target), `https://p.example/fetch?url=${encodeURIComponent(target)}`);
  assert.equal(proxyUrl('https://p.example/', target), `https://p.example/${target}`);
  assert.equal(proxyUrl('https://p.example', target), `https://p.example/${target}`);
  assert.equal(proxyUrl('https://p.example/raw/{rawurl}', target), `https://p.example/raw/${target}`);
  assert.equal(proxyUrl('', target), target);
});

// ---------------------------------------------------------------------------
// Strategy 1 — direct fetch
// ---------------------------------------------------------------------------

test('a direct fetch that works produces a parsed capture stamped from the clock', async () => {
  const http = makeHttp({ [URL_UNDER_TEST]: { body: SAMPLE_PAGE, headers: { 'content-type': 'text/html; charset=utf-8' } } });
  const result = await fetchDirect(URL_UNDER_TEST, { http, clock });
  assert.equal(result.ok, true);
  const capture = result.value;
  assert.equal(capture.strategy, 'direct-fetch');
  assert.equal(capture.kind, 'html');
  assert.equal(capture.sourceUrl, URL_UNDER_TEST);
  assert.equal(capture.capturedAt, '2026-03-04T09:15:00.000Z');
  assert.equal(capture.meta.title, 'Northwind — Approval chains');
  assert.equal(capture.meta.lang, 'en-GB');
  assert.equal(capture.meta['http.status'], '200');
  assert.ok(capture.doc, 'the capture carries a parsed tree');
  assert.equal(capture.html, SAMPLE_PAGE);
});

test('a CORS refusal is a quiet Result, never a throw, and never scary', async () => {
  const result = await fetchDirect(URL_UNDER_TEST, { http: corsBlockedHttp(), clock });
  assert.equal(result.ok, false);
  assert.match(result.error, /CORS/);
  assert.match(result.error, /Nothing is wrong on your side/);
  assert.equal(/error|failure|fatal/i.test(result.error), false);
});

test('a non-2xx answer is reported with its status', async () => {
  const http = makeHttp({ [URL_UNDER_TEST]: { status: 403, body: 'no' } });
  const result = await fetchDirect(URL_UNDER_TEST, { http, clock });
  assert.equal(result.ok, false);
  assert.match(result.error, /403/);
  assert.equal(result.detail.status, 403);
});

test('a missing transport is a Result, not a crash', async () => {
  const result = await fetchDirect(URL_UNDER_TEST, { clock });
  assert.equal(result.ok, false);
  assert.match(result.error, /No network transport/);
  assert.match(result.error, /Saved page/);
});

test('a malformed URL is refused with usable advice', async () => {
  const result = await fetchDirect('not a url', { http: makeHttp({}), clock });
  assert.equal(result.ok, false);
  assert.match(result.error, /https:\/\//);
});

// ---------------------------------------------------------------------------
// Strategy 2 — the user's proxy
// ---------------------------------------------------------------------------

test('the proxy strategy is inert until the user configures one', async () => {
  const result = await fetchViaProxy(URL_UNDER_TEST, { http: makeHttp({}), clock });
  assert.equal(result.ok, false);
  assert.match(result.error, /No CORS proxy is configured/);
});

test('a configured proxy is used, and the capture still records the real source URL', async () => {
  const proxied = `https://proxy.internal/get?url=${encodeURIComponent(URL_UNDER_TEST)}`;
  const http = makeHttp({ [proxied]: { body: SAMPLE_PAGE } });
  const result = await fetchViaProxy(URL_UNDER_TEST, { http, clock, proxyBase: 'https://proxy.internal/get?url=' });
  assert.equal(result.ok, true);
  assert.equal(result.value.sourceUrl, URL_UNDER_TEST, 'the proxy is transport, not provenance');
  assert.equal(result.value.strategy, 'cors-proxy');
  assert.equal(result.value.meta['http.proxied'], 'true');
});

// ---------------------------------------------------------------------------
// ingestUrl — the ordered degradation
// ---------------------------------------------------------------------------

test('ingestUrl tries direct first and stops there when it works', async () => {
  const http = makeHttp({ [URL_UNDER_TEST]: { body: SAMPLE_PAGE } });
  const result = await ingestUrl(URL_UNDER_TEST, { http, clock, proxyBase: 'https://proxy.internal/?' });
  assert.equal(result.ok, true);
  assert.equal(result.value.strategy, 'direct-fetch');
  assert.equal(http.calls[0], URL_UNDER_TEST, 'the document is fetched directly, first');
  assert.equal(
    http.calls.some((call) => call.startsWith('https://proxy.internal/')), false,
    'the proxy is not consulted when the direct route works',
  );
});

test('ingestUrl falls through to the proxy when direct fetch is blocked', async () => {
  const proxied = `https://proxy.internal/?${encodeURIComponent(URL_UNDER_TEST)}`;
  const http = makeHttp({
    [URL_UNDER_TEST]: { throws: 'Failed to fetch' },
    [proxied]: { body: SAMPLE_PAGE },
  });
  const result = await ingestUrl(URL_UNDER_TEST, { http, clock, proxyBase: 'https://proxy.internal/?' });
  assert.equal(result.ok, true);
  assert.equal(result.value.strategy, 'cors-proxy');
  assert.deepEqual(http.calls.slice(0, 2), [URL_UNDER_TEST, proxied], 'direct first, then the proxy');
  // Everything after the document is sub-resource collection, and it travels
  // the same road the document did.
  for (const call of http.calls.slice(2)) {
    assert.ok(call.startsWith('https://proxy.internal/'), `${call} should have gone via the proxy`);
  }
});

test('with everything blocked, ingestUrl returns a usable message naming the next steps', async () => {
  const result = await ingestUrl(URL_UNDER_TEST, { http: corsBlockedHttp(), clock });
  assert.equal(result.ok, false);
  assert.match(result.error, /Could not read/);
  assert.match(result.error, /Still available:/);
  assert.match(result.error, /Saved page/);
  assert.equal(result.detail.attempts.length, 1);
});

test('ingestUrl without a clock refuses rather than inventing a capture time', async () => {
  const result = await ingestUrl(URL_UNDER_TEST, { http: makeHttp({}) });
  assert.equal(result.ok, false);
  assert.match(result.error, /clock/);
});

test('a URL that answers with a PDF is imported as a document, not as mojibake', async () => {
  const pdf = new Uint8Array(readFileSync(join(FIXTURES, 'sample.pdf')));
  const url = 'https://northwind.example/one-pager.pdf';
  const http = makeHttp({ [url]: { body: pdf, headers: { 'content-type': 'application/pdf' } } });
  const result = await ingestUrl(url, { http, clock });
  assert.equal(result.ok, true);
  assert.equal(result.value.kind, 'document');
  assert.equal(result.value.strategy, 'direct-fetch');
  assert.equal(result.value.sourceUrl, url);
  assert.ok(result.value.blocks.length > 0);
});

// ---------------------------------------------------------------------------
// Strategy 5 — file dispatch
// ---------------------------------------------------------------------------

test('ingestFile dispatches on bytes, not on the filename', async () => {
  const png = tinyPng();
  const result = await ingestFile({ name: 'logo.pdf', bytes: png }, { clock });
  assert.equal(result.ok, true);
  assert.equal(result.value.kind, 'image');
  assert.equal(result.value.assets[0].mime, 'image/png');
});

test('ingestFile reads each supported format', async () => {
  const cases = [
    ['sample.docx', 'document'],
    ['sample.pptx', 'document'],
    ['sample.pdf', 'document'],
  ];
  for (const [name, kind] of cases) {
    const bytes = new Uint8Array(readFileSync(join(FIXTURES, name)));
    const result = await ingestFile({ name, bytes }, { clock });
    assert.equal(result.ok, true, `${name}: ${result.ok ? '' : result.error}`);
    assert.equal(result.value.kind, kind);
    assert.equal(result.value.capturedAt, '2026-03-04T09:15:00.000Z');
  }
  const html = await ingestFile({ name: 'page.html', bytes: bytesOf(SAMPLE_PAGE) }, { clock });
  assert.equal(html.ok, true);
  assert.equal(html.value.kind, 'html');
});

test('an unsupported file is refused with the list of what is supported', async () => {
  const result = await ingestFile({ name: 'archive.7z', bytes: new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) }, { clock });
  assert.equal(result.ok, false);
  assert.match(result.error, /Supported:/);
});

test('an empty file is refused rather than producing an empty specimen', async () => {
  const result = await ingestFile({ name: 'empty.png' }, { clock });
  assert.equal(result.ok, false);
  assert.match(result.error, /no content/);
});

test('ingestFiles reunites a saved page with its folder and imports the rest separately', async () => {
  const files = [
    { name: 'page.html', text: SAMPLE_PAGE },
    { name: 'page_files/chain.png', bytes: tinyPng(4, 4) },
    { name: 'page_files/site.css', text: 'body{color:#0B1220}' },
    { name: 'brochure.pdf', bytes: new Uint8Array(readFileSync(join(FIXTURES, 'sample.pdf'))) },
  ];
  const result = await ingestFiles(files, { clock });
  assert.equal(result.ok, true);
  assert.equal(result.value.length, 2);
  const [page, brochure] = result.value;
  assert.equal(page.strategy, 'saved-page');
  assert.ok(page.assets.some((a) => a.name === 'page_files/chain.png'));
  assert.equal(brochure.kind, 'document');
});

test('ingestFiles on an empty or unusable drop returns a Result, never a throw', async () => {
  assert.equal((await ingestFiles([], { clock })).ok, false);
  const junk = await ingestFiles([{ name: 'a.bin', bytes: new Uint8Array([1, 2, 3, 4]) }], { clock });
  assert.equal(junk.ok, false);
  assert.ok(Array.isArray(junk.detail.problems));
});
