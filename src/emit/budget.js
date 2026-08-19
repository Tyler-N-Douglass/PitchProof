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

/**
 * The smallest linear scale the allocator will take any asset to.
 *
 * Below about 15% a photograph is no longer the picture the seller chose; it is
 * a swatch. If the budget cannot be met with every asset at this floor, the
 * budget cannot be met, and the emitter says so rather than going further.
 */
export const SCALE_FLOOR = 0.15;

/**
 * Every scale the allocator applies is rounded to this grid.
 *
 * The search is a bisection over a real-valued quality dial, and a real-valued
 * dial is not a deterministic input to an image encoder: two runs that differ
 * in the last bit of a double would produce different files. Quantizing the
 * *scale* — the only thing the encoder ever sees — makes §5's byte-identical
 * re-emit true of a search that is otherwise continuous.
 */
export const SCALE_QUANTUM = 1 / 1024;

/**
 * How much faster the least important asset loses size than the most important.
 *
 * The dial sets one number, `q`, and every asset's scale is `q` raised to a
 * power that grows with its importance rank: `q` for rank 0, `q³` for the last
 * rank. At `q = 0.9` that is 0.90 for the logo on the opening beat and 0.73 for
 * the last image of the last branch — the ordering §13 asks for, applied as a
 * gradient rather than as a queue.
 */
export const IMPORTANCE_SPREAD = 2;

/**
 * Measured re-encode passes the search may spend after the lossless pass.
 *
 * Each one decodes, resamples and re-encodes every asset, so this is the cost
 * ceiling. Five is enough to land within a percent of the budget on every proof
 * in the corpus, because the bisection runs on *predictions* — which are free —
 * and only the candidates it settles on are measured.
 */
export const MEASURED_PROBES = 5;

/**
 * Round a scale onto the quantum grid, clamped to `[SCALE_FLOOR, 1]`.
 * @param {number} scale
 * @returns {number}
 */
export function quantizeScale(scale) {
  if (!Number.isFinite(scale) || scale >= 1) return 1;
  if (scale <= SCALE_FLOOR) return SCALE_FLOOR;
  const stepped = Math.round(scale / SCALE_QUANTUM) * SCALE_QUANTUM;
  return Math.min(1, Math.max(SCALE_FLOOR, stepped));
}

/**
 * The scale one asset takes at a given setting of the quality dial (P7).
 *
 * `q` is a single number for the whole proof: 1 leaves every asset at full
 * size, 0 puts every asset on the floor, and everything between downscales
 * *everything* — progressively, and the least important fastest. That is the
 * sentence §13 actually contains ("downscale progressively until under
 * budget") read as one dial over the whole set rather than as a queue in which
 * the least important asset is destroyed before the most important is touched.
 *
 * Monotone in both arguments by construction: raising `q` never shrinks an
 * asset further, and a higher rank never keeps more pixels than a lower one.
 * That is the §17.10 invariant, and it is now a property of the formula instead
 * of a property of the loop's visiting order.
 *
 * @param {number} q       quality dial in [0, 1]
 * @param {number} rank    importance rank, 0 = most important
 * @param {number} count   how many assets are being budgeted
 * @returns {number} quantized linear scale
 */
export function scaleForQuality(q, rank, count) {
  if (!(q > 0)) return SCALE_FLOOR;
  if (q >= 1) return 1;
  const spread = count > 1 ? (Math.max(0, rank) / (count - 1)) * IMPORTANCE_SPREAD : 0;
  return quantizeScale(Math.pow(q, 1 + spread));
}

/**
 * How far down an asset was taken, in hundredths of its linear size.
 *
 * `0` means, exactly and only, that the asset kept every pixel it arrived with
 * — a lossless re-encode or an SVG minification. Any resampling reports at
 * least 1. It is a strictly monotone function of the scale, so "steps never
 * decrease as importance rank increases" and "scale never increases as
 * importance rank increases" are the same statement.
 *
 * @param {number} scale
 * @returns {number}
 */
export function scaleSteps(scale) {
  return Math.max(0, Math.ceil((1 - Math.min(1, scale)) * 100));
}

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
 * @property {number} scale           the linear scale actually applied; 1 means no pixel was given up
 * @property {number} steps           `scaleSteps(scale)` — hundredths of linear size given up, 0 iff lossless
 * @property {string[]} assetIds      every asset id carrying this payload; one
 *                                    line covers all of them, because degrading
 *                                    the payload degrades every reference to it
 */

/**
 * @typedef {object} BudgetResult
 * @property {DegradationLine[]} plan
 * @property {import('../core/contracts.d.ts').Proof} proof
 * @property {number} assetBytes
 * @property {number} budget
 * @property {boolean} fits
 * @property {{assetId: string, bytes: number, reason: string}[]} undegradable
 * @property {boolean} unreachable    the budget cannot be met by degrading assets at all (P4)
 * @property {string|null} reason     why, in a sentence, when `unreachable`
 * @property {number} quality         the dial the search settled on: 1 is untouched, 0 is the floor
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
 * @returns {BudgetResult}
 */
export function budgetAssets(proof, maxBytes, options = {}) {
  const quality = options.quality ?? (proof.emitOptions && proof.emitOptions.imageQuality) ?? 0.85;
  const reserve = Math.max(0, Number(options.reserveBytes) || 0);
  const ceiling = Math.max(0, Number(maxBytes) || 0);
  const budget = Math.max(0, ceiling - reserve);

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
  const startTotal = assets.reduce((sum, a) => sum + costOf(a.dataUri, a.bytes), 0);

  /** Bytes carried inside the compressed payload, named whenever the budget is missed. */
  const payloadLines = () => payloadResident.map((asset) => ({
    assetId: asset.assetId,
    bytes: asset.bytes,
    reason: 'carried inside the compressed model payload rather than written into the document, so the budgeter cannot measure — or honestly promise — a saving on it; shrink it before it reaches the emitter',
  }));

  /**
   * @param {DegradationLine[]} plan
   * @param {Map<string, {dataUri: string, width: number, height: number, bytes: number}>} replacements
   * @param {number} total
   * @param {number} dial
   * @returns {BudgetResult}
   */
  const settled = (plan, replacements, total, dial) => ({
    plan,
    proof: applyReplacements(proof, replacements),
    assetBytes: total,
    budget,
    fits: total <= budget,
    undegradable: total <= budget ? [] : payloadLines(),
    unreachable: false,
    reason: null,
    quality: dial,
  });

  /**
   * The budget cannot be met by touching assets, so no asset is touched (P4).
   *
   * Degrading the prospect's photographs to reach a number the file was never
   * going to reach costs them real quality and buys nothing: the emit is
   * refused either way. What the seller needs is the reason, and the reason is
   * never the picture — it is whatever the ladder cannot resample.
   *
   * @param {string} reason
   * @param {{assetId: string, bytes: number, reason: string}[]} blocked
   * @returns {BudgetResult}
   */
  const unreachable = (reason, blocked = []) => ({
    plan: [],
    proof,
    assetBytes: startTotal,
    budget,
    fits: false,
    undegradable: [...blocked, ...payloadLines()],
    unreachable: true,
    reason,
    quality: 1,
  });

  // Named whenever the document is over its ceiling, whether or not the ladder
  // ran: a seller told "nothing else can be degraded" while a megabyte of
  // inline SVG sits in the payload has been told something untrue.
  if (startTotal <= budget) {
    return {
      plan: [],
      proof,
      assetBytes: startTotal,
      budget,
      fits: true,
      undegradable: reserve > ceiling ? payloadLines() : [],
      unreachable: false,
      reason: null,
      quality: 1,
    };
  }

  if (budget <= 0) {
    return unreachable(
      `the document costs ${reserve} bytes before a single image, which is already ${reserve - ceiling} bytes over the ${ceiling}-byte budget, `
      + 'so no amount of image degradation could meet it',
    );
  }

  // ---- the search ---------------------------------------------------------
  //
  // One dial, `q`, sets every asset's scale at once (`scaleForQuality`). The
  // bisection runs on **predictions**, which cost nothing, and only the
  // candidates it settles on are measured by a real decode-resample-encode. So
  // the allocator gets the precision of a fine ladder at the cost of a coarse
  // one, and the file lands just under the budget instead of far under it (P7).

  const count = assets.length;
  const prefixOf = new Map(assets.map((a) => [a.dataUri, dataUriPrefixBytes(a.dataUri)]));
  /** Every re-encode this call has performed, keyed by asset and scale. */
  /** @type {Map<string, {produced: {dataUri: string, width: number, height: number, bytes: number, how: string}, predicted: number, scale: number}|null>} */
  const attempts = new Map();
  /**
   * Every measurement of every payload, ascending by scale.
   *
   * This is the curve the search reads. `predictEmittedBytes` models a picture
   * as area — bytes fall with `scale²` — and that is the right model with one
   * measurement to hand, but it is wrong in a knowable direction: downscaling
   * also destroys detail, so a real photograph gives back *less* than the area
   * ratio promises (the corpus hero: 1,181,306 bytes at full size, 61,122 at
   * 15%, where area predicts 26,500). Two measurements of the same image fix
   * that without a model of images in general — the exponent between them is
   * this picture's own.
   * @type {Map<string, {scale: number, bytes: number}[]>}
   */
  const curve = new Map(assets.map((a) => [a.dataUri, [{ scale: 1, bytes: a.bytes }]]));
  /** Payloads the codec will not resample at all: vector art, and formats with no host resampler. */
  /** @type {Set<string>} */
  const noResample = new Set();

  const keyOf = (/** @type {AssetEntry} */ a, /** @type {number} */ scale) => `${a.assetId}@${scale.toFixed(6)}`;

  /**
   * What the allocator expects this asset to cost at `scale`, before doing the
   * work — read off this image's own measured curve wherever there is one, and
   * from the area model when there is not (E26).
   * @param {AssetEntry} a
   * @param {number} scale
   */
  const predictFor = (a, scale) => {
    const original = /** @type {number} */ (originalBytes.get(a.dataUri));
    if (scale >= 1) return Math.round(original * 0.97);
    const points = /** @type {{scale: number, bytes: number}[]} */ (curve.get(a.dataUri));
    if (noResample.has(a.dataUri)) {
      const lossless = attempts.get(keyOf(a, 1));
      return lossless ? lossless.produced.bytes : original;
    }
    const exact = points.find((p) => p.scale === scale);
    if (exact) return exact.bytes;
    if (points.length >= 2) {
      const [p, r] = nearestPair(points, scale);
      const interpolated = logInterpolate(p, r, scale);
      if (Number.isFinite(interpolated) && interpolated > 0) return Math.min(original, Math.round(interpolated));
    }
    const anchor = nearest(points, scale);
    return Math.min(original, predictEmittedBytes(anchor.bytes, anchor.scale, scale, /** @type {number} */ (prefixOf.get(a.dataUri))));
  };

  /**
   * Re-encode one asset at one scale, once. Memoized: the search revisits
   * scales, and a decode-resample-encode is the expensive thing here.
   * @param {AssetEntry} a
   * @param {number} scale
   */
  const attempt = (a, scale) => {
    const key = keyOf(a, scale);
    const hit = attempts.get(key);
    if (hit !== undefined) return hit;
    const original = /** @type {number} */ (originalBytes.get(a.dataUri));
    const predicted = predictFor(a, scale);
    const produced = degradeAsset({ ...a, bytes: original }, scale, { quality, resample: options.resample });
    const entry = produced && produced.bytes < original ? { produced, predicted, scale } : null;
    attempts.set(key, entry);
    if (entry) {
      const points = /** @type {{scale: number, bytes: number}[]} */ (curve.get(a.dataUri));
      if (!points.some((p) => p.scale === scale)) {
        points.push({ scale, bytes: produced.bytes });
        points.sort((x, y) => x.scale - y.scale);
      }
    } else if (scale < 1) {
      noResample.add(a.dataUri);
    }
    return entry;
  };

  /**
   * The result actually applied to an asset at dial position `q`.
   *
   * Vector art does not downscale, and a picture already at its container floor
   * gives nothing back — but both can still be re-encoded losslessly, and those
   * bytes are free. So a scale the codec refuses falls back to the lossless
   * pass rather than surrendering the saving it already made.
   * @param {AssetEntry} a
   * @param {number} scale
   */
  const resolve = (a, scale) => attempt(a, scale) || (scale < 1 ? attempt(a, 1) : null);

  /**
   * What the assets would cost at `q`, from measurements where they exist and
   * predictions where they do not. Free — this is what the bisection runs on.
   * @param {number} q
   */
  const predictTotal = (q) => {
    let sum = 0;
    for (const a of assets) {
      const scale = scaleForQuality(q, a.rank, count);
      const original = /** @type {number} */ (originalBytes.get(a.dataUri));
      const known = attempts.get(keyOf(a, scale));
      let bytes;
      if (known) bytes = known.produced.bytes;
      else if (known === null) {
        const lossless = scale < 1 ? attempts.get(keyOf(a, 1)) : null;
        bytes = lossless ? lossless.produced.bytes : original;
      } else bytes = Math.min(original, predictFor(a, scale));
      sum += costOf(a.dataUri, bytes);
    }
    return sum;
  };

  /**
   * What the assets really cost at `q`, by doing the work.
   * @param {number} q
   */
  const measure = (q) => {
    /** @type {Map<string, {produced: any, predicted: number, scale: number}|null>} */
    const chosen = new Map();
    let total = 0;
    for (const a of assets) {
      const entry = resolve(a, scaleForQuality(q, a.rank, count));
      chosen.set(a.dataUri, entry);
      total += costOf(a.dataUri, entry ? entry.produced.bytes : /** @type {number} */ (originalBytes.get(a.dataUri)));
    }
    return { q, total, chosen };
  };

  /**
   * The largest dial position whose *predicted* total fits, by bisection.
   * @param {number} lo
   * @param {number} hi
   */
  const solve = (lo, hi) => {
    let a = lo;
    let b = hi;
    for (let i = 0; i < 40; i++) {
      const mid = (a + b) / 2;
      if (predictTotal(mid) <= budget) a = mid; else b = mid;
    }
    return a;
  };

  // The lossless pass. Nothing here costs a pixel, so it happens whatever the
  // budget is, and it is the anchor every later prediction is measured from.
  const lossless = measure(1);
  if (lossless.total <= budget) return settled(...planFrom(lossless), 1);

  let lo = 0;
  let hi = 1;
  /** @type {{q: number, total: number, chosen: Map<string, any>}|null} */
  let fitting = null;

  // If even the floor is predicted not to fit, check the floor once and stop:
  // there is nothing between here and there worth the client's pixels.
  if (predictTotal(0) > budget) {
    const floor = measure(0);
    if (floor.total > budget) {
      /** @type {{assetId: string, bytes: number, reason: string}[]} */
      const blocked = [];
      for (const a of assets) {
        if (floor.chosen.get(a.dataUri)) continue;
        const parsed = parseDataUri(a.dataUri);
        blocked.push({
          assetId: a.assetId,
          bytes: costOf(a.dataUri, a.bytes),
          reason: `${parsed ? parsed.mime : 'unknown'} cannot be re-encoded any smaller by the in-repo codec; supply a host resampler (deps.resample) or capture it smaller`,
        });
      }
      return unreachable(
        `even with every asset at ${Math.round(SCALE_FLOOR * 100)}% of its linear size the artifact is ${reserve + floor.total} bytes, `
        + `still over the ${ceiling}-byte budget, so nothing was degraded`,
        blocked,
      );
    }
    fitting = floor;
    lo = 0;
  }

  const tolerance = (chosenTotal) => Math.max(1024, Math.round(0.02 * (startTotal - chosenTotal)));

  for (let probe = 0; probe < MEASURED_PROBES && hi - lo > SCALE_QUANTUM; probe++) {
    if (fitting && budget - fitting.total <= tolerance(fitting.total)) break;
    let q = solve(lo, hi);
    if (!(q > lo) || !(q < hi)) q = (lo + hi) / 2;
    const probed = measure(q);
    if (probed.total <= budget) {
      if (!fitting || probed.total > fitting.total) fitting = probed;
      lo = q;
    } else {
      hi = q;
    }
  }

  if (!fitting) {
    const floor = measure(0);
    if (floor.total > budget) {
      return unreachable(
        `even with every asset at ${Math.round(SCALE_FLOOR * 100)}% of its linear size the artifact is ${reserve + floor.total} bytes, `
        + `still over the ${ceiling}-byte budget, so nothing was degraded`,
      );
    }
    fitting = floor;
  }

  return settled(...planFrom(fitting), fitting.q);

  /**
   * Turn a measured dial position into the report §13 asks for.
   *
   * Every byte figure is what the **document** paid, not what one copy of the
   * payload weighs (C2). A hero the opening beat paints is written into the
   * pre-rendered markup and into the media table both, and a seller reading
   * "saved 1.0MB" about a file that lost 2.0MB has been given a number about
   * nothing.
   *
   * @param {{q: number, total: number, chosen: Map<string, any>}} chosen
   * @returns {[DegradationLine[], Map<string, any>, number]}
   */
  function planFrom(chosen) {
    /** @type {Map<string, {dataUri: string, width: number, height: number, bytes: number}>} */
    const replacements = new Map();
    /** @type {DegradationLine[]} */
    const plan = [];
    for (const asset of assets) {
      const entry = chosen.chosen.get(asset.dataUri);
      if (!entry) continue;
      replacements.set(asset.dataUri, entry.produced);
      const before = /** @type {number} */ (originalBytes.get(asset.dataUri));
      const fromSize = /** @type {{w: number, h: number}} */ (originalSize.get(asset.dataUri));
      const copies = copyCount.get(asset.dataUri) || 1;
      plan.push({
        assetId: asset.assetId,
        assetIds: asset.assetIds.slice(),
        rank: asset.rank,
        from: { w: fromSize.w, h: fromSize.h, quality },
        to: { w: entry.produced.width, h: entry.produced.height, quality },
        copies,
        predictedBytes: copies * entry.predicted,
        actualBytes: copies * entry.produced.bytes,
        reason: entry.produced.how,
        beforeBytes: copies * before,
        afterBytes: copies * entry.produced.bytes,
        savedBytes: copies * (before - entry.produced.bytes),
        scale: entry.scale,
        steps: scaleSteps(entry.scale),
      });
    }
    plan.sort((a, b) => a.rank - b.rank);
    return [plan, replacements, chosen.total];
  }
}

/**
 * @typedef {object} CostComponent
 * @property {string} name    what this part of the file is, in the seller's words
 * @property {number} bytes   what it costs the document
 * @property {string} [detail] anything that makes the number actionable
 */

/**
 * Name the largest things in the file that are not degradable images (P4).
 *
 * A refusal that says "1 asset could not be degraded: a 178-byte PNG" while
 * 485KB of embedded font sits in the same file has pointed the seller at the
 * smallest object in the room. The ladder only reaches images, so when the
 * overage is dominated by something else — a font, the runtime, the model
 * payload — the honest report is the one that says where the bytes are, in
 * descending order, whether or not anything can be done about them here.
 *
 * @param {CostComponent[]} components
 * @param {number} [limit]  how many to name before summarising the tail
 * @returns {string}
 */
export function describeFixedCost(components, limit = 4) {
  const real = (components || []).filter((c) => c && Number(c.bytes) > 0);
  if (!real.length) return '';
  const sorted = real.slice().sort((a, b) => b.bytes - a.bytes || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const shown = sorted.slice(0, Math.max(1, limit));
  const rest = sorted.slice(shown.length);
  const parts = shown.map((c) => `${c.name} ${c.bytes} bytes${c.detail ? ` (${c.detail})` : ''}`);
  if (rest.length) {
    parts.push(`everything else ${rest.reduce((n, c) => n + c.bytes, 0)} bytes`);
  }
  return `Where the bytes are: ${parts.join('; ')}.`;
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
