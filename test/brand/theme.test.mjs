/**
 * The L5 lane surface: `buildBrandSystem` and `compileTheme`.
 *
 * Two laws are asserted here rather than described:
 *
 *   D11/§15 — the artifact theme is `--pp-*` only. The test reads
 *   `src/runtime/runtime.css`, collects every custom property the stylesheet
 *   declares or reads, and asserts the compiled theme covers all of them and
 *   contains no `--st-*` name anywhere.
 *
 *   §4 — `buildBrandSystem` produces a BrandSystem that `validateBrand` accepts
 *   with zero errors, for every shape of input the studio can hand it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { validateBrand, COLOR_ROLES, MAX_TRANSITION_MS } from '../../src/core/contracts.js';
import { IdMinter } from '../../src/core/ids.js';
import { cssFontFamily } from '../../src/core/text-metrics.js';
import { stripCssComments } from '../../src/brand/shape.js';
import { encodePng } from '../../src/brand/logo.js';
import {
  buildBrandSystem, compileTheme, pickFace, assertNoStudioVars, joinCss,
  normalizeFace, normalizeLogo, normalizeColor,
  detectFaces, detectShape, classifyImagery, extractLogos, inverseVariant, attachUserFont,
  sampleFromPng, classifyImage, normalizeSample, selectLogos, identityScore, declaredLogoUrls,
  logosConfidence, toImageSamples,
  ROLE_VAR, FACE_VAR, VAR_ORDER, THEME_DEFAULTS, SHADOW_SCALE, TRANSITION_MS, STUDIO_PREFIX,
} from '../../src/brand/theme.js';

const RUNTIME_CSS = readFileSync(fileURLToPath(new URL('../../src/runtime/runtime.css', import.meta.url)), 'utf8');

const clock = () => '2026-05-01T12:00:00.000Z';
const minter = () => new IdMinter('pitchproof-test', 'brand');

const el = (tag, attrs = {}, children = []) => ({ type: 'element', tag, attrs, children });

/** A hand-built palette in the §4 ColorToken shape; L4 owns the real solve. */
const PALETTE = [
  ['primary', '#0b3fbe', [0.42, 0.19, 265]],
  ['onPrimary', '#ffffff', [1, 0, 0]],
  ['secondary', '#5a6b8c', [0.55, 0.06, 260]],
  ['onSecondary', '#ffffff', [1, 0, 0]],
  ['surface', '#ffffff', [1, 0, 0]],
  ['onSurface', '#121417', [0.19, 0.01, 260]],
  ['surfaceAlt', '#f2f4f8', [0.96, 0.005, 260]],
  ['onSurfaceAlt', '#121417', [0.19, 0.01, 260]],
  ['accent', '#e8590c', [0.63, 0.19, 42]],
  ['onAccent', '#ffffff', [1, 0, 0]],
  ['border', '#d5dae3', [0.88, 0.01, 260]],
  ['success', '#12653c', [0.44, 0.11, 155]],
  ['warning', '#8a5300', [0.47, 0.11, 70]],
  ['danger', '#a11d1d', [0.44, 0.17, 27]],
].map(([role, hex, oklch]) => ({ role, hex, oklch, source: 'extracted', contrastWithPair: 7.1 }));

const CSS = `
  :root { font-size: 100% }
  @font-face { font-family: "Söhne"; src: url("/f/soehne.woff2"); font-weight: 400 }
  h1, h2, .hero__title { font-family: "Canela", Georgia, serif; font-size: 56px; font-weight: 700 }
  body, p { font-family: "Söhne", Helvetica, sans-serif; font-size: 17px }
  pre, code { font-family: "Berkeley Mono", ui-monospace, monospace; font-size: 13px }
  .card, .panel { border-radius: 12px; border: 1px solid #d5dae3; box-shadow: 0 1px 3px rgba(0,0,0,.12) }
  .modal { border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.12) }
`;

// ------------------------------------------------------- variable coverage

/** Every `--pp-*` name the artifact stylesheet declares or reads. */
function runtimeVars(css) {
  const declared = [...css.matchAll(/(--pp-[a-z0-9-]+)\s*:/g)].map((m) => m[1]);
  const read = [...css.matchAll(/var\(\s*(--pp-[a-z0-9-]+)/g)].map((m) => m[1]);
  return new Set([...declared, ...read]);
}

test('the compiled theme covers every --pp-* the runtime stylesheet uses', () => {
  const needed = runtimeVars(RUNTIME_CSS);
  assert.ok(needed.size >= 20, `expected the stylesheet to use many variables, found ${needed.size}`);
  const theme = compileTheme(buildBrandSystem({ colors: PALETTE, css: CSS }, { clock, idMinter: minter() }));
  for (const name of [...needed].sort()) {
    assert.ok(name in theme.vars, `${name} is read by runtime.css but not emitted by compileTheme`);
    assert.ok(theme.css.includes(`${name}:`), `${name} is missing from the compiled :root block`);
  }
});

test('the emitted variable set is exactly VAR_ORDER, with no strays', () => {
  const theme = compileTheme(buildBrandSystem({ colors: PALETTE, css: CSS }, { clock, idMinter: minter() }));
  assert.deepEqual(Object.keys(theme.vars).sort(), VAR_ORDER.slice().sort());
  const emitted = [...theme.css.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1]);
  assert.deepEqual(emitted, VAR_ORDER, 'declarations are emitted in the declared order');
});

test('every ColorRole in §4 has a --pp-* variable', () => {
  for (const role of COLOR_ROLES) {
    assert.ok(ROLE_VAR[role], `no variable mapped for ${role}`);
    assert.ok(ROLE_VAR[role].startsWith('--pp-'));
  }
  assert.equal(new Set(Object.values(ROLE_VAR)).size, COLOR_ROLES.length, 'no two roles share a variable');
});

test('no --st-* name appears anywhere in the compiled output (D11, §15)', () => {
  const brand = buildBrandSystem({ colors: PALETTE, css: CSS }, { clock, idMinter: minter() });
  const theme = compileTheme(brand);
  assert.equal(theme.css.includes(STUDIO_PREFIX), false);
  assert.equal(JSON.stringify(theme.vars).includes(STUDIO_PREFIX), false);
  for (const name of Object.keys(theme.vars)) assert.ok(name.startsWith('--pp-'), name);
  assert.throws(() => assertNoStudioVars(':root{--st-ground:#0B1220}'), /--st-/);
  assert.equal(assertNoStudioVars(':root{--pp-primary:#fff}'), ':root{--pp-primary:#fff}');
});

test('the runtime stylesheet itself carries no studio variable', () => {
  // Comments may *name* the rule; the stylesheet may not use it.
  assert.equal(stripCssComments(RUNTIME_CSS).includes(STUDIO_PREFIX), false);
});

// ------------------------------------------------------------------ colours

test('colour roles compile to their variables', () => {
  const theme = compileTheme(buildBrandSystem({ colors: PALETTE, css: CSS }, { clock, idMinter: minter() }));
  assert.equal(theme.vars['--pp-primary'], '#0b3fbe');
  assert.equal(theme.vars['--pp-on-primary'], '#ffffff');
  assert.equal(theme.vars['--pp-surface-alt'], '#f2f4f8');
  assert.equal(theme.vars['--pp-on-surface-alt'], '#121417');
  assert.equal(theme.vars['--pp-danger'], '#a11d1d');
});

test('a role with no token keeps the stylesheet default rather than going blank', () => {
  const partial = PALETTE.filter((c) => c.role === 'primary' || c.role === 'onPrimary');
  const theme = compileTheme(buildBrandSystem({ colors: partial }, { clock, idMinter: minter() }));
  assert.equal(theme.vars['--pp-primary'], '#0b3fbe');
  assert.equal(theme.vars['--pp-accent'], THEME_DEFAULTS['--pp-accent']);
  assert.equal(theme.vars['--pp-surface'], THEME_DEFAULTS['--pp-surface']);
});

test('a malformed colour token is dropped, not emitted', () => {
  assert.equal(normalizeColor({ role: 'primary', hex: 'blue', oklch: [1, 0, 0], source: 'manual' }), null);
  assert.equal(normalizeColor({ role: 'nope', hex: '#000000', oklch: [1, 0, 0], source: 'manual' }), null);
  assert.equal(normalizeColor({ role: 'primary', hex: '#000000', oklch: [1, 0], source: 'manual' }), null);
  assert.equal(normalizeColor({ role: 'primary', hex: '#000000', oklch: [1, 0, 0], source: 'guess' }), null);
  assert.equal(normalizeColor({ role: 'primary', hex: '#00FF00', oklch: [1, 0, 0], source: 'manual' }).hex, '#00ff00');
});

// -------------------------------------------------------------------- type

test('the three faces compile through cssFontFamily', () => {
  const brand = buildBrandSystem({ colors: PALETTE, css: CSS }, { clock, idMinter: minter() });
  const theme = compileTheme(brand);
  const display = pickFace(brand.faces, 'display');
  const body = pickFace(brand.faces, 'body');
  const mono = pickFace(brand.faces, 'mono');
  assert.equal(display.family, 'Canela');
  assert.equal(body.family, 'Söhne');
  assert.equal(mono.family, 'Berkeley Mono');
  assert.equal(theme.vars['--pp-font-display'], cssFontFamily(display.fallbackStack));
  assert.equal(theme.vars['--pp-font-body'], cssFontFamily(body.fallbackStack));
  assert.equal(theme.vars['--pp-font-mono'], cssFontFamily(mono.fallbackStack));
  assert.ok(theme.vars['--pp-font-display'].startsWith('Canela,'), theme.vars['--pp-font-display']);
});

test('a missing display face borrows the body face, and a missing mono face falls back', () => {
  const brand = buildBrandSystem({ colors: PALETTE, css: 'body { font-family: "Public Sans", sans-serif; font-size: 16px }' }, { clock, idMinter: minter() });
  const theme = compileTheme(brand);
  assert.equal(theme.vars['--pp-font-display'], theme.vars['--pp-font-body']);
  assert.equal(theme.vars['--pp-font-mono'], THEME_DEFAULTS['--pp-font-mono']);
  assert.equal(pickFace(brand.faces, 'mono'), null);
});

test('the face with the strongest evidence carries the role', () => {
  const faces = [
    { family: 'Weak', role: 'body', confidence: 0.2, evidence: { occurrences: 1 }, fallbackStack: ['Weak'], weightsSeen: [400], metricDelta: null, embeddable: false },
    { family: 'Strong', role: 'body', confidence: 0.9, evidence: { occurrences: 9 }, fallbackStack: ['Strong'], weightsSeen: [400], metricDelta: null, embeddable: false },
  ];
  assert.equal(pickFace(faces, 'body').family, 'Strong');
  assert.equal(pickFace(faces.slice().reverse(), 'body').family, 'Strong');
  assert.equal(FACE_VAR.display, '--pp-font-display');
});

test('no face is embedded unless the user supplied the file and asserted the rights', () => {
  const brand = buildBrandSystem({ colors: PALETTE, css: CSS }, { clock, idMinter: minter() });
  for (const face of brand.faces) assert.equal(face.embeddable, false);
  const theme = compileTheme(brand);
  assert.deepEqual(theme.fontFaces, []);
  assert.equal(theme.css.includes('@font-face'), false);
});

test('a user-supplied, rights-asserted font is embedded as a data URI and nothing else is', () => {
  const detected = detectFaces(null, CSS, {});
  const { faces } = attachUserFont(detected, {
    family: 'Söhne',
    fileName: 'soehne.woff2',
    dataUri: 'data:font/woff2;base64,d09GMgABAAAAAA',
    weights: [400, 700],
    rightsAssertion: { assertedBy: 'dana@acme.example', statement: 'Licensed for this proof.' },
  }, { clock });
  const theme = compileTheme(buildBrandSystem({ colors: PALETTE, faces }, { clock, idMinter: minter() }));
  assert.deepEqual(theme.fontFaces, ['Söhne']);
  assert.ok(theme.css.includes('@font-face'));
  assert.ok(theme.css.includes('font-family: "Söhne"'));
  assert.ok(theme.css.includes('font-weight: 400 700'));
  assert.ok(theme.css.includes('src: url("data:font/woff2;base64,'));
  // The only url in the stylesheet is a data URI — the artifact makes no request.
  for (const m of theme.css.matchAll(/url\(\s*"([^"]*)"/g)) assert.ok(m[1].startsWith('data:'), m[1]);
});

test('an embeddable face with no file is not written into the stylesheet', () => {
  const faces = [{ family: 'Ghost', role: 'body', fallbackStack: ['Ghost'], weightsSeen: [400], metricDelta: null, embeddable: true }];
  const theme = compileTheme(buildBrandSystem({ colors: PALETTE, faces }, { clock, idMinter: minter() }));
  assert.equal(theme.css.includes('@font-face'), false);
});

// ------------------------------------------------------------------- shape

test('shape compiles to radius, border width and a shadow from the tier ladder', () => {
  const theme = compileTheme(buildBrandSystem({ colors: PALETTE, css: CSS }, { clock, idMinter: minter() }));
  assert.equal(theme.vars['--pp-radius'], '12px');
  assert.equal(theme.vars['--pp-border-width'], '1px');
  assert.equal(theme.vars['--pp-shadow'], SHADOW_SCALE[1]);
});

test('every shadow tier has a shadow, and tier 0 is none', () => {
  assert.equal(SHADOW_SCALE[0], 'none');
  for (const level of [1, 2, 3]) {
    const theme = compileTheme({ shape: { radiusPx: 0, borderWidthPx: 0, shadowLevel: level } });
    assert.equal(theme.vars['--pp-shadow'], SHADOW_SCALE[level]);
    assert.ok(theme.vars['--pp-shadow'].includes('rgba('));
  }
  assert.equal(compileTheme({ shape: { radiusPx: 0, borderWidthPx: 0, shadowLevel: 0 } }).vars['--pp-shadow'], 'none');
});

test('a fractional radius is written without floating-point noise', () => {
  const theme = compileTheme({ shape: { radiusPx: 0.5, borderWidthPx: 0.5, shadowLevel: 0 } });
  assert.equal(theme.vars['--pp-radius'], '0.5px');
  assert.equal(theme.vars['--pp-border-width'], '0.5px');
});

test('the transition duration honours the §10 motion budget', () => {
  const theme = compileTheme({});
  assert.equal(theme.vars['--pp-transition-ms'], `${TRANSITION_MS}ms`);
  assert.ok(TRANSITION_MS <= MAX_TRANSITION_MS);
});

// ------------------------------------------------------------- determinism

test('the same brand compiles to byte-identical CSS twice', () => {
  const brand = buildBrandSystem({ colors: PALETTE, css: CSS, sourceUrl: 'https://acme.example/' }, { clock, idMinter: minter() });
  const first = compileTheme(brand);
  const second = compileTheme(brand);
  assert.equal(first.css, second.css);
  assert.deepEqual(first.vars, second.vars);
  // And rebuilding the brand from the same inputs compiles the same bytes.
  const rebuilt = buildBrandSystem({ colors: PALETTE, css: CSS, sourceUrl: 'https://acme.example/' }, { clock, idMinter: minter() });
  assert.equal(compileTheme(rebuilt).css, first.css);
});

test('compileTheme takes nothing from a clock or a random source', () => {
  const brand = buildBrandSystem({ colors: PALETTE, css: CSS }, { clock: () => '2020-01-01T00:00:00.000Z', idMinter: minter() });
  const other = buildBrandSystem({ colors: PALETTE, css: CSS }, { clock: () => '2031-12-31T23:59:59.000Z', idMinter: minter() });
  assert.equal(compileTheme(brand).css, compileTheme(other).css);
  assert.equal(brand.id, other.id, 'the brand id is content-derived, not time-derived');
  assert.notEqual(brand.capturedAt, other.capturedAt);
});

// ------------------------------------------------------------ brand assembly

test('buildBrandSystem passes validateBrand with zero errors', () => {
  const brand = buildBrandSystem({
    sourceUrl: 'https://acme.example/',
    colors: PALETTE,
    css: CSS,
    doc: el('header', { class: 'site-header' }, [
      el('a', { class: 'site-logo' }, [el('svg', { class: 'site-logo', viewBox: '0 0 120 40' }, [el('path', { fill: '#0b3fbe', d: 'M0 0h120v40z' }, [])])]),
    ]),
    images: [],
    manualOverrides: ['colors.primary'],
  }, { clock, idMinter: minter() });

  const errors = [];
  validateBrand(brand, 'brand', errors);
  assert.deepEqual(errors, []);
  assert.equal(brand.capturedAt, '2026-05-01T12:00:00.000Z');
  assert.match(brand.id, /^br_[0-9a-f]{12}$/);
  assert.deepEqual(brand.manualOverrides, ['colors.primary']);
});

test('an empty brand is still contract-valid', () => {
  const errors = [];
  const brand = buildBrandSystem({}, { clock, idMinter: minter() });
  validateBrand(brand, 'brand', errors);
  assert.deepEqual(errors, []);
  assert.deepEqual(brand.colors, []);
  assert.deepEqual(brand.faces, []);
  assert.deepEqual(brand.logos, []);
  assert.deepEqual(brand.shape, { radiusPx: 0, borderWidthPx: 0, shadowLevel: 0 });
  assert.deepEqual(brand.imagery, { treatment: 'unknown', saturationBias: 0 });
  assert.equal(brand.sourceUrl, null);
  for (const value of Object.values(brand.confidence)) assert.equal(value, 0);
});

test('buildBrandSystem refuses to run without an injected clock and minter (§5)', () => {
  assert.throws(() => buildBrandSystem({}, { idMinter: minter() }), /clock/);
  assert.throws(() => buildBrandSystem({}, { clock }), /idMinter/);
  assert.throws(() => buildBrandSystem({}), /clock/);
});

test('an inverse variant is generated for a monochrome logo and not otherwise', () => {
  const mono = el('header', {}, [el('a', { class: 'logo' }, [
    el('svg', { class: 'logo', viewBox: '0 0 100 40' }, [el('path', { fill: '#111111', d: 'M0 0' }, [])]),
  ])]);
  const brandMono = buildBrandSystem({ doc: mono }, { clock, idMinter: minter() });
  assert.equal(brandMono.logos.length, 2);
  assert.equal(brandMono.logos[1].variant, 'inverse');

  const duo = el('header', {}, [el('a', { class: 'logo' }, [
    el('svg', { class: 'logo', viewBox: '0 0 100 40' }, [
      el('path', { fill: '#e11d48', d: 'M0 0' }, []),
      el('path', { fill: '#1d4ed8', d: 'M0 0' }, []),
    ]),
  ])]);
  const brandDuo = buildBrandSystem({ doc: duo }, { clock, idMinter: minter() });
  assert.equal(brandDuo.logos.length, 1);
  assert.equal(brandDuo.logos[0].needsInverseAsset, true);

  // The generation can be turned off explicitly.
  assert.equal(buildBrandSystem({ doc: mono, generateInverse: false }, { clock, idMinter: minter() }).logos.length, 1);
});

test('confidence is computed per group, and colour confidence belongs to L4', () => {
  const brand = buildBrandSystem({ colors: PALETTE, css: CSS, images: [] }, { clock, idMinter: minter() });
  // L4 owns colour confidence; unsupplied means zero, never an invented number.
  assert.equal(brand.confidence.colors, 0);
  assert.ok(brand.confidence.faces > 0 && brand.confidence.faces <= 1);
  assert.ok(brand.confidence.shape > 0 && brand.confidence.shape <= 1);
  assert.equal(brand.confidence.imagery, 0, 'no images means no imagery evidence');

  const supplied = buildBrandSystem({ colors: PALETTE, css: CSS, confidence: { colors: 0.83 } }, { clock, idMinter: minter() });
  assert.equal(supplied.confidence.colors, 0.83);
  for (const key of ['colors', 'faces', 'logos', 'shape', 'imagery']) {
    assert.ok(supplied.confidence[key] >= 0 && supplied.confidence[key] <= 1, key);
  }
});

test('finished parts are accepted as readily as raw inputs', () => {
  const faces = detectFaces(null, CSS, {});
  const shape = detectShape(CSS);
  const imagery = classifyImagery([]);
  const logos = extractLogos(null, [], { idMinter: minter() });
  const brand = buildBrandSystem({
    colors: PALETTE, faces, logos, shape,
    imagery: { treatment: imagery.treatment, saturationBias: imagery.saturationBias },
    confidence: { colors: 0.7, faces: 0.6, logos: 0.5, shape: 0.4, imagery: 0.3 },
  }, { clock, idMinter: minter() });
  const errors = [];
  validateBrand(brand, 'brand', errors);
  assert.deepEqual(errors, []);
  assert.deepEqual(brand.confidence, { colors: 0.7, faces: 0.6, logos: 0.5, shape: 0.4, imagery: 0.3 });
});

test('a malformed part is coerced into contract shape rather than escaping into the artifact', () => {
  const brand = buildBrandSystem({
    faces: [{ family: 'Odd', role: 'headline', weightsSeen: ['x'], embeddable: 'yes', metricDelta: { capHeight: 'a' } }],
    logos: [{ id: 'lg_1', kind: 'gif', data: 5, variant: 'hero', intrinsic: {}, hasTransparency: 'maybe' }],
    shape: { radiusPx: 'x', borderWidthPx: null, shadowLevel: 9 },
    imagery: { treatment: 'painterly', saturationBias: 'lots' },
  }, { clock, idMinter: minter() });
  const errors = [];
  validateBrand(brand, 'brand', errors);
  assert.deepEqual(errors, []);
  assert.equal(brand.faces[0].role, 'body');
  assert.equal(brand.faces[0].embeddable, false);
  assert.deepEqual(brand.faces[0].weightsSeen, [400]);
  assert.equal(brand.faces[0].metricDelta, null);
  assert.equal(brand.logos[0].kind, 'raster');
  assert.equal(brand.logos[0].variant, 'primary');
  assert.deepEqual(brand.logos[0].intrinsic, { w: 0, h: 0 });
  assert.deepEqual(brand.shape, { radiusPx: 0, borderWidthPx: 0, shadowLevel: 0 });
  assert.deepEqual(brand.imagery, { treatment: 'unknown', saturationBias: 0 });
});

test('normalizers keep the lane extensions they were given', () => {
  const face = normalizeFace({ family: 'A', role: 'display', fallbackStack: ['A'], weightsSeen: [500], metricDelta: { capHeight: 1, xHeight: 1, avgAdvance: 1 }, embeddable: false, confidence: 0.9 });
  assert.equal(face.confidence, 0.9);
  const logo = normalizeLogo({ id: 'x', kind: 'svg', data: '<svg/>', variant: 'mark', intrinsic: { w: 1, h: 1 }, hasTransparency: true, monochrome: true });
  assert.equal(logo.monochrome, true);
});

test('css may be given as a string, a list, or href-tagged records', () => {
  assert.equal(joinCss('a{}'), 'a{}');
  assert.equal(joinCss(['a{}', 'b{}']), 'a{}\nb{}');
  assert.equal(joinCss([{ text: 'a{}' }, { css: 'b{}' }]), 'a{}\nb{}');
  assert.equal(joinCss(undefined), '');
  const fromList = buildBrandSystem({ css: ['.card{border-radius:4px}', '.panel{border-radius:4px}'] }, { clock, idMinter: minter() });
  assert.equal(fromList.shape.radiusPx, 4);
});

test('the lane surface re-exports everything API.md declares', () => {
  for (const fn of [detectFaces, extractLogos, inverseVariant, detectShape, classifyImagery, buildBrandSystem, compileTheme]) {
    assert.equal(typeof fn, 'function');
  }
});

test('the imagery classifier is reachable through the lane surface', () => {
  // `API.md` publishes only `color.js` and `theme.js` from the brand lane, so a
  // classifier that can only be reached through `imagery.js` can never run —
  // imagery comes back `unknown` at zero confidence and the §7 review gate holds
  // the brand. These are the exports that close that.
  for (const fn of [sampleFromPng, classifyImage, normalizeSample, toImageSamples]) {
    assert.equal(typeof fn, 'function');
  }
  const png = encodePng(vividArtwork(64, 64));
  const sample = sampleFromPng(png, { id: 'hero', role: 'hero' });
  assert.equal(sample.width, 64);
  const result = classifyImagery([sample]);
  assert.notEqual(result.treatment, 'unknown');
  assert.ok(result.confidence > 0, 'a decoded image produces real confidence');
});

test('buildBrandSystem accepts raw PNG asset bytes as imagery evidence', () => {
  // L3 hands the studio `{name, bytes, mime}` records; requiring decoded pixels
  // here is how imagery silently stayed `unknown`.
  const bytes = encodePng(vividArtwork(64, 64));
  const brand = buildBrandSystem({ colors: PALETTE, images: [{ name: '/assets/hero.png', bytes }] }, { clock, idMinter: minter() });
  assert.notEqual(brand.imagery.treatment, 'unknown');
  assert.ok(brand.confidence.imagery > 0);
  const errors = [];
  validateBrand(brand, 'brand', errors);
  assert.deepEqual(errors, []);

  // Formats this build cannot decode are skipped, not guessed at or thrown on.
  assert.deepEqual(toImageSamples([{ name: 'a.jpg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]) }]), []);
  assert.deepEqual(toImageSamples(undefined), []);
  assert.equal(toImageSamples([{ width: 2, height: 2, data: new Uint8Array(16) }]).length, 1);
});

test('buildBrandSystem gives the primary role to the identity, not the og:image', () => {
  // The §20 critic's F10: `logoFor(brand)` defaults to `primary`, so every
  // layout rendered the og:image hero instead of the logo.
  const doc = el('html', {}, [
    el('head', {}, [
      el('script', { type: 'application/ld+json' }, [{ type: 'text', text: JSON.stringify({ '@type': 'Organization', logo: '/assets/logo.svg' }) }]),
      el('link', { rel: 'icon', href: '/assets/mark.svg' }, []),
      el('meta', { property: 'og:image', content: '/assets/hero-plant.png' }, []),
    ]),
    el('body', {}, [
      el('header', { class: 'site-header', role: 'banner' }, [
        el('a', { class: 'site-header__logo', href: '/' }, [el('img', { src: '/assets/logo.svg', alt: 'Northwind Industrial' }, [])]),
      ]),
    ]),
  ]);
  const assets = [
    { name: '/assets/logo.svg', bytes: new TextEncoder().encode('<svg viewBox="0 0 240 48"><path fill="#0b1220" d="M0 0h240v48z"/></svg>'), mime: 'image/svg+xml' },
    { name: '/assets/mark.svg', bytes: new TextEncoder().encode('<svg viewBox="0 0 48 48"><rect width="48" height="48" fill="#0b1220"/></svg>'), mime: 'image/svg+xml' },
    { name: '/assets/hero-plant.png', bytes: encodePng(vividArtwork(320, 180)), mime: 'image/png' },
  ];

  const brand = buildBrandSystem({ colors: PALETTE, doc, assets }, { clock, idMinter: minter() });
  const primary = brand.logos.filter((l) => l.variant === 'primary');
  assert.equal(primary.length, 1);
  assert.deepEqual(primary[0].intrinsic, { w: 240, h: 48 });
  assert.equal(primary[0].declared, true);
  assert.equal(brand.logos.some((l) => l.intrinsic.w === 320), false, 'the hero is not a brand asset');
  assert.deepEqual(declaredLogoUrls(doc), ['/assets/logo.svg']);
  // A schema.org declaration is the strongest agreement signal there is.
  assert.ok(brand.confidence.logos > 0.8, String(brand.confidence.logos));
  const errors = [];
  validateBrand(brand, 'brand', errors);
  assert.deepEqual(errors, []);
});

test('selection and identity scoring are reachable for the studio inspector', () => {
  assert.equal(typeof selectLogos, 'function');
  assert.equal(typeof identityScore, 'function');
  assert.equal(typeof logosConfidence, 'function');
});

/** Flat saturated artwork, as RGBA — decisive for the imagery classifier. */
function vividArtwork(w, h) {
  const palette = [[230, 57, 70], [29, 53, 87], [244, 162, 97], [42, 157, 143]];
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = palette[(Math.floor((x * 2) / w) + 2 * Math.floor((y * 2) / h)) % 4];
      const i = (y * w + x) * 4;
      data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}
