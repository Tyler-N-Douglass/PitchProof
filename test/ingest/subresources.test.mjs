/**
 * Sub-resource collection (§6, §7, §8) — the fix for CRITIQUE-1 F1/F3.
 *
 * The finding was that `ingestUrl` fetched the document and nothing else, so
 * `RawCapture.assets` came back empty for every URL capture: the brand engine
 * was handed no stylesheet, and every media block raised a blocking
 * `ASSET_MISSING` whose only offered remedy deleted the prospect's own hero
 * image from the proof. §1.2's first promise is "paste a prospect URL, get an
 * extracted brand system and a specimen library".
 *
 * This file drives `test/fixtures/corpus/` end to end and holds the three
 * properties the collection has to have — bounded, reported, deterministic —
 * plus §6's law that a sub-resource failure never loses the document.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ingestUrl, fetchViaProxy } from '../../src/ingest/fetch.js';
import {
  collectSubresources, subresourceCandidates, cssReferences, pickFromSrcset,
  candidateAllowed, sameSite, SUBRESOURCE_LIMITS, SRCSET_TARGET_WIDTH,
} from '../../src/ingest/subresources.js';
import { parseRobots, robotsAllows, ruleMatches, groupFor, emptyRobots } from '../../src/ingest/robots.js';
import { parseHtml } from '../../src/ingest/html-parse.js';
import {
  CORPUS_ORIGIN, CORPUS_PAGES, corpusHttp, corpusClock, assetBytes, pageHtml,
} from '../fixtures/corpus/index.mjs';
import { tinyPng } from './helpers.mjs';

const clock = corpusClock();
const HOME = CORPUS_PAGES[0].url;

/**
 * The corpus transport, with the requests it saw recorded and optional
 * per-path overrides — which is how the failure, cap and timeout cases are
 * driven without a second fixture.
 *
 * @param {Record<string, any>} [overrides]  path → response, or null to 404
 */
function recordingHttp(overrides = {}) {
  const base = corpusHttp();
  /** @type {string[]} */
  const calls = [];
  const http = async (url, init) => {
    const path = String(url).startsWith(CORPUS_ORIGIN) ? String(url).slice(CORPUS_ORIGIN.length) : String(url);
    calls.push(path);
    if (Object.prototype.hasOwnProperty.call(overrides, path)) {
      const override = overrides[path];
      if (override === null) return { ok: false, status: 404, async text() { return ''; }, async bytes() { return new Uint8Array(0); } };
      if (typeof override === 'function') return override(url, init);
      return override;
    }
    return base(url, init);
  };
  http.calls = calls;
  return http;
}

/** @param {any} bytes @returns {string} */
function text(bytes) { return new TextDecoder().decode(bytes); }

/** @param {any} result */
function value(result) {
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  return result.value;
}

/** @param {any} capture @param {string} name */
function assetNamed(capture, name) {
  return capture.assets.find((a) => a.name === name || (a.aliases || []).includes(name)) || null;
}

// ---------------------------------------------------------------------------
// The corpus, end to end — the critique's own scenario
// ---------------------------------------------------------------------------

test('the corpus home page comes back with its stylesheet, logo, mark and hero', async () => {
  const http = recordingHttp();
  const capture = value(await ingestUrl(HOME, { http, clock }));

  const names = capture.assets.map((a) => a.name);
  assert.deepEqual(names, [
    '/assets/site.css',
    '/assets/mark.svg',
    '/assets/hero-plant.png',
    '/assets/logo.svg',
  ], 'stylesheet first, then the head-declared icon and og:image, then body images');

  assert.deepEqual(capture.assets.map((a) => a.role), ['stylesheet', 'icon', 'og-image', 'image']);
  assert.deepEqual(capture.assets.map((a) => a.mime), ['text/css', 'image/svg+xml', 'image/png', 'image/svg+xml']);

  for (const asset of capture.assets) {
    const expected = assetBytes(asset.name);
    assert.deepEqual([...asset.bytes], [...expected], `${asset.name} came back byte for byte`);
  }
});

test('the transport saw exactly the requests it should have, and no others', async () => {
  const http = recordingHttp();
  await ingestUrl(HOME, { http, clock });
  assert.deepEqual(http.calls, [
    '/',
    '/robots.txt',
    '/assets/site.css',
    '/assets/mark.svg',
    '/assets/hero-plant.png',
    '/assets/logo.svg',
    '/assets/fonts/sohne-buch.woff2',
    '/assets/fonts/sohne-kraftig.woff2',
    '/assets/fonts/sohne-mono.woff2',
  ], 'document, robots, the four referenced assets, then the three @font-face files the stylesheet named');
});

test('the stylesheet handed over is the real one, which is what the brand engine was missing', async () => {
  const capture = value(await ingestUrl(HOME, { http: recordingHttp(), clock }));
  const css = capture.assets.filter((a) => a.mime === 'text/css');
  assert.equal(css.length, 1);
  const source = text(css[0].bytes);
  assert.equal(source, text(assetBytes('/assets/site.css')));
  // The three things §7 reads out of a stylesheet.
  assert.match(source, /#0F2A47/i, 'the navy the palette solver clusters on');
  assert.match(source, /#E8622C/i, 'the awkward accent that forces a derived onAccent');
  assert.match(source, /@font-face/, 'the face declarations detectFaces needs');
  assert.match(source, /font-family/, 'and the family usage');
  assert.equal(capture.meta['subresources.stylesheets'], '1');
});

test('the logo and the mark arrive as SVG markup a logo extractor can read', async () => {
  const capture = value(await ingestUrl(HOME, { http: recordingHttp(), clock }));
  const logo = assetNamed(capture, '/assets/logo.svg');
  const mark = assetNamed(capture, '/assets/mark.svg');
  assert.ok(logo && mark);
  assert.match(text(logo.bytes), /<svg/);
  assert.match(text(mark.bytes), /<svg/);
  assert.equal(logo.alt, 'Northwind Industrial', 'the alt travels with the asset');
  assert.equal(mark.role, 'icon');
});

test('every media block a URL capture produces has bytes behind it', async () => {
  for (const page of CORPUS_PAGES) {
    const capture = value(await ingestUrl(page.url, { http: recordingHttp(), clock }));
    // Every `<img src>` in the document resolves to an asset by name or alias.
    const srcs = [...capture.html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]);
    for (const src of srcs) {
      assert.ok(assetNamed(capture, src), `${page.id}: nothing behind <img src="${src}">`);
    }
  }
});

test('across the whole corpus, all six assets are collected', async () => {
  /** @type {Set<string>} */
  const collected = new Set();
  for (const page of CORPUS_PAGES) {
    const capture = value(await ingestUrl(page.url, { http: recordingHttp(), clock }));
    for (const asset of capture.assets) collected.add(asset.name);
  }
  assert.deepEqual([...collected].sort(), [
    '/assets/hero-plant.png',
    '/assets/logo.svg',
    '/assets/mark.svg',
    '/assets/product-hx400.png',
    '/assets/site.css',
    '/assets/uptime-figure.png',
  ]);
});

test('the German locale page collects its own assets too', async () => {
  const de = CORPUS_PAGES.find((p) => p.id === 'article-de');
  const capture = value(await ingestUrl(de.url, { http: recordingHttp(), clock }));
  assert.deepEqual(capture.assets.map((a) => a.name), ['/assets/site.css', '/assets/mark.svg', '/assets/logo.svg']);
  assert.equal(capture.meta.lang, 'de-DE');
});

// ---------------------------------------------------------------------------
// Reported
// ---------------------------------------------------------------------------

test('a sub-resource that 404s is recorded, and the capture still succeeds', async () => {
  const http = recordingHttp({ '/assets/logo.svg': null });
  const result = await ingestUrl(HOME, { http, clock });
  assert.equal(result.ok, true, '§6: a failed sub-resource never loses the document');
  const capture = result.value;

  assert.equal(assetNamed(capture, '/assets/logo.svg'), null);
  assert.ok(assetNamed(capture, '/assets/site.css'), 'the others still arrived');

  const skipped = capture.subresources.skipped.filter((s) => s.ref === '/assets/logo.svg');
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, 'not-found');
  assert.equal(skipped[0].status, 404);
  assert.match(capture.meta['subresources.skippedReasons'], /not-found×4/);
  assert.match(capture.meta['subresources.skippedDetail'], /not-found: \/assets\/logo\.svg/);
});

test('the three missing webfonts are reported rather than silently absent', async () => {
  const capture = value(await ingestUrl(HOME, { http: recordingHttp(), clock }));
  const fonts = capture.subresources.skipped.filter((s) => s.role === 'font');
  assert.equal(fonts.length, 3);
  for (const font of fonts) assert.equal(font.reason, 'not-found');
  assert.equal(capture.meta['subresources.requested'], '7');
  assert.equal(capture.meta['subresources.fetched'], '4');
  assert.equal(capture.meta['subresources.skipped'], '3');
  assert.equal(capture.meta['subresources.bytes'], String(capture.assets.reduce((n, a) => n + a.bytes.length, 0)));
});

test('a transport that throws on every sub-resource still yields the document', async () => {
  const base = corpusHttp();
  const http = async (url, init) => {
    if (String(url) === HOME) return base(url, init);
    throw new TypeError('Failed to fetch');
  };
  const capture = value(await ingestUrl(HOME, { http, clock }));
  assert.ok(capture.html.length > 1000);
  assert.equal(capture.assets.length, 0);
  assert.equal(capture.meta['subresources.fetched'], '0');
  assert.match(capture.meta['subresources.skippedReasons'], /unreachable/);
});

test('a 200 that is really an HTML error page is not kept as an image', async () => {
  const errorPage = '<!doctype html><html><body><h1>404</h1></body></html>';
  const http = recordingHttp({
    '/assets/logo.svg': {
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'text/html']]),
      async text() { return errorPage; },
      async bytes() { return new TextEncoder().encode(errorPage); },
    },
  });
  const capture = value(await ingestUrl(HOME, { http, clock }));
  assert.equal(assetNamed(capture, '/assets/logo.svg'), null);
  assert.ok(capture.subresources.skipped.some((s) => s.ref === '/assets/logo.svg' && s.reason === 'wrong-type'));
});

// ---------------------------------------------------------------------------
// Bounded
// ---------------------------------------------------------------------------

test('the count cap stops collection and says so', async () => {
  const http = recordingHttp();
  const capture = value(await ingestUrl(HOME, { http, clock, subresources: { maxCount: 2 } }));
  assert.equal(capture.assets.length, 2);
  assert.deepEqual(capture.assets.map((a) => a.name), ['/assets/site.css', '/assets/mark.svg']);
  assert.equal(capture.meta['subresources.capped'], 'count');
  assert.ok(capture.subresources.skipped.some((s) => s.reason === 'count-cap'));
  assert.match(capture.meta['subresources.skippedReasons'], /count-cap/);
});

test('the total byte cap stops collection and says so', async () => {
  const capture = value(await ingestUrl(HOME, { http: recordingHttp(), clock, subresources: { maxTotalBytes: 3500 } }));
  assert.equal(capture.meta['subresources.capped'], 'bytes');
  assert.ok(Number(capture.meta['subresources.bytes']) <= 3500);
  const overBudget = capture.subresources.skipped.filter((s) => s.reason === 'byte-cap');
  assert.ok(overBudget.length >= 1);
  assert.equal(typeof overBudget[0].bytes, 'number', 'the report says how big the thing it refused was');
});

test('a single oversized resource is skipped without stopping the rest', async () => {
  const capture = value(await ingestUrl(HOME, { http: recordingHttp(), clock, subresources: { maxBytesPerResource: 1000 } }));
  const oversize = capture.subresources.skipped.filter((s) => s.reason === 'oversize');
  assert.deepEqual(oversize.map((s) => s.ref), ['/assets/site.css', '/assets/hero-plant.png'],
    'the two resources over 1000 bytes, and only those');
  assert.equal(typeof oversize[0].bytes, 'number', 'the report says how big it was');
  assert.deepEqual(capture.assets.map((a) => a.name), ['/assets/mark.svg', '/assets/logo.svg'],
    'collection carried on past the ones it refused');
});

test('a resource that does not answer in time is a timeout, not a hang', async () => {
  const http = recordingHttp({
    '/assets/hero-plant.png': () => new Promise(() => { /* never settles */ }),
  });
  const capture = value(await ingestUrl(HOME, { http, clock, subresources: { timeoutMs: 25 } }));
  assert.ok(capture.subresources.skipped.some((s) => s.ref === '/assets/hero-plant.png' && s.reason === 'timeout'));
  assert.ok(assetNamed(capture, '/assets/site.css'));
});

test('@import recursion is bounded and the limit is reported', async () => {
  const deep = (n) => `@import url("/assets/deep-${n}.css");\n.l${n}{color:#111}`;
  const overrides = { '/assets/site.css': cssResponse(deep(1)) };
  for (let i = 1; i <= 6; i++) overrides[`/assets/deep-${i}.css`] = cssResponse(deep(i + 1));
  const capture = value(await ingestUrl(HOME, { http: recordingHttp(overrides), clock, subresources: { maxCssDepth: 2 } }));
  const sheets = capture.assets.filter((a) => a.mime === 'text/css').map((a) => a.name);
  assert.deepEqual(sheets, ['/assets/site.css', '/assets/deep-1.css', '/assets/deep-2.css']);
  assert.match(capture.meta['subresources.notes'], /@import depth limit \(2\) reached/);
});

/** @param {string} css */
function cssResponse(css) {
  return {
    ok: true,
    status: 200,
    headers: new Map([['content-type', 'text/css']]),
    async text() { return css; },
    async bytes() { return new TextEncoder().encode(css); },
  };
}

// ---------------------------------------------------------------------------
// Origin policy and robots
// ---------------------------------------------------------------------------

test('robots.txt gates sub-resources but never the document the user asked for', async () => {
  const robots = `User-agent: *\nDisallow: /assets/logo.svg\nDisallow: /quote/\n`;
  const http = recordingHttp({
    '/robots.txt': {
      ok: true, status: 200,
      async text() { return robots; },
      async bytes() { return new TextEncoder().encode(robots); },
    },
  });
  const capture = value(await ingestUrl(HOME, { http, clock }));
  assert.equal(assetNamed(capture, '/assets/logo.svg'), null);
  assert.ok(capture.subresources.skipped.some((s) => s.ref === '/assets/logo.svg' && s.reason === 'robots'));
  assert.ok(capture.html.length > 1000, 'the document itself is never gated on robots.txt');
  assert.ok(assetNamed(capture, '/assets/site.css'));
});

test('a caller that already has robots.txt is not made to fetch it twice', async () => {
  const http = recordingHttp();
  await ingestUrl(HOME, { http, clock, robotsText: 'User-agent: *\nDisallow:\n' });
  assert.equal(http.calls.includes('/robots.txt'), false);
});

test('robots can be turned off, and an unreadable robots.txt allows everything', async () => {
  const http = recordingHttp({ '/robots.txt': null });
  const capture = value(await ingestUrl(HOME, { http, clock }));
  assert.equal(capture.assets.length, 4);

  const off = recordingHttp();
  await ingestUrl(HOME, { http: off, clock, subresources: { respectRobots: false } });
  assert.equal(off.calls.includes('/robots.txt'), false);
});

test('collection stays same-site, except for what the page declares about itself', () => {
  const limits = { ...SUBRESOURCE_LIMITS, allowHosts: [] };
  const context = { host: 'www.northwind-industrial.example', robots: emptyRobots(), limits };
  const at = (url, role) => candidateAllowed({ url, ref: url, role, order: 0, alt: null, note: null }, context);

  assert.equal(at('https://www.northwind-industrial.example/a.png', 'image').allowed, true);
  assert.equal(at('https://northwind-industrial.example/a.png', 'image').allowed, true, 'the bare apex is the same site');
  assert.equal(at('https://cdn.northwind-industrial.example/a.png', 'image').allowed, true, 'a subdomain is the prospect');
  assert.equal(at('https://adtracker.example/pixel.gif', 'image').allowed, false);
  assert.equal(at('https://adtracker.example/pixel.gif', 'image').reason, 'cross-origin');
  assert.equal(at('https://cdn.other.example/og.png', 'og-image').allowed, true, 'og:image is the page being explicit');
  assert.equal(at('https://cdn.other.example/icon.svg', 'icon').allowed, true);
  assert.equal(at('https://cdn.other.example/site.css', 'stylesheet').allowed, false);

  const widened = { ...context, limits: { ...limits, allowHosts: ['cdn.other.example'] } };
  assert.equal(candidateAllowed({ url: 'https://cdn.other.example/site.css', ref: '', role: 'stylesheet', order: 0, alt: null, note: null }, widened).allowed, true);
});

test('sameSite is neither too strict nor too loose', () => {
  assert.equal(sameSite('www.a.example', 'a.example'), true);
  assert.equal(sameSite('cdn.a.example', 'www.a.example'), true);
  assert.equal(sameSite('a.example', 'a.example'), true);
  assert.equal(sameSite('a.example', 'b.example'), false);
  assert.equal(sameSite('evil-a.example', 'a.example'), false);
  assert.equal(sameSite('', 'a.example'), false);
});

test('the robots parser handles groups, wildcards, anchors and longest-match', () => {
  const robots = parseRobots([
    '# comment',
    'User-agent: *',
    'Disallow: /private/',
    'Allow: /private/public/',
    'Disallow: /*.pdf$',
    '',
    'User-agent: SpecificBot',
    'Disallow: /',
    '',
    'Sitemap: https://a.example/sitemap.xml',
  ].join('\n'));

  assert.deepEqual(robots.sitemaps, ['https://a.example/sitemap.xml']);
  assert.equal(robots.groups.length, 2);
  assert.equal(robotsAllows(robots, '/public/x'), true);
  assert.equal(robotsAllows(robots, '/private/x'), false);
  assert.equal(robotsAllows(robots, '/private/public/x'), true, 'the longer Allow wins');
  assert.equal(robotsAllows(robots, '/docs/a.pdf'), false);
  assert.equal(robotsAllows(robots, '/docs/a.pdf.html'), true, '$ anchors the match');
  assert.equal(robotsAllows(robots, 'https://a.example/private/x'), false, 'an absolute URL works too');
  assert.equal(robotsAllows(robots, '/anything', 'SpecificBot'), false);
  assert.equal(groupFor(robots, 'SpecificBot').agents[0], 'specificbot');

  assert.equal(robotsAllows(parseRobots(''), '/anything'), true, 'no robots.txt allows everything');
  assert.equal(robotsAllows(parseRobots('User-agent: *\nDisallow:'), '/anything'), true, 'an empty Disallow allows everything');
  assert.equal(robotsAllows(null, '/anything'), true);
  assert.equal(ruleMatches('/a/*/c', '/a/b/c'), true);
  assert.equal(ruleMatches('/a/*/c', '/a/b/d'), false);
});

// ---------------------------------------------------------------------------
// Deterministic
// ---------------------------------------------------------------------------

test('two runs of the same page produce byte-identical assets in the same order', async () => {
  const once = value(await ingestUrl(HOME, { http: recordingHttp(), clock }));
  const twice = value(await ingestUrl(HOME, { http: recordingHttp(), clock }));
  assert.deepEqual(once.assets.map((a) => a.name), twice.assets.map((a) => a.name));
  assert.deepEqual(once.assets.map((a) => a.role), twice.assets.map((a) => a.role));
  for (let i = 0; i < once.assets.length; i++) {
    assert.deepEqual([...once.assets[i].bytes], [...twice.assets[i].bytes]);
  }
  assert.deepEqual(once.subresources.skipped, twice.subresources.skipped);
});

test('the order does not depend on which response arrives first', async () => {
  // A transport that answers in reverse order of request, with jitter.
  const base = corpusHttp();
  const delays = new Map([
    ['/assets/site.css', 40],
    ['/assets/mark.svg', 30],
    ['/assets/hero-plant.png', 5],
    ['/assets/logo.svg', 1],
  ]);
  const slow = async (url, init) => {
    const path = String(url).replace(CORPUS_ORIGIN, '');
    const delay = delays.get(path) || 0;
    if (delay) await new Promise((r) => setTimeout(r, delay));
    return base(url, init);
  };
  const jittered = value(await ingestUrl(HOME, { http: slow, clock }));
  const plain = value(await ingestUrl(HOME, { http: recordingHttp(), clock }));
  assert.deepEqual(jittered.assets.map((a) => a.name), plain.assets.map((a) => a.name));
});

test('concurrency changes the speed, never the answer', async () => {
  const serial = value(await ingestUrl(HOME, { http: recordingHttp(), clock, subresources: { concurrency: 1 } }));
  const parallel = value(await ingestUrl(HOME, { http: recordingHttp(), clock, subresources: { concurrency: 8 } }));
  assert.deepEqual(serial.assets.map((a) => a.name), parallel.assets.map((a) => a.name));
  assert.deepEqual(
    serial.subresources.skipped.map((s) => s.ref),
    parallel.subresources.skipped.map((s) => s.ref),
  );
});

// ---------------------------------------------------------------------------
// Candidate discovery
// ---------------------------------------------------------------------------

test('candidates are discovered from every reference kind, in role order', () => {
  const doc = parseHtml(`
    <html><head>
      <link rel="stylesheet" href="/a.css">
      <link rel="icon" href="/favicon.svg">
      <link rel="preload" as="font" href="/f.woff2">
      <meta property="og:image" content="https://cdn.example/og.png">
      <meta name="twitter:image" content="/tw.png">
    </head><body>
      <img src="/hero.png" alt="Hero">
      <picture><source srcset="/w.webp 800w"><img src="/fallback.jpg"></picture>
      <video poster="/poster.jpg"></video>
      <svg><use href="/sprite.svg#icon"></use></svg>
      <a href="/not-an-asset">link</a>
      <img src="data:image/png;base64,AAA">
      <img src="#local">
    </body></html>`);
  const candidates = subresourceCandidates(doc, 'https://a.example/page');
  assert.deepEqual(candidates.map((c) => `${c.role}:${c.ref}`), [
    'stylesheet:/a.css',
    'icon:/favicon.svg',
    'og-image:https://cdn.example/og.png',
    'og-image:/tw.png',
    'image:/hero.png',
    'image:/w.webp',
    'image:/poster.jpg',
    'use:/sprite.svg',
    'font:/f.woff2',
  ]);
  assert.equal(candidates.find((c) => c.ref === '/hero.png').alt, 'Hero');
  assert.equal(candidates.some((c) => c.ref === '/not-an-asset'), false, 'an anchor is not a sub-resource');
  assert.equal(candidates.some((c) => c.ref === '/fallback.jpg'), false,
    'a <picture> contributes one candidate, the way a browser resolves it');
  assert.equal(candidates.some((c) => c.ref.startsWith('data:')), false);
});

test('a <base href> changes what relative references resolve against', () => {
  const doc = parseHtml('<html><head><base href="https://cdn.example/v2/"><link rel=stylesheet href="site.css"></head><body></body></html>');
  const [candidate] = subresourceCandidates(doc, 'https://a.example/page');
  assert.equal(candidate.url, 'https://cdn.example/v2/site.css');
});

test('duplicate references collapse, keeping the document-relative name', () => {
  const doc = parseHtml(`
    <html><head><meta property="og:image" content="https://a.example/hero.png"></head>
    <body><img src="/hero.png" alt="Hero"><img src="/hero.png"></body></html>`);
  const candidates = subresourceCandidates(doc, 'https://a.example/page');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].ref, '/hero.png', 'the relative reference names the asset');
  assert.equal(candidates[0].alt, 'Hero', 'the alt is not lost to the duplicate');
  assert.ok(candidates[0].refs.includes('https://a.example/hero.png'));
});

test('srcset picks one candidate deterministically and says which', () => {
  const wide = pickFromSrcset('/a-400.png 400w, /a-800.png 800w, /a-1600.png 1600w, /a-3200.png 3200w');
  assert.equal(wide.url, '/a-1600.png');
  assert.match(wide.note, new RegExp(`narrowest covering ${SRCSET_TARGET_WIDTH}px`));
  assert.match(wide.note, /of 4 srcset candidates/);

  const noneCovering = pickFromSrcset('/a-320.png 320w, /a-640.png 640w');
  assert.equal(noneCovering.url, '/a-640.png', 'fall back to the widest available');

  const density = pickFromSrcset('/a.png 1x, /a@2x.png 2x');
  assert.equal(density.url, '/a@2x.png');
  assert.match(density.note, /highest density/);

  const bare = pickFromSrcset('/a.png, /b.png');
  assert.equal(bare.url, '/a.png');
  assert.match(bare.note, /first of 2/);

  assert.equal(pickFromSrcset('   '), null);
  assert.equal(pickFromSrcset('/only.png').note, 'the only srcset candidate');
});

test('CSS references are extracted, with fonts distinguished from other url()s', () => {
  const css = `
    @import url("base.css");
    @import 'tokens.css' screen;
    /* @import "commented-out.css"; */
    @font-face { font-family: Sohne; src: url("/fonts/sohne.woff2") format("woff2"); }
    .hero { background-image: url(/img/hero.png); }
    .icon { background: url('data:image/svg+xml,<svg/>'); }
    .b { background: url(#gradient); }`;
  const refs = cssReferences(css, 'https://a.example/css/site.css');
  assert.deepEqual(refs.imports.map((i) => i.url), [
    'https://a.example/css/base.css',
    'https://a.example/css/tokens.css',
  ]);
  assert.deepEqual(refs.urls.map((u) => `${u.font ? 'font' : 'url'}:${u.url}`), [
    'font:https://a.example/fonts/sohne.woff2',
    'url:https://a.example/img/hero.png',
  ]);
});

test('CSS url() references are collected from the stylesheet that was fetched', async () => {
  const css = '.hero{background-image:url("/assets/hero-plant.png")}';
  const http = recordingHttp({ '/assets/site.css': cssResponse(css) });
  const capture = value(await ingestUrl(HOME, { http, clock }));
  const hero = assetNamed(capture, '/assets/hero-plant.png');
  assert.ok(hero, 'a background image behind a CSS rule is still a brand asset');
  assert.deepEqual([...hero.bytes], [...assetBytes('/assets/hero-plant.png')]);
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

test('sub-resources travel the same road as the document', async () => {
  const base = corpusHttp();
  /** @type {string[]} */
  const calls = [];
  const proxyBase = 'https://proxy.internal/get?url=';
  const http = async (url, init) => {
    calls.push(String(url));
    const inner = String(url).startsWith(proxyBase)
      ? decodeURIComponent(String(url).slice(proxyBase.length))
      : null;
    if (inner === null) return { ok: false, status: 403, async text() { return ''; } };
    return base(inner, init);
  };
  const capture = value(await fetchViaProxy(HOME, { http, clock, proxyBase }));
  assert.equal(capture.assets.length, 4, 'the assets came through the proxy too');
  assert.equal(capture.sourceUrl, HOME, 'the proxy is transport, not provenance');
  for (const call of calls) {
    assert.ok(call.startsWith(proxyBase), `every request went via the proxy: ${call}`);
  }
});

test('collection can be turned off, and says that it was', async () => {
  const http = recordingHttp();
  const capture = value(await ingestUrl(HOME, { http, clock, subresources: false }));
  assert.deepEqual(capture.assets, []);
  assert.equal(capture.meta['subresources.skippedReasons'], 'disabled by the caller');
  assert.deepEqual(http.calls, ['/'], 'nothing beyond the document was requested');
});

test('a non-HTML capture is unaffected by sub-resource collection', async () => {
  const png = tinyPng(4, 4);
  const url = `${CORPUS_ORIGIN}/assets/loose.png`;
  const http = async () => ({
    ok: true, status: 200,
    headers: new Map([['content-type', 'image/png']]),
    async bytes() { return png; },
    async text() { return ''; },
  });
  const capture = value(await ingestUrl(url, { http, clock }));
  assert.equal(capture.kind, 'image');
  assert.equal(capture.assets.length, 1);
  assert.equal(capture.meta['subresources.fetched'], undefined);
});

test('the asset shape is the one L5 and L6 key on', async () => {
  const capture = value(await ingestUrl(HOME, { http: recordingHttp(), clock }));
  for (const asset of capture.assets) {
    assert.equal(typeof asset.name, 'string');
    assert.ok(asset.bytes instanceof Uint8Array);
    assert.equal(typeof asset.mime, 'string');
    assert.ok(Array.isArray(asset.aliases));
    assert.equal(typeof asset.url, 'string');
    assert.equal(asset.src, asset.name, 'L6 captureMedia records `src` as a source');
    assert.ok(typeof asset.role === 'string');
    assert.equal(asset.aliases.includes(asset.name), false, 'the name is not repeated in the aliases');
    assert.ok(asset.aliases.includes(asset.url), 'the absolute URL is always an alias');
    assert.ok(asset.aliases.some((a) => !a.includes('/')), 'the bare filename is always an alias');
  }
});

test('collectSubresources is inert without a document or a transport', async () => {
  const nothing = await collectSubresources({ doc: null, baseUrl: HOME, fetchUrl: recordingHttp() });
  assert.deepEqual(nothing.assets, []);
  assert.equal(nothing.report.fetched, 0);
  const noTransport = await collectSubresources({ doc: parseHtml(pageHtml('home')), baseUrl: HOME, fetchUrl: null });
  assert.deepEqual(noTransport.assets, []);
});
