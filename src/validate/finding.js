/**
 * Finding construction and ordering.
 *
 * The §4 `Finding` is frozen at six fields. This module mints them and does two
 * things the contract leaves to the lane:
 *
 *  - **Ids are content-derived** (§5). A finding's id is a hash of its code, its
 *    locus and a stable key — never of its measured numbers, so a proof that
 *    still has the same defect keeps the same finding id between runs even if a
 *    breakpoint moves a measurement by a fraction of a pixel. Same defect, same
 *    id, every time; that is what lets the studio remember which findings a user
 *    has already looked at.
 *  - **Ordering is total and deterministic** (§14's "the same proof produces the
 *    same findings in the same order, every time"). Severity first, because the
 *    blocking ones are what the seller has to act on; then the contract's own
 *    code order; then locus; then the key. No two findings can compare equal
 *    unless they are the same finding.
 *
 * One optional field is added beyond the frozen six: `detail`, a plain object of
 * machine-readable numbers (the measured excess, the breakpoint, the resolved
 * face). §4 permits optional extensions, and the auto-fixer and the studio both
 * need the numbers without re-parsing the message.
 *
 * @module validate/finding
 */

import { contentId } from '../core/ids.js';
import { FINDING_CODES } from '../core/contracts.js';
import { resolveSeverity } from './severity.js';

/** Locus keys, in the order the contract declares them. */
const LOCUS_KEYS = ['sceneId', 'branchId', 'specimenId', 'assetId'];

const CODE_ORDER = new Map(FINDING_CODES.map((c, i) => [c, i]));

/**
 * Drop empty locus slots so two findings that name the same place hash the same
 * way regardless of which optional slots the caller passed as undefined.
 * @param {Record<string, string|undefined|null>} [locus]
 * @returns {{sceneId?: string, branchId?: string, specimenId?: string, assetId?: string}}
 */
export function compactLocus(locus) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const k of LOCUS_KEYS) {
    const v = locus ? locus[k] : undefined;
    if (typeof v === 'string' && v.length > 0) out[k] = v;
  }
  return out;
}

/**
 * Mint a Finding.
 *
 * @param {object} spec
 * @param {string} spec.code                      a FindingCode
 * @param {string} spec.message                   what a seller reads and acts on
 * @param {Record<string, string|undefined|null>} [spec.locus]
 * @param {string} [spec.key]                     disambiguates two findings of the same code at the same locus
 * @param {1|2|3} [spec.severity]                 only legal inside the code's documented band
 * @param {boolean} [spec.autoFixAvailable]
 * @param {Record<string, unknown>} [spec.detail] optional machine-readable numbers
 * @returns {import('../core/contracts.d.ts').Finding & {detail?: Record<string, unknown>}}
 */
export function makeFinding(spec) {
  const code = spec.code;
  if (!CODE_ORDER.has(code)) throw new Error(`makeFinding: unknown finding code ${String(code)}`);
  if (typeof spec.message !== 'string' || spec.message.trim() === '') {
    throw new Error(`makeFinding: ${code} needs a message a seller can act on`);
  }
  const locus = compactLocus(spec.locus);
  const key = spec.key === undefined || spec.key === null ? '' : String(spec.key);
  const severity = resolveSeverity(code, spec.severity);
  /** @type {any} */
  const finding = {
    id: contentId('finding', { code, locus, key }),
    severity,
    code,
    message: spec.message,
    locus,
    autoFixAvailable: spec.autoFixAvailable === true,
  };
  if (spec.detail && typeof spec.detail === 'object') finding.detail = spec.detail;
  return finding;
}

/**
 * The sort key of a finding, as a comparable tuple.
 * @param {any} f
 * @returns {(string|number)[]}
 */
function sortKey(f) {
  return [
    f.severity,
    CODE_ORDER.has(f.code) ? CODE_ORDER.get(f.code) : FINDING_CODES.length,
    f.locus?.sceneId || '',
    f.locus?.branchId || '',
    f.locus?.specimenId || '',
    f.locus?.assetId || '',
    f.id,
  ];
}

/**
 * Total order over findings. Stable, deterministic and independent of the order
 * the rules happened to run in.
 * @param {any} a
 * @param {any} b
 * @returns {number}
 */
export function compareFindings(a, b) {
  const ka = sortKey(a);
  const kb = sortKey(b);
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] === kb[i]) continue;
    if (typeof ka[i] === 'number' && typeof kb[i] === 'number') return /** @type {number} */ (ka[i]) - /** @type {number} */ (kb[i]);
    return String(ka[i]) < String(kb[i]) ? -1 : 1;
  }
  return 0;
}

/**
 * Sort a finding list into the canonical order, dropping exact duplicates by id.
 * Two rules that reach the same conclusion about the same place produce one
 * finding, not two.
 * @param {any[]} findings
 * @returns {any[]}
 */
export function sortFindings(findings) {
  /** @type {Map<string, any>} */
  const byId = new Map();
  for (const f of findings || []) {
    if (!f) continue;
    const prior = byId.get(f.id);
    // A duplicate id with a worse severity wins: the more serious reading of the
    // same defect is the one the seller needs to see.
    if (!prior || f.severity < prior.severity) byId.set(f.id, f);
  }
  return [...byId.values()].sort(compareFindings);
}

/**
 * Round a pixel measurement for display. Two decimals is finer than any screen
 * and coarse enough that a message is stable to read.
 * @param {number} n
 * @returns {number}
 */
export function px(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Format a ratio as a percentage with one decimal, for messages.
 * @param {number} n
 * @returns {string}
 */
export function pct(n) {
  return `${(Math.round(n * 1000) / 10).toFixed(1)}%`;
}
