/**
 * The rules engine: one rule per `FindingCode`, all fourteen (§4, §14).
 *
 * A rule is data, not a special case buried in a sweep function. Each declares
 * its code, its severity, what it inspects and whether it can offer an auto-fix,
 * and each returns `Finding[]` for a shared, read-only context. That shape buys
 * three things the spec asks for:
 *
 *  - **Determinism** (§5, §14). Rules run in the contract's own code order and
 *    every rule sorts its own output, so the same proof produces the same
 *    findings in the same order, every time, on every machine.
 *  - **A legible engine.** `RULES.map(r => r.code)` is the coverage list, and a
 *    test asserts it is exactly `FINDING_CODES` — a fifteenth code added to the
 *    contract fails the suite instead of being silently unchecked.
 *  - **No override surface.** Nothing here takes a flag that suppresses a
 *    finding, and `resolveSeverity` refuses to lower one below its declared
 *    value. §14 says severity 1 blocks emit and there is no override flag; the
 *    way to keep that true is to never build the parameter that would become
 *    one.
 *
 * @module validate/rules
 */

import {
  FINDING_CODES, QUALITY_STEPS, blockText, countWords,
} from '../core/contracts.js';
import { contentHash } from '../core/hash.js';
import { utf8Length, parseDataUri, base64Decode, utf8Decode } from '../core/bytes.js';
import { sceneRevealsNothing } from '../runtime/beats.js';
import { SPINE } from '../runtime/deck.js';
import { makeFinding, sortFindings } from './finding.js';
import { severityOf } from './severity.js';
import { detectOverflow, faceResolutions, resolveBoxFace, advanceDeltaOf } from './overflow.js';
import { checkContrast } from './contrast.js';
import {
  hasPromotionRecord, reviewReachable, renderedRenditionIds, scenesShowing,
} from './provenance.js';

// ---------------------------------------------------------------------------
// Thresholds the rules are held to, stated once
// ---------------------------------------------------------------------------

/** §6: a specimen older than this at emit time is a stale capture. */
export const STALE_CAPTURE_DAYS = 30;

/** §8 caps captured media at a 2400px long edge; anything larger was never downscaled. */
export const MAX_MEDIA_EDGE_PX = 2400;

/**
 * An asset is oversize when it eats this fraction of the whole byte budget, or
 * when it exceeds the absolute floor. One asset taking an eighth of the budget
 * is one asset the budgeter will have to degrade, so the seller should know
 * before it happens rather than read about it in the degradation report.
 */
export const ASSET_OVERSIZE_BUDGET_RATIO = 0.08;
/** @see ASSET_OVERSIZE_BUDGET_RATIO */
export const ASSET_OVERSIZE_FLOOR_BYTES = 1_000_000;

/**
 * How much of the model JSON survives compression and base64, measured against
 * D5/D6's numbers: text deflates four to six times over, and the compressed blob
 * is then base64'd at 4/3. 0.30 is the conservative end of that range, so the
 * estimate errs towards warning early rather than surprising late.
 */
export const MODEL_COMPRESSION_ESTIMATE = 0.30;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Every scene in the proof, spine first, then each branch in declaration order. */
export function allScenes(proof) {
  /** @type {{scene: any, branchId: string|null}[]} */
  const out = [];
  for (const scene of proof.spine || []) out.push({ scene, branchId: null });
  for (const branch of proof.branches || []) {
    for (const scene of branch.scenes || []) out.push({ scene, branchId: branch.id });
  }
  return out;
}

/** Every media reference in the proof, with the container that owns it. */
function allMedia(proof) {
  /** @type {{media: any, ownerKind: 'specimen'|'rendition', ownerId: string, specimenId: string|null}[]} */
  const out = [];
  for (const specimen of proof.specimens || []) {
    for (const media of specimen.media || []) {
      out.push({ media, ownerKind: 'specimen', ownerId: specimen.id, specimenId: specimen.id });
    }
  }
  for (const rendition of proof.renditions || []) {
    for (const media of rendition.media || []) {
      out.push({ media, ownerKind: 'rendition', ownerId: rendition.id, specimenId: rendition.specimenId || null });
    }
  }
  return out;
}

/**
 * What a media reference costs the artifact: the **inlined** size of its data
 * URI, base64 expansion and `data:` preamble included.
 *
 * One quantity, measured one way (L11-D24). This used to be three: a declared
 * `MediaRef.bytes`, else `parseDataUri().bytes`, else 3/4 of the URI's length —
 * and the first meant something different from the other two, so a ref that
 * declared its size was graded against a different number from one that did not.
 * Nothing noticed until §4's `bytes` was redefined as the inlined cost (L6's F19)
 * and the primary path silently changed meaning while the fallbacks did not.
 *
 * So the data URI *is* the measurement, and a declared `bytes` is a cross-check
 * rather than a source of truth — `ASSET_OVERSIZE` reports both when they differ,
 * so a model whose declaration has drifted says so instead of being believed.
 * The declaration is used only when there is nothing inlined to measure: a ref
 * still pointing at the network (which `NETWORK_REFERENCE` blocks on its own
 * account) or one with no payload at all.
 *
 * Because the result is already expanded, **nothing downstream may multiply it
 * by a base64 factor again.** That constant no longer exists here, so the
 * temptation cannot be acted on.
 *
 * @param {import('../core/contracts.d.ts').MediaRef} media
 * @returns {number} bytes the artifact pays for this asset
 */
function mediaBytes(media) {
  if (!media) return 0;
  const uri = typeof media.dataUri === 'string' ? media.dataUri : '';
  if (uri.startsWith('data:')) return utf8Length(uri);
  if (Number.isFinite(media.bytes) && media.bytes > 0) return media.bytes;
  return utf8Length(uri);
}

/**
 * The size a `MediaRef` claims, when it claims one that disagrees with what it
 * actually carries. `null` when it agrees, or when there is nothing to compare.
 * @param {import('../core/contracts.d.ts').MediaRef} media
 * @returns {number|null}
 */
function declaredBytesMismatch(media) {
  if (!media || !Number.isFinite(media.bytes) || media.bytes <= 0) return null;
  const uri = typeof media.dataUri === 'string' ? media.dataUri : '';
  if (!uri.startsWith('data:')) return null;
  return media.bytes === utf8Length(uri) ? null : media.bytes;
}

/** `parseDataUri`, but a malformed percent-escape is "not a data URI" rather than a throw. */
function safeParseDataUri(uri) {
  try { return parseDataUri(uri); } catch { return null; }
}

/** The text a data URI carries, or `''` when it cannot be decoded. */
function dataUriText(parsed) {
  try {
    return parsed.base64 ? utf8Decode(base64Decode(parsed.body)) : decodeURIComponent(parsed.body);
  } catch { return ''; }
}

/**
 * Does a `LogoAsset` carry a payload the artifact can actually draw?
 *
 * §4 documents `LogoAsset.data` as "inline SVG markup or data URI" for **either**
 * `kind`, so a `kind: 'svg'` logo holding `data:image/svg+xml,…` is contract-legal
 * and this rule accepts it (L11-D21). What it still refuses is a payload with
 * nothing in it: an SVG-typed data URI whose decoded body has no `<svg` element
 * is as empty as an empty string, and the check that catches inline markup with
 * no `<svg` in it should catch that too rather than waving it through on the
 * strength of the `data:` prefix. A data URI of some other type is accepted —
 * a PNG payload on a `kind: 'svg'` logo is a mislabelled kind, not a missing
 * asset, and `ASSET_MISSING` is not the code for it.
 *
 * @param {string} kind  `'svg'` or `'raster'`
 * @param {string} data  the trimmed payload
 * @returns {boolean}
 */
export function logoPayloadUsable(kind, data) {
  if (!data) return false;
  const parsed = safeParseDataUri(data);
  if (kind !== 'svg') return Boolean(parsed);
  if (/<svg[\s>]/i.test(data)) return true;
  if (!parsed) return false;
  if (/^image\/svg\+xml\b/i.test(parsed.mime)) return /<svg[\s>]/i.test(dataUriText(parsed));
  return parsed.bytes > 0;
}

/** Days between two ISO instants, positive when `later` is after `earlier`. */
export function daysBetween(earlier, later) {
  const a = Date.parse(earlier);
  const b = Date.parse(later);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return (b - a) / 86_400_000;
}

/** The externally-addressed references a raw HTML block would carry into the artifact. */
export function externalRefsIn(html) {
  const source = String(html || '');
  /** @type {string[]} */
  const hits = [];
  for (const m of source.matchAll(/\b(?:src|href|srcset|poster|data)\s*=\s*["']([^"']{1,200})["']/gi)) {
    const value = m[1].trim();
    if (/^(?:data:|#|about:blank)/i.test(value)) continue;
    hits.push(value);
  }
  for (const m of source.matchAll(/@import\s+[^;]{1,120}/gi)) hits.push(m[0].trim());
  for (const m of source.matchAll(/url\(\s*['"]?(?!data:|#)([^)'"]{1,200})\)/gi)) hits.push(m[1].trim());
  for (const m of source.matchAll(/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts)\s*\(/gi)) {
    hits.push(m[0].trim());
  }
  return hits;
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Rule
 * @property {string} code           the FindingCode this rule owns
 * @property {1|2|3} severity        the declared severity — the worst it produces
 * @property {string} title          short human name
 * @property {string} inspects       what the rule looks at
 * @property {boolean} autoFixable   whether any of its findings can be auto-fixed
 * @property {(ctx: any) => any[]} run
 */

/** @type {Rule} */
const assetMissing = {
  code: 'ASSET_MISSING',
  severity: severityOf('ASSET_MISSING'),
  title: 'Missing asset',
  inspects: 'every media block reference, media data URI, logo payload, and every scene reference to a specimen or a rendition',
  autoFixable: true,
  run(ctx) {
    const { proof, deck } = ctx;
    /** @type {any[]} */
    const out = [];
    const specimenById = new Map((proof.specimens || []).map((s) => [s.id, s]));
    const renditionById = new Map((proof.renditions || []).map((r) => [r.id, r]));
    const globalMedia = new Set(allMedia(proof).map((m) => m.media && m.media.id).filter(Boolean));

    /**
     * @param {any} owner
     * @param {'specimen'|'rendition'} kind
     */
    const checkBlocks = (owner, kind) => {
      const own = new Set((owner.media || []).map((m) => m && m.id).filter(Boolean));
      (owner.blocks || []).forEach((block, i) => {
        if (!block || block.type !== 'media') return;
        if (own.has(block.ref) || globalMedia.has(block.ref)) return;
        const specimenId = kind === 'specimen' ? owner.id : owner.specimenId || null;
        out.push(makeFinding({
          code: 'ASSET_MISSING',
          locus: { specimenId: specimenId || undefined, assetId: block.ref },
          key: `block:${owner.id}:${i}`,
          autoFixAvailable: true,
          message: `Block ${i} of ${kind} "${owner.title || owner.label || owner.id}" shows media "${block.ref}", and no media reference with that id exists in the proof. It would render as a broken image in front of the client.`,
          detail: { ownerKind: kind, ownerId: owner.id, blockIndex: i, ref: block.ref },
        }));
      });
    };

    for (const specimen of proof.specimens || []) checkBlocks(specimen, 'specimen');
    for (const rendition of proof.renditions || []) checkBlocks(rendition, 'rendition');

    for (const entry of allMedia(proof)) {
      const media = entry.media;
      if (!media) continue;
      const uri = typeof media.dataUri === 'string' ? media.dataUri : '';
      if (uri && parseDataUri(uri)) continue;
      out.push(makeFinding({
        code: 'ASSET_MISSING',
        locus: { specimenId: entry.specimenId || undefined, assetId: media.id },
        key: `payload:${media.id}`,
        message: `Media "${media.id}" on ${entry.ownerKind} ${entry.ownerId} carries ${uri ? 'a data URI that cannot be parsed' : 'no data URI at all'}. §13 inlines every asset by emit time; this one has nothing to inline.`,
        detail: { ownerKind: entry.ownerKind, ownerId: entry.ownerId, mediaId: media.id },
      }));
    }

    for (const logo of (proof.brand && proof.brand.logos) || []) {
      const data = typeof logo.data === 'string' ? logo.data.trim() : '';
      if (logoPayloadUsable(logo.kind, data)) continue;
      out.push(makeFinding({
        code: 'ASSET_MISSING',
        locus: { assetId: logo.id },
        key: `logo:${logo.id}`,
        message: `The ${logo.variant} logo carries no usable ${logo.kind === 'svg' ? 'SVG markup or data URI' : 'data URI'}. The artifact would present the prospect's brand without their mark.`,
        detail: { logoId: logo.id, variant: logo.variant, kind: logo.kind },
      }));
    }

    // A scene anchoring a branch that is not in the proof is **not** reported
    // here. It was, until CRITIQUE-2's C10: it is a branch-topology failure and
    // it belongs in the branch bucket a consumer filters on, so it moved to the
    // `BRANCH_UNREACHABLE` rule (L11-D25). This rule owns assets.
    for (const { scene, branchId } of allScenes(proof)) {
      const reachable = !deck || deck.sceneLocator.has(scene.id);
      if (scene.specimenId && !specimenById.has(scene.specimenId)) {
        out.push(makeFinding({
          code: 'ASSET_MISSING',
          severity: reachable ? 1 : 2,
          locus: { sceneId: scene.id, branchId: branchId || undefined, specimenId: scene.specimenId },
          key: `scene-specimen:${scene.id}`,
          message: `Scene ${scene.id} is built on specimen "${scene.specimenId}", which is not in the proof. The "before" side of this scene would be empty.`,
          detail: { sceneId: scene.id, specimenId: scene.specimenId },
        }));
      }
      for (const id of scene.renditionIds || []) {
        if (renditionById.has(id)) continue;
        out.push(makeFinding({
          code: 'ASSET_MISSING',
          severity: reachable ? 1 : 2,
          locus: { sceneId: scene.id, branchId: branchId || undefined },
          key: `scene-rendition:${scene.id}:${id}`,
          message: `Scene ${scene.id} shows rendition "${id}", which is not in the proof. The "after" side of this scene would be empty.`,
          detail: { sceneId: scene.id, renditionId: id },
        }));
      }
    }
    return sortFindings(out);
  },
};

/** @type {Rule} */
const assetOversize = {
  code: 'ASSET_OVERSIZE',
  severity: severityOf('ASSET_OVERSIZE'),
  title: 'Oversize asset',
  inspects: 'every media reference, against the byte budget and the §8 capture cap',
  autoFixable: true,
  run(ctx) {
    const { proof } = ctx;
    const maxBytes = (proof.emitOptions && proof.emitOptions.maxBytes) || 25_000_000;
    const limit = Math.max(ASSET_OVERSIZE_FLOOR_BYTES, maxBytes * ASSET_OVERSIZE_BUDGET_RATIO);
    const quality = (proof.emitOptions && proof.emitOptions.imageQuality) || 0.85;
    const canRecompress = QUALITY_STEPS.indexOf(quality) > 0;
    /** @type {any[]} */
    const out = [];
    for (const entry of allMedia(proof)) {
      const media = entry.media;
      if (!media) continue;
      const bytes = mediaBytes(media);
      const edge = Math.max(media.intrinsic?.w || 0, media.intrinsic?.h || 0);
      const overBytes = bytes > limit;
      const overEdge = edge > MAX_MEDIA_EDGE_PX;
      if (!overBytes && !overEdge) continue;
      const reasons = [];
      if (overBytes) reasons.push(`${(bytes / 1e6).toFixed(2)}MB inlined is ${((bytes / maxBytes) * 100).toFixed(1)}% of the ${(maxBytes / 1e6).toFixed(0)}MB budget`);
      if (overEdge) reasons.push(`its ${edge}px long edge exceeds the ${MAX_MEDIA_EDGE_PX}px capture cap in §8`);
      out.push(makeFinding({
        code: 'ASSET_OVERSIZE',
        locus: { specimenId: entry.specimenId || undefined, assetId: media.id },
        key: `oversize:${media.id}`,
        autoFixAvailable: canRecompress,
        message: `Media "${media.id}" on ${entry.ownerKind} ${entry.ownerId} is oversize: ${reasons.join(', ')}. The emitter's budgeter will degrade it and report the loss; ${canRecompress ? `recompressing the project at quality ${QUALITY_STEPS[QUALITY_STEPS.indexOf(quality) - 1]} first keeps the choice yours` : 'the project is already at the lowest quality step, so replace the asset with a smaller one'}.`,
        detail: {
          mediaId: media.id, bytes, limitBytes: Math.round(limit), edgePx: edge,
          ownerKind: entry.ownerKind, ownerId: entry.ownerId, quality,
          // Non-null when the ref declares a size that is not what it carries.
          // Not a finding of its own — §4 has no code for it — but the seller
          // should not be shown a number the model disagrees with in silence.
          declaredBytes: declaredBytesMismatch(media),
        },
      }));
    }
    return sortFindings(out);
  },
};

/** @type {Rule} */
const fontUnavailable = {
  code: 'FONT_UNAVAILABLE',
  severity: severityOf('FONT_UNAVAILABLE'),
  title: 'Typeface unavailable to the artifact',
  inspects: "every brand TypeFace, resolved through its own fallback stack the way a browser would",
  autoFixable: true,
  run(ctx) {
    const { proof } = ctx;
    /** @type {any[]} */
    const out = [];
    for (const { face, resolution } of faceResolutions(proof.brand || { faces: [] })) {
      if (resolution.available) continue;
      // A fix is offered only when it changes what actually renders: when the
      // declared stack names no concrete available family before its generic, so
      // the artifact lands on whatever the platform defaults to. A stack that
      // already resolves to a real family is doing its job, and offering to
      // append two more fallbacks after it is a no-op — which is how an auto-fix
      // panel loses its meaning.
      const recommended = resolution.stack;
      const improvable = resolution.landsOnDefault === true;
      // A face this build has no published metrics for reports `metricDelta:
      // null` rather than pretending the substitution is free (§4 permits it).
      const delta = advanceDeltaOf(resolution);
      const drift = delta === null
        ? 'no published metrics, so the movement is unmeasured'
        : `${delta > 1 ? '+' : ''}${((delta - 1) * 100).toFixed(1)}% average advance`;
      const confidence = `${Math.round(resolution.confidence * 100)}%`;
      out.push(makeFinding({
        code: 'FONT_UNAVAILABLE',
        key: `face:${face.family}:${face.role}`,
        autoFixAvailable: improvable,
        message: `The ${face.role} face "${face.family}" is not embeddable and is not a system family, so the artifact will render it in ${resolution.resolved} (${drift} average advance, ${confidence} confidence in the metrics). Every measurement in preflight already assumes that substitution; supply a licensed font file to embed, or accept the fallback and check the overflow findings.`,
        detail: {
          family: face.family, role: face.role, resolved: resolution.resolved,
          stack: resolution.stack, metricDelta: resolution.metricDelta,
          known: resolution.known, confidence: resolution.confidence,
          embeddable: face.embeddable === true, recommendedStack: recommended,
        },
      }));
    }
    return sortFindings(out);
  },
};

/** @type {Rule} */
const textOverflow = {
  code: 'TEXT_OVERFLOW',
  severity: severityOf('TEXT_OVERFLOW'),
  title: 'Text overflow after font substitution',
  inspects: 'every text box of every scene at all three breakpoints, measured in the face that will actually render',
  autoFixable: false,
  run(ctx) {
    /** @type {any[]} */
    const out = [];
    for (const measurement of ctx.measurements || []) {
      out.push(...detectOverflow(measurement, ctx.proof.brand));
    }
    return sortFindings(out);
  },
};

/** @type {Rule} */
const contrastFail = {
  code: 'CONTRAST_FAIL',
  severity: severityOf('CONTRAST_FAIL'),
  title: 'Contrast below the WCAG minimum',
  inspects: 'every text/background pair in the brand palette, computed exactly',
  autoFixable: true,
  run(ctx) {
    return checkContrast(ctx.proof.brand, { contrastRatio: ctx.deps.contrastRatio });
  },
};

/**
 * Roughly what an unreachable branch still costs the artifact.
 *
 * §14 makes `BRANCH_UNREACHABLE` a warning, and it should stay one — a branch
 * with no way in is a tidiness problem, not a deck that breaks in front of the
 * room. But the emitter ships its scenes regardless: the copy, the specimens and
 * the inlined media all go into the file and all count against §13's byte
 * budget, and until now nothing told the seller that is what they were paying
 * for. This is the number the message quotes (L11-D23).
 *
 * Two parts, estimated the same way `SIZE_BUDGET_EXCEEDED` estimates the whole:
 * the branch's own scene JSON after compression, and the media belonging to
 * specimens and renditions **nothing else in the deck shows**. Media shared with
 * a reachable scene is not a cost of the branch — removing the branch would not
 * recover it — so it is left out rather than double-counted.
 *
 * @param {import('../core/contracts.d.ts').Proof} proof
 * @param {import('../core/contracts.d.ts').Branch} branch
 * @returns {{sceneCount: number, modelBytes: number, mediaBytes: number, totalBytes: number, exclusiveSources: string[]}}
 */
export function branchShipCost(proof, branch) {
  const scenes = (branch && branch.scenes) || [];
  if (scenes.length === 0) {
    return { sceneCount: 0, modelBytes: 0, mediaBytes: 0, totalBytes: 0, exclusiveSources: [] };
  }
  const modelBytes = utf8Length(JSON.stringify(scenes)) * MODEL_COMPRESSION_ESTIMATE;

  /** @type {Set<string>} */
  const mine = new Set();
  /** @type {Set<string>} */
  const elsewhere = new Set();
  for (const { scene, branchId } of allScenes(proof)) {
    const into = branchId === (branch && branch.id) ? mine : elsewhere;
    if (scene.specimenId) into.add(scene.specimenId);
    for (const id of scene.renditionIds || []) into.add(id);
  }
  const exclusive = [...mine].filter((id) => !elsewhere.has(id)).sort();

  const owners = new Map();
  for (const specimen of proof.specimens || []) owners.set(specimen.id, specimen);
  for (const rendition of proof.renditions || []) owners.set(rendition.id, rendition);

  let media = 0;
  for (const id of exclusive) {
    const owner = owners.get(id);
    for (const m of (owner && owner.media) || []) media += mediaBytes(m);
  }

  return {
    sceneCount: scenes.length,
    modelBytes: Math.round(modelBytes),
    mediaBytes: Math.round(media),
    totalBytes: Math.round(modelBytes + media),
    exclusiveSources: exclusive,
  };
}

/** Bytes at a scale a seller reads at a glance. */
export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}MB`;
  if (n >= 1000) return `${Math.round(n / 1000)}KB`;
  return `${Math.round(n)} bytes`;
}

/**
 * §11's reachability failures, from both ends of the anchor edge.
 *
 * The declared half is L9's coverage list: a branch with no anchoring scene and
 * no jump-index entry. The other half is the mirror image — a scene whose
 * `branchAnchors` names a branch the proof does not contain — and it lives here
 * rather than under `ASSET_MISSING`, where it was filed until CRITIQUE-2's C10
 * (L11-D25). Both are answers to one question a consumer asks by filtering on a
 * code: *what is wrong with the branch graph?*
 *
 * @type {Rule}
 */
const branchUnreachable = {
  code: 'BRANCH_UNREACHABLE',
  severity: severityOf('BRANCH_UNREACHABLE'),
  title: 'Branch with no way in, or an anchor with no branch',
  inspects: '§11 coverage from both ends: every branch, for an anchoring scene or a jump-index entry and what its scenes cost the artifact if it has neither; and every scene anchor, for the branch it names',
  autoFixable: true,
  run(ctx) {
    const coverage = ctx.deps.branchCoverage(ctx.deck);
    const byId = new Map((ctx.proof.branches || []).map((b) => [b.id, b]));
    /** @type {any[]} */
    const out = (coverage.unreachable || []).map((branchId) => {
      const branch = byId.get(branchId);
      const cost = branchShipCost(ctx.proof, branch || { id: branchId, scenes: [] });
      const ships = cost.sceneCount === 0
        ? 'It has no scenes, so it costs the artifact nothing.'
        : `Its ${cost.sceneCount === 1 ? 'scene ships' : `${cost.sceneCount} scenes ship`} in the artifact anyway — the emitter drops nothing the model declares — at an estimated ${formatBytes(cost.totalBytes)} against the byte budget${cost.mediaBytes > 0 ? `, ${formatBytes(cost.mediaBytes)} of it media nothing else in the deck shows` : ''}. That is weight the client downloads to reach content no key opens.`;
      return makeFinding({
        code: 'BRANCH_UNREACHABLE',
        locus: { branchId },
        key: `unreachable:${branchId}`,
        autoFixAvailable: true,
        message: `Branch "${branch ? branch.objection || branchId : branchId}" has no anchoring scene and no jump-index entry, so no key the presenter can press reaches it. ${ships} Give it the objection in the client's words (which puts it in the jump index), or anchor it to the scene where that objection lands — auto-fix offers it from the opening scene. If it is not worth presenting, delete it: nothing else removes it from the file.`,
        detail: {
          branchId,
          objection: branch ? branch.objection : null,
          sceneCount: cost.sceneCount,
          shippedBytes: cost.totalBytes,
          shippedModelBytes: cost.modelBytes,
          shippedMediaBytes: cost.mediaBytes,
          exclusiveSources: cost.exclusiveSources,
        },
      });
    });

    // The other end of the edge. `buildDeck` filters an anchor that names
    // nothing, so no key is offered and nobody is stranded — severity 2, which
    // is this code's declared value. What is wrong is that the model says this
    // scene offers a branch: the studio counts the anchor when it reports how
    // many branches a scene offers, and the objection the anchor was placed for
    // has no way in from here.
    const declared = new Set((ctx.proof.branches || []).map((b) => b && b.id).filter(Boolean));
    for (const { scene, branchId } of allScenes(ctx.proof)) {
      for (const anchored of scene.branchAnchors || []) {
        if (declared.has(anchored)) continue;
        out.push(makeFinding({
          code: 'BRANCH_UNREACHABLE',
          severity: 2,
          locus: { sceneId: scene.id, branchId: anchored },
          key: `ghost-anchor:${scene.id}:${anchored}`,
          // No auto-fix: the two remedies are to delete an anchor the seller
          // authored on purpose or to restore a branch that is not in the file,
          // and a fix may not choose between them (L11-D25).
          message: `Scene ${scene.id} anchors branch "${anchored}", which is not in the proof. The deck drops an anchor that names nothing, so the artifact offers no key for it — but the objection this scene was meant to answer now has no way in from here, and the studio still counts the anchor when it says how many branches the scene offers. Remove the anchor, or restore the branch it names.`,
          detail: { sceneId: scene.id, branchId: anchored, kind: 'branch-anchor', inBranchId: branchId || null },
        }));
      }
    }

    return sortFindings(out);
  },
};

/**
 * §11's return failures, separated by cause.
 *
 * L9 reports *why* a branch has no resolved return, and the causes are not
 * equally serious. A branch with no scenes, or a proof with no spine, or an
 * anchor chain that never reaches the spine, leaves a presenter with nowhere to
 * go — §22.4's failure exactly, and severity 1. A branch that is merely
 * **unanchored** is different: it is still reachable from the jump index, and a
 * jump returns to the position it was made from, so nobody is stranded. What is
 * missing is the declaration, not the way back. That narrows to severity 2 (L9's
 * reading, relayed at integration and recorded in `docs/decisions/L11-validate.md`).
 */
const RETURN_REASONS = {
  'no-scenes': { severity: 1, why: 'it has no scenes at all, so there is no last scene to return from', fix: null },
  'nothing-to-return-from': { severity: 1, why: 'it has no scenes at all, so there is no last scene to return from', fix: null },
  'empty-spine': { severity: 1, why: 'its return policy is "nextSpineScene" and the spine is empty', fix: null },
  'anchor-chain-never-reaches-spine': { severity: 1, why: 'its return policy is "nextSpineScene" but its anchor chain never reaches the spine', fix: 'anchor-policy' },
  unanchored: { severity: 2, why: 'no scene anchors it, so the deck does not declare where it belongs', fix: 'anchor-scene' },
};

/** @type {Rule} */
const branchNoReturn = {
  code: 'BRANCH_NO_RETURN',
  severity: severityOf('BRANCH_NO_RETURN'),
  title: 'Branch with no way back',
  inspects: '§11 coverage: every branch, for a resolvable return target on its last scene',
  autoFixable: true,
  run(ctx) {
    const coverage = ctx.deps.branchCoverage(ctx.deck);
    const byId = new Map((ctx.proof.branches || []).map((b) => [b.id, b]));
    const detailById = new Map(((coverage.details) || []).map((d) => [d.branchId, d]));
    const spineLength = (ctx.proof.spine || []).length;

    return sortFindings((coverage.noReturn || []).map((branchId) => {
      const branch = byId.get(branchId);
      const detail = detailById.get(branchId);
      const reasons = (detail && detail.reasons) || [];
      // The most serious reason decides, so a branch that is both unanchored and
      // empty is reported at the severity the emptiness earns.
      let worst = { severity: /** @type {1|2} */ (1), why: 'its return target cannot be resolved', fix: null };
      let found = false;
      for (const reason of reasons) {
        const known = RETURN_REASONS[reason];
        if (!known) continue;
        if (!found || known.severity < worst.severity) { worst = known; found = true; }
      }
      const canFix = worst.fix === 'anchor-policy'
        || (worst.fix === 'anchor-scene' && spineLength > 0);
      const remedy = worst.fix === 'anchor-policy'
        ? 'Auto-fix returns it to its anchor instead, which is a position that exists.'
        : worst.fix === 'anchor-scene'
          ? (spineLength > 0
            ? 'Auto-fix anchors it to the opening scene so the deck declares where it belongs; move the anchor to wherever the objection actually lands.'
            : 'Give the proof a spine for the branch to hang off.')
          : 'Give the branch scenes, and give the proof a spine to return to.';
      const consequence = worst.severity === 1
        ? 'A presenter who jumps into it mid-pitch is stranded there.'
        : 'The presenter can still reach it from the jump index and still gets back, but the deck never says where it belongs.';
      return makeFinding({
        code: 'BRANCH_NO_RETURN',
        severity: worst.severity,
        locus: { branchId },
        key: `noreturn:${branchId}`,
        autoFixAvailable: canFix,
        message: `Branch "${branch ? branch.objection || branchId : branchId}" has no resolved return: ${worst.why}. ${consequence} ${remedy}`,
        detail: {
          branchId,
          returnPolicy: branch ? branch.returnPolicy : null,
          sceneCount: branch ? (branch.scenes || []).length : 0,
          spineLength,
          reasons,
          fixKind: canFix ? worst.fix : null,
        },
      });
    }));
  },
};

/** @type {Rule} */
const beatEmpty = {
  code: 'BEAT_EMPTY',
  severity: severityOf('BEAT_EMPTY'),
  title: 'Beat that reveals nothing',
  inspects: 'every beat of every scene that uses reveals at all, against the element ids the layout actually renders',
  autoFixable: true,
  run(ctx) {
    /** @type {any[]} */
    const out = [];
    const rendered = ctx.renderedElementIds || new Map();
    for (const { scene, branchId } of allScenes(ctx.proof)) {
      // A scene where no beat reveals anything is the still-frame shape the
      // beat engine renders whole (runtime/beats.js `sceneRevealsNothing`).
      // That is a layout choice, not a defect.
      if (sceneRevealsNothing(scene)) continue;
      const known = rendered.get(scene.id);
      (scene.beats || []).forEach((beat, i) => {
        const reveals = beat.reveals || [];
        const total = (scene.beats || []).length;
        if (reveals.length === 0) {
          out.push(makeFinding({
            code: 'BEAT_EMPTY',
            locus: { sceneId: scene.id, branchId: branchId || undefined },
            key: `beat:${scene.id}:${beat.id || i}`,
            autoFixAvailable: total > 1,
            message: `Beat ${i + 1} of ${total} in scene ${scene.id} reveals nothing, while other beats in the same scene do. Pressing forward there changes nothing on screen — a dead keypress in front of the room. Auto-fix removes the beat.`,
            detail: { sceneId: scene.id, beatId: beat.id || null, beatIndex: i, beatCount: total, kind: 'no-reveals' },
          }));
          return;
        }
        // A beat whose reveals all name elements the layout does not render is
        // the same dead keypress, arrived at a different way: the ids drifted,
        // or were hand-written against a layout the scene no longer uses.
        if (!known) return;
        const dangling = reveals.filter((id) => !known.has(id));
        if (dangling.length < reveals.length) return;
        out.push(makeFinding({
          code: 'BEAT_EMPTY',
          locus: { sceneId: scene.id, branchId: branchId || undefined },
          key: `beat-dangling:${scene.id}:${beat.id || i}`,
          autoFixAvailable: total > 1,
          message: `Beat ${i + 1} of ${total} in scene ${scene.id} reveals ${reveals.length} element id${reveals.length === 1 ? '' : 's'} the ${scene.layout} layout does not render (${dangling.slice(0, 3).join(', ')}${dangling.length > 3 ? ', …' : ''}), out of the ${known.size} it does. Pressing forward there changes nothing on screen. Re-point the beat at an element the layout renders, or auto-fix removes it.`,
          detail: {
            sceneId: scene.id, beatId: beat.id || null, beatIndex: i, beatCount: total,
            kind: 'dangling-reveals', dangling, renderedCount: known.size, layout: scene.layout,
          },
        }));
      });
    }
    return sortFindings(out);
  },
};

/** @type {Rule} */
const provenanceUnlabeled = {
  code: 'PROVENANCE_UNLABELED',
  severity: severityOf('PROVENANCE_UNLABELED'),
  title: 'Illustrative content presented as fact',
  inspects: 'every rendition\'s provenance and promotion record, and the rendered document when one is supplied',
  autoFixable: true,
  run(ctx) {
    const { proof } = ctx;
    /** @type {any[]} */
    const out = [];
    const shown = renderedRenditionIds(proof);
    const promoted = ctx.deps.hasPromotionRecord || hasPromotionRecord;

    for (const rendition of proof.renditions || []) {
      if (rendition.provenance !== 'verified-by-user') continue;
      if (promoted(rendition)) continue;
      const scenes = scenesShowing(proof, rendition.id);
      out.push(makeFinding({
        code: 'PROVENANCE_UNLABELED',
        locus: { specimenId: rendition.specimenId, sceneId: scenes[0] },
        key: `unpromoted:${rendition.id}`,
        autoFixAvailable: true,
        message: `Rendition "${rendition.label}" is stamped verified-by-user but carries no promotion record. §9 makes promoteProvenance the only route to that value, and it records who promoted it and when. Without the record the artifact would present ${rendition.producedBy === 'adapter' ? 'adapter-generated' : 'unverified'} copy as client-approved fact${scenes.length ? ` in ${scenes.length === 1 ? 'scene' : 'scenes'} ${scenes.join(', ')}` : ''}. Auto-fix demotes it to illustrative, which is what it is until someone says otherwise.`,
        detail: {
          renditionId: rendition.id, label: rendition.label, producedBy: rendition.producedBy,
          scenes, rendered: shown.has(rendition.id),
        },
      }));
    }

    const options = proof.emitOptions || {};
    if (options.labelIllustrativeContent === false && reviewReachable(options)) {
      const illustrative = (proof.renditions || []).filter((r) => r.provenance === 'illustrative' && shown.has(r.id));
      out.push(makeFinding({
        code: 'PROVENANCE_UNLABELED',
        key: 'label-disabled',
        autoFixAvailable: true,
        message: `This build is reachable in Review mode (mode "${options.mode}") with labelIllustrativeContent disabled, and ${illustrative.length} illustrative rendition${illustrative.length === 1 ? '' : 's'} would render unlabelled. §9 forbids disabling the label for a build a recipient can open. Auto-fix turns it back on.`,
        detail: { mode: options.mode, illustrativeShown: illustrative.length },
      }));
    }

    if (typeof ctx.html === 'string' && ctx.html.length > 0) {
      const emitFindings = ctx.deps.assertProvenance(proof, ctx.html, ctx.css || '', {
        renderScene: ctx.renderScene,
        labelDisableRequested: options.labelIllustrativeContent === false,
        mode: options.mode,
      }) || [];
      for (const finding of emitFindings) {
        // The promotion-record and label-option checks are the two preflight
        // already makes from the model above, with an auto-fix attached. Taking
        // L10's copy as well would report one defect twice.
        const check = finding.locus && finding.locus.check;
        if (check === 'promotion-record' || check === 'label-option') continue;
        out.push(makeFinding({
          code: FINDING_CODES.includes(finding.code) ? finding.code : 'PROVENANCE_UNLABELED',
          locus: finding.locus,
          key: `emit:${finding.id}`,
          autoFixAvailable: false,
          message: finding.message,
          detail: { ...(finding.detail || {}), source: 'rendered-document' },
        }));
      }
    }
    return sortFindings(out);
  },
};

/** @type {Rule} */
const networkReference = {
  code: 'NETWORK_REFERENCE',
  severity: severityOf('NETWORK_REFERENCE'),
  title: 'Network reference',
  inspects: 'raw blocks and media payloads in the model, plus the runtime and the rendered document when supplied',
  autoFixable: false,
  run(ctx) {
    const { proof } = ctx;
    /** @type {any[]} */
    const out = [];

    /**
     * Raw blocks are the one path by which a captured page's own markup reaches
     * the artifact verbatim (§8 keeps a raw copy, presented only on opt-in), so
     * they are the one path by which a tracking pixel could ride along.
     * @param {any} owner @param {'specimen'|'rendition'} kind
     */
    const scanBlocks = (owner, kind) => {
      (owner.blocks || []).forEach((block, i) => {
        if (!block || block.type !== 'raw') return;
        for (const ref of externalRefsIn(block.html)) {
          out.push(makeFinding({
            code: 'NETWORK_REFERENCE',
            locus: { specimenId: kind === 'specimen' ? owner.id : owner.specimenId || undefined },
            key: `raw:${owner.id}:${i}:${ref}`,
            message: `Raw block ${i} of ${kind} "${owner.title || owner.label || owner.id}" carries a network reference: ${ref}. §1.1 makes the artifact inert on the network and §13 blocks emit on any hit — inline the resource as a data: URI or drop the raw block.`,
            detail: { ownerKind: kind, ownerId: owner.id, blockIndex: i, reference: ref },
          }));
        }
      });
    };
    for (const specimen of proof.specimens || []) scanBlocks(specimen, 'specimen');
    for (const rendition of proof.renditions || []) scanBlocks(rendition, 'rendition');

    for (const entry of allMedia(proof)) {
      const uri = typeof entry.media?.dataUri === 'string' ? entry.media.dataUri.trim() : '';
      if (!uri || uri.startsWith('data:')) continue;
      out.push(makeFinding({
        code: 'NETWORK_REFERENCE',
        locus: { specimenId: entry.specimenId || undefined, assetId: entry.media.id },
        key: `media:${entry.media.id}`,
        message: `Media "${entry.media.id}" points at ${uri.slice(0, 80)} instead of carrying a data: URI. §8 inlines every asset at capture time; this one was never inlined and the artifact would fetch it.`,
        detail: { mediaId: entry.media.id, dataUri: uri.slice(0, 120) },
      }));
    }

    for (const logo of (proof.brand && proof.brand.logos) || []) {
      const data = typeof logo.data === 'string' ? logo.data : '';
      if (!data) continue;
      const refs = logo.kind === 'svg' ? externalRefsIn(data) : (data.trim().startsWith('data:') ? [] : [data.slice(0, 80)]);
      for (const ref of refs) {
        out.push(makeFinding({
          code: 'NETWORK_REFERENCE',
          locus: { assetId: logo.id },
          key: `logo:${logo.id}:${ref}`,
          message: `The ${logo.variant} logo carries a network reference: ${ref}. Inline it, or the artifact reaches the network the first time it paints the brand.`,
          detail: { logoId: logo.id, reference: ref },
        }));
      }
    }

    /**
     * L10's scanner reads a *document*, because that is what it guards at emit.
     * A stylesheet and a script reach the artifact as a `<style>` and a
     * `<script>` element, so preflight hands them over in the shape they will
     * take rather than as loose text the scanner has no rule for.
     * @param {string|undefined} text @param {string} source @param {'html'|'css'|'js'} kind
     */
    const scanDocument = (text, source, kind) => {
      if (typeof text !== 'string' || text.length === 0) return;
      const document = kind === 'css' ? `<style>${text}</style>`
        : kind === 'js' ? `<script>${text}</script>`
          : text;
      for (const finding of ctx.deps.scanForNetworkReferences(document) || []) {
        out.push(makeFinding({
          code: FINDING_CODES.includes(finding.code) ? finding.code : 'NETWORK_REFERENCE',
          locus: finding.locus,
          key: `${source}:${finding.id}`,
          message: `${source}: ${finding.message}`,
          detail: { ...(finding.detail || {}), source },
        }));
      }
    };
    scanDocument(ctx.runtimeJs, 'runtime script', 'js');
    scanDocument(ctx.runtimeCss, 'runtime stylesheet', 'css');
    scanDocument(ctx.html, 'rendered document', 'html');
    scanDocument(ctx.css, 'emitted stylesheet', 'css');

    return sortFindings(out);
  },
};

/** @type {Rule} */
const staleCapture = {
  code: 'STALE_CAPTURE',
  severity: severityOf('STALE_CAPTURE'),
  title: 'Stale capture',
  inspects: `every specimen's capturedAt against the injected clock, at ${STALE_CAPTURE_DAYS} days`,
  autoFixable: false,
  run(ctx) {
    if (!ctx.nowIso) return [];
    /** @type {any[]} */
    const out = [];
    for (const specimen of ctx.proof.specimens || []) {
      const age = daysBetween(specimen.capturedAt, ctx.nowIso);
      if (age === null || age <= STALE_CAPTURE_DAYS) continue;
      out.push(makeFinding({
        code: 'STALE_CAPTURE',
        locus: { specimenId: specimen.id },
        key: `stale:${specimen.id}`,
        message: `Specimen "${specimen.title || specimen.id}" was captured ${Math.floor(age)} days ago (${specimen.capturedAt}), past the ${STALE_CAPTURE_DAYS}-day mark in §6. The prospect's own page may have moved on; re-capture it before the meeting if the content matters to the point being made.`,
        detail: { specimenId: specimen.id, capturedAt: specimen.capturedAt, ageDays: Math.floor(age), thresholdDays: STALE_CAPTURE_DAYS, at: ctx.nowIso },
      }));
    }
    return sortFindings(out);
  },
};

/** @type {Rule} */
const specimenEmpty = {
  code: 'SPECIMEN_EMPTY',
  severity: severityOf('SPECIMEN_EMPTY'),
  title: 'Specimen with nothing in it',
  inspects: 'every specimen, for content blocks that carry text or media',
  autoFixable: false,
  run(ctx) {
    const { proof } = ctx;
    /** @type {any[]} */
    const out = [];
    /** @type {Map<string, string[]>} */
    const usedBy = new Map();
    for (const { scene } of allScenes(proof)) {
      if (!scene.specimenId) continue;
      if (!usedBy.has(scene.specimenId)) usedBy.set(scene.specimenId, []);
      usedBy.get(scene.specimenId).push(scene.id);
    }
    for (const specimen of proof.specimens || []) {
      const blocks = specimen.blocks || [];
      const words = countWords(blocks);
      const hasMedia = blocks.some((b) => b && b.type === 'media') || (specimen.media || []).length > 0;
      if (words > 0 || hasMedia) continue;
      const scenes = usedBy.get(specimen.id) || [];
      out.push(makeFinding({
        code: 'SPECIMEN_EMPTY',
        severity: scenes.length > 0 ? 1 : 2,
        locus: { specimenId: specimen.id, sceneId: scenes[0] },
        key: `empty:${specimen.id}`,
        message: scenes.length > 0
          ? `Specimen "${specimen.title || specimen.id}" has no text and no media, and ${scenes.length === 1 ? 'scene' : 'scenes'} ${scenes.join(', ')} ${scenes.length === 1 ? 'builds' : 'build'} on it. The "before" side of the proof — the prospect's own content, which is the entire argument — would be blank.`
          : `Specimen "${specimen.title || specimen.id}" has no text and no media. Nothing shows it, so nothing breaks, but it will not be usable until it is re-captured.`,
        detail: { specimenId: specimen.id, wordCount: words, blockCount: blocks.length, scenes },
      }));
    }
    return sortFindings(out);
  },
};

/**
 * A scene's beat structure, with the scene id divided out.
 *
 * `Beat.reveals` names element ids and `elementId(sceneId, path)` derives them
 * from the scene id, so two scenes that are duplicates in every visible way
 * still hold entirely different reveal ids. Hashing the ids therefore answers
 * "do these scenes share an id?", not "do these scenes show the same thing?" —
 * which is why the content half of `DUPLICATE_SCENE` never fired. This maps each
 * id back to the structural path the layout revealed it at, using the deck-wide
 * table preflight recovers by rendering every scene (`revealPathIndex`), so the
 * shape that comes out describes *which elements* each beat reveals rather than
 * which hashes it happens to hold. The table spans the deck rather than the one
 * scene, so a scene deep-copied from another — keeping the original's ids in its
 * beats — resolves to the same paths as its original, which is what a seller's
 * copy-paste duplicate actually looks like.
 *
 * An id no scene in the deck renders — a stale reveal left behind by an edit, or
 * an id typed by hand — falls back to the ordinal of its first appearance in this
 * scene's own beats. That is still id-free, so two scenes carrying the same
 * structural mistake still fingerprint alike, and it never leaks a scene id into
 * the hash.
 *
 * Beat order is kept: the same reveals in a different order are a different
 * telling. Order *within* a beat is not, because a beat reveals its elements
 * together, so each beat's labels are sorted.
 *
 * @param {import('../core/contracts.d.ts').Scene} scene
 * @param {Map<string, string>} [pathById]  element id → structural path, deck-wide
 * @returns {string[][]} one sorted label list per beat, in beat order
 */
export function beatShape(scene, pathById) {
  /** @type {Map<string, number>} */
  const ordinals = new Map();
  const label = (id) => {
    const path = pathById ? pathById.get(id) : undefined;
    if (typeof path === 'string') return `@${path}`;
    if (!ordinals.has(id)) ordinals.set(id, ordinals.size);
    return `#${ordinals.get(id)}`;
  };
  return (scene.beats || []).map((b) => (b.reveals || []).map(label).sort());
}

/**
 * §4's only duplicate-identity code, and the deck has two id namespaces, not one.
 *
 * Scene ids are the obvious one. Branch ids are the other: `buildDeck` keys its
 * sequences by `Branch.id` and the spine sentinel shares that keyspace, so two
 * branches claiming one id — or a branch claiming `"spine"` — is the same defect
 * one level up, and it was silent until CRITIQUE-2's C5 (L11-D26).
 *
 * @type {Rule}
 */
const duplicateScene = {
  code: 'DUPLICATE_SCENE',
  severity: severityOf('DUPLICATE_SCENE'),
  title: 'Duplicate id in the deck',
  inspects: 'every scene id and every branch id across the spine and every branch, the deck\'s spine sentinel, and every scene\'s visible content — layout, copy, specimen, renditions and the shape of its beats',
  autoFixable: false,
  run(ctx) {
    const { proof } = ctx;
    /** @type {any[]} */
    const out = [];

    // ---- branch ids -------------------------------------------------------
    // A deck indexes its branches by id, so only one branch can be the branch an
    // id names. The other is dropped from the deck entirely — no anchor, no jump
    // entry and no key reaches it — and every navigation that names the id opens
    // the survivor instead. Severity 1, by the same argument that blocks a
    // duplicated scene id, plus the whole authored branch that is lost with it.
    /** @type {Map<string, any[]>} */
    const branchesById = new Map();
    for (const branch of proof.branches || []) {
      if (!branch || typeof branch.id !== 'string') continue;
      if (!branchesById.has(branch.id)) branchesById.set(branch.id, []);
      branchesById.get(branch.id).push(branch);
    }
    // L2 records what its own collision policy cost: `Deck.duplicateBranchIds`
    // is the ids it dropped a sequence for (API.md Part 3b). The rule does not
    // need it — the collision is a fact about `proof.branches` and is derived
    // there, so the finding fires with no deck at all — but when a deck is in
    // hand it turns "this proof declares a duplicate" into "and the deck built
    // for this sweep has already lost one of them", which is a different and
    // stronger sentence. It is read, never depended on.
    const dropped = new Set(Array.isArray(ctx.deck && ctx.deck.duplicateBranchIds)
      ? ctx.deck.duplicateBranchIds
      : []);
    for (const [branchId, group] of [...branchesById].sort((a, b) => a[0].localeCompare(b[0]))) {
      const quoted = group.map((b) => `"${b.objection || b.id}"`);
      const named = quoted.length <= 2
        ? quoted.join(' and ')
        : `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
      const subject = group.length === 1 ? `Branch ${named} carries` : `${group.length} branches (${named}) carry`;
      // Reported as observed rather than predicted, when there is a deck to observe.
      const droppedByDeck = dropped.has(branchId);
      const confirmed = droppedByDeck ? ' The deck built for this sweep has already dropped one of them.' : '';
      if (branchId === SPINE) {
        out.push(makeFinding({
          code: 'DUPLICATE_SCENE',
          locus: { branchId },
          key: `branch-id-spine:${branchId}`,
          message: `${subject} the id "${SPINE}", which is the id the deck gives the spine itself. The deck holds one sequence per id, so the branch replaces the whole spine: the proof's own spine scenes never enter the artifact, and every return to the spine lands inside the branch instead. Give the branch its own id.${confirmed}`,
          detail: {
            branchId, kind: 'spine-collision', droppedByDeck,
            occurrences: group.length, objections: group.map((b) => b.objection || null),
          },
        }));
        continue;
      }
      if (group.length < 2) continue;
      out.push(makeFinding({
        code: 'DUPLICATE_SCENE',
        locus: { branchId },
        key: `branch-id:${branchId}`,
        message: `Branch id ${branchId} is claimed by ${group.length} branches (${named}). The deck holds one sequence per id, so only one of them is the branch this id names. ${group.length === 2 ? 'The other never enters' : 'The others never enter'} the deck at all — no anchor, no jump-index entry, no key — and every navigation that names this id opens the survivor instead. The presenter takes the objection the lost branch was written for, presses the key, and the client sees the other answer. Give each branch its own id.${confirmed}`,
        detail: {
          branchId,
          kind: 'branch-id',
          droppedByDeck,
          occurrences: group.length,
          objections: group.map((b) => b.objection || null),
          sceneCounts: group.map((b) => (b.scenes || []).length),
          sceneIds: group.map((b) => (b.scenes || []).map((sc) => sc && sc.id).filter(Boolean)),
        },
      }));
    }

    // ---- scene ids --------------------------------------------------------
    /** @type {Map<string, string[]>} */
    const places = new Map();
    for (const { scene, branchId } of allScenes(proof)) {
      const where = branchId ? `branch ${branchId}` : 'the spine';
      if (!places.has(scene.id)) places.set(scene.id, []);
      places.get(scene.id).push(where);
    }
    for (const [sceneId, where] of [...places].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (where.length < 2) continue;
      out.push(makeFinding({
        code: 'DUPLICATE_SCENE',
        locus: { sceneId },
        key: `id:${sceneId}`,
        message: `Scene id ${sceneId} appears ${where.length} times (${where.join(', ')}). The navigation locator keeps only the first occurrence, so a jump to this scene lands in one place and the other copies are unreachable. Give each scene its own id.`,
        detail: { sceneId, occurrences: where },
      }));
    }

    // ---- duplicated scene content -----------------------------------------
    const revealPaths = ctx.revealPaths instanceof Map ? ctx.revealPaths : new Map();
    /** @type {Map<string, {sceneId: string, where: string}[]>} */
    const byContent = new Map();
    for (const { scene, branchId } of allScenes(proof)) {
      const fingerprint = contentHash({
        layout: scene.layout,
        headline: scene.headline,
        subhead: scene.subhead,
        specimenId: scene.specimenId,
        renditionIds: scene.renditionIds || [],
        beats: beatShape(scene, revealPaths),
      });
      if (!byContent.has(fingerprint)) byContent.set(fingerprint, []);
      byContent.get(fingerprint).push({ sceneId: scene.id, where: branchId ? `branch ${branchId}` : 'the spine' });
    }
    for (const [fingerprint, group] of [...byContent].sort((a, b) => a[0].localeCompare(b[0]))) {
      const ids = [...new Set(group.map((g) => g.sceneId))].sort();
      if (ids.length < 2) continue;
      out.push(makeFinding({
        code: 'DUPLICATE_SCENE',
        severity: 2,
        locus: { sceneId: ids[0] },
        key: `content:${fingerprint}`,
        message: `Scenes ${ids.join(', ')} are identical in layout, copy and reveals. Presenting the same beat twice reads as losing the thread; keep one, or give the second a different point to make.`,
        detail: { sceneIds: ids, fingerprint, places: group },
      }));
    }
    return sortFindings(out);
  },
};

/** @type {Rule} */
const sizeBudgetExceeded = {
  code: 'SIZE_BUDGET_EXCEEDED',
  severity: severityOf('SIZE_BUDGET_EXCEEDED'),
  title: 'Over the byte budget',
  inspects: 'the estimated emitted size against EmitOptions.maxBytes, split into what the budgeter can degrade and what it cannot',
  autoFixable: true,
  run(ctx) {
    const { proof } = ctx;
    const maxBytes = (proof.emitOptions && proof.emitOptions.maxBytes) || 25_000_000;
    const quality = (proof.emitOptions && proof.emitOptions.imageQuality) || 0.85;
    const canRecompress = QUALITY_STEPS.indexOf(quality) > 0;

    let degradable = 0;
    for (const entry of allMedia(proof)) degradable += mediaBytes(entry.media);

    let logoBytes = 0;
    for (const logo of (proof.brand && proof.brand.logos) || []) logoBytes += utf8Length(String(logo.data || ''));

    const modelJson = JSON.stringify({
      ...proof,
      specimens: (proof.specimens || []).map((s) => ({ ...s, media: (s.media || []).map((m) => ({ ...m, dataUri: '' })) })),
      renditions: (proof.renditions || []).map((r) => ({ ...r, media: (r.media || []).map((m) => ({ ...m, dataUri: '' })) })),
      brand: { ...(proof.brand || {}), logos: [] },
    });
    const modelBytes = utf8Length(modelJson) * MODEL_COMPRESSION_ESTIMATE;
    const runtimeBytes = utf8Length(String(ctx.runtimeJs || '')) + utf8Length(String(ctx.runtimeCss || ''));

    const fixed = modelBytes + logoBytes + runtimeBytes;
    const total = fixed + degradable;
    if (total <= maxBytes) return [];

    const blocking = fixed > maxBytes;
    const overBy = total - maxBytes;
    return [makeFinding({
      code: 'SIZE_BUDGET_EXCEEDED',
      severity: blocking ? 1 : 2,
      key: blocking ? 'floor' : 'total',
      autoFixAvailable: !blocking && canRecompress,
      message: blocking
        ? `The parts of this proof the budgeter cannot degrade — the model, the logos and the runtime — already come to ${(fixed / 1e6).toFixed(2)}MB against a ${(maxBytes / 1e6).toFixed(0)}MB budget. No amount of image downscaling fits it; raise maxBytes or remove content.`
        : `The estimated artifact is ${(total / 1e6).toFixed(2)}MB against a ${(maxBytes / 1e6).toFixed(0)}MB budget, ${(overBy / 1e6).toFixed(2)}MB over. ${(degradable / 1e6).toFixed(2)}MB of that is media the budgeter can degrade, and it will report exactly what it degraded (§13). ${canRecompress ? `Auto-fix drops image quality one step to ${QUALITY_STEPS[QUALITY_STEPS.indexOf(quality) - 1]} so the choice stays yours.` : 'The project is already at the lowest quality step.'}`,
      detail: {
        maxBytes,
        estimatedBytes: Math.round(total),
        fixedBytes: Math.round(fixed),
        degradableBytes: Math.round(degradable),
        modelBytes: Math.round(modelBytes),
        logoBytes,
        runtimeBytes,
        quality,
      },
    })];
  },
};

/**
 * Every rule, in the contract's own code order. A test asserts this list is
 * exactly `FINDING_CODES` — no code unchecked, no rule without a code.
 * @type {Rule[]}
 */
export const RULES = [
  assetMissing,
  assetOversize,
  fontUnavailable,
  textOverflow,
  contrastFail,
  branchUnreachable,
  branchNoReturn,
  beatEmpty,
  provenanceUnlabeled,
  networkReference,
  staleCapture,
  specimenEmpty,
  duplicateScene,
  sizeBudgetExceeded,
];

// Load-time coverage proof: one rule per code, in the contract's order.
{
  const codes = RULES.map((r) => r.code);
  if (codes.length !== FINDING_CODES.length || codes.some((c, i) => c !== FINDING_CODES[i])) {
    throw new Error(`validate/rules: RULES must cover every FindingCode in order; got [${codes.join(', ')}]`);
  }
}

/**
 * The rule that owns a code.
 * @param {string} code
 * @returns {Rule|null}
 */
export function ruleFor(code) {
  return RULES.find((r) => r.code === code) || null;
}
