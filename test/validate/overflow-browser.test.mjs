/**
 * The browser cross-check for §22.2.
 *
 * D7 makes text measurement a deterministic table lookup rather than a canvas
 * call, for a good reason: a canvas measures whatever fonts the measuring
 * machine happens to have, so a golden test built on one would assert a property
 * of the CI container. But that decision owes an answer to an obvious question —
 * *how close is the model to a real rasteriser?* — and the only honest way to
 * answer it is to lay the corpus out in a real browser and report the residual.
 *
 * This test does that, and reports it rather than hiding it. Three buckets,
 * because they are three different questions:
 *
 *  1. **Installed family, Latin script.** The family the case resolves to is
 *     genuinely present (or fontconfig maps it to a metric-compatible twin, which
 *     is the same thing for measurement). This is the number that matters, and it
 *     is asserted below the detector's own severity-1 threshold — which is the
 *     whole argument for that threshold: if the engine agrees with Chromium to
 *     better than 2%, an excess larger than 2% cannot be an artifact of the
 *     model, and the severity-1 line is a statement about the text.
 *  2. **Installed family, CJK.** The Latin family is present but the CJK glyphs
 *     come from whatever CJK face the machine has, whose advances are not the
 *     engine's one-em model. Asserted at a looser, stated tolerance, and the
 *     direction of the error is recorded in `docs/decisions/L11-validate.md`.
 *  3. **Substituted family.** The browser did not have the family at all and
 *     silently rendered something else. A residual measured there is not a
 *     residual, it is a different question — reported, never asserted.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { CORPUS } from '../fixtures/overflow/corpus.mjs';
import { layOutBox, OVERFLOW_CLIP_RATIO } from '../../src/validate/index.js';
import { cssFontFamily } from '../../src/core/text-metrics.js';

/** Mean relative width error the engine is held to for installed Latin faces. */
const LATIN_TOLERANCE_MEAN = 0.005;
/** The worst single Latin run allowed. */
const LATIN_TOLERANCE_MAX = 0.015;
/**
 * CJK is looser and says so: the engine models every wide codepoint as exactly
 * one em, and a real CJK face is close to but not exactly that.
 */
const CJK_TOLERANCE_MAX = 0.040;

const CJK_RE = /[぀-㏿㐀-䶿一-鿿가-힣]/;

let browser = null;
let page = null;
let available = true;

before(async () => {
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch();
    page = await browser.newPage();
    await page.setContent('<!doctype html><meta charset="utf-8"><body style="margin:0"></body>');
  } catch (e) {
    available = false;
    console.log(`browser cross-check: skipped — Chromium is not available here (${e.message})`);
  }
});

after(async () => {
  if (browser) await browser.close();
});

/** Measure one text run in the browser exactly as the case declares it. */
async function measureInBrowser(box, family) {
  return page.evaluate(({ b, f }) => {
    const el = document.createElement('div');
    el.style.cssText = 'position:absolute;left:0;top:0;margin:0;padding:0;border:0;hyphens:none;word-break:normal;';
    el.style.width = `${b.containerWidthPx}px`;
    el.style.fontFamily = f;
    el.style.fontSize = `${b.style.fontSizePx}px`;
    el.style.fontWeight = String(b.style.weight || 400);
    el.style.lineHeight = String(b.style.lineHeight || 1.2);
    el.style.letterSpacing = `${b.style.letterSpacingPx || 0}px`;
    el.style.textTransform = b.style.textTransform || 'none';
    el.style.whiteSpace = b.whiteSpace || 'normal';
    el.style.overflowWrap = b.overflowWrap || 'normal';
    el.textContent = b.text;
    document.body.appendChild(el);
    const range = document.createRange();
    range.selectNodeContents(el.firstChild);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0.01);
    const out = {
      lineCount: Math.max(1, rects.length),
      maxLineWidthPx: rects.length ? Math.max(...rects.map((r) => r.width)) : 0,
    };
    el.remove();
    return out;
  }, { b: box, f: family });
}

/**
 * Is this family actually present, or does the browser silently substitute?
 * An absent family renders identically to a family that is certainly absent, so
 * measuring both and comparing settles it.
 */
async function familyIsInstalled(family) {
  return page.evaluate((f) => {
    const probe = 'Handgloves 0123456789 mmmmiiii';
    const measure = (stack) => {
      const el = document.createElement('span');
      el.style.cssText = 'position:absolute;white-space:nowrap;font-size:64px;';
      el.style.fontFamily = stack;
      el.textContent = probe;
      document.body.appendChild(el);
      const w = el.getBoundingClientRect().width;
      el.remove();
      return w;
    };
    const nonsense = measure('"PitchProofNoSuchFamily12345", monospace');
    const asked = measure(`"${f}", "PitchProofNoSuchFamily12345", monospace`);
    return Math.abs(asked - nonsense) > 0.5;
  }, family);
}

const stats = (list) => {
  if (list.length === 0) return { n: 0, mean: 0, p95: 0, max: 0 };
  const errs = list.map((r) => r.err).sort((a, b) => a - b);
  return {
    n: errs.length,
    mean: errs.reduce((a, b) => a + b, 0) / errs.length,
    p95: errs[Math.min(errs.length - 1, Math.floor(errs.length * 0.95))],
    max: errs[errs.length - 1],
  };
};

test('the deterministic engine agrees with real Chromium within a stated tolerance', async (t) => {
  if (!available) {
    t.skip('Chromium is not available in this environment');
    return;
  }

  /** @type {Map<string, boolean>} */
  const installed = new Map();
  for (const kase of CORPUS) {
    if (!installed.has(kase.resolvedFamily)) {
      installed.set(kase.resolvedFamily, await familyIsInstalled(kase.resolvedFamily));
    }
  }

  /** @type {any[]} */
  const rows = [];
  for (const kase of CORPUS) {
    const box = kase.measurement.boxes[0];
    const laid = layOutBox(box, kase.brand);
    const real = await measureInBrowser(box, cssFontFamily([kase.resolvedFamily]));
    if (!(real.maxLineWidthPx > 0)) continue;
    rows.push({
      id: kase.id,
      group: kase.group,
      family: kase.resolvedFamily,
      installed: installed.get(kase.resolvedFamily) === true,
      cjk: CJK_RE.test(box.text),
      engine: laid.full.maxLineWidthPx,
      browser: real.maxLineWidthPx,
      err: Math.abs(laid.full.maxLineWidthPx - real.maxLineWidthPx) / real.maxLineWidthPx,
      signed: (laid.full.maxLineWidthPx - real.maxLineWidthPx) / real.maxLineWidthPx,
      lines: [laid.full.lineCount, real.lineCount],
    });
  }

  const latin = rows.filter((r) => r.installed && !r.cjk);
  const cjk = rows.filter((r) => r.installed && r.cjk);
  const substituted = rows.filter((r) => !r.installed);
  const latinStats = stats(latin);
  const cjkStats = stats(cjk);
  const subStats = stats(substituted);
  const lineAgreement = [...latin, ...cjk].filter((r) => r.lines[0] === r.lines[1]).length;
  const lineTotal = latin.length + cjk.length;

  const fmt = (n) => `${(n * 100).toFixed(3)}%`;
  const signed = (list) => (list.length ? `${list.reduce((a, b) => a + b.signed, 0) / list.length >= 0 ? '+' : ''}${((list.reduce((a, b) => a + b.signed, 0) / list.length) * 100).toFixed(3)}%` : 'n/a');

  console.log([
    '',
    `browser cross-check — ${rows.length} corpus cases laid out in headless Chromium`,
    '',
    `  present on this machine:      ${[...installed].filter(([, v]) => v).map(([k]) => k).join(', ') || '(none)'}`,
    `  substituted by the browser:   ${[...installed].filter(([, v]) => !v).map(([k]) => k).join(', ') || '(none)'}`,
    '',
    `  installed / Latin   n=${String(latinStats.n).padStart(3)}  mean ${fmt(latinStats.mean)}  p95 ${fmt(latinStats.p95)}  max ${fmt(latinStats.max)}  bias ${signed(latin)}`,
    `  installed / CJK     n=${String(cjkStats.n).padStart(3)}  mean ${fmt(cjkStats.mean)}  p95 ${fmt(cjkStats.p95)}  max ${fmt(cjkStats.max)}  bias ${signed(cjk)}`,
    `  substituted family  n=${String(subStats.n).padStart(3)}  mean ${fmt(subStats.mean)}  p95 ${fmt(subStats.p95)}  max ${fmt(subStats.max)}  (reported, never asserted)`,
    '    — a residual measured against a font the browser does not have is a property of this',
    '      machine, not of the engine. The CSS generics in that list (ui-monospace and friends)',
    '      map to a real UI face on the platforms an artifact is opened on and to nothing here.',
    '',
    `  line-count agreement on present families: ${lineAgreement}/${lineTotal}`,
    '',
    '  worst five runs on a present family:',
    ...[...latin, ...cjk].sort((a, b) => b.err - a.err).slice(0, 5).map(
      (r) => `    ${r.id.padEnd(7)} ${r.group.padEnd(22)} ${r.family.padEnd(16)} engine ${r.engine.toFixed(2)}px  chromium ${r.browser.toFixed(2)}px  ${fmt(r.err)}`,
    ),
    '',
    `  the detector blocks above ${(OVERFLOW_CLIP_RATIO * 100).toFixed(0)}% of the container. The Latin residual above is what that`,
    '  threshold has to clear for a severity-1 finding to be a statement about the text',
    '  rather than about the model.',
    '',
  ].join('\n'));

  assert.ok(latin.length >= 20, `the cross-check needs a real sample of installed Latin runs, got ${latin.length}`);
  assert.ok(
    latinStats.mean <= LATIN_TOLERANCE_MEAN,
    `mean Latin width residual is ${fmt(latinStats.mean)}, above the ${fmt(LATIN_TOLERANCE_MEAN)} tolerance`,
  );
  assert.ok(
    latinStats.max <= LATIN_TOLERANCE_MAX,
    `worst Latin width residual is ${fmt(latinStats.max)}, above the ${fmt(LATIN_TOLERANCE_MAX)} tolerance`,
  );
  assert.ok(
    LATIN_TOLERANCE_MAX <= OVERFLOW_CLIP_RATIO,
    'the Latin residual tolerance must sit at or below the severity-1 threshold, or the threshold measures the model rather than the text',
  );
  if (cjk.length > 0) {
    assert.ok(
      cjkStats.max <= CJK_TOLERANCE_MAX,
      `worst CJK width residual is ${fmt(cjkStats.max)}, above the stated ${fmt(CJK_TOLERANCE_MAX)} tolerance`,
    );
  }
  assert.ok(
    lineAgreement >= Math.ceil(lineTotal * 0.98),
    `wrapped line count agreed on only ${lineAgreement} of ${lineTotal} runs on present families`,
  );
});
