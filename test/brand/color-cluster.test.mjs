/**
 * §7 collection, the area model, and clustering in OKLab.
 *
 * The load-bearing claim here is the one §7 states in a sentence: clusters are
 * weighted **by rendered area, not by occurrence count** — "a color used once
 * across a full-bleed hero matters more than a border used two hundred times".
 * That is asserted directly, in the shape §7 describes it.
 *
 * Determinism (§5) is the other claim: the same pixels and the same seed give
 * the same clusters, and a different seed may reorder but must not change the
 * quality of the partition.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { BREAKPOINTS } from '../../src/core/contracts.js';
import { AFM_TABLES, UNITS_PER_EM, measureText } from '../../src/core/text-metrics.js';
import {
  quantize, chooseK, kmeansOklab, silhouetteScore, toSamples,
  collectColors, collectFromComputedStyles, collectFromCss, collectFromPixels,
  normalizeSampleWeights, decodePixels, textInkArea,
  scanCssDeclarations, colorTokensIn, parseCssColor, compositeOver,
  maskCssLiterals, isCustomProperty, buildCustomPropertyEnv, resolveCssVars,
  MAX_VAR_DEPTH, ASSUMED_LINE_AREA, DECLARED_TOKEN_AREA,
  SOURCE_WEIGHTS, INK_DUTY_CYCLE, REFERENCE_VIEWPORT_AREA, ASSUMED_CARD_FRACTION,
  ASSUMED_FONT_SIZE_PX, ASSUMED_BORDER_PX, HELVETICA_STD_VW,
  inGamut, deltaEok, hexToOklab, rgbToHex, hexToOklch, oklchToHex,
  extractPalette, paletteContrastReport, contrastRatio,
} from '../../src/brand/color.js';
import { syntheticPixels, KNOWN_K_CENTERS } from '../fixtures/brand/palettes.mjs';
import { assetBytes, CORPUS_BRAND } from '../fixtures/corpus/index.mjs';

/* ------------------------------------------------------- the area model */

test('the ink duty cycle is derived from published metrics, not chosen', () => {
  // Adobe's Core-14 Helvetica AFM declares StdVW 88 (stem width, per mille);
  // the advance of `n` is 556, from the same published table.
  assert.equal(HELVETICA_STD_VW, 88);
  const nAdvance = AFM_TABLES.Helvetica.widths['n'.charCodeAt(0) - 32];
  assert.equal(nAdvance, 556);
  assert.equal(INK_DUTY_CYCLE, (2 * 88) / 556);
  assert.ok(INK_DUTY_CYCLE > 0.31 && INK_DUTY_CYCLE < 0.32);
});

test('the reference viewport is the lg breakpoint, not an invented number', () => {
  const lg = BREAKPOINTS[BREAKPOINTS.length - 1];
  assert.equal(lg.id, 'lg');
  assert.equal(REFERENCE_VIEWPORT_AREA, lg.width * lg.height);
  assert.equal(REFERENCE_VIEWPORT_AREA, 1600 * 900);
});

test('text ink area is the x-height band times the duty cycle', () => {
  const text = 'The quick brown fox';
  const fontSizePx = 20;
  const expected = measureText(text, { family: 'Helvetica', fontSizePx })
    * (AFM_TABLES.Helvetica.xHeight / UNITS_PER_EM * fontSizePx)
    * INK_DUTY_CYCLE;
  const got = textInkArea(600, 24, { text, fontSizePx, fontFamily: 'Helvetica' });
  assert.ok(Math.abs(got - expected) < 1e-9, `${got} vs ${expected}`);
  // Text always paints far less than its box.
  assert.ok(got < 600 * 24 * 0.5, 'a text run does not paint its whole line box');
  // With no text supplied, the box is modelled as full lines of text.
  const noText = textInkArea(600, 72, { fontSizePx, fontFamily: 'Helvetica' });
  assert.ok(noText > 0 && noText < 600 * 72);
  assert.ok(textInkArea(600, 72, { fontSizePx }) > textInkArea(600, 24, { fontSizePx }),
    'three lines of text paint more than one');
});

test('a full-bleed hero colour outranks a border used two hundred times', () => {
  // §7, stated literally: one full-bleed hero fill against two hundred hairline
  // borders. Occurrence counting would put the border 200:1 ahead.
  /** @type {any[]} */
  const entries = [{ styles: { backgroundColor: '#3b2eea' }, rect: { w: 1600, h: 900 } }];
  for (let i = 0; i < 200; i++) {
    entries.push({ styles: { borderColor: '#c9c9c9' }, rect: { w: 240, h: 120 }, borderWidthPx: 1 });
  }
  const samples = normalizeSampleWeights(collectFromComputedStyles(entries));
  const hero = samples.filter((s) => s.hex === '#3b2eea').reduce((a, s) => a + s.weight, 0);
  const border = samples.filter((s) => s.hex === '#c9c9c9').reduce((a, s) => a + s.weight, 0);
  assert.equal(samples.filter((s) => s.hex === '#c9c9c9').length, 200, 'the border really does occur 200 times');
  assert.ok(hero > border, `hero ${hero} must outrank border ${border}`);
  assert.ok(hero / border > 5, `and by a wide margin, not a hair (${(hero / border).toFixed(1)}×)`);
  // The clusters agree.
  const clusters = quantize(samples, { k: 2, seed: 'area' });
  assert.equal(clusters[0].hex, '#3b2eea', 'the heaviest cluster is the hero colour');
});

test('one large region outranks the same colour spread over many tiny ones', () => {
  const big = collectFromComputedStyles([{ styles: { backgroundColor: '#ff0000' }, rect: { w: 800, h: 600 } }]);
  const many = collectFromComputedStyles(
    Array.from({ length: 500 }, () => ({ styles: { backgroundColor: '#00ff00' }, rect: { w: 20, h: 20 } })),
  );
  const samples = normalizeSampleWeights(big.concat(many));
  const red = samples.filter((s) => s.hex === '#ff0000').reduce((a, s) => a + s.weight, 0);
  const green = samples.filter((s) => s.hex === '#00ff00').reduce((a, s) => a + s.weight, 0);
  assert.equal(800 * 600, 480000);
  assert.equal(500 * 20 * 20, 200000);
  assert.ok(red > green, `${red} vs ${green}: area, not count, decides`);
  assert.ok(Math.abs(red / green - 480000 / 200000) < 1e-9, 'the ratio is exactly the area ratio');
});

test('alpha reduces painted area and composites what the eye sees', () => {
  const opaque = collectFromComputedStyles([{ styles: { backgroundColor: 'rgba(0,0,0,1)' }, rect: { w: 100, h: 100 } }]);
  const half = collectFromComputedStyles([{ styles: { backgroundColor: 'rgba(0,0,0,0.5)' }, rect: { w: 100, h: 100 } }]);
  assert.equal(opaque[0].area, 10000);
  assert.equal(half[0].area, 5000);
  assert.equal(opaque[0].hex, '#000000');
  assert.equal(half[0].hex, '#808080', 'half-alpha black over white is mid grey');
  // Fully transparent contributes nothing at all.
  assert.equal(collectFromComputedStyles([{ styles: { backgroundColor: 'transparent' }, rect: { w: 100, h: 100 } }]).length, 0);
  assert.deepEqual(compositeOver({ rgb: [0, 0, 0], alpha: 0.25, hex: '' }, [255, 255, 255]).map(Math.round), [191, 191, 191]);
});

test('borders contribute their ring, not their box', () => {
  const [sample] = collectFromComputedStyles([
    { styles: { borderColor: '#123456' }, rect: { w: 200, h: 100 }, borderWidthPx: 2 },
  ]);
  assert.equal(sample.area, 2 * (200 + 100) * 2);
  assert.ok(sample.area < 200 * 100, 'a ring is smaller than its box');
  // Without a measured width, the least generous assumption applies.
  const [thin] = collectFromComputedStyles([{ styles: { borderColor: '#123456' }, rect: { w: 200, h: 100 } }]);
  assert.equal(thin.area, 2 * (200 + 100) * ASSUMED_BORDER_PX);
});

test('gradient stops share the fill they paint', () => {
  const samples = collectFromComputedStyles([
    { styles: { backgroundImage: 'linear-gradient(90deg, #ff0000 0%, #0000ff 100%)' }, rect: { w: 100, h: 100 } },
  ]);
  assert.equal(samples.length, 2);
  assert.equal(samples[0].area + samples[1].area, 10000);
  assert.deepEqual(samples.map((s) => s.hex).sort(), ['#0000ff', '#ff0000']);
});

/* --------------------------------------------------------- raw CSS path */

test('raw CSS declarations are found with their selector and property', () => {
  const css = `
    /* a comment { with braces } */
    :root { --brand: #3b2eea; }
    body { background: #ffffff; color: #0b1220 }
    @media (min-width: 40em) { .card { background-color: #f4f4f5; border-color: rgb(200 200 210) } }
    @keyframes spin { from { background: #ff0000 } }
    @font-face { font-family: X; src: local(X) }
  `;
  const decls = scanCssDeclarations(css);
  const find = (sel, prop) => decls.find((d) => d.selector === sel && d.prop === prop);
  assert.ok(find('body', 'background'));
  assert.ok(find('body', 'color'));
  assert.ok(find('.card', 'background-color'));
  assert.equal(find('.card', 'background-color').atRules[0], '@media (min-width: 40em)');
  assert.ok(decls.some((d) => d.atRules.some((a) => a.startsWith('@keyframes'))));
  // The comment's braces did not derail the scanner.
  assert.ok(!decls.some((d) => d.value.includes('with braces')));
});

test('the assumed CSS footprints are the documented ones and are marked estimated', () => {
  const ground = collectFromCss('body { background: #ffffff }');
  assert.equal(ground.length, 1);
  assert.equal(ground[0].area, REFERENCE_VIEWPORT_AREA);
  assert.equal(ground[0].estimated, true, 'an assumed footprint must say so');
  const card = collectFromCss('.card { background: #f4f4f5 }');
  assert.equal(card[0].area, REFERENCE_VIEWPORT_AREA * ASSUMED_CARD_FRACTION);
  assert.ok(card[0].area < ground[0].area, 'a card is smaller than the page');
  const text = collectFromCss('.copy { color: #333333 }');
  assert.ok(text[0].area > 0 && text[0].area < card[0].area, 'text ink is smaller than a card fill');
  // Non-painting at-rules contribute nothing.
  assert.equal(collectFromCss('@keyframes x { from { background: #ff0000 } }').length, 0);
  assert.equal(collectFromCss('@font-face { font-family: X }').length, 0);
  // Unresolvable values are skipped rather than guessed.
  assert.equal(collectFromCss('.x { color: var(--y) } .z { color: currentColor }').length, 0);
});

test('a colour name inside a custom-property name is never mistaken for a colour', () => {
  // The §22.1 defect this test exists for. `[a-zA-Z]{3,20}` with no boundary
  // guard matched `navy` inside `var(--nw-navy)`, `parseCssColor` turned it
  // into HTML navy `#000080`, and the extracted palette was a colour the site
  // does not use — with the area weight of a full-bleed page ground.
  //
  // The earlier version of this assertion used `var(--y)`, which contains no
  // colour keyword and so could never have caught it. Every name below does.
  const NAMES = [
    '--nw-navy', '--brand-orange', '--text-gold', '--accent-teal',
    '--tomato-sauce', '--color-salmon', '--ui-plum', '--bg-linen',
    '--navy', '--orange-500', '--gold', '--silver-border',
  ];
  for (const name of NAMES) {
    assert.deepEqual(colorTokensIn(`var(${name})`), [],
      `var(${name}) must not yield a colour`);
    assert.equal(collectFromCss(`.x { color: var(${name}) }`).length, 0,
      `${name} must contribute nothing when it is undeclared`);
    assert.equal(collectFromCss(`.x { color: var(${name}) ; background: var(${name}) }`).length, 0);
  }
  // A colour keyword that really is a whole identifier still resolves.
  assert.equal(colorTokensIn('navy')[0].hex, '#000080');
  assert.equal(colorTokensIn('1px solid red')[0].hex, '#ff0000');
  assert.deepEqual(colorTokensIn('linear-gradient(90deg, navy, orange)').map((t) => t.hex),
    ['#000080', '#ffa500']);
  assert.equal(colorTokensIn('  tomato  ')[0].hex, '#ff6347');
  // …and a keyword buried in a string or a url() does not.
  assert.deepEqual(colorTokensIn('url("gold-bar.png")'), []);
  assert.deepEqual(colorTokensIn("url('/img/navy-hero.jpg')"), []);
  assert.deepEqual(colorTokensIn('url(#navy-gradient)'), []);
  assert.deepEqual(colorTokensIn('"tomato"'), []);
  assert.deepEqual(colorTokensIn('--text-gold'), []);
  assert.deepEqual(colorTokensIn('gold-standard'), []);
  assert.deepEqual(colorTokensIn('standard-gold'), []);
  assert.equal(maskCssLiterals('url("gold.png") navy').trim().endsWith('navy'), true);
});

test('the palette is read from custom-property declarations, where sites keep it', () => {
  // A modern stylesheet declares its brand in `:root` and paints with `var()`.
  // Ignoring the declaration throws away the only place the real colour appears.
  const css = ':root { --nw-navy: #0F2A47; --nw-orange: #E8622C; } '
    + '.header { background: var(--nw-navy) } .cta { color: var(--nw-orange) }';
  const samples = collectFromCss(css);
  const hexes = samples.map((s) => s.hex).sort();
  assert.deepEqual(hexes, ['#0f2a47', '#e8622c'], 'the declared values, not the names');
  assert.ok(!hexes.includes('#000080') && !hexes.includes('#ffa500'), 'nothing fabricated');
  // A referenced token is weighted by where it is painted, not by its
  // declaration: a page ground carries far more area than a text colour.
  const ground = samples.find((s) => s.hex === '#0f2a47');
  const text = samples.find((s) => s.hex === '#e8622c');
  assert.ok(ground.area > text.area * 10, `${ground.area} vs ${text.area}`);
  assert.equal(samples.filter((s) => s.hex === '#0f2a47').length, 1, 'and is not counted twice');
});

test('var() resolves through chains and fallbacks, and refuses what it cannot see', () => {
  const env = buildCustomPropertyEnv(scanCssDeclarations(
    ':root { --base: #0F2A47; --alias: var(--base); --deep: var(--alias) }',
  ));
  assert.equal(resolveCssVars('var(--base)', env), '#0F2A47');
  assert.equal(resolveCssVars('var(--deep)', env), '#0F2A47', 'chains resolve');
  assert.equal(resolveCssVars('1px solid var(--base)', env), '1px solid #0F2A47');
  assert.equal(resolveCssVars('linear-gradient(var(--base), var(--base))', env),
    'linear-gradient(#0F2A47, #0F2A47)');
  // Undefined with no fallback is invalid at computed-value time in CSS too.
  assert.equal(resolveCssVars('var(--missing)', env), null);
  assert.equal(resolveCssVars('var(--missing, #ff0000)', env), '#ff0000', 'fallbacks are honoured');
  assert.equal(resolveCssVars('var(--missing, var(--base))', env), '#0F2A47');
  assert.equal(resolveCssVars('#0F2A47', env), '#0F2A47', 'a value with no var is returned as is');
  assert.equal(resolveCssVars('var(--base', env), null, 'an unbalanced var is not a colour');
  assert.equal(resolveCssVars('var(notaname)', env), null);
  // A self-referential token terminates rather than spinning.
  const cyclic = buildCustomPropertyEnv(scanCssDeclarations(':root{--a:var(--b);--b:var(--a)}'));
  assert.equal(resolveCssVars('var(--a)', cyclic), null);
  assert.equal(collectFromCss(':root{--a:var(--b);--b:var(--a)} .x{color:var(--a)}').length, 0);
  assert.ok(MAX_VAR_DEPTH >= 8);
});

test('an unconditional custom property beats one inside an at-rule', () => {
  // A `prefers-color-scheme: dark` override must not become the default palette.
  const env = buildCustomPropertyEnv(scanCssDeclarations(
    ':root { --ground: #FFFFFF } @media (prefers-color-scheme: dark) { :root { --ground: #000000 } }',
  ));
  assert.equal(env.get('--ground').value, '#FFFFFF');
  // Declared after the at-rule, unconditionally, it still wins.
  const env2 = buildCustomPropertyEnv(scanCssDeclarations(
    '@media (x) { :root { --g: #000000 } } :root { --g: #FFFFFF }',
  ));
  assert.equal(env2.get('--g').value, '#FFFFFF');
  // Two unconditional declarations: the last wins, as CSS itself resolves it.
  const env3 = buildCustomPropertyEnv(scanCssDeclarations(':root{--g:#111111} .a{--g:#222222}'));
  assert.equal(env3.get('--g').value, '#222222');
  assert.equal(isCustomProperty('--x'), true);
  assert.equal(isCustomProperty('color'), false);
});

test('a declared token nothing paints with still counts, at the weakest footprint', () => {
  const samples = collectFromCss(':root { --unused-teal: #0E7C86 }');
  assert.equal(samples.length, 1, 'a declared token is the brand stating its palette');
  assert.equal(samples[0].hex, '#0e7c86');
  assert.equal(samples[0].area, DECLARED_TOKEN_AREA);
  assert.equal(samples[0].area, ASSUMED_LINE_AREA, 'the smallest footprint in the model');
  assert.equal(samples[0].estimated, true);
  // A painted fill of the same colour outweighs it by orders of magnitude.
  const painted = collectFromCss(':root{--a:#0E7C86} body{background:var(--a)}');
  assert.equal(painted.length, 1);
  assert.ok(painted[0].area > samples[0].area * 100);
});

/* ------------------------------------------------------------- pixels */

test('pixels decode from every container the ingest lane can produce', () => {
  assert.equal(decodePixels(new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128])).length, 2);
  assert.equal(decodePixels(new Uint8Array([255, 0, 0, 0, 255, 0])).length, 2, 'RGB when not a multiple of four');
  assert.deepEqual(decodePixels([[1, 2, 3]])[0].rgb, [1, 2, 3]);
  assert.deepEqual(decodePixels(['#ff0000'])[0].rgb, [255, 0, 0]);
  assert.deepEqual(decodePixels([{ hex: '#00ff00', weight: 3 }])[0].weight, 3);
  assert.deepEqual(decodePixels([{ rgb: [1, 2, 3], alpha: 0.5 }])[0].alpha, 0.5);
  assert.equal(decodePixels(null).length, 0);
  assert.equal(decodePixels('nonsense').length, 0);
  // Transparent pixels paint nothing.
  const rgba = new Uint8Array([255, 0, 0, 0, 0, 0, 255, 255]);
  const samples = collectFromPixels(rgba);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].hex, '#0000ff');
});

test('pixels are histogrammed exactly, with no aliasing against periodic patterns', () => {
  // A one-in-four red pattern. This is the case a fixed-stride subsample gets
  // catastrophically wrong — stride 40 against period 4 returns 100% red — and
  // it is why collection histograms rather than samples.
  const px = [];
  for (let i = 0; i < 40000; i++) px.push(i % 4 === 0 ? '#ff0000' : '#0000ff');
  const samples = collectFromPixels(px);
  assert.equal(samples.length, 2, 'two colours, two bins');
  const red = samples.filter((s) => s.hex === '#ff0000').reduce((a, s) => a + s.area, 0);
  const blue = samples.filter((s) => s.hex === '#0000ff').reduce((a, s) => a + s.area, 0);
  assert.equal(red / (red + blue), 0.25, 'the exact painted share, not an estimate');
  assert.equal(red + blue, 40000, 'every pixel is counted');
  // A checkerboard, the other classic aliasing trap.
  const checker = [];
  for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) checker.push((x + y) % 2 ? '#000000' : '#ffffff');
  const cs = collectFromPixels(checker);
  assert.equal(cs.length, 2);
  assert.equal(cs[0].area, cs[1].area, 'a checkerboard is exactly half and half');
  // Deterministic, and bounded when a photograph has thousands of distinct bins.
  assert.deepEqual(collectFromPixels(px).map((s) => s.hex), samples.map((s) => s.hex));
  const many = [];
  for (let i = 0; i < 60000; i++) many.push([i % 256, (i >> 8) % 256, (i >> 4) % 256]);
  const capped = collectFromPixels(many, { maxSamples: 500 });
  assert.ok(capped.length <= 500, `bounded to ${capped.length}`);
  assert.deepEqual(capped.map((s) => s.hex), collectFromPixels(many, { maxSamples: 500 }).map((s) => s.hex));
});

/* --------------------------------------------------- source combination */

test('sources are normalised within themselves and combined by evidential weight', () => {
  const samples = normalizeSampleWeights([
    ...collectFromComputedStyles([{ styles: { backgroundColor: '#ff0000' }, rect: { w: 10, h: 10 } }]),
    ...collectFromCss('body { background: #00ff00 }'),
    ...collectFromPixels(['#0000ff', '#0000ff'], { origin: 'image' }),
    ...collectFromPixels(['#ffff00'], { origin: 'logo' }),
  ]);
  const total = samples.reduce((a, s) => a + s.weight, 0);
  assert.ok(Math.abs(total - 1) < 1e-12, `weights must sum to 1, got ${total}`);
  const by = (origin) => samples.filter((s) => s.origin === origin).reduce((a, s) => a + s.weight, 0);
  const present = SOURCE_WEIGHTS.computed + SOURCE_WEIGHTS.css + SOURCE_WEIGHTS.image + SOURCE_WEIGHTS.logo;
  assert.ok(Math.abs(by('computed') - SOURCE_WEIGHTS.computed / present) < 1e-12);
  assert.ok(Math.abs(by('css') - SOURCE_WEIGHTS.css / present) < 1e-12);
  // A tiny computed rect still outweighs a whole stylesheet, because computed
  // styles are what the browser actually painted.
  assert.ok(by('computed') > by('css'));
  assert.ok(SOURCE_WEIGHTS.computed > SOURCE_WEIGHTS.image);
  assert.ok(SOURCE_WEIGHTS.image > SOURCE_WEIGHTS.logo);
  assert.ok(SOURCE_WEIGHTS.logo > SOURCE_WEIGHTS.css);
});

test('missing sources renormalise rather than leaving weight unassigned', () => {
  const only = normalizeSampleWeights(collectFromCss('body { background: #00ff00 }'));
  assert.ok(Math.abs(only.reduce((a, s) => a + s.weight, 0) - 1) < 1e-12);
  assert.equal(normalizeSampleWeights([]).length, 0);
});

/* ---------------------------------------------------------- clustering */

test('the same pixels and the same seed produce the same clusters', () => {
  const px = syntheticPixels(KNOWN_K_CENTERS[4], { perCluster: 90, jitter: 5, seed: 'determinism' });
  const a = quantize(px, { k: 4, seed: 'brand/kmeans-test' });
  const b = quantize(px, { k: 4, seed: 'brand/kmeans-test' });
  assert.deepEqual(a.map((c) => [c.hex, c.weight, c.count]), b.map((c) => [c.hex, c.weight, c.count]));
  // And again through the full auto-k path.
  assert.deepEqual(
    quantize(px, { seed: 's' }).map((c) => c.hex),
    quantize(px, { seed: 's' }).map((c) => c.hex),
  );
});

test('a different seed may reorder but must not change the partition quality', () => {
  const px = syntheticPixels(KNOWN_K_CENTERS[5], { perCluster: 90, jitter: 6, seed: 'quality' });
  const samples = toSamples(px);
  /** @type {{hexes: string[], inertia: number, silhouette: number}[]} */
  const runs = [];
  for (const seed of ['one', 'two', 'three', 'pitchproof-v1', 99]) {
    const { clusters, assignment, inertia } = kmeansOklab(samples, { k: 5, seed });
    runs.push({
      hexes: clusters.map((c) => c.hex).sort(),
      inertia,
      silhouette: silhouetteScore(samples, assignment, 5, { seed }),
    });
  }
  const base = runs[0];
  for (const run of runs.slice(1)) {
    // Same partition: every centroid matches one in the reference run.
    for (let i = 0; i < base.hexes.length; i++) {
      const d = deltaEok(hexToOklab(run.hexes[i]), hexToOklab(base.hexes[i]));
      assert.ok(d < 0.02, `centroid ${run.hexes[i]} drifted ${d.toFixed(4)} from ${base.hexes[i]}`);
    }
    // Same quality, to a tolerance far tighter than any structural difference.
    assert.ok(Math.abs(run.inertia - base.inertia) / Math.max(base.inertia, 1e-12) < 0.02,
      `inertia ${run.inertia} vs ${base.inertia}`);
    assert.ok(Math.abs(run.silhouette - base.silhouette) < 0.02,
      `silhouette ${run.silhouette} vs ${base.silhouette}`);
  }
});

test('silhouette k-selection recovers a known number of clusters', () => {
  for (const [k, centers] of Object.entries(KNOWN_K_CENTERS)) {
    const px = syntheticPixels(centers, { perCluster: 80, jitter: 3, seed: `known-${k}` });
    assert.equal(chooseK(px, { seed: 'select' }), Number(k), `should recover k=${k}`);
  }
});

test('silhouette prefers the true partition over a wrong one', () => {
  const px = syntheticPixels(KNOWN_K_CENTERS[4], { perCluster: 80, jitter: 3, seed: 'sil' });
  const samples = toSamples(px);
  const scoreAt = (k) => silhouetteScore(samples, kmeansOklab(samples, { k, seed: 'sil' }).assignment, k, { seed: 'sil' });
  const truth = scoreAt(4);
  assert.ok(truth > scoreAt(3), 'four separated blobs beat three');
  assert.ok(truth > scoreAt(6), 'and beat six');
  assert.ok(truth > 0.7, `well-separated blobs should score high, got ${truth}`);
  assert.equal(silhouetteScore(samples, new Int32Array(samples.length), 1, {}), 0, 'k=1 has no silhouette');
});

test('the k range is honoured and clamped to what the data can support', () => {
  const px = syntheticPixels(KNOWN_K_CENTERS[6], { perCluster: 60, jitter: 3, seed: 'range' });
  for (const range of [[3, 8], [2, 4], [5, 5]]) {
    const k = chooseK(px, { seed: 'r', range });
    assert.ok(k >= range[0] && k <= range[1], `k=${k} outside ${range}`);
  }
  // Fewer distinct colours than k means fewer clusters, not an empty one.
  const two = quantize(['#ff0000', '#ff0000', '#0000ff'], { k: 6, seed: 'clamp' });
  assert.equal(two.length, 2);
  assert.throws(() => quantize([], { seed: 'x' }), /no samples/);
  assert.throws(() => chooseK([], { seed: 'x' }), /no samples/);
});

test('clusters are well formed, ordered by area, and representable', () => {
  const px = syntheticPixels(KNOWN_K_CENTERS[5], { perCluster: 70, jitter: 4, seed: 'shape' });
  const clusters = quantize(px, { seed: 'shape' });
  let total = 0;
  for (let i = 0; i < clusters.length; i++) {
    const c = clusters[i];
    assert.equal(c.index, i, 'indices are dense and ordered');
    assert.match(c.hex, /^#[0-9a-f]{6}$/);
    assert.ok(inGamut(c.oklch), `${c.hex} must be in gamut`);
    assert.equal(oklchToHex(c.oklch), c.hex);
    assert.ok(c.count > 0 && c.weight > 0 && c.spread >= 0);
    assert.ok(Object.keys(c.sourceWeights).length > 0, 'a cluster records where its weight came from');
    if (i > 0) assert.ok(clusters[i - 1].weight >= c.weight - 1e-12, 'ordered by weight, descending');
    total += c.weight;
  }
  assert.ok(Math.abs(total - 1) < 1e-9, `cluster weights sum to ${total}`);
});

test('cluster spread reflects how tight the cluster actually is', () => {
  const tight = quantize(syntheticPixels(['#3b2eea'], { perCluster: 200, jitter: 1, seed: 't' }), { k: 1, seed: 't' });
  const loose = quantize(syntheticPixels(['#3b2eea'], { perCluster: 200, jitter: 30, seed: 'l' }), { k: 1, seed: 'l' });
  assert.ok(tight[0].spread < loose[0].spread, `${tight[0].spread} vs ${loose[0].spread}`);
});

/* --------------------------------------------------------- end to end */

test('the whole pipeline runs from mixed sources and is deterministic', () => {
  const sources = {
    css: 'body{background:#ffffff;color:#0b1220} .cta{background:#3b2eea;color:#fff} .b{border-color:#8b93f4}',
    computed: [
      { styles: { backgroundColor: '#ffffff' }, rect: { w: 1600, h: 900 } },
      { styles: { color: '#0b1220' }, rect: { w: 900, h: 240 }, text: 'A specimen of the prospect’s own copy', fontSizePx: 18 },
      { styles: { backgroundColor: '#3b2eea' }, rect: { w: 260, h: 56 } },
      { styles: { backgroundColor: '#f0728c' }, rect: { w: 480, h: 320 } },
    ],
    images: [{ pixels: syntheticPixels(['#3b2eea', '#ffffff', '#f0728c'], { perCluster: 200, jitter: 6, seed: 'hero' }), area: 640000 }],
    logos: [{ pixels: ['#3b2eea', '#3b2eea', '#ffffff'] }],
  };
  const a = extractPalette(sources, { seed: 'pipeline' });
  const b = extractPalette(sources, { seed: 'pipeline' });
  assert.deepEqual(a.colors, b.colors);
  assert.deepEqual(a.clusters.map((c) => c.hex), b.clusters.map((c) => c.hex));
  assert.equal(a.confidence, b.confidence);
  assert.ok(a.k >= 3 && a.k <= 8, `k=${a.k} must come from the §7 range`);
  assert.deepEqual(a.origins, ['computed', 'css', 'image', 'logo']);
  assert.ok(a.sampleCount > 0);
  assert.equal(a.colors.length, 14);
  assert.throws(() => extractPalette({}), /no colours/);
});

/* ------------------------------------------------- the corpus is the test */

/**
 * Ground truth, read out of the fixture stylesheet by an oracle that shares no
 * code with the collector: every `#rrggbb` literal the file contains.
 * `site.css` uses no shorthand hexes and its only `rgba()` is inside a
 * `box-shadow`, which the area model does not treat as a painted surface.
 * @param {string} css
 * @returns {Set<string>}
 */
function literalHexesIn(css) {
  return new Set((css.match(/#[0-9a-fA-F]{6}\b/g) || []).map((h) => h.toLowerCase()));
}

test('extraction from the corpus yields only colours the corpus actually contains', () => {
  // §22.1 and §18 in one assertion. The brand is declared as custom properties
  // and painted through `var()`; before the fix, `var(--nw-navy)` produced HTML
  // navy `#000080` and `var(--nw-orange)` produced HTML orange `#ffa500`, with
  // page-ground area weight, and the emitted artifact wore colours the client
  // does not use.
  const css = Buffer.from(assetBytes('/assets/site.css')).toString('utf8');
  const literals = literalHexesIn(css);
  assert.ok(literals.size >= 8, `the fixture should declare a real palette, found ${literals.size}`);

  const { samples, origins } = collectColors({ css: [css] });
  assert.deepEqual(origins, ['css']);
  assert.ok(samples.length > 0, 'the stylesheet must yield colours at all');

  const collected = [...new Set(samples.map((s) => s.hex))].sort();
  const invented = collected.filter((h) => !literals.has(h));
  assert.deepEqual(invented, [],
    `these colours are not in the stylesheet: ${invented.join(', ')}`);

  // Every declared brand token is recovered, by value.
  for (const [name, value] of Object.entries(CORPUS_BRAND)) {
    if (typeof value !== 'string' || !value.startsWith('#')) continue;
    assert.ok(collected.includes(value.toLowerCase()),
      `the declared brand colour ${name} (${value}) was not extracted`);
  }

  // And specifically none of the HTML colour names hiding in the token names.
  for (const fabricated of ['#000080', '#ffa500', '#ff6347', '#008080', '#ffd700']) {
    assert.ok(!collected.includes(fabricated), `${fabricated} is fabricated from an identifier`);
  }
});

test('the corpus palette is weighted by where its colours are actually painted', () => {
  // The point of resolving `var()` rather than merely collecting declarations:
  // navy paints the header and the hero, so it must outrank the line colour
  // that only ever draws a hairline — even though both are declared identically
  // in `:root`.
  const css = Buffer.from(assetBytes('/assets/site.css')).toString('utf8');
  const { samples } = collectColors({ css: [css] });
  const areaOf = (hex) => samples.filter((s) => s.hex === hex.toLowerCase())
    .reduce((a, s) => a + s.area, 0);
  assert.ok(areaOf(CORPUS_BRAND.navy) > areaOf(CORPUS_BRAND.line) * 10,
    `navy ${areaOf(CORPUS_BRAND.navy)} must outrank line ${areaOf(CORPUS_BRAND.line)}`);
  assert.ok(areaOf(CORPUS_BRAND.paper) > areaOf(CORPUS_BRAND.steel));
  assert.ok(areaOf(CORPUS_BRAND.orange) > 0, 'the accent is painted somewhere');
});

test('the solved corpus palette wears the prospect\'s brand, not HTML defaults', () => {
  const css = Buffer.from(assetBytes('/assets/site.css')).toString('utf8');
  const literals = literalHexesIn(css);
  const result = extractPalette({ css: [css] }, { seed: 'corpus' });

  for (const token of result.colors) {
    if (token.source !== 'extracted') continue;
    assert.ok(literals.has(token.hex),
      `role ${token.role} was extracted as ${token.hex}, which is not in the stylesheet`);
  }
  const byRole = {};
  for (const t of result.colors) byRole[t.role] = t.hex;
  // The corpus's own description of its brand: a deep navy ground that can
  // carry white text, and a mid-orange accent that cannot.
  assert.ok([CORPUS_BRAND.navy.toLowerCase(), CORPUS_BRAND.navyDeep.toLowerCase()].includes(byRole.primary),
    `primary should be one of the brand navies, got ${byRole.primary}`);
  assert.equal(byRole.accent, CORPUS_BRAND.orange.toLowerCase(), 'the accent is the brand orange');
  assert.equal(byRole.surface, CORPUS_BRAND.paper.toLowerCase(), 'the ground is the brand paper');
  // §7's post-condition still holds on the real thing.
  for (const row of paletteContrastReport(result.colors)) {
    assert.ok(row.ok, `${row.role} on ${row.pair} is ${row.ratio.toFixed(3)}:1`);
  }
  // The corpus notes that #E8622C cannot carry white text at 4.5:1 — so
  // onAccent must not be white, and must have been solved rather than assumed.
  assert.ok(contrastRatio('#ffffff', CORPUS_BRAND.orange) < 4.5,
    'the fixture premise: white on the brand orange fails AA');
  assert.ok(contrastRatio(byRole.onAccent, byRole.accent) >= 4.5);
});
