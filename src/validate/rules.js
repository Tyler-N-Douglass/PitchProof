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
import { utf8Length, parseDataUri } from '../core/bytes.js';
import { sceneRevealsNothing } from '../runtime/beats.js';
import { makeFinding, sortFindings } from './finding.js';
import { severityOf } from './severity.js';
import { detectOverflow, faceResolutions, resolveBoxFace } from './overflow.js';
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

/** Base64 expansion for media, which D6 keeps outside the compressed payload. */
export const BASE64_EXPANSION = 4 / 3;

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

/** Byte size of a media reference: its declared size, or the size of its data URI. */
function mediaBytes(media) {
  if (Number.isFinite(media.bytes) && media.bytes > 0) return media.bytes;
  const parsed = typeof media.dataUri === 'string' ? parseDataUri(media.dataUri) : null;
  if (parsed && Number.isFinite(parsed.bytes)) return parsed.bytes;
  return typeof media.dataUri === 'string' ? Math.floor(media.dataUri.length * 0.75) : 0;
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
  inspects: 'every media block reference, media data URI, logo payload, and every scene reference to a specimen or rendition',
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
      const ok = logo.kind === 'svg' ? /<svg[\s>]/i.test(data) : Boolean(parseDataUri(data));
      if (ok) continue;
      out.push(makeFinding({
        code: 'ASSET_MISSING',
        locus: { assetId: logo.id },
        key: `logo:${logo.id}`,
        message: `The ${logo.variant} logo carries no usable ${logo.kind === 'svg' ? 'SVG markup' : 'data URI'}. The artifact would present the prospect's brand without their mark.`,
        detail: { logoId: logo.id, variant: logo.variant, kind: logo.kind },
      }));
    }

    for (const { scene, branchId } of allScenes(proof)) {
      const reachable = !deck || deck.sceneLocator.has(scene.id);
      if (scene.specimenId && !specimenById.has(scene.specimenId)) {
        out.push(makeFinding({
          code: 'ASSET_MISSING',
          severity: reachable ? undefined : 2,
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
          severity: reachable ? undefined : 2,
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
      if (overBytes) reasons.push(`${(bytes / 1e6).toFixed(2)}MB is ${((bytes / maxBytes) * 100).toFixed(1)}% of the ${(maxBytes / 1e6).toFixed(0)}MB budget`);
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
      // A fix is only offered when the recommended stack differs from the one
      // the brand already declares. A face that is simply absent, with a
      // fallback stack that is already the best available, has nothing to fix —
      // and offering a no-op fix is how an auto-fix panel loses its meaning.
      const recommended = resolution.stack;
      const declared = face.fallbackStack || [];
      const improvable = recommended.length !== declared.length
        || recommended.some((name, i) => name !== declared[i]);
      const delta = resolution.metricDelta.avgAdvance;
      const drift = `${delta > 1 ? '+' : ''}${((delta - 1) * 100).toFixed(1)}%`;
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

/** @type {Rule} */
const branchUnreachable = {
  code: 'BRANCH_UNREACHABLE',
  severity: severityOf('BRANCH_UNREACHABLE'),
  title: 'Branch with no way in',
  inspects: '§11 coverage: every branch, for an anchoring scene or a jump-index entry',
  autoFixable: true,
  run(ctx) {
    const coverage = ctx.deps.branchCoverage(ctx.deck);
    const byId = new Map((ctx.proof.branches || []).map((b) => [b.id, b]));
    return sortFindings((coverage.unreachable || []).map((branchId) => {
      const branch = byId.get(branchId);
      return makeFinding({
        code: 'BRANCH_UNREACHABLE',
        locus: { branchId },
        key: `unreachable:${branchId}`,
        autoFixAvailable: true,
        message: `Branch "${branch ? branch.objection || branchId : branchId}" has no anchoring scene and no jump-index entry, so no key the presenter can press reaches it. Give it the objection in the client's words (which puts it in the jump index), or anchor it to the scene where that objection lands.`,
        detail: { branchId, objection: branch ? branch.objection : null, sceneCount: branch ? (branch.scenes || []).length : 0 },
      });
    }));
  },
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
    const spineLength = (ctx.proof.spine || []).length;
    return sortFindings((coverage.noReturn || []).map((branchId) => {
      const branch = byId.get(branchId);
      const policy = branch ? branch.returnPolicy : 'anchor';
      const empty = branch ? (branch.scenes || []).length === 0 : false;
      const reason = empty
        ? 'it has no scenes at all, so there is no last scene to return from'
        : policy === 'anchor'
          ? 'its return policy is "anchor" and no scene anchors it, so there is no anchor to return to'
          : 'its return policy is "nextSpineScene" and the spine is empty';
      const remedy = spineLength > 0 && !empty
        ? 'Auto-fix switches it to "nextSpineScene", which always resolves while the spine has scenes.'
        : 'Give the branch scenes and give the proof a spine to return to.';
      return makeFinding({
        code: 'BRANCH_NO_RETURN',
        locus: { branchId },
        key: `noreturn:${branchId}`,
        autoFixAvailable: spineLength > 0 && !empty,
        message: `Branch "${branch ? branch.objection || branchId : branchId}" cannot return to the spine: ${reason}. A presenter who jumps into it mid-pitch is stranded there. ${remedy}`,
        detail: { branchId, returnPolicy: policy, sceneCount: branch ? (branch.scenes || []).length : 0, spineLength },
      });
    }));
  },
};

/** @type {Rule} */
const beatEmpty = {
  code: 'BEAT_EMPTY',
  severity: severityOf('BEAT_EMPTY'),
  title: 'Beat that reveals nothing',
  inspects: 'every beat of every scene that uses reveals at all',
  autoFixable: true,
  run(ctx) {
    /** @type {any[]} */
    const out = [];
    for (const { scene, branchId } of allScenes(ctx.proof)) {
      // A scene where no beat reveals anything is the still-frame shape the
      // beat engine renders whole (runtime/beats.js `sceneRevealsNothing`).
      // That is a layout choice, not a defect.
      if (sceneRevealsNothing(scene)) continue;
      (scene.beats || []).forEach((beat, i) => {
        if ((beat.reveals || []).length > 0) return;
        out.push(makeFinding({
          code: 'BEAT_EMPTY',
          locus: { sceneId: scene.id, branchId: branchId || undefined },
          key: `beat:${scene.id}:${beat.id || i}`,
          autoFixAvailable: true,
          message: `Beat ${i + 1} of ${scene.beats.length} in scene ${scene.id} reveals nothing, while other beats in the same scene do. Pressing forward there changes nothing on screen — a dead keypress in front of the room. Auto-fix removes the beat.`,
          detail: { sceneId: scene.id, beatId: beat.id || null, beatIndex: i, beatCount: scene.beats.length },
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
      for (const finding of ctx.deps.assertProvenance(proof, ctx.html, ctx.css || '') || []) {
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

    /** @param {string|undefined} text @param {string} source */
    const scanDocument = (text, source) => {
      if (typeof text !== 'string' || text.length === 0) return;
      for (const finding of ctx.deps.scanForNetworkReferences(text) || []) {
        out.push(makeFinding({
          code: FINDING_CODES.includes(finding.code) ? finding.code : 'NETWORK_REFERENCE',
          locus: finding.locus,
          key: `${source}:${finding.id}`,
          message: `${source}: ${finding.message}`,
          detail: { ...(finding.detail || {}), source },
        }));
      }
    };
    scanDocument(ctx.runtimeJs, 'runtime script');
    scanDocument(ctx.runtimeCss, 'runtime stylesheet');
    scanDocument(ctx.html, 'rendered document');
    scanDocument(ctx.css, 'emitted stylesheet');

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
        severity: scenes.length > 0 ? undefined : 2,
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

/** @type {Rule} */
const duplicateScene = {
  code: 'DUPLICATE_SCENE',
  severity: severityOf('DUPLICATE_SCENE'),
  title: 'Duplicate scene',
  inspects: 'every scene id across the spine and every branch, and every scene\'s content fingerprint',
  autoFixable: false,
  run(ctx) {
    const { proof } = ctx;
    /** @type {any[]} */
    const out = [];
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

    /** @type {Map<string, {sceneId: string, where: string}[]>} */
    const byContent = new Map();
    for (const { scene, branchId } of allScenes(proof)) {
      const fingerprint = contentHash({
        layout: scene.layout,
        headline: scene.headline,
        subhead: scene.subhead,
        specimenId: scene.specimenId,
        renditionIds: scene.renditionIds || [],
        beats: (scene.beats || []).map((b) => (b.reveals || []).slice().sort()),
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
    for (const entry of allMedia(proof)) degradable += mediaBytes(entry.media) * BASE64_EXPANSION;

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
      severity: blocking ? undefined : 2,
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
