/**
 * §14 — auto-fix where safe and reversible.
 *
 * The spec names four fixes explicitly ("derive a compliant color, downscale an
 * asset, trim a beat with no reveals, generate a missing return target") and one
 * law about all of them: *"Every auto-fix is logged and undoable."*
 *
 * That law decides the shape of this module. A fix is **not** a mutation. It is
 * a pure function `(proof) => Proof` handed back as data, together with the
 * label a human will read in the undo menu. The studio wraps it in a
 * `CommandStack` command (`autoFixCommand()` below builds one, stamped
 * `meta.autoFix`), so the fix lands on the same undo stack as every hand edit
 * and unwinds the same way. Nothing here reaches into a proof and changes it.
 *
 * Purity has a second payoff: the reversibility test is trivial and total.
 * Apply a fix, and the proof you passed in is still the proof you passed in —
 * that *is* the revert, and `test/validate/autofix.test.mjs` asserts it by deep
 * comparison for every fix on every finding it offers.
 *
 * A fix declares what it does, because not every defect can be made to
 * disappear by editing a model:
 *
 *  - `resolves` — re-running preflight no longer reports the finding. This is
 *    every fix but two.
 *  - `plan` — the edit instructs the emitter, and the byte count comes down when
 *    the budgeter acts on it. Resampling pixels needs an image codec, which is
 *    L10's, not a pure function's over a Proof.
 *  - `mitigates` — the finding stands because it is true, and the fix reduces
 *    its consequence. A brand face that cannot be embedded stays unembeddable;
 *    what the fix changes is which face renders in its place.
 *
 * Five codes are deliberately **not** auto-fixable, and the reasons matter:
 *
 *  - `TEXT_OVERFLOW` — the fix is to rewrite the sentence or change the type
 *    scale. Both are editorial. A tool that silently shortened a seller's
 *    headline before a pitch would be worse than the overflow.
 *  - `NETWORK_REFERENCE` — the only safe fix is to remove content the user put
 *    there on purpose, and §1.1 is a law, not a nuisance to be papered over.
 *  - `STALE_CAPTURE` — nothing but re-capturing fixes it.
 *  - `SPECIMEN_EMPTY` — same.
 *  - `DUPLICATE_SCENE` — which copy to keep is the seller's call about their
 *    own narrative.
 *
 * @module validate/autofix
 */

import { QUALITY_STEPS, CONTRAST_AA_BODY } from '../core/contracts.js';
import { replaceCommand } from '../core/command.js';
import { contrastRatio, deriveForContrast, hexToOklch } from './lane-brand.js';
import { resolveBoxFace } from './overflow.js';

/**
 * Deep copy of a proof. A `Proof` is JSON by construction (§4 — every field is a
 * string, number, boolean, array or plain object), so this is exact, and it
 * cannot accidentally share a nested array with the original the way a spread
 * would.
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** The next lower image quality step, or null at the floor. */
function nextQualityDown(quality) {
  const i = QUALITY_STEPS.indexOf(quality);
  return i > 0 ? QUALITY_STEPS[i - 1] : null;
}

/**
 * Every fixer, keyed by finding code. A fixer returns `{label, apply}` or null
 * when this particular finding cannot be fixed safely.
 * @type {Record<string, (proof: any, finding: any) => {label: string, apply: (proof: any) => any}|null>}
 */
const FIXERS = {
  CONTRAST_FAIL(proof, finding) {
    const d = finding.detail || {};
    if (!d.foregroundRole || !d.backgroundRole || d.kind === 'nontext') return null;
    const minimum = Number(d.minimum) || CONTRAST_AA_BODY;
    const colors = (proof.brand && proof.brand.colors) || [];
    const fg = colors.find((c) => c.role === d.foregroundRole);
    const bg = colors.find((c) => c.role === d.backgroundRole);
    if (!fg || !bg) return null;
    // Derive with a margin, so a downstream rounding of the hex cannot land the
    // palette back under the minimum it was just fixed to clear.
    const derived = deriveForContrast(fg.hex, bg.hex, minimum);
    if (!derived || derived === fg.hex) return null;
    const achieved = contrastRatio(derived, bg.hex);
    if (achieved < minimum) return null;
    return {
      label: `Derive ${d.foregroundRole} to ${derived} for ${minimum}:1 on ${d.backgroundRole}`,
      apply(current) {
        const next = clone(current);
        for (const token of next.brand.colors) {
          if (token.role !== d.foregroundRole) continue;
          token.hex = derived;
          token.oklch = hexToOklch(derived);
          token.source = 'derived';
          token.contrastWithPair = Math.round(achieved * 10000) / 10000;
        }
        for (const token of next.brand.colors) {
          if (token.role !== d.backgroundRole) continue;
          token.contrastWithPair = Math.round(contrastRatio(token.hex, derived) * 10000) / 10000;
        }
        const path = `brand.colors.${d.foregroundRole}`;
        if (!next.brand.manualOverrides.includes(path)) next.brand.manualOverrides.push(path);
        return next;
      },
    };
  },

  ASSET_OVERSIZE(proof) {
    const quality = (proof.emitOptions && proof.emitOptions.imageQuality) || 0.85;
    const lower = nextQualityDown(quality);
    if (lower === null) return null;
    return {
      // Resampling pixels needs an image codec, which belongs to L10's budgeter
      // (`budgetAssets`) and to the studio's canvas — not to a pure function over
      // a Proof. What this fix changes is the instruction the budgeter follows,
      // which is a real, reversible edit; the bytes come down when the emitter
      // acts on it, so the finding clears at emit rather than at preflight.
      effect: 'plan',
      label: `Recompress images at quality ${lower} (from ${quality})`,
      apply(current) {
        const next = clone(current);
        next.emitOptions.imageQuality = lower;
        return next;
      },
    };
  },

  SIZE_BUDGET_EXCEEDED(proof, finding) {
    const d = finding.detail || {};
    if (d.fixedBytes > d.maxBytes) return null;   // nothing degradable is left to give
    return FIXERS.ASSET_OVERSIZE(proof, finding);
  },

  ASSET_MISSING(proof, finding) {
    const d = finding.detail || {};
    if (d.ownerKind !== 'specimen' && d.ownerKind !== 'rendition') return null;
    if (!Number.isInteger(d.blockIndex)) return null;
    const collection = d.ownerKind === 'specimen' ? 'specimens' : 'renditions';
    return {
      label: `Remove the block referencing missing media "${d.ref}"`,
      apply(current) {
        const next = clone(current);
        const owner = (next[collection] || []).find((o) => o.id === d.ownerId);
        if (!owner || !Array.isArray(owner.blocks)) return next;
        const block = owner.blocks[d.blockIndex];
        if (!block || block.type !== 'media' || block.ref !== d.ref) return next;
        owner.blocks.splice(d.blockIndex, 1);
        return next;
      },
    };
  },

  BEAT_EMPTY(proof, finding) {
    const d = finding.detail || {};
    if (!d.sceneId) return null;
    const dangling = d.kind === 'dangling-reveals';
    return {
      label: dangling
        ? `Trim beat ${(d.beatIndex ?? 0) + 1} of scene ${d.sceneId}, whose reveals name nothing the layout renders`
        : `Trim beat ${(d.beatIndex ?? 0) + 1} of scene ${d.sceneId}, which reveals nothing`,
      apply(current) {
        const next = clone(current);
        const scenes = [...(next.spine || [])];
        for (const branch of next.branches || []) scenes.push(...(branch.scenes || []));
        for (const scene of scenes) {
          if (scene.id !== d.sceneId) continue;
          const i = scene.beats.findIndex((b) => (d.beatId ? b.id === d.beatId : false));
          const at = i >= 0 ? i : d.beatIndex;
          const beat = scene.beats[at];
          // Only ever remove a beat that still reveals nothing, and never the
          // last one: a scene with no beats has no position for the navigator to
          // stand on.
          if (!beat || scene.beats.length <= 1) continue;
          const stillDead = dangling
            ? (beat.reveals || []).length > 0 && (beat.reveals || []).every((id) => (d.dangling || []).includes(id))
            : (beat.reveals || []).length === 0;
          if (!stillDead) continue;
          scene.beats.splice(at, 1);
        }
        return next;
      },
    };
  },

  BRANCH_NO_RETURN(proof, finding) {
    const d = finding.detail || {};
    if (!d.branchId || !d.fixKind) return null;
    const branch = (proof.branches || []).find((b) => b.id === d.branchId);
    if (!branch || (branch.scenes || []).length === 0) return null;

    if (d.fixKind === 'anchor-policy') {
      // The branch has anchors; the policy was pointing somewhere that does not
      // resolve. Return it to the anchor it actually has.
      if (branch.returnPolicy === 'anchor') return null;
      return {
        label: `Return branch "${branch.objection || branch.id}" to its anchor`,
        apply(current) {
          const next = clone(current);
          for (const b of next.branches || []) if (b.id === d.branchId) b.returnPolicy = 'anchor';
          return next;
        },
      };
    }

    // 'anchor-scene': the branch is unanchored, so the deck never says where it
    // belongs. Anchoring it to the opening scene is the smallest edit that makes
    // the declaration complete, and the seller can move it.
    const spine = proof.spine || [];
    if (spine.length === 0) return null;
    return {
      label: `Anchor branch "${branch.objection || branch.id}" to the opening scene ${spine[0].id}`,
      apply(current) {
        const next = clone(current);
        const target = (next.spine || [])[0];
        if (!target) return next;
        if (!Array.isArray(target.branchAnchors)) target.branchAnchors = [];
        if (!target.branchAnchors.includes(d.branchId)) target.branchAnchors.push(d.branchId);
        return next;
      },
    };
  },

  BRANCH_UNREACHABLE(proof, finding) {
    const d = finding.detail || {};
    if (!d.branchId) return null;
    const spine = proof.spine || [];
    if (spine.length === 0) return null;
    const anchor = spine[0];
    return {
      label: `Offer branch "${d.objection || d.branchId}" from the opening scene ${anchor.id}`,
      apply(current) {
        const next = clone(current);
        const target = (next.spine || [])[0];
        if (!target) return next;
        if (!Array.isArray(target.branchAnchors)) target.branchAnchors = [];
        if (!target.branchAnchors.includes(d.branchId)) target.branchAnchors.push(d.branchId);
        return next;
      },
    };
  },

  FONT_UNAVAILABLE(proof, finding) {
    const d = finding.detail || {};
    if (!d.family) return null;
    const brand = proof.brand || { faces: [] };
    const face = (brand.faces || []).find((f) => f.family === d.family && f.role === d.role);
    if (!face) return null;
    const weights = (face.weightsSeen || []).slice().sort((a, b) => a - b);
    const weight = d.role === 'display' ? (weights[weights.length - 1] || 700) : (weights[0] || 400);
    const resolution = resolveBoxFace(face.family, brand, weight);
    const stack = resolution.stack;
    if (!stack.length) return null;
    const same = stack.length === (face.fallbackStack || []).length
      && stack.every((s, i) => s === face.fallbackStack[i]);
    if (same) return null;
    return {
      // The face is still unavailable afterwards — that is a true fact about the
      // project, and it keeps being reported. What the fix changes is which face
      // takes its place: the metric-closest one available, rather than whatever
      // the machine happens to default to. That is the difference between a
      // substitution nobody notices and §22.2's overflow.
      effect: 'mitigates',
      label: `Set the ${d.role} fallback stack to ${stack.join(', ')}`,
      apply(current) {
        const next = clone(current);
        for (const f of next.brand.faces || []) {
          if (f.family !== d.family || f.role !== d.role) continue;
          f.fallbackStack = stack.slice();
          f.metricDelta = { ...resolution.metricDelta };
        }
        const path = `brand.faces.${d.family}.${d.role}.fallbackStack`;
        if (!next.brand.manualOverrides.includes(path)) next.brand.manualOverrides.push(path);
        return next;
      },
    };
  },

  PROVENANCE_UNLABELED(proof, finding) {
    const d = finding.detail || {};
    if (d.renditionId) {
      const rendition = (proof.renditions || []).find((r) => r.id === d.renditionId);
      if (!rendition || rendition.provenance !== 'verified-by-user') return null;
      return {
        label: `Demote "${rendition.label}" to illustrative — nobody has promoted it`,
        apply(current) {
          const next = clone(current);
          for (const r of next.renditions || []) {
            if (r.id === d.renditionId && r.provenance === 'verified-by-user') r.provenance = 'illustrative';
          }
          return next;
        },
      };
    }
    if (proof.emitOptions && proof.emitOptions.labelIllustrativeContent === false) {
      return {
        label: 'Label illustrative content, as §9 requires for a Review-reachable build',
        apply(current) {
          const next = clone(current);
          next.emitOptions.labelIllustrativeContent = true;
          return next;
        },
      };
    }
    return null;
  },
};

/**
 * The auto-fixes available for a finding list.
 *
 * Only findings that declared `autoFixAvailable` are considered, and a fixer may
 * still decline — the two agree by construction because the rule computes
 * `autoFixAvailable` from the same conditions the fixer checks.
 *
 * @param {import('../core/contracts.d.ts').Proof} proof
 * @param {import('../core/contracts.d.ts').Finding[]} findings
 * @returns {{finding: any, label: string, apply: (proof: any) => any}[]}
 */
export function autoFixes(proof, findings) {
  /** @type {{finding: any, label: string, apply: (proof: any) => any}[]} */
  const out = [];
  for (const finding of findings || []) {
    if (!finding || finding.autoFixAvailable !== true) continue;
    const fixer = FIXERS[finding.code];
    if (!fixer) continue;
    let fix = null;
    try {
      fix = fixer(proof, finding);
    } catch (e) {
      // A fixer that cannot compute its fix offers none. It never half-applies:
      // `apply` has not run at this point, and the proof is untouched either way.
      fix = null;
    }
    if (!fix) continue;
    out.push({
      finding,
      label: fix.label,
      apply: fix.apply,
      // 'resolves' — re-running preflight on the fixed proof no longer reports
      // this finding. 'plan' — the edit instructs the emitter, and the finding
      // clears when the emitter acts on it. Nothing else is legal.
      effect: fix.effect === 'plan' || fix.effect === 'mitigates' ? fix.effect : 'resolves',
    });
  }
  return out;
}

/**
 * Wrap an auto-fix as an undoable `CommandStack` command, stamped so the history
 * shows which entries the tool made rather than the user (§14: "every auto-fix
 * is logged and undoable").
 *
 * @param {import('../core/contracts.d.ts').Proof} proof   the current state
 * @param {{finding: any, label: string, apply: (proof: any) => any}} fix
 * @returns {import('../core/command.js').Command<any>}
 */
export function autoFixCommand(proof, fix) {
  return replaceCommand(fix.label, proof, fix.apply(proof), {
    scope: 'proof',
    meta: {
      autoFix: true,
      code: fix.finding.code,
      findingId: fix.finding.id,
      severity: fix.finding.severity,
      locus: fix.finding.locus,
    },
  });
}

/**
 * Apply a list of fixes in order, threading the proof through each. Returned as
 * a new proof; the input is untouched.
 * @param {any} proof
 * @param {{apply: (proof: any) => any}[]} fixes
 * @returns {any}
 */
export function applyAll(proof, fixes) {
  let current = proof;
  for (const fix of fixes || []) current = fix.apply(current);
  return current;
}

/** Codes this module can fix, for the studio's affordances and for the tests. */
export const FIXABLE_CODES = Object.keys(FIXERS).sort();
