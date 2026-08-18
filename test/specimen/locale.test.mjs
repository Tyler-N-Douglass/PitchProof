/**
 * Locale detection — §8: "Preserve `lang` and locale hints; they drive locale
 * scenarios later." All four signal families, and what happens when they
 * disagree.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { detectLocale, localeSignals, normalizeLocale, urlSignals } from '../../src/specimen/locale.js';
import { loadFixture, parseFixtureHtml } from '../fixtures/specimen/corpus.mjs';

/** @param {string} head */
function doc(head, attrs = 'lang="en"') {
  return parseFixtureHtml(`<!doctype html><html ${attrs}><head>${head}</head><body><p>Body.</p></body></html>`);
}

test('signal 1 — <html lang> and xml:lang', () => {
  assert.equal(detectLocale(doc('', 'lang="fr-CA"'), null), 'fr-CA');
  assert.equal(detectLocale(doc('', 'xml:lang="ja"'), null), 'ja');
  assert.equal(detectLocale(doc('', 'lang="DE-de"'), null), 'de-DE', 'casing is normalised, not trusted');
});

test('signal 2 — og:locale and content-language', () => {
  assert.equal(detectLocale(doc('<meta property="og:locale" content="de_DE">', 'lang=""'), null), 'de-DE');
  assert.equal(detectLocale(doc('<meta http-equiv="content-language" content="pt-BR">', 'lang=""'), null), 'pt-BR');
  assert.equal(detectLocale(doc('<meta name="og:locale" content="zh_Hant_TW">', 'lang=""'), null), 'zh-Hant-TW');
});

test('signal 3 — an hreflang alternate that points at this page', () => {
  const url = 'https://acme.example/de-de/produkte';
  const page = doc(`
    <link rel="alternate" hreflang="x-default" href="https://acme.example/products">
    <link rel="alternate" hreflang="en-US" href="https://acme.example/products">
    <link rel="alternate" hreflang="de-DE" href="https://acme.example/de-de/produkte">`, 'lang="de"');
  assert.equal(detectLocale(page, url), 'de-DE',
    'the alternate whose href is this page is the site naming this page\'s market');

  const signals = localeSignals(page, url);
  assert.equal(signals[0].source, 'hreflang-self');
  assert.ok(!signals.some((s) => s.locale === 'en-US'), 'alternates for other pages are not this page\'s locale');
});

test('signal 4 — the URL: path segment, subdomain, query and country-code TLD', () => {
  assert.deepEqual(urlSignals('https://acme.example/en-gb/pricing').map((s) => s.source), ['url-path']);
  assert.deepEqual(urlSignals('https://de.acme.example/preise').map((s) => s.source), ['url-subdomain']);
  assert.deepEqual(urlSignals('https://acme.example/page?lang=ja').map((s) => s.source), ['url-query']);
  assert.deepEqual(urlSignals('https://www.acme.de/preise').map((s) => s.source), ['tld']);
  assert.deepEqual(urlSignals('https://www.fr.acme.example/x').map((s) => s.source), ['url-subdomain']);

  assert.equal(detectLocale(doc('', 'lang=""'), 'https://acme.example/es-mx/precios'), 'es-MX');
  assert.equal(detectLocale(doc('', 'lang=""'), 'https://nl.acme.example/'), 'nl');
  assert.equal(detectLocale(doc('', 'lang=""'), 'https://acme.example/p?locale=it-IT'), 'it-IT');
});

test('a ccTLD names a market, never a language, and only ever refines one', () => {
  assert.equal(detectLocale(doc('', 'lang=""'), 'https://www.acme.de/'), null,
    'a .de domain alone does not prove the page is in German');
  assert.equal(detectLocale(doc('', 'lang="de"'), 'https://www.acme.de/'), 'de-DE');
  assert.equal(detectLocale(doc('', 'lang="en"'), 'https://www.acme.co.uk/'), 'en-GB',
    '.uk is the market whose BCP-47 region is GB');
  assert.equal(detectLocale(doc('', 'lang="en"'), 'https://acme.io/'), 'en', 'a vanity TLD says nothing');
});

test('the strongest signal wins, and a weaker one may only add specificity', () => {
  // `lang="en"` outranks the path, but the path knows the market.
  assert.equal(detectLocale(doc('', 'lang="en"'), 'https://acme.example/en-au/support'), 'en-AU');
  // A path in a different language does not override the document's own lang.
  assert.equal(detectLocale(doc('', 'lang="de"'), 'https://acme.example/en/support'), 'de');
  // og:locale is more specific than lang and agrees on the language.
  assert.equal(detectLocale(doc('<meta property="og:locale" content="en_US">', 'lang="en"'), null), 'en-US');
});

test('normalizeLocale accepts what pages actually contain, and refuses what is not a locale', () => {
  assert.equal(normalizeLocale('en_us'), 'en-US');
  assert.equal(normalizeLocale('  pt-br  '), 'pt-BR');
  assert.equal(normalizeLocale('zh-hans-cn'), 'zh-Hans-CN');
  assert.equal(normalizeLocale('en-029'), 'en-029');
  assert.equal(normalizeLocale('es-419,es;q=0.9'), 'es-419');
  assert.equal(normalizeLocale('xx'), null, 'an unassigned two-letter code is not a language');
  assert.equal(normalizeLocale('products'), null);
  assert.equal(normalizeLocale(''), null);
  assert.equal(normalizeLocale(null), null);
});

test('a page with no locale hint at all reports null rather than guessing', () => {
  const bare = parseFixtureHtml('<!doctype html><html><head><title>T</title></head><body><p>Hi.</p></body></html>');
  assert.equal(detectLocale(bare, 'https://acme.example/page'), null);
  assert.deepEqual(localeSignals(bare, 'https://acme.example/page'), []);
});

test('every signal found is retained for the studio, ranked', () => {
  const page = doc('<meta property="og:locale" content="en_US">', 'lang="en"');
  const signals = localeSignals(page, 'https://acme.example/en-gb/x');
  assert.deepEqual(signals.map((s) => s.source), ['html-lang', 'og:locale', 'url-path']);
  assert.ok(signals[0].rank > signals[1].rank);
  assert.deepEqual(signals.map((s) => s.locale), ['en', 'en-US', 'en-GB']);
});

test('the corpus fixtures resolve to the locales their pages declare', () => {
  const cases = [
    ['home.html', 'en-US'],
    ['product.html', 'en'],
    ['article.html', 'en-GB'],
    ['article-de.html', 'de-DE'],
    ['docs.html', 'en'],
  ];
  for (const [name, expected] of cases) {
    const fx = loadFixture(name);
    assert.equal(detectLocale(fx.doc, fx.url), expected, name);
  }
});
