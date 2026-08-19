/**
 * A `Proof` built out of the Northwind corpus by the real pipeline.
 *
 * `test/fixtures/emit/proofs.mjs` hand-writes a proof: it names layouts,
 * declares provenance, and hands the emitter blocks that were never ingested,
 * never stripped and never measured. That fixture is useful — it isolates the
 * emitter — but the §20 critic put the cost plainly:
 *
 *   "Every severity-1 finding in this report was reachable from a proof built
 *   out of the corpus, and none was reachable from `makeProof()`."
 *
 * F1 (sub-resources never fetched), F2 (`var(--nw-navy)` extracted as HTML
 * navy), F4 (importer media refs pointing at `word/media/image1.png`), F10 (the
 * hero photograph elected as the client's logo) and F12 (the same asset inlined
 * once per page) were all invisible to a fixture that starts after ingest. They
 * are visible here because this one starts before it: four hostile pages and two
 * binary documents go in, and a §4 `Proof` comes out, through the published
 * surfaces of L3, L4, L5, L6, L7, L8 and L9 and nothing else.
 *
 * Every source of variation is injected — the corpus HTTP stub, the corpus
 * clock, one seeded `IdMinter` — so two calls return the same proof and the
 * artifact emitted from it is byte-identical (§5, §17.6). `buildCorpusProof()`
 * asserts that itself.
 */

import { IdMinter } from '../../../src/core/ids.js';
import * as ingest from '../../../src/ingest/index.js';
import * as specimenLane from '../../../src/specimen/index.js';
import * as colorLane from '../../../src/brand/color.js';
import * as themeLane from '../../../src/brand/theme.js';
import * as recipeLane from '../../../src/recipe/index.js';
import * as sceneLane from '../../../src/scene/index.js';

import {
  CORPUS_PAGES, CORPUS_DOCUMENTS, CORPUS_ORIGIN,
  corpusHttp, corpusClock, documentBytes,
} from './index.mjs';

/** The seed every id in a corpus proof descends from. Fixed, so ids are stable. */
export const CORPUS_SEED = 'northwind-industrial';

/**
 * Which of §9's eight seed recipes each specimen is run through.
 *
 * The choices are the ones the corpus itself invites, so that between them they
 * exercise five of the eight rather than the same one six times: the home page
 * is a system assembly, the product page a channel fan-out, the English article
 * a brief-to-asset, its German translation the locale fan-out that page exists
 * to test, and the two binary documents the approval chain and the DAM round
 * trip a proposal actually goes through.
 *
 * Keyed by specimen id where the corpus distinguishes two specimens of the same
 * kind, and by kind otherwise.
 */
const RECIPE_FOR_PAGE = {
  home: 'system-assembly',
  product: 'channel-variants',
  article: 'governed-iteration',
  'article-de': 'locale-fanout',
};

const RECIPE_FOR_DOCUMENT = {
  'proposal-docx': 'approval-chain',
  'design-note-pdf': 'dam-round-trip',
};

// `volume-view` takes every kind §4 declares, so it is the only safe fallback.
// The assignments above are asserted against each recipe's own `inputKinds`
// before it runs, so a mismatch is an error rather than a silent demotion to
// this one — an earlier version fell back quietly and ran five of six specimens
// through whichever recipe happened to be first.
const RECIPE_FALLBACK = 'volume-view';

/**
 * Layouts assigned in a fixed rotation over the spine, so a corpus proof
 * exercises more than one of L8's eight rather than repeating the first.
 */
const SPINE_LAYOUTS = ['splitBeforeAfter', 'stack', 'sideNote', 'quoteCard', 'fanOut', 'systemMap'];

/**
 * The layouts that render a rendition's **prose**, as opposed to its label.
 *
 * `systemMap` and `contentsIndex` render a rendition's name and a sentence
 * about it — deliberately, and L8 asserts it rather than leaving it to a
 * comment. So a rendition whose writing direction is the thing under test must
 * not land on one, or the direction has nowhere to appear.
 *
 * A blind rotation put the corpus's single `ar-SA` rendition on `systemMap`,
 * and the artifact came out with no `dir="rtl"` in it anywhere — which would
 * have read as L8's C8 fix failing, when what had actually happened was that
 * this fixture handed the one right-to-left rendition to the one layout that
 * cannot show a direction. The same class of hole as the recipes: coverage lost
 * to an arbitrary assignment, in a way no test names.
 */
const PROSE_LAYOUTS = SPINE_LAYOUTS.filter((l) => l !== 'systemMap' && l !== 'contentsIndex');

/**
 * The layout a rendition is shown in.
 *
 * The rotation is the default, so the deck exercises more than one of L8's
 * eight. A rendition that declares a writing direction overrides it onto the
 * next prose layout in the same rotation, so the choice stays deterministic and
 * position-derived rather than becoming a special case with a name.
 *
 * @param {any} rendition
 * @param {number} index  position in the spine
 * @returns {string}
 */
function layoutFor(rendition, index) {
  const rotated = SPINE_LAYOUTS[index % SPINE_LAYOUTS.length];
  if (!rendition || !rendition.dir || PROSE_LAYOUTS.includes(rotated)) return rotated;
  return PROSE_LAYOUTS[index % PROSE_LAYOUTS.length];
}

/** Text decoded once. */
const DECODER = new TextDecoder();

/**
 * Ingest every corpus page and document.
 *
 * Pages go through `ingestUrl` with the corpus HTTP stub rather than through
 * `importHtmlText`, because the strategy ladder and the sub-resource fetch are
 * part of what is being tested: F1 was a whole stage of the pipeline that never
 * ran, and a fixture that hands ingest its own stylesheet would never have
 * noticed.
 *
 * @param {{http?: any, clock?: () => string}} [deps]
 * @returns {Promise<{pages: any[], documents: any[]}>}
 */
export async function ingestCorpus(deps = {}) {
  const http = deps.http || corpusHttp();
  const clock = deps.clock || corpusClock();

  /** @type {any[]} */
  const pages = [];
  for (const page of CORPUS_PAGES) {
    const result = await ingest.ingestUrl(page.url, { http, clock });
    if (!result.ok) {
      throw new Error(`corpus: ingesting ${page.id} (${page.url}) failed: ${result.error}`);
    }
    pages.push({ page, capture: result.value });
  }

  /** @type {any[]} */
  const documents = [];
  for (const doc of CORPUS_DOCUMENTS) {
    const bytes = documentBytes(doc.id);
    const result = doc.file.endsWith('.pdf')
      ? ingest.importPdf(bytes, { name: doc.name, clock })
      : ingest.importOoxml(bytes, { name: doc.name, clock });
    if (!result.ok) throw new Error(`corpus: importing ${doc.id} failed: ${result.error}`);
    documents.push({ doc, capture: result.value });
  }

  return { pages, documents };
}

/**
 * The palette from the most recent `buildCorpusBrand` call: solved roles,
 * clusters, confidence and origins. Read by `corpusPalette()`.
 * @type {any}
 */
let lastPalette = null;

/**
 * Every colour the pipeline collected from the corpus, whether or not §7's role
 * solve found a role for it.
 * @returns {{colors: any[], clusters: any[], confidence: number, origins: string[]}}
 */
export function corpusPalette() {
  if (!lastPalette) throw new Error('corpus: build a proof before asking for its palette');
  return lastPalette;
}

/**
 * Build the brand from what ingest actually brought back.
 *
 * The stylesheet is not passed in from the fixture: it is whichever bytes
 * `ingestUrl` fetched as a sub-resource, decoded. That is the point — the brand
 * is only as good as the ingest, and F2 was a colour extractor reading a
 * stylesheet it had been handed rather than one it had been fetched.
 *
 * @param {any[]} pages   entries from `ingestCorpus().pages`
 * @param {{clock: () => string, idMinter: any}} deps
 * @returns {any} a §4 BrandSystem
 */
export function buildCorpusBrand(pages, deps) {
  /** @type {string[]} */
  const css = [];
  /** @type {Map<string, any>} */
  const assets = new Map();
  for (const { capture } of pages) {
    for (const asset of capture.assets || []) {
      if (!assets.has(asset.name)) assets.set(asset.name, asset);
      if (asset.mime === 'text/css') {
        const text = DECODER.decode(asset.bytes);
        if (!css.includes(text)) css.push(text);
      }
    }
  }
  if (css.length === 0) {
    throw new Error('corpus: ingest returned no stylesheet, so there is no brand to extract (F1)');
  }

  const allAssets = [...assets.values()];
  const images = allAssets.filter((a) => a.mime === 'image/png');

  // L4 owns the solve. `extractPalette` throws rather than return a palette that
  // fails §7's 4.5:1 post-condition, which is what we want here: a corpus proof
  // that emitted with an unreadable palette would be worse than one that failed.
  const palette = colorLane.extractPalette({ css, images }, { seed: CORPUS_SEED });
  // Kept for callers that need to check what the pipeline *saw* rather than what
  // the role solve kept. §7 assigns fourteen roles; a stylesheet with more
  // colours than that legitimately leaves some of them without one, so a test
  // asserting "the brand's own colours came through" has to ask the clusters.
  lastPalette = palette;

  const home = pages[0].capture;
  return themeLane.buildBrandSystem({
    sourceUrl: CORPUS_ORIGIN,
    doc: home.doc,
    css,
    assets: allAssets,
    images,
    colors: palette.colors,
    confidence: { colors: palette.confidence },
  }, deps);
}

/**
 * Turn every capture into a `Specimen`, sharing one `MediaLedger` across the
 * whole project.
 *
 * The ledger is L6's answer to F12: the corpus's twelve `MediaRef`s are three
 * distinct sets of bytes, and without it each page inlines the shared logo and
 * hero again. Wiring it here rather than in a test is deliberate — the
 * integrator was the one who had to wire it, and a fixture that skipped it
 * would leave the emitter budgeting against a payload no real project has.
 *
 * Sibling pages are passed to every specimen so §8's repeated-across-pages
 * chrome detection has something to compare against. A page is never its own
 * sibling: passing one destroys the specimen it was meant to sharpen.
 *
 * @param {{pages: any[], documents: any[]}} captured
 * @param {{clock: () => string, idMinter: any, imageQuality?: number}} deps
 * @returns {any[]}
 */
export function buildCorpusSpecimens(captured, deps) {
  const imageQuality = deps.imageQuality || 0.85;
  const ledger = typeof specimenLane.MediaLedger === 'function'
    ? new specimenLane.MediaLedger()
    : null;
  const siblingDocs = captured.pages.map(({ capture }) => capture.doc);

  /** @type {any[]} */
  const specimens = [];

  captured.pages.forEach(({ page, capture }, index) => {
    specimens.push(specimenLane.buildSpecimen(capture, {
      kind: page.kind,
      imageQuality,
      clock: deps.clock,
      idMinter: deps.idMinter,
      ledger,
      siblings: siblingDocs.filter((_, j) => j !== index),
    }));
  });

  for (const { capture } of captured.documents) {
    specimens.push(specimenLane.buildSpecimen(capture, {
      kind: 'document',
      imageQuality,
      clock: deps.clock,
      idMinter: deps.idMinter,
      ledger,
    }));
  }

  return specimens;
}

/**
 * The recipe a specimen is run through, by the corpus entry it came from.
 * @param {any} specimen
 * @param {number} index  position in the specimen list: pages first, then documents
 * @returns {string}
 */
function recipeFor(specimen, index) {
  const page = CORPUS_PAGES[index];
  if (page && specimen.kind !== 'document') return RECIPE_FOR_PAGE[page.id] || RECIPE_FALLBACK;
  const doc = CORPUS_DOCUMENTS[index - CORPUS_PAGES.length];
  if (doc) return RECIPE_FOR_DOCUMENT[doc.id] || RECIPE_FALLBACK;
  return RECIPE_FALLBACK;
}

/**
 * Split a specimen's blocks into scene-sized sections at heading boundaries.
 *
 * A seller does not put a 498-word article on one slide, and a fixture that does
 * teaches the overflow detector to expect a shape no real deck has: the whole
 * corpus went through in six scenes and reported forty-nine overflows, most of
 * them one article's body text against one column. Sectioning is how the content
 * actually reaches a deck, so it belongs in the pipeline the fixture models.
 *
 * A section starts at a heading of level `<= SECTION_HEADING_LEVEL` and runs to
 * the next one. A section that grows past `MAX_SECTION_BLOCKS` is split again at
 * the next block boundary rather than left to overflow — the same call a seller
 * makes when a slide will not hold.
 *
 * @param {any[]} blocks
 * @returns {any[][]} sections, never empty, each non-empty
 */
export function sectionBlocks(blocks) {
  const list = (blocks || []).filter(Boolean);
  if (list.length === 0) return [];

  /** @type {any[][]} */
  const sections = [];
  /** @type {any[]} */
  let current = [];
  const flush = () => { if (current.length) { sections.push(current); current = []; } };

  for (const block of list) {
    const opensSection = block.type === 'heading'
      && Number(block.level) <= SECTION_HEADING_LEVEL
      && current.length > 0;
    if (opensSection || current.length >= MAX_SECTION_BLOCKS) flush();
    current.push(block);
  }
  flush();
  return sections;
}

/** Headings at or above this level open a new section. */
const SECTION_HEADING_LEVEL = 2;

/** No section carries more blocks than this, heading included. */
const MAX_SECTION_BLOCKS = 5;

/**
 * Run each specimen through its recipe — through `renderRecipe`, which is the
 * whole point.
 *
 * An earlier version called `buildRendition` directly with the specimen's own
 * blocks, and the §20 critic caught what that cost:
 *
 *   "It never calls `renderRecipe`. All 31 renditions are copies of their own
 *   source, labelled with recipe *names*. Overflow recall, budget honesty,
 *   provenance and layout coverage have all been measured on a proof whose
 *   'after' side is its own 'before' side."
 *
 * Every critic pass so far therefore judged a pipeline with L7's whole stage
 * skipped, and pass 2's C8 fix — `dir="rtl"` reaching the artifact — could not
 * regress-test itself here, because nothing in the proof carried a `dir` to
 * lose. §9's recipes are the product's middle; a fixture that steps over them
 * measures six sevenths of a pipeline and calls it the pipeline.
 *
 * `renderRecipe` returns a `Result`, and a failure is thrown rather than
 * skipped. A corpus proof that quietly dropped a recipe would walk straight
 * back into the same hole, one recipe at a time.
 *
 * @param {any[]} specimens
 * @param {{idMinter: any, clock: () => string}} deps
 * @returns {any[]}
 */
export function buildCorpusRenditions(specimens, deps) {
  /** @type {any[]} */
  const renditions = [];
  specimens.forEach((specimen, index) => {
    const recipeId = recipeFor(specimen, index);
    const recipe = recipeLane.recipeById(recipeId);
    // Not a fallback. A recipe id this fixture names and L7 does not publish is
    // a drift between the two, and swallowing it would leave every specimen
    // running through whichever recipe happened to be first.
    if (!recipe) throw new Error(`corpus: L7 publishes no recipe ${recipeId}`);
    if (!recipeLane.recipeAccepts(recipe, specimen)) {
      throw new Error(
        `corpus: recipe ${recipeId} does not accept a ${specimen.kind} specimen `
        + `(it takes ${recipe.inputKinds.join(', ')})`);
    }

    const result = recipeLane.renderRecipe(recipe, specimen, {
      idMinter: deps.idMinter,
      clock: deps.clock,
    });
    if (!result.ok) throw new Error(`corpus: ${recipeId} failed on ${specimen.kind} — ${result.error}`);
    if (result.value.length === 0) throw new Error(`corpus: ${recipeId} produced nothing`);

    for (const rendition of capFanOut(result.value)) renditions.push(rendition);
  });
  return renditions;
}

/** No specimen contributes more than this many renditions to the deck. */
const MAX_RENDITIONS_PER_RECIPE = 5;

/**
 * Trim a recipe's fan-out to a deck-sized number, without dropping a behaviour.
 *
 * `locale-fanout` produces nine renditions and `governed-iteration` five; a deck
 * carrying every one is a stress test of the emitter rather than a proof a
 * seller would build, and this fixture is meant to look like the latter.
 *
 * But a plain `slice(0, 5)` drops **`ar-SA`, which is ninth and is the only
 * right-to-left market in the library** — so the corpus would carry no `dir:
 * 'rtl'` anywhere, and pass 2's C8 fix (getting `dir="rtl"` into the artifact at
 * all) could not regress-test itself on the very proof every critic pass judges.
 * That is the same shape of hole the critic found in this file: coverage lost
 * quietly, in a way no test names.
 *
 * So the cap is by *distinct behaviour*, not by position: take the first N in
 * the recipe's own order, then make sure every writing direction the recipe
 * produced is represented. Direction is the one property of a rendition the
 * artifact lays out differently, which is why it is what the cap protects.
 *
 * @param {any[]} produced  renditions in the recipe's own order
 * @returns {any[]}
 */
function capFanOut(produced) {
  const kept = produced.slice(0, MAX_RENDITIONS_PER_RECIPE);
  const keptDirs = new Set(kept.map((r) => r.dir || 'ltr'));
  for (const rendition of produced.slice(MAX_RENDITIONS_PER_RECIPE)) {
    const dir = rendition.dir || 'ltr';
    if (keptDirs.has(dir)) continue;
    keptDirs.add(dir);
    kept.push(rendition);
  }
  return kept;
}

/**
 * The spine: one scene per specimen, layouts rotated so more than one of L8's
 * eight is exercised, plus a contents index at the front.
 *
 * @param {any[]} specimens
 * @param {any[]} renditions
 * @param {{idMinter: any}} deps
 * @returns {any[]}
 */
export function buildCorpusSpine(specimens, renditions, deps) {
  const specimenById = new Map(specimens.map((s) => [s.id, s]));
  return renditions.map((rendition, i) => {
    const specimen = specimenById.get(rendition.specimenId) || null;
    // The section's own leading heading is the scene's headline where it has
    // one — the client's words, not a label this fixture wrote.
    const lead = rendition.blocks.find((b) => b.type === 'heading');
    return sceneLane.buildScene({
      layout: layoutFor(rendition, i),
      specimen,
      renditions: [rendition],
      headline: (lead && lead.text) || (specimen && specimen.title) || null,
      subhead: specimen ? specimen.sourceUrl : null,
      idMinter: deps.idMinter,
    });
  });
}

/**
 * Branches, hung off the product and article specimens.
 *
 * The objections are the ones the corpus's own copy invites — it argues about
 * fouling margin and about approval chains — because §10 wants "verbatim
 * phrasing a client would use", and a jump search over invented text proves
 * nothing about a search over real text.
 *
 * @param {any[]} specimens
 * @param {any[]} renditions
 * @param {{idMinter: any}} deps
 * @returns {any[]}
 */
export function buildCorpusBranches(specimens, renditions, deps) {
  /** The first rendition of each specimen — a branch argues from its opening. */
  const byId = new Map();
  for (const r of renditions) if (!byId.has(r.specimenId)) byId.set(r.specimenId, r);
  const pick = (kind) => specimens.find((s) => s.kind === kind) || specimens[0];

  /** @type {{objection: string, aliases: string[], kind: string, layout: string, returnPolicy: string}[]} */
  const plan = [
    {
      objection: 'Your fouling margin assumptions are more optimistic than ours',
      aliases: ['fouling', 'margin', 'design margin', 'assumptions'],
      kind: 'article',
      layout: 'sideNote',
      returnPolicy: 'anchor',
    },
    {
      objection: 'This will not clear our approval chain this quarter',
      aliases: ['approvals', 'approval chain', 'procurement', 'sign-off', 'this quarter'],
      kind: 'product',
      layout: 'stack',
      returnPolicy: 'anchor',
    },
    {
      objection: 'We already have a supplier for heat exchangers',
      aliases: ['incumbent', 'existing supplier', 'switching'],
      kind: 'document',
      layout: 'splitBeforeAfter',
      returnPolicy: 'nextSpineScene',
    },
    {
      // Nested. A room does not ask its objections one at a time: the answer to
      // the approval-chain question invites the budget question, and §11's
      // return stack exists precisely so the presenter can take the second
      // without losing their way back out of the first. A deck with only flat
      // branches never exercises the unwinding, and §22.4's stranding case —
      // the one D1 was — lives entirely in the nested path.
      objection: 'Even approved, this lands in next year\'s capital budget',
      aliases: ['budget', 'capex', 'next year', 'funding'],
      kind: 'product',
      layout: 'sideNote',
      returnPolicy: 'anchor',
      // Offered from inside the approval-chain branch rather than from the spine.
      nestedUnder: 'This will not clear our approval chain this quarter',
    },
  ];

  const branches = plan.map((entry) => {
    const specimen = pick(entry.kind);
    const rendition = byId.get(specimen.id);
    return {
      id: deps.idMinter.next('branch'),
      objection: entry.objection,
      aliases: entry.aliases,
      returnPolicy: entry.returnPolicy,
      scenes: [sceneLane.buildScene({
        layout: entry.layout,
        specimen,
        renditions: [rendition].filter(Boolean),
        headline: entry.objection,
        subhead: null,
        idMinter: deps.idMinter,
      })],
      // Not part of §4's `Branch`. Carried here so `anchorBranches` can place
      // the branch, and dropped before the branch reaches the proof.
      anchorSpecimenId: specimen.id,
      nestedUnder: entry.nestedUnder || null,
    };
  });
  return branches;
}

/**
 * Put every branch on the spine scene built from the specimen it argues about,
 * and take the fixture-only anchor hint back off.
 *
 * §10's `returnPolicy: 'anchor'` returns the presenter to the scene that offered
 * the branch, so a branch nothing anchors has nowhere to return to — L11 reports
 * it as `BRANCH_NO_RETURN` and it is right to. A fixture that shipped three of
 * them would be teaching the emitter to expect a shape no real deck has.
 *
 * @param {any[]} spine
 * @param {any[]} branches
 * @returns {any[]} the branches, without the fixture-only field
 */
export function anchorBranches(spine, branches) {
  const byObjection = new Map(branches.map((b) => [b.objection, b]));
  return branches.map((branch) => {
    const { anchorSpecimenId, nestedUnder, ...rest } = branch;

    // A nested branch is offered from a scene *inside* another branch, not from
    // the spine. That is what puts a second frame on §11's return stack.
    if (nestedUnder) {
      const parent = byObjection.get(nestedUnder);
      if (!parent) throw new Error(`corpus: no branch says "${nestedUnder}" to nest under`);
      const host = parent.scenes[0];
      if (!host) throw new Error(`corpus: the branch "${nestedUnder}" has no scene to offer from`);
      if (!host.branchAnchors.includes(rest.id)) host.branchAnchors.push(rest.id);
      return rest;
    }

    const scene = spine.find((s) => s.specimenId === anchorSpecimenId) || spine[0];
    if (!scene) throw new Error('corpus: the spine is empty, so no branch can be anchored');
    if (!scene.branchAnchors.includes(rest.id)) scene.branchAnchors.push(rest.id);
    return rest;
  });
}

/**
 * Build the whole thing.
 *
 * @param {{
 *   http?: any, clock?: () => string, seed?: any,
 *   imageQuality?: number, emitOptions?: any, assertDeterministic?: boolean
 * }} [options]
 * @returns {Promise<any>} a §4 Proof
 */
export async function buildCorpusProof(options = {}) {
  const clock = options.clock || corpusClock();
  const idMinter = new IdMinter(options.seed || CORPUS_SEED);
  const deps = { clock, idMinter };

  const captured = await ingestCorpus({ http: options.http, clock });
  const brand = buildCorpusBrand(captured.pages, deps);
  const specimens = buildCorpusSpecimens(captured, { ...deps, imageQuality: options.imageQuality });
  const renditions = buildCorpusRenditions(specimens, deps);
  const spine = buildCorpusSpine(specimens, renditions, deps);
  const branches = anchorBranches(spine, buildCorpusBranches(specimens, renditions, deps));

  const recipeIds = new Set(renditions.map((r) => r.recipeId).filter(Boolean));
  const recipes = recipeLane.SEED_RECIPES.filter((r) => recipeIds.has(r.id));

  /** @type {any} */
  const proof = {
    schemaVersion: 1,
    id: `pf_${(brand.id || '').slice(-12) || 'northwind0000'}`,
    prospectName: 'Northwind Industrial',
    createdAt: clock(),
    brand,
    specimens,
    renditions,
    recipes,
    spine,
    branches,
    emitOptions: {
      mode: 'both',
      includePresenterNotes: true,
      maxBytes: 25_000_000,
      imageQuality: 0.85,
      labelIllustrativeContent: true,
      ...(options.emitOptions || {}),
    },
  };
  return proof;
}

/**
 * The corpus proof, plus everything a caller needs to check the pipeline rather
 * than only its output: what ingest fetched, what chrome was stripped, what the
 * palette solve saw.
 * @param {any} [options]
 * @returns {Promise<{proof: any, captured: any}>}
 */
export async function buildCorpusProofWithTrace(options = {}) {
  const clock = options.clock || corpusClock();
  const idMinter = new IdMinter(options.seed || CORPUS_SEED);
  const captured = await ingestCorpus({ http: options.http, clock });
  const proof = await buildCorpusProof({ ...options, clock });
  return { proof, captured, idMinter };
}

// ---------------------------------------------------------------------------
// Planted defects
// ---------------------------------------------------------------------------

/**
 * §17.4 asks for precision and recall against a corpus with known defects. The
 * planted-defect corpora each lane built measure that over synthetic text,
 * because synthetic text is the only place ground truth is knowable by
 * construction — and that is exactly the gap the §20 critic named: a detector
 * can be perfect on planted paragraphs and blind on a real page.
 *
 * A plant here injects one named defect into the corpus proof **through the
 * same published surfaces the rest of the pipeline uses**, and returns what it
 * injected. So precision and recall can be measured over the prospect's own copy
 * in real layouts, with ground truth that is still knowable — because we put it
 * there.
 *
 * What a plant may not do: reach into a lane's internals, construct a §4 record
 * by hand that no surface would produce, or plant a defect the detector is
 * already looking for by name. Each one below is a thing a seller could actually
 * do to their own deck by accident.
 *
 * @typedef {object} Plant
 * @property {string} name
 * @property {import('../../../src/core/contracts.d.ts').FindingCode} code
 * @property {string} describe   what a seller did to cause this
 * @property {boolean} [expectsNothing]  the pipeline is expected to neutralise
 *   this before the detector sees it; the plant is a negative control
 * @property {(proof: any) => any[]} apply  mutates the proof, returns the expected findings
 * @property {Record<string, string>} [alsoMoves]  other finding codes this defect
 *   legitimately implies, each with the reason. Anything *not* declared here and
 *   moved by the plant is a precision failure and fails the test.
 */

/** A token no line breaker can break, long enough to overflow any container. */
const UNBREAKABLE = 'HX400SHELLANDTUBECOUNTERFLOWCONFIGURATIONWITHREMOVABLEBUNDLEANDFLOATINGHEAD';

/** @type {Plant[]} */
export const PLANTS = [
  {
    name: 'TEXT_OVERFLOW_CLIP',
    code: 'TEXT_OVERFLOW',
    describe: 'the seller pasted an unbroken part number into a headline',
    apply(proof) {
      // A heading, because headings are the boxes layouts clip rather than clamp.
      const scene = proof.spine.find((s) => s.headline);
      if (!scene) throw new Error('corpus plant: no scene carries a headline');
      scene.headline = `${scene.headline} ${UNBREAKABLE}`;
      return [{ code: 'TEXT_OVERFLOW', sceneId: scene.id, severity: 1 }];
    },
  },
  {
    name: 'NETWORK_REFERENCE',
    code: 'NETWORK_REFERENCE',
    describe: 'the brand team\'s logo SVG links a remote raster it renders on top of',
    apply(proof) {
      // The route that actually reaches the document. §4's `LogoAsset` carries
      // the mark as `data` — SVG markup, inlined — and an SVG may reference an
      // external image. It is a real shape: a brand's "vector" logo is often a
      // vector frame around a placed raster, and the export keeps the link.
      // Nothing about it looks like a network reference until it is scanned.
      const logo = proof.brand.logos.find((l) => l.variant === 'primary') || proof.brand.logos[0];
      if (!logo) throw new Error('corpus plant: the brand carries no logo');
      if (logo.kind !== 'svg' || typeof logo.data !== 'string') {
        throw new Error('corpus plant: the primary logo is not inline SVG, so there is nothing to smuggle a link into');
      }
      logo.data = logo.data.replace(
        '</svg>',
        '  <image href="https://cdn.northwind-industrial.example/logo-raster@2x.png" x="0" y="0" width="240" height="48"/>\n</svg>');
      return [{ code: 'NETWORK_REFERENCE', logoId: logo.id, severity: 1 }];
    },
  },
  {
    // A negative control, and the one plant that expects *nothing*.
    //
    // §13's scanner refuses an absolute URL in the emitted document, and dispute
    // 31 argues that makes an outbound link in the prospect's own content a
    // severity-1 refusal. In practice it never gets that far: `scene/blocks.js`
    // renders a `cta` block's label and drops its `href`, so the URL never
    // reaches the document to be scanned. Two defences, and this asserts the
    // outer one still holds — if a layout ever starts rendering hrefs, this
    // plant starts failing before the scanner has to catch it.
    name: 'CTA_LIVE_LINK_NEUTRALISED',
    code: 'NETWORK_REFERENCE',
    expectsNothing: true,
    describe: "the seller kept a live 'Request a quote' link out of the source page",
    apply(proof) {
      const rendition = proof.renditions.find((r) => r.blocks.length > 0);
      if (!rendition) throw new Error('corpus plant: no rendition carries blocks');
      rendition.blocks = rendition.blocks.concat([{
        type: 'cta',
        label: 'Request a quote',
        href: 'https://www.northwind-industrial.example/contact/',
      }]);
      return [{ code: 'NETWORK_REFERENCE', renditionId: rendition.id, expectCount: 0 }];
    },
  },
  {
    name: 'CONTRAST_FAIL',
    code: 'CONTRAST_FAIL',
    describe: 'the seller hand-picked a body colour off the brand guide',
    apply(proof) {
      // §7's solve guarantees 4.5:1, so the only way to reach this state is the
      // one the studio offers: a manual override applied after the solve. That
      // is the path worth testing — it is the path a real failure takes.
      const onSurface = proof.brand.colors.find((c) => c.role === 'onSurface');
      const surface = proof.brand.colors.find((c) => c.role === 'surface');
      if (!onSurface || !surface) throw new Error('corpus plant: the palette has no surface pair');
      onSurface.hex = '#b9c4cf';          // ~1.9:1 on white
      onSurface.source = 'manual';
      onSurface.contrastWithPair = null;  // no longer the solver's number
      proof.brand.manualOverrides = [...(proof.brand.manualOverrides || []), 'onSurface'];
      return [{ code: 'CONTRAST_FAIL', role: 'onSurface', severity: 1 }];
    },
  },
  {
    name: 'BRANCH_NO_RETURN',
    code: 'BRANCH_NO_RETURN',
    describe: 'the seller deleted the scene a branch was hung off',
    apply(proof) {
      const branch = proof.branches.find((b) => b.returnPolicy === 'anchor');
      if (!branch) throw new Error('corpus plant: no anchored branch to strand');
      for (const scene of proof.spine) {
        scene.branchAnchors = scene.branchAnchors.filter((id) => id !== branch.id);
      }
      return [{ code: 'BRANCH_NO_RETURN', branchId: branch.id }];
    },
  },
  {
    name: 'BRANCH_UNREACHABLE',
    code: 'BRANCH_UNREACHABLE',
    describe: 'the seller cleared a branch\'s objection and deleted the scene that offered it',
    apply(proof) {
      // Subtractive on purpose. An earlier version of this plant added an
      // orphan branch with a scene of its own, and that scene's copy overflowed
      // like every other scene built from the same specimen — so the plant moved
      // `TEXT_OVERFLOW` as well, and the precision measurement was reporting the
      // fixture's own content rather than the detector's behaviour. Taking an
      // existing branch off the deck changes nothing but reachability.
      const branch = proof.branches.find((b) => b.objection);
      if (!branch) throw new Error('corpus plant: every branch is already unnamed');
      branch.objection = '';
      branch.aliases = [];
      for (const scene of proof.spine) {
        scene.branchAnchors = scene.branchAnchors.filter((id) => id !== branch.id);
      }
      return [{ code: 'BRANCH_UNREACHABLE', branchId: branch.id }];
    },
    alsoMoves: {
      // Inherent, not collateral. Nothing anchors the branch, so §10's
      // `returnPolicy: 'anchor'` has no scene to return to. Both findings are
      // true of it and both should be reported.
      BRANCH_NO_RETURN: 'an unanchored branch has no return target either',
    },
  },
  {
    name: 'ASSET_MISSING',
    code: 'ASSET_MISSING',
    describe: 'the seller removed an image the copy still refers to',
    apply(proof) {
      for (const specimen of proof.specimens) {
        const block = (specimen.blocks || []).find((b) => b.type === 'media');
        if (!block) continue;
        specimen.media = (specimen.media || []).filter((m) => m.id !== block.ref);
        for (const rendition of proof.renditions) {
          if (rendition.specimenId !== specimen.id) continue;
          rendition.media = (rendition.media || []).filter((m) => m.id !== block.ref);
        }
        return [{ code: 'ASSET_MISSING', specimenId: specimen.id, ref: block.ref, severity: 1 }];
      }
      throw new Error('corpus plant: no specimen carries a media block');
    },
  },
  {
    name: 'DUPLICATE_BRANCH_ID',
    code: 'DUPLICATE_SCENE',
    describe: 'the seller duplicated a branch to edit and never changed its id',
    apply(proof) {
      const [first, second] = proof.branches;
      if (!first || !second) throw new Error('corpus plant: fewer than two branches to collide');
      // The shadowed branch keeps its own scenes and objection — this is a
      // collision of identity, not of content, which is exactly what makes it
      // silent. `buildDeck` keeps the first and drops the second, so before
      // this was reported the presenter's key opened the wrong branch and every
      // deck-driven rule skipped the dropped branch's scenes entirely.
      const shadowedId = second.id;
      second.id = first.id;
      // Every anchor that named the second branch now names the first, which is
      // what a studio "duplicate" produces: two branches with one id, both
      // reachable in the model, one of them invisible to the deck. Leaving the
      // old anchors stale would plant a *ghost anchor* as well and the plant
      // would be measuring two defects at once.
      const allScenes = proof.spine.concat(...proof.branches.map((b) => b.scenes));
      for (const scene of allScenes) {
        scene.branchAnchors = scene.branchAnchors.map((id) => (id === shadowedId ? first.id : id));
      }
      return [{ code: 'DUPLICATE_SCENE', branchId: first.id, severity: 1 }];
    },
    alsoMoves: {
      // The corpus hangs its nested branch off a scene inside the branch that
      // gets shadowed. When that scene leaves the deck the nested branch is
      // anchored nowhere, so §10's `returnPolicy: 'anchor'` has no scene to
      // return to. **One duplicated id strands a branch two levels away**,
      // which is the clearest statement of why this is severity 1.
      //
      // `TEXT_OVERFLOW` is deliberately *not* declared here. The shadowed
      // branch's scenes do leave the sweep — that is the real harm, and L11's
      // argument for severity 1 — but on this corpus those scenes raise no
      // overflow finding, so nothing moves. Declaring it would have been a
      // plausible sentence about a number that does not change, and the
      // stale-declaration check caught it.
      BRANCH_NO_RETURN: 'a branch nested inside the shadowed one loses the scene that offered it',
    },
  },
  {
    name: 'BEAT_EMPTY',
    code: 'BEAT_EMPTY',
    describe: 'the seller swapped a scene\'s layout and left its beats pointing at the old one',
    apply(proof) {
      const scene = proof.spine.find((s) => (s.beats || []).length > 1);
      if (!scene) throw new Error('corpus plant: no scene has more than one beat');
      const beat = scene.beats[scene.beats.length - 1];
      beat.reveals = ['el_planted_nothing_reveals_this'];
      return [{ code: 'BEAT_EMPTY', sceneId: scene.id, beatId: beat.id }];
    },
  },
  {
    name: 'DUPLICATE_SCENE',
    code: 'DUPLICATE_SCENE',
    describe: 'the seller duplicated a scene and never changed it',
    apply(proof) {
      const scene = proof.spine[1] || proof.spine[0];
      if (!scene) throw new Error('corpus plant: the spine is empty');
      const specimen = proof.specimens.find((s) => s.id === scene.specimenId) || null;
      const renditions = proof.renditions.filter((r) => scene.renditionIds.includes(r.id));
      // Built by `buildScene`, not deep-copied. A structural copy keeps the
      // original's element ids, so every beat in the copy would reveal ids that
      // exist only in the scene it was copied from — three `BEAT_EMPTY` findings
      // the plant did not mean to introduce. A scene built from the same inputs
      // is what a seller's "duplicate" actually produces.
      const copy = sceneLane.buildScene({
        layout: scene.layout,
        specimen,
        renditions,
        headline: scene.headline,
        subhead: scene.subhead,
        id: `${scene.id}x`,
      });
      proof.spine = proof.spine.concat([copy]);
      return [{ code: 'DUPLICATE_SCENE', sceneId: copy.id, ofSceneId: scene.id }];
    },
    alsoMoves: {
      // Inherent. The copy renders the same text in the same containers, so it
      // overflows in the same places. A duplicate-scene detector that suppressed
      // them would be hiding findings the seller still has to fix once they keep
      // one of the two.
      TEXT_OVERFLOW: 'the copy overflows wherever the original does',
    },
  },
];

/** @param {string} name @returns {Plant} */
export function plantByName(name) {
  const plant = PLANTS.find((p) => p.name === name);
  if (!plant) throw new Error(`corpus: no plant named ${name}. Known: ${PLANTS.map((p) => p.name).join(', ')}`);
  return plant;
}

/**
 * A corpus proof with one named defect planted in it, and the ground truth for
 * what was planted.
 *
 * The clean proof is built first and asserted clean of the planted code, so a
 * plant that was already true of the corpus is caught here rather than being
 * scored as a detection.
 *
 * @param {string} name  one of `PLANTS[].name`
 * @param {any} [options]  passed to `buildCorpusProof`
 * @returns {Promise<{proof: any, plant: Plant, expected: any[]}>}
 */
export async function buildPlantedProof(name, options = {}) {
  const plant = plantByName(name);
  const proof = await buildCorpusProof(options);
  const expected = plant.apply(proof);
  if (!Array.isArray(expected) || expected.length === 0) {
    throw new Error(`corpus: plant ${name} declared no ground truth`);
  }
  return { proof, plant, expected };
}
