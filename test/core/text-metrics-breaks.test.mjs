/**
 * The model's break opportunities are the engine's, checked against the engine.
 *
 * §22.2 names text overflow after font substitution as the defect that "makes a
 * proof look amateur in front of a CMO, and it is invisible until it isn't", and
 * §17.4 puts a number on catching it: recall ≥ 0.98. Both depend on `layoutText`
 * breaking lines where a browser breaks them.
 *
 * It did not. `BREAK_AFTER` contained `/`, which UAX#14 gives line-break class
 * `SY` — no break opportunity — and which Chromium does not break at. An extra
 * break opportunity lets the model pack more onto a line than the browser will,
 * so it reports *fewer* lines than render: under-reporting, the one direction
 * §22.2 forbids. It was the largest single cause of the overflow detector's
 * recall sitting at 0.90 (CRITIQUE-2 C1, L8-D9), and removing it took the same
 * corpus measurement to 0.9921.
 *
 * So this asserts the set against a real engine rather than against a reading of
 * the standard. A character we think breaks and Chromium does not is the shape
 * of the defect; a character Chromium breaks and we do not is the safe
 * direction, but it is still a divergence and is reported.
 *
 * Playwright is a dev dependency (D3); Chromium is preinstalled and this never
 * runs `playwright install`. The test skips rather than passing if it cannot
 * launch — a check that silently succeeds without checking is worse than none.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { layoutText, measureText } from '../../src/core/text-metrics.js';

/** Every character the model believes is a break opportunity, plus `/`. */
const CANDIDATES = [
  { name: 'hyphen-minus', ch: '-', modelBreaks: true },
  { name: 'non-breaking hyphen U+2010', ch: '‐', modelBreaks: true },
  { name: 'figure dash U+2012', ch: '‒', modelBreaks: true },
  { name: 'en dash', ch: '–', modelBreaks: true },
  { name: 'em dash', ch: '—', modelBreaks: true },
  { name: 'zero-width space', ch: '​', modelBreaks: true },
  { name: 'soft hyphen', ch: '­', modelBreaks: true },
  // The one that was wrong. UAX#14 class SY: no break opportunity.
  { name: 'solidus', ch: '/', modelBreaks: false },
];

async function loadChromium() {
  try { return (await import('playwright')).chromium; } catch { return null; }
}

/** The style every case is measured in. */
const STYLE = { family: 'Helvetica', weight: 400, fontSizePx: 16, lineHeight: 1.2 };

/**
 * Does the model put `aaa<ch>bbb` on two lines in a box narrower than the whole
 * run but wider than half of it? That width is the discriminator: a break
 * opportunity in the middle puts it on two lines, and no break opportunity
 * leaves it on one and overflowing.
 * @param {string} ch
 * @returns {number}
 */
function modelLines(ch) {
  const text = `${'a'.repeat(10)}${ch}${'b'.repeat(10)}`;
  const full = measureText(text, STYLE);
  return layoutText(text, STYLE, { maxWidthPx: full * 0.7, maxLines: 0 }).lineCount;
}

test('the model breaks after exactly the characters it declares', () => {
  for (const { name, ch, modelBreaks } of CANDIDATES) {
    const lines = modelLines(ch);
    if (modelBreaks) assert.ok(lines >= 2, `${name} is declared a break opportunity but the model kept one line`);
    else assert.equal(lines, 1, `${name} is not a break opportunity but the model broke at it`);
  }
});

test('the engine agrees with the model, character for character', async (t) => {
  const chromium = await loadChromium();
  if (!chromium) return t.skip('playwright is not linked in node_modules');

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><meta charset="utf-8"><body></body>');
    const engine = await page.evaluate((chars) => {
      /** @type {Record<string, number>} */
      const out = {};
      for (const ch of chars) {
        const d = document.createElement('div');
        // A monospace box twelve characters wide: a 21-character run fits on one
        // line only if nothing in it may break.
        d.style.cssText = 'position:absolute;width:12ch;font:16px monospace;'
          + 'white-space:normal;overflow-wrap:normal;word-break:normal;line-height:20px';
        d.textContent = `${'a'.repeat(10)}${ch}${'b'.repeat(10)}`;
        document.body.appendChild(d);
        out[ch] = Math.round(d.getBoundingClientRect().height / 20);
        d.remove();
      }
      return out;
    }, CANDIDATES.map((c) => c.ch));

    /** @type {string[]} */
    const divergences = [];
    for (const { name, ch, modelBreaks } of CANDIDATES) {
      const engineBreaks = engine[ch] >= 2;
      if (engineBreaks === modelBreaks) continue;
      divergences.push(
        `${name} (U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}): `
        + `the model ${modelBreaks ? 'breaks' : 'does not break'} here, Chromium `
        + `${engineBreaks ? 'does' : 'does not'}`
        + (modelBreaks && !engineBreaks
          ? ' — this is the dangerous direction: the model packs more onto a line than the browser will, '
            + 'so it reports fewer lines than render and misses overflow that is really there'
          : ' — the safe direction, but still a divergence'));
    }
    assert.deepEqual(divergences, [], divergences.join('\n'));
  } finally {
    await browser.close();
  }
});

test('the model and the engine break the corpus\'s own URLs the same way', async (t) => {
  // The case that made the solidus tempting, and the case where it did damage.
  // These are not unbreakable runs — they carry hyphens, and both the model and
  // Chromium break at those. What matters is that they break at the *same*
  // places, so a container the model says holds a URL really holds it.
  const urls = [
    'www.northwind-industrial.example/insights/fouling-margins/',
    'www.northwind-industrial.example/equipment/heat-exchangers/hx-400/',
    'northwindindustrial.example/insights/foulingmargins/',   // no hyphens at all
    'https://cdn.example.com/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p',
  ];
  const widths = [120, 200, 320];

  const chromium = await loadChromium();
  if (!chromium) return t.skip('playwright is not linked in node_modules');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><meta charset="utf-8"><body></body>');
    const engine = await page.evaluate(({ list, ws }) => {
      /** @type {Record<string, number>} */
      const out = {};
      for (const text of list) {
        for (const width of ws) {
          const d = document.createElement('div');
          d.style.cssText = `position:absolute;width:${width}px;font:16px Helvetica,Arial,sans-serif;`
            + 'white-space:normal;overflow-wrap:normal;word-break:normal;line-height:20px';
          d.textContent = text;
          document.body.appendChild(d);
          out[`${width}|${text}`] = Math.round(d.getBoundingClientRect().height / 20);
          d.remove();
        }
      }
      return out;
    }, { list: urls, ws: widths });

    /** @type {string[]} */
    const divergences = [];
    for (const url of urls) {
      for (const width of widths) {
        const model = layoutText(url, STYLE, { maxWidthPx: width, maxLines: 0 }).lineCount;
        const real = engine[`${width}|${url}`];
        if (model === real) continue;
        divergences.push(
          `${width}px "${url}": model ${model} line(s), Chromium ${real}`
          + (model < real
            ? ' — the model packs more onto a line than the browser will, so it will miss an overflow that is really there'
            : ' — the safe direction'));
      }
    }
    assert.deepEqual(divergences, [], divergences.join('\n'));
  } finally {
    await browser.close();
  }
});
