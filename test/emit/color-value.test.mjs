/**
 * The colour arithmetic the provenance law is judged on.
 *
 * §17.1 requires "WCAG contrast ratios against the W3C worked examples" with
 * "no eyeballed constants". The emitter's contrast check is severity 1 with no
 * override, so its arithmetic is pinned here to published values rather than to
 * whatever the implementation happens to return.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseColor, contrastRatio, relativeLuminance, compositeOver, toHex,
  hslToRgb, oklchToSrgb, splitComponents, parseColorMix,
} from '../../src/emit/color-value.js';

/** WCAG 2.1 relative luminance, from the specification's own examples. */
test('relative luminance matches the WCAG 2.1 definition', () => {
  assert.equal(relativeLuminance({ r: 255, g: 255, b: 255 }), 1);
  assert.equal(relativeLuminance({ r: 0, g: 0, b: 0 }), 0);
  assert.ok(Math.abs(relativeLuminance({ r: 255, g: 0, b: 0 }) - 0.2126) < 1e-12);
  assert.ok(Math.abs(relativeLuminance({ r: 0, g: 255, b: 0 }) - 0.7152) < 1e-12);
  assert.ok(Math.abs(relativeLuminance({ r: 0, g: 0, b: 255 }) - 0.0722) < 1e-12);
  // The linearisation kink: 10/255 is below the 0.03928 threshold.
  assert.ok(Math.abs(relativeLuminance({ r: 10, g: 10, b: 10 }) - (10 / 255 / 12.92)) < 1e-12);
});

test('contrast ratios match published reference pairs', () => {
  const pairs = [
    ['#000000', '#ffffff', 21],
    ['#ffffff', '#ffffff', 1],
    ['#777777', '#ffffff', 4.478],
    ['#767676', '#ffffff', 4.5417],
    ['#ff0000', '#ffffff', 3.9985],
    ['#0000ff', '#ffffff', 8.5924],
    ['#008000', '#ffffff', 5.1323],
    ['#595959', '#ffffff', 7.0],
  ];
  for (const [a, b, expected] of pairs) {
    const got = contrastRatio(parseColor(a), parseColor(b));
    assert.ok(Math.abs(got - expected) < 0.01, `${a} on ${b}: expected ${expected}, got ${got.toFixed(4)}`);
  }
});

test('contrast is symmetric', () => {
  assert.equal(contrastRatio(parseColor('#123456'), parseColor('#abcdef')), contrastRatio(parseColor('#abcdef'), parseColor('#123456')));
});

test('every hex form parses', () => {
  assert.deepEqual(parseColor('#0f8'), { r: 0, g: 255, b: 136, a: 1 });
  assert.deepEqual(parseColor('#0f8c'), { r: 0, g: 255, b: 136, a: 204 / 255 });
  assert.deepEqual(parseColor('#00ff88'), { r: 0, g: 255, b: 136, a: 1 });
  assert.deepEqual(parseColor('#00ff88cc'), { r: 0, g: 255, b: 136, a: 204 / 255 });
  assert.equal(parseColor('#xyz'), null);
});

test('the modern and legacy function syntaxes both parse', () => {
  assert.deepEqual(parseColor('rgb(1,2,3)'), { r: 1, g: 2, b: 3, a: 1 });
  assert.deepEqual(parseColor('rgba(1, 2, 3, 0.5)'), { r: 1, g: 2, b: 3, a: 0.5 });
  assert.deepEqual(parseColor('rgb(1 2 3 / 50%)'), { r: 1, g: 2, b: 3, a: 0.5 });
  assert.deepEqual(parseColor('rgb(100% 0% 0%)'), { r: 255, g: 0, b: 0, a: 1 });
  assert.deepEqual(parseColor('hsl(0 100% 50%)'), { r: 255, g: 0, b: 0, a: 1 });
  assert.deepEqual(parseColor('hsl(120, 100%, 50%)'), { r: 0, g: 255, b: 0, a: 1 });
  assert.deepEqual(parseColor('color(srgb 1 0 0)'), { r: 255, g: 0, b: 0, a: 1 });
});

test('OKLCH resolves to sRGB closely enough for a 4.5:1 threshold', () => {
  const white = oklchToSrgb(1, 0, 0);
  assert.deepEqual(white, [255, 255, 255]);
  const black = oklchToSrgb(0, 0, 0);
  assert.deepEqual(black, [0, 0, 0]);
  const red = oklchToSrgb(0.6279, 0.2577, 29.23);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(red[i] - [255, 0, 0][i]) <= 2, `oklch red channel ${i}: ${red[i]}`);
});

test('named colours and transparent parse', () => {
  assert.deepEqual(parseColor('white'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseColor('rebeccapurple'), { r: 102, g: 51, b: 153, a: 1 });
  assert.deepEqual(parseColor('transparent'), { r: 0, g: 0, b: 0, a: 0 });
  assert.equal(parseColor('currentColor'), null, 'currentColor is not a colour until the cascade resolves it');
  assert.equal(parseColor('inherit'), null);
});

test('color-mix mixes in the ratios it was given', () => {
  const half = parseColorMix('in srgb, #000000 50%, #ffffff 50%');
  assert.deepEqual(half, { r: 128, g: 128, b: 128, a: 1 });
  const scrim = parseColor('color-mix(in srgb, #000000 45%, transparent)');
  assert.equal(scrim.a, 0.45);
  const implicit = parseColorMix('in srgb, #000000, #ffffff');
  assert.deepEqual(implicit, { r: 128, g: 128, b: 128, a: 1 });
});

test('compositing a translucent colour over a backdrop is physically right', () => {
  const over = compositeOver({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(over, { r: 128, g: 128, b: 128, a: 1 });
  assert.equal(toHex(over), '#808080');
  const opaque = compositeOver({ r: 10, g: 20, b: 30, a: 1 }, { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(opaque, { r: 10, g: 20, b: 30, a: 1 });
});

test('a label at half opacity really does lose contrast', () => {
  const bg = parseColor('#ffffff');
  const full = contrastRatio(compositeOver(parseColor('#595959'), bg), bg);
  const faded = contrastRatio(compositeOver({ ...parseColor('#595959'), a: 0.3 }, bg), bg);
  assert.ok(full > 6.9 && full < 7.1);
  assert.ok(faded < 2, `a 30% label should read at under 2:1, got ${faded.toFixed(2)}`);
});

test('component splitting keeps nested functions whole', () => {
  assert.deepEqual(splitComponents('1 2 3 / 50%'), ['1', '2', '3', '/', '50%']);
  assert.deepEqual(splitComponents('var(--a, 1 2) 3'), ['var(--a, 1 2)', '3']);
});

test('hsl round-trips the primaries', () => {
  assert.deepEqual(hslToRgb(0, 1, 0.5), { r: 255, g: 0, b: 0 });
  assert.deepEqual(hslToRgb(240, 1, 0.5), { r: 0, g: 0, b: 255 });
  assert.deepEqual(hslToRgb(0, 0, 1), { r: 255, g: 255, b: 255 });
});
