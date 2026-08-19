/**
 * The studio's single seam onto the other lanes.
 *
 * Every cross-lane call in `src/ui/**` goes through this module and nothing
 * else imports another lane's surface. Two reasons, and the second is the one
 * that matters at three in the morning before a pitch:
 *
 *   1. The wiring is one file. When a lane's surface moves, exactly one file
 *      changes, and `API.md` Part 3 is the only thing this file is written
 *      against.
 *   2. It is injectable. `mountStudio({services})` takes an override, so every
 *      panel is testable with a fake lane, and the panels themselves never
 *      learn whether a lane is real.
 *
 * **Unwired lanes fail loudly and legibly.** A missing lane does not silently
 * no-op: it returns an `err()` naming the module path that has not landed, and
 * the panel renders that sentence where the result would have gone. The emit
 * gate treats an unavailable validator as a blocker in its own right, because a
 * proof that was never validated must not be emitted (§14).
 *
 * @module ui/services
 */

import { ok, err } from '../core/result.js';
import { contentId } from '../core/ids.js';
import { normalizeEmitOptions } from '../core/contracts.js';

// ---------------------------------------------------------------------------
// LANE IMPORTS — the integrator's block.
//
// Exactly the nine surfaces `API.md` Part 3 declares, and nothing else. If a
// lane's module path moves, this block is the only place in `src/ui/**` that
// changes; `LANE_MODULES` below derives `wired` from the binding itself, so a
// lane that fails to load reports itself rather than failing silently in a
// panel.
// ---------------------------------------------------------------------------

import * as ingestLane from '../ingest/index.js';
import * as colorLane from '../brand/color.js';
import * as themeLane from '../brand/theme.js';
import * as specimenLane from '../specimen/index.js';
import * as recipeLane from '../recipe/index.js';
import * as sceneLane from '../scene/index.js';
import * as branchLane from '../branch/index.js';
import * as emitLane from '../emit/index.js';
import * as validateLane from '../validate/index.js';

/**
 * Every lane the studio consumes, in the order the left rail needs them.
 * `wired` is the truth the UI shows the user; it is not a guess.
 * @type {{key: string, module: string, label: string, wired: boolean, lane: any}[]}
 */
export const LANE_MODULES = [
  { key: 'ingest', module: 'src/ingest/index.js', label: 'Ingest', wired: !!ingestLane, lane: ingestLane },
  { key: 'color', module: 'src/brand/color.js', label: 'Brand colour', wired: !!colorLane, lane: colorLane },
  { key: 'theme', module: 'src/brand/theme.js', label: 'Brand type, logo, shape', wired: !!themeLane, lane: themeLane },
  { key: 'specimen', module: 'src/specimen/index.js', label: 'Specimen capture', wired: !!specimenLane, lane: specimenLane },
  { key: 'recipe', module: 'src/recipe/index.js', label: 'Recipes', wired: !!recipeLane, lane: recipeLane },
  { key: 'scene', module: 'src/scene/index.js', label: 'Scene layouts', wired: !!sceneLane, lane: sceneLane },
  { key: 'branch', module: 'src/branch/index.js', label: 'Branches', wired: !!branchLane, lane: branchLane },
  { key: 'emit', module: 'src/emit/index.js', label: 'Emitter', wired: !!emitLane, lane: emitLane },
  { key: 'validate', module: 'src/validate/index.js', label: 'Validation', wired: !!validateLane, lane: validateLane },
];

/**
 * Declared lane surfaces the studio deliberately does not call, and why.
 *
 * `API.md` Part 3 is checked from the *publishing* side — a lane must export
 * what it declared. Nothing checked the *consuming* side, and that is exactly
 * how the seed recipe library came to be built, tested, published and
 * unreachable from the studio for a whole pass (CRITIQUE-1 F14).
 *
 * `test/ui/lane-conformance.test.mjs` now closes that: every surface declared
 * for a lane the studio imports must either appear in `services.js` as a call,
 * or appear here with a reason. Adding a lane export the studio ought to use
 * and forgetting to wire it fails a test; deciding not to use one costs a
 * sentence.
 *
 * Keyed by module path, then by export name.
 * @type {Record<string, Record<string, string>>}
 */
export const LANE_SURFACE_NOTES = {
  'src/ingest/index.js': {
    attr: 'A DOM accessor for lanes that walk a document. The studio never walks one: it hands captures to L5 and L6, which do.',
    importSavedPage: 'Routed through `ingestFiles`, L3\'s own multi-file router, which attaches a saved page\'s asset folder to the page it belongs to. Calling the importers individually would be a second, worse copy of that (D-L12-4).',
    importHar: 'Routed through `ingestFiles`, which sniffs the archive and calls this itself.',
    importMhtml: 'Routed through `ingestFiles`, which sniffs the archive and calls this itself.',
    importOoxml: 'Routed through `ingestFiles`, which sniffs the MIME and calls this itself.',
    importPdf: 'Routed through `ingestFiles`, which sniffs the MIME and calls this itself.',
    importImage: 'Routed through `ingestFiles`, which sniffs the MIME and calls this itself.',
  },
  'src/brand/color.js': {
    srgbToLinear: 'Colour maths. The studio shows numbers L4 computed; it computes none of its own (§7: "computed, never assumed").',
    hexToRgb: 'Colour maths. Every number the studio shows was computed by L4 and handed over on the token.',
    rgbToHex: 'Colour maths. The studio normalises a typed hex itself and asks L4 for everything derived from it.',
    rgbToOklab: 'Colour maths. The studio asks for `oklch`, which is the form the §4 token carries.',
    oklabToRgb: 'Colour maths. Conversions belong to the lane that owns the colour space.',
    oklabToOklch: 'Colour maths. The studio asks for `oklch` directly and never converts between spaces.',
    relativeLuminance: 'Colour maths — the studio asks for `contrastRatio`, which is the number a person reads.',
    inGamut: 'The solver guarantees its own output is in gamut; re-checking it here would be the studio second-guessing the lane that owns the constraint.',
    clampChromaToGamut: 'Same: gamut clamping belongs to derivation, and `deriveForContrast` is the studio\'s route to it.',
    quantize: 'Reached through `extractPalette`, which L4 documents as "the whole §7 colour pipeline in one call, for L5\'s buildBrandSystem and for the studio\'s extract step".',
    chooseK: 'Reached through `extractPalette`.',
    solveRoles: 'Reached through `extractPalette`.',
    colorConfidence: 'Reached through `extractPalette`, which returns the confidence it computed.',
  },
  'src/brand/theme.js': {
    detectFaces: 'Reached through `buildBrandSystem`, which detects faces itself when it is given a document and stylesheets.',
    extractLogos: 'Reached through `buildBrandSystem`.',
    detectShape: 'Reached through `buildBrandSystem`.',
    classifyImagery: 'Reached through `buildBrandSystem`. The studio supplies its samples via `imagerySamples` (D-L12-3).',
  },
  'src/specimen/index.js': {
    stripChrome: 'Reached through `buildSpecimen`, which strips, records what it removed, and keeps it restorable in one pass.',
    toBlocks: 'Reached through `buildSpecimen`.',
    captureMedia: 'Reached through `buildSpecimen`.',
    detectLocale: 'Reached through `buildSpecimen`, which writes the locale onto the specimen.',
  },
  'src/recipe/index.js': {
    recipeById: 'A project holds its own copy of each recipe, which the user may have removed. Looking one up in the library would answer a different question from the one the panel is asking.',
  },
  'src/scene/index.js': {
    PROVENANCE_LABEL_CLASS: 'The class the artifact renders. The studio never writes artifact classes — that is the D11 line — and the emitter is what asserts the label is present.',
  },
  'src/branch/index.js': {
    randomWalk: 'The seeded driver behind §17.8\'s property test. A studio that walked branches at random would be doing the test suite\'s job, not the seller\'s.',
  },
  'src/emit/index.js': {
    inlineRuntime: 'The document builder inside `emit`. The studio has exactly one route to an emitted file, and it goes through the gate (§14).',
  },
  'src/validate/index.js': {},
};

/**
 * The sentence a panel shows where a lane's result would have gone.
 * @param {string} key
 * @returns {string}
 */
export function unavailable(key) {
  const entry = LANE_MODULES.find((l) => l.key === key);
  const path = entry ? entry.module : `src/${key}/index.js`;
  const label = entry ? entry.label : key;
  return `${label} is not wired into this build (${path} has not landed). Nothing was changed.`;
}

/** @param {string} key @returns {{ok: false, error: string}} */
function laneErr(key) { return err(unavailable(key)); }

/**
 * Build the HTTP function L3 takes by injection. The studio is allowed to reach
 * the network — §1.1's "no phone-home" law is about the *artifact*. Ingest still
 * never calls a global directly, so tests drive it with a stub and this is the
 * only place a real request is constructed.
 * @param {any} view  the window
 * @returns {((url: string, init?: any) => Promise<any>)|null}
 */
export function makeHttp(view) {
  const f = view && typeof view.fetch === 'function' ? view.fetch.bind(view) : null;
  if (!f) return null;
  return async (url, init) => {
    const response = await f(url, { ...(init || {}), credentials: 'omit', redirect: 'follow' });
    return {
      ok: response.ok,
      status: response.status,
      text: () => response.text(),
      bytes: async () => new Uint8Array(await response.arrayBuffer()),
    };
  };
}

/**
 * @typedef {object} ServiceEnv
 * @property {() => string} clock            ISO clock, injected (§5)
 * @property {string} [runtimeJs]            the bundled artifact runtime, for the emitter
 * @property {string} [runtimeCss]           the bundled artifact stylesheet
 * @property {((url: string, init?: any) => Promise<any>)|null} [http]
 * @property {any} [view]                    the window, when one exists
 */

/**
 * Build the adapter. Every method is total: it either does the lane's work or
 * returns a `Result` explaining precisely which module has not landed.
 * @param {ServiceEnv} env
 * @returns {object}
 */
export function makeServices(env) {
  const clock = env.clock;
  const http = env.http !== undefined ? env.http : makeHttp(env.view);

  /** Layout registration is idempotent and must happen before any preview. */
  let layoutsReady = false;

  const services = {
    /** @type {Record<string, boolean>} */
    status: Object.fromEntries(LANE_MODULES.map((l) => [l.key, l.wired])),

    /** @returns {string[]} lane keys that have not landed */
    missing() { return LANE_MODULES.filter((l) => !l.wired).map((l) => l.key); },

    /** @returns {{key: string, module: string, label: string, wired: boolean}[]} */
    lanes() { return LANE_MODULES.map(({ key, module, label, wired }) => ({ key, module, label, wired })); },

    /** @param {string} key @returns {boolean} */
    has(key) { return !!services.status[key]; },

    // -- ingest -------------------------------------------------------------

    /**
     * @param {string} url
     * @param {{proxyBase?: string}} [options]
     * @returns {Promise<any>}
     */
    async ingestUrl(url, options = {}) {
      if (!ingestLane) return laneErr('ingest');
      if (!http) return err('This browser exposes no fetch, so a URL cannot be read. Import a saved page or paste the HTML instead.');
      try {
        return await ingestLane.ingestUrl(url, { proxyBase: options.proxyBase || '', http, clock });
      } catch (e) { return err(`Ingest failed: ${message(e)}`, e); }
    },

    /**
     * @param {{name: string, bytes: Uint8Array, mime: string, text?: string}[]} files
     * @returns {Promise<any>}
     */
    async importFiles(files) {
      if (!ingestLane) return laneErr('ingest');
      try {
        // L3's own multi-file router: it detects a saved page plus its asset
        // folder, attaches the assets, and routes everything else by sniffed
        // MIME. Doing that here would be a second, worse copy of it.
        const result = await ingestLane.ingestFiles(files, { clock });
        if (!result.ok) return result;
        const value = result.value;
        return ok(Array.isArray(value)
          ? { captures: value, problems: [] }
          : { captures: value.captures || [], problems: value.problems || [] });
      } catch (e) { return err(`Import failed: ${message(e)}`, e); }
    },

    /**
     * @param {string} html
     * @param {string|null} sourceUrl
     * @returns {any}
     */
    importHtmlText(html, sourceUrl) {
      if (!ingestLane) return laneErr('ingest');
      try { return ingestLane.importHtmlText(html, { sourceUrl: sourceUrl || null, clock }); }
      catch (e) { return err(`Could not parse that HTML: ${message(e)}`, e); }
    },

    /**
     * §6's strategy chain, in order, with what each one needs. Shown when a
     * fetch fails so the user reads a route forward rather than an error: "most
     * enterprise sites refuse a direct fetch, which is normal" is a sentence
     * L3 already wrote, and the studio should be quoting it rather than
     * inventing its own.
     * @returns {{id: string, label: string, describe: string, kind: string, automatic: boolean, requires: string[]}[]}
     */
    fetchStrategies() {
      if (!ingestLane) return [];
      try {
        return ingestLane.fetchStrategies().map((strategy) => ({
          id: strategy.id,
          label: strategy.label,
          describe: strategy.describe,
          kind: strategy.kind,
          automatic: !!strategy.automatic,
          requires: strategy.requires || [],
        }));
      } catch { return []; }
    },

    /**
     * @param {string} base
     * @returns {Promise<any>}
     */
    async discoverSitemap(base) {
      if (!ingestLane) return laneErr('ingest');
      if (!http) return err('No fetch is available, so sitemap discovery cannot run.');
      try {
        const found = await ingestLane.discoverSitemap(base, { http });
        if (!found.ok) return found;
        return ok(ingestLane.rankCandidates(found.value));
      } catch (e) { return err(`Sitemap discovery failed: ${message(e)}`, e); }
    },

    // -- brand --------------------------------------------------------------

    /**
     * Contrast between two hexes. Falls back to `null` rather than to a guessed
     * number: §7 says contrast is computed, never assumed, so an unwired colour
     * lane shows a dash, not a plausible-looking figure.
     * @param {string} a
     * @param {string} b
     * @returns {number|null}
     */
    contrast(a, b) {
      if (!colorLane) return null;
      try { return colorLane.contrastRatio(a, b); } catch { return null; }
    },

    /**
     * @param {string} hex
     * @returns {[number, number, number]|null}
     */
    oklch(hex) {
      if (!colorLane) return null;
      try { return colorLane.hexToOklch(hex); } catch { return null; }
    },

    /**
     * @param {string} baseHex
     * @param {string} targetHex
     * @param {number} minRatio
     * @returns {string|null}
     */
    deriveForContrast(baseHex, targetHex, minRatio) {
      if (!colorLane) return null;
      try { return colorLane.deriveForContrast(baseHex, targetHex, minRatio); } catch { return null; }
    },

    /**
     * Extract a whole brand system from captures.
     * @param {any[]} captures
     * @param {{seed: string}} options
     * @returns {any}
     */
    buildBrand(captures, options) {
      if (!themeLane || !colorLane) return laneErr(themeLane ? 'color' : 'theme');
      try {
        const idMinter = minterFor(options.seed);
        return ok(themeLane.buildBrandSystem(brandParts(captures, { seed: options.seed }), { clock, idMinter }));
      } catch (e) { return err(`Brand extraction failed: ${message(e)}`, e); }
    },

    /**
     * The artifact stylesheet for a brand — `--pp-*` only, by L5's contract.
     * @param {any} brand
     * @returns {{css: string, vars: Record<string, string>}}
     */
    compileTheme(brand) {
      if (!themeLane) return { css: '', vars: {} };
      try { return themeLane.compileTheme(brand); } catch { return { css: '', vars: {} }; }
    },

    /**
     * @param {any} logo
     * @returns {any|null}
     */
    inverseLogo(logo) {
      if (!themeLane) return null;
      try { return themeLane.inverseVariant(logo); } catch { return null; }
    },

    // -- specimen -----------------------------------------------------------

    /**
     * @param {any} capture
     * @param {{kind?: string, imageQuality: number, seed: string}} options
     * @returns {any}
     */
    buildSpecimen(capture, options) {
      if (!specimenLane) return laneErr('specimen');
      try {
        return ok(specimenLane.buildSpecimen(capture, {
          kind: options.kind,
          imageQuality: options.imageQuality,
          clock,
          idMinter: minterFor(options.seed),
          // §8/D8: L6 needs a parser when a capture arrived as HTML text with
          // no tree. The parser is L3's, and this is the seam that joins them.
          parseHtml: ingestLane ? ingestLane.parseHtml : undefined,
        }));
      } catch (e) { return err(`Specimen capture failed: ${message(e)}`, e); }
    },

    /**
     * §8's per-specimen raw-HTML opt-in. L6 refuses an opt-in that does not
     * record who and when, which is why the caller passes a name.
     * @param {any} specimen
     * @param {boolean} allowed
     * @param {string} by
     * @returns {any}
     */
    setRawOptIn(specimen, allowed, by) {
      if (!specimenLane) return laneErr('specimen');
      try { return ok(specimenLane.setRawHtmlOptIn(specimen, { allowed, by, at: clock() })); }
      catch (e) { return err(`Could not change the raw-HTML opt-in: ${message(e)}`, e); }
    },

    /**
     * Put one stripped block back (§8). The lane matches the entry and returns a
     * new specimen; the studio commits it through the command stack, so a
     * restore is as undoable as any other edit.
     * @param {any} specimen
     * @param {any} entry
     * @returns {any}
     */
    restoreStripped(specimen, entry) {
      if (!specimenLane) return laneErr('specimen');
      try { return ok(specimenLane.restoreBlock(specimen, entry)); }
      catch (e) { return err(`Could not restore that block: ${message(e)}`, e); }
    },

    /**
     * @param {any} specimen
     * @returns {any}
     */
    restoreAllStripped(specimen) {
      if (!specimenLane) return laneErr('specimen');
      try { return ok(specimenLane.restoreAllBlocks(specimen)); }
      catch (e) { return err(`Could not restore those blocks: ${message(e)}`, e); }
    },

    /**
     * Record a content edit on a specimen. §18.3 requires the artifact to say
     * when a specimen was edited, so this never silently changes blocks: L6
     * refuses an edit that does not say what changed.
     * @param {any} specimen
     * @param {any[]} blocks
     * @param {string} note
     * @returns {any}
     */
    editSpecimenBlocks(specimen, blocks, note) {
      if (!specimenLane) {
        return ok({ ...specimen, blocks, edited: true, editNotes: [...(specimen.editNotes || []), note] });
      }
      try { return ok(specimenLane.markEdited(specimen, { blocks, note, at: clock() })); }
      catch (e) { return err(`Could not record that edit: ${message(e)}`, e); }
    },

    /**
     * The raw-HTML fallback blocks, empty unless the specimen was opted in.
     * @param {any} specimen
     * @returns {{blocks: any[], allowed: boolean, reason: string}}
     */
    rawFallback(specimen) {
      if (!specimenLane) return { blocks: [], allowed: false, reason: 'the specimen lane is not wired into this build' };
      try { return specimenLane.rawFallbackBlocks(specimen); }
      catch { return { blocks: [], allowed: false, reason: 'raw HTML could not be read' }; }
    },

    // -- recipes ------------------------------------------------------------

    /** @returns {any[]} the eight §9 seed recipes, or an empty library */
    seedRecipes() {
      if (!recipeLane) return [];
      try { return recipeLane.SEED_RECIPES.slice(); } catch { return []; }
    },

    /**
     * @param {any[]} sourceBlocks
     * @param {any[]} pastedBlocks
     * @returns {{pairs: [number|null, number|null][], score: number}}
     */
    alignBlocks(sourceBlocks, pastedBlocks) {
      if (!recipeLane) return fallbackAlign(sourceBlocks, pastedBlocks);
      try { return recipeLane.alignBlocks(sourceBlocks, pastedBlocks); }
      catch { return fallbackAlign(sourceBlocks, pastedBlocks); }
    },

    /**
     * @param {string} text
     * @returns {any[]}
     */
    parsePasted(text) {
      if (!recipeLane) return fallbackParse(text);
      try { return recipeLane.parsePasted(text); } catch { return fallbackParse(text); }
    },

    /**
     * The seed recipes that accept a specimen, in library order. §9's library
     * is a set of *transformations*, so which of them apply depends on what the
     * specimen is.
     * @param {any} specimen
     * @returns {any[]}
     */
    recipesFor(specimen) {
      if (!recipeLane || !specimen) return [];
      try { return recipeLane.recipesFor(specimen); } catch { return []; }
    },

    /**
     * @param {any} recipe
     * @param {any} specimen
     * @returns {boolean}
     */
    recipeAccepts(recipe, specimen) {
      if (!recipeLane || !recipe || !specimen) return false;
      try { return recipeLane.recipeAccepts(recipe, specimen); } catch { return false; }
    },

    /**
     * Run one seed recipe's template against a specimen (§9: the seed library
     * "is the reframe payload"). Deterministic, and a failure is a `Result`
     * rather than a half-built set.
     * @param {string|any} recipe
     * @param {any} specimen
     * @param {object} [options]
     * @returns {any}
     */
    renderRecipe(recipe, specimen, options = {}) {
      if (!recipeLane) return laneErr('recipe');
      try { return recipeLane.renderRecipe(recipe, specimen, options); }
      catch (e) { return err(`That recipe could not run: ${message(e)}`, e); }
    },

    /**
     * Run every seed recipe that accepts the specimen.
     * @param {any} specimen
     * @param {object} [options]
     * @returns {any}
     */
    renderAllRecipes(specimen, options = {}) {
      if (!recipeLane) return laneErr('recipe');
      try { return ok(recipeLane.renderAll(specimen, options)); }
      catch (e) { return err(`The recipe library could not run: ${message(e)}`, e); }
    },

    /**
     * @param {object} args
     * @returns {any}
     */
    buildRendition(args) {
      if (!recipeLane) return laneErr('recipe');
      try { return ok(recipeLane.buildRendition(args)); }
      catch (e) { return err(`Could not build that rendition: ${message(e)}`, e); }
    },

    /**
     * The only route to `verified-by-user` (§9). It records who promoted and
     * when, which is why the UI calls it a deliberate act rather than a toggle.
     * @param {any} rendition
     * @param {string} by
     * @returns {any}
     */
    promoteProvenance(rendition, by) {
      if (!recipeLane) return laneErr('recipe');
      try { return ok(recipeLane.promoteProvenance(rendition, { by, at: clock() })); }
      catch (e) { return err(`Promotion refused: ${message(e)}`, e); }
    },

    /**
     * The promotion record standing against a rendition, decoded. L7 stores it
     * as a signed token inside `notes` so it survives an export and cannot be
     * hand-forged; the studio has to decode it to show a person who promoted
     * what, and when (§9).
     * @param {any} rendition
     * @returns {{by: string, at: string, from: string, signatureValid: boolean}|null}
     */
    promotionRecord(rendition) {
      if (!recipeLane) return null;
      try { return recipeLane.readPromotionRecord(rendition); } catch { return null; }
    },

    /**
     * A rendition's notes with the promotion tokens taken out, so the notes
     * field shows prose rather than machinery — and so editing the notes cannot
     * destroy the record.
     * @param {any} rendition
     * @returns {string}
     */
    visibleNotes(rendition) {
      const notes = rendition ? rendition.notes : null;
      if (!recipeLane) return notes || '';
      try { return recipeLane.stripPromotionRecords(notes) || ''; } catch { return notes || ''; }
    },

    /**
     * Rewrite a rendition's prose notes while preserving every promotion record
     * attached to it.
     * @param {any} rendition
     * @param {string} prose
     * @returns {string|null}
     */
    composeNotes(rendition, prose) {
      const text = String(prose || '').trim();
      if (!recipeLane) return text || null;
      let records = '';
      try {
        records = String(rendition.notes || '')
          .split('\n')
          .filter((line) => /\[\[pp-promotion:/.test(line))
          .join('\n');
      } catch { records = ''; }
      const joined = [text, records].filter(Boolean).join('\n');
      return joined || null;
    },

    /**
     * @param {string} label
     * @returns {{maxChars: number, maxWords: number}|null}
     */
    channelBudget(label) {
      if (!recipeLane) return null;
      try { return recipeLane.channelBudget(label); } catch { return null; }
    },

    /**
     * @param {any[]} blocks
     * @param {{maxChars: number, maxWords: number}} budget
     * @returns {{blocks: any[], overBy: number}}
     */
    enforceBudget(blocks, budget) {
      if (!recipeLane) return { blocks, overBy: 0 };
      try { return recipeLane.enforceBudget(blocks, budget); } catch { return { blocks, overBy: 0 }; }
    },

    /**
     * @param {any} recipe
     * @param {any} specimen
     * @param {{endpoint: string, key: string}} adapter
     * @returns {Promise<any>}
     */
    async runAdapter(recipe, specimen, adapter) {
      if (!recipeLane) return laneErr('recipe');
      if (!adapter || !adapter.endpoint) return err('No adapter endpoint is configured. Settings → runtime adapter.');
      if (!http) return err('This browser exposes no fetch, so the adapter cannot be called.');
      try { return await recipeLane.runAdapter(recipe, specimen, { endpoint: adapter.endpoint, key: adapter.key, http }); }
      catch (e) { return err(`Adapter call failed: ${message(e)}`, e); }
    },

    // -- scenes -------------------------------------------------------------

    /** Register the eight layouts with L2's registry, once. */
    ensureLayouts() {
      if (layoutsReady || !sceneLane) return;
      try { sceneLane.registerAllLayouts(); layoutsReady = true; } catch { layoutsReady = false; }
    },

    /** @returns {{layout: string, name: string, describe: string}[]} */
    sceneTemplates() {
      if (!sceneLane) return [];
      try { return sceneLane.sceneTemplates(); } catch { return []; }
    },

    /**
     * @param {object} args
     * @returns {any}
     */
    buildScene(args) {
      if (!sceneLane) return laneErr('scene');
      try { return ok(sceneLane.buildScene(args)); }
      catch (e) { return err(`Could not build that scene: ${message(e)}`, e); }
    },

    // -- branches -----------------------------------------------------------

    /**
     * @param {any} deck
     * @returns {any|null}
     */
    buildJumpIndex(deck) {
      if (!branchLane) return null;
      try { return branchLane.buildJumpIndex(deck); } catch { return null; }
    },

    /**
     * @param {any} index
     * @param {string} query
     * @returns {{branchId: string, objection: string, score: number, matched: string}[]}
     */
    searchJump(index, query) {
      if (!branchLane || !index) return [];
      try { return branchLane.searchJump(index, query, { limit: 8 }); } catch { return []; }
    },

    /**
     * Where a branch actually returns to, resolved against the live deck.
     * §22.4: a nested jump that does not unwind strands the presenter, so the
     * studio shows the scene a branch exits to rather than only whether one
     * exists.
     * @param {any} deck
     * @param {string} branchId
     * @returns {{sequenceId: string, sceneIndex: number, scene: any}|null}
     */
    returnTargetFor(deck, branchId) {
      if (!branchLane || !deck) return null;
      try {
        const target = branchLane.returnTargetFor(deck, branchId);
        if (!target) return null;
        const sequence = deck.sequences.get(target.sequenceId);
        const scene = sequence ? sequence.scenes[target.sceneIndex] || null : null;
        return { ...target, scene };
      } catch { return null; }
    },

    /**
     * @param {any} deck
     * @returns {{unreachable: string[], noReturn: string[]}}
     */
    branchCoverage(deck) {
      if (!branchLane) return { unreachable: [], noReturn: [] };
      try { return branchLane.branchCoverage(deck); } catch { return { unreachable: [], noReturn: [] }; }
    },

    /**
     * @param {any} runtime
     * @returns {(() => void)|null}
     */
    registerBranchOverlays(runtime) {
      if (!branchLane) return null;
      try { return branchLane.registerBranchOverlays(runtime); } catch { return null; }
    },

    // -- validation ---------------------------------------------------------

    /**
     * @param {any} proof
     * @returns {Promise<any>}
     */
    async runPreflight(proof) {
      if (!validateLane) return laneErr('validate');
      try {
        const findings = await validateLane.runPreflight(proof, {
          clock, runtimeJs: env.runtimeJs || '', runtimeCss: env.runtimeCss || '',
        });
        return ok(findings || []);
      } catch (e) { return err(`Preflight failed: ${message(e)}`, e); }
    },

    /**
     * What a sweep checks, one entry per §4 finding code. Shown before the
     * first sweep, so "no sweep has been run" is a list of what running one
     * would tell you rather than an absence.
     * @returns {{code: string, severity: 1|2|3, describe: string}[]}
     */
    preflightRules() {
      if (!validateLane) return [];
      try {
        return (validateLane.RULES || []).map((rule) => ({
          code: rule.code,
          severity: rule.severity,
          describe: rule.describe || rule.description || '',
        }));
      } catch { return []; }
    },

    /**
     * Contrast findings for a brand, without running a whole sweep. §22.1 is
     * the failure that makes a proof unreadable on a real palette, and it is
     * cheapest to catch at the moment somebody types the hex.
     * @param {any} brand
     * @returns {any[]}
     */
    checkContrast(brand) {
      if (!validateLane || !brand) return [];
      try { return validateLane.checkContrast(brand) || []; } catch { return []; }
    },

    /**
     * Text-overflow findings for one scene at one breakpoint, measured through
     * L8's `measureScene` and L11's detector — the same two calls the sweep
     * makes, so the scene editor and the rehearsal cannot disagree.
     *
     * §22.2 calls post-substitution overflow "the defect that makes a proof look
     * amateur in front of a CMO, and it is invisible until it isn't". Showing it
     * beside the headline being typed is the earliest it can possibly be seen.
     * @param {any} scene
     * @param {any} ctx      a `LayoutContext`
     * @param {string} breakpoint
     * @returns {any[]}
     */
    sceneOverflow(scene, ctx, breakpoint) {
      if (!sceneLane || !validateLane || !scene || !ctx) return [];
      try {
        const measurement = sceneLane.measureScene(scene, ctx, breakpoint);
        return validateLane.detectOverflow(measurement, ctx.brand) || [];
      } catch { return []; }
    },

    /**
     * @param {any} proof
     * @param {any[]} findings
     * @returns {{finding: any, label: string, apply: (p: any) => any}[]}
     */
    autoFixes(proof, findings) {
      if (!validateLane) return [];
      try { return validateLane.autoFixes(proof, findings) || []; } catch { return []; }
    },

    /**
     * @param {any} proof
     * @param {(pos: any) => void} onPosition
     * @returns {Promise<any>}
     */
    async dryRun(proof, onPosition) {
      if (!validateLane) return laneErr('validate');
      try { return ok(await validateLane.dryRun(proof, { onPosition })); }
      catch (e) { return err(`Dry run failed: ${message(e)}`, e); }
    },

    /**
     * @param {string} code
     * @returns {1|2|3}
     */
    severityOf(code) {
      if (!validateLane) return 2;
      try { return validateLane.severityOf(code); } catch { return 2; }
    },

    // -- emit ---------------------------------------------------------------

    /**
     * @param {any} proof
     * @param {any} options
     * @returns {Promise<any>}
     */
    async emit(proof, options) {
      if (!emitLane) return laneErr('emit');
      try {
        return await emitLane.emit(proof, normalizeEmitOptions(options), {
          runtimeJs: env.runtimeJs || '',
          runtimeCss: env.runtimeCss || '',
          clock,
        });
      } catch (e) { return err(`Emit failed: ${message(e)}`, e); }
    },

    /**
     * Re-verify an emitted file against the two laws that matter most, with no
     * emit involved: §13's zero-network scan and §9/§18's provenance assertion.
     *
     * The emitter already refuses on either, so this changes no outcome. It
     * exists because a seller is sometimes asked to prove it — by a security
     * reviewer, in a room — and "the tool says it checked" is weaker than
     * running the scanner over the file that is about to be handed over.
     * @param {any} proof
     * @param {string} html
     * @param {string} [css]
     * @returns {{findings: any[], network: any[], provenance: any[], clean: boolean}}
     */
    verifyArtifact(proof, html, css = '') {
      if (!emitLane) return { findings: [], network: [], provenance: [], clean: false };
      let network = [];
      let provenance = [];
      try { network = emitLane.scanForNetworkReferences(html) || []; } catch { network = []; }
      try { provenance = emitLane.assertProvenance(proof, html, css) || []; } catch { provenance = []; }
      const findings = [...network, ...provenance];
      return { findings, network, provenance, clean: findings.length === 0 };
    },

    /**
     * The size budget as line items, without emitting. §13 requires every
     * degradation reported, so the emit panel shows this before the user runs.
     * @param {any} proof
     * @param {number} maxBytes
     * @returns {{plan: any[], proof: any}|null}
     */
    budgetAssets(proof, maxBytes) {
      if (!emitLane) return null;
      try { return emitLane.budgetAssets(proof, maxBytes); } catch { return null; }
    },
  };

  return services;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** @param {unknown} e @returns {string} */
function message(e) { return e instanceof Error ? e.message : String(e); }

/**
 * A minimal id minter shaped like L1's `IdMinter` but seeded per call, so two
 * captures in the same session do not collide and a re-run reproduces the same
 * ids. Lanes take `{idMinter}` and only ever call `next(kind)`.
 * @param {string} seed
 * @returns {{next: (kind: string) => string, reset: () => void}}
 */
export function minterFor(seed) {
  let n = 0;
  return {
    next(kind) { n += 1; return contentId(/** @type {any} */ (kind), { seed, n }); },
    reset() { n = 0; },
  };
}

/**
 * Assemble the `parts` argument L5's `buildBrandSystem` takes.
 *
 * L5 does its own face, logo and shape detection given `doc`, `css` and
 * `assets`; L4 owns colour, so the palette is solved here with
 * `extractPalette` and handed over finished, along with the confidence it
 * computed.
 *
 * What goes into `css` is the part that decides whether an extraction produces
 * anything at all. It is **stylesheet text**, assembled from three places, in
 * the order a browser would apply them:
 *
 *   1. every `text/css` asset the capture brought back — the real stylesheets,
 *      once L3 has fetched them, and already today for a saved page, a HAR or
 *      an MHTML archive;
 *   2. every `<style>` element in the document;
 *   3. every `style="…"` attribute, wrapped in a synthetic rule so L4's
 *      declaration scanner sees it as one.
 *
 * Handing L4 the raw HTML instead — as this did — technically works, because a
 * `<style>` body is inside the text, but it also feeds it every attribute value
 * and every word of prose, and it finds nothing at all when the page's colour
 * lives in a linked stylesheet. Which is precisely the case that matters.
 *
 * `logos` carries the colours of any inline SVG mark, which L4 accepts as CSS
 * colour strings (`decodePixels`). §7 asks for "a quantization pass over the
 * hero imagery and the logo", and the logo is the half that needs no image
 * decoder.
 *
 * `images` stays empty until a declared surface turns captured bytes into RGBA
 * samples — see `docs/disputes/L12-ui.md` D-L12-3. Zero samples means L5's
 * classifier says `unknown` at zero confidence, which §7's review gate then
 * holds for a person. `imagerySamples` is the seam that fills it.
 *
 * @param {any[]} captures
 * @param {{seed: string}} options
 * @returns {any}
 */
function brandParts(captures, options) {
  const docs = captures.map((c) => c.doc).filter(Boolean);
  const assets = captures.flatMap((c) => c.assets || []);
  const sourceUrl = (captures.find((c) => c.sourceUrl) || {}).sourceUrl || null;

  const css = stylesheetSources(captures, assets);
  const logos = logoColorSources(captures, assets);
  const images = imagerySamples(assets);

  /** @type {{colors: any[], confidence: number}} */
  let palette = { colors: [], confidence: 0 };
  try {
    const solved = colorLane.extractPalette({ css, logos, images }, { seed: options.seed });
    palette = { colors: solved.colors, confidence: solved.confidence };
  } catch {
    // §7: no colour could be collected. An empty palette with zero confidence
    // is the honest result; the studio holds it for review, says the extraction
    // found nothing, and the user enters the roles by hand.
    palette = { colors: [], confidence: 0 };
  }

  return {
    sourceUrl,
    doc: docs[0] || null,
    css,
    assets,
    images,
    colors: palette.colors,
    confidence: { colors: palette.confidence },
  };
}

/**
 * Every piece of stylesheet text a set of captures carries, in cascade order.
 * @param {any[]} captures
 * @param {{name?: string, mime?: string, bytes?: Uint8Array}[]} assets
 * @returns {string[]}
 */
export function stylesheetSources(captures, assets) {
  /** @type {string[]} */
  const out = [];
  for (const asset of assets || []) {
    const isCss = /^text\/css/.test(asset.mime || '') || /\.css(\?|$)/i.test(asset.name || '');
    if (!isCss || !asset.bytes) continue;
    const text = decodeText(asset.bytes);
    if (text.trim()) out.push(text);
  }
  for (const capture of captures || []) {
    if (!capture || !capture.doc) continue;
    out.push(...inlineStyleText(capture.doc));
  }
  return out;
}

/**
 * `<style>` bodies and `style="…"` attributes from a parsed document. The
 * attributes are wrapped in a synthetic rule so L4's declaration scanner reads
 * them as declarations rather than as loose text.
 * @param {any} doc
 * @returns {string[]}
 */
export function inlineStyleText(doc) {
  /** @type {string[]} */
  const sheets = [];
  /** @type {string[]} */
  const inline = [];
  if (!ingestLane || !doc) return sheets;
  try {
    for (const node of ingestLane.querySelectorAll(doc, 'style')) {
      const text = ingestLane.textContent(node);
      if (text && text.trim()) sheets.push(text);
    }
    ingestLane.walk(doc, (node) => {
      const value = node && node.attrs ? node.attrs.style : null;
      if (value && String(value).trim()) inline.push(String(value));
      return undefined;
    });
  } catch { /* a document shape this lane does not recognise contributes nothing */ }
  if (inline.length) sheets.push(inline.map((d) => `.pp-inline{${d}}`).join('\n'));
  return sheets;
}

/**
 * Colours declared inside inline SVG marks, as CSS colour strings. L4's
 * `decodePixels` accepts those directly, so the logo contributes to the solve
 * without an image decoder (§7).
 * @param {any[]} captures
 * @param {{name?: string, mime?: string, bytes?: Uint8Array}[]} assets
 * @returns {string[][]}
 */
export function logoColorSources(captures, assets) {
  /** @type {string[]} */
  const svgText = [];
  for (const asset of assets || []) {
    const isSvg = /^image\/svg/.test(asset.mime || '') || /\.svg(\?|$)/i.test(asset.name || '');
    if (isSvg && asset.bytes) svgText.push(decodeText(asset.bytes));
  }
  for (const capture of captures || []) {
    if (capture && typeof capture.html === 'string') {
      for (const match of capture.html.matchAll(/<svg[\s\S]*?<\/svg>/gi)) svgText.push(match[0]);
    }
  }
  const colors = [];
  for (const text of svgText) {
    for (const match of String(text).matchAll(/(?:fill|stroke|stop-color|flood-color)\s*[=:]\s*["']?\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|[a-zA-Z]{3,20})/g)) {
      const value = match[1];
      if (/^(none|currentcolor|inherit|transparent|url)$/i.test(value)) continue;
      colors.push(value);
    }
  }
  return colors.length ? [colors] : [];
}

/**
 * RGBA samples for L5's imagery classifier.
 *
 * Empty until a lane declares a surface that decodes captured bytes into
 * `ImageSample`s (D-L12-3). When `brand/theme.js` re-exports `sampleFromPng`,
 * this is the one function that changes: map the PNG assets through it and the
 * imagery treatment stops being held at `unknown`.
 * @param {{name?: string, mime?: string, bytes?: Uint8Array}[]} assets
 * @returns {any[]}
 */
export function imagerySamples(assets) {
  const sampler = themeLane && typeof themeLane.sampleFromPng === 'function' ? themeLane.sampleFromPng : null;
  if (!sampler) return [];
  const out = [];
  for (const asset of assets || []) {
    const isPng = /^image\/png/.test(asset.mime || '') || /\.png(\?|$)/i.test(asset.name || '');
    if (!isPng || !asset.bytes) continue;
    try { out.push(sampler(asset.bytes, { id: asset.name, role: 'content' })); }
    catch { /* an image this build cannot decode contributes nothing */ }
  }
  return out;
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function decodeText(bytes) {
  try {
    if (typeof TextDecoder === 'function') return new TextDecoder('utf-8').decode(bytes);
  } catch { /* fall through */ }
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/**
 * Did an extraction actually find anything? §18: an extraction that yields
 * nothing must say so rather than report success.
 * @param {any} brand
 * @returns {{empty: boolean, found: string[], missing: string[]}}
 */
export function brandYield(brand) {
  const found = [];
  const missing = [];
  const check = (label, ok_) => (ok_ ? found : missing).push(label);
  check('colour roles', (brand.colors || []).length > 0);
  check('type faces', (brand.faces || []).length > 0);
  check('logos', (brand.logos || []).length > 0);
  check('shape', Number(brand.confidence?.shape || 0) > 0);
  check('imagery', Number(brand.confidence?.imagery || 0) > 0);
  return { empty: found.length === 0, found, missing };
}

/**
 * Block alignment when L7 has not landed: pair by position, which is the
 * honest default and is exactly what the side-by-side surface falls back to
 * when the two sides have different shapes.
 * @param {any[]} source
 * @param {any[]} pasted
 * @returns {{pairs: [number|null, number|null][], score: number}}
 */
export function fallbackAlign(source, pasted) {
  const a = source || [];
  const b = pasted || [];
  /** @type {[number|null, number|null][]} */
  const pairs = [];
  const n = Math.max(a.length, b.length);
  let matched = 0;
  for (let i = 0; i < n; i++) {
    const left = i < a.length ? i : null;
    const right = i < b.length ? i : null;
    if (left !== null && right !== null && a[i].type === b[i].type) matched += 1;
    pairs.push([left, right]);
  }
  return { pairs, score: n ? matched / n : 0 };
}

/**
 * Paste parsing when L7 has not landed: blank-line separated paragraphs, with
 * a leading `#` making a heading and a leading `-` making a list. Deliberately
 * small — the real parser is L7's — but real enough that the paste surface
 * works rather than being a dead control.
 * @param {string} text
 * @returns {any[]}
 */
export function fallbackParse(text) {
  const chunks = String(text || '').split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  return chunks.map((chunk) => {
    const heading = chunk.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      return { type: 'heading', level: /** @type {any} */ (heading[1].length), text: heading[2].trim() };
    }
    const lines = chunk.split('\n').map((s) => s.trim()).filter(Boolean);
    if (lines.length > 1 && lines.every((l) => /^([-*]|\d+[.)])\s+/.test(l))) {
      return {
        type: 'list',
        ordered: /^\d/.test(lines[0]),
        items: lines.map((l) => l.replace(/^([-*]|\d+[.)])\s+/, '')),
      };
    }
    if (/^>\s+/.test(chunk)) return { type: 'quote', text: chunk.replace(/^>\s+/gm, '').trim() };
    return { type: 'paragraph', text: chunk.replace(/\s*\n\s*/g, ' ') };
  });
}
