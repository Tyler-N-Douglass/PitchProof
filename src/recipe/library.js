/**
 * The seed recipe library (§9).
 *
 * Eight recipes, "the reframe payload", each with a real template that produces
 * renditions from a specimen deterministically. This is the **manual default
 * path made excellent** rather than a placeholder waiting for an adapter: with
 * no endpoint configured, no key, and no network, every one of the eight
 * produces contract-valid renditions from the prospect's own captured page.
 *
 * A rendition produced here is `producedBy: 'template'` and
 * `provenance: 'illustrative'` — the tool arranged it, so the artifact labels it.
 * The user promotes what they have verified, one rendition at a time, through
 * `promoteProvenance`.
 *
 * @module recipe/library
 */

import { ok, err } from '../core/result.js';
import * as localeFanout from './templates/locale-fanout.js';
import * as channelVariants from './templates/channel-variants.js';
import * as systemAssembly from './templates/system-assembly.js';
import * as briefToAsset from './templates/brief-to-asset.js';
import * as governedIteration from './templates/governed-iteration.js';
import * as approvalChain from './templates/approval-chain.js';
import * as damRoundTrip from './templates/dam-round-trip.js';
import * as volumeView from './templates/volume-view.js';

/**
 * The eight templates, in §9 order. Each module exports `RECIPE` and `render`.
 * @type {{RECIPE: import('../core/contracts.d.ts').Recipe, render: Function}[]}
 */
export const RECIPE_TEMPLATES = [
  localeFanout,
  channelVariants,
  systemAssembly,
  briefToAsset,
  governedIteration,
  approvalChain,
  damRoundTrip,
  volumeView,
];

/**
 * All eight §9 seed recipes, as `Recipe` objects.
 * @type {import('../core/contracts.d.ts').Recipe[]}
 */
export const SEED_RECIPES = RECIPE_TEMPLATES.map((t) => t.RECIPE);

/** @type {Map<string, {RECIPE: import('../core/contracts.d.ts').Recipe, render: Function}>} */
const BY_ID = new Map(RECIPE_TEMPLATES.map((t) => [t.RECIPE.id, t]));

/**
 * @param {string} id
 * @returns {import('../core/contracts.d.ts').Recipe|null}
 */
export function recipeById(id) {
  const entry = BY_ID.get(String(id));
  return entry ? entry.RECIPE : null;
}

/**
 * Is this recipe applicable to this specimen kind?
 * @param {import('../core/contracts.d.ts').Recipe} recipe
 * @param {import('../core/contracts.d.ts').Specimen} specimen
 * @returns {boolean}
 */
export function recipeAccepts(recipe, specimen) {
  if (!recipe || !specimen) return false;
  return recipe.inputKinds.includes(specimen.kind);
}

/**
 * The recipes that accept a specimen, in library order.
 * @param {import('../core/contracts.d.ts').Specimen} specimen
 * @returns {import('../core/contracts.d.ts').Recipe[]}
 */
export function recipesFor(specimen) {
  return SEED_RECIPES.filter((r) => recipeAccepts(r, specimen));
}

/**
 * Run a seed recipe's template against a specimen.
 *
 * Deterministic: the same specimen and options always produce the same
 * renditions, ids included. Failure is a `Result` err — a recipe that cannot
 * run must not hand the studio a half-built scene.
 *
 * @param {string|import('../core/contracts.d.ts').Recipe} recipe
 * @param {import('../core/contracts.d.ts').Specimen} specimen
 * @param {object} [options] passed through to the template
 * @returns {{ok: true, value: import('../core/contracts.d.ts').Rendition[]} | {ok: false, error: string, detail?: unknown}}
 */
export function renderRecipe(recipe, specimen, options = {}) {
  const id = typeof recipe === 'string' ? recipe : recipe && recipe.id;
  const entry = BY_ID.get(String(id));
  if (!entry) return err(`renderRecipe: unknown recipe ${String(id)}`);
  if (!specimen || typeof specimen !== 'object' || !Array.isArray(specimen.blocks)) {
    return err(`renderRecipe: ${id} needs a specimen with blocks`);
  }
  if (specimen.blocks.length === 0) {
    return err(`renderRecipe: ${id} cannot run on an empty specimen`);
  }
  try {
    const renditions = entry.render(specimen, options);
    if (!Array.isArray(renditions) || renditions.length === 0) {
      return err(`renderRecipe: ${id} produced nothing`);
    }
    return ok(renditions);
  } catch (e) {
    return err(`renderRecipe: ${id} failed — ${e instanceof Error ? e.message : String(e)}`, e);
  }
}

/**
 * Run every recipe that accepts the specimen. Used by the studio's "populate
 * the library" action and by the integration test.
 * @param {import('../core/contracts.d.ts').Specimen} specimen
 * @param {object} [options]
 * @returns {{renditions: import('../core/contracts.d.ts').Rendition[], failures: {recipeId: string, error: string}[]}}
 */
export function renderAll(specimen, options = {}) {
  /** @type {import('../core/contracts.d.ts').Rendition[]} */
  const renditions = [];
  /** @type {{recipeId: string, error: string}[]} */
  const failures = [];
  for (const recipe of recipesFor(specimen)) {
    const result = renderRecipe(recipe.id, specimen, options);
    if (result.ok) renditions.push(...result.value);
    else failures.push({ recipeId: recipe.id, error: result.error });
  }
  return { renditions, failures };
}
