/**
 * Size budgeting (§13, §17.10, §22.5).
 *
 * §22.5: "a 60MB artifact that takes eleven seconds to open is a failed
 * artifact". §13: "greedy allocation against `maxBytes`: compute the byte cost
 * of every asset, rank by presentation importance (spine before branch,
 * revealed-early before revealed-late), and downscale progressively until under
 * budget. **Report exactly what was degraded and by how much — never
 * silently.**"
 *
 * Two properties make that report worth reading, and both are asserted in
 * `test/emit/budget.test.mjs`:
 *
 *   - **Degradation is monotonic in importance rank.** The allocator always
 *     spends the least important asset first, so the number of ladder steps
 *     applied never decreases as rank increases. The logo on the opening beat
 *     is the last thing to lose pixels, not the first.
 *   - **The reported saving is the real saving.** Every line carries both the
 *     prediction the allocator made and the bytes the re-encode actually
 *     produced, and `savedBytes` equals `beforeBytes - afterBytes` exactly —
 *     because the image really was decoded, resampled and re-encoded
 *     (`emit/png.js`), not estimated.
 *
 * Importance is derived, not declared: the emitter renders every scene and
 * looks at which element actually carries each asset, then reads the beat that
 * reveals that element. That is what "revealed-early before revealed-late"
 * means when nobody has hand-labelled anything.
 *
 * An asset the codec cannot re-encode — a JPEG, a WebP, an interlaced PNG —
 * is reported as undegradable rather than quietly left at full size. If the
 * budget cannot be met without it, `emit()` raises `SIZE_BUDGET_EXCEEDED` and
 * refuses. §13 forbids a silent partial emit, and so does this.
 *
 * @module emit/budget
 */

import { utf8Length, parseDataUri, base64Encode, base64Decode, utf8Encode, utf8Decode } from '../core/bytes.js';
import { revealedAt, REVEAL_ATTR } from '../runtime/beats.js';
import { contentId } from '../core/ids.js';
import { rescalePng, isPng, pngSize } from './png.js';

/** Scale steps, applied in order. Step 0 is a lossless re-encode. */
export const SCALE_LADDER = Object.freeze([1, 0.75, 0.5, 0.35, 0.25, 0.15]);

/** Attributes a rendered element can carry an asset in. */
const ASSET_ATTRS = ['src', 'href', 'xlink:href', 'poster', 'data'];

/**
 * @typedef {object} AssetEntry
 * @property {string} assetId
 * @property {'media'|'logo'} kind
 * @property {string} dataUri
 * @property {number} bytes            emitted cost of the data URI
 * @property {{w: number, h: number}} intrinsic
 * @property {number} order            position in the model, the last tiebreak
 * @property {string|null} ownerId
 * @property {boolean} hero            first media of its owner
 * @property {{sequence: number, sceneIndex: number, beatIndex: number}} placement
 * @property {number} rank
 */

/**
 * Collect every inlined asset in a proof.
 * @param {import('../core/contracts.d.ts').Proof} proof
 * @returns {AssetEntry[]}
 */
export function collectAssets(proof) {
  /** @type {AssetEntry[]} */
  const out = [];
  let order = 0;

  /**
   * @param {string} assetId
   * @param {'media'|'logo'} kind
   * @param {string} dataUri
   * @param {{w: number, h: number}} intrinsic
   * @param {string|null} ownerId
   * @param {boolean} hero
   */
  const add = (assetId, kind, dataUri, intrinsic, ownerId, hero) => {
    if (typeof dataUri !== 'string' || !dataUri.startsWith('data:')) return;
    out.push({
      assetId,
      kind,
      dataUri,
      bytes: utf8Length(dataUri),
      intrinsic: { w: Number(intrinsic && intrinsic.w) || 0, h: Number(intrinsic && intrinsic.h) || 0 },
      order: order++,
      ownerId,
      hero,
      placement: { sequence: 2, sceneIndex: 0, beatIndex: 0 },
      rank: 0,
    });
  };

  for (const logo of (proof.brand && proof.brand.logos) || []) {
    add(logo.id, 'logo', logo.data, logo.intrinsic, proof.brand.id, true);
  }
  for (const specimen of proof.specimens || []) {
    (specimen.media || []).forEach((m, i) => add(m.id, 'media', m.dataUri, m.intrinsic, specimen.id, i === 0));
  }
  for (const rendition of proof.renditions || []) {
    (rendition.media || []).forEach((m, i) => add(m.id, 'media', m.dataUri, m.intrinsic, rendition.id, i === 0));
  }
  return out;
}

/**
 * Where in the presentation each asset first appears.
 *
 * @param {import('../core/contracts.d.ts').Proof} proof
 * @param {AssetEntry[]} assets
 * @param {(scene: import('../core/contracts.d.ts').Scene) => any} [renderScene]
 */
export function locateAssets(proof, assets, renderScene) {
  /** @type {Map<string, AssetEntry[]>} */
  const byUri = new Map();
  for (const a of assets) {
    const list = byUri.get(a.dataUri) || [];
    list.push(a);
    byUri.set(a.dataUri, list);
  }
  if (!renderScene) return;

  /** @type {{scene: import('../core/contracts.d.ts').Scene, sequence: number, sceneIndex: number}[]} */
  const scenes = [];
  (proof.spine || []).forEach((scene, i) => scenes.push({ scene, sequence: 0, sceneIndex: i }));
  (proof.branches || []).forEach((branch) => {
    (branch.scenes || []).forEach((scene, i) => scenes.push({ scene, sequence: 1, sceneIndex: i }));
  });

  for (const { scene, sequence, sceneIndex } of scenes) {
    let tree;
    try { tree = renderScene(scene); } catch { continue; }
    const beatOf = beatIndexResolver(scene);

    /**
     * @param {any} node
     * @param {string|null} revealId
     */
    const walkNode = (node, revealId) => {
      if (node === null || node === undefined || node === false) return;
      if (Array.isArray(node)) { for (const c of node) walkNode(c, revealId); return; }
      if (typeof node !== 'object' || 'raw' in node || !node.t) return;
      const attrs = node.a || {};
      const own = typeof attrs[REVEAL_ATTR] === 'string' ? attrs[REVEAL_ATTR] : revealId;
      for (const name of ASSET_ATTRS) {
        const value = attrs[name];
        if (typeof value !== 'string') continue;
        const hits = byUri.get(value);
        if (!hits) continue;
        const beatIndex = own ? beatOf(own) : 0;
        for (const asset of hits) {
          const p = asset.placement;
          if (sequence < p.sequence
            || (sequence === p.sequence && sceneIndex < p.sceneIndex)
            || (sequence === p.sequence && sceneIndex === p.sceneIndex && beatIndex < p.beatIndex)) {
            asset.placement = { sequence, sceneIndex, beatIndex };
          }
        }
      }
      for (const c of node.c || []) walkNode(c, own);
    };
    walkNode(tree, null);
  }
}

/**
 * The beat index at which an element id first becomes visible.
 * @param {import('../core/contracts.d.ts').Scene} scene
 * @returns {(elementId: string) => number}
 */
export function beatIndexResolver(scene) {
  const beats = scene.beats || [];
  /** @type {Map<string, number>} */
  const first = new Map();
  for (let i = 0; i < beats.length; i++) {
    for (const id of revealedAt(scene, i)) if (!first.has(id)) first.set(id, i);
  }
  return (elementId) => (first.has(elementId) ? /** @type {number} */ (first.get(elementId)) : 0);
}

/**
 * Rank assets by presentation importance: 0 is the most important.
 *
 * Order of the keys, and why:
 *   1. sequence — the spine is the pitch; a branch is a detour (§13).
 *   2. scene index — earlier in the sequence is seen by more of the room.
 *   3. beat index — §13's "revealed-early before revealed-late", read off the
 *      beat that actually reveals the element carrying the asset.
 *   4. kind — the logo and the hero of a scene carry the brand; an incidental
 *      image does not.
 *   5. model order — a stable tiebreak, so the ranking is deterministic (§5).
 *
 * @param {AssetEntry[]} assets
 * @returns {AssetEntry[]} the same objects, sorted and with `rank` assigned
 */
export function rankAssets(assets) {
  const kindWeight = (a) => (a.kind === 'logo' ? 0 : a.hero ? 1 : 2);
  const sorted = assets.slice().sort((a, b) => (
    a.placement.sequence - b.placement.sequence
    || a.placement.sceneIndex - b.placement.sceneIndex
    || a.placement.beatIndex - b.placement.beatIndex
    || kindWeight(a) - kindWeight(b)
    || a.order - b.order
  ));
  sorted.forEach((a, i) => { a.rank = i; });
  return sorted;
}

/**
 * Re-encode one asset at a scale step.
 *
 * @param {AssetEntry} asset
 * @param {number} scale
 * @param {object} [options]
 * @param {(input: {bytes: Uint8Array, mime: string, width: number, height: number, scale: number, quality: number}) => {bytes: Uint8Array, width: number, height: number}|null} [options.resample]
 * @param {number} [options.quality]
 * @returns {{dataUri: string, width: number, height: number, bytes: number, how: string}|null}
 */
export function degradeAsset(asset, scale, options = {}) {
  const parsed = parseDataUri(asset.dataUri);
  if (!parsed) return null;
  const mime = parsed.mime.toLowerCase();

  if (mime === 'image/svg+xml' || mime.startsWith('text/')) {
    if (scale !== 1) return null;                 // vector art does not downscale
    const body = parsed.base64 ? utf8Decode(base64Decode(parsed.body)) : decodeURIComponent(parsed.body);
    const minified = minifySvg(body);
    if (minified.length >= body.length) return null;
    const encoded = parsed.base64
      ? `data:${parsed.mime};base64,${base64Encode(utf8Encode(minified))}`
      : `data:${parsed.mime},${encodeURIComponent(minified)}`;
    if (utf8Length(encoded) >= asset.bytes) return null;
    return { dataUri: encoded, width: asset.intrinsic.w, height: asset.intrinsic.h, bytes: utf8Length(encoded), how: 'minified markup' };
  }

  if (!parsed.base64) return null;
  const raw = base64Decode(parsed.body);

  if (isPng(raw)) {
    const rescaled = rescalePng(raw, scale);
    if (!rescaled) return null;
    const uri = `data:${parsed.mime};base64,${base64Encode(rescaled.bytes)}`;
    const bytes = utf8Length(uri);
    if (bytes >= asset.bytes) return null;
    return {
      dataUri: uri,
      width: rescaled.width,
      height: rescaled.height,
      bytes,
      how: scale === 1 ? 're-encoded losslessly' : `resampled to ${Math.round(scale * 100)}%`,
    };
  }

  if (typeof options.resample === 'function') {
    const size = { width: asset.intrinsic.w, height: asset.intrinsic.h };
    const produced = options.resample({
      bytes: raw,
      mime: parsed.mime,
      width: size.width,
      height: size.height,
      scale,
      quality: options.quality ?? 0.85,
    });
    if (!produced || !produced.bytes || !produced.bytes.length) return null;
    const uri = `data:${parsed.mime};base64,${base64Encode(produced.bytes)}`;
    const bytes = utf8Length(uri);
    if (bytes >= asset.bytes) return null;
    return { dataUri: uri, width: produced.width, height: produced.height, bytes, how: `resampled to ${Math.round(scale * 100)}% by the host resampler` };
  }

  return null;
}

/**
 * Whitespace and comments an SVG does not need. Text-bearing elements are left
 * exactly as written, because whitespace inside them is content.
 * @param {string} svg
 * @returns {string}
 */
export function minifySvg(svg) {
  const TEXTY = /<(text|tspan|textPath|title|desc|style)\b/i;
  const parts = String(svg).split(/(<[^>]*>)/);
  let insideText = 0;
  /** @type {string[]} */
  const out = [];
  for (const part of parts) {
    if (!part) continue;
    if (part[0] === '<') {
      if (part.startsWith('<!--')) continue;
      if (TEXTY.test(part) && !part.startsWith('</')) insideText++;
      else if (/^<\/(text|tspan|textPath|title|desc|style)\b/i.test(part)) insideText = Math.max(0, insideText - 1);
      out.push(part.replace(/\s+/g, ' ').replace(/\s*\/>$/, '/>'));
      continue;
    }
    out.push(insideText > 0 ? part : part.replace(/\s+/g, part.trim() ? ' ' : ''));
  }
  return out.join('').trim();
}

/**
 * Apply degraded assets back into the proof, without mutating the input.
 * @param {import('../core/contracts.d.ts').Proof} proof
 * @param {Map<string, {dataUri: string, width: number, height: number, bytes: number}>} replacements
 * @returns {import('../core/contracts.d.ts').Proof}
 */
export function applyReplacements(proof, replacements) {
  if (replacements.size === 0) return proof;
  const media = (list) => (list || []).map((m) => {
    const hit = replacements.get(m.id);
    if (!hit) return m;
    const decoded = parseDataUri(hit.dataUri);
    return { ...m, dataUri: hit.dataUri, intrinsic: { w: hit.width, h: hit.height }, bytes: decoded ? decoded.bytes : m.bytes };
  });
  return {
    ...proof,
    brand: {
      ...proof.brand,
      logos: (proof.brand.logos || []).map((l) => {
        const hit = replacements.get(l.id);
        return hit ? { ...l, data: hit.dataUri, intrinsic: { w: hit.width, h: hit.height } } : l;
      }),
    },
    specimens: (proof.specimens || []).map((s) => ({ ...s, media: media(s.media) })),
    renditions: (proof.renditions || []).map((r) => ({ ...r, media: media(r.media) })),
  };
}

/**
 * @typedef {object} DegradationLine
 * @property {string} assetId
 * @property {number} rank
 * @property {{w: number, h: number, quality: number}} from
 * @property {{w: number, h: number, quality: number}} to
 * @property {number} predictedBytes  what the allocator expected the asset to cost afterwards
 * @property {number} actualBytes     what it cost after the re-encode
 * @property {string} reason
 * @property {number} beforeBytes
 * @property {number} afterBytes
 * @property {number} savedBytes      exactly `beforeBytes - afterBytes`
 * @property {number} steps
 */

/**
 * Budget a proof's assets against `maxBytes`.
 *
 * @param {import('../core/contracts.d.ts').Proof} proof
 * @param {number} maxBytes
 * @param {object} [options]
 * @param {number} [options.reserveBytes]  bytes the document costs before assets
 * @param {(scene: import('../core/contracts.d.ts').Scene) => any} [options.renderScene]
 * @param {number} [options.quality]
 * @param {(input: any) => any} [options.resample]
 * @returns {{plan: DegradationLine[], proof: import('../core/contracts.d.ts').Proof, assetBytes: number, budget: number, fits: boolean, undegradable: {assetId: string, bytes: number, reason: string}[]}}
 */
export function budgetAssets(proof, maxBytes, options = {}) {
  const quality = options.quality ?? (proof.emitOptions && proof.emitOptions.imageQuality) ?? 0.85;
  const reserve = Math.max(0, Number(options.reserveBytes) || 0);
  const budget = Math.max(0, (Number(maxBytes) || 0) - reserve);

  const assets = collectAssets(proof);
  locateAssets(proof, assets, options.renderScene);
  rankAssets(assets);

  const originalBytes = new Map(assets.map((a) => [a.assetId, a.bytes]));
  const originalSize = new Map(assets.map((a) => [a.assetId, { ...a.intrinsic }]));
  let total = assets.reduce((sum, a) => sum + a.bytes, 0);

  /** @type {Map<string, {dataUri: string, width: number, height: number, bytes: number}>} */
  const replacements = new Map();
  /** @type {Map<string, {steps: number, how: string, predicted: number}>} */
  const progress = new Map();
  /** @type {{assetId: string, bytes: number, reason: string}[]} */
  const undegradable = [];

  if (total > budget) {
    // Greedy: always spend the least important asset that still has a step.
    const order = assets.slice().sort((a, b) => b.rank - a.rank);
    // -1, so the first step attempted is ladder index 0: a lossless re-encode.
    // A PNG written by another encoder often gives back real bytes for nothing,
    // and spending pixels before trying that would be gratuitous.
    /** @type {Map<string, number>} */
    const stepIndex = new Map(assets.map((a) => [a.assetId, -1]));
    /** @type {Set<string>} */
    const exhausted = new Set();

    let progressed = true;
    while (total > budget && progressed) {
      progressed = false;
      for (const asset of order) {
        if (total <= budget) break;
        if (exhausted.has(asset.assetId)) continue;
        const next = /** @type {number} */ (stepIndex.get(asset.assetId)) + 1;
        if (next >= SCALE_LADDER.length) { exhausted.add(asset.assetId); continue; }

        const scale = SCALE_LADDER[next];
        const current = replacements.get(asset.assetId);
        const currentBytes = current ? current.bytes : asset.bytes;
        // The prediction: emitted bytes scale with pixel count, and step 0 is a
        // lossless re-encode whose gain we do not pretend to know in advance.
        const baseBytes = /** @type {number} */ (originalBytes.get(asset.assetId));
        const predicted = next === 0 ? Math.round(baseBytes * 0.97) : Math.round(baseBytes * scale * scale);

        const produced = degradeAsset({ ...asset, dataUri: asset.dataUri, bytes: baseBytes }, scale, { quality, resample: options.resample });
        stepIndex.set(asset.assetId, next);
        if (!produced) {
          if (next === SCALE_LADDER.length - 1) exhausted.add(asset.assetId);
          continue;
        }
        if (produced.bytes >= currentBytes) continue;

        total -= currentBytes - produced.bytes;
        replacements.set(asset.assetId, produced);
        progress.set(asset.assetId, { steps: next, how: produced.how, predicted });
        progressed = true;
      }
    }

    for (const asset of assets) {
      if (!replacements.has(asset.assetId)) {
        const parsed = parseDataUri(asset.dataUri);
        const mime = parsed ? parsed.mime : 'unknown';
        undegradable.push({
          assetId: asset.assetId,
          bytes: asset.bytes,
          reason: `${mime} cannot be re-encoded by the in-repo codec; supply a host resampler (deps.resample) or capture it smaller`,
        });
      }
    }
  }

  /** @type {DegradationLine[]} */
  const plan = [];
  for (const asset of assets) {
    const replacement = replacements.get(asset.assetId);
    if (!replacement) continue;
    const step = progress.get(asset.assetId);
    const before = /** @type {number} */ (originalBytes.get(asset.assetId));
    const fromSize = /** @type {{w: number, h: number}} */ (originalSize.get(asset.assetId));
    plan.push({
      assetId: asset.assetId,
      rank: asset.rank,
      from: { w: fromSize.w, h: fromSize.h, quality },
      to: { w: replacement.width, h: replacement.height, quality },
      predictedBytes: step ? step.predicted : before,
      actualBytes: replacement.bytes,
      reason: step ? step.how : 're-encoded',
      beforeBytes: before,
      afterBytes: replacement.bytes,
      savedBytes: before - replacement.bytes,
      steps: step ? step.steps : 0,
    });
  }
  plan.sort((a, b) => a.rank - b.rank);

  return {
    plan,
    proof: applyReplacements(proof, replacements),
    assetBytes: total,
    budget,
    fits: total <= budget,
    undegradable,
  };
}

/**
 * A `SIZE_BUDGET_EXCEEDED` finding.
 *
 * Severity 1. §22.5 calls an over-budget artifact "a failed artifact", and §13
 * forbids a silent partial emit; a warning the caller could walk past would be
 * exactly that.
 *
 * @param {string} message
 * @param {Record<string, unknown>} locus
 * @returns {import('../core/contracts.d.ts').Finding}
 */
export function sizeBudgetFinding(message, locus) {
  return {
    id: contentId('finding', { code: 'SIZE_BUDGET_EXCEEDED', message, locus }),
    severity: 1,
    code: 'SIZE_BUDGET_EXCEEDED',
    message,
    locus,
    autoFixAvailable: false,
  };
}
