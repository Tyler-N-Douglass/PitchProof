/**
 * P6 — §6's paste route must produce a proof that can be emitted.
 *
 * A pasted page is markup with no bytes behind it, so no `MediaRef` can be
 * minted for its `<img>`s. Until D-L6-21 the `media` **block** survived anyway,
 * carrying the source path as its `ref` — and a `media` block whose ref names
 * no asset is a severity-1 `ASSET_MISSING`. So paste, the route §6 lists for
 * exactly the case where a fetch is blocked, produced a proof that could not
 * emit: one blocking finding per image per rendition, whose only offered remedy
 * deleted the prospect's own content.
 *
 * The three assertions this file exists for:
 *
 *   1. a real paste, through `buildSpecimen`, reaches `emit()` with no blocking
 *      finding — and none of any severity naming the missing image;
 *   2. the seller is still told, per image, what did not come with the page,
 *      and can put it back by supplying the bytes;
 *   3. the rule that used to fire still fires. `ASSET_MISSING` was not lowered
 *      and nothing was weakened to make (1) true: a proof that really does
 *      carry a block pointing at nothing is still refused.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { importHtmlText, parseHtml } from '../../src/ingest/index.js';
import { buildSpecimen, restoreOmittedMedia, unresolvedMediaRefs } from '../../src/specimen/specimen.js';
import { encodePng } from '../../src/specimen/png.js';
import { emit } from '../../src/emit/index.js';
import { registerAllLayouts } from '../../src/scene/index.js';
import { defaultEmitOptions } from '../../src/core/contracts.js';
import { contentId } from '../../src/core/ids.js';
import { brand, scene } from '../fixtures/emit/proofs.mjs';
import { buildRuntime } from '../../scripts/build.mjs';

registerAllLayouts();

const CLOCK = () => '2026-03-02T09:15:00.000Z';

/** What a seller actually pastes: view-source of a product page, images and all. */
const PASTED = `<!doctype html>
<html lang="en"><head><title>HX-400 shell-and-tube heat exchanger — Northwind Industrial</title>
<meta name="description" content="Removable-bundle heat exchanger for continuous fouling service."></head>
<body>
<header><nav><a href="/"><img src="/assets/logo.svg" alt="Northwind Industrial"></a>
<a href="/products">Products</a><a href="/support">Support</a></nav></header>
<main>
<h1>HX-400 shell-and-tube heat exchanger</h1>
<figure><img src="/assets/product-hx400.png" alt="The HX-400 on its skid"><figcaption>HX-400 on its shipping skid</figcaption></figure>
<p>The HX-400 is built for continuous duty in fouling service. The bundle pulls without breaking the shell connections, so a plant can clean it inside a normal turnaround rather than scheduling an outage around it.</p>
<p>Every unit ships with its material certificates, a hydrostatic test record and the fouling margin the thermal design was signed off against.</p>
<a class="btn" href="/contact">Request a quotation</a>
</main>
<footer><p>© Northwind Industrial. Registered in England.</p></footer>
</body></html>`;

/** The paste route as the studio drives it: `importHtmlText`, then `buildSpecimen`. */
function pastedSpecimen() {
  const capture = importHtmlText(PASTED, { clock: CLOCK, sourceUrl: 'https://northwind.example/hx400' });
  assert.ok(capture.ok, `the paste was refused: ${capture.ok ? '' : capture.error}`);
  assert.deepEqual(capture.value.assets, [], 'a paste carries markup and no bytes — that is the whole premise');
  return buildSpecimen(capture.value, { clock: CLOCK, imageQuality: 0.85, parseHtml });
}

/** The smallest proof that shows one specimen through the real emitter. */
function proofAround(specimen) {
  return {
    schemaVersion: 1,
    id: contentId('proof', 'paste-media'),
    prospectName: 'Northwind Industrial',
    createdAt: CLOCK(),
    brand: brand(),
    specimens: [specimen],
    renditions: [],
    recipes: [],
    spine: [scene('sc_paste_0', { specimenId: specimen.id, blockCount: specimen.blocks.length })],
    branches: [],
    emitOptions: defaultEmitOptions(),
  };
}

let cachedRuntime = null;
function runtimeDeps() {
  if (!cachedRuntime) cachedRuntime = buildRuntime();
  return { runtimeJs: cachedRuntime.js, runtimeCss: cachedRuntime.css, clock: CLOCK };
}

test('P6 — a pasted page keeps its words, holds back the images it has no bytes for, and says so', () => {
  const specimen = pastedSpecimen();

  assert.equal(specimen.media.length, 0, 'nothing was fetched, so nothing was minted');
  assert.deepEqual(specimen.blocks.filter((b) => b.type === 'media'), [],
    'no block is left pointing at bytes that do not exist');
  assert.ok(specimen.blocks.some((b) => b.type === 'heading' && b.text.startsWith('HX-400')),
    'the prospect\'s words are untouched');
  assert.ok(specimen.blocks.some((b) => b.type === 'cta'), 'and so is their call to action');

  // The loss, named. Both images: the one in the content and the logo inside
  // the chrome region, which `restoreBlock` would otherwise put back dangling.
  assert.deepEqual(unresolvedMediaRefs(specimen), ['/assets/logo.svg', '/assets/product-hx400.png']);
  const inContent = specimen.mediaOmitted.find((o) => o.ref === '/assets/product-hx400.png');
  assert.ok(inContent, 'the hero is on the record');
  assert.equal(inContent.origin, 'blocks');
  assert.equal(inContent.caption, 'HX-400 on its shipping skid',
    'with the caption the page gave it, so the seller knows which image it was');
  assert.equal(typeof inContent.position, 'number');
  assert.equal(inContent.reason, 'bytes-not-captured');
  const inChrome = specimen.mediaOmitted.find((o) => o.ref === '/assets/logo.svg');
  assert.ok(inChrome && inChrome.origin === 'stripped', 'and so is the logo inside the stripped header');
  assert.equal(specimen.meta['capture.mediaOmitted'], '2',
    'a count in `meta`, which is a frozen field a consumer reads without knowing this lane');
  assert.equal(specimen.edited, false,
    'nothing the seller did was recorded as an edit to the prospect\'s content (§18.3)');
  assert.ok(typeof specimen.raw === 'string' && specimen.raw.includes('product-hx400.png'),
    '§8 — the untouched source still holds the <img>, so the loss is recoverable from the capture itself');
});

test('P6 — the pasted specimen emits, with no finding about the images that never arrived', async () => {
  const specimen = pastedSpecimen();
  const result = await emit(proofAround(specimen), {}, runtimeDeps());

  assert.ok(result.ok, `a clean paste must emit: ${result.ok ? '' : result.error}`);
  const blocking = result.value.findings.filter((f) => f.severity === 1);
  assert.deepEqual(blocking, [], `paste produced a proof that cannot emit:\n${blocking.map((f) => f.message).join('\n')}`);
  const assets = result.value.findings.filter((f) => f.code === 'ASSET_MISSING');
  assert.deepEqual(assets, [], 'no finding names an asset that was never part of the capture');
  assert.ok(result.value.html.includes('HX-400'), 'and the prospect\'s page is in the artifact');
});

test('P6 — a block that really does point at nothing is still refused, at severity 1', async () => {
  const specimen = pastedSpecimen();
  // The pre-D-L6-21 shape, reconstructed by hand: the block the capture used to
  // leave behind. If this ever stops being refused, the finding was weakened
  // rather than the defect fixed.
  const dangling = {
    ...specimen,
    blocks: [...specimen.blocks, { type: 'media', ref: '/assets/product-hx400.png', caption: 'HX-400 on its shipping skid' }],
  };
  const result = await emit(proofAround(dangling), {}, runtimeDeps());

  assert.equal(result.ok, false, 'a media block with no asset behind it is still a refusal');
  const findings = (result.detail && result.detail.findings) || [];
  const missing = findings.filter((f) => f.code === 'ASSET_MISSING');
  assert.ok(missing.length > 0, `and it is still ASSET_MISSING that catches it — got ${result.error}`);
  assert.ok(missing.every((f) => f.severity === 1), 'still at severity 1 — the severity is not the defect');
});

test('P6 — the seller supplies the missing image and the block comes back where it was', async () => {
  const specimen = pastedSpecimen();
  const png = encodePng(new Uint8Array([
    200, 30, 40, 255, 30, 200, 40, 255,
    40, 30, 200, 255, 90, 90, 90, 255,
  ]), 2, 2);

  const back = restoreOmittedMedia(specimen, '/assets/product-hx400.png',
    { name: '/assets/product-hx400.png', bytes: png, mime: 'image/png' },
    { imageQuality: 0.85 });

  const mediaBlocks = back.blocks.filter((b) => b.type === 'media');
  assert.equal(mediaBlocks.length, 1);
  assert.equal(mediaBlocks[0].caption, 'HX-400 on its shipping skid');
  assert.equal(mediaBlocks[0].ref, back.media[0].id, 'the block points at the bytes that arrived');
  assert.ok(back.media[0].dataUri.startsWith('data:image/png;base64,'), '§8 — inlined at capture');

  // Back where it came from: between the heading and the first paragraph.
  const order = back.blocks.map((b) => b.type);
  assert.deepEqual(order.slice(0, 3), ['heading', 'media', 'paragraph'],
    'restored at its original position, not appended');
  assert.deepEqual(back.mediaOmitted.map((o) => o.ref), ['/assets/logo.svg'], 'the logo is still outstanding');
  assert.deepEqual(unresolvedMediaRefs(back), ['/assets/logo.svg']);
  assert.equal(back.meta['capture.mediaOmitted'], '1', 'and the count follows');
  assert.equal(back.edited, false, 'restoring the prospect\'s own image is not an edit');

  const result = await emit(proofAround(back), {}, runtimeDeps());
  assert.ok(result.ok, `the restored specimen must still emit: ${result.ok ? '' : result.error}`);
  assert.deepEqual(result.value.findings.filter((f) => f.code === 'ASSET_MISSING'), []);
});
