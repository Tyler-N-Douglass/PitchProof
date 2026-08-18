/**
 * Face detection, role assignment, and the embedding law (§7, §18).
 *
 * The load-bearing assertion in this file is the one about `embeddable`:
 * detection may never set it, a Google Fonts link may never set it, and the
 * only route to `true` is a user supplying a file together with a recorded
 * rights assertion.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  detectFaces, collectTypeEvidence, scoreRole, attachUserFont, facesConfidence,
  parseGoogleFontsHref, parseFontShorthand, parseFontWeight, parseFontSize,
  parseFamilyDeclaration, isWebfontHost, hostOf, srcUrls, representativeWeight,
  isFallbackOnly, normalizeStylesheets, walkDoc, docText, inlineSelector,
} from '../../src/brand/type.js';

const fixturePath = (name) => fileURLToPath(new URL(`../fixtures/brand/faces/${name}`, import.meta.url));
const fixture = (name) => readFileSync(fixturePath(name), 'utf8');

/** Minimal DocNode builders — the node shape L3 declares in API.md. */
const el = (tag, attrs = {}, children = []) => ({ type: 'element', tag, attrs, children });
const txt = (text) => ({ type: 'text', text });

const AVAILABLE = ['Arial', 'Helvetica', 'Georgia', 'Times New Roman', 'Courier New', 'Verdana'];

// ---------------------------------------------------------------- role solve

test('a heading-heavy stylesheet yields a display face and a body face', () => {
  const faces = detectFaces(null, fixture('heading-heavy.css'), { available: AVAILABLE });
  const byFamily = new Map(faces.map((f) => [f.family, f]));

  assert.ok(byFamily.has('Canela Deck'), `expected Canela Deck among ${[...byFamily.keys()].join(', ')}`);
  assert.ok(byFamily.has('Söhne'), `expected Söhne among ${[...byFamily.keys()].join(', ')}`);
  assert.equal(byFamily.get('Canela Deck').role, 'display');
  assert.equal(byFamily.get('Söhne').role, 'body');

  // Georgia and Helvetica only ever appear behind another family, so they are
  // fallbacks rather than brand faces.
  assert.equal(byFamily.has('Georgia'), false);
  assert.equal(byFamily.has('Helvetica'), false);

  // The @font-face rule and the heading rules both name Canela Deck, so it has
  // two independent sources behind it.
  assert.deepEqual(byFamily.get('Canela Deck').evidence.sources, ['font-face', 'stylesheet']);
  assert.deepEqual(byFamily.get('Canela Deck').weightsSeen, [700]);
});

test('a body-only stylesheet yields exactly one body face and no display face', () => {
  const faces = detectFaces(null, fixture('body-only.css'), { available: AVAILABLE });
  assert.equal(faces.length, 1, `expected one face, got ${faces.map((f) => f.family).join(', ')}`);
  assert.equal(faces[0].family, 'Public Sans');
  assert.equal(faces[0].role, 'body');
  assert.equal(faces.some((f) => f.role === 'display'), false);
});

test('a mono-in-code stylesheet yields a mono face from the stack and the selectors', () => {
  const faces = detectFaces(null, fixture('mono-code.css'), { available: AVAILABLE });
  const mono = faces.filter((f) => f.role === 'mono');
  assert.equal(mono.length, 1, `expected one mono face, got ${mono.map((f) => f.family).join(', ')}`);
  assert.equal(mono[0].family, 'IBM Plex Mono');
  assert.equal(faces.find((f) => f.family === 'Inter').role, 'body');
});

test('a monospace generic in the stack is enough to call a face mono', () => {
  // The family name gives no hint at all here; only the generic and the
  // selectors do.
  const css = '.terminal-output { font-family: "Aperture", ui-monospace, monospace; font-size: 13px; }';
  const [face] = detectFaces(null, css, { available: AVAILABLE });
  assert.equal(face.family, 'Aperture');
  assert.equal(face.role, 'mono');
  assert.ok(face.roleScores.mono > face.roleScores.body);
});

test('role scoring is additive and inspectable', () => {
  const css = 'h1 { font-family: Foo; font-size: 56px; font-weight: 700; }';
  const { index } = collectTypeEvidence(null, css);
  const ev = index.get('foo');
  const scored = scoreRole(ev);
  assert.equal(scored.role, 'display');
  assert.ok(scored.scores.display >= 6, `display score ${scored.scores.display}`);
  assert.ok(scored.margin > 0);
});

test('large sizes alone imply display, copy sizes alone imply body', () => {
  const big = detectFaces(null, '.callout { font-family: Foo; font-size: 44px; }', { available: AVAILABLE });
  assert.equal(big[0].role, 'display');
  const small = detectFaces(null, '.note { font-family: Foo; font-size: 15px; }', { available: AVAILABLE });
  assert.equal(small[0].role, 'body');
});

// ------------------------------------------------------------- google fonts

test('a Google Fonts v2 href is parsed for families and weight axes', () => {
  const parsed = parseGoogleFontsHref('https://fonts.googleapis.com/css2?family=Inter:wght@400;700&family=Lora:ital,wght@0,400;1,700&display=swap');
  assert.deepEqual(parsed, [
    { family: 'Inter', weights: [400, 700] },
    { family: 'Lora', weights: [400, 700] },
  ]);
});

test('a Google Fonts v1 href is parsed too', () => {
  const parsed = parseGoogleFontsHref('https://fonts.googleapis.com/css?family=Open+Sans:400,700italic|Lora');
  assert.deepEqual(parsed, [
    { family: 'Open Sans', weights: [400, 700] },
    { family: 'Lora', weights: [] },
  ]);
});

test('a variable-font weight range in a href expands to both ends', () => {
  const parsed = parseGoogleFontsHref('https://fonts.googleapis.com/css2?family=Figtree:wght@300..900');
  assert.deepEqual(parsed, [{ family: 'Figtree', weights: [300, 900] }]);
});

test('webfont hosts are recognised and never fetched', () => {
  assert.equal(isWebfontHost('https://fonts.googleapis.com/css2?family=Inter'), true);
  assert.equal(isWebfontHost('https://use.typekit.net/abc.css'), true);
  assert.equal(isWebfontHost('https://example.com/fonts/brand.woff2'), false);
  assert.equal(hostOf('https://fonts.gstatic.com/s/inter/x.woff2'), 'fonts.gstatic.com');
});

test('a Google Fonts link contributes families but never makes them embeddable', () => {
  const html = fixture('google-link.html');
  const styleCss = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
  const hrefs = [...html.matchAll(/<link\b[^>]*href="([^"]+)"[^>]*>/g)]
    .map((m) => m[1].replace(/&amp;/g, '&'));

  const doc = el('html', {}, [
    el('head', {}, hrefs.map((href) => el('link', { rel: 'stylesheet', href }, []))),
    el('body', {}, [
      el('h1', { class: 'hero-title', style: "font-family: 'Playfair Display', serif; font-size: 60px;" }, [txt('Headline')]),
      el('p', {}, [txt('Body copy.')]),
    ]),
  ]);

  const faces = detectFaces(doc, styleCss, { available: AVAILABLE });
  const families = faces.map((f) => f.family);
  assert.ok(families.includes('Playfair Display'), families.join(', '));
  assert.ok(families.includes('Source Sans Pro'), families.join(', '));
  assert.ok(families.includes('Open Sans'), families.join(', '));
  assert.ok(families.includes('Lora'), families.join(', '));

  for (const face of faces) {
    assert.equal(face.embeddable, false, `${face.family} must not be embeddable from a link alone (§7, §18)`);
  }

  const playfair = faces.find((f) => f.family === 'Playfair Display');
  assert.equal(playfair.role, 'display');
  assert.equal(playfair.webfontLinked, true);
  assert.deepEqual(playfair.webfontHosts, ['fonts.googleapis.com']);
  assert.deepEqual(playfair.weightsSeen, [700, 900]);
});

test('every detected face is non-embeddable, across every fixture', () => {
  for (const name of ['heading-heavy.css', 'body-only.css', 'mono-code.css']) {
    for (const face of detectFaces(null, fixture(name), { available: AVAILABLE })) {
      assert.equal(face.embeddable, false, `${name}: ${face.family}`);
    }
  }
});

// ------------------------------------------------------- user-supplied fonts

test('attachUserFont is the only route to embeddable, and records the assertion', () => {
  const faces = detectFaces(null, 'body { font-family: "Söhne", sans-serif; font-size: 16px; }', { available: AVAILABLE });
  assert.equal(faces[0].embeddable, false);

  const clock = () => '2026-03-04T09:00:00.000Z';
  const bytes = new Uint8Array(2048).fill(7);
  const result = attachUserFont(faces, {
    family: 'Söhne',
    fileName: 'soehne-buch.woff2',
    bytes,
    weights: [400, 600],
    rightsAssertion: {
      assertedBy: 'dana@acme.example',
      statement: 'Acme holds a desktop and web licence for Söhne and authorises embedding it in this proof.',
    },
  }, { clock, available: AVAILABLE });

  assert.equal(result.face.embeddable, true);
  assert.equal(result.face.available, true);
  assert.deepEqual(result.face.metricDelta, { capHeight: 1, xHeight: 1, avgAdvance: 1 });
  assert.deepEqual(result.face.weightsSeen, [400, 600]);
  assert.equal(result.face.rightsAssertion.assertedBy, 'dana@acme.example');
  assert.equal(result.face.rightsAssertion.assertedAt, '2026-03-04T09:00:00.000Z');
  assert.equal(result.assertion.bytes, 2048);
  assert.equal(result.assertion.fileName, 'soehne-buch.woff2');
  assert.equal(result.face.fontFile.mime, 'font/woff2');
  // The original array is not mutated.
  assert.equal(faces[0].embeddable, false);
});

test('attachUserFont refuses a file with no rights assertion', () => {
  const faces = detectFaces(null, 'body { font-family: Foo; }', { available: AVAILABLE });
  assert.throws(
    () => attachUserFont(faces, { family: 'Foo', fileName: 'foo.woff2', bytes: new Uint8Array(4) }, { clock: () => 'x' }),
    /rights assertion/,
  );
  assert.throws(
    () => attachUserFont(faces, { family: 'Foo', fileName: 'foo.woff2', bytes: new Uint8Array(4), rightsAssertion: { assertedBy: '', statement: '' } }, { clock: () => 'x' }),
    /rights assertion/,
  );
});

test('attachUserFont refuses a rights assertion with no file', () => {
  assert.throws(
    () => attachUserFont([], { family: 'Foo', fileName: 'foo.woff2', rightsAssertion: { assertedBy: 'a', statement: 'b' } }, { clock: () => 'x' }),
    /font file/,
  );
});

test('attachUserFont adds a family the page never named', () => {
  const clock = () => '2026-03-04T09:00:00.000Z';
  const { faces } = attachUserFont([], {
    family: 'Untitled Sans',
    fileName: 'untitled-sans.otf',
    bytes: new Uint8Array(16),
    rightsAssertion: { assertedBy: 'ops@acme.example', statement: 'Licensed.' },
  }, { clock });
  assert.equal(faces.length, 1);
  assert.equal(faces[0].family, 'Untitled Sans');
  assert.equal(faces[0].embeddable, true);
  assert.equal(faces[0].fontFile.mime, 'font/otf');
});

// ---------------------------------------------------------------- CSS values

test('the font shorthand is parsed, not pattern-matched', () => {
  assert.deepEqual(parseFontShorthand('italic small-caps bold 24px/1.4 "Inter", sans-serif'), {
    weights: [700], sizePx: 24, families: ['Inter', 'sans-serif'],
  });
  assert.deepEqual(parseFontShorthand('600 1.5rem/2 Georgia, serif'), {
    weights: [600], sizePx: 24, families: ['Georgia', 'serif'],
  });
  assert.equal(parseFontShorthand('menu'), null);
  assert.equal(parseFontShorthand(''), null);
});

test('font-weight keywords and variable ranges are read', () => {
  assert.deepEqual(parseFontWeight('bold'), [700]);
  assert.deepEqual(parseFontWeight('normal'), [400]);
  assert.deepEqual(parseFontWeight('100 900'), [100, 900]);
  assert.deepEqual(parseFontWeight('550'), [550]);
  assert.deepEqual(parseFontWeight('nonsense'), []);
});

test('font-size resolves keywords, rem and percentages', () => {
  assert.equal(parseFontSize('x-large'), 24);
  assert.equal(parseFontSize('1.25rem'), 20);
  assert.equal(parseFontSize('1.25rem', { rootFontSizePx: 10 }), 12.5);
  assert.equal(parseFontSize('150%'), 24);
  assert.equal(parseFontSize('12pt'), 16);
});

test('a font-family list separates real families from generics', () => {
  const parsed = parseFamilyDeclaration('"Fira Code", ui-monospace, SFMono-Regular, monospace');
  assert.deepEqual(parsed.families, ['Fira Code', 'SFMono-Regular']);
  assert.deepEqual(parsed.generics, ['ui-monospace', 'monospace']);
  assert.equal(parsed.monoGeneric, true);
});

test('@font-face src urls are extracted without being followed', () => {
  const urls = srcUrls("url('/a.woff2') format('woff2'), url(https://fonts.gstatic.com/b.woff) format('woff')");
  assert.deepEqual(urls, ['/a.woff2', 'https://fonts.gstatic.com/b.woff']);
});

test('the representative weight is 400 when the page uses it, and the nearest cut otherwise', () => {
  assert.equal(representativeWeight([300, 400, 700]), 400);
  assert.equal(representativeWeight([500, 700]), 500);
  assert.equal(representativeWeight([200, 800]), 200);
  assert.equal(representativeWeight([]), 400);
});

test('stylesheets may be given as a string, a list, or href-tagged records', () => {
  assert.deepEqual(normalizeStylesheets('a{}'), [{ text: 'a{}', href: null }]);
  assert.deepEqual(normalizeStylesheets(['a{}', 'b{}']), [{ text: 'a{}', href: null }, { text: 'b{}', href: null }]);
  assert.deepEqual(normalizeStylesheets([{ text: 'a{}', href: '/x.css' }]), [{ text: 'a{}', href: '/x.css' }]);
});

// ----------------------------------------------------------------- evidence

test('inline style attributes are evidence, attributed to a readable selector', () => {
  const doc = el('body', {}, [
    el('h1', { class: 'masthead__title', id: 'top', style: 'font-family: "Ampersand"; font-size: 52px;' }, [txt('Hi')]),
  ]);
  const { index } = collectTypeEvidence(doc, '');
  const ev = index.get('ampersand');
  assert.ok(ev);
  assert.deepEqual([...ev.sources], ['inline']);
  assert.deepEqual(ev.selectors, ['h1#top.masthead__title']);
  assert.deepEqual(ev.sizesPx, [52]);
});

test('a <style> element inside the document is read as a stylesheet', () => {
  const doc = el('html', {}, [el('head', {}, [el('style', {}, [txt('body { font-family: Chronicle; font-size: 16px; }')])])]);
  const faces = detectFaces(doc, '', { available: AVAILABLE });
  assert.equal(faces.length, 1);
  assert.equal(faces[0].family, 'Chronicle');
});

test('a family that only ever sits behind another is a fallback, not a face', () => {
  const { index } = collectTypeEvidence(null, 'body { font-family: Brandon, Arial, sans-serif; font-size: 16px; }');
  assert.equal(isFallbackOnly(index.get('brandon')), false);
  assert.equal(isFallbackOnly(index.get('arial')), true);
  const kept = detectFaces(null, 'body { font-family: Brandon, Arial, sans-serif; font-size: 16px; }', { available: AVAILABLE, includeFallbackFamilies: true });
  assert.equal(kept.length, 2);
});

test('walkDoc and docText traverse the L3 node shape', () => {
  const doc = el('div', {}, [el('span', {}, [txt('a')]), txt('b')]);
  const tags = [];
  walkDoc(doc, (n) => { if (n.type === 'element') tags.push(n.tag); });
  assert.deepEqual(tags, ['div', 'span']);
  assert.equal(docText(doc), 'ab');
  assert.equal(inlineSelector(el('a', { class: 'x y z w', id: 'q' })), 'a#q.x.y.z');
});

// --------------------------------------------------------------- confidence

test('confidence rises with sample size and with agreement across sources', () => {
  const once = detectFaces(null, '.a { font-family: Metric; font-size: 16px; }', { available: AVAILABLE })[0];
  const many = detectFaces(null, `
    @font-face { font-family: Metric; src: url(/m.woff2); font-weight: 400; }
    .a, .b { font-family: Metric; font-size: 16px; }
    .c { font-family: Metric; font-size: 17px; }
    .d { font-family: Metric; font-size: 16px; }
    .e { font-family: Metric; font-size: 16px; }
    .f { font-family: Metric; font-size: 16px; }
  `, { available: AVAILABLE })[0];
  assert.ok(many.confidence > once.confidence, `${many.confidence} should exceed ${once.confidence}`);
  assert.ok(once.confidence > 0 && many.confidence <= 1);
});

test('a face whose substitution moves the metrics is less confident than one that does not', () => {
  const exact = detectFaces(null, 'body { font-family: Arial; font-size: 16px; }', { available: AVAILABLE })[0];
  const moved = detectFaces(null, 'body { font-family: Montserrat; font-size: 16px; }', { available: AVAILABLE })[0];
  assert.ok(moved.metricDelta.avgAdvance !== 1);
  assert.ok(exact.confidence > moved.confidence, `${exact.confidence} should exceed ${moved.confidence}`);
});

test('group confidence is discounted when no body face was found', () => {
  const withBody = detectFaces(null, 'body { font-family: Alpha; font-size: 16px; }', { available: AVAILABLE });
  const withoutBody = detectFaces(null, 'h1 { font-family: Alpha; font-size: 48px; }', { available: AVAILABLE });
  assert.equal(withBody[0].role, 'body');
  assert.equal(withoutBody[0].role, 'display');
  assert.ok(facesConfidence(withBody) > facesConfidence(withoutBody));
  assert.equal(facesConfidence([]), 0);
});

test('confidence is never a hardcoded constant across different inputs', () => {
  const values = new Set([
    facesConfidence(detectFaces(null, 'body { font-family: Alpha; font-size: 16px; }', { available: AVAILABLE })),
    facesConfidence(detectFaces(null, fixture('heading-heavy.css'), { available: AVAILABLE })),
    facesConfidence(detectFaces(null, fixture('body-only.css'), { available: AVAILABLE })),
    facesConfidence(detectFaces(null, fixture('mono-code.css'), { available: AVAILABLE })),
  ]);
  assert.ok(values.size >= 3, `expected distinct confidences, got ${[...values].join(', ')}`);
});

// ------------------------------------------------------------- determinism

test('detection is deterministic: identical input, identical output', () => {
  const css = fixture('heading-heavy.css');
  const a = JSON.stringify(detectFaces(null, css, { available: AVAILABLE }));
  const b = JSON.stringify(detectFaces(null, css, { available: AVAILABLE }));
  assert.equal(a, b);
});

test('detection order does not depend on declaration order for equal evidence', () => {
  const one = detectFaces(null, '.a { font-family: Zeta; font-size: 16px; } .b { font-family: Alpha; font-size: 16px; }', { available: AVAILABLE });
  const two = detectFaces(null, '.b { font-family: Alpha; font-size: 16px; } .a { font-family: Zeta; font-size: 16px; }', { available: AVAILABLE });
  assert.deepEqual(one.map((f) => f.family), two.map((f) => f.family));
  assert.deepEqual(one.map((f) => f.family), ['Alpha', 'Zeta']);
});
