/**
 * The emit gate.
 *
 * §14: "Severity 1 findings block emit. There is no override flag." §7: the
 * studio "surfaces low-confidence fields for review before they can be used in
 * an emit". Both are conditions on the same button, so both are computed here,
 * in one place, by one function — and the emit action and the emit panel read
 * the same answer. There is no second path to the emitter and no argument that
 * bypasses this: `test/ui/no-override.test.mjs` asserts that the only call to
 * `services.emit` in `src/ui/**` is the one guarded below.
 *
 * A blocker is not a finding. Findings come from L11 and have the §4 shape; a
 * blocker is the studio's own sentence about why the button is off, and it
 * always names the thing to go and fix.
 *
 * @module ui/gate
 */

import { contentHash } from '../core/hash.js';
import { brandGroupEvidence, brandGroupIsStarterDefault, unreviewedBrandGroups } from './model.js';

/**
 * @typedef {object} Blocker
 * @property {string} kind        machine-readable reason
 * @property {string} message     the sentence shown to the user
 * @property {string} [where]     rail section that fixes it
 * @property {object} [locus]     scene/branch/specimen ids, when a finding has one
 */

/** How each §7 confidence group reads in a sentence. */
export const BRAND_GROUP_PHRASE = {
  colors: 'The colour roles',
  faces: 'The type faces',
  logos: 'The logo assets',
  shape: 'The shape language',
  imagery: 'The imagery treatment',
};

/**
 * The verb and pronoun each phrase takes. Three of the five groups are plural
 * and two are singular, and a blocker that reads "The shape language are
 * empty" is a sentence a seller reports as a bug in a product that is working.
 */
export const BRAND_GROUP_GRAMMAR = {
  colors: { verb: 'are', it: 'them' },
  faces: { verb: 'are', it: 'them' },
  logos: { verb: 'are', it: 'them' },
  shape: { verb: 'is', it: 'it' },
  imagery: { verb: 'is', it: 'it' },
};

/**
 * The severity-1 findings in a list.
 * @param {any[]} findings
 * @returns {any[]}
 */
export function blockingFindings(findings) {
  return (findings || []).filter((f) => f && f.severity === 1);
}

/**
 * A stable digest of the proof, used to tell whether the last preflight still
 * describes what is about to be emitted.
 * @param {any} proof
 * @returns {string}
 */
export function proofDigest(proof) { return contentHash(proof); }

/**
 * Everything standing between the user and an emitted file.
 * @param {any} app
 * @returns {{blockers: Blocker[], canEmit: boolean, blockingFindings: any[]}}
 */
export function emitBlockers(app) {
  /** @type {Blocker[]} */
  const blockers = [];
  const proof = app.proof;
  const sweep = app.ui.sweep;

  if (!(proof.spine || []).length) {
    blockers.push({
      kind: 'NO_SCENES',
      message: 'This proof has no spine. Add at least one scene before emitting.',
      where: 'scenes',
    });
  }

  if (!app.services.has('validate')) {
    blockers.push({
      kind: 'VALIDATE_UNAVAILABLE',
      message: 'The validation lane is not wired into this build, so this proof cannot be preflighted — and a proof that was never validated is not emitted.',
      where: 'rehearse',
    });
  } else if (!sweep.at) {
    blockers.push({
      kind: 'NO_PREFLIGHT',
      message: 'No rehearsal sweep has been run. Run the sweep before emitting.',
      where: 'rehearse',
    });
  } else if (sweep.proofHash && sweep.proofHash !== proofDigest(proof)) {
    blockers.push({
      kind: 'STALE_PREFLIGHT',
      message: 'The proof has changed since the last sweep. Run the sweep again so the preflight describes what you are about to emit.',
      where: 'rehearse',
    });
  }

  const blocking = blockingFindings(sweep.findings);
  for (const finding of blocking) {
    blockers.push({
      kind: finding.code,
      message: `${finding.code}: ${finding.message}`,
      where: 'rehearse',
      locus: finding.locus || {},
    });
  }

  for (const entry of unreviewedBrandGroups(proof.brand)) {
    const evidence = brandGroupEvidence(proof.brand, entry.group);
    const phrase = BRAND_GROUP_PHRASE[entry.group] || entry.group;
    const g = BRAND_GROUP_GRAMMAR[entry.group] || { verb: 'is', it: 'it' };
    if (!evidence.hasContent) {
      blockers.push({
        kind: 'BRAND_EMPTY',
        message: `${phrase} ${g.verb} empty — ${evidence.describe}. There is nothing here to review, so nothing can be signed off: extract ${g.it}, or enter ${g.it} by hand.`,
        where: 'brand',
      });
    } else if (brandGroupIsStarterDefault(proof.brand, entry.group)) {
      // 0% here does not mean "extraction ran and could not tell". It means
      // nothing has been extracted and nothing has been entered, so what is on
      // screen is the studio's own starting value — not the prospect's. Saying
      // it "came out 0% confident" and asking for it to be checked "against the
      // source" describes a measurement that never happened, against a source
      // that does not exist.
      blockers.push({
        kind: 'BRAND_DEFAULTS',
        message: `${phrase} ${g.verb} still the ${evidence.describe} every new project starts with — nothing has been extracted from their site and nothing has been entered by hand, which is why the confidence reads 0%. Extract their brand, or set ${g.it} yourself, before signing ${g.it} off as theirs.`,
        where: 'brand',
      });
    } else {
      blockers.push({
        kind: 'BRAND_UNREVIEWED',
        message: `${phrase} came out ${Math.round(entry.confidence * 100)}% confident (${evidence.describe}). §7 holds a low-confidence brand field out of an emit until somebody has looked at it — check ${g.it} against the source and mark ${g.it} reviewed.`,
        where: 'brand',
      });
    }
  }

  if (!app.services.has('emit')) {
    blockers.push({
      kind: 'EMIT_UNAVAILABLE',
      message: 'The emitter is not wired into this build (src/emit/index.js has not landed).',
      where: 'emit',
    });
  }

  return { blockers, canEmit: blockers.length === 0, blockingFindings: blocking };
}

/**
 * A one-line summary for the rail badge and the status bar.
 * @param {any} app
 * @returns {{tone: string, text: string}}
 */
export function gateSummary(app) {
  const { blockers, canEmit } = emitBlockers(app);
  if (canEmit) return { tone: 'ok', text: 'Ready to emit' };
  const first = blockers[0];
  return {
    tone: blockers.some((b) => b.kind !== 'NO_PREFLIGHT' && b.kind !== 'STALE_PREFLIGHT') ? 'bad' : 'warn',
    text: blockers.length === 1 ? first.message : `${blockers.length} things block the emit`,
  };
}
