/**
 * L12 Studio UI — the lane surface declared in `API.md` Part 3.
 *
 *   mountStudio({document, window, store, clock, runtimeJs, runtimeCss}): StudioApp
 *
 * `src/ui/shell.html` provides the document shell with the three markers
 * `scripts/build.mjs` fills in. `bootStudio` is what that shell calls: it opens
 * the project store, builds the injected clock, and hands both to `mountStudio`.
 * Every other export here is a lane extension — the pieces the tests drive
 * directly and the integrator may need to reach.
 *
 * Nothing in this module reads a clock or a random source. The one wall-clock
 * read in the studio is in `bootStudio`, marked and explained, and it is passed
 * *in* to everything else as a parameter (§5).
 *
 * @module ui/index
 */

import { StudioApp } from './app.js';
import { ProjectStore } from '../core/storage.js';

export { StudioApp } from './app.js';
export { makeServices, makeHttp, LANE_MODULES, unavailable } from './services.js';
export { ACTIONS, actionIndex, routeOf } from './actions.js';
export { emitBlockers, gateSummary, blockingFindings, proofDigest } from './gate.js';
export { Preview, deckFingerprint } from './preview.js';
export { Patcher, delegate, flatten, actionFor, ACT_ATTR, ARG_ATTR, KEY_ATTR, PRESERVE_ATTR } from './render.js';
export { renderStudio } from './layout.js';
export { renderPanel, renderAllPanels, PANELS } from './panels/index.js';
export { keyStringOf, matchesBinding, keyLabel, bindingGroups } from './keys.js';
export { SECTIONS, SETTING_KEYS, WIDE_SECTIONS } from './constants.js';

/** The element `shell.html` reserves for the studio. */
export const ROOT_ID = 'pp-studio-root';

/**
 * Mount the studio into a document.
 *
 * @param {object} env
 * @param {Document} env.document
 * @param {any} env.window
 * @param {any} env.store                  a `ProjectStore` (`core/storage.js`)
 * @param {() => string} env.clock         returns an ISO string; injected (§5)
 * @param {string} [env.runtimeJs]         the bundled artifact runtime, for the emitter
 * @param {string} [env.runtimeCss]        the bundled artifact stylesheet, for the preview
 * @param {any} [env.services]             lane adapter override, for tests
 * @param {import('./model.js').Doc} [env.doc]
 * @param {Element} [env.root]
 * @returns {StudioApp}
 */
export function mountStudio(env) {
  if (!env || !env.document) throw new Error('mountStudio: a document is required');
  if (typeof env.clock !== 'function') throw new Error('mountStudio: an injected clock is required (§5)');

  const app = new StudioApp({
    document: env.document,
    window: env.window || env.document.defaultView,
    store: env.store,
    clock: env.clock,
    runtimeJs: env.runtimeJs,
    runtimeCss: env.runtimeCss,
    services: env.services,
    doc: env.doc,
  });

  const root = env.root || env.document.getElementById(ROOT_ID) || env.document.body;
  app.mount(root);
  void app.start();
  return app;
}

/**
 * Boot from `shell.html`.
 *
 * The build inlines the artifact runtime and stylesheet as
 * `window.__PITCHPROOF_RUNTIME_JS__` / `__PITCHPROOF_RUNTIME_CSS__`; this reads
 * them, opens IndexedDB (falling back to memory, loudly, per §16), and mounts.
 *
 * @param {object} env
 * @param {Document} env.document
 * @param {any} env.window
 * @returns {Promise<StudioApp>}
 */
export async function bootStudio({ document: doc, window: view }) {
  const clock = () => new Date().toISOString(); // determinism-quarantine: the studio's one wall-clock read; it is injected into every model path as a parameter (§5)
  const store = await ProjectStore.open({
    clock,
    indexedDB: view && view.indexedDB ? view.indexedDB : null,
  });
  return mountStudio({
    document: doc,
    window: view,
    store,
    clock,
    runtimeJs: (view && view.__PITCHPROOF_RUNTIME_JS__) || '',
    runtimeCss: (view && view.__PITCHPROOF_RUNTIME_CSS__) || '',
  });
}
