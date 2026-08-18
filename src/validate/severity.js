/**
 * Severity policy for the fourteen finding codes (§4, §14).
 *
 * §14 ends with the sentence this whole lane is organised around: *"Severity 1
 * findings block emit. There is no override flag."* That makes the severity of
 * a code a product decision rather than a formatting choice, so every one of the
 * fourteen is declared here, in one table, with the reasoning in
 * `docs/decisions/L11-validate.md`.
 *
 * Two rules hold everywhere:
 *
 *  1. `FIXED_SEVERITY` (core/contracts.js) pins three codes by spec. This module
 *     asserts the declared table agrees with it at load time, so a future edit
 *     that quietly lowers `PROVENANCE_UNLABELED` to a warning fails the moment
 *     the module is imported rather than the moment a client sees the proof.
 *  2. A rule may *narrow* a finding to a lower-priority severity only inside a
 *     documented band (marginal text overflow, an unreferenced empty specimen),
 *     and never below a fixed code's pinned value. `resolveSeverity` is the only
 *     place that decision is made, and it throws rather than accept an illegal
 *     one.
 *
 * @module validate/severity
 */

import { FINDING_CODES, FIXED_SEVERITY } from '../core/contracts.js';

/**
 * The severity a code carries when it fires on its canonical, blocking case.
 * This is what `severityOf()` reports: the worst a finding of this code can be,
 * so a caller asking "does this code block emit?" gets the honest answer.
 *
 * @type {Record<string, 1|2|3>}
 */
export const DECLARED_SEVERITY = {
  // A media reference with nothing behind it renders as a broken image in front
  // of the client. Nothing about that is recoverable at presentation time.
  ASSET_MISSING: 1,
  // The emitter's budgeter degrades oversize assets and reports what it did
  // (§13). A warning is the honest severity: the proof still presents.
  ASSET_OVERSIZE: 2,
  // A missing face substitutes rather than fails. The *consequence* — text that
  // no longer fits — is TEXT_OVERFLOW, and that is where the blocking severity
  // belongs. Flagging the substitution itself at severity 1 would block every
  // proof that uses a brand's real typeface, which is every proof.
  FONT_UNAVAILABLE: 2,
  // §22.2. Visibly clipped text is severity 1; overflow inside the documented
  // tolerance band narrows to 2 (see validate/overflow.js).
  TEXT_OVERFLOW: 1,
  // §14: "at severity 1 for body text below 4.5:1".
  CONTRAST_FAIL: 1,
  // Dead content: prepared but unreachable. Costly, not dangerous — the deck
  // still presents correctly, and the presenter simply never gets there.
  BRANCH_UNREACHABLE: 2,
  // §22.4: a branch the presenter cannot get out of strands them mid-pitch.
  BRANCH_NO_RETURN: 1,
  // A keypress that does nothing in front of a room. Embarrassing, not broken.
  BEAT_EMPTY: 2,
  // §18.1, §22.6, FIXED.
  PROVENANCE_UNLABELED: 1,
  // §1.1, §13, §18.4, FIXED.
  NETWORK_REFERENCE: 1,
  // §6, FIXED at 3.
  STALE_CAPTURE: 3,
  // An empty specimen on screen is a blank "before" side; an empty specimen in
  // the library is housekeeping. The rule narrows to 2 for the second case.
  SPECIMEN_EMPTY: 1,
  // A scene id used twice breaks the navigation locator (runtime/deck.js keeps
  // the first occurrence). Duplicated *content* under distinct ids narrows to 2.
  DUPLICATE_SCENE: 1,
  // Over budget but degradable is a warning; over budget in the part that
  // cannot be degraded is unfixable at emit and blocks.
  SIZE_BUDGET_EXCEEDED: 1,
};

// Load-time proof that the declared table covers the contract exactly and
// agrees with every pinned severity.
for (const code of FINDING_CODES) {
  if (!(code in DECLARED_SEVERITY)) throw new Error(`validate/severity: no severity declared for ${code}`);
}
for (const code of Object.keys(DECLARED_SEVERITY)) {
  if (!FINDING_CODES.includes(code)) throw new Error(`validate/severity: ${code} is not a FindingCode`);
}
for (const [code, fixed] of Object.entries(FIXED_SEVERITY)) {
  if (DECLARED_SEVERITY[code] !== fixed) {
    throw new Error(`validate/severity: ${code} is fixed at ${fixed} by contract but declared ${DECLARED_SEVERITY[code]}`);
  }
}

/**
 * Codes whose severity a rule may narrow, and the lowest-priority severity the
 * narrowing may reach. Anything not listed here fires at its declared severity,
 * always. A code in `FIXED_SEVERITY` can never appear in this table.
 * @type {Record<string, {floor: 1|2|3, why: string}>}
 */
export const NARROWABLE = {
  TEXT_OVERFLOW: {
    floor: 2,
    why: 'overflow inside the tolerance band, where this engine and a real browser may legitimately disagree',
  },
  CONTRAST_FAIL: {
    floor: 2,
    why: 'a non-text pair measured against the 3:1 non-text minimum rather than the 4.5:1 body minimum',
  },
  SPECIMEN_EMPTY: {
    floor: 2,
    why: 'an empty specimen no scene puts on screen',
  },
  DUPLICATE_SCENE: {
    floor: 2,
    why: 'duplicated scene content under distinct ids, which navigates correctly but repeats itself',
  },
  SIZE_BUDGET_EXCEEDED: {
    floor: 2,
    why: 'over budget only in assets the emitter can degrade',
  },
  ASSET_MISSING: {
    floor: 2,
    why: 'a dangling reference on a scene nothing in the deck reaches',
  },
};

for (const code of Object.keys(NARROWABLE)) {
  if (code in FIXED_SEVERITY) throw new Error(`validate/severity: ${code} has a fixed severity and may not be narrowed`);
  if (!FINDING_CODES.includes(code)) throw new Error(`validate/severity: ${code} is not a FindingCode`);
}

/**
 * The severity a code carries — the worst case it can produce.
 * @param {string} code
 * @returns {1|2|3}
 */
export function severityOf(code) {
  const sev = DECLARED_SEVERITY[code];
  if (!sev) throw new Error(`severityOf: unknown finding code ${String(code)}`);
  return sev;
}

/**
 * Settle the severity of one finding.
 *
 * Passing no `requested` severity yields the declared one. Passing one is only
 * legal when the code is narrowable and the value is inside its band; every
 * other combination throws, which is what stops "there is no override flag"
 * from decaying into "there is no override flag yet".
 *
 * @param {string} code
 * @param {1|2|3} [requested]
 * @returns {1|2|3}
 */
export function resolveSeverity(code, requested) {
  const declared = severityOf(code);
  if (requested === undefined || requested === null) return declared;
  if (requested !== 1 && requested !== 2 && requested !== 3) {
    throw new Error(`resolveSeverity: ${code}: severity must be 1, 2 or 3, got ${String(requested)}`);
  }
  if (requested === declared) return declared;
  if (code in FIXED_SEVERITY) {
    throw new Error(`resolveSeverity: ${code} is fixed at ${FIXED_SEVERITY[code]} by contract and may not be changed`);
  }
  if (requested < declared) {
    throw new Error(`resolveSeverity: ${code} declares severity ${declared}; a rule may not raise it to ${requested}`);
  }
  const band = NARROWABLE[code];
  if (!band) throw new Error(`resolveSeverity: ${code} may not be narrowed below severity ${declared}`);
  if (requested > band.floor) {
    throw new Error(`resolveSeverity: ${code} may narrow no further than severity ${band.floor} (${band.why})`);
  }
  return requested;
}

/**
 * True when a finding list contains anything that blocks emit. There is no
 * companion function that lets one through.
 * @param {{severity: number}[]} findings
 * @returns {boolean}
 */
export function blocksEmit(findings) {
  return (findings || []).some((f) => f.severity === 1);
}

/**
 * The blocking subset, for a message that tells the seller exactly what to fix.
 * @param {{severity: number}[]} findings
 * @returns {any[]}
 */
export function blockingFindings(findings) {
  return (findings || []).filter((f) => f.severity === 1);
}
