/**
 * The emit gate — §14's sentence, made true.
 *
 * §14: "Severity 1 findings block emit. There is no override flag. If a lane
 * proposes one, the critic rejects it." `API.md` Part 3 repeats it: "A
 * severity-1 finding refuses the emit. There is no override flag anywhere in
 * the codebase."
 *
 * Until this module existed, that sentence was **false**. `emit()` enforced the
 * laws it owned — network references, provenance, model assets, the size
 * budget, the §4 contract — and let `TEXT_OVERFLOW` and `CONTRAST_FAIL` through,
 * including a body pair below 4.5:1 that §14 pins at severity 1. The law
 * survived in the shipped product only because `src/ui/gate.js` runs preflight
 * before enabling the button, which makes it a property of one caller rather
 * than a property of the artifact. §9's own reasoning about provenance —
 * "enforce this in the emitter, not just in the UI" — applies here word for
 * word: a `.pitchproof.html` handed to a client must not depend on which
 * program produced it.
 *
 * **This runs L11's rules, not a second copy of them.** `RULES` is imported
 * from `src/validate/rules.js` and every rule object is invoked with the
 * context `runPreflight` builds, so the emitter and the rehearsal sweep cannot
 * drift: there is one implementation of overflow detection, one of contrast
 * checking, one of branch coverage. `test/emit/gate.test.mjs` asserts the two
 * agree finding-for-finding on a corpus, which is what keeps that true as L11
 * changes.
 *
 * **Why not simply call `runPreflight`.** Because it is a module cycle the
 * bundler refuses (D3):
 *
 * ```
 * emit/emit.js → validate/index.js → validate/preflight.js
 *              → validate/lane-emit.js → emit/index.js → emit/emit.js
 * ```
 *
 * `validate/lane-emit.js` re-exports L10's scanner and provenance checker,
 * because preflight needs them — the dependency between the two lanes is
 * genuinely mutual. `validate/rules.js` is the half with no back-edge: it takes
 * both of those through `ctx.deps` rather than importing them, so an emitter
 * that supplies its own can run the whole rule set without a cycle. That is the
 * seam this module uses, and `docs/disputes/L10-emit.md` (L10-D8) records the
 * one-line change to `lane-emit.js` that would remove the cycle for good.
 *
 * @module emit/gate
 */

import { BREAKPOINTS } from '../core/contracts.js';
import { elementId } from '../core/ids.js';
import { RULES } from '../validate/rules.js';
import { sortFindings } from '../validate/finding.js';
import { measureScene } from '../scene/index.js';
import { branchCoverage } from '../branch/index.js';
import { contrastRatio } from '../brand/color.js';
import { scanForNetworkReferences } from './scan.js';
import { assertProvenance } from './provenance.js';
import { hasPromotionRecord } from './promotion.js';

/**
 * The `LayoutContext` a scene is measured against.
 *
 * This is `Runtime.layoutContext()` — the context the artifact itself will
 * render with — rather than a reconstruction. The emitter already has a
 * `Runtime` built from the model that is about to ship, so measuring against
 * anything else would be measuring a different deck.
 *
 * @param {import('../runtime/runtime.js').Runtime} runtime
 * @param {import('../core/contracts.d.ts').Scene} scene
 * @returns {any}
 */
export function layoutContextFor(runtime, scene) {
  const ctx = runtime.layoutContext(scene);
  return { ...ctx, el: (path) => elementId(scene.id, path) };
}

/**
 * Measure every scene of the deck at every breakpoint.
 *
 * A scene id is measured once even when the model repeats it — the repetition
 * is itself a `DUPLICATE_SCENE` finding, and measuring it twice would report
 * every box in it twice.
 *
 * @param {any} deck
 * @param {import('../runtime/runtime.js').Runtime} runtime
 * @param {{id: string, width: number, height: number}[]} breakpoints
 * @returns {{sceneId: string, breakpoint: string, boxes: any[]}[]}
 */
export function measureDeck(deck, runtime, breakpoints) {
  /** @type {any[]} */
  const out = [];
  /** @type {Set<string>} */
  const seen = new Set();
  const sequences = [deck.spine, ...[...deck.sequences.values()].filter((s) => s.kind === 'branch')];
  for (const sequence of sequences) {
    for (const scene of sequence.scenes) {
      if (seen.has(scene.id)) continue;
      seen.add(scene.id);
      const ctx = layoutContextFor(runtime, scene);
      for (const breakpoint of breakpoints) {
        const measurement = measureScene(scene, ctx, breakpoint.id);
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
 * The cross-lane functions the rules call. Every one is the surface `API.md`
 * declares for its lane, and the two L10 owns are L10's own — which is what
 * makes running the rules here equivalent to running them in preflight.
 * @returns {object}
 */
export function gateDeps() {
  return {
    contrastRatio,
    measureScene,
    branchCoverage,
    scanForNetworkReferences,
    assertProvenance,
    hasPromotionRecord,
  };
}

/**
 * Run every §14 rule against the artifact that is about to ship.
 *
 * @param {object} args
 * @param {import('../core/contracts.d.ts').Proof} args.proof   the budgeted, round-tripped model
 * @param {any} args.deck
 * @param {import('../runtime/runtime.js').Runtime} args.runtime
 * @param {(scene: any) => any} args.renderScene
 * @param {string} args.html       the emitted document
 * @param {string} args.css        the final stylesheet
 * @param {string} args.runtimeJs
 * @param {string} args.runtimeCss
 * @param {string|null} args.nowIso
 * @param {{id: string, width: number, height: number}[]} [args.breakpoints]
 * @returns {import('../core/contracts.d.ts').Finding[]}
 */
export function runEmitGate(args) {
  const breakpoints = args.breakpoints && args.breakpoints.length ? args.breakpoints : BREAKPOINTS.slice();
  const ctx = {
    renderScene: args.renderScene,
    proof: args.proof,
    deck: args.deck,
    breakpoints,
    measurements: measureDeck(args.deck, args.runtime, breakpoints),
    nowIso: args.nowIso,
    runtimeJs: args.runtimeJs,
    runtimeCss: args.runtimeCss,
    html: args.html,
    css: args.css,
    deps: gateDeps(),
  };

  /** @type {any[]} */
  const findings = [];
  for (const rule of RULES) findings.push(...rule.run(ctx));
  return sortFindings(findings);
}

/**
 * The codes the gate covers, for the documentation to stay honest about which
 * laws the emitter enforces. It is every code in the §4 set, because `RULES`
 * carries one rule per code and the gate runs all of them.
 * @returns {string[]}
 */
export function gatedCodes() {
  return RULES.map((r) => r.code);
}
