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

/**
 * The bytes a PNG spends before it has stored a single pixel: signature 8,
 * IHDR 25, IDAT framing 12, IEND 12, zlib header and Adler-32 6.
 *
 * It is small, and at full size it is noise. At the bottom of the ladder it is
 * most of the file — a 30×18 thumbnail is mostly container — which is why a
 * prediction of `bytes × scale²` was out by 1200% on small assets while looking
 * fine on large ones.
 */
export const PNG_CONTAINER_BYTES = 63;

/**
 * Predict the emitted cost of an asset at a new scale.
 *
 * The prediction is anchored to a **measurement of the same image**, not to a
 * formula about images in general: the allocator has already encoded this asset
 * at the previous ladder step, so it predicts the next step from that. That
 * matters because downscaling changes entropy — area-averaging noise makes it
 * compressible — and no closed form knows that about a particular picture.
 *
 * Two corrections on top of the area ratio, both of which the naive model
 * missed entirely:
 *   - the container floor above, subtracted before scaling and added back;
 *   - base64, which is what the artifact actually pays: 4 bytes per 3, plus
 *     the `data:<mime>;base64,` prefix.
 *
 * @param {number} previousEmittedBytes  measured emitted cost at `previousScale`
 * @param {number} previousScale
 * @param {number} nextScale
 * @param {number} prefixBytes           length of `data:<mime>;base64,`
 * @returns {number} predicted emitted bytes at `nextScale`
 */
export function predictEmittedBytes(previousEmittedBytes, previousScale, nextScale, prefixBytes) {
  const previousPayloadBase64 = Math.max(0, previousEmittedBytes - prefixBytes);
  const previousBinary = Math.max(PNG_CONTAINER_BYTES, Math.floor((previousPayloadBase64 * 3) / 4));
  const previousPixels = previousBinary - PNG_CONTAINER_BYTES;
  const ratio = previousScale > 0 ? (nextScale * nextScale) / (previousScale * previousScale) : 1;
  const nextBinary = PNG_CONTAINER_BYTES + previousPixels * ratio;
  return prefixBytes + 4 * Math.ceil(nextBinary / 3);
}

/**
 * The `data:<mime>;base64,` prefix length for a data URI.
 * @param {string} dataUri
 * @returns {number}
 */
export function dataUriPrefixBytes(dataUri) {
  const comma = String(dataUri).indexOf(',');
  return comma < 0 ? 22 : comma + 1;
}

/** Attributes a rendered element can carry an asset in. */
const ASSET_ATTRS = ['src', 'href', 'xlink:href', 'poster', 'data'];

/**
 * @typedef {object} AssetEntry
 * @property {string} assetId          the first id carrying this payload
 * @property {string[]} assetIds       every id carrying it — see `dedupeAssets`
 * @property {'media'|'logo'} kind
 * @property {string} dataUri
 * @property {number} bytes            emitted cost of the data URI, counted once
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
      assetIds: [assetId],
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
 * Collapse assets that carry the same bytes into one budgeting unit.
 *
 * Two things make this necessary, and both are real:
 *
 *   - the same image can be referenced by more than one `MediaRef` (a capture
 *     inlined once per specimen, a logo reused across scenes), and
 *   - `splitMedia` already deduplicates the media table by exact URI, so the
 *     artifact pays for those bytes **once**.
 *
 * Counting them per reference made the budgeter believe the proof was larger
 * than it is, so it degraded further than it needed to, and it wrote one
 * degradation line per reference — a seller reading the report saw the same
 * image downscaled three times. One payload, one budgeting unit, one line.
 *
 * The surviving entry keeps the *earliest* placement of any reference, so an
 * image that appears both on spine scene 1 and deep in a branch is ranked by
 * the spine appearance, which is the one that matters.
 *
 * @param {AssetEntry[]} assets
 * @returns {AssetEntry[]}
 */
export function dedupeAssets(assets) {
  /** @type {Map<string, AssetEntry>} */
  const byPayload = new Map();
  for (const asset of assets) {
    const hit = byPayload.get(asset.dataUri);
    if (!hit) {
      byPayload.set(asset.dataUri, { ...asset, assetIds: [asset.assetId] });
      continue;
    }
    if (!hit.assetIds.includes(asset.assetId)) hit.assetIds.push(asset.assetId);
    if (earlier(asset.placement, hit.placement)) hit.placement = asset.placement;
    if (asset.kind === 'logo') hit.kind = 'logo';
    if (asset.hero) hit.hero = true;
    if (asset.order < hit.order) { hit.order = asset.order; hit.assetId = asset.assetId; }
  }
  return [...byPayload.values()];
}

/**
 * How many times each asset's payload is actually written into a document
 * (C2).
 *
 * The budgeter used to assume "one asset, one copy": `collectAssets` was summed
 * and the sum subtracted from the built size to get the document's fixed cost.
 * That assumption is false in both directions and the artifact paid for it.
 *
 *   - **Too many.** `collectAssets` yields one entry per `MediaRef`, so an
 *     image referenced by a specimen and by the rendition made from it was
 *     counted twice while `splitMedia` carries it once. (`dedupeAssets` fixes
 *     that half, and the emitter now dedupes before it measures.)
 *   - **Too few.** An asset the opening beat paints is written into the
 *     pre-rendered markup *and* into the media table, because the first paint
 *     has to happen before a line of JavaScript runs. That asset costs the file
 *     twice and the budgeter charged it once — a 1.3MB hero photograph on the
 *     opening scene put the reserve out by 1.3MB, which is how a budget the
 *     artifact met untouched came back refused.
 *
 * Neither is fixable by a better assumption, so nothing is assumed: the payload
 * is counted in the document that was actually built. Longest payload first,
 * with the ranges it claims masked out, so a data URI nested inside another one
 * — an `<image>` inside an inline SVG — is charged to the outer asset that
 * really carries it and not to both.
 *
 * An asset that appears **zero** times is not missing: it is inside the base64
 * model payload, because it was too short or too un-base64 for `splitMedia` to
 * hoist into the media table. Its bytes are real but they are compressed and
 * interleaved with everything else in that payload, so they belong to the
 * document reserve, not to any line item the budgeter could promise a saving
 * on. See `assetFootprint`.
 *
 * @param {string} html          the built document
 * @param {AssetEntry[]} assets  deduped by payload — `dedupeAssets(collectAssets(proof))`
 * @returns {Map<string, number>} data URI → times it is written into `html`
 */
export function countAssetCopies(html, assets) {
  const text = String(html || '');
  /** @type {Map<string, number>} */
  const copies = new Map();
  /** Claimed [start, end) ranges, kept sorted by start. */
  /** @type {{from: number, to: number}[]} */
  const claimed = [];

  const unique = [];
  const seen = new Set();
  for (const asset of assets) {
    if (typeof asset.dataUri !== 'string' || !asset.dataUri || seen.has(asset.dataUri)) continue;
    seen.add(asset.dataUri);
    unique.push(asset.dataUri);
  }
  // Longest first, so an outer payload claims its span before an inner one can.
  unique.sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));

  for (const uri of unique) {
    let count = 0;
    let at = 0;
    for (;;) {
      const i = text.indexOf(uri, at);
      if (i < 0) break;
      const end = i + uri.length;
      if (!overlapsClaimed(claimed, i, end)) {
        count += 1;
        insertClaim(claimed, i, end);
        at = end;
      } else {
        at = i + 1;
      }
    }
    copies.set(uri, count);
  }
  return copies;
}

/**
 * @param {{from: number, to: number}[]} claimed
 * @param {number} from
 * @param {number} to
 * @returns {boolean}
 */
function overlapsClaimed(claimed, from, to) {
  for (const range of claimed) {
    if (range.from >= to) break;
    if (range.to > from) return true;
  }
  return false;
}

/**
 * @param {{from: number, to: number}[]} claimed
 * @param {number} from
 * @param {number} to
 */
function insertClaim(claimed, from, to) {
  let i = 0;
  while (i < claimed.length && claimed[i].from < from) i++;
  claimed.splice(i, 0, { from, to });
}

/**
 * @typedef {object} AssetFootprint
 * @property {Map<string, number>} copies       data URI → copies written into the document
 * @property {Map<string, number>} byAssetId    every asset id → copies of its payload
 * @property {number} assetBytes                bytes the document spends on assets, exactly
 * @property {number} reserveBytes              every other byte in the document, exactly
 * @property {number} documentBytes             `utf8Length(html)`
 * @property {AssetEntry[]} inPayload           assets carried inside the model payload
 */

/**
 * What a built document actually spends on assets, and on everything else.
 *
 * The one invariant this exists to make true, asserted in
 * `test/emit/budget.test.mjs` against emitted strings:
 *
 * ```
 * reserveBytes + assetBytes === utf8Length(html)
 * ```
 *
 * `reserveBytes` is therefore a measurement rather than an estimate — it is
 * every byte of the document that is not a literal asset payload, the model
 * payload and the runtime bundle included. That is exactly the number the size
 * budget needs: `maxBytes - reserveBytes` is what is left for pictures.
 *
 * @param {string} html
 * @param {AssetEntry[]} assets  deduped by payload
 * @returns {AssetFootprint}
 */
export function assetFootprint(html, assets) {
  const copies = countAssetCopies(html, assets);
  /** @type {Map<string, number>} */
  const byAssetId = new Map();
  /** @type {AssetEntry[]} */
  const inPayload = [];
  let assetBytes = 0;
  for (const asset of assets) {
    const n = copies.get(asset.dataUri) || 0;
    assetBytes += n * asset.bytes;
    for (const id of asset.assetIds || [asset.assetId]) byAssetId.set(id, n);
    if (n === 0) inPayload.push(asset);
  }
  const documentBytes = utf8Length(String(html || ''));
  return {
    copies,
    byAssetId,
    assetBytes,
    reserveBytes: Math.max(0, documentBytes - assetBytes),
    documentBytes,
    inPayload,
  };
}

/**
 * @param {{sequence: number, sceneIndex: number, beatIndex: number}} a
 * @param {{sequence: number, sceneIndex: number, beatIndex: number}} b
 * @returns {boolean} true when `a` appears before `b`
 */
function earlier(a, b) {
  if (a.sequence !== b.sequence) return a.sequence < b.sequence;
  if (a.sceneIndex !== b.sceneIndex) return a.sceneIndex < b.sceneIndex;
  return a.beatIndex < b.beatIndex;
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
 *
 * Keyed by the original payload rather than by asset id: when the same image is
 * referenced by several `MediaRef`s, degrading it has to update all of them, or
 * the artifact would carry both the degraded copy and the original and the
 * budget maths would be a fiction.
 *
 * @param {import('../core/contracts.d.ts').Proof} proof
 * @param {Map<string, {dataUri: string, width: number, height: number, bytes: number}>} byPayload
 * @returns {import('../core/contracts.d.ts').Proof}
 */
export function applyReplacements(proof, byPayload) {
  if (byPayload.size === 0) return proof;
  const media = (list) => (list || []).map((m) => {
    const hit = byPayload.get(m.dataUri);
    if (!hit) return m;
    // `MediaRef.bytes` is the **inlined** cost — `utf8Length(dataUri)` — not the
    // decoded payload (L6's F19 fix). `degradeAsset` already measures it that
    // way, so `hit.bytes` is the number, and `parseDataUri(...).bytes` would
    // hand a seller a size a third short for the one asset the product has just
    // told them it shrank.
    return { ...m, dataUri: hit.dataUri, intrinsic: { w: hit.width, h: hit.height }, bytes: hit.bytes };
  });
  return {
    ...proof,
    brand: {
      ...proof.brand,
      logos: (proof.brand.logos || []).map((l) => {
        const hit = byPayload.get(l.data);
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
 * @property {number} predictedBytes  what the allocator expected the asset to cost the document afterwards
 * @property {number} actualBytes     what it cost the document after the re-encode
 * @property {string} reason
 * @property {number} copies          times this payload is written into the document (C2)
 * @property {number} beforeBytes     what the **document** spent on this payload: `copies × utf8Length(dataUri)`
 * @property {number} afterBytes      what it spends now
 * @property {number} savedBytes      exactly `beforeBytes - afterBytes`, and exactly the bytes the file lost
 * @property {number} steps
 * @property {string[]} assetIds      every asset id carrying this payload; one
 *                                    line covers all of them, because degrading
 *                                    the payload degrades every reference to it
 */

/**
 * Budget a proof's assets against `maxBytes`.
 *
 * @param {import('../core/contracts.d.ts').Proof} proof
 * @param {number} maxBytes
 * @param {object} [options]
 * @param {number} [options.reserveBytes]  bytes the document costs before assets
 * @param {Map<string, number>} [options.copies]  asset id → how many times its payload is written into
 *   the document, from `assetFootprint`. Absent, every payload is assumed to be written once, which is
 *   what a caller budgeting a proof in isolation can know. `emit()` measures it instead of assuming it.
 * @param {(scene: import('../core/contracts.d.ts').Scene) => any} [options.renderScene]
 * @param {number} [options.quality]
 * @param {(input: any) => any} [options.resample]
 * @returns {{plan: DegradationLine[], proof: import('../core/contracts.d.ts').Proof, assetBytes: number, budget: number, fits: boolean, undegradable: {assetId: string, bytes: number, reason: string}[]}}
 */
export function budgetAssets(proof, maxBytes, options = {}) {
  const quality = options.quality ?? (proof.emitOptions && proof.emitOptions.imageQuality) ?? 0.85;
  const reserve = Math.max(0, Number(options.reserveBytes) || 0);
  const budget = Math.max(0, (Number(maxBytes) || 0) - reserve);

  const everyAsset = dedupeAssets(collectAssets(proof));
  locateAssets(proof, everyAsset, options.renderScene);
  rankAssets(everyAsset);

  // How many times the document writes each payload. Measured by `emit()` from
  // the document it just built; assumed to be once by a caller who has not
  // built one yet (C2).
  const copiesOf = options.copies instanceof Map
    ? (/** @type {AssetEntry} */ a) => {
      const n = options.copies.get(a.assetId);
      return typeof n === 'number' ? n : 1;
    }
    : () => 1;

  /**
   * An asset written into the document zero times is not absent — it is inside
   * the base64 model payload, where `splitMedia` leaves anything too short or
   * too un-base64 to hoist into the media table. Those bytes are real, but they
   * are deflated and interleaved with the rest of the model, so no per-asset
   * saving can be measured for them and none is promised: they are part of the
   * reserve, and the ladder does not touch them. §13 asks for a report of
   * exactly what was degraded and by how much; a line claiming a payload asset
   * saved its full uncompressed length would be off by the compression ratio.
   */
  const assets = everyAsset.filter((a) => copiesOf(a) > 0);
  const payloadResident = everyAsset.filter((a) => copiesOf(a) === 0);

  /** Keyed by the original payload, which is what the artifact pays for once. */
  const originalBytes = new Map(assets.map((a) => [a.dataUri, a.bytes]));
  const originalSize = new Map(assets.map((a) => [a.dataUri, { ...a.intrinsic }]));
  /** Keyed by payload: the whole cost of that payload to the document. */
  const copyCount = new Map(assets.map((a) => [a.dataUri, copiesOf(a)]));
  const costOf = (/** @type {string} */ key, /** @type {number} */ bytes) => (copyCount.get(key) || 1) * bytes;
  let total = assets.reduce((sum, a) => sum + costOf(a.dataUri, a.bytes), 0);

  /** @type {Map<string, {dataUri: string, width: number, height: number, bytes: number}>} */
  const replacements = new Map();
  /** @type {Map<string, {steps: number, how: string, predicted: number}>} */
  const progress = new Map();
  /** @type {{assetId: string, bytes: number, reason: string}[]} */
  const undegradable = [];

  if (total > budget) {
    // Greedy: always spend the least important asset that still has a step.
    // A pass "advances" whenever any asset still had a ladder step to try,
    // even when that step produced nothing — the first step is a lossless
    // re-encode, and an image that was already encoded well gives back no
    // bytes for it. Stopping there would leave the budget unmet with the whole
    // ladder untouched.
    const order = assets.slice().sort((a, b) => b.rank - a.rank);
    // -1, so the first step attempted is ladder index 0: a lossless re-encode.
    /** @type {Map<string, number>} */
    const stepIndex = new Map(assets.map((a) => [a.dataUri, -1]));
    /** The scale and measured cost the last successful step left behind. */
    /** @type {Map<string, {scale: number, bytes: number}>} */
    const lastGood = new Map(assets.map((a) => [a.dataUri, { scale: 1, bytes: a.bytes }]));
    /** @type {Set<string>} */
    const exhausted = new Set();

    let advanced = true;
    while (total > budget && advanced) {
      advanced = false;
      for (const asset of order) {
        if (total <= budget) break;
        const key = asset.dataUri;
        if (exhausted.has(key)) continue;
        const next = /** @type {number} */ (stepIndex.get(key)) + 1;
        if (next >= SCALE_LADDER.length) { exhausted.add(key); continue; }

        stepIndex.set(key, next);
        advanced = true;
        if (next === SCALE_LADDER.length - 1) exhausted.add(key);

        const scale = SCALE_LADDER[next];
        const current = replacements.get(key);
        const currentBytes = current ? current.bytes : asset.bytes;
        const anchor = /** @type {{scale: number, bytes: number}} */ (lastGood.get(key));

        // Predicted before the work, from the last measurement of this same
        // image. `predictEmittedBytes` explains why that beats a formula.
        const predicted = next === 0
          ? Math.round(asset.bytes * 0.97)
          : predictEmittedBytes(anchor.bytes, anchor.scale, scale, dataUriPrefixBytes(asset.dataUri));

        const produced = degradeAsset({ ...asset, bytes: /** @type {number} */ (originalBytes.get(key)) }, scale, { quality, resample: options.resample });
        if (!produced) continue;
        if (produced.bytes >= currentBytes) continue;

        total -= costOf(key, currentBytes - produced.bytes);
        replacements.set(key, produced);
        lastGood.set(key, { scale, bytes: produced.bytes });
        progress.set(key, { steps: next, how: produced.how, predicted });
      }
    }

    // Only an asset that was tried to exhaustion and still could not give
    // anything back is "undegradable", and only when the budget was actually
    // missed — otherwise the list would name assets the allocator simply never
    // needed to touch.
    if (total > budget) {
      for (const asset of assets) {
        if (replacements.has(asset.dataUri)) continue;
        const parsed = parseDataUri(asset.dataUri);
        const mime = parsed ? parsed.mime : 'unknown';
        undegradable.push({
          assetId: asset.assetId,
          bytes: costOf(asset.dataUri, asset.bytes),
          reason: `${mime} cannot be re-encoded any smaller by the in-repo codec; supply a host resampler (deps.resample) or capture it smaller`,
        });
      }
    }
  }

  // Named whenever the budget is missed, whether or not the ladder ran: a
  // seller told "nothing else can be degraded" while a megabyte of inline SVG
  // sits in the payload has been told something untrue.
  if (total > budget || reserve > (Number(maxBytes) || 0)) {
    for (const asset of payloadResident) {
      undegradable.push({
        assetId: asset.assetId,
        bytes: asset.bytes,
        reason: 'carried inside the compressed model payload rather than written into the document, so the budgeter cannot measure — or honestly promise — a saving on it; shrink it before it reaches the emitter',
      });
    }
  }

  /** @type {DegradationLine[]} */
  const plan = [];
  for (const asset of assets) {
    const replacement = replacements.get(asset.dataUri);
    if (!replacement) continue;
    const step = progress.get(asset.dataUri);
    const before = /** @type {number} */ (originalBytes.get(asset.dataUri));
    const fromSize = /** @type {{w: number, h: number}} */ (originalSize.get(asset.dataUri));
    // Every byte figure on the line is what the **document** paid, not what one
    // copy of the payload weighs (C2). A hero the opening beat paints is
    // written into the pre-rendered markup and into the media table both, and a
    // seller reading "saved 1.0MB" about a file that lost 2.0MB has been given
    // a number about nothing.
    const copies = copyCount.get(asset.dataUri) || 1;
    plan.push({
      assetId: asset.assetId,
      assetIds: asset.assetIds.slice(),
      rank: asset.rank,
      from: { w: fromSize.w, h: fromSize.h, quality },
      to: { w: replacement.width, h: replacement.height, quality },
      copies,
      predictedBytes: copies * (step ? step.predicted : before),
      actualBytes: copies * replacement.bytes,
      reason: step ? step.how : 're-encoded',
      beforeBytes: copies * before,
      afterBytes: copies * replacement.bytes,
      savedBytes: copies * (before - replacement.bytes),
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
