/**
 * Media capture — §8's "inline all media as data URIs, downscaled to a max edge
 * of 2400px, recompressed at the project's `imageQuality`".
 *
 * The PNG codec is checked against an **independent oracle**: PNGs are built in
 * this file with `node:zlib` and a hand-written filter, so the decoder is
 * never graded by the encoder that produced its input. The encoder is checked
 * the other way round — `zlib.inflateSync` must accept its IDAT and
 * `zlib.crc32` must agree with every chunk CRC.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { base64Decode, parseDataUri } from '../../src/core/bytes.js';
import { IdMinter } from '../../src/core/ids.js';
import { Pcg32 } from '../../src/core/prng.js';
import { imageInfo, jpegSize, svgSize, webpSize } from '../../src/specimen/imageinfo.js';
import { captureMedia, MAX_EDGE, paletteFor } from '../../src/specimen/media.js';
import { adler32, decodePng, encodePng, pngChunks, pngSize } from '../../src/specimen/png.js';
import { medianCut } from '../../src/specimen/quantize.js';
import { fitWithin, resizeRgba } from '../../src/specimen/resample.js';

// ---------------------------------------------------------------- oracle

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** @param {string} type @param {Buffer} data */
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * Build a PNG with `node:zlib`, filter type 0 on every scanline.
 * @param {{width: number, height: number, bitDepth: number, colorType: number,
 *          rows: number[][], plte?: number[], trns?: number[], interlace?: number}} spec
 */
function oraclePng(spec) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(spec.width, 0);
  ihdr.writeUInt32BE(spec.height, 4);
  ihdr[8] = spec.bitDepth;
  ihdr[9] = spec.colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = spec.interlace || 0;
  const raw = Buffer.concat(spec.rows.map((row) => Buffer.concat([Buffer.from([0]), Buffer.from(row)])));
  const parts = [SIG, chunk('IHDR', ihdr)];
  if (spec.plte) parts.push(chunk('PLTE', Buffer.from(spec.plte)));
  if (spec.trns) parts.push(chunk('tRNS', Buffer.from(spec.trns)));
  parts.push(chunk('IDAT', zlib.deflateSync(raw)));
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return new Uint8Array(Buffer.concat(parts));
}

/**
 * A flat-ish gradient: cheap to compress, and enough structure to prove a
 * resample did the right thing.
 * @param {number} w @param {number} h
 */
function gradientPixels(w, h) {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      rgba[o] = (x * 255 / Math.max(1, w - 1)) | 0;
      rgba[o + 1] = (y * 255 / Math.max(1, h - 1)) | 0;
      rgba[o + 2] = 128;
      rgba[o + 3] = 255;
    }
  }
  return rgba;
}

/** Deterministic pixels — §5 forbids `Math.random()` even in a test fixture. */
function samplePixels(w, h, seed = 'specimen/media') {
  const gen = new Pcg32(seed, 7n);
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      rgba[o] = (x * 255 / Math.max(1, w - 1)) | 0;
      rgba[o + 1] = (y * 255 / Math.max(1, h - 1)) | 0;
      rgba[o + 2] = gen.nextInt(256);
      rgba[o + 3] = 255;
    }
  }
  return rgba;
}

// ---------------------------------------------------------------- decoder

test('the decoder reads a PNG built by an independent oracle — truecolour, 8-bit', () => {
  const png = oraclePng({
    width: 2,
    height: 2,
    bitDepth: 8,
    colorType: 2,
    rows: [[255, 0, 0, 0, 255, 0], [0, 0, 255, 255, 255, 255]],
  });
  const out = decodePng(png);
  assert.deepEqual([out.width, out.height], [2, 2]);
  assert.deepEqual(Array.from(out.rgba), [
    255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 255, 255, 255, 255, 255, 255,
  ]);
  assert.equal(out.hasAlpha, false);
  assert.deepEqual(pngSize(png), { w: 2, h: 2 });
});

test('the decoder reads greyscale, greyscale+alpha and 16-bit samples', () => {
  const grey = decodePng(oraclePng({ width: 2, height: 1, bitDepth: 8, colorType: 0, rows: [[0, 255]] }));
  assert.deepEqual(Array.from(grey.rgba), [0, 0, 0, 255, 255, 255, 255, 255]);

  const greyAlpha = decodePng(oraclePng({ width: 2, height: 1, bitDepth: 8, colorType: 4, rows: [[16, 0, 200, 128]] }));
  assert.deepEqual(Array.from(greyAlpha.rgba), [16, 16, 16, 0, 200, 200, 200, 128]);

  const deep = decodePng(oraclePng({
    width: 1, height: 1, bitDepth: 16, colorType: 6, rows: [[0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xff, 0xff]],
  }));
  assert.deepEqual(Array.from(deep.rgba), [0x12, 0x56, 0x9a, 0xff], '16-bit samples reduce to their high byte');
});

test('the decoder reads sub-byte bit depths and palettes with transparency', () => {
  // 1-bit greyscale, 4 pixels in one byte (1010 0000).
  const oneBit = decodePng(oraclePng({ width: 4, height: 1, bitDepth: 1, colorType: 0, rows: [[0b10100000]] }));
  assert.deepEqual(Array.from(oneBit.rgba).filter((_, i) => i % 4 === 0), [255, 0, 255, 0]);

  // 4-bit palette with a transparent first entry.
  const palette = decodePng(oraclePng({
    width: 3,
    height: 1,
    bitDepth: 4,
    colorType: 3,
    rows: [[0x01, 0x20]],
    plte: [10, 20, 30, 40, 50, 60, 70, 80, 90],
    trns: [0, 255],
  }));
  assert.deepEqual(Array.from(palette.rgba), [10, 20, 30, 0, 40, 50, 60, 255, 70, 80, 90, 255]);
});

test('the decoder honours a truecolour transparency key and every filter type', () => {
  const keyed = decodePng(oraclePng({
    width: 2, height: 1, bitDepth: 8, colorType: 2, rows: [[1, 2, 3, 9, 9, 9]], trns: [0, 1, 0, 2, 0, 3],
  }));
  assert.deepEqual(Array.from(keyed.rgba), [1, 2, 3, 0, 9, 9, 9, 255]);

  // Filters 1..4 applied by hand over a known image, decoded back.
  const width = 4;
  const height = 5;
  const pixels = [];
  for (let y = 0; y < height; y++) {
    const row = [];
    for (let x = 0; x < width; x++) row.push((x * 40 + y * 7) & 255);
    pixels.push(row);
  }
  const filtered = [];
  for (let y = 0; y < height; y++) {
    const type = y % 5;
    const out = [type];
    for (let x = 0; x < width; x++) {
      const a = x > 0 ? pixels[y][x - 1] : 0;
      const b = y > 0 ? pixels[y - 1][x] : 0;
      const c = x > 0 && y > 0 ? pixels[y - 1][x - 1] : 0;
      let v;
      switch (type) {
        case 0: v = pixels[y][x]; break;
        case 1: v = pixels[y][x] - a; break;
        case 2: v = pixels[y][x] - b; break;
        case 3: v = pixels[y][x] - ((a + b) >> 1); break;
        default: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pred = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
          v = pixels[y][x] - pred;
        }
      }
      out.push(v & 255);
    }
    filtered.push(out.slice(1));
    filtered[filtered.length - 1].unshift(type);
  }
  const png = Buffer.concat([
    SIG,
    chunk('IHDR', (() => { const b = Buffer.alloc(13); b.writeUInt32BE(width, 0); b.writeUInt32BE(height, 4); b[8] = 8; b[9] = 0; return b; })()),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(filtered.map((r) => Buffer.from(r))))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  const decoded = decodePng(new Uint8Array(png));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      assert.equal(decoded.rgba[(y * width + x) * 4], pixels[y][x], `filter ${y % 5} at ${x},${y}`);
    }
  }
});

test('the decoder de-interlaces Adam7', () => {
  // A 4×4 image where each pixel's grey value is its index, written pass by
  // pass in Adam7 order.
  const width = 4;
  const height = 4;
  const value = (x, y) => y * 4 + x;
  const passes = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
  /** @type {number[][]} */
  const rows = [];
  for (const [xs, ys, xStep, yStep] of passes) {
    const pw = Math.ceil((width - xs) / xStep);
    const ph = Math.ceil((height - ys) / yStep);
    if (pw <= 0 || ph <= 0) continue;
    for (let y = 0; y < ph; y++) {
      const row = [];
      for (let x = 0; x < pw; x++) row.push(value(xs + x * xStep, ys + y * yStep));
      rows.push(row);
    }
  }
  const png = oraclePng({ width, height, bitDepth: 8, colorType: 0, rows, interlace: 1 });
  const out = decodePng(png);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      assert.equal(out.rgba[(y * width + x) * 4], value(x, y), `interlaced pixel ${x},${y}`);
    }
  }
});

// ---------------------------------------------------------------- encoder

test('a PNG round-trips through the encoder and decoder unchanged', () => {
  for (const [w, h] of [[1, 1], [7, 3], [64, 41]]) {
    const rgba = samplePixels(w, h);
    const png = encodePng(rgba, w, h);
    const back = decodePng(png);
    assert.equal(back.width, w);
    assert.equal(back.height, h);
    assert.deepEqual(Array.from(back.rgba), Array.from(rgba), `${w}×${h} round trip`);
  }
});

test('alpha survives the round trip, and an opaque image is encoded without an alpha channel', () => {
  const rgba = new Uint8Array([255, 0, 0, 0, 0, 255, 0, 128, 0, 0, 255, 255, 9, 9, 9, 1]);
  const png = encodePng(rgba, 2, 2);
  const back = decodePng(png);
  assert.deepEqual(Array.from(back.rgba), Array.from(rgba));
  assert.equal(back.colorType, 6);

  const opaque = encodePng(new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]), 2, 1);
  assert.equal(decodePng(opaque).colorType, 2, 'no alpha channel is written when nothing is transparent');
});

test('the encoder writes a valid zlib stream and correct CRCs, judged by node:zlib', () => {
  const rgba = samplePixels(20, 12);
  const png = encodePng(rgba, 20, 12);
  const chunks = pngChunks(png);
  assert.deepEqual(chunks.map((c) => c.type), ['IHDR', 'IDAT', 'IEND']);

  const idat = Buffer.from(chunks.find((c) => c.type === 'IDAT').data);
  const inflated = zlib.inflateSync(idat);
  assert.equal(inflated.length, 12 * (1 + 20 * 3), 'one filter byte plus RGB samples per row');
  assert.equal(adler32(new Uint8Array(inflated)), idat.readUInt32BE(idat.length - 4), 'the zlib checksum is the real one');

  // Every chunk CRC, recomputed by zlib.
  let i = 8;
  while (i < png.length) {
    const len = Buffer.from(png.buffer, png.byteOffset + i, 4).readUInt32BE(0);
    const body = Buffer.from(png.buffer, png.byteOffset + i + 4, 4 + len);
    const stored = Buffer.from(png.buffer, png.byteOffset + i + 8 + len, 4).readUInt32BE(0);
    assert.equal(zlib.crc32(body), stored, `CRC of ${body.subarray(0, 4).toString('latin1')}`);
    i += 12 + len;
  }
});

test('encoding is deterministic — the same pixels always produce the same bytes', () => {
  const rgba = samplePixels(33, 17);
  assert.deepEqual(Array.from(encodePng(rgba, 33, 17)), Array.from(encodePng(rgba.slice(), 33, 17)));
});

// ---------------------------------------------------------------- resampling

test('the box filter averages exactly, and preserves aspect ratio arithmetic', () => {
  const rgba = new Uint8Array([
    0, 0, 0, 255, 100, 100, 100, 255,
    200, 200, 200, 255, 255, 255, 255, 255,
  ]);
  const half = resizeRgba(rgba, 2, 2, 1, 1);
  assert.deepEqual(Array.from(half), [139, 139, 139, 255], 'the mean of 0, 100, 200 and 255');

  assert.deepEqual(fitWithin(3000, 1500, 2400), { w: 2400, h: 1200, scaled: true });
  assert.deepEqual(fitWithin(1500, 3000, 2400), { w: 1200, h: 2400, scaled: true });
  assert.deepEqual(fitWithin(800, 600, 2400), { w: 800, h: 600, scaled: false });
  assert.deepEqual(fitWithin(2401, 1, 2400), { w: 2400, h: 1, scaled: true });
});

test('fully transparent pixels do not bleed colour into their neighbours', () => {
  // Opaque white beside transparent black: premultiplied filtering must give
  // white at half alpha, not grey.
  const rgba = new Uint8Array([255, 255, 255, 255, 0, 0, 0, 0]);
  const out = resizeRgba(rgba, 2, 1, 1, 1);
  assert.deepEqual(Array.from(out), [255, 255, 255, 128]);
});

test('resampling is deterministic and lands on the requested size', () => {
  const rgba = samplePixels(97, 61);
  const a = resizeRgba(rgba, 97, 61, 33, 21);
  const b = resizeRgba(rgba, 97, 61, 33, 21);
  assert.deepEqual(Array.from(a), Array.from(b));
  assert.equal(a.length, 33 * 21 * 4);
});

// ---------------------------------------------------------------- capture

test('§8 a PNG over 2400px is downscaled to a max edge of 2400, with accurate intrinsic and bytes', () => {
  const w = 2600;
  const h = 1300;
  const png = encodePng(gradientPixels(w, h), w, h);
  const [ref] = captureMedia([{ name: 'hero.png', bytes: png, mime: 'image/png' }], { imageQuality: 0.85 });

  assert.deepEqual(ref.intrinsic, { w: 2400, h: 1200 });
  assert.equal(Math.round((2400 / 2600) * 1300), 1200, 'the aspect ratio is preserved by construction');
  assert.equal(ref.resized, true);
  assert.deepEqual(ref.originalIntrinsic, { w: 2600, h: 1300 });
  assert.equal(ref.needsDownscale, false);

  const parsed = parseDataUri(ref.dataUri);
  assert.equal(parsed.mime, 'image/png');
  assert.equal(ref.bytes, parsed.bytes, 'bytes is the real byte count of what was inlined');
  const decoded = decodePng(base64Decode(parsed.body));
  assert.deepEqual([decoded.width, decoded.height], [2400, 1200], 'intrinsic describes the inlined image');
});

test('capture is deterministic across runs', () => {
  const png = encodePng(samplePixels(200, 150), 200, 150);
  const asset = { name: 'a.png', bytes: png, mime: 'image/png' };
  const one = captureMedia([asset], { imageQuality: 0.75, idMinter: new IdMinter('seed', 'specimen/media') });
  const two = captureMedia([asset], { imageQuality: 0.75, idMinter: new IdMinter('seed', 'specimen/media') });
  assert.deepEqual(one, two);
  assert.ok(one[0].id.startsWith('md_'));

  const noMinter = captureMedia([asset], { imageQuality: 0.75 });
  assert.deepEqual(noMinter[0].id, captureMedia([asset], { imageQuality: 0.75 })[0].id,
    'without a minter the id is content-derived and still stable');
});

test('imageQuality is a real lever on PNG: lower tiers quantise the palette and save bytes', () => {
  const png = encodePng(samplePixels(240, 160), 240, 160);
  const at = (q) => captureMedia([{ name: 'p.png', bytes: png, mime: 'image/png' }], { imageQuality: q })[0];
  const best = at(0.92);
  const mid = at(0.75);
  const low = at(0.6);

  assert.equal(paletteFor(0.92), 0);
  assert.equal(paletteFor(0.85), 0);
  assert.equal(paletteFor(0.75), 256);
  assert.equal(paletteFor(0.6), 64);
  assert.ok(mid.bytes < best.bytes, `0.75 (${mid.bytes}) should be smaller than 0.92 (${best.bytes})`);
  assert.ok(low.bytes < mid.bytes, `0.6 (${low.bytes}) should be smaller than 0.75 (${mid.bytes})`);
  assert.ok(low.notes.some((n) => n.startsWith('palette:')), 'the degradation is reported');

  // And the quantised image still decodes at the right size.
  const decoded = decodePng(base64Decode(parseDataUri(low.dataUri).body));
  assert.deepEqual([decoded.width, decoded.height], [240, 160]);
});

test('median cut is deterministic and exact when the image has few colours', () => {
  const rgba = new Uint8Array([1, 1, 1, 255, 2, 2, 2, 255, 1, 1, 1, 255, 3, 3, 3, 255]);
  const a = medianCut(rgba, 64);
  const b = medianCut(rgba.slice(), 64);
  assert.equal(a.exact, true);
  assert.equal(a.colors.length, 3);
  assert.deepEqual(a.colors, b.colors);
  assert.deepEqual(Array.from(a.indices), Array.from(b.indices));

  const many = medianCut(samplePixels(64, 64), 16);
  assert.ok(many.colors.length <= 16);
  assert.equal(many.indices.length, 64 * 64);
});

test('§8 a JPEG is passed through unchanged and reported as not resized, so L10 can budget it', () => {
  const jpeg = fakeJpeg(4000, 3000);
  assert.deepEqual(jpegSize(jpeg), { w: 4000, h: 3000 });

  const [ref] = captureMedia([{ name: 'photo.jpg', bytes: jpeg, mime: 'image/jpeg' }], { imageQuality: 0.6 });
  assert.equal(ref.format, 'jpeg');
  assert.deepEqual(ref.intrinsic, { w: 4000, h: 3000 }, 'intrinsic is the real size, not a guess');
  assert.equal(ref.resized, false);
  assert.equal(ref.recompressed, false);
  assert.equal(ref.needsDownscale, true, 'the emitter is told this asset is still over budget');
  assert.equal(ref.resizeSkipped, 'jpeg-no-encoder');
  assert.equal(ref.bytes, jpeg.length, 'the bytes are the original bytes');
  assert.deepEqual(Array.from(base64Decode(parseDataUri(ref.dataUri).body)), Array.from(jpeg));
  assert.equal(parseDataUri(ref.dataUri).mime, 'image/jpeg');
  assert.equal(ref.quality, null, 'no quality is claimed for an image that was not recompressed');
});

test('GIF, WebP, BMP and SVG dimensions are read from the bytes', () => {
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xf0, 0x00, 0, 0, 0]);
  assert.deepEqual(imageInfo(gif), { format: 'gif', mime: 'image/gif', w: 320, h: 240, known: true });

  const webp = fakeWebpVp8(800, 600);
  assert.deepEqual(webpSize(webp), { w: 800, h: 600 });
  assert.equal(imageInfo(webp).format, 'webp');

  const bmp = new Uint8Array(30);
  bmp[0] = 0x42; bmp[1] = 0x4d;
  new DataView(bmp.buffer).setInt32(18, 640, true);
  new DataView(bmp.buffer).setInt32(22, -480, true);
  assert.deepEqual(imageInfo(bmp), { format: 'bmp', mime: 'image/bmp', w: 640, h: 480, known: true });

  assert.deepEqual(svgSize('<svg width="120" height="60"></svg>'), { w: 120, h: 60, known: true });
  assert.deepEqual(svgSize('<svg viewBox="0 0 24 24"></svg>'), { w: 24, h: 24, known: true });
  assert.equal(svgSize('<svg></svg>').known, false);
});

test('an SVG is inlined as text, with scripts and external references flagged for the emitter', () => {
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 24">'
    + '<script>fetch("https://tracker.example/beacon")</script>'
    + '<image href="https://cdn.example/logo.png"/></svg>');
  const [ref] = captureMedia([{ name: 'logo.svg', bytes: svg, mime: 'image/svg+xml' }], { imageQuality: 0.85 });
  assert.equal(ref.format, 'svg');
  assert.deepEqual(ref.intrinsic, { w: 48, h: 24 });
  assert.ok(ref.notes.includes('svg:script'));
  assert.ok(ref.notes.includes('svg:external-reference'));
  assert.equal(ref.bytes, svg.length);
});

test('identical assets collapse to one MediaRef that remembers every name it arrived under', () => {
  const png = encodePng(samplePixels(8, 8), 8, 8);
  const refs = captureMedia([
    { name: 'hero.png', src: '/img/hero.png', bytes: png, mime: 'image/png' },
    { name: 'hero-copy.png', src: '/img/hero-copy.png', bytes: png, mime: 'image/png' },
  ], { imageQuality: 0.85 });
  assert.equal(refs.length, 1);
  assert.deepEqual(refs[0].sources.sort(), ['/img/hero-copy.png', '/img/hero.png', 'hero-copy.png', 'hero.png'].sort());
});

test('bytes that are not an image are skipped rather than given invented dimensions', () => {
  const refs = captureMedia([
    { name: 'notes.txt', bytes: new TextEncoder().encode('this is not an image'), mime: 'text/plain' },
    { name: 'empty.png', bytes: new Uint8Array(0), mime: 'image/png' },
  ], { imageQuality: 0.85 });
  assert.deepEqual(refs, []);
});

test('alt text rides along with the asset', () => {
  const png = encodePng(samplePixels(4, 4), 4, 4);
  const [withAlt] = captureMedia([{ name: 'a.png', bytes: png, alt: 'A controller in a panel' }], { imageQuality: 0.85 });
  assert.equal(withAlt.alt, 'A controller in a panel');
  const [without] = captureMedia([{ name: 'b.png', bytes: encodePng(samplePixels(4, 4, 'other'), 4, 4) }], { imageQuality: 0.85 });
  assert.equal(without.alt, null, 'alt is null, never an empty string standing in for one');
});

test('MAX_EDGE is the §8 constant', () => {
  assert.equal(MAX_EDGE, 2400);
});

// ---------------------------------------------------------------- helpers

/** A JPEG header with a real SOF0 frame — enough to read a size from. */
function fakeJpeg(w, h) {
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255, 3,
    1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof, 0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 63, 0, 0xff, 0xd9]);
}

/** A lossy WebP container with a VP8 key-frame header. */
function fakeWebpVp8(w, h) {
  const body = [0x9d, 0x01, 0x2a, w & 255, (w >> 8) & 0x3f, h & 255, (h >> 8) & 0x3f];
  const vp8 = [0, 0, 0, ...body];
  const bytes = new Uint8Array(12 + 8 + vp8.length);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  view.setUint32(4, bytes.length - 8, true);
  bytes.set(new TextEncoder().encode('WEBP'), 8);
  bytes.set(new TextEncoder().encode('VP8 '), 12);
  view.setUint32(16, vp8.length, true);
  bytes.set(vp8, 20);
  return bytes;
}
