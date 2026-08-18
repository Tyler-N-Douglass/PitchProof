/**
 * Imagery treatment classification (§7).
 *
 * §7 asks for "an imagery treatment classifier (edge density + saturation
 * distribution + face detection heuristic -> photographic / illustrative /
 * mixed)". All three signals are here, and every threshold is named, exported
 * and documented with where it came from — a classifier whose constants are
 * anonymous magic numbers cannot be argued with, and a brand fact nobody can
 * argue with is a brand fact nobody can correct.
 *
 * ## Input
 *
 * The caller supplies decoded pixels. This module does not decode JPEG, and
 * deliberately: a half-written JPEG decoder produces subtly wrong pixels, and
 * wrong pixels here become a wrong brand fact. The studio decodes with the
 * platform (`createImageBitmap` + a canvas) and hands the result over; Node
 * tests build buffers directly; PNGs can be decoded in-repo with
 * `sampleFromPng`, which runs on `core/inflate.js`.
 *
 * ```ts
 * type ImageSample = {
 *   id?: string;              // stable identifier, for reporting
 *   width: number;            // pixels
 *   height: number;
 *   data: Uint8Array | Uint8ClampedArray;   // RGBA, row-major, length = width*height*4
 *   role?: 'hero' | 'content' | 'thumbnail' | 'logo' | 'background';
 *   weight?: number;          // relative importance; defaults to rendered area
 * };
 * ```
 *
 * `weight` is how §7's "weight clusters by rendered area, not by occurrence
 * count" applies to imagery: a full-bleed hero decides a brand's imagery
 * treatment and a 48px thumbnail does not.
 *
 * @module brand/imagery
 */

import { decodePng } from './logo.js';

// ---------------------------------------------------------------- constants

/**
 * Every threshold this classifier uses, with its provenance. Exported so a test
 * can assert against the constant rather than against a number typed twice, and
 * so the studio can show a user why an image was called what it was called.
 */
export const IMAGERY_THRESHOLDS = {
  /**
   * Longest edge the analysis runs at. Every feature here is a per-pixel
   * statistic, so a box-averaged 256px copy carries the same distributions at a
   * fraction of the cost — and a fixed analysis size means two captures of the
   * same image at different resolutions classify identically.
   */
  analysisMaxEdge: 256,

  /**
   * Sobel gradient magnitude, as a fraction of the operator's maximum (4x255),
   * at or above which a pixel sits on an edge. 0.08 is a step of roughly 20
   * luma levels across the 3x3 window — the smallest luminance step that reads
   * as a boundary rather than as 8-bit quantisation noise.
   */
  edgeMagnitude: 0.08,

  /**
   * Gradient magnitude below which a pixel is inside a flat region. 0.02 is
   * about 5 luma levels across the window, which is within the banding a JPEG or
   * a gradient mesh produces inside an area a designer drew as flat.
   */
  flatMagnitude: 0.02,

  /**
   * Edge-density ramp. Vector and flat-illustration artwork sits at the bottom
   * of this range because its edges are confined to shape boundaries;
   * photographic imagery sits at the top because film grain, sensor noise and
   * natural texture put a gradient nearly everywhere.
   */
  edgeDensityRamp: { lo: 0.02, hi: 0.18 },

  /** Flat-region-share ramp, the same signal read from the other end. */
  flatShareRamp: { lo: 0.35, hi: 0.9 },

  /**
   * Palette concentration: the share of pixels falling in the eight most
   * populated bins of a 5-bit-per-channel (32x32x32) quantisation. An
   * illustration is built from a chosen palette and concentrates; a photograph
   * spreads across thousands of bins.
   */
  paletteShareRamp: { lo: 0.1, hi: 0.7 },

  /** Number of quantisation bins the palette share is measured over. */
  paletteTopBins: 8,

  /** Bits per channel in the palette quantisation. */
  paletteBits: 5,

  /**
   * HSV saturation at or above which a pixel is "vivid", and the ramp for the
   * share of vivid pixels. Flat illustration and brand-colour artwork pushes
   * saturation far past what a camera records under ordinary light.
   */
  vividSaturation: 0.6,
  vividShareRamp: { lo: 0.05, hi: 0.45 },

  /**
   * The saturation a `saturationBias` of 0 corresponds to. This is a stated
   * anchor, not a measurement: 0 means "as saturated as ordinary photographic
   * imagery", -1 means fully neutral, +1 means fully saturated. 0.30 is the
   * midpoint of the 0.2-0.4 band that unmodified photographic imagery's mean
   * HSV saturation falls into, and it is the only number in this module a brand
   * team is likely to want to move.
   */
  neutralSaturation: 0.3,

  /**
   * Skin-tone bounds in YCbCr, from Chai & Ngan, "Face segmentation using
   * skin-color map in videophone applications", IEEE Transactions on Circuits
   * and Systems for Video Technology 9(4):551-564, 1999.
   */
  skinYCbCr: { cbMin: 77, cbMax: 127, crMin: 133, crMax: 173 },

  /**
   * Skin-tone bounds in RGB under uniform daylight, from Kovac, Peer & Solina,
   * "Human skin color clustering for face detection", EUROCON 2003. Both rules
   * must agree before a pixel is called skin, which cuts the false positives
   * either rule produces on wood, sand and terracotta.
   */
  skinRgb: { rMin: 95, gMin: 40, bMin: 20, spreadMin: 15, rgDiffMin: 15 },

  /**
   * A skin-coloured blob is face-like when it occupies this share of the frame,
   * has a bounding box taller than it is wide but not by more than 2:1, and
   * fills that box solidly. The bounds are the geometry of a human head:
   * roughly 1.3:1 tall in the frontal view, and convex enough that its blob
   * fills most of its own bounding box.
   */
  face: { minAreaShare: 0.005, maxAreaShare: 0.35, minAspect: 0.9, maxAspect: 2.2, minFill: 0.45 },

  /**
   * An image with fewer pixels than this, or with almost nothing painted, is
   * `unknown` rather than classified: 8x8 is the smallest grid a 3x3 Sobel
   * operator has an interior for at all, and an image that is 98% transparent
   * carries no treatment to read.
   */
  minAnalysablePixels: 64,
  minOpaqueShare: 0.02,

  /**
   * Below this score for both classes, an image is `unknown` rather than
   * guessed at. Above it, a margin narrower than `mixedMargin` means the image
   * itself is mixed — a photograph with flat graphic overlay, which is a real
   * and common treatment.
   */
  minDecisive: 0.35,
  mixedMargin: 0.12,

  /**
   * The share of weighted evidence one class must hold before the brand's
   * imagery is called that class rather than mixed.
   */
  dominantShare: 0.7,

  /**
   * Weighted pixel area at which the sample is large enough for full confidence.
   * Two 1024x768 images.
   */
  sampleSaturationPx: 2 * 1024 * 768,
};

/**
 * Feature weights for the two class scores. Each set sums to 1 before the face
 * bonus is applied.
 *
 * Texture carries the most weight for `photographic` because it is the signal
 * that separates a photograph from everything else. Flatness and palette
 * concentration carry the most for `illustrative` for the same reason in
 * reverse. Saturation is a supporting signal only: a heavily graded photograph
 * is saturated too, so it may never decide a class on its own.
 */
export const IMAGERY_WEIGHTS = {
  photographic: { texture: 0.45, paletteSpread: 0.35, notFlat: 0.2 },
  illustrative: { flatness: 0.4, paletteConcentration: 0.35, vividness: 0.25 },
  /** How much a detected face moves each score. A face is nearly conclusive. */
  faceBonus: 0.25,
};

// ------------------------------------------------------------------ sampling

/**
 * Validate and normalize a caller-supplied image sample.
 * @param {any} sample
 * @param {number} index
 * @returns {{id: string, width: number, height: number, data: Uint8Array, weight: number, role: string}}
 */
export function normalizeSample(sample, index = 0) {
  if (!sample || typeof sample !== 'object') throw new Error(`imagery: sample ${index} is not an object`);
  const width = Math.floor(Number(sample.width));
  const height = Math.floor(Number(sample.height));
  if (!(width > 0 && height > 0)) throw new Error(`imagery: sample ${index} has no dimensions`);
  const data = sample.data;
  if (!data || typeof data.length !== 'number') throw new Error(`imagery: sample ${index} has no pixel data`);
  if (data.length < width * height * 4) {
    throw new Error(`imagery: sample ${index} has ${data.length} bytes, needs ${width * height * 4} (RGBA)`);
  }
  return {
    id: typeof sample.id === 'string' ? sample.id : `image-${index}`,
    width,
    height,
    data: data instanceof Uint8Array ? data : new Uint8Array(data.buffer ? data.buffer : data),
    weight: Number.isFinite(sample.weight) && sample.weight > 0 ? sample.weight : width * height,
    role: typeof sample.role === 'string' ? sample.role : 'content',
  };
}

/**
 * Decode a PNG into an `ImageSample`, for callers that have bytes rather than
 * pixels. Runs on `core/inflate.js`; no platform image decoding involved.
 * @param {Uint8Array} bytes
 * @param {{id?: string, role?: string, weight?: number}} [meta]
 * @returns {{id: string, width: number, height: number, data: Uint8Array, weight: number, role: string}}
 */
export function sampleFromPng(bytes, meta = {}) {
  const decoded = decodePng(bytes);
  return normalizeSample({ ...meta, width: decoded.width, height: decoded.height, data: decoded.data }, 0);
}

/**
 * Box-average an image down so its longest edge is at most `maxEdge`. Averaging
 * rather than nearest-neighbour matters: nearest-neighbour would keep the
 * high-frequency noise that the edge-density signal is trying to measure and
 * report the same texture at every scale.
 * @param {{width: number, height: number, data: Uint8Array}} image
 * @param {number} maxEdge
 * @returns {{width: number, height: number, data: Uint8Array}}
 */
export function downsample(image, maxEdge) {
  const longest = Math.max(image.width, image.height);
  if (longest <= maxEdge) return { width: image.width, height: image.height, data: image.data };
  const scale = maxEdge / longest;
  const w = Math.max(1, Math.round(image.width * scale));
  const h = Math.max(1, Math.round(image.height * scale));
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * image.height) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * image.height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * image.width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * image.width) / w));
      let r = 0; let g = 0; let b = 0; let a = 0; let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * image.width + sx) * 4;
          r += image.data[i]; g += image.data[i + 1]; b += image.data[i + 2]; a += image.data[i + 3];
          n += 1;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return { width: w, height: h, data: out };
}

// ------------------------------------------------------------------ features

/**
 * Rec. 709 luma, the same coefficients WCAG 2.1 uses for relative luminance, so
 * "brightness" means one thing across the whole product.
 * @param {number} r @param {number} g @param {number} b
 * @returns {number}
 */
export function luma(r, g, b) { return 0.2126 * r + 0.7152 * g + 0.0722 * b; }

/**
 * HSV saturation of an sRGB triple: (max - min) / max, and 0 for black.
 * @param {number} r @param {number} g @param {number} b
 * @returns {number}
 */
export function saturation(r, g, b) {
  const max = Math.max(r, g, b);
  if (max === 0) return 0;
  return (max - Math.min(r, g, b)) / max;
}

/**
 * @typedef {object} EdgeStats
 * @property {number} edgeDensity   share of pixels on an edge
 * @property {number} flatShare     share of pixels inside a flat region
 * @property {number} meanMagnitude mean normalized gradient magnitude
 */

/**
 * Sobel edge statistics over the luma channel. The 3x3 Sobel operator's maximum
 * response is 4x255 per axis, which is what the magnitude is normalized by.
 * @param {{width: number, height: number, data: Uint8Array}} image
 * @returns {EdgeStats}
 */
export function edgeStats(image) {
  const { width: w, height: h, data } = image;
  if (w < 3 || h < 3) return { edgeDensity: 0, flatShare: 1, meanMagnitude: 0 };
  const l = new Float64Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) l[i] = luma(data[p], data[p + 1], data[p + 2]);

  const t = IMAGERY_THRESHOLDS;
  let edges = 0;
  let flats = 0;
  let total = 0;
  let sum = 0;
  const norm = 4 * 255;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const tl = l[i - w - 1]; const tc = l[i - w]; const tr = l[i - w + 1];
      const ml = l[i - 1]; const mr = l[i + 1];
      const bl = l[i + w - 1]; const bc = l[i + w]; const br = l[i + w + 1];
      const gx = (tr + 2 * mr + br) - (tl + 2 * ml + bl);
      const gy = (bl + 2 * bc + br) - (tl + 2 * tc + tr);
      const mag = Math.sqrt(gx * gx + gy * gy) / norm;
      sum += mag;
      total += 1;
      if (mag >= t.edgeMagnitude) edges += 1;
      else if (mag < t.flatMagnitude) flats += 1;
    }
  }
  if (total === 0) return { edgeDensity: 0, flatShare: 1, meanMagnitude: 0 };
  return { edgeDensity: edges / total, flatShare: flats / total, meanMagnitude: sum / total };
}

/**
 * @typedef {object} PaletteStats
 * @property {number} distinctBins
 * @property {number} topShare       share of pixels in the top-N bins
 */

/**
 * Palette concentration over a 5-bit-per-channel quantisation.
 * @param {{width: number, height: number, data: Uint8Array}} image
 * @returns {PaletteStats}
 */
export function paletteStats(image) {
  const t = IMAGERY_THRESHOLDS;
  const shift = 8 - t.paletteBits;
  /** @type {Map<number, number>} */
  const bins = new Map();
  const d = image.data;
  let counted = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;                 // transparent pixels are not paint
    const key = ((d[i] >> shift) << (2 * t.paletteBits)) | ((d[i + 1] >> shift) << t.paletteBits) | (d[i + 2] >> shift);
    bins.set(key, (bins.get(key) || 0) + 1);
    counted += 1;
  }
  if (counted === 0) return { distinctBins: 0, topShare: 0 };
  const counts = [...bins.values()].sort((a, b) => b - a);
  let top = 0;
  for (let i = 0; i < Math.min(t.paletteTopBins, counts.length); i++) top += counts[i];
  return { distinctBins: bins.size, topShare: top / counted };
}

/**
 * @typedef {object} SaturationStats
 * @property {number} mean
 * @property {number} vividShare
 * @property {number} neutralShare
 */

/**
 * Saturation distribution over the opaque pixels.
 * @param {{width: number, height: number, data: Uint8Array}} image
 * @returns {SaturationStats}
 */
export function saturationStats(image) {
  const t = IMAGERY_THRESHOLDS;
  const d = image.data;
  let sum = 0;
  let vivid = 0;
  let neutral = 0;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;
    const s = saturation(d[i], d[i + 1], d[i + 2]);
    sum += s;
    if (s >= t.vividSaturation) vivid += 1;
    if (s < 0.1) neutral += 1;
    n += 1;
  }
  if (n === 0) return { mean: 0, vividShare: 0, neutralShare: 1 };
  return { mean: sum / n, vividShare: vivid / n, neutralShare: neutral / n };
}

/**
 * @typedef {object} FaceStats
 * @property {number} skinShare
 * @property {boolean} faceLike
 * @property {{areaShare: number, aspect: number, fill: number}|null} blob
 */

/**
 * The face-detection heuristic §7 asks for. Not a face detector — a
 * skin-coloured-blob detector with the geometry of a head, which is enough to
 * separate "people photography" from "flat illustration" and is honest about
 * being a heuristic.
 *
 * Two published skin-tone rules must both agree before a pixel counts, then the
 * mask's connected components are measured against the proportions of a human
 * head.
 *
 * @param {{width: number, height: number, data: Uint8Array}} image
 * @returns {FaceStats}
 */
export function faceStats(image) {
  const t = IMAGERY_THRESHOLDS;
  const { width: w, height: h, data } = image;
  const mask = new Uint8Array(w * h);
  let skin = 0;
  let opaque = 0;
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    if (data[p + 3] < 128) continue;
    opaque += 1;
    if (isSkinPixel(data[p], data[p + 1], data[p + 2])) { mask[i] = 1; skin += 1; }
  }
  const skinShare = opaque > 0 ? skin / opaque : 0;
  if (skin === 0) return { skinShare: 0, faceLike: false, blob: null };

  const blob = largestBlob(mask, w, h);
  if (!blob) return { skinShare, faceLike: false, blob: null };

  const areaShare = blob.area / (w * h);
  const boxW = blob.maxX - blob.minX + 1;
  const boxH = blob.maxY - blob.minY + 1;
  const aspect = boxW > 0 ? boxH / boxW : 0;
  const fill = boxW * boxH > 0 ? blob.area / (boxW * boxH) : 0;
  const faceLike = areaShare >= t.face.minAreaShare
    && areaShare <= t.face.maxAreaShare
    && aspect >= t.face.minAspect
    && aspect <= t.face.maxAspect
    && fill >= t.face.minFill;
  return { skinShare, faceLike, blob: { areaShare, aspect, fill } };
}

/**
 * Both published skin rules, ANDed.
 * @param {number} r @param {number} g @param {number} b
 * @returns {boolean}
 */
export function isSkinPixel(r, g, b) {
  const t = IMAGERY_THRESHOLDS;
  // Kovac, Peer & Solina (2003), uniform daylight rule.
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const rgbOk = r > t.skinRgb.rMin && g > t.skinRgb.gMin && b > t.skinRgb.bMin
    && (max - min) > t.skinRgb.spreadMin
    && Math.abs(r - g) > t.skinRgb.rgDiffMin
    && r > g && r > b;
  if (!rgbOk) return false;
  // Chai & Ngan (1999), YCbCr chrominance rule (ITU-R BT.601 conversion).
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  return cb >= t.skinYCbCr.cbMin && cb <= t.skinYCbCr.cbMax && cr >= t.skinYCbCr.crMin && cr <= t.skinYCbCr.crMax;
}

/**
 * Largest 4-connected component of a binary mask, by iterative flood fill so a
 * large region cannot overflow the call stack.
 * @param {Uint8Array} mask @param {number} w @param {number} h
 * @returns {{area: number, minX: number, minY: number, maxX: number, maxY: number}|null}
 */
export function largestBlob(mask, w, h) {
  const seen = new Uint8Array(w * h);
  /** @type {{area: number, minX: number, minY: number, maxX: number, maxY: number}|null} */
  let best = null;
  const stack = new Int32Array(w * h);
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || seen[start]) continue;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    let area = 0;
    let minX = w; let minY = h; let maxX = 0; let maxY = 0;
    while (top > 0) {
      const i = stack[--top];
      const x = i % w;
      const y = (i - x) / w;
      area += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && mask[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack[top++] = i - 1; }
      if (x < w - 1 && mask[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack[top++] = i + 1; }
      if (y > 0 && mask[i - w] && !seen[i - w]) { seen[i - w] = 1; stack[top++] = i - w; }
      if (y < h - 1 && mask[i + w] && !seen[i + w]) { seen[i + w] = 1; stack[top++] = i + w; }
    }
    if (!best || area > best.area) best = { area, minX, minY, maxX, maxY };
  }
  return best;
}

// -------------------------------------------------------------- per-image

/**
 * @typedef {object} ImageVerdict
 * @property {string} id
 * @property {'photographic'|'illustrative'|'mixed'|'unknown'} treatment
 * @property {number} photographic   0..1
 * @property {number} illustrative   0..1
 * @property {number} weight
 * @property {EdgeStats} edges
 * @property {PaletteStats} palette
 * @property {SaturationStats} saturation
 * @property {FaceStats} face
 */

/**
 * Classify one image.
 * @param {any} sample
 * @param {number} [index]
 * @returns {ImageVerdict}
 */
export function classifyImage(sample, index = 0) {
  const t = IMAGERY_THRESHOLDS;
  const norm = normalizeSample(sample, index);
  const small = downsample(norm, t.analysisMaxEdge);

  const opaque = opaqueShare(small);
  if (small.width * small.height < t.minAnalysablePixels || opaque < t.minOpaqueShare) {
    return {
      id: norm.id, treatment: 'unknown', photographic: 0, illustrative: 0, weight: norm.weight,
      edges: { edgeDensity: 0, flatShare: 0, meanMagnitude: 0 },
      palette: { distinctBins: 0, topShare: 0 },
      saturation: { mean: 0, vividShare: 0, neutralShare: 0 },
      face: { skinShare: 0, faceLike: false, blob: null },
    };
  }

  const edges = edgeStats(small);
  const palette = paletteStats(small);
  const sat = saturationStats(small);
  const face = faceStats(small);

  const texture = ramp(edges.edgeDensity, t.edgeDensityRamp.lo, t.edgeDensityRamp.hi);
  const flatness = ramp(edges.flatShare, t.flatShareRamp.lo, t.flatShareRamp.hi);
  const concentration = ramp(palette.topShare, t.paletteShareRamp.lo, t.paletteShareRamp.hi);
  const vividness = ramp(sat.vividShare, t.vividShareRamp.lo, t.vividShareRamp.hi);

  const pw = IMAGERY_WEIGHTS.photographic;
  const iw = IMAGERY_WEIGHTS.illustrative;
  let photographic = pw.texture * texture + pw.paletteSpread * (1 - concentration) + pw.notFlat * (1 - flatness);
  let illustrative = iw.flatness * flatness + iw.paletteConcentration * concentration + iw.vividness * vividness;
  if (face.faceLike) {
    photographic = Math.min(1, photographic + IMAGERY_WEIGHTS.faceBonus);
    illustrative = Math.max(0, illustrative - IMAGERY_WEIGHTS.faceBonus);
  }
  photographic = clamp01(photographic);
  illustrative = clamp01(illustrative);

  /** @type {'photographic'|'illustrative'|'mixed'|'unknown'} */
  let treatment;
  if (Math.max(photographic, illustrative) < t.minDecisive) treatment = 'unknown';
  else if (Math.abs(photographic - illustrative) < t.mixedMargin) treatment = 'mixed';
  else treatment = photographic > illustrative ? 'photographic' : 'illustrative';

  return {
    id: norm.id,
    treatment,
    photographic: round6(photographic),
    illustrative: round6(illustrative),
    weight: norm.weight,
    edges: { edgeDensity: round6(edges.edgeDensity), flatShare: round6(edges.flatShare), meanMagnitude: round6(edges.meanMagnitude) },
    palette: { distinctBins: palette.distinctBins, topShare: round6(palette.topShare) },
    saturation: { mean: round6(sat.mean), vividShare: round6(sat.vividShare), neutralShare: round6(sat.neutralShare) },
    face,
  };
}

// ---------------------------------------------------------------- aggregate

/**
 * Classify a brand's imagery (§7). The §4 contract asks for a treatment and a
 * saturation bias; the per-image verdicts and the aggregate weights come back
 * alongside them so the studio can show its working.
 *
 * @param {any[]} images   `ImageSample[]` — see the module docblock
 * @returns {{treatment: 'photographic'|'illustrative'|'mixed'|'unknown', saturationBias: number, verdicts: ImageVerdict[], weights: Record<string, number>, confidence: number}}
 */
export function classifyImagery(images) {
  const t = IMAGERY_THRESHOLDS;
  const list = Array.isArray(images) ? images : [];
  if (list.length === 0) {
    return { treatment: 'unknown', saturationBias: 0, verdicts: [], weights: { photographic: 0, illustrative: 0, mixed: 0, unknown: 0 }, confidence: 0 };
  }

  /** @type {ImageVerdict[]} */
  const verdicts = list.map((s, i) => classifyImage(s, i));
  const weights = { photographic: 0, illustrative: 0, mixed: 0, unknown: 0 };
  let satNum = 0;
  let satDen = 0;
  for (const v of verdicts) {
    weights[v.treatment] += v.weight;
    // An image that could not be read contributes no saturation evidence.
    if (v.treatment === 'unknown') continue;
    satNum += v.saturation.mean * v.weight;
    satDen += v.weight;
  }

  const decided = weights.photographic + weights.illustrative + weights.mixed;
  /** @type {'photographic'|'illustrative'|'mixed'|'unknown'} */
  let treatment = 'unknown';
  if (decided > 0) {
    // An image that is itself mixed is half evidence for each class.
    const photoShare = (weights.photographic + weights.mixed / 2) / decided;
    const illusShare = (weights.illustrative + weights.mixed / 2) / decided;
    if (photoShare >= t.dominantShare) treatment = 'photographic';
    else if (illusShare >= t.dominantShare) treatment = 'illustrative';
    else treatment = 'mixed';
  }

  const meanSaturation = satDen > 0 ? satNum / satDen : 0;
  return {
    treatment,
    saturationBias: saturationBias(meanSaturation),
    verdicts,
    weights,
    confidence: imageryConfidence(verdicts, treatment),
  };
}

/**
 * Map a mean HSV saturation onto the §4 `saturationBias` scale: -1 fully
 * neutral, 0 as saturated as ordinary photographic imagery
 * (`neutralSaturation`), +1 fully saturated. Piecewise linear about the anchor
 * and continuous at it, so a brand that sits exactly at the anchor reports
 * exactly 0.
 * @param {number} meanSaturation  0..1
 * @returns {number}
 */
export function saturationBias(meanSaturation) {
  const ref = IMAGERY_THRESHOLDS.neutralSaturation;
  const s = Math.max(0, Math.min(1, meanSaturation));
  if (s <= ref) return round6(s / ref - 1);
  return round6((s - ref) / (1 - ref));
}

/**
 * Confidence in the imagery verdict (§7: sample size and agreement across
 * sources, computed).
 *
 *   sample     — total analysed pixel area against `sampleSaturationPx`. One
 *                thumbnail is not a brand's imagery treatment.
 *   agreement  — the share of weight sitting on the reported treatment, with a
 *                `mixed` image counting as half-agreement with either class.
 *   decisive   — the mean margin between the two class scores, so a set of
 *                images that were all borderline reports low confidence even
 *                when they all landed on the same side.
 *
 * @param {ImageVerdict[]} verdicts
 * @param {string} treatment
 * @returns {number}
 */
export function imageryConfidence(verdicts, treatment) {
  if (!verdicts || verdicts.length === 0 || treatment === 'unknown') return 0;
  const t = IMAGERY_THRESHOLDS;
  let area = 0;
  let agreeing = 0;
  let total = 0;
  let margin = 0;
  for (const v of verdicts) {
    area += v.weight;
    total += v.weight;
    if (v.treatment === treatment) agreeing += v.weight;
    else if (v.treatment === 'mixed' || treatment === 'mixed') agreeing += v.weight / 2;
    margin += Math.abs(v.photographic - v.illustrative) * v.weight;
  }
  const sample = Math.min(1, area / t.sampleSaturationPx);
  const agreement = total > 0 ? agreeing / total : 0;
  const decisive = total > 0 ? Math.min(1, (margin / total) / 0.4) : 0;
  return round6(clamp01(0.35 * sample + 0.4 * agreement + 0.25 * decisive));
}

/**
 * Share of pixels that are painted at all.
 * @param {{width: number, height: number, data: Uint8Array}} image
 * @returns {number}
 */
export function opaqueShare(image) {
  const d = image.data;
  const n = image.width * image.height;
  if (n === 0) return 0;
  let opaque = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] >= 128) opaque += 1;
  return opaque / n;
}

/**
 * Linear ramp from 0 at `lo` to 1 at `hi`, clamped at both ends.
 * @param {number} value @param {number} lo @param {number} hi
 * @returns {number}
 */
export function ramp(value, lo, hi) {
  if (!(hi > lo)) return 0;
  return clamp01((value - lo) / (hi - lo));
}

/** @param {number} n @returns {number} */
function clamp01(n) { return Math.max(0, Math.min(1, n)); }
/** @param {number} n @returns {number} */
function round6(n) { return Math.round(n * 1e6) / 1e6; }
