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

// ---------------------------------------------------------------------------
// The auto-fix ledger
//
// The gate says what stands between the seller and an emitted file. The ledger
// says what has already been tried against it and what that did — which is a
// different question, and until CRITIQUE-3 P2 nothing in the studio was asking
// it.
//
// P2's measured symptom was forty auto-fix clicks over 232 seconds with the
// blocking count stuck at three from the seventeenth, the same button offered
// every time. The cause was P1, and P1 is fixed; but a repair loop that cannot
// make progress has to be able to say so, because the next cause will not be
// P1. So every application records what it actually did, keyed by the finding's
// id — which is content-derived from its code, locus and key, and therefore the
// same string when the same finding comes back at the next sweep.
//
// Three outcomes, and each one is a fact the panel can act on:
//
//   'applied'   — the proof changed. Provisional: the next sweep decides.
//   'no-change' — the fix ran against this exact proof and produced the same
//                 proof. Clicking it again produces the same proof again, so
//                 the button is withdrawn and the finding is named as one for
//                 a person.
//   'returned'  — the proof changed and the finding came back anyway. Only ever
//                 set for a fix that declared `effect: 'resolves'`; a 'plan' or
//                 'mitigates' fix leaving its finding standing is the contract,
//                 not a failure.
//
// The ledger lives on `app.ui` beside the sweep, because it describes one
// session's attempts against one sweep's findings and means nothing without it.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} FixAttempt
 * @property {string} findingId
 * @property {string|null} code
 * @property {string} label
 * @property {string} effect      'resolves' | 'plan' | 'mitigates'
 * @property {'applied'|'no-change'|'returned'} outcome
 * @property {string} at
 */

/**
 * The attempt standing against a finding, or null.
 * @param {any} app
 * @param {string} findingId
 * @returns {FixAttempt|null}
 */
export function fixAttempt(app, findingId) {
  const log = (app && app.ui && app.ui.fixAttempts) || [];
  return log.find((a) => a && a.findingId === findingId) || null;
}

/**
 * True when an auto-fix has been tried against this finding and did not clear
 * it, so offering the same button again would be inviting a click that cannot
 * help.
 * @param {any} app
 * @param {string} findingId
 * @returns {boolean}
 */
export function fixExhausted(app, findingId) {
  const attempt = fixAttempt(app, findingId);
  return !!attempt && (attempt.outcome === 'no-change' || attempt.outcome === 'returned');
}

/**
 * Record what an application of one fix did. One entry per finding: a second
 * attempt replaces the first, because what matters is the current answer to
 * "would clicking this help".
 * @param {any} app
 * @param {any} fix                    an entry from `services.autoFixes`
 * @param {'applied'|'no-change'|'returned'} outcome
 * @returns {void}
 */
export function recordFixAttempt(app, fix, outcome) {
  const finding = (fix && fix.finding) || {};
  if (!finding.id) return;
  const rest = (app.ui.fixAttempts || []).filter((a) => a.findingId !== finding.id);
  app.ui.fixAttempts = [...rest, {
    findingId: finding.id,
    code: finding.code || null,
    label: fix.label,
    effect: fix.effect === 'plan' || fix.effect === 'mitigates' ? fix.effect : 'resolves',
    outcome,
    at: app.clock(),
  }];
}

/**
 * Re-read the ledger against a fresh sweep. A fix that declared it would
 * resolve its finding, and whose finding is still here, did not.
 * @param {any} app
 * @param {any[]} findings   the findings the new sweep raised
 * @returns {number}         how many attempts turned out not to have worked
 */
export function reconcileFixAttempts(app, findings) {
  const present = new Set((findings || []).map((f) => f && f.id));
  let returned = 0;
  app.ui.fixAttempts = (app.ui.fixAttempts || []).map((attempt) => {
    if (attempt.outcome !== 'applied' || attempt.effect !== 'resolves') return attempt;
    if (!present.has(attempt.findingId)) return attempt;
    returned += 1;
    return { ...attempt, outcome: /** @type {'returned'} */ ('returned') };
  });
  return returned;
}

/**
 * How much of a finding list an auto-fix could still clear, for the sentence
 * that has to be true before the first click rather than after the fortieth.
 * @param {any} app
 * @param {any[]} findings
 * @param {any[]} fixes     `services.autoFixes(proof, findings)`
 * @returns {{offered: number, exhausted: number, manual: number}}
 */
export function fixCoverage(app, findings, fixes) {
  const byFinding = new Map((fixes || []).map((fx) => [fx.finding && fx.finding.id, fx]));
  let offered = 0;
  let exhausted = 0;
  let manual = 0;
  for (const finding of findings || []) {
    if (!finding) continue;
    if (!byFinding.has(finding.id)) { manual += 1; continue; }
    if (fixExhausted(app, finding.id)) { exhausted += 1; continue; }
    offered += 1;
  }
  return { offered, exhausted, manual };
}

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
