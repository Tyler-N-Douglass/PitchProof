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
 *  2b. A preformatted run (`ContentBlock.pre`) is drawn on the number of lines
 *     the model reports for it. The container check above is about width; this
 *     one is about what the model then does with it, and `pre` is where the two
 *     can come apart on their own — a run whose newlines and runs of spaces the
 *     browser keeps and the model collapses is reported short, in the one
 *     direction §22.2 forbids, for exactly the content most likely to be wide.
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
import { layoutText } from '../../src/core/text-metrics.js';
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
  // The artifact's own order (`src/emit/document.js`): the runtime sheet first
  // with its neutral defaults, the brand theme over it, the scene sheet last.
  // Both sheets declare `--pp-font-*` on `:root`, so a page that loaded them
  // the other way round would lay every run out in `system-ui` while the model
  // measured the prospect's faces — which is what this file exists to catch.
  const html = '<!doctype html><meta charset="utf-8">'
    + `<style>${RUNTIME_CSS}</style>`
    + `<style>${theme.css}</style>`
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

/**
 * Every `[data-pp-tx="pre"]` run in one scene, with what Chromium made of it:
 * the CSS that applied, the number of line boxes it drew, and the x of two
 * characters the source lines up in the same column.
 * @param {string} sceneId
 * @param {{index: number, a: number, b: number}[]} columnProbes
 * @returns {Promise<any[]>}
 */
async function readPreRuns(sceneId, columnProbes) {
  return page.evaluate(({ id, probes }) => {
    const root = document.querySelector(`[data-pp-scene="${id}"]`);
    return [...root.querySelectorAll('[data-pp-tx="pre"]')].map((el, index) => {
      const cs = getComputedStyle(el);
      const range = document.createRange();
      range.selectNodeContents(el);
      // One rect per line box. Deduped by their top edge, because a range that
      // spans several text fragments can report a rect per fragment.
      const tops = [...new Set([...range.getClientRects()]
        .filter((r) => r.height > 0)
        .map((r) => Math.round(r.top * 10) / 10))];
      const node = el.firstChild;
      /** The left edge of the character at `offset` in the run. */
      const charLeft = (offset) => {
        const r = document.createRange();
        r.setStart(node, offset);
        r.setEnd(node, offset + 1);
        const b = r.getBoundingClientRect();
        return { left: Math.round(b.left * 100) / 100, top: Math.round(b.top * 100) / 100 };
      };
      const columns = probes.filter((p) => p.index === index)
        .map((p) => ({ a: charLeft(p.a), b: charLeft(p.b) }));
      return {
        text: el.textContent,
        whiteSpace: cs.whiteSpace,
        fontFamily: cs.fontFamily,
        lineClamp: cs.webkitLineClamp || cs.getPropertyValue('-webkit-line-clamp'),
        lineBoxes: tops.length,
        columns,
      };
    });
  }, { id: sceneId, probes: columnProbes });
}

/**
 * The absolute offsets, within one run, of two characters the source puts in
 * the same column on two different lines. Returns nothing when the run has no
 * such pair, so the probe describes the fixture rather than demanding one.
 * @param {string} text
 * @returns {{a: number, b: number}|null}
 */
function alignedColumnPair(text) {
  const lines = text.split('\n');
  let base = 0;
  /** @type {{col: number, at: number}[]} */
  const marks = [];
  for (const line of lines) {
    // A column the author lined up: a token that follows a run of two or more
    // spaces, which is whitespace `white-space: normal` would have collapsed.
    const m = /\s{2,}(\S)/g;
    let hit;
    while ((hit = m.exec(line)) !== null) marks.push({ col: hit.index + hit[0].length - 1, at: base + hit.index + hit[0].length - 1 });
    base += line.length + 1;
  }
  for (let i = 0; i < marks.length; i++) {
    for (let j = i + 1; j < marks.length; j++) {
      if (marks[i].col === marks[j].col && marks[i].at !== marks[j].at) return { a: marks[i].at, b: marks[j].at };
    }
  }
  return null;
}

test('a preformatted run keeps its columns and is measured on the lines Chromium draws', async (t) => {
  if (!available) return t.skip('Chromium unavailable');
  const { html, scenes } = buildPage();
  const monoFamily = brandFixture().faces.find((f) => f.role === 'mono').family;

  /** @type {string[]} */
  const wrong = [];
  /** @type {string[]} */
  const collapsed = [];
  let runs = 0;
  let proseWouldUnderReport = 0;
  let alignments = 0;

  for (const bp of BREAKPOINTS) {
    page = await browser.newPage({ viewport: { width: bp.width, height: bp.height }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'load' });

    for (const { id, testCase, ctx } of scenes) {
      const measurement = measureScene(buildScene({ ...testCase, id }), ctx, bp.id);
      const model = measurement.boxes.filter((b) => b.role === 'pre');
      if (model.length === 0) continue;

      /** @type {{index: number, a: number, b: number}[]} */
      const probes = [];
      model.forEach((box, index) => {
        const pair = alignedColumnPair(box.text);
        if (pair) probes.push({ index, a: pair.a, b: pair.b });
      });

      const drawn = await readPreRuns(id, probes);
      assert.equal(drawn.length, model.length,
        `${bp.id} ${id}: Chromium draws ${drawn.length} preformatted runs, the model reports ${model.length}`);

      for (let i = 0; i < model.length; i++) {
        const box = model[i];
        const el = drawn[i];
        runs++;

        // The three halves of the change, checked where they are visible: the
        // whitespace survives into the page, it is set in the brand's mono
        // face, and the text the model measured is the text the page holds.
        assert.equal(el.whiteSpace, 'pre-wrap', `${bp.id} ${id}: a pre run rendered with white-space: ${el.whiteSpace}`);
        assert.ok(el.fontFamily.replace(/["\']/g, '').startsWith(monoFamily),
          `${bp.id} ${id}: a pre run is set in ${el.fontFamily}, not the brand's mono face`);
        assert.equal(el.text, box.text, `${bp.id} ${id}: the measured text is not the rendered text, byte for byte`);
        assert.equal(box.whiteSpace, 'pre-wrap', `${bp.id} ${id}: the model does not report the pre-wrap to the detector`);
        assert.ok(el.lineClamp === 'none' || el.lineClamp === '',
          `${bp.id} ${id}: this check assumes no clamp on a pre run, got ${el.lineClamp}`);

        // 1. The line count the detector will divide the box height by.
        const laid = layoutText(box.text, box.style, {
          maxWidthPx: box.containerWidthPx,
          whiteSpace: box.whiteSpace,
          overflowWrap: box.overflowWrap,
        });
        if (laid.lineCount !== el.lineBoxes) {
          wrong.push(`${bp.id} ${id}: model lays the pre run out on ${laid.lineCount} lines, Chromium draws ${el.lineBoxes} (${box.containerWidthPx.toFixed(1)}px, ${box.style.fontSizePx}px ${box.style.family})`);
        }

        // 2. The same run measured as prose — what the deck reported before
        // `pre` was read. It is allowed to be right by luck on a one-line run;
        // it must never claim *more* lines than the browser draws, and on at
        // least one run in this deck it has to claim fewer, or this test is not
        // guarding anything.
        const asProse = layoutText(box.text, box.style, {
          maxWidthPx: box.containerWidthPx,
          overflowWrap: box.overflowWrap,
        });
        if (asProse.lineCount < el.lineBoxes) proseWouldUnderReport++;
        else if (asProse.lineCount > el.lineBoxes) {
          collapsed.push(`${bp.id} ${id}: measuring the pre run as prose claims ${asProse.lineCount} lines against Chromium's ${el.lineBoxes}`);
        }

        // 3. Two characters the source puts in the same column are drawn in the
        // same column. This is the alignment the `<pre>` was written for, and
        // the thing a proportional face or a collapsed run of spaces destroys.
        for (const col of el.columns) {
          alignments++;
          assert.ok(Math.abs(col.a.left - col.b.left) <= 0.5,
            `${bp.id} ${id}: two characters the source lines up are drawn at x=${col.a.left} and x=${col.b.left}`);
          assert.ok(col.a.top !== col.b.top, `${bp.id} ${id}: the column probe landed on one line`);
        }
      }
    }
    await page.close();
    page = null;
  }

  assert.deepEqual(wrong, [], `the model and Chromium disagree about a preformatted run's line count:\n  ${wrong.join('\n  ')}`);
  assert.deepEqual(collapsed, [], `measuring a pre run as prose over-reported, which is not the failure this guards:\n  ${collapsed.join('\n  ')}`);
  assert.ok(runs >= BREAKPOINTS.length, `only ${runs} preformatted runs were drawn; the fixture no longer carries one`);
  assert.ok(alignments > 0, 'no aligned column pair was checked; the fixture no longer lines anything up');
  assert.ok(proseWouldUnderReport > 0,
    'measuring these runs as prose reported the same line count everywhere, so this deck does not exercise the defect');
});

test('a captured <pre> reaches the stage from the capture with its columns intact', async (t) => {
  if (!available) return t.skip('Chromium unavailable');
  // End to end from the prospect's page rather than from a block written here:
  // `test/fixtures/specimen/docs.html` is a documentation page carrying a real
  // `<pre><code>` scripting sample, L6 captures it as a paragraph whose
  // whitespace is significant (`pre`, API.md Part 3b), and this is the half
  // that has to make it legible on the stage.
  const { buildSpecimen } = await import('../../src/specimen/index.js');
  const { fixtureHtml } = await import('../fixtures/specimen/corpus.mjs');

  const specimen = buildSpecimen({
    html: fixtureHtml('docs.html'),
    url: 'https://www.northwind-industrial.example/docs/autotune/',
    capturedAt: '2026-01-14T09:00:00.000Z',
    id: 'sp_docs_pre',
  });
  const captured = specimen.blocks.find((b) => b.type === 'paragraph' && b.pre === true);
  assert.ok(captured, 'the capture no longer carries the scripting sample');
  assert.ok(captured.text.includes('\n'), 'the captured sample has no line structure to keep');

  const testCase = { layout: 'splitBeforeAfter', specimen, renditions: [], headline: 'Their scripting guide, as captured', subhead: null };
  const scene = buildScene(testCase);
  const ctx = contextFor(scene, { specimen, renditions: [] });
  const theme = compileTheme(brandFixture());
  const html = '<!doctype html><meta charset="utf-8">'
    + `<style>${RUNTIME_CSS}</style>`
    + `<style>${theme.css}</style>`
    + `<style>${SCENES_CSS}</style>`
    + '<style>.pp-case{height:100vh}</style>'
    + `<body><div class="pp-case"><div class="pp-stage"><div class="pp-stage-scene">`
    + `<div class="pp-scene" data-pp-scene="${scene.id}" data-pp-layout="${scene.layout}">${toHtml(renderSceneTree(scene, ctx))}</div>`
    + '</div></div></div></body>';

  let checked = 0;
  for (const bp of BREAKPOINTS) {
    page = await browser.newPage({ viewport: { width: bp.width, height: bp.height }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'load' });

    const model = measureScene(scene, ctx, bp.id).boxes.filter((b) => b.role === 'pre');
    assert.equal(model.length, 1, `${bp.id}: the captured sample is not on the stage as one preformatted run`);
    const [drawn] = await readPreRuns(scene.id, []);

    // The prospect's characters, on the prospect's lines, in a mono face.
    assert.equal(drawn.text, captured.text, `${bp.id}: the stage does not carry the captured sample verbatim`);
    assert.equal(drawn.whiteSpace, 'pre-wrap', `${bp.id}: the sample's whitespace is not preserved`);
    assert.ok(/Courier New/.test(drawn.fontFamily), `${bp.id}: the sample is set in ${drawn.fontFamily}`);
    assert.ok(drawn.lineBoxes >= captured.text.split('\n').length,
      `${bp.id}: ${captured.text.split('\n').length} source lines are drawn on ${drawn.lineBoxes} line boxes`);

    // And the detector is told the same thing.
    const laid = layoutText(drawn.text, model[0].style, {
      maxWidthPx: model[0].containerWidthPx,
      whiteSpace: model[0].whiteSpace,
      overflowWrap: model[0].overflowWrap,
    });
    assert.equal(laid.lineCount, drawn.lineBoxes,
      `${bp.id}: the model lays the captured sample out on ${laid.lineCount} lines, Chromium draws ${drawn.lineBoxes}`);
    checked++;
    await page.close();
    page = null;
  }
  assert.equal(checked, BREAKPOINTS.length);
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
