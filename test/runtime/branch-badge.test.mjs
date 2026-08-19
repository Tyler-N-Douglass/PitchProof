/**
 * The off-spine indicator carries the client's words, whole.
 *
 * §11 requires the badge to show *"the objection in the client's words"* — it
 * is what tells the presenter and the room which question they jumped to. It
 * was one `nowrap` line under a `max-width: min(60ch, 70vw)`, and the §20
 * critic measured what that did to a real corpus objection:
 *
 *   lg (1600x900)  clientWidth 325  scrollWidth 359   cut 34px
 *   sm (390x844)   clientWidth 164  scrollWidth 359   cut 195px (119% of the box)
 *
 * On screen at 1600px, with the rest of the stage empty:
 *
 *   Your fouling margin assumptions are more optimistic t…  R to return
 *
 * The second half of the finding is the one that generalises. The badge is
 * rendered by the runtime rather than by a layout, so it carried no
 * `data-pp-tx`, no `SceneMeasurement` box existed for it, and `TEXT_OVERFLOW`
 * could not fire on it at any severity, at any breakpoint, ever. **The
 * detector's population is defined by the thing being measured**, so runtime
 * chrome that renders client copy has to be in it — otherwise the blind spot is
 * permanent and silent.
 *
 * This drives the real emitted artifact in Chromium, because both halves of the
 * finding are about what the browser does with the CSS, and neither is visible
 * to a unit test over the VNode tree.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

import { buildCorpusProof } from '../fixtures/corpus/proof.mjs';
import { corpusClock } from '../fixtures/corpus/index.mjs';
import { emit } from '../../src/emit/index.js';
import { registerAllLayouts } from '../../src/scene/index.js';
import { buildRuntime } from '../../scripts/build.mjs';
import { BREAKPOINTS } from '../../src/core/contracts.js';

registerAllLayouts();

async function loadChromium() {
  try { return (await import('playwright')).chromium; } catch { return null; }
}

test('the branch badge shows the whole objection at every breakpoint', async (t) => {
  const chromium = await loadChromium();
  if (!chromium) return t.skip('playwright is not linked in node_modules');

  const runtime = buildRuntime();
  const proof = await buildCorpusProof();
  const result = await emit(proof, proof.emitOptions, {
    runtimeJs: runtime.js, runtimeCss: runtime.css, clock: corpusClock(),
  });
  assert.ok(result.ok, result.ok ? '' : String(result.error));

  // The longest objection in the deck — the one most likely to be cut, and the
  // one the critic screenshotted.
  const branch = [...proof.branches].sort((a, b) => (b.objection || '').length - (a.objection || '').length)[0];
  assert.ok(branch && branch.objection.length > 40, 'no objection long enough to test truncation');

  const dir = mkdtempSync(join(tmpdir(), 'pp-badge-'));
  const file = join(dir, 'artifact.html');
  writeFileSync(file, result.value.html);

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    await context.route('**/*', (route) => (route.request().url().startsWith('file://')
      ? route.continue() : route.abort()));
    const page = await context.newPage();

    /** @type {string[]} */
    const problems = [];
    for (const bp of BREAKPOINTS) {
      await page.setViewportSize({ width: bp.width, height: bp.height });
      await page.goto(pathToFileURL(file).href, { waitUntil: 'load' });
      await page.evaluate((id) => window.__PITCHPROOF__.runtime.run('jump', id), branch.id);
      await page.waitForFunction(() => !!document.querySelector('.pp-branch-badge-label'), null, { timeout: 5000 });

      const badge = await page.evaluate(() => {
        const el = document.querySelector('.pp-branch-badge-label');
        return {
          text: (el.textContent || '').trim(),
          clientWidth: Math.round(el.clientWidth),
          scrollWidth: Math.round(el.scrollWidth),
          clientHeight: Math.round(el.clientHeight),
          scrollHeight: Math.round(el.scrollHeight),
          tx: el.getAttribute('data-pp-tx'),
        };
      });

      assert.equal(badge.text, branch.objection,
        `at ${bp.id} the badge does not carry the objection verbatim`);
      assert.equal(badge.tx, 'branchBadge',
        `at ${bp.id} the badge carries no data-pp-tx, so §22.2 cannot measure it`);

      if (badge.scrollWidth > badge.clientWidth) {
        problems.push(`${bp.id}: cut ${badge.scrollWidth - badge.clientWidth}px horizontally `
          + `(${badge.clientWidth} of ${badge.scrollWidth})`);
      }
      if (badge.scrollHeight > badge.clientHeight) {
        problems.push(`${bp.id}: cut ${badge.scrollHeight - badge.clientHeight}px vertically `
          + `(${badge.clientHeight} of ${badge.scrollHeight})`);
      }
    }
    assert.deepEqual(problems, [],
      `the client's own objection is cut on stage:\n  ${problems.join('\n  ')}`);
  } finally {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a branch nobody named says so, rather than showing its internal id', async () => {
  // CRITIQUE-3 P12: the jump index falls back to the branch id as a display
  // label, so a branch with `objection: ''` put `bn_0c0a82c55c49` on stage in
  // front of the room. The badge says what is true instead.
  const { Runtime } = await import('../../src/runtime/runtime.js');
  const { toHtml } = await import('../../src/core/vdom.js');

  const proof = await buildCorpusProof();
  const unnamed = proof.branches[0];
  unnamed.objection = '';
  unnamed.aliases = [];

  const runtime = new Runtime(proof);
  runtime.go({ type: 'jump', branchId: unnamed.id });
  const html = toHtml(runtime.renderBranchBadge());

  assert.ok(!html.includes(unnamed.id.replace(/^bn_/, '') + '<'),
    `the badge printed the branch id to the room: ${html}`);
  assert.match(html, /Unnamed branch/);
  assert.match(html, /data-pp-unnamed/);
});
