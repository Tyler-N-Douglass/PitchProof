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
 * **The emitter runs L11's sweep. It does not run its own copy of it.** This is
 * one call to `runPreflight` with the artifact's own rendered scenes, its final
 * stylesheet and the document that is about to be written.
 *
 * It was not always. The first version of this module rebuilt preflight's
 * context by hand — measuring the deck, collecting rendered element ids,
 * assembling the cross-lane dependency object — because
 * `validate/lane-emit.js` re-exported L10's scanner through `emit/index.js` and
 * a direct call was a module cycle the bundler refuses (D3). That workaround
 * cost about a hundred lines and, on its first run, a real defect: it forgot
 * `renderedElementIds`, so half of `BEAT_EMPTY` was silently inert. L10-D8
 * proposed the fix, `lane-emit.js` now imports the two leaf modules directly,
 * the cycle is gone, and the workaround went with it. What remains is the shape
 * the law should always have had: one sweep, one implementation, no second
 * context that can drift from the first.
 *
 * @module emit/gate
 */

import { runPreflight, RULES } from '../validate/index.js';

/**
 * The one rule the emitter answers itself.
 *
 * `SIZE_BUDGET_EXCEEDED` in `validate/rules.js` **estimates** the emitted size
 * from the model — it has to, because preflight runs before anything is
 * serialized, and it says so in its own message ("the estimated artifact
 * is…"). By the time the gate runs, the emitter has budgeted, serialized and
 * *measured* the real file. Running the estimate as well would put two findings
 * for one question in front of the user, with the less accurate one first, and
 * would raise a false alarm on every proof the budgeter successfully fits.
 *
 * `emit()` answers this code from the measured bytes instead, at severity 1
 * (decision E14). It is the only code the emitter answers itself, and the only
 * one where it has better information than the rule.
 */
export const MEASURED_BY_EMIT = new Set(['SIZE_BUDGET_EXCEEDED']);

/**
 * Run the §14 sweep against the artifact that is about to ship.
 *
 * Every argument is the artifact's own: `renderScene` renders through the
 * runtime the emitter built from the model it is serializing, `html` is the
 * document being written, and `css` is the stylesheet that document carries.
 * Preflight is capable of running without them — the studio's rehearse pass
 * does — and the findings that need them are exactly the ones §9 and §13 put in
 * the emitter, so the emitter supplies all three.
 *
 * @param {object} args
 * @param {import('../core/contracts.d.ts').Proof} args.proof   the budgeted, round-tripped model
 * @param {(scene: any) => any} args.renderScene
 * @param {string} args.html       the emitted document
 * @param {string} args.css        the final stylesheet
 * @param {string} args.runtimeJs
 * @param {string} args.runtimeCss
 * @param {(() => string)|string|null} args.clock
 * @param {{id: string, width: number, height: number}[]} [args.breakpoints]
 * @returns {Promise<import('../core/contracts.d.ts').Finding[]>}
 */
export async function runEmitGate(args) {
  const findings = await runPreflight(args.proof, {
    breakpoints: args.breakpoints,
    clock: args.clock,
    runtimeJs: args.runtimeJs,
    runtimeCss: args.runtimeCss,
    html: args.html,
    css: args.css,
    renderScene: args.renderScene,
  });
  return findings.filter((f) => !MEASURED_BY_EMIT.has(f.code));
}

/**
 * The codes the gate reports, so the documentation cannot drift from the code.
 * `RULES` carries one rule per §4 code; the gate reports all of them except
 * `MEASURED_BY_EMIT`, which `emit()` answers from the measured artifact.
 * @returns {string[]}
 */
export function gatedCodes() {
  return RULES.map((r) => r.code).filter((c) => !MEASURED_BY_EMIT.has(c));
}
