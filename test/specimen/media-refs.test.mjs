/**
 * Media reachability and single-inlining.
 *
 * Two failures the §20 critic found, and the assertions whose absence let them
 * through:
 *
 *   F4 (severity 1) — a `.docx` or PDF specimen carried its image in
 *   `specimen.media` while its `media` block still referenced the importer's
 *   own part name (`word/media/image1.png`). The image was inlined and
 *   unreachable, and every such document made a proof un-emittable with
 *   `ASSET_MISSING`. Nothing asserted that a block's `ref` resolves.
 *
 *   F12 (severity 2) — each specimen inlined its own copy of a shared logo or
 *   hero, so 67% of the media payload was byte-identical duplicates that §13's
 *   budgeter then had to spend `maxBytes` on.
 *
 *   F19 (severity 3) — `MediaRef.bytes` was the decoded payload, so every size
 *   the studio put in front of a seller was a uniform third short of what the
 *   asset costs the artifact. Nothing asserted the declared size against the
 *   data URI it describes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { IdMinter } from '../../src/core/ids.js';
import { importImage, importOoxml, importPdf, parseHtml } from '../../src/ingest/index.js';
import { resolveBlockMedia, resolveMediaRef, mediaIndex } from '../../src/specimen/blocks.js';
import { captureMedia, dedupeMedia, MediaLedger } from '../../src/specimen/media.js';
import { encodePng } from '../../src/specimen/png.js';
import { buildSpecimen, unresolvedMediaRefs } from '../../src/specimen/specimen.js';
import {
  CORPUS_ASSETS, CORPUS_DOCUMENTS, CORPUS_PAGES, assetBytes, corpusClock, documentBytes, pageHtml,
} from '../fixtures/corpus/index.mjs';
import { buildCorpusProof } from '../fixtures/corpus/proof.mjs';

const clock = corpusClock();

/** Import one corpus document exactly as the studio's ingest path would. */
function documentCapture(entry) {
  const bytes = documentBytes(entry.id);
  const result = entry.file.endsWith('.pdf')
    ? importPdf(bytes, { name: entry.name, clock })
    : importOoxml(bytes, { name: entry.name, clock });
  assert.ok(result.ok, `${entry.id} failed to import: ${result.error}`);
  return result.value;
}

/** Every image the corpus site serves, as ingest would hand them over. */
function corpusImageAssets() {
  return CORPUS_ASSETS
    .filter((a) => /\.(png|jpe?g|gif|webp)$/i.test(a.path))
    .map((a) => ({ name: a.path, bytes: assetBytes(a.path), mime: a.mime }));
}

/** @param {any} specimen */
function mediaBlockRefs(specimen) {
  return specimen.blocks.filter((b) => b.type === 'media').map((b) => b.ref);
}

test('F4 — every media block of an imported .docx or .pdf resolves to a MediaRef in the same specimen', () => {
  assert.ok(CORPUS_DOCUMENTS.length >= 2, 'the corpus carries the documents §6.5 requires');
  let sawAnImage = false;

  for (const entry of CORPUS_DOCUMENTS) {
    const capture = documentCapture(entry);
    const specimen = buildSpecimen(capture, { kind: 'document', imageQuality: 0.85, clock });
    const ids = new Set(specimen.media.map((m) => m.id));
    const refs = mediaBlockRefs(specimen);

    for (const ref of refs) {
      sawAnImage = true;
      assert.ok(ids.has(ref),
        `${entry.id}: media block ref ${ref} is not a MediaRef of this specimen — `
        + `that is a severity-1 ASSET_MISSING on an image that is present and inlined`);
      assert.ok(ref.startsWith('md_'), `${entry.id}: a block ref must be a minted media id, not a part name`);
    }
    assert.deepEqual(unresolvedMediaRefs(specimen), [], `${entry.id}: nothing left dangling`);
    assert.deepEqual(specimen.mediaUnresolved, []);
    assert.equal(specimen.media.length, capture.assets.filter((a) => a.bytes.length).length,
      `${entry.id}: every imported asset is inlined`);
  }
  assert.ok(sawAnImage, 'the corpus documents must actually contain an image, or this proves nothing');
});

test('F4 — the same holds for an HTML capture, which is the path that already worked', () => {
  const page = CORPUS_PAGES.find((p) => p.id === 'product');
  const html = pageHtml(page.id);
  const specimen = buildSpecimen({
    kind: 'html',
    sourceUrl: page.url,
    capturedAt: clock(),
    html,
    doc: parseHtml(html),
    assets: corpusImageAssets(),
    meta: {},
  }, { kind: page.kind, imageQuality: 0.85, clock });

  const ids = new Set(specimen.media.map((m) => m.id));
  const refs = mediaBlockRefs(specimen);
  assert.ok(refs.length > 0, 'the product page shows at least one image');
  for (const ref of refs) assert.ok(ids.has(ref), `HTML capture: ${ref} does not resolve`);
});

test('F4 — an imported image specimen reaches its own bytes', () => {
  const bytes = assetBytes('/assets/hero-plant.png');
  const capture = importImage(bytes, { name: 'hero-plant.png', mime: 'image/png', clock });
  assert.ok(capture.ok, 'the image importer is a §6.5 path too');
  const specimen = buildSpecimen(capture.value, { imageQuality: 0.85, clock });
  const ids = new Set(specimen.media.map((m) => m.id));
  const refs = mediaBlockRefs(specimen);
  assert.equal(refs.length, 1);
  assert.ok(ids.has(refs[0]), 'an image specimen whose only block cannot find its image is the whole specimen lost');
});

test('importer refs resolve by part name, basename, relative form and percent-encoding', () => {
  const png = encodePng(new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255]), 2, 2);
  const media = captureMedia([{ name: 'word/media/image 1.png', bytes: png, mime: 'image/png' }], { imageQuality: 0.85 });
  const index = mediaIndex(media);
  const id = media[0].id;

  assert.equal(resolveMediaRef(index, 'word/media/image 1.png'), id);
  assert.equal(resolveMediaRef(index, 'image 1.png'), id, 'by basename');
  assert.equal(resolveMediaRef(index, './word/media/image 1.png'), id, 'relative form');
  assert.equal(resolveMediaRef(index, 'word/media/image%201.png'), id, 'percent-encoded');
  assert.equal(resolveMediaRef(index, 'word/media/missing.png'), null);
  assert.equal(resolveMediaRef(index, ''), null);

  const { blocks, resolved, unresolved } = resolveBlockMedia([
    { type: 'media', ref: 'image 1.png', caption: 'A' },
    { type: 'media', ref: 'nowhere.png' },
    { type: 'paragraph', text: 'untouched' },
    { type: 'media', ref: id, unresolved: true },
  ], media);
  assert.equal(blocks[0].ref, id);
  assert.equal(blocks[0].caption, 'A', 'resolution rewrites the ref and nothing else');
  assert.equal(blocks[1].unresolved, true);
  assert.deepEqual(blocks[2], { type: 'paragraph', text: 'untouched' });
  assert.equal(blocks[3].unresolved, undefined, 'a ref that is already an id is cleared of a stale flag');
  assert.equal(resolved, 1);
  assert.deepEqual(unresolved, ['nowhere.png']);
});

test('an importer block whose bytes were never captured stays visible and is reported, not silently dropped', () => {
  const specimen = buildSpecimen({
    kind: 'document',
    sourceUrl: null,
    capturedAt: clock(),
    html: null,
    doc: null,
    blocks: [
      { type: 'heading', level: 1, text: 'Proposal' },
      { type: 'media', ref: 'word/media/image9.png', caption: 'Never extracted' },
    ],
    assets: [],
    meta: {},
  }, { clock, imageQuality: 0.85 });

  assert.equal(specimen.blocks[1].ref, 'word/media/image9.png');
  assert.equal(specimen.blocks[1].unresolved, true);
  assert.deepEqual(specimen.mediaUnresolved, ['word/media/image9.png']);
  assert.deepEqual(unresolvedMediaRefs(specimen), ['word/media/image9.png']);
});

test('F12 — a shared ledger inlines an asset once across the specimens of one project', () => {
  const assets = corpusImageAssets();
  const pages = CORPUS_PAGES.map((p) => ({
    page: p,
    capture: {
      kind: 'html',
      sourceUrl: p.url,
      capturedAt: clock(),
      html: pageHtml(p.id),
      doc: parseHtml(pageHtml(p.id)),
      assets,
      meta: {},
    },
  }));

  // How the studio and the critic's pipeline capture today: one project-wide
  // minter, one `buildSpecimen` call per page, no shared knowledge of what has
  // already been inlined.
  const separateMinter = new IdMinter('seed', 'specimen');
  const alone = pages.map(({ page, capture }) => buildSpecimen(capture, {
    kind: page.kind, imageQuality: 0.85, clock, idMinter: separateMinter,
  }));
  const distinctBytes = new Set(alone.flatMap((s) => s.media).map((m) => m.dataUri)).size;
  const separateIds = new Set(alone.flatMap((s) => s.media).map((m) => m.id)).size;
  assert.ok(separateIds > distinctBytes,
    'the corpus must actually share images between pages, or this test proves nothing');

  const ledger = new MediaLedger();
  const minter = new IdMinter('seed', 'specimen');
  const shared = pages.map(({ page, capture }) => buildSpecimen(capture, {
    kind: page.kind, imageQuality: 0.85, clock, idMinter: minter, ledger,
  }));

  const refs = shared.flatMap((s) => s.media);
  const ids = new Set(refs.map((m) => m.id));
  const uris = new Set(refs.map((m) => m.dataUri));
  assert.equal(ids.size, uris.size, 'one id per distinct set of bytes across the whole project');
  assert.equal(ledger.size, uris.size);
  assert.ok(ledger.hits > 0 && ledger.bytesSaved > 0, 'the reuse is counted, not silent');

  // Identical bytes must be the identical MediaRef, id and data URI alike.
  const byUri = new Map();
  for (const ref of refs) {
    const seen = byUri.get(ref.dataUri);
    if (seen) assert.equal(ref.id, seen, 'the same bytes carry the same id in every specimen');
    else byUri.set(ref.dataUri, ref.id);
  }
  for (const specimen of shared) {
    const own = new Set(specimen.media.map((m) => m.id));
    for (const ref of mediaBlockRefs(specimen)) assert.ok(own.has(ref), 'blocks still resolve inside their specimen');
  }
});

test('F12 — dedupeMedia collapses specimens that were captured independently', () => {
  const assets = corpusImageAssets();
  const minter = new IdMinter('seed', 'specimen');
  const specimens = CORPUS_PAGES.map((p) => buildSpecimen({
    kind: 'html',
    sourceUrl: p.url,
    capturedAt: clock(),
    html: pageHtml(p.id),
    doc: parseHtml(pageHtml(p.id)),
    assets,
    meta: {},
  }, { kind: p.kind, imageQuality: 0.85, clock, idMinter: minter }));

  // What the artifact actually pays for is one copy per distinct id, since the
  // runtime keys media by id.
  const payload = (carriers) => {
    const seen = new Map();
    for (const ref of carriers.flatMap((c) => c.media)) if (!seen.has(ref.id)) seen.set(ref.id, ref.bytes);
    return [...seen.values()].reduce((n, b) => n + b, 0);
  };
  const payloadBefore = payload(specimens);
  const { carriers, merged, bytesSaved, mapping, groups } = dedupeMedia(specimens);
  const payloadAfter = payload(carriers);

  const after = carriers.flatMap((s) => s.media);
  const ids = new Set(after.map((m) => m.id));
  const uris = new Set(after.map((m) => m.dataUri));
  assert.ok(merged > 0, 'the corpus shares images, so something must merge');
  assert.equal(ids.size, uris.size, 'one surviving id per distinct set of bytes');
  assert.ok(bytesSaved > 0);
  assert.equal(bytesSaved, payloadBefore - payloadAfter,
    'the reported saving is the real change in inlined bytes, not an estimate');
  assert.equal(bytesSaved, groups.reduce((n, g) => n + g.bytes * g.absorbed.length, 0));
  assert.ok(groups.every((g) => g.absorbed.length > 0));

  for (const specimen of carriers) {
    const own = new Set(specimen.media.map((m) => m.id));
    for (const ref of mediaBlockRefs(specimen)) {
      assert.ok(own.has(ref), `block ref ${ref} must be rewritten to the surviving id`);
    }
    for (const entry of specimen.stripped || []) {
      for (const block of entry.blocks) {
        if (block.type === 'media') {
          assert.ok(!mapping[block.ref] || mapping[block.ref] === block.ref,
            'a stripped block cannot reintroduce a dead ref when it is restored');
        }
      }
    }
  }

  // The originals are untouched — the studio's command stack needs that.
  assert.equal(payload(specimens), payloadBefore, 'dedupeMedia returns new carriers and mutates none');
});

test('F12 — dedupe is deterministic and independent of the order the specimens are passed in', () => {
  const assets = corpusImageAssets();
  const build = () => {
    const minter = new IdMinter('seed', 'specimen');
    return CORPUS_PAGES.map((p) => buildSpecimen({
      kind: 'html',
      sourceUrl: p.url,
      capturedAt: clock(),
      html: pageHtml(p.id),
      doc: parseHtml(pageHtml(p.id)),
      assets,
      meta: {},
    }, { kind: p.kind, imageQuality: 0.85, clock, idMinter: minter }));
  };

  const a = dedupeMedia(build());
  const b = dedupeMedia(build());
  assert.deepEqual(a.mapping, b.mapping, 'the same project always dedupes to the same ids (§17.6)');
  assert.deepEqual(a.carriers.map((s) => s.media.map((m) => m.id)), b.carriers.map((s) => s.media.map((m) => m.id)));

  const reversed = dedupeMedia([...build()].reverse());
  assert.deepEqual(reversed.mapping, a.mapping, 'the surviving id does not depend on the order of the carriers');

  // Two runs through the ledger path are identical too.
  const viaLedger = () => {
    const ledger = new MediaLedger();
    const minter = new IdMinter('seed', 'specimen');
    return CORPUS_PAGES.map((p) => buildSpecimen({
      kind: 'html',
      sourceUrl: p.url,
      capturedAt: clock(),
      html: pageHtml(p.id),
      doc: parseHtml(pageHtml(p.id)),
      assets,
      meta: {},
    }, { kind: p.kind, imageQuality: 0.85, clock, idMinter: minter, ledger }));
  };
  assert.deepEqual(viaLedger(), viaLedger());
});

test('dedupeMedia keeps what a merge would otherwise lose, and is a no-op when nothing repeats', () => {
  const red = encodePng(new Uint8Array([255, 0, 0, 255]), 1, 1);
  const blue = encodePng(new Uint8Array([0, 0, 255, 255]), 1, 1);
  const one = captureMedia([{ name: 'a.png', src: '/a.png', bytes: red, alt: 'Plant at dusk' }], { imageQuality: 0.85, idMinter: new IdMinter('x', 'm1') });
  const two = captureMedia([{ name: 'b.png', src: '/b.png', bytes: red, alt: 'The same photo, described differently' }], { imageQuality: 0.85, idMinter: new IdMinter('y', 'm2') });
  assert.notEqual(one[0].id, two[0].id, 'independently captured, so independently identified');

  const carriers = [
    { media: one, blocks: [{ type: 'media', ref: one[0].id }] },
    { media: two, blocks: [{ type: 'media', ref: two[0].id }] },
  ];
  const { carriers: out, merged, bytesSaved } = dedupeMedia(carriers);
  assert.equal(merged, 1);
  assert.equal(bytesSaved, one[0].bytes);
  const survivor = out[0].media[0];
  assert.equal(out[1].media[0].id, survivor.id);
  assert.equal(out[1].blocks[0].ref, survivor.id);
  assert.deepEqual(survivor.sources.sort(), ['/a.png', '/b.png', 'a.png', 'b.png']);
  assert.equal(survivor.altVariants.length, 2, 'the alt text a merge would have dropped is kept');
  assert.deepEqual(survivor.absorbedIds, [survivor.id === one[0].id ? two[0].id : one[0].id]);

  const distinct = dedupeMedia([
    { media: captureMedia([{ name: 'r.png', bytes: red }], { imageQuality: 0.85 }), blocks: [] },
    { media: captureMedia([{ name: 'b.png', bytes: blue }], { imageQuality: 0.85 }), blocks: [] },
  ]);
  assert.equal(distinct.merged, 0);
  assert.equal(distinct.bytesSaved, 0);
  assert.deepEqual(dedupeMedia([]).carriers, []);
});

// ------------------------------------------------------------------- F19

/**
 * Take a data URI apart without using any of the code that built it.
 *
 * `inlined` is the length of the URI as it will sit in the artifact; `payload`
 * is the length of the bytes it carries, decoded here by `Buffer` rather than
 * by this repository's base64. Both are computed from the string alone, so a
 * `MediaRef` cannot pass by agreeing with the function that wrote it.
 *
 * @param {string} uri
 * @returns {{mime: string, inlined: number, payload: number}}
 */
function measureDataUri(uri) {
  assert.ok(uri.startsWith('data:'), `not a data URI: ${uri.slice(0, 32)}`);
  const comma = uri.indexOf(',');
  assert.ok(comma > 0, 'a data URI has a comma');
  const header = uri.slice(5, comma);
  const body = uri.slice(comma + 1);
  assert.ok(header.endsWith(';base64'), `capture inlines base64: ${header}`);

  // Two independent readings of the payload size, so a typo in either shows up.
  const decoded = Buffer.from(body, 'base64');
  const padding = (body.match(/=+$/) || [''])[0].length;
  assert.equal(decoded.length, (body.length / 4) * 3 - padding, 'base64 is 4 characters per 3 bytes');

  return {
    mime: header.slice(0, -';base64'.length),
    inlined: Buffer.byteLength(uri, 'utf8'),
    payload: decoded.length,
  };
}

test('F19 — MediaRef.bytes is the inlined cost of the asset, measured against the data URI itself', async () => {
  const proof = await buildCorpusProof();
  /** @type {Map<string, any>} distinct MediaRef id → ref */
  const refs = new Map();
  for (const carrier of [...proof.specimens, ...proof.renditions]) {
    for (const ref of carrier.media || []) if (!refs.has(ref.id)) refs.set(ref.id, ref);
  }
  assert.ok(refs.size >= 3, `the corpus proof carries media to measure (${refs.size})`);

  let inlinedTotal = 0;
  let payloadTotal = 0;

  for (const ref of refs.values()) {
    const measured = measureDataUri(ref.dataUri);
    assert.equal(ref.bytes, measured.inlined,
      `${ref.id} (${measured.mime}) declares ${ref.bytes} bytes and inlines ${measured.inlined}`);
    assert.equal(ref.decodedBytes, measured.payload,
      `${ref.id} carries a ${measured.payload}-byte payload`);
    assert.ok(ref.bytes > ref.decodedBytes,
      'base64 always costs more than the bytes it carries; a MediaRef may never claim otherwise');
    inlinedTotal += measured.inlined;
    payloadTotal += measured.payload;
  }

  // The finding itself: the old measure was not close. Base64 is 4/3 plus the
  // `data:image/png;base64,` preamble, so the payload is at most 75% of the
  // cost — anything reading `bytes` as the payload was a third light.
  assert.ok(payloadTotal <= inlinedTotal * 0.75,
    `payload ${payloadTotal} vs inlined ${inlinedTotal}: base64 cannot be more than 3/4 of its own encoding`);
  assert.ok(inlinedTotal >= payloadTotal * 4 / 3,
    `the artifact pays ${inlinedTotal} for ${payloadTotal} bytes of image`);
});

test('F19 — a specimen\'s declared media total is the bytes those assets add to the artifact', async () => {
  const proof = await buildCorpusProof();
  // What the studio's specimen panel and inspector both compute.
  for (const specimen of proof.specimens) {
    const declared = (specimen.media || []).reduce((n, m) => n + (m.bytes || 0), 0);
    const actual = (specimen.media || []).reduce((n, m) => n + Buffer.byteLength(m.dataUri, 'utf8'), 0);
    assert.equal(declared, actual,
      `${specimen.id}: the size shown for this specimen's media must be the size it contributes`);
  }

  // And the same sum taken across the whole proof, once per distinct asset,
  // which is what the emit panel's pre-flight estimate reports.
  const byId = new Map();
  for (const carrier of [...proof.specimens, ...proof.renditions]) {
    for (const ref of carrier.media || []) byId.set(ref.id, ref);
  }
  const declared = [...byId.values()].reduce((n, m) => n + m.bytes, 0);
  const actual = [...byId.values()].reduce((n, m) => n + Buffer.byteLength(m.dataUri, 'utf8'), 0);
  assert.equal(declared, actual);
  assert.ok(declared > 0);
});

test('F19 — an SVG that is passed through byte-for-byte still declares what it costs', () => {
  // The passthrough path never touches the payload, which is exactly where a
  // "bytes = the file the seller gave us" reading would have looked right and
  // been wrong: the artifact pays for the base64, not for the file.
  const path = CORPUS_ASSETS.filter((a) => /\.svg$/i.test(a.path))[0].path;
  const svg = assetBytes(path);
  const [ref] = captureMedia([{ name: path, bytes: svg, mime: 'image/svg+xml' }], { imageQuality: 0.85 });
  const measured = measureDataUri(ref.dataUri);

  assert.equal(ref.format, 'svg');
  assert.equal(ref.sourceBytes, svg.length, 'the source is recorded unchanged');
  assert.equal(ref.decodedBytes, svg.length, 'and nothing was re-encoded');
  assert.equal(measured.payload, svg.length);
  assert.equal(ref.bytes, measured.inlined);
  assert.ok(ref.bytes > svg.length,
    `${ref.bytes} inlined for a ${svg.length}-byte file — the difference is what F19 hid`);
});
