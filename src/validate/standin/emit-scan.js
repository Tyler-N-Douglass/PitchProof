/**
 * STAND-IN for L10's `scanForNetworkReferences(html)` and
 * `assertProvenance(proof, html, css)` (`API.md` Part 3 → L10).
 *
 * L10 owns the authoritative versions and enforces them inside `emit()`, which
 * is where §22.6 requires the enforcement to live. This stand-in implements the
 * same two laws so L11's preflight can raise the same findings *before* the
 * seller reaches the emit button, and so this lane's tests could run before L10
 * landed. It follows D10 and D14: parse-shaped rather than a blanket grep, with
 * exactly three W3C namespace strings permitted as whole tokens.
 *
 * @module validate/standin/emit-scan
 */

import { makeFinding } from '../finding.js';

/** D14: the only three absolute URLs any artifact may contain, as whole tokens. */
export const NAMESPACE_ALLOWLIST = [
  'http://www.w3.org/2000/svg',
  'http://www.w3.org/1999/xlink',
  'http://www.w3.org/1999/xhtml',
];

/** Network constructors and APIs no artifact may name. */
const NETWORK_APIS = [
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon',
  'importScripts', 'navigator.connection',
];

/**
 * Replace every allowlisted namespace URL with a placeholder of equal length, so
 * the remaining scan sees only URLs that are genuinely locations.
 * @param {string} text
 * @returns {string}
 */
function maskNamespaces(text) {
  let out = text;
  for (const ns of NAMESPACE_ALLOWLIST) {
    out = out.split(ns).join('~'.repeat(ns.length));
  }
  return out;
}

/**
 * @param {string} html
 * @returns {import('../../core/contracts.d.ts').Finding[]}
 */
export function scanForNetworkReferences(html) {
  const source = String(html || '');
  const masked = maskNamespaces(source);
  /** @type {any[]} */
  const findings = [];
  /** @param {string} what @param {string} sample */
  const hit = (what, sample) => {
    findings.push(makeFinding({
      code: 'NETWORK_REFERENCE',
      key: `${what}:${sample}`,
      message: `The document contains a network reference (${what}): ${sample}. §1.1 and §13 make the emitted artifact inert on the network; remove it or inline the resource as a data: URI.`,
      detail: { kind: what, sample },
    }));
  };

  for (const m of masked.matchAll(/https?:\/\/[^\s"'`<>)]{1,120}/g)) hit('absolute URL', m[0]);
  for (const m of masked.matchAll(/(?:src|href)\s*=\s*"(\/\/[^"]{1,120})"/g)) hit('protocol-relative URL', m[1]);
  for (const m of masked.matchAll(/@import\s+[^;]{1,120}/g)) hit('@import', m[0].slice(0, 80));
  for (const m of masked.matchAll(/url\(\s*['"]?(?!data:|#)([^)'"]{1,120})\)/g)) hit('external url()', m[1]);
  for (const api of NETWORK_APIS) {
    const re = new RegExp(`\\b${api.replace('.', '\\.')}\\s*\\(`, 'g');
    for (const m of masked.matchAll(re)) hit('network API', m[0]);
  }
  for (const m of masked.matchAll(/(?:src|href)\s*=\s*"(?!data:|#|about:blank)([^"]{1,120})"/g)) {
    hit('non-data resource reference', m[1]);
  }
  return findings;
}

/**
 * §9/§18/§22.6, enforced against the rendered document rather than the model.
 * @param {import('../../core/contracts.d.ts').Proof} proof
 * @param {string} html
 * @param {string} [css]
 * @returns {import('../../core/contracts.d.ts').Finding[]}
 */
export function assertProvenance(proof, html, css) {
  const doc = String(html || '');
  const sheet = String(css || '');
  /** @type {any[]} */
  const findings = [];
  const label = proof.emitOptions ? proof.emitOptions.labelIllustrativeContent !== false : true;
  if (!label) return findings;

  const hidden = /\.pp-provenance[^{]*\{[^}]*(display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?!\.\d*[1-9])|font-size\s*:\s*(?:[0-9]|10)(?:\.\d+)?px)/i.test(sheet);

  for (const rendition of proof.renditions || []) {
    if (rendition.provenance !== 'illustrative') continue;
    const shown = (proof.spine || []).concat(...(proof.branches || []).map((b) => b.scenes))
      .some((s) => (s.renditionIds || []).includes(rendition.id));
    if (!shown) continue;
    const labelled = doc.includes(rendition.id) && /class="[^"]*pp-provenance/.test(doc);
    if (!labelled) {
      findings.push(makeFinding({
        code: 'PROVENANCE_UNLABELED',
        locus: { specimenId: rendition.specimenId },
        key: `unlabelled:${rendition.id}`,
        message: `Rendition "${rendition.label}" is illustrative but the rendered document carries no pp-provenance label for it. §18.1 requires the label, and it may not be omitted.`,
        detail: { renditionId: rendition.id },
      }));
    } else if (hidden) {
      findings.push(makeFinding({
        code: 'PROVENANCE_UNLABELED',
        locus: { specimenId: rendition.specimenId },
        key: `hidden:${rendition.id}`,
        message: `The illustrative-content label for "${rendition.label}" is present but styled to invisibility. §18.1 forbids styling the label below legibility.`,
        detail: { renditionId: rendition.id },
      }));
    }
  }
  return findings;
}
