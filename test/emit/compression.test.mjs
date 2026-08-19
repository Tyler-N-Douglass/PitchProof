/**
 * Compression (§13, D5, D6).
 *
 * §13: "Consider deflate-compressing the payload and inflating at runtime via
 * `DecompressionStream` with a raw-bytes fallback path; measure and keep
 * whichever is smaller and still passes cold-boot budget."
 *
 * Both variants are measured on the bytes the file really pays — the payload
 * *and* the decoder the variant needs — and the artifact's own decode path is
 * tested here rather than only in a browser, because it ships as source and
 * therefore can be.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodePayload, splitMedia, isExtractableMedia } from '../../src/emit/model.js';
import {
  ppInflateRaw, ppBase64ToBytes, ppUtf8Decode, ppRehydrateMedia, ppDecodePayload,
  ppReadMediaTable, artifactRuntimeSource,
} from '../../src/emit/artifact-runtime.js';
import { emit } from '../../src/emit/index.js';
import { deflateRaw } from '../../src/core/deflate.js';
import { utf8Encode, utf8Decode, base64Encode, base64Decode, concatBytes } from '../../src/core/bytes.js';
import { stableStringify } from '../../src/core/hash.js';
import { registerTestLayouts } from '../fixtures/emit/layouts.mjs';
import { runtimeBundle, FIXED_CLOCK } from '../fixtures/emit/runtime-bundle.mjs';
import { emitProof, tinyProof } from '../fixtures/emit/proofs.mjs';
import { artifactMediaTable, artifactModel } from '../fixtures/emit/artifact-dom.mjs';

const { js: runtimeJs, css: runtimeCss } = runtimeBundle();
const deps = { runtimeJs, runtimeCss, clock: FIXED_CLOCK };

test('both variants are measured, and the smaller one is kept', () => {
  const encoded = encodePayload(emitProof());
  assert.equal(encoded.measured.length, 2);
  const modes = encoded.measured.map((m) => m.mode).sort();
  assert.deepEqual(modes, ['deflate', 'raw']);
  for (const m of encoded.measured) {
    assert.ok(m.payloadBytes > 0);
    assert.ok(m.bootBytes > 0);
    assert.equal(m.totalBytes, m.payloadBytes + m.bootBytes);
  }
  const smallest = encoded.measured.reduce((best, m) => (m.totalBytes < best.totalBytes ? m : best));
  assert.equal(encoded.mode, smallest.mode, 'the emitter kept the larger variant');
  assert.equal(encoded.modelBytes, smallest.payloadBytes);
});

test('the comparison counts the inflater the compressed variant has to carry', () => {
  const encoded = encodePayload(emitProof());
  const deflate = encoded.measured.find((m) => m.mode === 'deflate');
  const raw = encoded.measured.find((m) => m.mode === 'raw');
  assert.ok(deflate.bootBytes > raw.bootBytes, 'the compressed variant must pay for its fallback decoder');
  assert.ok(deflate.payloadBytes < raw.payloadBytes, 'compression must actually compress');
});

test('a tiny proof keeps the raw variant, a real one compresses', () => {
  const tiny = encodePayload(tinyProof());
  assert.equal(tiny.mode, 'raw', 'below the inflater\'s own size, compressing is a net loss');
  const real = encodePayload(emitProof({ imageEdge: 64 }));
  assert.equal(real.mode, 'deflate');
});

test('the artifact round-trips its own model payload', async () => {
  registerTestLayouts();
  const proof = emitProof();
  const result = await emit(proof, {}, deps);
  assert.equal(result.ok, true, result.ok ? '' : result.error);

  const payload = between(result.value.html, '<script id="pp-model" type="application/octet-stream">', '</script>');
  const mode = result.value.compression.mode;

  const bytes = ppBase64ToBytes(payload);
  const raw = mode === 'deflate' ? ppInflateRaw(bytes) : bytes;
  const model = JSON.parse(ppUtf8Decode(raw));
  // Through the artifact's own reader, because C2 gave the media table a second
  // kind of line: the payloads the opening beat already paints are borrowed
  // back out of the markup instead of written twice.
  const table = artifactMediaTable(result.value.html);
  const rebuilt = ppRehydrateMedia(model, table);

  assert.equal(rebuilt.id, proof.id);
  assert.equal(rebuilt.prospectName, proof.prospectName);
  assert.equal(rebuilt.spine.length, proof.spine.length);
  assert.equal(rebuilt.branches.length, proof.branches.length);
  assert.equal(rebuilt.specimens[0].media[0].dataUri, proof.specimens[0].media[0].dataUri, 'media must come back byte-identical');
  // §4: a logo is "inline SVG markup or data URI". The fixture's is markup, and
  // markup is text, so D6 keeps it inside the compressed model rather than in
  // the media table.
  assert.equal(rebuilt.brand.logos[0].data, proof.brand.logos[0].data, 'the logo must come back byte-identical');
  assert.match(rebuilt.brand.logos[0].data, /^<svg\b/);
});

test('the platform decode path and the fallback agree', async () => {
  const json = stableStringify(emitProof());
  const bytes = utf8Encode(json);
  const compressed = deflateRaw(bytes);

  const fallback = ppInflateRaw(compressed);
  assert.equal(utf8Decode(fallback), json);

  const viaPlatform = await ppDecodePayload(compressed, 'deflate');
  assert.equal(utf8Decode(viaPlatform), json, 'DecompressionStream and the embedded inflater must agree');

  const passthrough = await ppDecodePayload(bytes, 'raw');
  assert.equal(utf8Decode(passthrough), json);
});

test('the stored-block fallback path decodes correctly', () => {
  // A stored block is what DEFLATE produces for incompressible data, and it is
  // the path an engine without DecompressionStream is most likely to meet on a
  // payload of base64. Build one by hand so the test does not depend on the
  // compressor choosing it.
  const body = utf8Encode('stored blocks carry their payload verbatim — no Huffman table, no back-references.');
  const header = new Uint8Array([0x01, body.length & 0xff, (body.length >> 8) & 0xff, ~body.length & 0xff, (~body.length >> 8) & 0xff]);
  const stream = concatBytes(header, body);
  assert.equal(utf8Decode(ppInflateRaw(stream)), utf8Decode(body));

  // Two stored blocks, the first not final.
  const first = utf8Encode('first half; ');
  const second = utf8Encode('second half.');
  const h1 = new Uint8Array([0x00, first.length & 0xff, (first.length >> 8) & 0xff, ~first.length & 0xff, (~first.length >> 8) & 0xff]);
  const h2 = new Uint8Array([0x01, second.length & 0xff, (second.length >> 8) & 0xff, ~second.length & 0xff, (~second.length >> 8) & 0xff]);
  assert.equal(utf8Decode(ppInflateRaw(concatBytes(h1, first, h2, second))), 'first half; second half.');
});

test('the embedded inflater handles fixed and dynamic Huffman blocks too', () => {
  const cases = [
    'a',
    'ab'.repeat(4000),
    JSON.stringify({ deep: { nested: Array.from({ length: 400 }, (_, i) => ({ i, label: `row ${i}` })) } }),
    'the quick brown fox jumps over the lazy dog. '.repeat(500),
    Array.from({ length: 6000 }, (_, i) => String.fromCharCode(32 + (i * 7) % 95)).join(''),
  ];
  for (const text of cases) {
    const bytes = utf8Encode(text);
    assert.equal(utf8Decode(ppInflateRaw(deflateRaw(bytes))), text, `round trip failed for a ${bytes.length}-byte input`);
  }
});

test('the embedded base64 decoder matches the core encoder', () => {
  for (const n of [0, 1, 2, 3, 4, 5, 255, 1000, 4096]) {
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) bytes[i] = (i * 37 + 11) & 255;
    const encoded = base64Encode(bytes);
    assert.deepEqual([...ppBase64ToBytes(encoded)], [...bytes], `mismatch at length ${n}`);
    assert.deepEqual([...ppBase64ToBytes(encoded)], [...base64Decode(encoded)]);
  }
});

test('media is split out of the model and rejoined exactly (D6)', () => {
  const proof = emitProof();
  const split = splitMedia(proof);
  const json = stableStringify(split.model);
  assert.ok(!json.includes('data:image/png;base64'), 'base64 media must not travel inside the compressed model');
  assert.match(json, /@m\d+/);
  assert.ok(split.table.every((uri) => /^data:[^,]*;base64,[A-Za-z0-9+/=]*$/.test(uri)), 'the media table must hold only base64 data URIs');

  const rebuilt = ppRehydrateMedia(JSON.parse(json), split.table);
  assert.equal(rebuilt.specimens[0].media[0].dataUri, proof.specimens[0].media[0].dataUri);
});

test('a non-base64 data URI stays inside the model, where it compresses', () => {
  const svg = 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3C%2Fsvg%3E';
  assert.equal(isExtractableMedia(svg), false);
  assert.equal(isExtractableMedia(`data:image/png;base64,${'A'.repeat(200)}`), true);
  assert.equal(isExtractableMedia('data:image/png;base64,AAAA'), false, 'a short URI is not worth a placeholder');
  const proof = emitProof();
  const split = splitMedia(proof);
  const json = stableStringify(split.model);
  assert.ok(json.includes('<svg'), 'inline SVG markup stays in the model, where it compresses');
  // Checked on the mime, not on a substring: base64 is an alphabet in which
  // the letters "svg" occur by chance.
  assert.ok(
    !split.table.some((uri) => /^data:image\/svg\+xml/i.test(uri)),
    'and never reaches the media table',
  );
});

test('the media table can never contain a sequence that ends its script element', () => {
  const split = splitMedia(emitProof());
  const text = split.table.join('\n');
  assert.ok(!/<\/\s*script/i.test(text));
  assert.ok(!text.includes('<'));
});

test('the emitted boot source carries the inflater only when it is needed', () => {
  assert.ok(artifactRuntimeSource('deflate').includes('function ppInflateRaw'));
  assert.ok(!artifactRuntimeSource('raw').includes('function ppInflateRaw'));
  assert.ok(artifactRuntimeSource('raw').includes('var ppDecodePayload = ppDecodePayloadRaw;'));
  for (const mode of ['deflate', 'raw']) {
    const src = artifactRuntimeSource(mode);
    assert.ok(src.includes('function ppBootArtifact'), `${mode} variant lost the boot function`);
    assert.ok(!src.includes('export '), 'serialized source must not carry module syntax');
  }
});

test('EmitResult.compression reports the mode actually used and real byte counts', async () => {
  registerTestLayouts();
  const result = await emit(emitProof(), {}, deps);
  assert.equal(result.ok, true);
  const { mode, modelBytes, mediaBytes } = result.value.compression;
  assert.ok(mode === 'deflate' || mode === 'raw');
  const payload = between(result.value.html, '<script id="pp-model" type="application/octet-stream">', '</script>');
  const mediaText = between(result.value.html, '<script id="pp-media" type="application/octet-stream">', '</script>');
  assert.equal(modelBytes, payload.length, 'modelBytes must be the payload actually written');
  assert.equal(mediaBytes, mediaText.length, 'mediaBytes must be the media table actually written');
});

/** @param {string} haystack @param {string} open @param {string} close @returns {string} */
function between(haystack, open, close) {
  const start = haystack.indexOf(open);
  assert.notEqual(start, -1, `could not find ${open}`);
  const from = start + open.length;
  const end = haystack.indexOf(close, from);
  assert.notEqual(end, -1, `could not find ${close}`);
  return haystack.slice(from, end);
}


// --------------------------------------------------------------------- C2

test('the opening beat\'s pictures are written into the file once, not twice (C2)', async () => {
  registerTestLayouts();
  const proof = emitProof({ imageEdge: 200 });
  const result = await emit(proof, {}, deps);
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  const html = result.value.html;

  // §12 needs the opening beat painted before any JavaScript runs, so its
  // pictures are in the markup as literal `src` values. D6 needs every payload
  // in the media table, so the runtime can rebuild the model. Doing both wrote
  // the same megabyte twice; the table now borrows the markup's copy.
  const payloads = new Set();
  for (const media of [...proof.specimens.flatMap((s) => s.media || []), ...proof.renditions.flatMap((r) => r.media || [])]) {
    payloads.add(media.dataUri);
  }
  assert.ok(payloads.size > 0, 'the fixture must carry media, or this test asserts nothing');

  let borrowed = 0;
  for (const uri of payloads) {
    let count = 0;
    let at = 0;
    for (;;) {
      const i = html.indexOf(uri, at);
      if (i < 0) break;
      count += 1;
      at = i + uri.length;
    }
    assert.equal(count, 1, `a payload appears ${count} times in the emitted file; the artifact pays for every one of them`);
  }

  const table = artifactMediaTable(html);
  const written = between(html, '<script id="pp-media" type="application/octet-stream">', '</script>').split('\n');
  for (let i = 0; i < written.length; i++) {
    if (written[i].charAt(0) === '@') {
      borrowed += 1;
      assert.match(html, new RegExp(`data-pp-m="${i}"`), `line ${i} borrows a payload from markup that does not mark it`);
      assert.ok(table[i].startsWith('data:'), `line ${i} did not resolve back to a payload`);
    }
  }
  assert.ok(borrowed > 0, 'the fixture must paint at least one picture on the opening beat');

  // And the model the artifact rebuilds is the model that was encoded.
  const rebuilt = artifactModel(html);
  const byId = new Map([...rebuilt.specimens.flatMap((s) => s.media || []), ...rebuilt.renditions.flatMap((r) => r.media || [])].map((m) => [m.id, m]));
  for (const media of [...proof.specimens.flatMap((s) => s.media || []), ...proof.renditions.flatMap((r) => r.media || [])]) {
    assert.equal(byId.get(media.id).dataUri, media.dataUri, `${media.id} did not come back byte-identical`);
  }
});

test('a borrowed media line that the markup cannot answer fails loudly (C2)', () => {
  // The failure mode this replaces is worse than a throw: a model carrying the
  // string "@m3" where a picture should be, rendered as a broken image and — on
  // a browser that resolves it as a relative URL — a network request out of an
  // artifact whose whole promise is that it makes none.
  assert.throws(
    () => ppReadMediaTable('@src', { querySelector: () => null }),
    /the opening beat does not carry it/,
  );
  assert.throws(
    () => ppReadMediaTable('@src', { querySelector: () => ({ getAttribute: () => null }) }),
    /the opening beat does not carry it/,
  );
  assert.deepEqual(ppReadMediaTable('', { querySelector: () => null }), []);
});
