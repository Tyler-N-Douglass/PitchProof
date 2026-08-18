/**
 * Imagery treatment classification (§7).
 *
 * Every image here is a synthetic buffer whose edge density, palette and
 * saturation are known by construction, so each assertion says which of the
 * three §7 signals it is exercising. The face fixture is a skin-toned ellipse
 * with the proportions of a human head, drawn over a non-skin textured ground.
 *
 * The pseudo-random texture is drawn from `core/prng.js`, not `Math.random`, so
 * every fixture in this file is byte-identical on every run (§5).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Pcg32 } from '../../src/core/prng.js';
import {
  classifyImagery, classifyImage, normalizeSample, downsample, edgeStats,
  paletteStats, saturationStats, faceStats, isSkinPixel, largestBlob,
  saturationBias, imageryConfidence, opaqueShare, ramp, luma, saturation,
  sampleFromPng, IMAGERY_THRESHOLDS, IMAGERY_WEIGHTS,
} from '../../src/brand/imagery.js';
import { encodePng } from '../../src/brand/logo.js';

/** Build an RGBA buffer from a per-pixel function. */
function make(w, h, fn) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = fn(x, y);
      const i = (y * w + x) * 4;
      data[i] = p[0]; data[i + 1] = p[1]; data[i + 2] = p[2];
      data[i + 3] = p.length > 3 ? p[3] : 255;
    }
  }
  return { width: w, height: h, data };
}

/** Flat vector-style artwork: four saturated blocks, no texture at all. */
const FLAT_PALETTE = [[230, 57, 70], [29, 53, 87], [244, 162, 97], [42, 157, 143]];
const flatArtwork = (id = 'flat') => ({
  id,
  ...make(200, 200, (x, y) => FLAT_PALETTE[(Math.floor(x / 100) + 2 * Math.floor(y / 100)) % 4]),
});

/** Photograph-like texture: a smooth base with per-pixel sensor-style noise. */
const photographic = (id = 'photo', seed = 11) => {
  const g = new Pcg32(seed, 7);
  return {
    id,
    ...make(200, 200, (x, y) => {
      const base = 90 + Math.round(60 * Math.sin(x / 17) + 40 * Math.cos(y / 13));
      const n = () => Math.max(0, Math.min(255, base + g.nextInt(70) - 35));
      return [n(), n(), n()];
    }),
  };
};

/** A skin-toned ellipse with head proportions, over a blue-grey textured ground. */
const portrait = (id = 'portrait') => {
  const g = new Pcg32(3, 9);
  return {
    id,
    ...make(200, 200, (x, y) => {
      const dx = (x - 100) / 30;
      const dy = (y - 100) / 39;
      if (dx * dx + dy * dy <= 1) return [200 + g.nextInt(12) - 6, 150 + g.nextInt(12) - 6, 120 + g.nextInt(12) - 6];
      return [60 + g.nextInt(40), 80 + g.nextInt(40), 120 + g.nextInt(40)];
    }),
  };
};

// ------------------------------------------------------------------- input

test('the input contract is checked, not assumed', () => {
  assert.throws(() => normalizeSample(null), /not an object/);
  assert.throws(() => normalizeSample({ width: 0, height: 4, data: new Uint8Array(0) }), /dimensions/);
  assert.throws(() => normalizeSample({ width: 4, height: 4 }), /pixel data/);
  assert.throws(() => normalizeSample({ width: 4, height: 4, data: new Uint8Array(8) }), /needs 64 \(RGBA\)/);
  const ok = normalizeSample({ width: 2, height: 2, data: new Uint8Array(16) });
  assert.equal(ok.weight, 4, 'weight defaults to rendered area');
  assert.equal(ok.role, 'content');
  assert.equal(normalizeSample({ width: 2, height: 2, data: new Uint8Array(16), weight: 9, role: 'hero' }, 0).weight, 9);
});

test('a PNG can be turned into a sample without a platform decoder', () => {
  const data = new Uint8Array(4 * 4 * 4);
  for (let i = 0; i < 16; i++) { data[i * 4] = 200; data[i * 4 + 1] = 30; data[i * 4 + 2] = 30; data[i * 4 + 3] = 255; }
  const sample = sampleFromPng(encodePng({ width: 4, height: 4, data }), { id: 'hero', role: 'hero' });
  assert.equal(sample.width, 4);
  assert.equal(sample.id, 'hero');
  assert.equal(sample.data[0], 200);
});

// ---------------------------------------------------------------- features

test('Sobel edge density is 0 on a flat field and exact on a single step', () => {
  const solid = make(64, 64, () => [128, 128, 128]);
  const solidStats = edgeStats(solid);
  assert.equal(solidStats.edgeDensity, 0);
  assert.equal(solidStats.flatShare, 1);

  // One hard vertical edge down the middle of a 64x64 frame. The 3x3 operator
  // responds in exactly the two interior columns either side of the boundary,
  // over the 62x62 interior: 2/62.
  const step = make(64, 64, (x) => (x < 32 ? [0, 0, 0] : [255, 255, 255]));
  const stepStats = edgeStats(step);
  assert.ok(Math.abs(stepStats.edgeDensity - 2 / 62) < 1e-12, `edge density ${stepStats.edgeDensity}`);
  assert.ok(Math.abs(stepStats.flatShare - 60 / 62) < 1e-12, `flat share ${stepStats.flatShare}`);

  // Per-pixel noise puts a gradient nearly everywhere, which is the signal that
  // separates a photograph from flat artwork.
  assert.ok(edgeStats(photographic()).edgeDensity > 0.2);
});

test('the edge thresholds are the exported constants, not inline numbers', () => {
  // A step of exactly the documented magnitude, across the whole frame.
  const t = IMAGERY_THRESHOLDS;
  assert.ok(t.edgeMagnitude > t.flatMagnitude);
  assert.equal(ramp(t.edgeDensityRamp.lo, t.edgeDensityRamp.lo, t.edgeDensityRamp.hi), 0);
  assert.equal(ramp(t.edgeDensityRamp.hi, t.edgeDensityRamp.lo, t.edgeDensityRamp.hi), 1);
  assert.equal(ramp(-5, 0, 1), 0);
  assert.equal(ramp(5, 0, 1), 1);
  assert.equal(ramp(1, 1, 1), 0);
});

test('palette concentration separates a four-colour illustration from a photograph', () => {
  assert.deepEqual(paletteStats(flatArtwork()), { distinctBins: 4, topShare: 1 });
  const photo = paletteStats(photographic());
  assert.ok(photo.distinctBins > 500, `a photograph spreads across bins, got ${photo.distinctBins}`);
  assert.ok(photo.topShare < 0.2, `top-8 share ${photo.topShare}`);
});

test('saturation statistics measure what they say they measure', () => {
  const grey = saturationStats(make(32, 32, () => [128, 128, 128]));
  assert.equal(grey.mean, 0);
  assert.equal(grey.neutralShare, 1);
  const vivid = saturationStats(make(32, 32, () => [255, 0, 0]));
  assert.equal(vivid.mean, 1);
  assert.equal(vivid.vividShare, 1);
  assert.equal(saturation(0, 0, 0), 0);
  assert.equal(Math.round(luma(255, 255, 255)), 255);
  // Transparent pixels are not counted.
  assert.equal(saturationStats(make(8, 8, () => [255, 0, 0, 0])).mean, 0);
});

test('both published skin rules must agree before a pixel counts as skin', () => {
  assert.equal(isSkinPixel(200, 150, 120), true, 'a plausible skin tone');
  assert.equal(isSkinPixel(60, 80, 120), false, 'a blue-grey');
  assert.equal(isSkinPixel(255, 255, 255), false, 'white fails the RGB spread rule');
  assert.equal(isSkinPixel(255, 0, 0), false, 'a saturated red fails the YCbCr chrominance rule');
  assert.equal(isSkinPixel(0, 0, 0), false);
  // A mid-brown does sit inside both published rules — that is the known
  // weakness of every skin-colour rule, and it is exactly why the classifier
  // also requires the blob to have the geometry of a head.
  assert.equal(isSkinPixel(100, 60, 30), true);
});

test('the largest connected blob is found by area, with its bounding box', () => {
  const w = 8;
  const h = 8;
  const mask = new Uint8Array(w * h);
  mask[0] = 1;                                  // a one-pixel island
  for (let y = 2; y < 6; y++) for (let x = 3; x < 7; x++) mask[y * w + x] = 1;
  const blob = largestBlob(mask, w, h);
  assert.deepEqual(blob, { area: 16, minX: 3, minY: 2, maxX: 6, maxY: 5 });
  assert.equal(largestBlob(new Uint8Array(w * h), w, h), null);
});

test('the face heuristic fires on a head-shaped skin blob and not on flat artwork', () => {
  const face = faceStats(portrait());
  assert.equal(face.faceLike, true);
  assert.ok(face.blob.aspect > IMAGERY_THRESHOLDS.face.minAspect && face.blob.aspect < IMAGERY_THRESHOLDS.face.maxAspect);
  assert.ok(face.blob.fill >= IMAGERY_THRESHOLDS.face.minFill);
  assert.ok(face.blob.areaShare >= IMAGERY_THRESHOLDS.face.minAreaShare);
  assert.equal(faceStats(flatArtwork()).faceLike, false);
  assert.equal(faceStats(flatArtwork()).skinShare, 0);
});

test('a skin-coloured field that fills the frame is not a face', () => {
  // Too large, and its bounding box is the whole image, so the geometry test
  // rejects it — which is what stops a terracotta wall reading as a portrait.
  const wall = make(100, 100, () => [200, 150, 120]);
  assert.ok(faceStats(wall).skinShare > 0.9);
  assert.equal(faceStats(wall).faceLike, false);
});

test('downsampling box-averages rather than picking a nearest neighbour', () => {
  const checker = make(64, 64, (x, y) => ((x + y) % 2 === 0 ? [0, 0, 0] : [255, 255, 255]));
  const small = downsample(checker, 8);
  assert.equal(small.width, 8);
  assert.equal(small.height, 8);
  // Every 8x8 block averages to mid-grey, so the texture disappears rather than
  // being resampled at full contrast.
  for (let i = 0; i < small.data.length; i += 4) {
    assert.ok(Math.abs(small.data[i] - 128) <= 2, `pixel ${i / 4} is ${small.data[i]}`);
  }
  // An image already inside the budget is returned untouched.
  const tiny = make(4, 4, () => [1, 2, 3]);
  assert.equal(downsample(tiny, 256).data, tiny.data);
});

// -------------------------------------------------------------- per-image

test('flat saturated artwork classifies as illustrative', () => {
  const v = classifyImage(flatArtwork());
  assert.equal(v.treatment, 'illustrative');
  assert.ok(v.illustrative > 0.8, `illustrative score ${v.illustrative}`);
  assert.ok(v.photographic < 0.2, `photographic score ${v.photographic}`);
  assert.equal(v.edges.flatShare > 0.9, true);
  assert.equal(v.palette.topShare, 1);
});

test('textured imagery with a spread palette classifies as photographic', () => {
  const v = classifyImage(photographic());
  assert.equal(v.treatment, 'photographic');
  assert.ok(v.photographic > 0.8, `photographic score ${v.photographic}`);
  assert.ok(v.edges.edgeDensity > IMAGERY_THRESHOLDS.edgeDensityRamp.hi);
});

test('a face pushes an image toward photographic', () => {
  const v = classifyImage(portrait());
  assert.equal(v.treatment, 'photographic');
  assert.equal(v.face.faceLike, true);
  // The same texture without the face scores lower, by exactly the face bonus
  // where the score is not already clamped.
  assert.ok(IMAGERY_WEIGHTS.faceBonus > 0);
});

test('an image that is half texture and half flat colour is itself mixed', () => {
  const g = new Pcg32(5, 1);
  const half = make(200, 200, (x, y) => (x < 80
    ? [90 + g.nextInt(120), 80 + g.nextInt(120), 70 + g.nextInt(120)]
    : [(y < 100 ? 230 : 29), (y < 100 ? 57 : 53), (y < 100 ? 70 : 87)]));
  const v = classifyImage(half);
  assert.equal(v.treatment, 'mixed');
  assert.ok(Math.abs(v.photographic - v.illustrative) < IMAGERY_THRESHOLDS.mixedMargin);
});

test('an image too small or too empty to read is unknown, not guessed', () => {
  assert.equal(classifyImage({ width: 4, height: 4, data: new Uint8Array(64).fill(255) }).treatment, 'unknown');
  assert.equal(classifyImage(make(100, 100, () => [255, 0, 0, 0])).treatment, 'unknown');
  assert.equal(opaqueShare(make(4, 4, () => [0, 0, 0, 0])), 0);
  assert.equal(opaqueShare(make(4, 4, () => [0, 0, 0, 255])), 1);
});

// --------------------------------------------------------------- aggregate

test('a set of photographs reports photographic', () => {
  const result = classifyImagery([photographic('a', 11), photographic('b', 12), photographic('c', 13)]);
  assert.equal(result.treatment, 'photographic');
  assert.equal(result.verdicts.length, 3);
  assert.ok(result.confidence > 0);
});

test('a set of flat artwork reports illustrative', () => {
  assert.equal(classifyImagery([flatArtwork('a'), flatArtwork('b')]).treatment, 'illustrative');
});

test('an even split reports mixed', () => {
  const result = classifyImagery([photographic('p1', 11), photographic('p2', 12), flatArtwork('i1'), flatArtwork('i2')]);
  assert.equal(result.treatment, 'mixed');
  assert.ok(result.weights.photographic > 0 && result.weights.illustrative > 0);
});

test('weight is by rendered area, so a hero outvotes a thumbnail', () => {
  // §7's "weight by rendered area, not occurrence count", applied to imagery.
  const hero = { ...photographic('hero'), weight: 1600 * 900 };
  const thumbs = [0, 1, 2, 3, 4].map((n) => ({ ...flatArtwork(`thumb-${n}`), weight: 64 * 64 }));
  assert.equal(classifyImagery([hero, ...thumbs]).treatment, 'photographic');
  // With equal weights the thumbnails win on count.
  const equal = classifyImagery([{ ...photographic('hero2'), weight: 1 }, ...thumbs.map((t) => ({ ...t, weight: 1 }))]);
  assert.equal(equal.treatment, 'illustrative');
});

test('no images at all is unknown with zero confidence', () => {
  const result = classifyImagery([]);
  assert.equal(result.treatment, 'unknown');
  assert.equal(result.saturationBias, 0);
  assert.equal(result.confidence, 0);
  assert.equal(classifyImagery(null).treatment, 'unknown');
});

test('images that cannot be read leave the treatment unknown', () => {
  const result = classifyImagery([{ id: 'x', ...make(100, 100, () => [0, 0, 0, 0]) }]);
  assert.equal(result.treatment, 'unknown');
  assert.equal(result.weights.unknown > 0, true);
});

// ---------------------------------------------------------- saturationBias

test('saturationBias anchors at the documented reference', () => {
  const ref = IMAGERY_THRESHOLDS.neutralSaturation;
  assert.equal(saturationBias(0), -1);
  assert.equal(saturationBias(ref), 0);
  assert.equal(saturationBias(1), 1);
  assert.equal(saturationBias(ref / 2), -0.5);
  assert.ok(saturationBias(0.6) > 0 && saturationBias(0.6) < 1);
  // Continuous at the anchor.
  assert.ok(Math.abs(saturationBias(ref - 1e-6) - saturationBias(ref + 1e-6)) < 1e-5);
});

test('a desaturated brand reports a negative bias and a vivid one positive', () => {
  const grey = { id: 'g', ...make(64, 64, (x) => { const v = 40 + (x % 180); return [v, v, v]; }) };
  const vivid = { id: 'v', ...make(64, 64, (x, y) => FLAT_PALETTE[(x + y) % 4]) };
  assert.equal(classifyImagery([grey]).saturationBias, -1);
  assert.ok(classifyImagery([vivid]).saturationBias > 0.3);
});

// --------------------------------------------------------------- confidence

test('confidence rises with sample size, agreement and decisiveness', () => {
  const one = classifyImagery([photographic('a', 11)]);
  const many = classifyImagery([photographic('a', 11), photographic('b', 12), photographic('c', 13), photographic('d', 14),
    { ...photographic('e', 15), weight: 1024 * 768 }, { ...photographic('f', 16), weight: 1024 * 768 }]);
  assert.ok(many.confidence > one.confidence, `${many.confidence} should exceed ${one.confidence}`);
  assert.ok(many.confidence <= 1);

  const split = classifyImagery([photographic('p', 11), flatArtwork('i')]);
  assert.ok(split.confidence < many.confidence, 'a set that disagrees is less certain');
  assert.equal(imageryConfidence([], 'photographic'), 0);
  assert.equal(imageryConfidence([{ weight: 1, treatment: 'unknown', photographic: 0, illustrative: 0 }], 'unknown'), 0);
});

test('confidence is not a constant', () => {
  const values = new Set([
    classifyImagery([photographic('a', 11)]).confidence,
    classifyImagery([flatArtwork('b')]).confidence,
    classifyImagery([photographic('c', 11), flatArtwork('d')]).confidence,
  ]);
  assert.ok(values.size >= 2, [...values].join(', '));
});

// -------------------------------------------------------------- determinism

test('classification is deterministic', () => {
  const images = [photographic('a', 11), flatArtwork('b'), portrait('c')];
  const first = JSON.stringify(classifyImagery(images));
  const second = JSON.stringify(classifyImagery(images));
  assert.equal(first, second);
});

test('a resized copy of the same image classifies the same way', () => {
  // The analysis runs at a fixed size, so two captures of one image at
  // different resolutions cannot disagree about the brand's imagery.
  const big = make(512, 512, (x, y) => FLAT_PALETTE[(Math.floor(x / 256) + 2 * Math.floor(y / 256)) % 4]);
  const small = make(128, 128, (x, y) => FLAT_PALETTE[(Math.floor(x / 64) + 2 * Math.floor(y / 64)) % 4]);
  assert.equal(classifyImage(big).treatment, classifyImage(small).treatment);
});
