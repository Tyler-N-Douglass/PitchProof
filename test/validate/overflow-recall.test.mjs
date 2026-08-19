/**
 * **Per-finding recall of `runPreflight` over the emitted corpus artifact,
 * measured in real Chromium.**
 *
 * CRITIQUE-2's C1 is the §17.4 recall number, and it has been answered in two
 * halves. L8 answered the first: the containers `measureScene` reports are now
 * the containers Chromium draws, checked by `test/scene/geometry-browser.test.mjs`.
 * That took *per-box* recall over this artifact from 0.65 to 0.99.
 *
 * This file answers the second, which L8 reported as L8-D10 and could not fix
 * from its own lane. Per-box recall asks "did the engine notice this box?".
 * **Per-finding recall asks the question the seller actually lives with: did a
 * finding come out for it, one the studio can list, dismiss and auto-fix on its
 * own?** Those two numbers were 0.99 and 0.77, and the gap was entirely
 * L11's: the finding key was `box.elementId`, the *nearest revealable
 * ancestor*, so a headline and a body paragraph that both overflowed inside one
 * panel minted one id, `sortFindings` dropped one as a duplicate, and the
 * seller was shown half the defect. Twenty findings on this corpus.
 *
 * **Why this test and not the planted corpus.** `overflow-corpus.test.mjs`
 * grades the detector against an oracle over hand-planted cases, and it scored
 * 1.0000 all the way through C1 — a planted case has one box per defect, so a
 * key that collapses siblings cannot fail there. The failure needs real content
 * in real layouts, emitted, and a real browser. So the ground truth here is
 * Chromium's layout of the artifact the tool actually ships.
 *
 * **What is asserted, and why it is not a number pinned to this corpus.**
 * Rewrite one headline in the fixture and the recall figure moves; the
 * properties under it do not:
 *
 *  1. **No two boxes share a finding.** Every box Chromium reports as not
 *     fitting is matched by a finding no other box is matched by. This is the
 *     defect, stated directly, and it fails on a key that collapses.
 *  2. **Recall over what the artifact actually cuts is at or above §17.4's
 *     0.98.** Measured 0.9921 on this corpus at the time of writing.
 *  3. **Precision is exact.** Every box the engine reports really does overflow
 *     in Chromium. A recall fix that bought its number with false positives
 *     would fail here.
 *
 * The three population sizes and the residual are printed on every run, so a
 * regression is legible rather than a number moving.
 *
 * **The residual is reported, never rounded away.** Two families of box are
 * missed and both are named in the log:
 *
 *  - Boxes whose overflow Chromium does not cut (`overflow: visible`) — a
 *    numeral whose line box stands two pixels proud of its badge, with nothing
 *    clipped and nothing lost. They are counted in the "not fitting" population
 *    and excluded from the "actually cuts" one, which is why the two numbers
 *    differ.
 *  - A headline whose last line the model packs and Chromium does not, inside
 *    the AFM-versus-rasteriser residual that `overflow-browser.test.mjs`
 *    measures at p95 0.89%. That is a `src/core/text-metrics.js` limit, not a
 *    finding-identity one, and it is not closable from this lane. It is **not**
 *    closed here by narrowing a container to buy the number back: that would
 *    trade a real property for a figure.
 *
 * Skipped, loudly, where Chromium is unavailable — the same contract
 * `overflow-browser.test.mjs` and `geometry-browser.test.mjs` use.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BREAKPOINTS } from '../../src/core/contracts.js';
import { registerAllLayouts } from '../../src/scene/index.js';
import { emit } from '../../src/emit/index.js';
import { buildRuntime } from '../../scripts/build.mjs';
import { runPreflight } from '../../src/validate/index.js';
import { buildCorpusProof } from '../fixtures/corpus/proof.mjs';
import { corpusClock } from '../fixtures/corpus/index.mjs';

/** §17.4's floor, over the boxes the artifact actually cuts. */
const REQUIRED_RECALL = 0.98;

/**
 * A box counts as overflowing when Chromium's own scroll extent exceeds its
 * client box by more than a pixel of rounding — the same predicate
 * `geometry-browser.test.mjs` uses for its tolerance, and the same one
 * CRITIQUE-2 measured C1 with.
 */
const OVER_PX = 1;

let browser = null;
let available = true;
/** @type {any[]} */
let truth = [];
/** @type {Map<string, string[]>} */
let modelBoxes = new Map();
/** @type {any[]} */
let findings = [];

/**
 * Read every `data-pp-tx` box of the scene on stage, reconstructing the same
 * identity `collectTextBoxes` derives — nearest `data-pp-el` ancestor, the
 * geometry slot it sits in, its role — from the DOM rather than from the model,
 * so nothing in the comparison comes from the code under test.
 *
 * Serialised into the page, so it may not close over anything.
 */
const READ_SCENE = () => {
  const scene = document.querySelector('.pp-scene');
  if (!scene) return null;
  const sceneId = scene.getAttribute('data-pp-scene');
  /** @type {Map<string, number>} */
  const slotCounts = new Map();
  const out = [];
  const walk = (el, state) => {
    let next = state;
    if (el.hasAttribute('data-pp-el')) next = { ...next, elementId: el.getAttribute('data-pp-el') };
    if (el.hasAttribute('data-pp-box')) {
      const slot = el.getAttribute('data-pp-box');
      const n = (slotCounts.get(slot) || 0) + 1;
      slotCounts.set(slot, n);
      const group = el.getAttribute('data-pp-container');
      next = { ...next, slot, containerId: group ? `${slot}:${group}` : `${slot}#${n}` };
    }
    if (el.hasAttribute('data-pp-tx')) {
      const text = (el.textContent || '').trim();
      if (text) {
        const cs = getComputedStyle(el);
        out.push({
          sceneId,
          elementId: next.elementId,
          containerId: next.containerId,
          role: el.getAttribute('data-pp-tx'),
          text: text.slice(0, 60),
          overW: el.scrollWidth - el.clientWidth,
          overH: el.scrollHeight - el.clientHeight,
          clientW: el.clientWidth,
          clientH: el.clientHeight,
          overflow: cs.overflow,
          textOverflow: cs.textOverflow,
          clamp: cs.webkitLineClamp,
        });
      }
      return;                       // a text role never nests inside another
    }
    for (const child of el.children) walk(child, next);
  };
  walk(scene, { elementId: null, slot: 'stage', containerId: 'stage#0' });
  return out;
};

/** Chromium cut this box: something is hidden behind a clip, a clamp or an ellipsis. */
const isCut = (b) => b.overflow !== 'visible' || b.clamp !== 'none' || b.textOverflow === 'ellipsis';

before(async () => {
  registerAllLayouts();
  const proof = await buildCorpusProof();
  findings = (await runPreflight(proof, { clock: corpusClock() }))
    .filter((f) => f.code === 'TEXT_OVERFLOW');

  // The model's side of the comparison, keyed by the box each finding names.
  // Two findings on one box (two axes) is legal and expected; two *boxes*
  // sharing one finding id is the defect.
  for (const f of findings) {
    const d = f.detail || {};
    const k = `${f.locus.sceneId}|${d.breakpoint}|${d.elementId || '-'}|${d.role}|${d.orderInElement || 0}`;
    if (!modelBoxes.has(k)) modelBoxes.set(k, []);
    modelBoxes.get(k).push(f.id);
  }

  let chromium = null;
  try {
    ({ chromium } = await import('playwright'));
    browser = await chromium.launch();
  } catch (e) {
    available = false;
    console.log(`overflow recall: skipped — Chromium is not available here (${e.message})`);
    return;
  }

  const rt = buildRuntime();
  const result = await emit(proof, proof.emitOptions, {
    runtimeJs: rt.js, runtimeCss: rt.css, clock: corpusClock(),
  });
  assert.equal(result.ok, true, 'the corpus proof must emit before its artifact can be measured');
  const dir = mkdtempSync(join(tmpdir(), 'pp-recall-'));
  const file = join(dir, 'artifact.html');
  writeFileSync(file, result.value.html);

  /** @type {Map<string, any>} */
  const worst = new Map();
  for (const bp of BREAKPOINTS) {
    const ctx = await browser.newContext({ viewport: { width: bp.width, height: bp.height } });
    // The artifact is offline by construction (§13); anything non-`file://` is
    // a defect L10 owns, and letting it through here would let a slow abort
    // change a measurement.
    await ctx.route('**/*', (r) => (r.request().url().startsWith('file://') ? r.continue() : r.abort()));
    const page = await ctx.newPage();
    await page.goto(pathToFileURL(file).href);
    await page.waitForFunction(() => !!(window.__PITCHPROOF__ && window.__PITCHPROOF__.runtime), null, { timeout: 20000 });

    // Every reachable position, spine and branches, exactly as the rehearsal
    // sweep walks them — the same set `measureDeck` measures.
    const positions = await page.evaluate(() => window.PitchProofRuntime
      .allPositions(window.__PITCHPROOF__.runtime.deck)
      .map((p) => ({ sceneId: p.sceneId, beatIndex: p.beatIndex })));

    for (const pos of positions) {
      await page.evaluate((p) => {
        window.__PITCHPROOF__.runtime.go({ type: 'goToBeat', sceneId: p.sceneId, beatIndex: p.beatIndex });
      }, pos);
      const boxes = await page.evaluate(READ_SCENE);
      if (!boxes) continue;
      /** @type {Map<string, number>} */
      const seen = new Map();
      for (const b of boxes) {
        const pair = `${b.elementId || '-'}|${b.role}`;
        const ordinal = seen.get(pair) || 0;
        seen.set(pair, ordinal + 1);
        const key = `${b.sceneId}|${bp.id}|${b.elementId || '-'}|${b.role}|${ordinal}`;
        const over = b.clientW > 0 && (b.overW > OVER_PX || b.overH > OVER_PX);
        const prior = worst.get(key);
        // A box is measured once per beat; a reveal can change what is on the
        // line, so the worst state the presenter can reach is the true one.
        const better = !prior
          || (over && !prior.over)
          || (over && prior.over && b.overW + b.overH > prior.overW + prior.overH);
        if (better) worst.set(key, { ...b, bp: bp.id, ordinal, over, key });
      }
    }
    await ctx.close();
  }
  truth = [...worst.values()];
});

after(async () => {
  if (browser) await browser.close();
});

test('every box the artifact overflows gets a finding of its own', (t) => {
  if (!available) { t.skip('Chromium unavailable'); return; }

  const overflowing = truth.filter((b) => b.over);
  assert.ok(overflowing.length > 20,
    'the corpus artifact must overflow enough boxes for this to be a measurement');

  /** Findings already spent on another box. A collapsed key shows up here. */
  const spent = new Set();
  const missed = [];
  let matched = 0;
  for (const box of overflowing) {
    const ids = modelBoxes.get(box.key) || [];
    const free = ids.find((id) => !spent.has(id));
    if (free) { spent.add(free); matched++; box.matched = true; } else missed.push(box);
  }

  const share = (pred) => {
    const pop = overflowing.filter(pred);
    const hit = pop.filter((b) => b.matched).length;
    // An empty population has no recall. Printing 1.0000 for it would be the
    // kind of confident wrong number this whole file exists because of.
    return { hit, n: pop.length, text: pop.length ? (hit / pop.length).toFixed(4) : 'n/a (none)', recall: pop.length ? hit / pop.length : null };
  };
  const all = share(() => true);
  const cut = share(isCut);
  const silent = share((b) => isCut(b) && b.textOverflow !== 'ellipsis' && b.clamp === 'none');
  const spurious = [...modelBoxes.keys()].filter((k) => {
    const box = truth.find((b) => b.key === k);
    return !box || !box.over;
  });

  console.log([
    '',
    `overflow recall — emitted corpus artifact, Chromium at ${BREAKPOINTS.map((b) => b.id).join('/')}`,
    `  boxes measured ${truth.length}   TEXT_OVERFLOW findings ${findings.length}   distinct boxes named ${modelBoxes.size}`,
    `  per-finding recall, all boxes Chromium reports not fitting   ${all.hit}/${all.n} = ${all.text}`,
    `  per-finding recall, boxes Chromium actually cuts             ${cut.hit}/${cut.n} = ${cut.text}`,
    `  per-finding recall, cut with no signal to the viewer         ${silent.hit}/${silent.n} = ${silent.text}`,
    `  precision, findings whose box does overflow                  ${modelBoxes.size - spurious.length}/${modelBoxes.size}`,
    '  residual, every box missed:',
    ...missed.map((m) => `    ${m.bp} ${m.sceneId} ${m.elementId} ${m.containerId} ${m.role}#${m.ordinal}`
      + ` overW=${m.overW} overH=${m.overH} box=${m.clientW}x${m.clientH}`
      + ` overflow=${m.overflow} text-overflow=${m.textOverflow} clamp=${m.clamp}`
      + ` ${isCut(m) ? 'CUT' : 'not cut'} "${m.text}"`),
    '',
  ].join('\n'));

  // 1. The defect, stated directly: no finding stands in for two boxes.
  const collapsed = [...modelBoxes.entries()].filter(([, ids]) => new Set(ids).size !== ids.length);
  assert.deepEqual(collapsed.map(([k]) => k), [],
    'two findings on one box must be two axes, never two boxes sharing an id');
  const idOwners = new Map();
  for (const [key, ids] of modelBoxes) for (const id of ids) {
    idOwners.set(id, (idOwners.get(id) || new Set()).add(key));
  }
  assert.deepEqual(
    [...idOwners.entries()].filter(([, keys]) => keys.size > 1).map(([id]) => id),
    [],
    'a finding id names exactly one box',
  );

  // 2. §17.4, over what the artifact actually cuts.
  assert.ok(cut.n > 0, 'the corpus artifact must cut some text for §17.4 to be measurable at all');
  assert.ok(cut.recall >= REQUIRED_RECALL,
    `§17.4 requires recall ≥ ${REQUIRED_RECALL} over the text the artifact cuts; measured ${cut.text}`);

  // 3. And it is not bought with noise.
  assert.deepEqual(spurious, [],
    'every box the engine reports must be one Chromium really does overflow');

  // 4. Whatever is missed must be missed for a reason that is written down,
  //    and the two written-down reasons have shapes. A miss outside both is a
  //    new defect and fails here rather than being absorbed into a percentage.
  //
  //    (a) A box the browser cuts may only be missed by **one line of its own
  //        box** on the vertical axis, which is what the AFM-versus-rasteriser
  //        residual (`overflow-browser.test.mjs`: mean 0.158%, p95 0.890%) can
  //        do — flip the last word onto a line the model packed. It may not be
  //        missed on the width axis at all: a width miss means the engine is
  //        wrong about a line's extent, which the geometry cross-check and that
  //        residual together rule out.
  const oneLine = (m) => {
    const lines = m.clamp === 'none' ? 1 : Math.max(1, Number(m.clamp) || 1);
    return m.clientH > 0 ? (m.clientH / lines) + OVER_PX : OVER_PX;
  };
  const unexplained = missed.filter(isCut)
    .filter((m) => m.overW > OVER_PX || m.overH > oneLine(m));
  assert.deepEqual(
    unexplained.map((m) => `${m.bp} ${m.sceneId} ${m.role}#${m.ordinal} overW=${m.overW} overH=${m.overH}`),
    [],
    'text the artifact cuts may only be missed by a single line of vertical residual, and never by width',
  );

  //    (b) A box the browser does *not* cut may only be missed by a few pixels
  //        of line-box overshoot — a numeral standing proud of its badge, with
  //        `overflow: visible` and nothing lost. Anything larger is real
  //        overflow spilling across the stage, and is not a rounding artifact.
  const spilling = missed.filter((m) => !isCut(m)).filter((m) => m.overW > 4 || m.overH > 4);
  assert.deepEqual(
    spilling.map((m) => `${m.bp} ${m.sceneId} ${m.role}#${m.ordinal} overW=${m.overW} overH=${m.overH}`),
    [],
    'an uncut box may overshoot its line box by a pixel or two, not spill across the layout',
  );
});

test('the same box at three breakpoints is three findings, deliberately', (t) => {
  if (!available) { t.skip('Chromium unavailable'); return; }
  // De-duplication across breakpoints would be the wrong kind of tidy: the
  // remedy differs — a headline that fits at `lg` and not at `sm` is rewritten
  // for `sm` alone — and §4's locus cannot carry a breakpoint, so collapsing
  // them would leave a finding that cannot say where it applies. Recorded as a
  // decision (L11-D28) rather than left to be re-derived from the code.
  const byBox = new Map();
  for (const f of findings) {
    const d = f.detail;
    const k = `${f.locus.sceneId}|${d.elementId || '-'}|${d.role}|${d.orderInElement || 0}|${d.axis}`;
    if (!byBox.has(k)) byBox.set(k, new Set());
    byBox.get(k).add(d.breakpoint);
  }
  const multi = [...byBox.values()].filter((s) => s.size > 1);
  assert.ok(multi.length > 0,
    'the corpus must contain a box that overflows at more than one breakpoint for this to mean anything');
  for (const f of findings) assert.match(f.message, new RegExp(`\\bat ${f.detail.breakpoint}\\b`),
    'and each of those findings must say which breakpoint it is about');
});
