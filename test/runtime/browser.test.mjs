/**
 * The runtime, in a real browser, from `file://`, with the network blocked.
 *
 * Everything else in `test/runtime/` runs the runtime headlessly against a
 * document double. That proves the wiring; it does not prove the artifact
 * opens. This does: it writes a document containing nothing but the bundled
 * runtime and a pre-rendered first paint, opens it from disk in Chromium with
 * every request refused, and drives it from the keyboard.
 *
 * `scripts/verify-offline.mjs` (L10) does this against a real emitted artifact.
 * This test does it against the runtime alone, so a regression in L2 is caught
 * by L2's own suite rather than surfacing later as an emitter failure.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { bundle } from '../../scripts/lib/bundler.mjs';
import { Runtime } from '../../src/runtime/runtime.js';
import { toHtml } from '../../src/core/vdom.js';
import { PRERENDERED_ATTR, STAGE_ROOT_ID } from '../../src/runtime/host.js';
import { makeProof } from '../fixtures/make-proof.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Playwright is a dev dependency; skip cleanly where it is not linked. */
async function loadChromium() {
  try {
    const pw = await import('playwright');
    return pw.chromium;
  } catch {
    return null;
  }
}

/**
 * Build a self-contained document: the runtime bundle, the artifact stylesheet,
 * the proof as an inline JSON payload, and the opening beat pre-rendered so the
 * page paints before any script runs.
 * @param {import('../../src/core/contracts.d.ts').Proof} proof
 * @returns {string}
 */
function buildDocument(proof) {
  const { code } = bundle({
    entry: join(ROOT, 'src/runtime/index.js'),
    root: join(ROOT, 'src'),
    global: 'PitchProofRuntime',
  });
  const css = readFileSync(join(ROOT, 'src/runtime/runtime.css'), 'utf8');
  const runtime = new Runtime(proof);
  const firstPaint = toHtml(runtime.render());
  const payload = JSON.stringify(proof).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>PitchProof runtime smoke</title>
<style>${css}</style>
</head>
<body>
<div id="${STAGE_ROOT_ID}" ${PRERENDERED_ATTR}>${firstPaint}</div>
<script id="pp-model" type="application/json">${payload}</script>
<script>${code}</script>
<script>
(function () {
  var proof = JSON.parse(document.getElementById('pp-model').textContent);
  var booted = PitchProofRuntime.boot({ proof: proof, document: document, window: window });
  window.__pp = booted;
  window.__ppEvents = [];
  booted.runtime.on('change', function (e) { window.__ppEvents.push(e.reason); });
})();
</script>
</body>
</html>`;
}

test('the runtime boots from file:// with the network blocked and drives from the keyboard', async (t) => {
  const chromium = await loadChromium();
  if (!chromium) return t.skip('playwright is not linked in node_modules');

  const proof = makeProof();
  const dir = mkdtempSync(join(tmpdir(), 'pp-browser-'));
  const file = join(dir, 'smoke.html');
  writeFileSync(file, buildDocument(proof));

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    /** @type {string[]} */
    const attempted = [];
    // Refuse everything that is not the document itself. A single attempt is a
    // failure: §1.1 makes "verifiably inert on the network" a product law.
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith('file://')) { route.continue(); return; }
      attempted.push(url);
      route.abort();
    });
    const page = await context.newPage();
    page.on('requestfailed', (r) => { if (!r.url().startsWith('file://')) attempted.push(r.url()); });
    /** @type {string[]} */
    const consoleErrors = [];
    page.on('pageerror', (e) => consoleErrors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

    await page.goto(pathToFileURL(file).href, { waitUntil: 'load' });
    await page.waitForFunction(() => Boolean(window.__pp));

    assert.deepEqual(attempted, [], `the runtime attempted ${attempted.length} network request(s): ${attempted.join(', ')}`);
    assert.deepEqual(consoleErrors, [], consoleErrors.join('\n'));

    // The first paint was already in the document, so the scene is on screen.
    const headline = await page.textContent('.pp-scene');
    assert.ok(headline && headline.includes('Headline for sc_spine_0'), headline);

    // Adopting the pre-render means no repaint happened on boot.
    const events = await page.evaluate(() => window.__ppEvents);
    assert.deepEqual(events, [], 'boot must hydrate, not repaint');

    /** @returns {Promise<{hash: string, sequence: string, beat: string}>} */
    const stageState = () => page.evaluate(() => {
      const el = document.querySelector('.pp-stage');
      return {
        hash: el.getAttribute('data-pp-hash'),
        sequence: el.getAttribute('data-pp-sequence'),
        beat: el.getAttribute('data-pp-beat'),
      };
    });

    const atStart = await stageState();
    assert.equal(atStart.sequence, 'spine');
    assert.equal(atStart.beat, '0');

    // Forward, then back, restores the exact state — §17.9 in a real browser.
    await page.keyboard.press('ArrowRight');
    const afterForward = await stageState();
    assert.notEqual(afterForward.hash, atStart.hash);
    assert.equal(afterForward.beat, '1');
    await page.keyboard.press('ArrowLeft');
    assert.deepEqual(await stageState(), atStart);

    // Space advances, arrow-down moves a scene.
    await page.keyboard.press('Space');
    assert.equal((await stageState()).beat, '1');
    await page.keyboard.press('ArrowDown');
    assert.equal((await stageState()).beat, '0');

    // The blank screen covers the deck without moving it.
    const beforeBlank = await stageState();
    await page.keyboard.press('b');
    assert.equal(await page.locator('.pp-blank').count(), 1);
    assert.equal(await page.locator('.pp-stage--blank').count(), 1);
    await page.keyboard.press('ArrowRight');
    assert.equal((await stageState()).beat, beforeBlank.beat, 'the deck must not advance behind a blank screen');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.pp-blank').count(), 0);

    // The help overlay opens, traps focus and closes.
    await page.keyboard.press('?');
    assert.equal(await page.locator('.pp-overlay--help').count(), 1);
    const helpText = await page.textContent('.pp-overlay--help');
    assert.ok(helpText.includes('Next beat'));
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.pp-overlay--help').count(), 0);

    // A jump into a branch shows the badge, and R returns to the spine.
    await page.evaluate(() => window.__pp.runtime.run('jump', 'bn_approvals'));
    assert.equal((await stageState()).sequence, 'bn_approvals');
    assert.equal(await page.locator('.pp-branch-badge').count(), 1);
    await page.keyboard.press('r');
    assert.equal((await stageState()).sequence, 'spine');

    // A full keyboard walk of the whole deck leaves the runtime on the spine
    // with an empty return stack and no errors.
    await page.keyboard.press('Home');
    for (let i = 0; i < 120; i++) await page.keyboard.press('ArrowRight');
    const end = await page.evaluate(() => ({
      sequence: window.__pp.runtime.nav.sequenceId,
      depth: window.__pp.runtime.nav.stack.length,
    }));
    assert.equal(end.sequence, 'spine');
    assert.equal(end.depth, 0);

    assert.deepEqual(attempted, [], `network requests attempted during the walk: ${attempted.join(', ')}`);
    assert.deepEqual(consoleErrors, [], consoleErrors.join('\n'));
  } finally {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reduced motion is honoured in the browser', async (t) => {
  const chromium = await loadChromium();
  if (!chromium) return t.skip('playwright is not linked in node_modules');

  const dir = mkdtempSync(join(tmpdir(), 'pp-browser-rm-'));
  const file = join(dir, 'smoke.html');
  writeFileSync(file, buildDocument(makeProof()));

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await context.newPage();
    await page.goto(pathToFileURL(file).href, { waitUntil: 'load' });
    await page.waitForFunction(() => Boolean(window.__pp));

    const ms = await page.evaluate(() => document.documentElement.style.getPropertyValue('--pp-transition-ms'));
    assert.equal(ms.trim(), '0ms');
    assert.equal(await page.getAttribute('html', 'data-pp-reduced-motion'), 'true');
  } finally {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
