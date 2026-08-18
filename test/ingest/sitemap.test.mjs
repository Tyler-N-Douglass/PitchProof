/**
 * Sitemap assist (§6).
 *
 * The requirement under test is precise and easy to get wrong: rank by
 * **structural richness, not by position**, and surface a home page, a
 * product/PDP, an article and a locale variant. A ranker that just reproduced
 * sitemap order would pass a naive test, so the fixture below is deliberately
 * ordered *against* the answer — the four pages that should lead are scattered
 * through the file, with pagination, tag pages and PDFs in front of them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  discoverSitemap, rankCandidates, parseSitemap, makeEntry, classify, scoreEntry,
  topSuggestions, gunzip, KIND_PRIORITY,
} from '../../src/ingest/sitemap.js';
import { makeHttp } from './helpers.mjs';

const ORIGIN = 'https://northwind.example';

const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
  <url><loc>${ORIGIN}/tag/compliance</loc><priority>0.9</priority></url>
  <url><loc>${ORIGIN}/blog/page/4</loc><changefreq>daily</changefreq></url>
  <url><loc>${ORIGIN}/assets/one-pager.pdf</loc><priority>1.0</priority></url>
  <url><loc>${ORIGIN}/search?q=audit</loc></url>
  <url>
    <loc>${ORIGIN}/products/audit-trail-for-regulated-teams</loc>
    <lastmod>2026-02-20</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.6</priority>
  </url>
  <url><loc>${ORIGIN}/solutions</loc><priority>0.8</priority></url>
  <url>
    <loc>${ORIGIN}/</loc>
    <lastmod>2026-02-18</lastmod>
    <priority>1.0</priority>
    <xhtml:link rel="alternate" hreflang="de-de" href="${ORIGIN}/de-de/"/>
    <xhtml:link rel="alternate" hreflang="fr-fr" href="${ORIGIN}/fr-fr/"/>
  </url>
  <url><loc>${ORIGIN}/legal/terms</loc></url>
  <url>
    <loc>${ORIGIN}/blog/2026/02/why-a-proof-beats-a-demo</loc>
    <lastmod>2026-02-25T09:00:00Z</lastmod>
    <changefreq>monthly</changefreq>
  </url>
  <url>
    <loc>${ORIGIN}/de-de/produkte/pruefpfad-fuer-regulierte-teams</loc>
    <lastmod>2026-02-19</lastmod>
    <xhtml:link rel="alternate" hreflang="en-gb" href="${ORIGIN}/products/audit-trail-for-regulated-teams"/>
  </url>
  <url><loc>${ORIGIN}/about</loc></url>
</urlset>`;

const INDEX = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${ORIGIN}/sitemap-pages.xml</loc><lastmod>2026-02-25</lastmod></sitemap>
  <sitemap><loc>${ORIGIN}/sitemap-posts.xml</loc></sitemap>
</sitemapindex>`;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test('a urlset is parsed with its lastmod, changefreq, priority and alternates', () => {
  const parsed = parseSitemap(SITEMAP, `${ORIGIN}/sitemap.xml`);
  assert.equal(parsed.kind, 'urlset');
  assert.equal(parsed.entries.length, 11);
  const home = parsed.entries.find((e) => e.url === `${ORIGIN}/`);
  assert.equal(home.lastmod, '2026-02-18');
  assert.equal(home.priority, 1);
  assert.deepEqual(home.alternates.map((a) => a.hreflang), ['de-de', 'fr-fr']);
  const post = parsed.entries.find((e) => e.url.includes('why-a-proof'));
  assert.equal(post.changefreq, 'monthly');
  assert.equal(post.lastmod, '2026-02-25T09:00:00Z');
});

test('a sitemap index is recognised and yields its children, not entries', () => {
  const parsed = parseSitemap(INDEX, `${ORIGIN}/sitemap.xml`);
  assert.equal(parsed.kind, 'index');
  assert.deepEqual(parsed.sitemaps, [`${ORIGIN}/sitemap-pages.xml`, `${ORIGIN}/sitemap-posts.xml`]);
  assert.equal(parsed.entries.length, 0);
});

test('parsing tolerates CDATA, namespace prefixes and junk', () => {
  const xml = `<urlset><url><loc><![CDATA[${ORIGIN}/x]]></loc></url><url><ns:loc>${ORIGIN}/y</ns:loc></url><url></url></urlset>`;
  const parsed = parseSitemap(xml, '');
  assert.deepEqual(parsed.entries.map((e) => e.url), [`${ORIGIN}/x`, `${ORIGIN}/y`]);
});

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

test('URLs are classified by what kind of specimen they would make', () => {
  const cases = [
    [`${ORIGIN}/`, 'home'],
    [`${ORIGIN}/index.html`, 'home'],
    [`${ORIGIN}/products/audit-trail`, 'product'],
    [`${ORIGIN}/shop/widgets/big-widget`, 'product'],
    [`${ORIGIN}/blog/2026/02/a-post`, 'article'],
    [`${ORIGIN}/news/quarterly-update`, 'article'],
    [`${ORIGIN}/2025/12/an-untagged-post`, 'article'],
    [`${ORIGIN}/de-de/`, 'locale'],
    [`${ORIGIN}/fr-fr/tarifs`, 'locale'],
    [`${ORIGIN}/de-de/produkte/x`, 'locale'],
    [`${ORIGIN}/solutions`, 'category'],
    [`${ORIGIN}/industries/insurance`, 'category'],
    [`${ORIGIN}/a-page-with-a-wordy-slug`, 'article'],
    [`${ORIGIN}/about`, 'category'],
  ];
  for (const [url, kind] of cases) {
    assert.equal(classify(url), kind, `${url} should classify as ${kind}`);
  }
});

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

test('ranking favours a home page, a product, an article and a locale variant', () => {
  const ranked = rankCandidates(parseSitemap(SITEMAP, '').entries);
  const head = ranked.slice(0, 4);
  assert.deepEqual(head.map((e) => e.kind), ['home', 'product', 'article', 'locale'],
    '§6 names exactly these four; the head of the list must cover them');
  assert.deepEqual(head.map((e) => e.url), [
    `${ORIGIN}/`,
    `${ORIGIN}/products/audit-trail-for-regulated-teams`,
    `${ORIGIN}/blog/2026/02/why-a-proof-beats-a-demo`,
    `${ORIGIN}/de-de/produkte/pruefpfad-fuer-regulierte-teams`,
  ]);
});

test('ranking is by richness, not by position in the file', () => {
  const entries = parseSitemap(SITEMAP, '').entries;
  const ranked = rankCandidates(entries);
  assert.notEqual(ranked[0].url, entries[0].url, 'the first entry in the file does not win by default');

  const positions = ranked.map((e) => entries.findIndex((x) => x.url === e.url));
  assert.notDeepEqual(positions, [...positions].sort((a, b) => a - b), 'the ranking reorders the file');

  // The pages that make bad specimens sink.
  const rankOf = (fragment) => ranked.findIndex((e) => e.url.includes(fragment));
  assert.ok(rankOf('/tag/') > 5, 'a tag page is not a specimen');
  assert.ok(rankOf('/blog/page/4') > 5, 'pagination is not a specimen');
  assert.ok(rankOf('one-pager.pdf') > 5, 'a PDF link declared priority 1.0 still sinks');
  assert.ok(rankOf('/search?') > 5, 'a search URL sinks');
});

test('a wordier slug outranks a bare one within the same kind', () => {
  const entries = [
    makeEntry({ url: `${ORIGIN}/blog/x` }),
    makeEntry({ url: `${ORIGIN}/blog/how-we-cut-review-cycle-time-in-half` }),
  ];
  const ranked = rankCandidates(entries);
  assert.equal(ranked[0].url, `${ORIGIN}/blog/how-we-cut-review-cycle-time-in-half`);
});

test('freshness is relative to the other entries, so no clock is read', () => {
  const older = makeEntry({ url: `${ORIGIN}/blog/older-post-about-audits`, lastmod: '2020-01-01' });
  const newer = makeEntry({ url: `${ORIGIN}/blog/newer-post-about-audits`, lastmod: '2026-02-25' });
  const ranked = rankCandidates([older, newer]);
  assert.equal(ranked[0].url, newer.url);
  assert.ok(ranked[0].signals.freshness > ranked[1].signals.freshness);
});

test('declared priority is weighted lightly against real structure', () => {
  const shouted = makeEntry({ url: `${ORIGIN}/x`, priority: 1 });
  const real = makeEntry({ url: `${ORIGIN}/blog/a-genuinely-specific-article-slug`, priority: 0.1 });
  const ranked = rankCandidates([shouted, real]);
  assert.equal(ranked[0].url, real.url, 'a site cannot promote a thin page by declaring priority 1.0');
});

test('every entry is scored, and the signals are inspectable', () => {
  const ranked = rankCandidates(parseSitemap(SITEMAP, '').entries);
  for (const entry of ranked) {
    assert.equal(typeof entry.score, 'number');
    assert.ok(Number.isFinite(entry.score));
    for (const key of ['slugWords', 'depth', 'alternates', 'freshness', 'priority', 'changefreq', 'penalty']) {
      assert.equal(typeof entry.signals[key], 'number', `${entry.url} is missing the ${key} signal`);
    }
  }
});

test('ranking is deterministic, and ties break on the URL', () => {
  const entries = parseSitemap(SITEMAP, '').entries;
  const once = rankCandidates(entries).map((e) => e.url);
  const twice = rankCandidates(parseSitemap(SITEMAP, '').entries).map((e) => e.url);
  assert.deepEqual(once, twice);

  const tied = rankCandidates([
    makeEntry({ url: `${ORIGIN}/blog/b-slug-with-three-words` }),
    makeEntry({ url: `${ORIGIN}/blog/a-slug-with-three-words` }),
  ]).map((e) => e.url);
  assert.deepEqual(tied, [`${ORIGIN}/blog/a-slug-with-three-words`, `${ORIGIN}/blog/b-slug-with-three-words`]);
});

test('ranking keeps every entry and never invents one', () => {
  const entries = parseSitemap(SITEMAP, '').entries;
  const ranked = rankCandidates(entries);
  assert.equal(ranked.length, entries.length);
  assert.deepEqual(new Set(ranked.map((e) => e.url)), new Set(entries.map((e) => e.url)));
  assert.deepEqual(rankCandidates([]), []);
  assert.deepEqual(rankCandidates(null), []);
});

test('topSuggestions caps the list without reordering it', () => {
  const ranked = rankCandidates(parseSitemap(SITEMAP, '').entries);
  assert.deepEqual(topSuggestions(ranked, 3), ranked.slice(0, 3));
  assert.equal(topSuggestions(ranked, 0).length, 1);
  assert.deepEqual(KIND_PRIORITY.slice(0, 4), ['home', 'product', 'article', 'locale']);
});

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

test('robots.txt is consulted first, and its sitemap is used', async () => {
  const http = makeHttp({
    [`${ORIGIN}/robots.txt`]: { body: `User-agent: *\nDisallow: /admin\nSitemap: ${ORIGIN}/custom-sitemap.xml\n` },
    [`${ORIGIN}/custom-sitemap.xml`]: { body: SITEMAP },
  });
  const result = await discoverSitemap(`${ORIGIN}/some/page`, { http });
  assert.equal(result.ok, true);
  assert.equal(result.value[0].kind, 'home');
  assert.equal(http.calls[0], `${ORIGIN}/robots.txt`);
  assert.ok(http.calls.includes(`${ORIGIN}/custom-sitemap.xml`));
});

test('a sitemap index is followed one level down', async () => {
  const http = makeHttp({
    [`${ORIGIN}/sitemap.xml`]: { body: INDEX },
    [`${ORIGIN}/sitemap-pages.xml`]: { body: SITEMAP },
    [`${ORIGIN}/sitemap-posts.xml`]: {
      body: `<urlset><url><loc>${ORIGIN}/blog/another-long-and-specific-post</loc></url></urlset>`,
    },
  });
  const result = await discoverSitemap(ORIGIN, { http });
  assert.equal(result.ok, true);
  assert.equal(result.value.length, 12);
  assert.ok(result.value.some((e) => e.url.includes('another-long-and-specific-post')));
});

test('the conventional paths are tried when robots.txt names nothing', async () => {
  const http = makeHttp({
    [`${ORIGIN}/robots.txt`]: { body: 'User-agent: *\nDisallow:\n' },
    [`${ORIGIN}/sitemap.xml`]: { body: SITEMAP },
  });
  const result = await discoverSitemap(ORIGIN, { http });
  assert.equal(result.ok, true);
  assert.equal(result.value.length, 11);
});

test('a gzipped sitemap is transparently inflated', async () => {
  // A gzip container around a stored-deflate block, built here so the test
  // needs no compressor.
  const body = new TextEncoder().encode(`<urlset><url><loc>${ORIGIN}/blog/a-gzipped-and-specific-post</loc></url></urlset>`);
  const stored = new Uint8Array([1, body.length & 0xff, (body.length >> 8) & 0xff, ~body.length & 0xff, (~body.length >> 8) & 0xff, ...body]);
  const gz = new Uint8Array([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 0, ...stored, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...gunzip(gz)], [...body], 'the gunzip helper itself works');

  const http = makeHttp({
    [`${ORIGIN}/robots.txt`]: { body: `Sitemap: ${ORIGIN}/sitemap.xml.gz` },
    [`${ORIGIN}/sitemap.xml.gz`]: { body: gz },
  });
  const result = await discoverSitemap(ORIGIN, { http });
  assert.equal(result.ok, true);
  assert.ok(result.value.some((e) => e.url.includes('a-gzipped-and-specific-post')));
});

test('gunzip refuses anything that is not a gzip stream', () => {
  assert.equal(gunzip(new Uint8Array([1, 2, 3])), null);
  assert.equal(gunzip(null), null);
});

test('no sitemap anywhere degrades to a Result that says what to do instead', async () => {
  const result = await discoverSitemap(ORIGIN, { http: makeHttp({}) });
  assert.equal(result.ok, false);
  assert.match(result.error, /No sitemap was readable/);
  assert.match(result.error, /add pages by URL/);
  assert.ok(result.detail.tried.length > 0);
});

test('discovery with no transport, or with a bad base, is a Result and not a throw', async () => {
  const noHttp = await discoverSitemap(ORIGIN, {});
  assert.equal(noHttp.ok, false);
  assert.match(noHttp.error, /No network transport/);

  const badBase = await discoverSitemap('not a url at all', { http: makeHttp({}) });
  assert.equal(badBase.ok, false);
});

test('a transport that throws on every request still returns a Result', async () => {
  const exploding = async () => { throw new TypeError('Failed to fetch'); };
  const result = await discoverSitemap(ORIGIN, { http: exploding });
  assert.equal(result.ok, false);
  assert.match(result.error, /No sitemap was readable/);
});

test('scoreEntry is pure and does not mutate the freshness window', () => {
  const entry = makeEntry({ url: `${ORIGIN}/blog/a-specific-post`, lastmod: '2026-01-01' });
  const window = { newest: 20260201000000, oldest: 20250101000000 };
  const before = JSON.stringify(window);
  scoreEntry(entry, window);
  assert.equal(JSON.stringify(window), before);
  assert.ok(entry.score > 0);
});
