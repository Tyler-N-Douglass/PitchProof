/**
 * DEFLATE at artifact scale.
 *
 * `primitives.test.mjs` fuzzes the codec up to nine kilobytes, which proves the
 * Huffman and match logic but says nothing about the sizes an artifact actually
 * carries. A proof with real media is measured in megabytes, and the failures
 * that appear only at that scale — a window that wraps, a block boundary that
 * lands mid-match, a stored-block fallback that never engages — would surface as
 * a corrupt artifact on a client's laptop rather than as a test failure.
 *
 * Sizes here are kept to roughly a megabyte so the suite stays fast. The full
 * multi-megabyte sweep was run once against every case below and is reproduced
 * by raising `SCALE`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { deflateRaw } from '../../src/core/deflate.js';
import { inflateRaw } from '../../src/core/inflate.js';
import { Pcg32 } from '../../src/core/prng.js';
import { utf8Encode } from '../../src/core/bytes.js';

/** Raise to re-run the sweep at the sizes an artifact really reaches. */
const SCALE = 1;

/**
 * @param {Uint8Array} bytes
 * @param {string} label
 * @returns {{ours: number, zlib9: number}}
 */
function roundTrip(bytes, label) {
  const out = deflateRaw(bytes);
  const back = inflateRaw(out, bytes.length);
  assert.equal(back.length, bytes.length, `${label}: inflated length`);
  // A byte-by-byte loop rather than deepEqual: on a megabyte input the
  // assertion library's diff is the slowest thing in the suite.
  let firstBad = -1;
  for (let i = 0; i < bytes.length; i++) {
    if (back[i] !== bytes[i]) { firstBad = i; break; }
  }
  assert.equal(firstBad, -1, `${label}: first mismatch at byte ${firstBad}`);
  assert.equal(
    Buffer.compare(Buffer.from(zlib.inflateRawSync(Buffer.from(out))), Buffer.from(bytes)),
    0,
    `${label}: zlib must inflate our output`,
  );
  return { ours: out.length, zlib9: zlib.deflateRawSync(Buffer.from(bytes), { level: 9 }).length };
}

test('a large model payload round-trips and beats zlib level 9', () => {
  const spine = Array.from({ length: 400 }, (_, i) => ({
    id: `sc_${i.toString(16).padStart(12, '0')}`,
    layout: 'splitBeforeAfter',
    headline: `Scene ${i}: the same content, assembled from design-system components`,
    beats: Array.from({ length: 4 }, (_, b) => ({
      id: `bt_${i}_${b}`,
      reveals: [`el_${i}_${b}`],
      presenterNote: b === 0 ? 'Open by naming the problem in their words.' : null,
      dwellHintMs: null,
    })),
  }));
  const bytes = utf8Encode(JSON.stringify({ spine }));
  assert.ok(bytes.length > 200_000, 'the fixture must be big enough to matter');
  const { ours, zlib9 } = roundTrip(bytes, 'model JSON');
  assert.ok(ours < zlib9, `ours ${ours} should beat zlib9 ${zlib9} on model JSON`);
});

test('incompressible data falls back to stored blocks with bounded overhead', () => {
  const n = 800_000 * SCALE;
  const g = new Pcg32('deflate-scale-noise');
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) bytes[i] = g.nextInt(256);
  const { ours, zlib9 } = roundTrip(bytes, 'incompressible');
  // Stored blocks cost five bytes of header per block. Anything much above
  // that means the compressor is emitting Huffman trees for random data.
  assert.ok(ours < n * 1.0005 + 64, `stored-block overhead too high: ${ours - n} bytes over ${n}`);
  assert.ok(ours <= zlib9, `ours ${ours} should be no worse than zlib9 ${zlib9} on noise`);
});

test('matches carry across the 32KB window on highly repetitive input', () => {
  const n = 1_000_000 * SCALE;
  const bytes = new Uint8Array(n).fill(65);
  const { ours, zlib9 } = roundTrip(bytes, 'all-one-byte');
  assert.ok(ours < n / 500, `a megabyte of one byte should collapse: got ${ours}`);
  assert.ok(ours <= zlib9 + 8, `ours ${ours} vs zlib9 ${zlib9}`);
});

test('long-range periodic structure compresses and round-trips', () => {
  const n = 900_000 * SCALE;
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) bytes[i] = 32 + ((i * 7) % 90);
  const { ours, zlib9 } = roundTrip(bytes, 'periodic');
  assert.ok(ours < n / 100, `periodic data should collapse: got ${ours}`);
  assert.ok(ours <= zlib9 + 8, `ours ${ours} vs zlib9 ${zlib9}`);
});

test('block and window boundaries are exact', () => {
  // The sizes where an off-by-one in block emission or window wrap would show:
  // either side of 32KB (the window) and 64KB (the largest stored block).
  for (const n of [32767, 32768, 32769, 65534, 65535, 65536, 65537, 131072]) {
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) bytes[i] = i % 251;
    roundTrip(bytes, `boundary ${n}`);
  }
});

test('base64 media round-trips, which is why media is not deflated at all (D6)', () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const g = new Pcg32('deflate-scale-b64');
  const n = 700_000 * SCALE;
  let s = '';
  for (let i = 0; i < n; i++) s += chars[g.nextInt(64)];
  const bytes = utf8Encode(s);
  const { ours } = roundTrip(bytes, 'base64 media');
  // Base64 of random bytes carries six bits of entropy per byte, so the floor
  // is 75%. Getting near it is the whole reason D6 leaves media outside the
  // deflate stream: a second pass costs time and saves almost nothing.
  assert.ok(ours > n * 0.74, `base64 of noise cannot compress below its entropy floor: ${ours}/${n}`);
  assert.ok(ours < n * 0.80, `and should reach close to it: ${ours}/${n}`);
});
