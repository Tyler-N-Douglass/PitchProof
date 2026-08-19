/**
 * The pipeline, end to end, on the corpus.
 *
 * §20's critic put the case for this test plainly:
 *
 *   "Every severity-1 finding in this report was reachable from a proof built
 *   out of the corpus, and none was reachable from `makeProof()`."
 *
 * `test/fixtures/emit/proofs.mjs` hand-writes a proof — it names layouts,
 * declares provenance, and hands the emitter blocks that were never ingested,
 * never stripped and never measured. Useful for isolating the emitter, blind to
 * everything before it. F1 (sub-resources never fetched), F2 (`var(--nw-navy)`
 * extracted as HTML navy), F4 (importer media refs pointing at
 * `word/media/image1.png`), F10 (the hero photograph elected as the client's
 * logo) and F12 (the same asset inlined once per page) were every one of them
 * invisible to it.
 *
 * This drives `buildCorpusProof()` instead: four hostile pages and two binary
 * documents in, a §4 `Proof` out, through the published surfaces of L3, L4, L5,
 * L6, L7, L8 and L9 and nothing else — and then through `emit()` with the real
 * runtime bundle.
 *
 * Where an assertion here names a number, the number is checked against the
 * corpus rather than against the pipeline's own output: the palette must be
 * colours that appear in `site.css`, the media refs must be ids the specimen
 * minted, the assets must be bytes the fixture holds. A test whose ground truth
 * is the code it tests proves only that the code is consistent with itself.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCorpusProof, buildPlantedProof, ingestCorpus, sectionBlocks, CORPUS_SEED,
} from '../fixtures/corpus/proof.mjs';
import {
  CORPUS_PAGES, CORPUS_DOCUMENTS, CORPUS_BRAND, CORPUS_ASSETS,
  corpusClock, assetBytes,
} from '../fixtures/corpus/index.mjs';
import { collectColors } from '../../src/brand/color.js';
import { emit } from '../../src/emit/index.js';
import { registerAllLayouts, specimenEdited, EDITED_MARK_CLASS } from '../../src/scene/index.js';
import { runPreflight, autoFixes } from '../../src/validate/index.js';
import { renderLayout } from '../../src/runtime/layouts.js';
import { toHtml } from '../../src/core/vdom.js';
import { buildRuntime } from '../../scripts/build.mjs';

registerAllLayouts();

/** Built once — ingest, cluster and encode are the slow parts and are pure. */
let cached = null;
async function proof() {
  if (!cached) cached = await buildCorpusProof();
  return cached;
}

let cachedRuntime = null;
function runtime() {
  if (!cachedRuntime) cachedRuntime = buildRuntime();
  return cachedRuntime;
}

/** @param {any} p */
async function emitted(p) {
  const rt = runtime();
  return emit(p, p.emitOptions, { runtimeJs: rt.js, runtimeCss: rt.css, clock: corpusClock() });
}

/** Findings live in different places depending on whether the emit was refused. */
function findingsOf(result) {
  if (result.ok) return result.value.findings || [];
  if (Array.isArray(result.detail)) return result.detail;
  return (result.detail && result.detail.findings) || [];
}

// ---------------------------------------------------------------- ingest

test('ingest fetches the sub-resources the pages reference (F1)', async () => {
  const captured = await ingestCorpus();
  assert.equal(captured.pages.length, CORPUS_PAGES.length);

  for (const { page, capture } of captured.pages) {
    assert.ok(capture.assets.length > 0,
      `${page.id} came back with no assets — the sub-resource fetch did not run`);
  }

  // The stylesheet in particular: without it there is no palette, and F2 was a
  // colour extractor reading a stylesheet it had been handed rather than fetched.
  const home = captured.pages[0].capture;
  const css = home.assets.find((a) => a.mime === 'text/css');
  assert.ok(css, 'no stylesheet was fetched for the home page');

  // Byte-for-byte what the corpus holds, not an approximation of it.
  assert.deepEqual([...css.bytes], [...assetBytes('/assets/site.css')]);
});

test('every fetched asset is one the corpus actually serves', async () => {
  const captured = await ingestCorpus();
  const served = new Set(CORPUS_ASSETS.map((a) => a.path));
  for (const { page, capture } of captured.pages) {
    for (const asset of capture.assets) {
      const name = asset.url || asset.name;
      assert.ok(
        served.has(asset.name) || [...served].some((p) => String(name).endsWith(p)),
        `${page.id} fetched ${asset.name}, which the corpus does not serve`);
    }
  }
});

// ------------------------------------------------------------------ brand

test('the palette contains only colours the corpus stylesheet declares (F2)', async () => {
  const p = await proof();
  // An independent oracle: every hex literal in the stylesheet, read from the
  // fixture rather than from the extractor.
  const css = new TextDecoder().decode(assetBytes('/assets/site.css'));
  const literals = new Set([...css.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0].toLowerCase()));
  assert.ok(literals.size >= 8, 'the corpus stylesheet has too few colours to test against');

  const extracted = p.brand.colors.filter((c) => c.source === 'extracted');
  assert.ok(extracted.length > 0, 'nothing at all was extracted; every role was derived');
  for (const token of extracted) {
    assert.ok(literals.has(token.hex.toLowerCase()),
      `role ${token.role} is ${token.hex}, which appears nowhere in the corpus stylesheet`);
  }
});

test("the brand's declared tokens are recovered by value", async () => {
  // Asked of what the collector *saw*, not of the fourteen solved roles. §7
  // assigns fourteen roles and the corpus declares more colours than that, so a
  // stylesheet colour legitimately finishes without a role — `steel`, `ink` and
  // `line` do. The F2 failure was different in kind: `var(--nw-navy)` was read as
  // HTML `navy` and the real value never reached the clusterer at all.
  //
  // The stylesheet is the one ingest fetched; the test above asserts it is
  // byte-for-byte the corpus's own file.
  const captured = await ingestCorpus();
  const sheet = captured.pages[0].capture.assets.find((a) => a.mime === 'text/css');
  const css = new TextDecoder().decode(sheet.bytes);

  const { samples } = collectColors({ css: [css] });
  const seen = new Set(samples.map((sample) => String(sample.hex).toLowerCase()));

  const declared = Object.values(CORPUS_BRAND).filter((v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v));
  assert.equal(declared.length, 8, 'CORPUS_BRAND no longer declares the eight colours this test was written against');
  const missing = declared.filter((hex) => !seen.has(hex.toLowerCase()));
  assert.deepEqual(missing, [], `declared brand colours the pipeline never saw: ${missing.join(', ')}`);

  // And nothing it saw was invented. The oracle is the file, read independently
  // of the collector: every sample must be a hex literal the stylesheet contains.
  const literals = new Set([...css.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0].toLowerCase()));
  const fabricated = [...seen].filter((hex) => !literals.has(hex));
  assert.deepEqual(fabricated, [], `colours the collector produced that the stylesheet does not contain: ${fabricated.join(', ')}`);
});

test('the solved roles are colours the corpus contains, not inventions', async () => {
  const p = await proof();
  const css = new TextDecoder().decode(assetBytes('/assets/site.css'));
  const literals = new Set([...css.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0].toLowerCase()));
  // Only the extracted ones. A derived role is §7 deliberately reaching for a
  // colour the brand does not have, because the brand's own could not clear the
  // contrast floor — `onAccent` is navy-deep here precisely because white on the
  // brand orange is 3.38:1.
  for (const token of p.brand.colors) {
    if (token.source !== 'extracted') continue;
    assert.ok(literals.has(token.hex.toLowerCase()),
      `role ${token.role} is ${token.hex}, extracted, but that colour is nowhere in the stylesheet`);
  }
});

test('every foreground role clears 4.5:1 against its pair (§7)', async () => {
  const p = await proof();
  for (const token of p.brand.colors) {
    if (!/^on[A-Z]/.test(token.role)) continue;
    assert.ok(typeof token.contrastWithPair === 'number',
      `${token.role} reports no contrast against its pair`);
    assert.ok(token.contrastWithPair >= 4.5,
      `${token.role} is ${token.contrastWithPair.toFixed(2)}:1 against its pair, below §7's floor`);
  }
});

test('the primary logo is a logo, not the hero photograph (F10)', async () => {
  const p = await proof();
  const primaries = p.brand.logos.filter((l) => l.variant === 'primary');
  assert.equal(primaries.length, 1, 'a brand carries exactly one primary logo');
  const src = String(primaries[0].src || primaries[0].href || primaries[0].id || '');
  assert.ok(!/hero/i.test(src), `the hero photograph was elected as the primary logo: ${src}`);
});

test('an unknown family reports no metric delta rather than a perfect one (F9)', async () => {
  const p = await proof();
  const unknown = p.brand.faces.filter((f) => f.known === false);
  assert.ok(unknown.length > 0, 'the corpus declares no unknown families, so this proves nothing');
  for (const face of unknown) {
    assert.equal(face.metricDelta, null,
      `${face.family} has no published metrics but reports a delta of ${JSON.stringify(face.metricDelta)}`);
  }
});

// -------------------------------------------------------------- specimens

test('every media block resolves to a MediaRef of its own specimen (F4)', async () => {
  const p = await proof();
  for (const specimen of p.specimens) {
    const ids = new Set((specimen.media || []).map((m) => m.id));
    for (const block of specimen.blocks || []) {
      if (block.type !== 'media') continue;
      assert.ok(ids.has(block.ref),
        `${specimen.kind} specimen block references ${block.ref}, which is not one of its MediaRefs`);
    }
  }
});

test('the shared assets are inlined once, not once per page (F12)', async () => {
  const p = await proof();
  const refs = p.specimens.flatMap((s) => s.media || []);
  assert.ok(refs.length > 0, 'no media was captured at all');
  const distinctBytes = new Set(refs.map((m) => m.dataUri));
  const distinctIds = new Set(refs.map((m) => m.id));
  // A shared logo captured once per page would give one id per occurrence.
  assert.equal(distinctIds.size, distinctBytes.size,
    `${distinctIds.size} MediaRef ids cover only ${distinctBytes.size} distinct payloads — the ledger is not deduplicating`);
});

test('the German page keeps its own locale', async () => {
  const p = await proof();
  const locales = p.specimens.map((s) => s.locale).filter(Boolean);
  assert.ok(locales.includes('de-DE'), `no specimen detected de-DE: ${locales.join(', ')}`);
});

test('chrome stripping is reversible', async () => {
  const p = await proof();
  const stripped = p.specimens.flatMap((s) => s.stripped || []);
  assert.ok(stripped.length > 0, 'nothing was stripped from four pages of navigation and footers');
});

// ------------------------------------------------------- sectioning + deck

test('sectionBlocks never loses or duplicates a block', () => {
  const blocks = [
    { type: 'heading', level: 1, text: 'A' },
    { type: 'paragraph', text: 'a1' },
    { type: 'heading', level: 2, text: 'B' },
    { type: 'paragraph', text: 'b1' },
    { type: 'paragraph', text: 'b2' },
    { type: 'paragraph', text: 'b3' },
    { type: 'paragraph', text: 'b4' },
    { type: 'paragraph', text: 'b5' },
  ];
  const sections = sectionBlocks(blocks);
  assert.deepEqual(sections.flat(), blocks);
  for (const section of sections) assert.ok(section.length > 0);
  assert.ok(sections.length >= 2, 'a level-2 heading did not open a section');
});

test('sectionBlocks handles the empty case without inventing one', () => {
  assert.deepEqual(sectionBlocks([]), []);
  assert.deepEqual(sectionBlocks(null), []);
});

test('every rendition came out of a recipe, not out of its own specimen', async () => {
  // CRITIQUE-3 P5. This fixture used to call `buildRendition` directly with the
  // specimen's own blocks, so all 31 renditions were verbatim slices of their
  // own source, labelled with recipe *names*. Every §20 critic pass judged a
  // pipeline with L7's whole stage skipped — the splitBeforeAfter scenes put the
  // prospect's copy on the left and a slice of the same copy on the right, under
  // "Illustrative example — not client-approved content".
  const p = await proof();
  assert.deepEqual([...new Set(p.renditions.map((r) => r.producedBy))], ['template'],
    'a rendition not produced by a template did not come from renderRecipe');

  // The stronger claim, and the one that catches a regression to hand-built
  // renditions: no rendition's blocks may be a **contiguous slice** of its
  // specimen's. That is exactly what the old fixture produced — `sectionBlocks`
  // cut the source at heading boundaries and handed the pieces straight to
  // `buildRendition`.
  //
  // Deliberately *not* "the text must differ". §18.2 forbids fabrication, so a
  // recipe's output is largely the client's own words: `channel-variants`'s
  // "Paid social" is a heading and a paragraph lifted verbatim, plus a table the
  // recipe wrote. Demanding new text would demand invention, which is the one
  // thing §18.2 is there to prevent. What a recipe changes is *structure*.
  const specimenById = new Map(p.specimens.map((s) => [s.id, s]));
  const shape = (blocks) => JSON.stringify(blocks.map((b) => [b.type, b.text ?? null]));

  /** @type {string[]} */
  const passthrough = [];
  for (const rendition of p.renditions) {
    const specimen = specimenById.get(rendition.specimenId);
    if (!specimen || rendition.blocks.length === 0) continue;
    const source = specimen.blocks || [];
    const needle = shape(rendition.blocks);
    for (let i = 0; i + rendition.blocks.length <= source.length; i += 1) {
      if (shape(source.slice(i, i + rendition.blocks.length)) === needle) {
        passthrough.push(`${rendition.label} (specimen blocks ${i}..${i + rendition.blocks.length - 1})`);
        break;
      }
    }
  }
  assert.deepEqual(passthrough, [],
    `these renditions are contiguous slices of their own specimen: ${passthrough.join(', ')}`);
});

test('the deck carries a right-to-left rendition, on a layout that can show it', async () => {
  // Two ways this fixture lost the coverage, both silently, both found by the
  // §20 critic rather than by a test. The fan-out cap took the first five of
  // `locale-fanout`'s nine markets and ar-SA is ninth — the only RTL market in
  // the library — so the corpus carried no `dir` at all. And a blind layout
  // rotation then put the one RTL rendition on `systemMap`, which renders a
  // rendition's *label* and not its prose, so the direction had nowhere to
  // appear.
  //
  // Without both fixed, pass 2's C8 fix cannot regress-test itself on the proof
  // every critic pass judges: there is no `dir` in it to lose.
  const p = await proof();
  const rtl = p.renditions.filter((r) => r.dir === 'rtl');
  assert.ok(rtl.length > 0, 'no rendition in the corpus proof reads right to left');

  for (const rendition of rtl) {
    const scene = p.spine.concat(...p.branches.map((b) => b.scenes))
      .find((sc) => sc.renditionIds.includes(rendition.id));
    assert.ok(scene, `${rendition.label} is on no scene`);
    assert.ok(!['systemMap', 'contentsIndex'].includes(scene.layout),
      `${rendition.label} is laid out by ${scene.layout}, which renders a rendition's label and not its prose`);
  }
});

test('the rendered right-to-left scene actually carries dir="rtl"', async () => {
  // Asked of the rendered tree, not of the emitted file: the artifact carries
  // its model compressed, so only the opening beat's first-paint markup is
  // literal in the bytes. Grepping the file for `dir="rtl"` finds nothing and
  // means nothing — which is exactly the false negative that sent me looking
  // for a defect in L8 that was not there.
  const p = await proof();
  const rtl = p.renditions.find((r) => r.dir === 'rtl');
  assert.ok(rtl, 'no right-to-left rendition to render');
  const scene = p.spine.find((sc) => sc.renditionIds.includes(rtl.id));
  const specimen = p.specimens.find((s) => s.id === scene.specimenId) || null;

  const html = toHtml(renderLayout({
    scene, specimen, renditions: [rtl], brand: p.brand,
    el: (path) => `el_${path}`, revealed: () => true,
  }));
  const marks = (html.match(/dir="rtl"/g) || []).length;
  assert.ok(marks > 0, `the ${scene.layout} layout rendered ${rtl.label} with no dir="rtl" anywhere`);

  // And §18.2: the text is still the source's English, so nothing may claim it
  // is Arabic. `dir` is the market's; `lang` is the source's.
  assert.ok(!html.includes('lang="ar-SA"'),
    'a block claims lang="ar-SA" over text that is still the source\'s English — '
    + 'that hands a screen reader an Arabic voice for English words');
});

test('the deck exercises more than one layout and more than one recipe', async () => {
  const p = await proof();
  const layouts = new Set(p.spine.map((s) => s.layout));
  assert.ok(layouts.size >= 4, `the spine uses only ${layouts.size} layout(s): ${[...layouts].join(', ')}`);
  const recipes = new Set(p.renditions.map((r) => r.recipeId));
  assert.ok(recipes.size >= 4, `only ${recipes.size} of §9's eight recipes are exercised`);
});

test('every branch is anchored and every anchor names a real branch', async () => {
  const p = await proof();
  const branchIds = new Set(p.branches.map((b) => b.id));
  // Branch scenes count. A nested branch is offered from a scene inside another
  // branch, which is the whole point of §11's return stack — looking only at the
  // spine would report the nested one as stranded.
  const allScenes = p.spine.concat(...p.branches.map((b) => b.scenes));
  const anchored = new Set(allScenes.flatMap((s) => s.branchAnchors));
  for (const branch of p.branches) {
    assert.ok(anchored.has(branch.id),
      `branch "${branch.objection}" is anchored to no scene, so it has nowhere to return to`);
  }
  for (const id of anchored) assert.ok(branchIds.has(id), `a scene anchors ${id}, which is not a branch`);
});

test('the deck has a nested branch, so the return stack is exercised (§22.4)', async () => {
  const p = await proof();
  const spineAnchored = new Set(p.spine.flatMap((s) => s.branchAnchors));
  const nested = p.branches.filter((b) => !spineAnchored.has(b.id));
  assert.ok(nested.length > 0,
    'every branch is offered from the spine, so nothing ever puts a second frame on the return stack — '
    + 'and §22.4\'s stranding case lives entirely in the nested path');
  for (const branch of nested) {
    const hosts = p.branches.filter((b) => b.scenes.some((s) => s.branchAnchors.includes(branch.id)));
    assert.ok(hosts.length > 0, `${branch.id} is anchored nowhere at all`);
    assert.ok(!hosts.some((h) => h.id === branch.id), `${branch.id} is offered from inside itself`);
  }
});

test('an auto-fix that removes the client\'s content is recorded, and the deck says so (§18.3)', async () => {
  // §18.3: *if a specimen was edited, the artifact says so.* Three lanes hold a
  // piece of that sentence and no test held the whole of it — L11's fixer calls
  // markEdited, L6 stores it, L8 renders a marker, and each was checked in its
  // own lane against its own fixture. This walks the sentence: plant a defect,
  // take the remedy the studio offers, and look at what the room would see.
  //
  // The critic found the first link broken (CRITIQUE-3 P6): the fix spliced the
  // prospect's content out and set neither `edited` nor `editNotes`, so the
  // artifact — the one surface the rule is written about — stayed silent.
  const clock = () => '2026-02-10T10:00:00.000Z';
  const { proof: planted } = await buildPlantedProof('ASSET_MISSING');
  const findings = await runPreflight(planted, { clock });

  // The fix on a *specimen*. A rendition is the tool's own draft, and L11
  // deliberately records nothing when one is trimmed — editing your own work is
  // not editing the client's.
  const fixes = autoFixes(planted, findings, { clock })
    .filter((f) => f.finding.code === 'ASSET_MISSING');
  const onSpecimen = fixes.find((f) => / of specimen /.test(f.finding.message));
  assert.ok(onSpecimen, `no ASSET_MISSING fix acts on a specimen: ${fixes.map((f) => f.label).join(' | ')}`);

  const fixed = onSpecimen.apply(planted);
  const edited = fixed.specimens.filter((s) => s.edited);
  assert.equal(edited.length, 1, 'removing the client\'s content left no record on any specimen');
  assert.ok(specimenEdited(edited[0]));

  // The note is what a reader is left with, so it has to say what went and why.
  const notes = JSON.stringify(edited[0].editNotes);
  assert.match(notes, /Removed an image/);
  assert.match(notes, /would have shown to the room as a broken image/);
  assert.match(notes, /Everything else on the page is as it was captured/);

  // And the deck carries the marker where the client will see it.
  const scene = fixed.spine.find((sc) => sc.specimenId === edited[0].id);
  assert.ok(scene, 'the edited specimen is on no scene, so this proves nothing');
  const html = toHtml(renderLayout({
    scene,
    specimen: edited[0],
    renditions: fixed.renditions.filter((r) => scene.renditionIds.includes(r.id)),
    brand: fixed.brand,
    el: (path) => `el_${path}`,
    revealed: () => true,
  }));
  assert.ok(html.includes(EDITED_MARK_CLASS),
    `the ${scene.layout} layout rendered an edited specimen with no .${EDITED_MARK_CLASS} anywhere`);

  // An untouched specimen must not wear it — a marker on everything says
  // nothing, which is the failure mode of every honesty label.
  const untouched = fixed.specimens.find((sp) => !sp.edited && fixed.spine.some((sc) => sc.specimenId === sp.id));
  assert.ok(untouched, 'every specimen is edited, so the negative case is untested');
  const cleanScene = fixed.spine.find((sc) => sc.specimenId === untouched.id);
  const cleanHtml = toHtml(renderLayout({
    scene: cleanScene,
    specimen: untouched,
    renditions: fixed.renditions.filter((r) => cleanScene.renditionIds.includes(r.id)),
    brand: fixed.brand,
    el: (path) => `el_${path}`,
    revealed: () => true,
  }));
  assert.ok(!cleanHtml.includes(EDITED_MARK_CLASS),
    `the ${cleanScene.layout} layout marked an unedited specimen as edited`);
});

test('nothing in the proof claims to be verified by a user', async () => {
  const p = await proof();
  for (const r of p.renditions) {
    assert.notEqual(r.provenance, 'verified-by-user',
      `${r.label} claims verified-by-user, which only promoteProvenance may produce`);
  }
  assert.ok(p.renditions.every((r) => r.provenance === 'illustrative'),
    'a fixture that marked its own content client-supplied would skip §18.1 entirely');
});

// ------------------------------------------------------------------- emit

test('the corpus proof emits, with no severity-1 finding', async () => {
  const p = await proof();
  const result = await emitted(p);
  const blocking = findingsOf(result).filter((f) => f.severity === 1);
  assert.deepEqual(
    blocking.map((f) => `${f.code} ${f.message}`),
    [],
    'the emitter refused a proof built from the corpus by the real pipeline');
  assert.ok(result.ok);
  assert.ok(result.value.bytes > 0);
});

test('two emits of the corpus proof are byte-identical (§5, §17.6)', async () => {
  const a = await buildCorpusProof();
  const b = await buildCorpusProof();
  const ra = await emitted(a);
  const rb = await emitted(b);
  assert.equal(ra.ok, rb.ok);
  if (!ra.ok) {
    // Still a real assertion: two refusals must refuse identically.
    assert.deepEqual(findingsOf(ra).map((f) => f.code + f.message), findingsOf(rb).map((f) => f.code + f.message));
    return;
  }
  assert.equal(ra.value.html.length, rb.value.html.length);
  assert.equal(ra.value.html, rb.value.html);
});

test('a different seed still produces a valid proof, with different ids', async () => {
  // The ids must come from the seed and nowhere else — no clock, no counter that
  // survives between runs (§5).
  const a = await buildCorpusProof();
  const b = await buildCorpusProof({ seed: `${CORPUS_SEED}-alternate` });
  assert.notEqual(a.spine[0].id, b.spine[0].id, 'the scene ids do not depend on the seed');
  assert.equal(a.spine.length, b.spine.length);
  assert.equal(a.brand.colors.length, b.brand.colors.length);
});

test('the emitted artifact carries a provenance label for every illustrative rendition (§18.1)', async () => {
  const p = await proof();
  const result = await emitted(p);
  const unlabelled = findingsOf(result).filter((f) => f.code === 'PROVENANCE_UNLABELED');
  assert.deepEqual(unlabelled.map((f) => f.message), []);
});

test('the emitted artifact reaches no network (§1.1, §13)', async () => {
  const p = await proof();
  const result = await emitted(p);
  const network = findingsOf(result).filter((f) => f.code === 'NETWORK_REFERENCE');
  assert.deepEqual(network.map((f) => f.message), []);
});

test('the artifact is smaller than the budget without degrading the client\'s images', async () => {
  const p = await proof();
  const result = await emitted(p);
  if (!result.ok) return;   // the refusal is asserted above; do not double-report it
  assert.ok(result.value.bytes < p.emitOptions.maxBytes);
  assert.deepEqual(result.value.degradations, [],
    'the budgeter degraded the client\'s assets on a deck that fits comfortably');
});
