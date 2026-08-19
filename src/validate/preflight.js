/**
 * §14 — the automated sweep.
 *
 * "Walks every scene, every beat, and every branch in a headless pass and
 * collects `Finding[]`." It runs under `node --test` with no browser, which is
 * only possible because D4 made layouts render to a VNode tree and L8 exposes
 * `measureScene` — so the sweep measures the same tree the artifact will paint,
 * rather than a second model of it.
 *
 * Two properties are asserted by test rather than hoped for:
 *
 *  - **Determinism.** The same proof produces the same findings, in the same
 *    order, byte for byte, every time. Rules run in the contract's code order,
 *    every finding id is content-derived, and time enters only through the
 *    injected clock.
 *  - **No override.** `runPreflight` takes measurement inputs and dependencies.
 *    It takes nothing that suppresses a finding, filters by severity, or marks
 *    one as accepted. §14 says severity 1 blocks emit and there is no override
 *    flag; the parameter that would become one does not exist here.
 *
 * @module validate/preflight
 */

import { BREAKPOINTS, validateProofShape } from '../core/contracts.js';
import { buildDeck } from '../runtime/deck.js';
import { renderLayout, missingLayouts } from '../runtime/layouts.js';
import { REVEAL_ATTR } from '../runtime/beats.js';
import { collectByAttr } from '../core/vdom.js';
import { elementId } from '../core/ids.js';
import { registerAllLayouts } from '../scene/index.js';
import { RULES } from './rules.js';
import { sortFindings } from './finding.js';
import { contrastRatio } from './lane-brand.js';
import { measureScene } from './lane-scene.js';
import { branchCoverage } from './lane-branch.js';
import { scanForNetworkReferences, assertProvenance } from './lane-emit.js';
import { hasPromotionRecord } from './provenance.js';

/**
 * The cross-lane surfaces the sweep calls, all injectable. The defaults are the
 * modules `API.md` declares; the parameters exist so a test can drive one rule
 * without standing up a whole lane, and so the integrator can swap a lane in
 * without editing this file.
 * @param {object} [options]
 * @returns {object}
 */
export function resolveDeps(options = {}) {
  return {
    contrastRatio: options.contrastRatio || contrastRatio,
    measureScene: options.measureScene || measureScene,
    branchCoverage: options.branchCoverage || branchCoverage,
    scanForNetworkReferences: options.scanForNetworkReferences || scanForNetworkReferences,
    assertProvenance: options.assertProvenance || assertProvenance,
    hasPromotionRecord: options.hasPromotionRecord || hasPromotionRecord,
  };
}

/**
 * Read the injected clock. §5 and `scripts/lint-determinism.mjs` between them
 * mean no module here may ask the machine what time it is; the caller says.
 * @param {(() => string)|string|null|undefined} clock
 * @returns {string|null}
 */
export function readClock(clock) {
  if (typeof clock === 'function') {
    const value = clock();
    return typeof value === 'string' ? value : null;
  }
  if (typeof clock === 'string') return clock;
  return null;
}

/**
 * Normalise the breakpoint list. The §4 default is all three (`sm` 390, `md`
 * 1024, `lg` 1600); a caller may pass a subset by id or pass explicit geometry,
 * but may not pass none — measuring at no breakpoint would be an override by
 * omission.
 * @param {undefined|('sm'|'md'|'lg')[]|{id: string, width: number, height: number}[]} breakpoints
 * @returns {{id: string, width: number, height: number}[]}
 */
export function resolveBreakpoints(breakpoints) {
  if (!breakpoints || breakpoints.length === 0) return BREAKPOINTS.slice();
  return breakpoints.map((b) => {
    if (typeof b === 'string') {
      const found = BREAKPOINTS.find((x) => x.id === b);
      if (!found) throw new Error(`runPreflight: unknown breakpoint "${b}"`);
      return found;
    }
    if (!b || typeof b.id !== 'string' || !(b.width > 0) || !(b.height > 0)) {
      throw new Error('runPreflight: a breakpoint needs {id, width, height}');
    }
    return b;
  });
}

/**
 * The `LayoutContext` L8 measures against — the same shape
 * `Runtime.layoutContext()` builds, so preflight and the artifact see one scene.
 * @param {import('../core/contracts.d.ts').Proof} proof
 * @param {import('../core/contracts.d.ts').Scene} scene
 * @param {Map<string, any>} specimenById
 * @param {Map<string, any>} renditionById
 * @param {Map<string, any>} mediaById
 * @returns {any}
 */
export function layoutContextFor(proof, scene, specimenById, renditionById, mediaById) {
  return {
    scene,
    brand: proof.brand,
    specimen: scene.specimenId ? specimenById.get(scene.specimenId) || null : null,
    renditions: (scene.renditionIds || []).map((id) => renditionById.get(id)).filter(Boolean),
    media: mediaById,
    el: (path) => elementId(scene.id, path),
    // Preflight measures what the artifact will render. §9 forces the label on
    // for review-reachable builds, and the emit options say the rest.
    labelIllustrative: proof.emitOptions ? proof.emitOptions.labelIllustrativeContent !== false : true,
    mode: /** @type {'presenter'|'review'} */ (proof.emitOptions && proof.emitOptions.mode === 'presenter' ? 'presenter' : 'review'),
  };
}

/**
 * Measure every scene in the deck at every breakpoint.
 *
 * Scenes are visited in deck order — spine first, then each branch — and a scene
 * id is measured once even if the model repeats it (the repetition is itself a
 * `DUPLICATE_SCENE` finding).
 *
 * @param {import('../core/contracts.d.ts').Proof} proof
 * @param {any} deck
 * @param {{id: string, width: number, height: number}[]} breakpoints
 * @param {object} deps
 * @returns {{sceneId: string, breakpoint: string, boxes: any[]}[]}
 */
export function measureDeck(proof, deck, breakpoints, deps) {
  const specimenById = new Map((proof.specimens || []).map((s) => [s.id, s]));
  const renditionById = new Map((proof.renditions || []).map((r) => [r.id, r]));
  /** @type {Map<string, any>} */
  const mediaById = new Map();
  for (const specimen of proof.specimens || []) for (const m of specimen.media || []) mediaById.set(m.id, m);
  for (const rendition of proof.renditions || []) for (const m of rendition.media || []) mediaById.set(m.id, m);

  /** @type {any[]} */
  const out = [];
  /** @type {Set<string>} */
  const seen = new Set();
  const sequences = [deck.spine, ...[...deck.sequences.values()].filter((s) => s.kind === 'branch')];
  for (const sequence of sequences) {
    for (const scene of sequence.scenes) {
      if (seen.has(scene.id)) continue;
      seen.add(scene.id);
      const ctx = layoutContextFor(proof, scene, specimenById, renditionById, mediaById);
      for (const breakpoint of breakpoints) {
        const measurement = deps.measureScene(scene, ctx, breakpoint.id);
        if (!measurement) continue;
        out.push({
          sceneId: measurement.sceneId || scene.id,
          breakpoint: measurement.breakpoint || breakpoint.id,
          boxes: measurement.boxes || [],
        });
      }
    }
  }
  return out;
}

/**
 * A scene renderer for the checks that have to look at rendered markup rather
 * than at the model — L10's `assertProvenance`, which needs to find the
 * illustrative label inside the subtree that carries the rendition.
 *
 * It renders through L2's layout registry, so preflight sees exactly the tree
 * the artifact will paint. Layouts are registered on demand: the studio
 * registers them at boot, but a headless sweep may be the first thing to run.
 *
 * @param {import('../core/contracts.d.ts').Proof} proof
 * @returns {(scene: any) => any}
 */
export function makeSceneRenderer(proof) {
  const specimenById = new Map((proof.specimens || []).map((s) => [s.id, s]));
  const renditionById = new Map((proof.renditions || []).map((r) => [r.id, r]));
  /** @type {Map<string, any>} */
  const mediaById = new Map();
  for (const specimen of proof.specimens || []) for (const m of specimen.media || []) mediaById.set(m.id, m);
  for (const rendition of proof.renditions || []) for (const m of rendition.media || []) mediaById.set(m.id, m);
  if (missingLayouts().length > 0) registerAllLayouts();
  return (scene) => renderLayout(layoutContextFor(proof, scene, specimenById, renditionById, mediaById));
}

/**
 * The element ids each scene's layout actually renders.
 *
 * §4 `Beat.reveals` names element ids, and L2 requires every revealable element
 * to carry `data-pp-el`. A beat naming an id the layout never renders is a
 * keypress that does nothing in front of the room — functionally the same defect
 * as a beat with no reveals at all, and invisible to a sweep that only reads the
 * model. Rendering each scene once makes it visible.
 *
 * A scene whose tree carries no revealable element at all is left out: that is a
 * still-frame layout the beat engine renders whole, and comparing against an
 * empty set would flag every beat in it.
 *
 * @param {import('../core/contracts.d.ts').Proof} proof
 * @param {any} deck
 * @param {(scene: any) => any} render
 * @returns {Map<string, Set<string>>}
 */
export function renderedElementIds(proof, deck, render) {
  /** @type {Map<string, Set<string>>} */
  const out = new Map();
  if (typeof render !== 'function') return out;
  for (const scene of deck.sceneById.values()) {
    let ids;
    try {
      const tree = render(scene);
      ids = collectByAttr(tree, REVEAL_ATTR).map((el) => el.a[REVEAL_ATTR]).filter(Boolean);
    } catch (e) {
      // A layout that cannot render is a defect the layout registry reports;
      // this rule stays silent rather than blaming every beat in the scene for it.
      continue;
    }
    if (ids.length === 0) continue;
    out.set(scene.id, new Set(ids));
  }
  return out;
}

/**
 * The §14 automated sweep.
 *
 * @param {import('../core/contracts.d.ts').Proof} proof
 * @param {object} [options]
 * @param {('sm'|'md'|'lg')[]|{id: string, width: number, height: number}[]} [options.breakpoints]
 * @param {(() => string)|string} [options.clock]     injected; §5 forbids reading the machine clock
 * @param {string} [options.runtimeJs]                scanned for network references before it is inlined
 * @param {string} [options.runtimeCss]
 * @param {string} [options.html]                     the rendered document, when there is one
 * @param {string} [options.css]
 * @returns {Promise<import('../core/contracts.d.ts').Finding[]>}
 */
export async function runPreflight(proof, options = {}) {
  if (!proof || typeof proof !== 'object') throw new TypeError('runPreflight: a Proof is required');
  const shapeErrors = validateProofShape(proof);
  if (shapeErrors.length > 0) {
    // A proof that violates §4 cannot be measured meaningfully, and quietly
    // returning "no findings" would read as a pass. Fail loudly instead.
    throw new Error(`runPreflight: the proof violates the §4 contract:\n  ${shapeErrors.slice(0, 8).join('\n  ')}`);
  }

  const deps = resolveDeps(options);
  const deck = buildDeck(proof);
  const breakpoints = resolveBreakpoints(options.breakpoints);
  const nowIso = readClock(options.clock);
  const measurements = measureDeck(proof, deck, breakpoints, deps);

  const renderScene = options.renderScene || makeSceneRenderer(proof);
  const ctx = {
    renderScene,
    renderedElementIds: renderedElementIds(proof, deck, renderScene),
    proof,
    deck,
    breakpoints,
    measurements,
    nowIso,
    runtimeJs: options.runtimeJs,
    runtimeCss: options.runtimeCss,
    html: options.html,
    css: options.css,
    deps,
  };

  /** @type {any[]} */
  const findings = [];
  for (const rule of RULES) findings.push(...rule.run(ctx));
  return sortFindings(findings);
}

/**
 * A preflight summary the studio's rehearse panel and the emitter both read.
 * @param {import('../core/contracts.d.ts').Finding[]} findings
 * @returns {{total: number, blocking: number, warnings: number, notes: number,
 *            byCode: Record<string, number>, canEmit: boolean}}
 */
export function summarize(findings) {
  /** @type {Record<string, number>} */
  const byCode = {};
  let blocking = 0;
  let warnings = 0;
  let notes = 0;
  for (const f of findings || []) {
    byCode[f.code] = (byCode[f.code] || 0) + 1;
    if (f.severity === 1) blocking++;
    else if (f.severity === 2) warnings++;
    else notes++;
  }
  return {
    total: (findings || []).length,
    blocking,
    warnings,
    notes,
    byCode,
    // §14: severity 1 blocks emit, and nothing in this codebase lets one through.
    canEmit: blocking === 0,
  };
}
