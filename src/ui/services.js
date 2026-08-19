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
import { shortHash } from '../core/hash.js';
import { normalizeEmitOptions } from '../core/contracts.js';
import { embeddedFontFile, usedIds } from './model.js';

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
 * The sentence for a lane call that was made without the proof its new ids have
 * to be free in. It is a wiring fault rather than anything the user did, and it
 * says so: CRITIQUE-3 P1 was exactly this argument being absent, and the way it
 * stayed absent for a whole build was that nothing refused the call.
 * @param {string} method
 * @returns {string}
 */
function missingProof(method) {
  return `${method} was called without the project's proof, so the ids it mints could collide with ids the project already uses. Nothing was changed. This is a wiring fault in the studio (CRITIQUE-3 P1), not something you did.`;
}

/**
 * Every id the proof uses except the brand's own, for a call that replaces the
 * brand. @param {any} proof @returns {Set<string>}
 */
function freeOfBrand(proof) {
  const taken = usedIds(proof);
  const brand = proof ? proof.brand : null;
  if (brand) {
    taken.delete(brand.id);
    for (const logo of brand.logos || []) taken.delete(logo.id);
  }
  return taken;
}

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
     *
     * `proof` is required, and it is required for the reason CRITIQUE-3 P1
     * names: the logo ids L5 mints have to be free in *this* project, and the
     * only thing that knows which ids are free is the project. The ids of the
     * brand being replaced are excluded from that set — a brand is replaced,
     * not appended, so its ids are about to be released, and holding them back
     * would make a second extraction of the same site produce a different brand
     * from the first. L5's own comment on the brand id says the same thing: "a
     * recapture that found the same brand is the same brand."
     *
     * @param {any[]} captures
     * @param {{seed: string, proof: any}} options
     * @returns {any}
     */
    buildBrand(captures, options) {
      if (!themeLane || !colorLane) return laneErr(themeLane ? 'color' : 'theme');
      if (!options || !options.proof) return err(missingProof('buildBrand'));
      try {
        const idMinter = minterFor(options.seed, {
          taken: freeOfBrand(options.proof),
          salt: { brandFrom: (captures || []).map((c) => (c && typeof c.sourceUrl === 'string' ? c.sourceUrl : null)) },
        });
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
     * The stylesheet the artifact wears, as one string.
     *
     * **The preview and the emit call this same method, and nothing else.**
     * CRITIQUE-2 C7: the preview compiled the brand through L5's `compileTheme`
     * and the emit passed no `themeCss` at all, so every emitted file fell
     * through to L10's `compileFallbackTheme` — the path named for a build where
     * L5 has not landed. Nineteen of twenty-three custom properties happened to
     * agree; the four that did not were the scale, the stage padding, the
     * transition duration and the shadow — precisely the set §15's "live preview
     * at true aspect" promises to be showing. Two functions compiling the same
     * brand is a divergence waiting to widen, so there is now one.
     * @param {any} brand
     * @returns {string}
     */
    artifactThemeCss(brand) {
      const theme = services.compileTheme(brand);
      return theme && typeof theme.css === 'string' ? theme.css : '';
    },

    /**
     * Attach a user-supplied font file to a face and mark it embeddable.
     *
     * §7 permits exactly one route to `embeddable: true` — "the user explicitly
     * supplies a font file they assert they have rights to" — and L5's
     * `attachUserFont` is that route: it refuses without a file and refuses
     * without a rights assertion naming who made it. The studio has no other
     * way to set the flag (CRITIQUE-2 C3), which is what keeps the claim and
     * the fact from moving independently.
     * @param {any[]} faces
     * @param {any} supply    `{family, fileName, bytes, dataUri, mime, weights, style, rightsAssertion}`
     * @returns {any}
     */
    attachUserFont(faces, supply) {
      if (!themeLane) return laneErr('theme');
      try { return ok(themeLane.attachUserFont(faces, supply, { clock })); }
      catch (e) { return err(`The font file was not attached: ${message(e)}`, e); }
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
     * Turn a capture into a specimen.
     *
     * `proof` is required. CRITIQUE-3 P1: the specimen and media ids L6 mints
     * must not collide with anything the project already holds, and a minter
     * that is handed only the seed cannot know. Every capture route goes
     * through here, so there is one place that can get this wrong and it is
     * this one.
     *
     * @param {any} capture
     * @param {{kind?: string, imageQuality: number, seed: string, proof: any}} options
     * @returns {any}
     */
    buildSpecimen(capture, options) {
      if (!specimenLane) return laneErr('specimen');
      if (!options || !options.proof) return err(missingProof('buildSpecimen'));
      try {
        return ok(specimenLane.buildSpecimen(capture, {
          kind: options.kind,
          imageQuality: options.imageQuality,
          clock,
          idMinter: minterFor(options.seed, { taken: usedIds(options.proof), salt: captureSalt(capture) }),
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
     * The images a capture could not bring back, as the seller has to see them.
     *
     * §6's paste route has markup and no bytes, so L6 holds a `media` block
     * whose `ref` names nothing out of the block stream rather than emitting a
     * reference the artifact would render as a broken image (its D-L6-21, for
     * CRITIQUE-3 P6). That is the right call, and it moved the failure: the
     * emit now succeeds and the deck ships without the pictures. Until this
     * call existed nothing in `src/ui/**` read the record, so nothing said so.
     *
     * Two sources, merged, because either alone under-reports:
     *
     *   - `specimen.mediaOmitted` — the entries L6 held back, each with the
     *     caption and the position it will go back to.
     *   - `unresolvedMediaRefs(specimen)` — the lane's own authoritative list,
     *     which also catches a `media` block still standing in the stream whose
     *     `ref` resolves to nothing (a hand edit, or an older capture). Those
     *     have no entry, so they get one marked `restorable: false`: the studio
     *     can name them but cannot put them back in a position it does not know.
     *
     * @param {any} specimen
     * @returns {{id: string|null, ref: string, caption: string|null, position: number|null, origin: string|null, reason: string|null, restorable: boolean}[]}
     */
    omittedMedia(specimen) {
      if (!specimen) return [];
      const entries = Array.isArray(specimen.mediaOmitted) ? specimen.mediaOmitted : [];
      /** @type {any[]} */
      const out = entries.map((e) => ({
        id: e.id || null,
        ref: String(e.ref),
        caption: e.caption === undefined ? null : e.caption,
        position: Number.isInteger(e.position) ? e.position : null,
        origin: e.origin || null,
        reason: e.reason || null,
        restorable: true,
      }));
      let refs = [];
      if (specimenLane) {
        try { refs = specimenLane.unresolvedMediaRefs(specimen) || []; } catch { refs = []; }
      }
      const named = new Set(out.map((e) => e.ref));
      for (const ref of refs) {
        if (named.has(ref)) continue;
        out.push({ id: null, ref: String(ref), caption: null, position: null, origin: null, reason: 'reference-unresolved', restorable: false });
      }
      return out;
    },

    /**
     * Put one omitted image back, now that the seller has the file.
     *
     * The `proof` argument is CRITIQUE-3 P1's discipline applied to a second
     * minting site: this captures a new `MediaRef`, so it mints an id, so it
     * has to see what the project already uses.
     *
     * @param {any} specimen
     * @param {any} target    an entry from `omittedMedia`, its id, or its ref
     * @param {{name: string, bytes: Uint8Array, mime: string, alt?: string|null}} supply
     * @param {{seed: string, proof: any, imageQuality?: number}} options
     * @returns {any}
     */
    restoreOmittedMedia(specimen, target, supply, options) {
      if (!specimenLane) return laneErr('specimen');
      if (!options || !options.proof) return err(missingProof('restoreOmittedMedia'));
      try {
        return ok(specimenLane.restoreOmittedMedia(specimen, target, supply, {
          imageQuality: options.imageQuality === undefined ? 0.85 : options.imageQuality,
          idMinter: minterFor(options.seed, {
            taken: usedIds(options.proof),
            salt: { restore: String(target && target.ref ? target.ref : target), of: specimen.id, name: supply ? supply.name : null },
          }),
        }));
      } catch (e) { return err(`That image could not be put back: ${message(e)}`, e); }
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
     * as a digest-stamped token inside `notes` so it survives an export and so
     * a partly-edited record stops counting; the studio has to decode it to
     * show a person who promoted what, and when (§9).
     *
     * **`signatureValid` is tamper-evidence, not authenticity.** The digest is
     * `shortHash({v, by, at, of, from})` — unkeyed, and `formatPromotionRecord`
     * is exported — so anyone holding the repo can compute a valid one
     * (CRITIQUE-1 F23). There is no better option available: §1.1 forbids a
     * backend and accounts, and any key would have to ship inside the artifact
     * the forger already has. What a valid digest proves is that the line has
     * not been corrupted or half-edited; it does not prove that the person
     * named promoted anything. It is not the weakest link either — setting
     * `provenance: 'client-supplied'` suppresses the illustrative label with no
     * record at all, in one word rather than six fields and a hash.
     *
     * `promotionRecordLimit()` is the sentence to put in front of a person; it
     * comes from L7 rather than from here, so there is exactly one description
     * of this guarantee in the repo.
     *
     * @param {any} rendition
     * @returns {{by: string, at: string, from: string, signatureValid: boolean}|null}
     */
    promotionRecord(rendition) {
      if (!recipeLane) return null;
      try { return recipeLane.readPromotionRecord(rendition); } catch { return null; }
    },

    /**
     * L7's one sentence about what a valid promotion record does and does not
     * prove, shown verbatim beside the outcome it qualifies.
     *
     * Taken from the lane rather than written here on purpose: two descriptions
     * of one guarantee is how this adapter's own comment came to claim more for
     * the digest than it delivers, for a whole pass. Returns `null` only if the
     * lane is absent, in which case there is no record to qualify either.
     * @returns {string|null}
     */
    promotionRecordLimit() {
      if (!recipeLane) return null;
      try { return recipeLane.PROMOTION_RECORD_LIMIT || null; } catch { return null; }
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
     * Thread a proof through several auto-fixes in one pass (§14; CRITIQUE-3
     * P11). L11 publishes `applyAll` for exactly this and the studio had never
     * called it, so clearing N findings cost N clicks and N full sweeps at the
     * one moment §14 calls "the last pass before you walk in".
     *
     * The lane's function is the one that threads, deliberately: each fix
     * re-finds its own target in the proof it is handed, so what an earlier fix
     * did to the shape of the proof is the fix's problem to survive, and there
     * is one implementation of that rather than two. A fix that cannot find its
     * target returns the proof unchanged, which is why the caller compares
     * digests instead of trusting the count.
     *
     * @param {any} proof
     * @param {{apply: (p: any) => any}[]} fixes
     * @returns {any} a `Result` carrying the new proof
     */
    applyAllFixes(proof, fixes) {
      if (!validateLane) return laneErr('validate');
      try { return ok(validateLane.applyAll(proof, fixes || [])); }
      catch (e) { return err(`Those fixes could not be applied: ${message(e)}`, e); }
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
          // C7: the artifact wears the theme the preview showed, compiled once.
          themeCss: services.artifactThemeCss(proof && proof.brand),
          // C3: and the faces the user supplied a licensed file for, so the
          // font-face rules L10 is ready to write actually reach the file.
          fonts: artifactFonts(proof && proof.brand),
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
 * The faces the emitter may write a font-face rule for.
 *
 * §13 inlines "fonts (only user-supplied, license-asserted)", and §7 makes the
 * supplied file the thing that licences the claim. So a face reaches this list
 * only when it carries all three: the flag, a `data:` URI for the file the user
 * handed over, and the rights assertion naming who made it. A face flagged
 * embeddable with no file behind it is not shipped and not silently believed —
 * it is dropped here and reported on the Brand panel, because the artifact
 * would otherwise substitute a fallback while the studio said it had not.
 *
 * L10 filters on `licenseAsserted` again on its own side. Two independent
 * checks of the same law is the intent, not duplication.
 *
 * @param {any} brand
 * @returns {{family: string, dataUri: string, weight: number, style: string, licenseAsserted: boolean}[]}
 */
export function artifactFonts(brand) {
  /** @type {any[]} */
  const out = [];
  for (const face of (brand && brand.faces) || []) {
    if (!face || face.embeddable !== true) continue;
    const file = embeddedFontFile(face);
    if (!file) continue;
    const assertion = face.rightsAssertion;
    if (!assertion || !assertion.assertedBy || !assertion.statement) continue;
    const weights = (face.weightsSeen || []).filter((w) => Number.isFinite(w));
    out.push({
      family: String(face.family || ''),
      dataUri: file.dataUri,
      weight: Number(face.primaryWeight) || weights[0] || 400,
      style: file.style === 'italic' ? 'italic' : 'normal',
      licenseAsserted: true,
    });
  }
  return out;
}

/**
 * The id minter the lanes are given, over the ids the project has already used.
 *
 * **CRITIQUE-3 P1.** This function used to take the seed alone and count from
 * zero: `contentId(kind, {seed, n})`, with `n` restarting at 1 on every
 * construction and `seed` constant for the life of the project. It was
 * constructed fresh for each capture, so the first id every capture minted was
 * the same string — three pasted pages all came back `sp_004ebe5c150e`, the
 * runtime's `specimenById` map held one entry for three specimens, and six
 * scenes built across three of the prospect's pages all resolved to the same
 * page. `validateProofShape` has no uniqueness check, so the artifact shipped.
 * Its own doc comment claimed the property it did not have.
 *
 * The repair is not a longer-lived counter. A counter is state with a lifetime,
 * and every lifetime a counter could have is wrong somewhere: per call collides
 * on the second call, per session collides after a reload, per project collides
 * after an import of a project built elsewhere. **The state that has to survive
 * all four is the set of ids the document already carries**, and the document
 * is the one thing that survives a reload, an import, an undo and a redo,
 * because it *is* what is persisted. So the minter is handed that set and walks
 * past anything in it, exactly the way `ui/model.mintId` has always done for the
 * ids the studio mints itself.
 *
 * `salt` is what makes the walk rare rather than routine: seeded with the
 * capture's own identity, two different pages mint different ids on the first
 * try and only a genuine re-capture of the same page has to step. Both are
 * deterministic — no clock, no counter that a reload resets, nothing that
 * depends on how many ids some other subsystem drew.
 *
 * `taken` is required and is copied, never adopted: a minter that cannot see
 * what the project has used is the defect above, so there is no way to
 * construct one that cannot see.
 *
 * @param {string} seed
 * @param {{taken: Iterable<string>, salt?: unknown}} options
 * @returns {{next: (kind: string) => string, reset: () => void, minted: () => string[]}}
 */
export function minterFor(seed, options) {
  if (!options || options.taken === undefined || options.taken === null) {
    throw new Error('minterFor: the ids the project has already used are required (CRITIQUE-3 P1) — a minter that cannot see them mints a collision.');
  }
  const taken = new Set(options.taken);
  const salt = options.salt === undefined ? null : options.salt;
  /** @type {string[]} */
  const minted = [];
  let n = 0;
  return {
    next(kind) {
      n += 1;
      for (let i = 0; i < 100000; i++) {
        const id = contentId(/** @type {any} */ (kind), { seed, salt, n, i });
        if (taken.has(id)) continue;
        taken.add(id);
        minted.push(id);
        return id;
      }
      throw new Error(`minterFor: could not mint a free ${String(kind)} id`);
    },
    // Kept for parity with L1's `IdMinter`, which the lanes are typed against.
    // It rewinds the sequence but never the `taken` set: an id already handed
    // out stays spoken for, so a reset cannot reissue one.
    reset() { n = 0; },
    /** @returns {string[]} every id this minter handed out, in order */
    minted() { return minted.slice(); },
  };
}

/**
 * The identity of a capture, as a minting salt.
 *
 * Small on purpose — it is hashed once per id — and made of the fields that
 * differ between two pages of the same site: where it came from, when it was
 * taken, what it is called, and how big it was. Two genuinely different pages
 * differ in at least one; two captures of the same page at the same instant
 * differ in none, and the `taken` walk is what separates those.
 * @param {any} capture
 * @returns {Record<string, unknown>}
 */
export function captureSalt(capture) {
  const c = capture || {};
  const meta = c.meta && typeof c.meta === 'object' ? c.meta : {};
  return {
    url: typeof c.sourceUrl === 'string' ? c.sourceUrl : null,
    at: typeof c.capturedAt === 'string' ? c.capturedAt : null,
    title: typeof meta.title === 'string' ? meta.title : null,
    kind: typeof c.kind === 'string' ? c.kind : null,
    htmlLength: typeof c.html === 'string' ? c.html.length : 0,
    blocks: Array.isArray(c.blocks) ? c.blocks.length : 0,
    assets: Array.isArray(c.assets) ? c.assets.length : 0,
    digest: shortHash(typeof c.html === 'string' ? c.html : String(c.text || ''), 16),
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
