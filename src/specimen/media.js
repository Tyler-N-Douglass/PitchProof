/**
 * Media capture — §8: "Inline all media as data URIs at capture time,
 * downscaled to a max edge of 2400px, recompressed at the project's
 * `imageQuality`."
 *
 * What happens to each input format, exactly (D-L6-6):
 *
 * | Input | Decoded | Downscaled to 2400px | Recompressed | Reported |
 * |---|---|---|---|---|
 * | PNG   | yes, in-repo decoder | yes, area-average box filter | yes, in-repo encoder; palette-reduced below quality 0.85 | `resized`, `recompressed`, exact `intrinsic`, exact `bytes` |
 * | JPEG  | no    | **no** | no — passed through byte-for-byte | `resized:false`, `needsDownscale`, `resizeSkipped:'jpeg-no-encoder'` |
 * | GIF / WebP / BMP / ICO | no | no | no — passed through | same as JPEG |
 * | SVG   | n/a   | n/a (vector) | no | `intrinsic` from width/height or viewBox; `hasScript` / `hasExternalRef` flagged for the emitter |
 * | anything else | — | — | — | skipped entirely; never invented |
 *
 * There is no JPEG encoder in this repository, and half a JPEG encoder would
 * produce visibly worse images than the original while claiming to have
 * "recompressed" them. Passing the bytes through and telling L10's budgeter
 * that the asset was **not** resized is the honest option, and it is the one
 * §13's "report exactly what was degraded and by how much — never silently"
 * asks for.
 */

import { base64Encode, toHex, utf8Decode } from '../core/bytes.js';
import { sha256Bytes } from '../core/hash.js';
import { contentId } from '../core/ids.js';
import { imageInfo } from './imageinfo.js';
import { decodePng, encodePng } from './png.js';
import { medianCut } from './quantize.js';
import { fitWithin, resizeRgba } from './resample.js';

/** §8's hard ceiling on the longest edge of any captured raster. */
export const MAX_EDGE = 2400;

/**
 * A capture-time index of what has already been inlined, shared across the
 * specimens of one project.
 *
 * `captureMedia` dedupes by SHA-256 **within one call**, but a project captures
 * each page in its own call, so a shared logo or hero image is otherwise
 * inlined once per page — and §13 then budgets an artifact that is carrying n
 * copies of the same bytes. Passing one ledger to every `buildSpecimen` call
 * makes the second and later captures reuse the first `MediaRef` (same id, same
 * data URI) instead of encoding it again, which also saves the re-encode.
 *
 * Deterministic: the result depends only on the order the captures are made in,
 * which is the project's own order.
 */
export class MediaLedger {
  constructor() {
    /** @type {Map<string, any>} digest → MediaRef */
    this.byDigest = new Map();
    this.hits = 0;
    this.bytesSaved = 0;
  }

  /** @param {string} digest @returns {any|null} */
  get(digest) {
    const hit = this.byDigest.get(digest);
    if (!hit) return null;
    this.hits += 1;
    this.bytesSaved += hit.bytes;
    return hit;
  }

  /** @param {any} ref */
  put(ref) {
    if (ref && ref.digest && !this.byDigest.has(ref.digest)) this.byDigest.set(ref.digest, ref);
    return ref;
  }

  /** @returns {any[]} every distinct MediaRef the ledger has seen, in capture order */
  refs() { return [...this.byDigest.values()]; }

  get size() { return this.byDigest.size; }
}

/** Formats this lane can decode, resample and re-encode. */
export const RESIZABLE_FORMATS = new Set(['png']);

/**
 * Palette size for a quality tier. `QUALITY_STEPS` from the contract are
 * 0.6 / 0.75 / 0.85 / 0.92; the top two tiers stay truecolour.
 * @param {number} quality
 * @returns {number} 0 means "do not quantise"
 */
export function paletteFor(quality) {
  const q = typeof quality === 'number' && Number.isFinite(quality) ? quality : 0.85;
  if (q >= 0.85) return 0;
  if (q >= 0.7) return 256;
  return 64;
}

/**
 * @param {Uint8Array} bytes
 * @param {string} mime
 * @returns {string}
 */
export function toDataUri(bytes, mime) {
  return `data:${mime};base64,${base64Encode(bytes)}`;
}

/**
 * §8 / API.md L6 — inline every captured asset as a `MediaRef`.
 *
 * @param {{name?: string, bytes: Uint8Array, mime?: string, alt?: string|null, src?: string}[]} assets
 * @param {{imageQuality?: number, maxEdge?: number, idMinter?: {next: (kind: string) => string},
 *          ledger?: MediaLedger}} [options]
 * @returns {import('../core/contracts.d.ts').MediaRef[]}
 */
export function captureMedia(assets, options = {}) {
  const maxEdge = options.maxEdge === undefined ? MAX_EDGE : options.maxEdge;
  const quality = options.imageQuality === undefined ? 0.85 : options.imageQuality;
  const minter = options.idMinter || null;
  const ledger = options.ledger || null;
  /** @type {any[]} */
  const out = [];
  /** @type {Map<string, any>} identical source bytes collapse to one ref */
  const seen = new Map();

  for (const asset of assets || []) {
    if (!asset || !asset.bytes || asset.bytes.length === 0) continue;
    const digest = toHex(sha256Bytes(asset.bytes));
    const existing = seen.get(digest);
    if (existing) {
      addSource(existing, asset);
      continue;
    }
    // Already inlined by an earlier specimen of the same project: reuse the
    // MediaRef whole, so the bytes appear once in the artifact (§13).
    const shared = ledger ? ledger.get(digest) : null;
    if (shared) {
      addSource(shared, asset);
      seen.set(digest, shared);
      out.push(shared);
      continue;
    }
    const ref = captureOne(asset, { maxEdge, quality, minter, digest });
    if (!ref) continue;
    seen.set(digest, ref);
    if (ledger) ledger.put(ref);
    out.push(ref);
  }
  return out;
}

/** Record every name/src an asset was reached by, so `<img>` resolution works. */
function addSource(ref, asset) {
  for (const key of [asset.name, asset.src]) {
    if (key && !ref.sources.includes(key)) ref.sources.push(key);
  }
  if (ref.alt === null && asset.alt) ref.alt = String(asset.alt);
}

/**
 * @returns {any|null} a `MediaRef` with lane extensions, or null when the bytes
 *   are not an image this pipeline recognises
 */
function captureOne(asset, { maxEdge, quality, minter, digest }) {
  const hint = `${asset.mime || ''} ${asset.name || ''}`;
  const info = imageInfo(asset.bytes, hint);
  if (info.format === 'unknown') return null;

  let bytes = asset.bytes;
  let mime = info.mime;
  let width = info.w;
  let height = info.h;
  let resized = false;
  let recompressed = false;
  /** @type {string|null} */
  let resizeSkipped = null;
  /** @type {string[]} */
  const notes = [];

  if (info.format === 'png') {
    try {
      const decoded = decodePng(asset.bytes);
      width = decoded.width;
      height = decoded.height;
      const fit = fitWithin(decoded.width, decoded.height, maxEdge);
      let rgba = decoded.rgba;
      if (fit.scaled) {
        rgba = resizeRgba(decoded.rgba, decoded.width, decoded.height, fit.w, fit.h);
        width = fit.w;
        height = fit.h;
        resized = true;
      }
      const palette = paletteSpec(rgba, quality);
      const encoded = encodePng(rgba, width, height, palette ? { palette } : {});
      if (resized || encoded.length < asset.bytes.length) {
        bytes = encoded;
        recompressed = true;
        if (palette) notes.push(`palette:${palette.colors.length}`);
      } else {
        notes.push('kept-original-bytes: re-encode was not smaller');
      }
      mime = 'image/png';
    } catch (err) {
      // A PNG we cannot decode is still a PNG the browser can render; carrying
      // it through unchanged beats dropping the prospect's own image.
      resizeSkipped = `png-decode-failed: ${err && err.message ? err.message : 'unknown'}`;
      notes.push(resizeSkipped);
    }
  } else if (info.format === 'svg') {
    const text = utf8Decode(asset.bytes);
    if (/<script[\s>]/i.test(text)) notes.push('svg:script');
    if (/(?:href|src)\s*=\s*["']?https?:/i.test(text)) notes.push('svg:external-reference');
    if (!info.known) notes.push('svg:intrinsic-unknown');
  } else {
    resizeSkipped = `${info.format}-no-encoder`;
  }

  const needsDownscale = (width > maxEdge || height > maxEdge) && !resized;
  if (needsDownscale && !resizeSkipped) resizeSkipped = `${info.format}-no-encoder`;

  const id = minter ? minter.next('media') : contentId('media', { digest, quality, maxEdge });
  return {
    id,
    dataUri: toDataUri(bytes, mime),
    alt: asset.alt === undefined || asset.alt === null ? null : String(asset.alt),
    intrinsic: { w: width, h: height },
    bytes: bytes.length,
    // --- lane extensions (optional fields only; §4 permits them) ---
    mime,
    format: info.format,
    name: asset.name || null,
    src: asset.src || asset.name || null,
    sources: [asset.name, asset.src].filter(Boolean),
    digest,
    sourceBytes: asset.bytes.length,
    originalIntrinsic: { w: info.w, h: info.h },
    resized,
    recompressed,
    quality: info.format === 'png' && recompressed ? quality : null,
    needsDownscale,
    resizeSkipped,
    notes,
  };
}

/**
 * Build the palette for a quality tier, or null to stay truecolour. A palette
 * that would not actually reduce the colour count is skipped — it would only
 * add a PLTE chunk for nothing.
 */
function paletteSpec(rgba, quality) {
  const limit = paletteFor(quality);
  if (!limit) return null;
  const result = medianCut(rgba, limit);
  if (result.colors.length > 256) return null;
  return result;
}


/**
 * Collapse byte-identical media across a whole project.
 *
 * `MediaLedger` prevents duplicates at capture time, but specimens are often
 * captured independently — the studio imports a page today and another
 * tomorrow, and the critic's pipeline builds each specimen in its own call — so
 * a project assembled from those still carries n copies of one hero image.
 * §13 budgets against `maxBytes`; carrying the same bytes three times spends
 * that budget on nothing and makes the degradation report double-count.
 *
 * Works on anything shaped `{media: MediaRef[], blocks: ContentBlock[]}`, so
 * specimens and renditions can be passed together — and a `Specimen`'s
 * `stripped[].blocks` are rewritten too, so restoring a stripped block cannot
 * reintroduce a dangling ref.
 *
 * The surviving id is the lexicographically smallest in each group, which
 * depends on the ids alone and not on the order the carriers are passed in —
 * §17.6 needs the same project to dedupe to the same bytes every time.
 *
 * @param {any[]} carriers specimens and/or renditions
 * @returns {{carriers: any[], mapping: Record<string, string>, merged: number,
 *            bytesSaved: number, groups: {id: string, absorbed: string[], bytes: number}[]}}
 */
export function dedupeMedia(carriers) {
  const items = Array.isArray(carriers) ? carriers : [];

  /** @type {Map<string, any[]>} identical inlined bytes → the refs carrying them */
  const groups = new Map();
  for (const carrier of items) {
    for (const ref of (carrier && carrier.media) || []) {
      if (!ref || !ref.id || !ref.dataUri) continue;
      // Group on what actually costs bytes in the artifact — the inlined data
      // URI — rather than on the source digest, since two captures of one image
      // at different scales are genuinely different assets.
      const key = ref.dataUri;
      const list = groups.get(key);
      if (list) list.push(ref);
      else groups.set(key, [ref]);
    }
  }

  /** @type {Record<string, string>} */
  const mapping = {};
  /** @type {Map<string, any>} surviving id → the MediaRef to keep */
  const survivors = new Map();
  /** @type {{id: string, absorbed: string[], bytes: number}[]} */
  const report = [];
  let merged = 0;
  let bytesSaved = 0;

  for (const refs of groups.values()) {
    const ids = [...new Set(refs.map((r) => r.id))].sort();
    const keepId = ids[0];
    const keep = mergeRefs(refs.filter((r) => r.id === keepId)[0], refs);
    survivors.set(keepId, keep);
    for (const id of ids) mapping[id] = keepId;
    if (ids.length > 1) {
      merged += ids.length - 1;
      bytesSaved += keep.bytes * (ids.length - 1);
      report.push({ id: keepId, absorbed: ids.slice(1), bytes: keep.bytes });
    }
  }

  const rewriteBlocks = (blocks) => (blocks || []).map((b) => {
    if (!b || b.type !== 'media') return b;
    const to = mapping[b.ref];
    return to && to !== b.ref ? { ...b, ref: to } : b;
  });

  const out = items.map((carrier) => {
    if (!carrier) return carrier;
    /** @type {any[]} */
    const media = [];
    const kept = new Set();
    for (const ref of carrier.media || []) {
      const keepId = mapping[ref.id] || ref.id;
      if (kept.has(keepId)) continue;
      kept.add(keepId);
      media.push(survivors.get(keepId) || ref);
    }
    /** @type {any} */
    const next = { ...carrier, media, blocks: rewriteBlocks(carrier.blocks) };
    if (Array.isArray(carrier.stripped)) {
      next.stripped = carrier.stripped.map((entry) => ({ ...entry, blocks: rewriteBlocks(entry.blocks) }));
    }
    return next;
  });

  return { carriers: out, mapping, merged, bytesSaved, groups: report };
}

/**
 * One MediaRef standing for a group of identical ones. Alt text and source
 * names differ per page, so everything the group knew is kept: the first
 * non-empty alt wins and the rest are recorded, rather than being lost to a
 * merge nobody can see afterwards.
 */
function mergeRefs(keep, refs) {
  const alts = [...new Set(refs.map((r) => r.alt).filter((a) => a))];
  const sources = [...new Set(refs.flatMap((r) => r.sources || []).filter(Boolean))].sort();
  const merged = { ...keep };
  if (!merged.alt && alts.length) [merged.alt] = alts;
  if (sources.length) merged.sources = sources;
  if (alts.length > 1) merged.altVariants = alts;
  const absorbed = [...new Set(refs.map((r) => r.id))].sort().filter((id) => id !== keep.id);
  if (absorbed.length) merged.absorbedIds = absorbed;
  return merged;
}
