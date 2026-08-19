/**
 * The artifact's payload: how the proof model and its media get into the file
 * (§13 compression, DECISIONS D5 and D6).
 *
 * D6 splits the payload rather than compressing it whole. Media is already in
 * compressed formats, so putting it inside the deflate stream and then base64ing
 * the result pays the base64 expansion twice — about 1.39× the original bytes,
 * where leaving it outside costs 1.333× once, which is the floor for any
 * single-file HTML document. Text compresses four to six times over, so it
 * belongs inside. The split has a second benefit the cold-boot budget cares
 * about: media is usable the instant the document parses, with nothing awaiting
 * decompression.
 *
 * Two decisions this module makes that the spec left open, both recorded in
 * `docs/decisions/L10-emit.md`:
 *
 *   1. **The model payload is base64 in both variants**, compressed or not. A
 *      raw JSON payload would put the prospect's own `sourceUrl` strings into
 *      the document as literal text, and the network scanner — correctly — does
 *      not know the difference between a URL that is data and a URL that is a
 *      destination. Base64 removes the question. It costs 1.333× on a payload
 *      that only wins the comparison when it is small anyway.
 *   2. **The comparison includes the decoder.** The compressed variant has to
 *      carry an inflater for engines without `DecompressionStream`, so its true
 *      cost is the payload plus that code. §13 says to "measure and keep
 *      whichever is smaller"; measuring only half of it would not be measuring.
 *
 * @module emit/model
 */

import { deflateRaw } from '../core/deflate.js';
import { utf8Encode, base64Encode, utf8Length } from '../core/bytes.js';
import { stableStringify } from '../core/hash.js';
import { artifactRuntimeSource } from './artifact-runtime.js';

/** A data URI has to be at least this long before a placeholder is worth it. */
export const MEDIA_PLACEHOLDER_FLOOR = 64;

/**
 * Attribute the emitter puts on a pre-rendered element whose media the table
 * borrows back instead of writing out a second time. Its value is the media
 * table index it stands in for.
 */
export const MEDIA_REF_ATTR = 'data-pp-m';

/**
 * Attributes a hoisted payload may be read back out of at boot.
 *
 * Deliberately short. Every name here is an ordinary HTML attribute whose
 * `getAttribute` returns the literal text that was written — no namespace
 * resolution, no URL normalisation. `xlink:href` is not on the list: it is an
 * SVG-namespaced attribute whose `getAttribute` name depends on how the
 * document was parsed, and an artifact that cannot read one payload back is an
 * artifact with a hole in its model. Elements inside `<svg>` are skipped
 * entirely for the same reason.
 */
export const HOISTABLE_ATTRS = Object.freeze(['src', 'poster', 'href', 'data']);

/**
 * @typedef {object} SplitModel
 * @property {any} model              the proof with base64 media replaced by `@m<n>`
 * @property {string[]} table         the extracted data URIs, in first-use order
 * @property {number} mediaBytes      the emitted size of the media table
 */

/**
 * Is this string a base64 data URI large enough to move out of the model?
 *
 * Non-base64 data URIs — an inline SVG written as `data:image/svg+xml,<svg…>` —
 * are deliberately left in the model. They are text, so they compress, and
 * keeping them out of the media table means the table can never contain a
 * character that would terminate the raw-text element holding it.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isExtractableMedia(value) {
  if (typeof value !== 'string' || value.length < MEDIA_PLACEHOLDER_FLOOR) return false;
  if (!/^data:[^,]*;base64,/i.test(value)) return false;
  return /^[A-Za-z0-9+/=]*$/.test(value.slice(value.indexOf(',') + 1));
}

/**
 * Pull every large base64 data URI out of the model, replacing it with a
 * placeholder. Identical URIs collapse to one table entry, so a logo used on
 * six scenes is carried once.
 *
 * @param {any} proof
 * @returns {SplitModel}
 */
export function splitMedia(proof) {
  /** @type {string[]} */
  const table = [];
  /** @type {Map<string, number>} */
  const seen = new Map();

  const walk = (value) => {
    if (typeof value === 'string') {
      if (!isExtractableMedia(value)) return value;
      let index = seen.get(value);
      if (index === undefined) {
        index = table.length;
        table.push(value);
        seen.set(value, index);
      }
      return `@m${index}`;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      // Sorted, not insertion order. The walk order decides which media gets
      // `@m0`, so an object whose keys were built in a different order would
      // otherwise produce a different — but equivalent — payload, and §17.6
      // asserts byte-identity, not equivalence.
      /** @type {Record<string, unknown>} */
      const out = {};
      for (const key of Object.keys(value).sort()) out[key] = walk(value[key]);
      return out;
    }
    return value;
  };

  const model = walk(proof);
  const mediaText = table.join('\n');
  return { model, table, mediaBytes: utf8Length(mediaText) };
}

/**
 * @typedef {object} HoistedMedia
 * @property {any} tree        the first-paint tree, with `data-pp-m` on the elements that lend a payload
 * @property {string[]} lines  the media table as it should be written: a data URI, or `@<attribute>`
 * @property {number} hoisted  how many table entries the markup now carries instead
 * @property {number} savedBytes  bytes the document no longer writes twice
 */

/**
 * Stop writing the opening beat's pictures into the file twice (C2).
 *
 * `splitMedia` already carries each payload once *in the media table*. The
 * pre-rendered opening beat is a second copy of every payload it paints, and it
 * is not optional: §12's cold-boot budget is met by having the first scene
 * already in the markup, so the `<img>` needs a real `src` before a line of
 * JavaScript has run. On a proof whose opening scene shows a 1.3MB screenshot
 * that is 1.3MB of the file spent saying the same thing twice — 43% of the
 * artifact in the case that motivated this — and the size budgeter was charged
 * for one copy while the seller paid for two.
 *
 * So the markup keeps the payload and the table borrows it back. Each element
 * that lends one is marked `data-pp-m="<table index>"`, and its table line
 * becomes `@<attribute>` — three or five bytes instead of a megabyte. At boot,
 * `ppBootArtifact` reads the attribute off the marked element before the
 * runtime touches the stage, so the model it reassembles is byte-identical to
 * the one that was encoded.
 *
 * Deliberate limits:
 *
 *   - **Only the first element to carry a payload lends it.** Two `<img>` tags
 *     showing the same picture both need a real `src`; the second copy is a
 *     cost the markup genuinely has, and `assetFootprint` charges it.
 *   - **Nothing inside `<svg>`.** See `HOISTABLE_ATTRS`.
 *   - **Nothing inside a `raw` node.** Its content is an opaque HTML string;
 *     the emitter does not know what element the payload sits on, so it does
 *     not pretend to.
 *   - **Only payloads in the table.** Anything `splitMedia` left in the model
 *     is inside the compressed payload and is not a second literal copy.
 *
 * The tree is rebuilt rather than mutated: the caller's nodes may be shared
 * with the runtime's own render of the same scene.
 *
 * @param {any} tree                 the first-paint VNode tree
 * @param {string[]} table           `splitMedia(...).table`
 * @returns {HoistedMedia}
 */
export function hoistFirstPaintMedia(tree, table) {
  const lines = (table || []).slice();
  if (!lines.length) return { tree, lines, hoisted: 0, savedBytes: 0 };

  /** @type {Map<string, number>} */
  const indexOfPayload = new Map();
  for (let i = 0; i < lines.length; i++) if (!indexOfPayload.has(lines[i])) indexOfPayload.set(lines[i], i);

  /** @type {Set<number>} */
  const lent = new Set();
  let savedBytes = 0;

  /**
   * @param {any} node
   * @param {boolean} inSvg
   * @returns {any}
   */
  const walk = (node, inSvg) => {
    if (node === null || node === undefined || node === false) return node;
    if (Array.isArray(node)) return node.map((child) => walk(child, inSvg));
    if (typeof node !== 'object') return node;
    if ('raw' in node) return node;
    if (!node.t) return node;

    const tag = String(node.t).toLowerCase();
    const nowInSvg = inSvg || tag === 'svg';
    const attrs = node.a || {};
    /** @type {Record<string, unknown>|null} */
    let replacement = null;

    if (!nowInSvg) {
      for (const name of HOISTABLE_ATTRS) {
        const value = attrs[name];
        if (typeof value !== 'string') continue;
        const index = indexOfPayload.get(value);
        if (index === undefined || lent.has(index)) continue;
        lent.add(index);
        savedBytes += utf8Length(lines[index]) - (1 + name.length);
        lines[index] = `@${name}`;
        // The marker goes first so it is stable to read in the emitted markup;
        // attribute order is object key order (`toHtml`), and §17.6 asserts a
        // byte-identical re-emit.
        replacement = { [MEDIA_REF_ATTR]: String(index), ...attrs };
        break;
      }
    }

    const children = node.c ? walk(node.c, nowInSvg) : node.c;
    if (!replacement && children === node.c) return node;
    return { ...node, a: replacement || attrs, c: children };
  };

  const walked = walk(tree, false);
  return { tree: walked, lines, hoisted: lent.size, savedBytes };
}

/**
 * @typedef {object} EncodedPayload
 * @property {'deflate'|'raw'} mode
 * @property {string} payload         base64, ready to sit in an inert script element
 * @property {string} mediaText       one data URI per line
 * @property {number} modelBytes      emitted bytes of the model payload
 * @property {number} mediaBytes      emitted bytes of the media table
 * @property {number} bootBytes       emitted bytes of the decode code
 * @property {string} bootSource      the decode code for the chosen variant
 * @property {{mode: string, payloadBytes: number, bootBytes: number, totalBytes: number}[]} measured
 */

/**
 * Serialize, compress, measure both variants, keep the smaller.
 *
 * @param {any} proof
 * @returns {EncodedPayload}
 */
export function encodePayload(proof) {
  const split = splitMedia(proof);
  // `stableStringify` sorts keys, so the payload — and therefore the artifact —
  // does not depend on the order a lane happened to build its objects in (§5).
  const json = stableStringify(split.model);
  const bytes = utf8Encode(json);

  const rawPayload = base64Encode(bytes);
  const deflatePayload = base64Encode(deflateRaw(bytes));

  const rawBoot = artifactRuntimeSource('raw');
  const deflateBoot = artifactRuntimeSource('deflate');

  const variants = [
    { mode: /** @type {'raw'} */ ('raw'), payload: rawPayload, boot: rawBoot },
    { mode: /** @type {'deflate'} */ ('deflate'), payload: deflatePayload, boot: deflateBoot },
  ].map((v) => ({
    ...v,
    payloadBytes: utf8Length(v.payload),
    bootBytes: utf8Length(v.boot),
    totalBytes: utf8Length(v.payload) + utf8Length(v.boot),
  }));

  // Ties go to `raw`: an artifact that needs no decoder starts a millisecond
  // sooner and has one fewer thing that can fail on an old engine.
  const chosen = variants.reduce((best, v) => (v.totalBytes < best.totalBytes ? v : best), variants[0]);

  return {
    mode: chosen.mode,
    payload: chosen.payload,
    mediaText: split.table.join('\n'),
    modelBytes: chosen.payloadBytes,
    mediaBytes: split.mediaBytes,
    bootBytes: chosen.bootBytes,
    bootSource: chosen.boot,
    measured: variants.map((v) => ({ mode: v.mode, payloadBytes: v.payloadBytes, bootBytes: v.bootBytes, totalBytes: v.totalBytes })),
  };
}
