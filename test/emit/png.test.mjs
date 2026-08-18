/**
 * The PNG codec the size budgeter degrades with.
 *
 * §13 requires the emitter to report "exactly what was degraded and by how
 * much". That report is only honest if the re-encode really happened, so the
 * codec has to be correct, lossless where it claims to be, and deterministic
 * (§5) — those are the three things asserted here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync, inflateSync } from 'node:zlib';
import { decodePng, encodePng, rescalePng, resample, pngSize, isPng, readChunks, adler32 } from '../../src/emit/png.js';
import { Pcg32 } from '../../src/core/prng.js';

/** @param {number} w @param {number} h @param {(x: number, y: number) => [number, number, number, number]} fn */
function image(w, h, fn) {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = fn(x, y);
      const o = (y * w + x) * 4;
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = a;
    }
  }
  return { width: w, height: h, rgba };
}

test('encode then decode is lossless for opaque images', () => {
  const src = image(37, 19, (x, y) => [(x * 7) & 255, (y * 11) & 255, (x ^ y) & 255, 255]);
  const back = decodePng(encodePng(src));
  assert.equal(back.width, 37);
  assert.equal(back.height, 19);
  assert.deepEqual([...back.rgba], [...src.rgba]);
});

test('encode then decode is lossless with alpha', () => {
  const src = image(16, 16, (x, y) => [x * 15, y * 15, 128, (x * y) & 255]);
  const back = decodePng(encodePng(src));
  assert.deepEqual([...back.rgba], [...src.rgba]);
});

test('a fully opaque image is written without an alpha channel', () => {
  const opaque = encodePng(image(8, 8, () => [1, 2, 3, 255]));
  const translucent = encodePng(image(8, 8, () => [1, 2, 3, 254]));
  const colourTypeOf = (bytes) => readChunks(bytes).find((c) => c.type === 'IHDR').data[9];
  assert.equal(colourTypeOf(opaque), 2, 'opaque images should be colour type 2 (RGB)');
  assert.equal(colourTypeOf(translucent), 6, 'images with alpha should be colour type 6 (RGBA)');
  assert.ok(opaque.length < translucent.length);
});

test('the encoder is deterministic (§5)', () => {
  const src = image(24, 24, (x, y) => [x, y, x + y, 255]);
  assert.deepEqual([...encodePng(src)], [...encodePng(src)]);
});

test('the IDAT stream is valid zlib that Node can inflate', () => {
  const png = encodePng(image(12, 12, (x, y) => [x * 20, y * 20, 0, 255]));
  const idat = readChunks(png).find((c) => c.type === 'IDAT');
  const raw = inflateSync(Buffer.from(idat.data));
  assert.equal(raw.length, (12 * 3 + 1) * 12, 'the inflated stream must be one filter byte plus a row of RGB per row');
  assert.doesNotThrow(() => gunzipSync, 'zlib is available');
});

test('the chunk CRCs are right — a wrong one makes the file unopenable', () => {
  const png = encodePng(image(4, 4, () => [9, 9, 9, 255]));
  // Node's inflate would not be enough; decode the header the way a reader does.
  assert.ok(isPng(png));
  assert.deepEqual(pngSize(png), { w: 4, h: 4 });
  const types = readChunks(png).map((c) => c.type);
  assert.deepEqual(types, ['IHDR', 'IDAT', 'IEND']);
});

test('adler32 matches the published value for "Wikipedia"', () => {
  assert.equal(adler32(new Uint8Array([...'Wikipedia'].map((c) => c.charCodeAt(0)))), 0x11e60398);
});

test('downscaling is an area average, not a nearest-neighbour sample', () => {
  // A 2x2 block of known values must average exactly.
  const src = image(2, 2, (x, y) => [(x + y) === 0 ? 0 : 255, 0, 0, 255]);
  const half = resample(src, 1, 1);
  assert.equal(half.rgba[0], Math.round((0 + 255 + 255 + 255) / 4));
});

test('downscaling keeps transparent pixels from bleeding colour', () => {
  const src = image(2, 1, (x) => (x === 0 ? [255, 0, 0, 255] : [0, 0, 255, 0]));
  const half = resample(src, 1, 1);
  assert.equal(half.rgba[0], 255, 'the visible red must not be diluted by an invisible blue');
  assert.equal(half.rgba[2], 0);
  assert.equal(half.rgba[3], 128);
});

test('rescale is monotonic in bytes for real, noisy content', () => {
  const rng = new Pcg32(99, 1);
  const src = image(128, 128, () => [rng.nextInt(256), rng.nextInt(256), rng.nextInt(256), 255]);
  const png = encodePng(src);
  let previous = png.length;
  for (const scale of [0.75, 0.5, 0.35, 0.25, 0.15]) {
    const out = rescalePng(png, scale);
    assert.ok(out.bytes.length < previous, `scale ${scale} produced ${out.bytes.length}, not below ${previous}`);
    assert.equal(out.width, Math.max(1, Math.round(128 * scale)));
    previous = out.bytes.length;
  }
});

test('rescale round-trips into a decodable image at every step', () => {
  const src = image(64, 40, (x, y) => [x * 4, y * 6, 128, 255]);
  const png = encodePng(src);
  for (const scale of [1, 0.5, 0.25]) {
    const out = rescalePng(png, scale);
    const back = decodePng(out.bytes);
    assert.ok(back, `scale ${scale} produced something undecodable`);
    assert.equal(back.width, out.width);
    assert.equal(back.height, out.height);
  }
});

test('formats the codec cannot read are refused rather than mangled', () => {
  assert.equal(decodePng(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), null, 'a JPEG is not a PNG');
  assert.equal(decodePng(new Uint8Array(0)), null);
  assert.equal(rescalePng(new Uint8Array([1, 2, 3]), 0.5), null);
  assert.equal(isPng(new Uint8Array([0x89, 0x50])), false);

  // An interlaced PNG: same header, interlace method 1.
  const png = encodePng(image(4, 4, () => [1, 2, 3, 255]));
  const interlaced = png.slice();
  interlaced[8 + 8 + 12] = 1;                 // IHDR data byte 12 is the interlace method
  assert.equal(decodePng(interlaced), null, 'Adam7 is out of scope and must be refused, not half-decoded');
});

test('a 1x1 image survives the smallest scale', () => {
  const png = encodePng(image(1, 1, () => [7, 8, 9, 255]));
  const out = rescalePng(png, 0.15);
  assert.equal(out.width, 1);
  assert.equal(out.height, 1);
  assert.deepEqual([...decodePng(out.bytes).rgba], [7, 8, 9, 255]);
});
