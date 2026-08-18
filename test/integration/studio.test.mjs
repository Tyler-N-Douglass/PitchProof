/**
 * The built studio, opened in a browser.
 *
 * This test exists because the studio was broken and every other test passed.
 *
 * `scripts/build.mjs` filled its three template markers with `String.replace`
 * and a *string* replacement, which expands `$'`, `$&` and `` $` ``. Three
 * bundled sources legitimately contain them — character tables in
 * `core/text-metrics.js` and `emit/scan-parse.js` hold a literal `'$'`, and
 * `runtime/host.js` holds `'\\$&'` in `cssEscape` — so each `$'` spliced the
 * entire remainder of the document into the middle of a string literal. The
 * studio parsed with a syntax error, `PitchProofStudio` was never defined, and
 * `dist/pitchproof-studio.html` rendered its own "bundle did not load"
 * fallback. 1608 tests were green at the time, because none of them opened the
 * built file.
 *
 * The lesson generalises past the bug: unit tests check the parts, and the
 * build is a part nothing was checking. §1 calls the studio "a single-file,
 * Netlify-deployable HTML application"; this asserts that the file that would
 * be deployed actually runs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildStudio, buildRuntime } from '../../scripts/build.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STUDIO = join(ROOT, 'dist', 'pitchproof-studio.html');

async function loadChromium() {
  try { return (await import('playwright')).chromium; } catch { return null; }
}

/** Build the studio in memory so the test does not depend on a prior build. */
function studioHtml() {
  const built = buildStudio(buildRuntime());
  assert.ok(built, 'buildStudio returned nothing — the ui lane has not landed');
  return built;
}

test('the built studio is valid JavaScript, not a spliced document', () => {
  const html = studioHtml();
  // The signature of the defect: the document's own tail appearing inside the
  // body, because `$'` expanded to "everything after the match".
  const tail = '</script>\n</body>\n</html>';
  const firstTail = html.indexOf(tail);
  if (firstTail >= 0) {
    assert.equal(firstTail, html.length - tail.length - (html.endsWith('\n') ? 1 : 0),
      'the document tail appears before the end of the file, which is what a $-expansion splice looks like');
  }
  assert.ok(!html.includes('</body></html>,'), 'a spliced tail landed inside an expression');
  // A marker left unreplaced means a template drifted from the build script.
  for (const marker of ['<!--PITCHPROOF_STYLES-->', '<!--PITCHPROOF_RUNTIME-->', '<!--PITCHPROOF_SCRIPT-->']) {
    assert.ok(!html.includes(marker), `${marker} was never filled in`);
  }
});

test('the studio bundle carries the dollar sequences that broke it, unmangled', () => {
  const html = studioHtml();
  // `cssEscape` in src/runtime/host.js. If `$&` had been expanded, this exact
  // sequence would not survive into the bundle.
  assert.ok(html.includes("'\\\\$&'") || html.includes('\\\\$&'),
    "cssEscape's replacement string did not survive the build intact");
});

test('the built studio runs in a browser with no errors and no network', async (t) => {
  const chromium = await loadChromium();
  if (!chromium) return t.skip('playwright is not linked in node_modules');
  if (!existsSync(STUDIO)) return t.skip('dist/pitchproof-studio.html has not been built');

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    /** @type {string[]} */
    const attempted = [];
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith('file://')) { route.continue(); return; }
      attempted.push(url);
      route.abort();
    });
    const page = await context.newPage();
    /** @type {string[]} */
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    page.on('requestfailed', (r) => { if (!r.url().startsWith('file://')) attempted.push(r.url()); });

    await page.goto(pathToFileURL(STUDIO).href, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.PitchProofStudio === 'object', null, { timeout: 10_000 });

    assert.deepEqual(errors, [], errors.join('\n'));
    assert.deepEqual(attempted, [],
      `§1.1: the studio reached the network ${attempted.length} time(s): ${attempted.join(', ')}`);

    // It mounted, rather than falling back.
    const mounted = await page.evaluate(() => {
      const root = document.getElementById('pp-studio-root');
      return { children: root ? root.children.length : 0, text: (document.body.textContent || '').slice(0, 200) };
    });
    assert.ok(mounted.children > 0, 'the studio root is empty — the bundle did not mount');
    assert.ok(!/bundle did not load/i.test(mounted.text), `the studio showed its own failure fallback: ${mounted.text}`);

    // §15's rail, all eight sections plus settings.
    const railLabels = await page.evaluate(() =>
      [...document.querySelectorAll('nav button, [data-st-rail] button, .st-rail button')]
        .map((b) => (b.textContent || '').trim().toLowerCase()));
    for (const section of ['project', 'brand', 'specimen', 'recipe', 'scene', 'branch', 'rehears', 'emit']) {
      assert.ok(railLabels.some((l) => l.includes(section)), `the rail has no ${section} section: ${railLabels.join(', ')}`);
    }
  } finally {
    await browser.close();
  }
});

test('the studio stylesheet loads no font and reaches no network (§1.1)', async (t) => {
  const chromium = await loadChromium();
  if (!chromium) return t.skip('playwright is not linked in node_modules');
  if (!existsSync(STUDIO)) return t.skip('dist/pitchproof-studio.html has not been built');

  // Read the stylesheets the browser actually parsed. A regex over the file
  // matches `<style` inside the bundle's own JavaScript — the emitter builds
  // artifact documents and discusses `@font-face` in comments — and would flag
  // the studio's source code as a violation of the studio's behaviour.
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    await context.route('**/*', (route) => (route.request().url().startsWith('file://') ? route.continue() : route.abort()));
    const page = await context.newPage();
    await page.goto(pathToFileURL(STUDIO).href, { waitUntil: 'load' });

    const css = await page.evaluate(() => [...document.querySelectorAll('style')].map((s) => s.textContent).join('\n'));
    assert.ok(css.length > 0, 'the studio parsed no stylesheet at all');
    assert.ok(!/@font-face/i.test(css), 'the studio must not load a webfont; §15 names Geist with a local fallback stack');
    assert.ok(!/fonts\.googleapis|fonts\.gstatic/i.test(css));
    assert.ok(!/url\(\s*['"]?https?:/i.test(css), 'the studio stylesheet reaches the network');

    // §15 / D11: the studio's own stylesheet never touches the artifact
    // namespace. The artifact theme travels inside the document as a string for
    // the emitter, which is why this has to be asked of the parsed stylesheet.
    const stVars = [...new Set([...css.matchAll(/--st-[a-z0-9-]+/g)].map((m) => m[0]))];
    const ppVars = [...new Set([...css.matchAll(/--pp-[a-z0-9-]+/g)].map((m) => m[0]))];
    assert.ok(stVars.length > 0, 'the studio stylesheet declares no --st-* variables at all');
    assert.deepEqual(ppVars, [], `the studio stylesheet reaches into the artifact namespace: ${ppVars.join(', ')}`);
  } finally {
    await browser.close();
  }
});

test('the parsed document is one document with nothing left to fetch', async (t) => {
  const chromium = await loadChromium();
  if (!chromium) return t.skip('playwright is not linked in node_modules');
  if (!existsSync(STUDIO)) return t.skip('dist/pitchproof-studio.html has not been built');

  const html = readFileSync(STUDIO, 'utf8');
  assert.ok(html.startsWith('<!doctype html>') || html.startsWith('<!DOCTYPE html>'));

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    await context.route('**/*', (route) => (route.request().url().startsWith('file://') ? route.continue() : route.abort()));
    const page = await context.newPage();
    await page.goto(pathToFileURL(STUDIO).href, { waitUntil: 'load' });

    const shape = await page.evaluate(() => ({
      htmlElements: document.querySelectorAll('html').length,
      externalScripts: document.querySelectorAll('script[src]').length,
      externalStyles: document.querySelectorAll('link[rel="stylesheet"], link[rel="preload"], link[rel="prefetch"]').length,
      // An iframe is fine and is how the live preview keeps the artifact's
      // `--pp-*` theme out of the studio's `--st-*` chrome (§15, D11). What
      // would not be fine is one that fetches: the preview is written into
      // directly, like the presenter window (D16).
      fetchingFrames: [...document.querySelectorAll('iframe')]
        .filter((f) => {
          const src = f.getAttribute('src');
          return (src && src !== 'about:blank') || f.hasAttribute('srcdoc');
        }).length,
      remoteImages: [...document.querySelectorAll('img[src]')].filter((i) => !i.getAttribute('src').startsWith('data:')).length,
      baseTags: document.querySelectorAll('base').length,
    }));
    assert.deepEqual(shape, {
      htmlElements: 1,
      externalScripts: 0,
      externalStyles: 0,
      fetchingFrames: 0,
      remoteImages: 0,
      baseTags: 0,
    });
  } finally {
    await browser.close();
  }
});
