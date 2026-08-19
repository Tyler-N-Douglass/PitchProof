/**
 * **The geometry the model reports is the geometry the browser gives it.**
 *
 * §17.4 asks for recall ≥ 0.98 on severity-1 overflow and §22.2 calls text
 * overflow after font substitution "the defect that makes a proof look amateur
 * in front of a CMO, and it is invisible until it isn't". CRITIQUE-2's C1
 * measured the recall the deck actually shipped with — 0.65 — and found the
 * cause upstream of the detector: `measureScene` was handing it containers that
 * did not exist. Six scene headlines were told they had 350px at `sm` where
 * Chromium gave them 131; a ledger name was told it had 328px in a box Chromium
 * drew five pixels wide.
 *
 * Everything that let that happen was self-consistent. `boxGeometry` matched
 * the token table, `scenes.css` matched the token table, and
 * `test/scene/css-agreement.test.mjs` asserted the two matched each other. What
 * nothing in the suite did was ask a browser. This file asks.
 *
 * **Why this, and not "recall is above 0.98 today".** A recall number over one
 * corpus is a fact about that corpus's sentences: rewrite a headline and it
 * moves. The property underneath it does not. If every container the model
 * reports is the container Chromium draws, then recall is whatever the text
 * layout engine's accuracy makes it, and it cannot silently rot when the
 * stylesheet gains a flex row or a `max-width`. So the assertion here is the
 * geometry, not the recall — and it is an assertion a stylesheet change breaks
 * on the next run rather than in front of a client.
 *
 * **The three shapes it checks.**
 *
 *  1. Every element carrying `data-pp-box` is drawn with the inner box
 *     `boxGeometry()` claims for that slot.
 *  2. Every element carrying `data-pp-tx` is drawn with the container width
 *     `collectTextBoxes()` reports for it — the number `detectBoxOverflow()`
 *     divides by.
 *  3. An element the stylesheet sizes to its own words — the `inline-flex`
 *     provenance pill and the `inline-block` CTA, and nothing else — declares
 *     `data-pp-fit`, and is checked as a *bound* rather than an equality: the
 *     model reports the room the element has, the browser never renders it
 *     wider than that room, and the room itself is the parent's box less the
 *     element's own gutters. §22.2's direction rule is why it is a bound: where
 *     the two can honestly differ, the model must claim *less* room than the
 *     page has, never more, so the error falls towards a warning that is not
 *     needed rather than a truncation nobody sees. The inventory is asserted,
 *     so growing it is a decision rather than an accident.
 *
 * Nothing here is measured against the model. The ground truth is Chromium's
 * layout of the same tree the artifact paints, under the same two stylesheets
 * the artifact inlines, at the three viewports `BREAKPOINTS` declares.
 *
 * Skipped, loudly, where Chromium is unavailable — the same contract
 * `test/validate/overflow-browser.test.mjs` uses.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { BREAKPOINTS } from '../../src/core/contracts.js';
import { toHtml } from '../../src/core/vdom.js';
import { compileTheme } from '../../src/brand/theme.js';
import {
  buildScene, renderSceneTree, measureScene, boxGeometry, SLOTS, TYPE_ROLES,
} from '../../src/scene/index.js';
import { layoutCases, contextFor, brandFixture } from '../fixtures/scene/content.mjs';

const SCENES_CSS = readFileSync(new URL('../../src/scene/scenes.css', import.meta.url).pathname, 'utf8');
const RUNTIME_CSS = readFileSync(new URL('../../src/runtime/runtime.css', import.meta.url).pathname, 'utf8');

/**
 * How far a measured number may sit from Chromium's before it is a defect.
 *
 * Sub-pixel: Chromium reports `clientWidth` as an integer and lays fractional
 * grid tracks out at device-pixel precision, so a track of 245.6px comes back
 * as 245 or 246. Anything larger than a rounding of the same number is a
 * different number, which is the whole subject of this file.
 */
const TOLERANCE_PX = 1.01;

/** Slots drawn in SVG design units, whose px box is the drawing's scale. */
const SVG_SLOTS = new Set(['mapCanvas', 'mapText']);
/**
 * Slots no element carries, because they are intermediate terms the other
 * formulas are built out of rather than boxes a layout draws: `splitCol` is
 * what `splitPanelHead` and `splitCell` divide, `fanGrid` is what `fanCard`
 * divides. Both are therefore checked by the boxes derived from them — a wrong
 * `splitCol` is a wrong `splitCell`, at every breakpoint, in this same run.
 */
const DERIVED_SLOTS = new Set(['splitCol', 'fanGrid']);
/** Text roles drawn inside the SVG, for the same reason. */
const SVG_ROLES = new Set(Object.keys(TYPE_ROLES).filter((r) => TYPE_ROLES[r].svg));

let browser = null;
let page = null;
let available = true;

before(async () => {
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch();
  } catch (e) {
    available = false;
    console.log(`scene geometry cross-check: skipped — Chromium is not available here (${e.message})`);
  }
});

after(async () => {
  if (page) await page.close();
  if (browser) await browser.close();
});

/**
 * One page carrying every layout case, in the same wrappers the runtime paints
 * into (`.pp-stage` → `.pp-stage-scene` → `.pp-scene`) so `--pp-stage-pad` and
 * the scroll container are the artifact's, not this test's.
 *
 * Each case is its own full-height stage, stacked down the document. The stage
 * is `height: 100%` of a `100vh` block per case, so every scene is laid out
 * against the breakpoint's real viewport height exactly as one scene on screen
 * would be.
 *
 * @returns {{html: string, scenes: {id: string, testCase: any, ctx: any}[]}}
 */
function buildPage() {
  const theme = compileTheme(brandFixture());
  /** @type {{id: string, testCase: any, ctx: any}[]} */
  const scenes = [];
  const stages = layoutCases().map((testCase) => {
    const scene = buildScene(testCase);
    const ctx = contextFor(scene, { specimen: testCase.specimen, renditions: testCase.renditions });
    scenes.push({ id: scene.id, testCase, ctx });
    const tree = renderSceneTree(scene, ctx);
    return `<div class="pp-case" data-pp-case="${scene.id}"><div class="pp-stage"><div class="pp-stage-scene">`
      + `<div class="pp-scene" data-pp-scene="${scene.id}" data-pp-layout="${scene.layout}">${toHtml(tree)}</div>`
      + '</div></div></div>';
  });
  const html = '<!doctype html><meta charset="utf-8">'
    + `<style>${theme.css}</style>`
    + `<style>${RUNTIME_CSS}</style>`
    + `<style>${SCENES_CSS}</style>`
    // The only rule this test adds: one viewport-tall stage per case. Nothing
    // here touches a width, a padding or a font.
    + '<style>.pp-case{height:100vh}</style>'
    + `<body>${stages.join('')}</body>`;
  return { html, scenes };
}

/**
 * Read every `data-pp-box` and `data-pp-tx` element of one scene out of the
 * page, with the numbers that decide whether the model was right.
 * @param {string} sceneId
 * @returns {Promise<{boxes: any[], runs: any[]}>}
 */
async function readScene(sceneId) {
  return page.evaluate((id) => {
    const root = document.querySelector(`[data-pp-scene="${id}"]`);
    const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
    /** The content-box width of an element, in CSS px. */
    const contentWidth = (el) => {
      const cs = getComputedStyle(el);
      return el.clientWidth - num(cs.paddingLeft) - num(cs.paddingRight);
    };
    const isSvg = (el) => typeof el.className !== 'string';

    const boxes = [...root.querySelectorAll('[data-pp-box]')].map((el) => ({
      slot: el.getAttribute('data-pp-box'),
      n: el.getAttribute('data-pp-n'),
      width: contentWidth(el),
      svg: isSvg(el),
    }));

    const runs = [...root.querySelectorAll('[data-pp-tx]')].map((el) => {
      const parent = el.parentElement;
      const cs = getComputedStyle(el);
      return {
        role: el.getAttribute('data-pp-tx'),
        text: (el.textContent || '').trim(),
        fit: el.getAttribute('data-pp-fit'),
        width: contentWidth(el),
        // For a fitted element: the room its parent gives it, less its own
        // gutters. This is the number the model claims, and the number a longer
        // label would fill.
        room: parent
          ? contentWidth(parent)
            - num(cs.paddingLeft) - num(cs.paddingRight)
            - num(cs.borderLeftWidth) - num(cs.borderRightWidth)
            - num(cs.marginLeft) - num(cs.marginRight)
          : null,
        svg: isSvg(el),
      };
    });
    return { boxes, runs };
  }, sceneId);
}

test('every box a layout draws is the box boxGeometry reports', async (t) => {
  if (!available) return t.skip('Chromium unavailable');
  const { html, scenes } = buildPage();

  /** @type {Set<string>} */
  const covered = new Set();
  /** @type {string[]} */
  const wrong = [];

  for (const bp of BREAKPOINTS) {
    page = await browser.newPage({ viewport: { width: bp.width, height: bp.height }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'load' });

    for (const { id } of scenes) {
      const { boxes } = await readScene(id);
      // The ledger takes vertical room from everything above it; a box's
      // *width* never depends on it, which is what is asserted here.
      const ledger = boxes.some((b) => b.slot === 'provenanceLedger');
      for (const box of boxes) {
        if (box.svg || SVG_SLOTS.has(box.slot)) continue;
        covered.add(box.slot);
        const model = boxGeometry(box.slot, bp.id, {
          n: box.n === null ? undefined : Number(box.n),
          ledger: box.slot === 'provenanceLedger' ? false : ledger,
        });
        const delta = model.widthPx - box.width;
        if (Math.abs(delta) > TOLERANCE_PX) {
          wrong.push(`${bp.id} ${id} slot "${box.slot}"(n=${box.n}): model ${model.widthPx.toFixed(2)}px, Chromium ${box.width}px (${delta > 0 ? '+' : ''}${delta.toFixed(2)})`);
        }
      }
    }
    await page.close();
    page = null;
  }

  assert.deepEqual(wrong, [], `boxGeometry disagrees with Chromium:\n  ${wrong.join('\n  ')}`);

  // A pass that measured three slots would prove nothing. Every slot the
  // geometry answers for, apart from the two drawn in SVG design units, has to
  // have been on the page.
  const missing = SLOTS.filter((s) => !SVG_SLOTS.has(s) && !DERIVED_SLOTS.has(s) && !covered.has(s));
  assert.deepEqual(missing, [], `these slots were never rendered, so nothing checked them: ${missing.join(', ')}`);
});

test('every text container measureScene reports is the container Chromium draws', async (t) => {
  if (!available) return t.skip('Chromium unavailable');
  const { html, scenes } = buildPage();

  /** @type {Set<string>} */
  const covered = new Set();
  /** @type {string[]} */
  const wrong = [];
  /** @type {string[]} */
  const overclaimed = [];
  let checked = 0;

  for (const bp of BREAKPOINTS) {
    page = await browser.newPage({ viewport: { width: bp.width, height: bp.height }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'load' });

    for (const { id, testCase, ctx } of scenes) {
      const measurement = measureScene(buildScene({ ...testCase, id }), ctx, bp.id);
      const { runs } = await readScene(id);

      // The walk order is the same tree in both cases, so the two lists line up
      // run for run. If they ever do not, that is itself the defect: it means
      // the model is describing text the page does not render, or missing text
      // it does.
      assert.equal(runs.length, measurement.boxes.length,
        `${bp.id} ${id}: Chromium shows ${runs.length} text runs, measureScene reports ${measurement.boxes.length}`);

      for (let i = 0; i < runs.length; i++) {
        const run = runs[i];
        const model = measurement.boxes[i];
        assert.equal(run.role, model.role, `${bp.id} ${id} run ${i}: roles differ (${run.role} / ${model.role})`);
        assert.equal(run.text.replace(/\s+/g, ' '), model.text.replace(/\s+/g, ' '),
          `${bp.id} ${id} run ${i}: the measured text is not the rendered text`);
        if (run.svg || SVG_ROLES.has(run.role)) continue;
        checked++;
        covered.add(run.role);

        if (run.fit) {
          // A fitted box: the model reports the room, the browser renders the
          // words. The room must be real (the parent's box less this element's
          // own gutters) and the rendered box must fit inside it.
          const roomDelta = model.containerWidthPx - run.room;
          if (roomDelta > TOLERANCE_PX) {
            overclaimed.push(`${bp.id} ${id} ${run.role}: model claims ${model.containerWidthPx.toFixed(2)}px of room, the page has ${run.room.toFixed(2)}px`);
          }
          if (run.width - model.containerWidthPx > TOLERANCE_PX) {
            wrong.push(`${bp.id} ${id} ${run.role}: Chromium draws ${run.width}px, wider than the ${model.containerWidthPx.toFixed(2)}px the model reports`);
          }
          continue;
        }

        const delta = model.containerWidthPx - run.width;
        if (Math.abs(delta) > TOLERANCE_PX) {
          wrong.push(`${bp.id} ${id} ${run.role}: model ${model.containerWidthPx.toFixed(2)}px, Chromium ${run.width}px (${delta > 0 ? '+' : ''}${delta.toFixed(2)}) — "${run.text.slice(0, 48)}"`);
        }
      }
    }
    await page.close();
    page = null;
  }

  assert.deepEqual(wrong, [], `measureScene disagrees with Chromium:\n  ${wrong.join('\n  ')}`);
  assert.deepEqual(overclaimed, [],
    `a fitted box was told it had room the page does not have — §22.2's error must fall the other way:\n  ${overclaimed.join('\n  ')}`);
  assert.ok(checked > 500, `only ${checked} text runs were checked; the page did not render the deck`);

  // The roles that carry the deck's prose have to be among them, or a pass here
  // says nothing about the case §22.2 is written for.
  for (const role of ['headline', 'subhead', 'panelTitle', 'panelMeta', 'body', 'listItem', 'noteLabel', 'stepLabel', 'provenance']) {
    assert.ok(covered.has(role), `no ${role} run was checked`);
  }
});

test('the inventory of content-sized text boxes is exactly the declared one', async (t) => {
  if (!available) return t.skip('Chromium unavailable');
  const { html, scenes } = buildPage();

  /** @type {Map<string, {role: string, width: number, model: number}[]>} */
  const fitted = new Map();

  for (const bp of BREAKPOINTS) {
    page = await browser.newPage({ viewport: { width: bp.width, height: bp.height }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'load' });
    for (const { id, testCase, ctx } of scenes) {
      const measurement = measureScene(buildScene({ ...testCase, id }), ctx, bp.id);
      const { runs } = await readScene(id);
      for (let i = 0; i < runs.length; i++) {
        const run = runs[i];
        if (!run.fit || run.svg || SVG_ROLES.has(run.role)) continue;
        const list = fitted.get(run.role) || [];
        list.push({ role: run.role, width: run.width, model: measurement.boxes[i].containerWidthPx });
        fitted.set(run.role, list);
      }
    }
    await page.close();
    page = null;
  }

  // Two, and they are the two the stylesheet sizes to their own words: the
  // `inline-flex` provenance pill and the `inline-block` CTA. Every other text
  // box in the deck is checked as an equality by the test above, and the reason
  // this list is asserted rather than merely reported is that each entry is a
  // container the model can only *bound* — a place where §22.2's error has to
  // be made to fall the safe way by hand. Growing the list is a decision.
  assert.deepEqual([...fitted.keys()].sort(), ['cta', 'provenance'],
    'the set of content-sized text boxes changed');

  for (const [role, seen] of fitted) {
    assert.ok(seen.length >= BREAKPOINTS.length, `${role} was only rendered ${seen.length} times`);
    // At least one of them has to actually be narrower than its room, or the
    // shape is not content-sized at all and the declaration is stale.
    assert.ok(seen.some((x) => x.model - x.width > TOLERANCE_PX),
      `${role} filled its container everywhere it was drawn; it is not a fitted box any more`);
  }
});
