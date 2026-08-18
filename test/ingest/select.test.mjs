/**
 * The selector engine (D8).
 *
 * L6 expresses every chrome-stripping signal as a query, so the coverage that
 * matters is not "does `div` work" but "does each supported production match
 * exactly the set it should, and does an unsupported one fail loudly instead of
 * silently returning nothing".
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseHtml, normalizedText, attr } from '../../src/ingest/html-parse.js';
import {
  querySelectorAll, querySelector, matches, closest, parseSelector, SelectorError,
} from '../../src/ingest/select.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '..', 'fixtures', 'ingest');

const PAGE = parseHtml(`
<body class="page">
  <header id="top" class="site chrome" role="banner">
    <nav aria-label="Primary" data-region="nav">
      <a href="/">Home</a>
      <a href="/pricing" class="cta primary" data-track="nav-pricing">Pricing</a>
      <a href="https://partner.example/x" rel="external">Partner</a>
    </nav>
  </header>
  <main>
    <article data-kind="post" lang="en-GB">
      <h1 id="title">Headline</h1>
      <p class="lead">Lead paragraph.</p>
      <p>Second paragraph.</p>
      <ul class="points"><li>one</li><li class="last">two</li></ul>
      <figure><img src="/a.png" alt="A"><figcaption>Caption</figcaption></figure>
    </article>
    <aside class="related"><p>Aside body.</p></aside>
  </main>
  <footer class="site chrome"><p>Footer</p></footer>
</body>`);

/** @param {string} selector */
function names(selector, root = PAGE) {
  return querySelectorAll(root, selector).map((n) => {
    const id = attr(n, 'id');
    const cls = attr(n, 'class');
    return `${n.tag}${id ? `#${id}` : ''}${cls ? `.${cls.split(/\s+/).join('.')}` : ''}`;
  });
}

test('type selector', () => {
  assert.deepEqual(names('figcaption'), ['figcaption']);
  assert.equal(querySelectorAll(PAGE, 'p').length, 4);
});

test('universal selector matches every element but not the root it was given', () => {
  const root = querySelector(PAGE, 'ul.points');
  assert.deepEqual(names('*', root), ['li', 'li.last']);
});

test('class and id selectors', () => {
  assert.deepEqual(names('.lead'), ['p.lead']);
  assert.deepEqual(names('#top'), ['header#top.site.chrome']);
  assert.deepEqual(names('.site.chrome'), ['header#top.site.chrome', 'footer.site.chrome']);
});

test('a compound selector requires every part', () => {
  assert.deepEqual(names('a.cta.primary'), ['a.cta.primary']);
  assert.deepEqual(names('a.cta.missing'), []);
});

test('attribute presence, equality, prefix, suffix, substring, dash and word match', () => {
  assert.deepEqual(names('[data-kind]'), ['article']);
  assert.deepEqual(names('[data-kind=post]'), ['article']);
  assert.deepEqual(names('[data-kind="post"]'), ['article']);
  assert.deepEqual(names('[href^="/pri"]'), ['a.cta.primary']);
  assert.deepEqual(names('[src$=".png"]'), ['img']);
  assert.deepEqual(names('[href*="pricing"]'), ['a.cta.primary']);
  assert.deepEqual(names('[lang|=en]'), ['article']);
  assert.deepEqual(names('[class~=chrome]'), ['header#top.site.chrome', 'footer.site.chrome']);
  assert.deepEqual(names('[data-kind=POST i]'), ['article']);
  assert.deepEqual(names('[data-kind=POST]'), []);
});

test('descendant and child combinators are different', () => {
  assert.equal(querySelectorAll(PAGE, 'main p').length, 3);
  assert.equal(querySelectorAll(PAGE, 'main > article > p').length, 2);
  assert.deepEqual(names('article > ul > li.last'), ['li.last']);
  assert.deepEqual(names('body > p'), []);
});

test('adjacent and general sibling combinators', () => {
  assert.deepEqual(names('h1 + p'), ['p.lead']);
  assert.equal(querySelectorAll(PAGE, 'h1 ~ p').length, 2);
  assert.deepEqual(names('img + figcaption'), ['figcaption']);
});

test('comma groups union, de-duplicate, and stay in document order', () => {
  assert.deepEqual(names('footer p, header nav a.cta, .lead'), ['a.cta.primary', 'p.lead', 'p']);
  assert.deepEqual(names('p.lead, .lead'), ['p.lead'], 'a node matched by two groups appears once');
});

test('structural pseudo-classes', () => {
  assert.deepEqual(names('ul.points li:first-child'), ['li']);
  assert.deepEqual(names('ul.points li:last-child'), ['li.last']);
  assert.deepEqual(names('figure img:only-child'), []);
  assert.deepEqual(names('article :not(p):not(h1):not(ul):not(li):not(figure):not(img):not(figcaption)'), []);
});

test(':is and :where act as a match group', () => {
  assert.deepEqual(names(':is(header, footer) > nav'), ['nav']);
  assert.equal(querySelectorAll(PAGE, ':where(h1, figcaption)').length, 2);
});

test('matches() and closest() walk the live tree', () => {
  const cta = querySelector(PAGE, 'a.cta');
  assert.equal(matches(cta, 'a[href^="/"]'), true);
  assert.equal(matches(cta, 'a[href^="http"]'), false);
  assert.equal(attr(closest(cta, 'header'), 'id'), 'top');
  assert.equal(closest(cta, 'article'), null);
  assert.equal(attr(closest(cta, 'a, nav'), 'class'), 'cta primary', 'closest includes the node itself');
});

test('descendant matching sees ancestors above the queried root, as the DOM does', () => {
  const nav = querySelector(PAGE, 'nav');
  assert.equal(querySelectorAll(nav, 'header a').length, 3);
});

test('an unsupported production is refused rather than silently returning nothing', () => {
  assert.throws(() => querySelectorAll(PAGE, 'li:nth-child(2)'), SelectorError);
  assert.throws(() => querySelectorAll(PAGE, 'p::first-line'), SelectorError);
  assert.throws(() => parseSelector(''), SelectorError);
  assert.throws(() => parseSelector('> p'), SelectorError);
});

test('a selector on a missing tree is empty, not an exception', () => {
  assert.deepEqual(querySelectorAll(null, 'p'), []);
  assert.equal(querySelector(null, 'p'), null);
});

test('the hostile fixture answers the queries a chrome-stripping pass would ask', () => {
  const doc = parseHtml(readFileSync(join(FIXTURES, 'hostile.html'), 'utf8'));

  assert.equal(querySelectorAll(doc, '[role=banner], [role=contentinfo], nav').length, 4);
  assert.equal(querySelectorAll(doc, 'header nav a').length, 6);
  assert.equal(querySelectorAll(doc, 'main > h1').length, 1);
  assert.equal(querySelectorAll(doc, '#cookie-banner').length, 1);
  assert.equal(querySelectorAll(doc, '[data-segment]').length, 1);
  assert.equal(querySelectorAll(doc, 'link[rel=alternate][hreflang]').length, 2);
  assert.equal(querySelectorAll(doc, 'a.cta').length, 1);
  assert.equal(
    normalizedText(querySelector(doc, 'figure > figcaption')),
    'Four reviewers, one artifact.',
  );
  assert.equal(querySelectorAll(doc, 'table.plans thead > tr > th').length, 4);
  assert.equal(querySelectorAll(doc, 'svg > path').length, 1);
});

test('querySelectorAll is deterministic across repeated runs', () => {
  const doc = parseHtml(readFileSync(join(FIXTURES, 'hostile.html'), 'utf8'));
  const once = querySelectorAll(doc, 'main p, main li').map(normalizedText);
  const twice = querySelectorAll(doc, 'main p, main li').map(normalizedText);
  assert.deepEqual(once, twice);
  assert.ok(once.length > 5);
});
