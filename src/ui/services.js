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
// Each line below is exactly the surface `API.md` Part 3 declares. A lane that
// has not landed has its line commented out and its entry in `LANE_MODULES`
// marked `wired: false`; wiring it is uncommenting the import and flipping the
// flag. Nothing else in `src/ui/**` changes.
// ---------------------------------------------------------------------------

/* eslint-disable */
// import * as ingestLane from '../ingest/index.js';
// import * as colorLane from '../brand/color.js';
// import * as themeLane from '../brand/theme.js';
import * as specimenLane from '../specimen/index.js';
// import * as recipeLane from '../recipe/index.js';
// import * as sceneLane from '../scene/index.js';
import * as branchLane from '../branch/index.js';
// import * as emitLane from '../emit/index.js';
// import * as validateLane from '../validate/index.js';
/* eslint-enable */

/** @type {any} */ const ingestLane = null;
/** @type {any} */ const colorLane = null;
/** @type {any} */ const themeLane = null;
/** @type {any} */ const recipeLane = null;
/** @type {any} */ const sceneLane = null;
/** @type {any} */ const emitLane = null;
/** @type {any} */ const validateLane = null;

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
      /** @type {any[]} */
      const captures = [];
      /** @type {string[]} */
      const problems = [];
      for (const file of files) {
        const result = await importOne(ingestLane, file, clock);
        if (result.ok) captures.push(...(Array.isArray(result.value) ? result.value : [result.value]));
        else problems.push(`${file.name}: ${result.error}`);
      }
      if (!captures.length) return err(problems.join('\n') || 'Nothing in those files could be read.');
      return ok({ captures, problems });
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
        const parts = brandParts(captures, { colorLane, themeLane, idMinter, seed: options.seed });
        return ok(themeLane.buildBrandSystem(parts, { clock, idMinter }));
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
 * Pick the right L3 importer for a file by extension, then by content.
 * @param {any} lane
 * @param {{name: string, bytes: Uint8Array, mime: string, text?: string}} file
 * @param {() => string} clock
 * @returns {Promise<any>}
 */
async function importOne(lane, file, clock) {
  const name = (file.name || '').toLowerCase();
  try {
    if (name.endsWith('.har')) return lane.importHar(file.text || '', { clock });
    if (name.endsWith('.mhtml') || name.endsWith('.mht')) return lane.importMhtml(file.text || '', { clock });
    if (name.endsWith('.html') || name.endsWith('.htm')) return lane.importHtmlText(file.text || '', { sourceUrl: null, clock });
    if (name.endsWith('.docx') || name.endsWith('.pptx') || name.endsWith('.xlsx')) {
      return lane.importOoxml(file.bytes, { name: file.name, clock });
    }
    if (name.endsWith('.pdf')) return lane.importPdf(file.bytes, { name: file.name, clock });
    if (/^image\//.test(file.mime || '')) return lane.importImage(file.bytes, { name: file.name, mime: file.mime, clock });
    return lane.importSavedPage([file], { clock });
  } catch (e) { return err(message(e), e); }
}

/**
 * Assemble the `parts` argument L5's `buildBrandSystem` takes from a set of
 * captures. Everything it contains is produced by L4/L5; this only routes.
 * @param {any[]} captures
 * @param {{colorLane: any, themeLane: any, idMinter: any, seed: string}} deps
 * @returns {any}
 */
function brandParts(captures, deps) {
  const docs = captures.map((c) => c.doc).filter(Boolean);
  const css = captures.map((c) => c.html || '').join('\n');
  const assets = captures.flatMap((c) => c.assets || []);
  const pixels = assets.filter((a) => /^image\//.test(a.mime || ''));
  const clusters = deps.colorLane.quantize(pixels, { k: deps.colorLane.chooseK(pixels, { seed: deps.seed, range: [3, 8] }), seed: deps.seed });
  return {
    sourceUrl: captures.find((c) => c.sourceUrl)?.sourceUrl || null,
    colors: deps.colorLane.solveRoles(clusters, { seed: deps.seed }),
    faces: deps.themeLane.detectFaces(docs[0] || null, css, {}),
    logos: deps.themeLane.extractLogos(docs[0] || null, assets, { idMinter: deps.idMinter }),
    shape: deps.themeLane.detectShape(css),
    imagery: deps.themeLane.classifyImagery(pixels),
    confidence: { colors: deps.colorLane.colorConfidence(clusters, captures.length) },
  };
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
