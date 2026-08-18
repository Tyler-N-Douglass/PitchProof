/**
 * Shape language extraction (§7): CSS value parsing including shorthands and
 * unit conversion, the modal radius and border width, and the shadow tier.
 *
 * The unit conversions are asserted against the CSS Values 4 definitions
 * (1in = 96px, 1pt = 1/72in, 1pc = 12pt, 1cm = 96/2.54px), and the shadow tiers
 * against Material Design's published elevation shadows, so the tiers mean
 * something outside this repository.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseLength, percentageOf, parseCssRules, parseDeclarations, stripCssComments,
  splitTopLevel, splitComponents, parseBorderShorthand, parseBorderWidths,
  parseRadiusValue, representativeRadius, parseBoxShadow, shadowStrength,
  declarationStrength, shadowTier, colorAlpha, looksLikeColor, selectorWeight,
  collectShapeEvidence, detectShape, shapeFromEvidence, shapeConfidence,
  weightedMode, modalShadowTier, rootFontSize,
  SHADOW_TIER_BOUNDS, PILL_PERCENT, PILL_RADIUS_PX, DEFAULT_ROOT_FONT_SIZE_PX,
} from '../../src/brand/shape.js';

// --------------------------------------------------------------- CSS lengths

test('absolute units convert by the CSS Values 4 definitions', () => {
  assert.equal(parseLength('16px'), 16);
  assert.equal(parseLength('1in'), 96);
  assert.equal(parseLength('12pt'), 16);          // 12/72 in = 1/6 in = 16px
  assert.equal(parseLength('1pc'), 16);           // 1pc = 12pt
  assert.equal(parseLength('2.54cm'), 96);
  assert.equal(parseLength('25.4mm'), 96);
  assert.equal(Math.round(parseLength('40q')), 38); // 40Q = 1cm = 96/2.54px
});

test('font-relative units resolve against the supplied context', () => {
  assert.equal(parseLength('1rem'), DEFAULT_ROOT_FONT_SIZE_PX);
  assert.equal(parseLength('1rem', { rootFontSizePx: 10 }), 10);
  assert.equal(parseLength('2em', { fontSizePx: 20 }), 40);
  assert.equal(parseLength('1ex', { fontSizePx: 20 }), 10);   // CSS fallback: 0.5em
  assert.equal(parseLength('1ch', { fontSizePx: 20 }), 10);
});

test('percentages need a basis, viewport units need a viewport', () => {
  assert.equal(parseLength('50%'), null);
  assert.equal(parseLength('50%', { basisPx: 320 }), 160);
  assert.equal(parseLength('10vw'), 102.4);
  assert.ok(Math.abs(parseLength('10vh') - 76.8) < 1e-9);
  assert.equal(parseLength('10vw', { viewportWidthPx: 1600 }), 160);
  assert.equal(percentageOf('12.5%'), 12.5);
  assert.equal(percentageOf('12px'), null);
});

test('only zero is unitless, and unresolvable values return null rather than a guess', () => {
  assert.equal(parseLength('0'), 0);
  assert.equal(parseLength('8'), null);
  assert.equal(parseLength('auto'), null);
  assert.equal(parseLength('calc(1rem + 2px)'), null);
  assert.equal(parseLength('var(--r)'), null);
  assert.equal(parseLength(''), null);
});

// ------------------------------------------------------------- CSS structure

test('comments are removed without disturbing strings', () => {
  assert.equal(stripCssComments('a{content:"/* not a comment */"}'), 'a{content:"/* not a comment */"}');
  assert.equal(stripCssComments('a{/* x */color:red}').replace(/\s+/g, ''), 'a{color:red}');
});

test('top-level splitting respects parentheses and strings', () => {
  assert.deepEqual(splitTopLevel('rgba(0, 0, 0, .2), 0 1px 2px'), ['rgba(0, 0, 0, .2)', '0 1px 2px']);
  assert.deepEqual(splitComponents('0 1px 3px rgba(0, 0, 0, .12)'), ['0', '1px', '3px', 'rgba(0,0,0,.12)'.replace('rgba(0,0,0,.12)', 'rgba(0, 0, 0, .12)')]);
  assert.deepEqual(splitComponents('inset 0 0 0 1px #fff'), ['inset', '0', '0', '0', '1px', '#fff']);
});

test('rules, at-rules and nested conditional groups are parsed flat with their conditions', () => {
  const rules = parseCssRules(`
    @import url("x.css");
    @font-face { font-family: "A"; src: url(a.woff2); }
    .card { border-radius: 8px }
    @media (min-width: 60rem) {
      .card { border-radius: 12px }
      @supports (display: grid) { .grid { border-radius: 4px } }
    }
    @keyframes spin { from { transform: rotate(0) } }
  `);
  const selectors = rules.filter((r) => !r.at).map((r) => r.selectors.join(','));
  assert.deepEqual(selectors, ['.card', '.card', '.grid']);
  assert.equal(rules.find((r) => r.at === 'import').prelude, 'url("x.css")');
  assert.equal(rules.find((r) => r.at === 'font-face').declarations['font-family'], '"A"');
  const grid = rules.find((r) => r.selectors[0] === '.grid');
  assert.deepEqual(grid.conditions, ['@media (min-width: 60rem)', '@supports (display: grid)']);
  // A keyframes body is motion, not shape, and contributes no declarations.
  assert.deepEqual(rules.find((r) => r.at === 'keyframes').declarations, {});
});

test('declarations drop !important and let the last one win', () => {
  assert.deepEqual(parseDeclarations('color: red; color: blue !important; bad'), { color: 'blue' });
});

test('a 62.5% root font-size makes every rem worth 10px', () => {
  const rules = parseCssRules('html { font-size: 62.5%; } .a { border-radius: 0.8rem }');
  assert.equal(rootFontSize(rules), 10);
  assert.equal(detectShape('html { font-size: 62.5%; } .card { border-radius: 0.8rem }').radiusPx, 8);
  // Without the 62.5% root, 0.8rem is 12.8px, which the 1px radius quantisation
  // reports as 13 — sub-pixel radii are a rounding artefact of rem arithmetic.
  assert.equal(detectShape('.card { border-radius: 0.8rem }').radiusPx, 13);
});

// ------------------------------------------------------------------- borders

test('the border shorthand is parsed in any component order', () => {
  assert.deepEqual(parseBorderShorthand('1px solid #ddd'), { widthPx: 1, style: 'solid', color: '#ddd', paints: true });
  assert.deepEqual(parseBorderShorthand('solid 2px rgba(0,0,0,.2)'), { widthPx: 2, style: 'solid', color: 'rgba(0,0,0,.2)', paints: true });
  assert.deepEqual(parseBorderShorthand('thin dashed rebeccapurple'), { widthPx: 1, style: 'dashed', color: 'rebeccapurple', paints: true });
  assert.deepEqual(parseBorderShorthand('medium'), { widthPx: 3, style: null, color: null, paints: true });
  assert.equal(parseBorderShorthand('none').paints, false);
  assert.equal(parseBorderShorthand('0 solid #000').paints, false);
  assert.equal(parseBorderShorthand('1px hidden #000').paints, false);
});

test('border-width takes one to four sides', () => {
  assert.deepEqual(parseBorderWidths('1px'), [1]);
  assert.deepEqual(parseBorderWidths('1px 0'), [1, 0]);
  assert.deepEqual(parseBorderWidths('thin medium thick 0'), [1, 3, 5, 0]);
});

test('a colour keyword in a shorthand is not mistaken for a length', () => {
  assert.equal(looksLikeColor('rebeccapurple'), true);
  assert.equal(looksLikeColor('currentcolor'), true);
  assert.equal(looksLikeColor('solid'), false);
  assert.equal(looksLikeColor('#abc'), true);
});

// -------------------------------------------------------------------- radius

test('the border-radius shorthand is read corner by corner', () => {
  assert.deepEqual(parseRadiusValue('8px').map((c) => c.px), [8]);
  assert.deepEqual(parseRadiusValue('8px 8px 0 0').map((c) => c.px), [8, 8, 0, 0]);
  // The elliptical form: only the horizontal radii are read.
  assert.deepEqual(parseRadiusValue('10px 20px / 4px 8px').map((c) => c.px), [10, 20]);
  assert.deepEqual(parseRadiusValue('50%').map((c) => c.percent), [50]);
});

test('the representative radius is the largest resolvable corner', () => {
  assert.equal(representativeRadius(parseRadiusValue('8px 8px 0 0')), 8);
  assert.equal(representativeRadius(parseRadiusValue('4px 12px')), 12);
});

test('pills and circles are excluded from the modal radius', () => {
  assert.equal(representativeRadius(parseRadiusValue(`${PILL_PERCENT}%`)), null);
  assert.equal(representativeRadius(parseRadiusValue('9999px')), null);
  assert.equal(representativeRadius(parseRadiusValue(`${PILL_RADIUS_PX + 1}px`)), null);
  assert.equal(representativeRadius(parseRadiusValue(`${PILL_RADIUS_PX}px`)), PILL_RADIUS_PX);
  // A small percentage is not a pill and does resolve.
  assert.ok(representativeRadius(parseRadiusValue('2%')) > 0);
});

// ------------------------------------------------------------------- shadows

test('a box-shadow list is parsed layer by layer, with inset and alpha', () => {
  const layers = parseBoxShadow('0 1px 3px rgba(0,0,0,.12), inset 0 0 0 1px #fff');
  assert.equal(layers.length, 2);
  assert.deepEqual(layers[0], { inset: false, offsetXPx: 0, offsetYPx: 1, blurPx: 3, spreadPx: 0, color: 'rgba(0,0,0,.12)', alpha: 0.12 });
  assert.equal(layers[1].inset, true);
  assert.equal(layers[1].alpha, 1);
  assert.deepEqual(parseBoxShadow('none'), []);
});

test('alpha is read from every colour syntax', () => {
  assert.equal(colorAlpha('rgba(0,0,0,.2)'), 0.2);
  assert.equal(colorAlpha('rgb(0 0 0 / 20%)'), 0.2);
  assert.equal(colorAlpha('#0000001f'), 31 / 255);
  assert.equal(colorAlpha('#0007'), 7 * 17 / 255);
  assert.equal(colorAlpha('black'), 1);
  assert.equal(colorAlpha('transparent'), 0);
});

test("shadow strength reproduces Material's published elevation ladder", () => {
  // dp1: 0 1px 3px rgba(0,0,0,.12) -> geometry 1.5 + 0 + 1 = 2.5, alpha factor 1
  assert.equal(shadowStrength(parseBoxShadow('0 1px 3px rgba(0,0,0,.12)')[0]), 2.5);
  // dp2: 0 3px 6px rgba(0,0,0,.16) -> geometry 3 + 0 + 3 = 6, alpha factor 4/3
  assert.ok(Math.abs(shadowStrength(parseBoxShadow('0 3px 6px rgba(0,0,0,.16)')[0]) - 8) < 1e-9);
  // dp16: 0 16px 24px rgba(0,0,0,.14) -> geometry 12 + 0 + 16 = 28, factor 7/6
  assert.ok(Math.abs(shadowStrength(parseBoxShadow('0 16px 24px rgba(0,0,0,.14)')[0]) - 28 * (0.14 / 0.12)) < 1e-9);
  // An inset shadow is an inner well, not elevation.
  assert.equal(shadowStrength(parseBoxShadow('inset 0 2px 8px rgba(0,0,0,.4)')[0]), 0);
  // A fully transparent shadow paints nothing.
  assert.equal(shadowStrength(parseBoxShadow('0 4px 8px transparent')[0]), 0);
});

test('the tiers land where the Material ladder says they should', () => {
  assert.equal(shadowTier(0), 0);
  assert.equal(shadowTier(shadowStrength(parseBoxShadow('0 1px 3px rgba(0,0,0,.12)')[0])), 1);
  assert.equal(shadowTier(shadowStrength(parseBoxShadow('0 3px 6px rgba(0,0,0,.16)')[0])), 2);
  assert.equal(shadowTier(shadowStrength(parseBoxShadow('0 16px 24px rgba(0,0,0,.14)')[0])), 3);
  assert.equal(shadowTier(SHADOW_TIER_BOUNDS.t1), 1);
  assert.equal(shadowTier(SHADOW_TIER_BOUNDS.t1 + 0.001), 2);
  assert.equal(shadowTier(SHADOW_TIER_BOUNDS.t2), 2);
  assert.equal(shadowTier(SHADOW_TIER_BOUNDS.t2 + 0.001), 3);
});

test('a stacked shadow is measured by its heaviest layer', () => {
  const layers = parseBoxShadow('0 1px 1px rgba(0,0,0,.1), 0 12px 24px rgba(0,0,0,.2)');
  assert.equal(declarationStrength(layers), shadowStrength(layers[1]));
});

// ------------------------------------------------------------------ evidence

test('component selectors weigh more than page-level ones', () => {
  assert.equal(selectorWeight(['.card']), 3);
  assert.equal(selectorWeight(['.modal-dialog']), 3);
  assert.equal(selectorWeight(['.btn-primary']), 2);
  assert.equal(selectorWeight(['blockquote']), 1);
  assert.equal(selectorWeight(['*']), 0.25);
  assert.equal(selectorWeight(['html']), 0.25);
  // The strongest selector in a list decides.
  assert.equal(selectorWeight(['blockquote', '.card']), 3);
});

test('the modal radius is the repeated value, not the mean and not the first', () => {
  const css = `
    .card { border-radius: 8px }
    .panel { border-radius: 8px }
    .tile { border-radius: 8px }
    .promo-banner { border-radius: 40px }
  `;
  assert.equal(detectShape(css).radiusPx, 8);
});

test('a heavier selector outvotes a lighter one at equal count', () => {
  const css = `
    .card { border-radius: 12px }
    blockquote { border-radius: 3px }
    figure { border-radius: 3px }
  `;
  assert.equal(detectShape(css).radiusPx, 12);
});

test('the modal border width counts "no border" as evidence', () => {
  const flat = detectShape(`
    .card { border: none; border-radius: 8px }
    .panel { border: none }
    .tile { border: none }
    .quote { border: 1px solid #eee }
  `);
  assert.equal(flat.borderWidthPx, 0);
  const outlined = detectShape(`
    .card { border: 1px solid #ddd }
    .panel { border: 1px solid #ddd }
    .tile { border-width: 1px }
  `);
  assert.equal(outlined.borderWidthPx, 1);
});

test('hairline borders survive as half pixels', () => {
  assert.equal(detectShape('.card { border: 0.5px solid #000 } .panel { border: 0.5px solid #000 }').borderWidthPx, 0.5);
});

test('a full extraction reads radius, border and shadow together', () => {
  const css = `
    :root { font-size: 100% }
    * { box-sizing: border-box }
    .card, .panel { border-radius: 0.75rem; border: 1px solid #e4e7ec; box-shadow: 0 1px 2px rgba(16,24,40,.06), 0 1px 3px rgba(16,24,40,.1); }
    .modal { border-radius: 0.75rem; box-shadow: 0 20px 24px -4px rgba(16,24,40,.08), 0 8px 8px -4px rgba(16,24,40,.03); }
    .btn { border-radius: 0.5rem; border: 1px solid transparent }
    .avatar { border-radius: 50% }
    .pill { border-radius: 9999px }
  `;
  const shape = detectShape(css);
  assert.equal(shape.radiusPx, 12);
  assert.equal(shape.borderWidthPx, 1);
  assert.equal(shape.shadowLevel, 3);       // the modal's 20px offset is a dp16-class lift
});

test('a design with no shadows anywhere reports tier 0', () => {
  assert.equal(detectShape('.card { border-radius: 4px } .panel { border-radius: 4px }').shadowLevel, 0);
  assert.equal(detectShape('.card { box-shadow: none }').shadowLevel, 0);
});

test('an empty stylesheet yields zeroes and zero confidence, not a guess', () => {
  assert.deepEqual(detectShape(''), { radiusPx: 0, borderWidthPx: 0, shadowLevel: 0 });
  assert.equal(shapeConfidence(collectShapeEvidence('')), 0);
});

// ---------------------------------------------------------------- statistics

test('the weighted mode breaks ties deterministically', () => {
  const rows = [
    { value: 4, weight: 1, selector: '.a' },
    { value: 8, weight: 1, selector: '.b' },
  ];
  assert.equal(weightedMode(rows, 1).value, 8);            // ties go to the larger value
  assert.equal(weightedMode(rows.slice().reverse(), 1).value, 8);
  assert.equal(weightedMode([], 1), null);
});

test('the modal shadow tier breaks ties toward the higher tier', () => {
  const rows = [
    { tier: 1, strength: 2, weight: 1, selector: '.a' },
    { tier: 3, strength: 30, weight: 1, selector: '.b' },
  ];
  assert.equal(modalShadowTier(rows).tier, 3);
  assert.equal(modalShadowTier([]), null);
});

test('shapeFromEvidence and detectShape agree', () => {
  const css = '.card { border-radius: 6px; border: 2px solid #000; box-shadow: 0 2px 4px rgba(0,0,0,.2) }';
  assert.deepEqual(shapeFromEvidence(collectShapeEvidence(css)), detectShape(css));
});

// --------------------------------------------------------------- confidence

test('confidence rises with sample size and with agreement', () => {
  const thin = shapeConfidence(collectShapeEvidence('.a { border-radius: 8px }'));
  const thick = shapeConfidence(collectShapeEvidence(`
    .card { border-radius: 8px; border: 1px solid #ddd; box-shadow: 0 1px 3px rgba(0,0,0,.12) }
    .panel { border-radius: 8px; border: 1px solid #ddd; box-shadow: 0 1px 3px rgba(0,0,0,.12) }
    .tile { border-radius: 8px; border: 1px solid #ddd; box-shadow: 0 1px 3px rgba(0,0,0,.12) }
    .well { border-radius: 8px; border: 1px solid #ddd; box-shadow: 0 1px 3px rgba(0,0,0,.12) }
  `));
  assert.ok(thick > thin, `${thick} should exceed ${thin}`);
  assert.ok(thick <= 1 && thin >= 0);
});

test('a stylesheet that disagrees with itself reports lower confidence than one that does not', () => {
  const agreeing = shapeConfidence(collectShapeEvidence(`
    .card { border-radius: 8px } .panel { border-radius: 8px }
    .tile { border-radius: 8px } .well { border-radius: 8px }
  `));
  const split = shapeConfidence(collectShapeEvidence(`
    .card { border-radius: 2px } .panel { border-radius: 8px }
    .tile { border-radius: 16px } .well { border-radius: 24px }
  `));
  assert.ok(agreeing > split, `${agreeing} should exceed ${split}`);
});

test('extraction is deterministic', () => {
  const css = '.card { border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.12) } .btn { border: 1px solid #ccc }';
  assert.deepEqual(detectShape(css), detectShape(css));
  assert.equal(shapeConfidence(collectShapeEvidence(css)), shapeConfidence(collectShapeEvidence(css)));
});
