/**
 * The layout registry (§10).
 *
 * A layout is "a pure function of `(Scene, BrandSystem, Specimen, Rendition[])`
 * → DOM"; DECISIONS D4 makes the target a VNode tree instead, which keeps the
 * function pure in the strict sense and lets the emitter serialize a scene to
 * static HTML for first paint.
 *
 * L2 owns the registry and the contract every layout signs. L8 owns the eight
 * layouts themselves and registers them here. Keeping the two apart is what
 * lets the runtime be tested, and the artifact be booted, before a single
 * layout exists — and it is why a layout can never reach into the runtime's
 * state: all it receives is the context object below.
 *
 * @module runtime/layouts
 */

import { h } from '../core/vdom.js';
import { SCENE_LAYOUTS } from '../core/contracts.js';

/**
 * Everything a layout is allowed to see. Note what is absent: the navigation
 * state, the beat index, and the document. A layout renders the scene's full
 * content once; the beat engine decides what is *visible*, by element id, at
 * render time and on every beat change. A layout that rendered per-beat would
 * make backward navigation depend on re-running the layout, and §10 requires
 * backward navigation to be exact.
 *
 * @typedef {object} LayoutContext
 * @property {import('../core/contracts.d.ts').Scene} scene
 * @property {import('../core/contracts.d.ts').BrandSystem} brand
 * @property {import('../core/contracts.d.ts').Specimen|null} specimen
 * @property {import('../core/contracts.d.ts').Rendition[]} renditions
 * @property {Map<string, import('../core/contracts.d.ts').MediaRef>} media
 * @property {(path: string) => string} el   mints the stable element id for a structural path
 * @property {boolean} labelIllustrative     §9: illustrative content must carry a visible label
 * @property {'presenter'|'review'} mode
 */

/**
 * @typedef {(ctx: LayoutContext) => import('../core/vdom.js').VNode} LayoutFn
 */

/** @type {Map<string, LayoutFn>} */
const REGISTRY = new Map();

/**
 * Register a layout. The name must be one of the closed set in §4 — a lane
 * that invents a ninth layout has drifted from the contract, and this is where
 * that shows up rather than at emit time.
 * @param {import('../core/contracts.d.ts').SceneLayout} name
 * @param {LayoutFn} fn
 * @returns {() => void} unregister
 */
export function registerLayout(name, fn) {
  if (!SCENE_LAYOUTS.includes(name)) {
    throw new Error(`layouts: "${name}" is not one of the eight layouts frozen in §4`);
  }
  if (typeof fn !== 'function') throw new Error(`layouts: ${name} must be a function`);
  REGISTRY.set(name, fn);
  return () => { if (REGISTRY.get(name) === fn) REGISTRY.delete(name); };
}

/**
 * @param {string} name
 * @returns {LayoutFn|null}
 */
export function getLayout(name) {
  return REGISTRY.get(name) || null;
}

/** @returns {string[]} */
export function registeredLayouts() {
  return [...REGISTRY.keys()].sort();
}

/** @returns {string[]} the §4 layouts nobody has registered yet */
export function missingLayouts() {
  return SCENE_LAYOUTS.filter((n) => !REGISTRY.has(n));
}

/** Drop every registration. Tests use this; nothing in the artifact does. */
export function resetLayouts() {
  REGISTRY.clear();
}

/**
 * Render a scene through its layout.
 *
 * An unregistered layout renders a legible placeholder rather than throwing.
 * A proof that is mid-build in the studio has to keep rendering while a lane is
 * still landing, and a presenter who somehow meets this in a live artifact
 * needs to see what is wrong, not a blank screen. Validation blocks the emit
 * long before it gets that far.
 *
 * @param {LayoutContext} ctx
 * @returns {import('../core/vdom.js').VNode}
 */
export function renderLayout(ctx) {
  const fn = REGISTRY.get(ctx.scene.layout);
  if (!fn) return placeholderLayout(ctx);
  return fn(ctx);
}

/**
 * @param {LayoutContext} ctx
 * @returns {import('../core/vdom.js').VNode}
 */
export function placeholderLayout(ctx) {
  const { scene } = ctx;
  return h('div', { class: 'pp-layout pp-layout--placeholder', 'data-pp-layout': scene.layout },
    h('div', { class: 'pp-placeholder-card' },
      h('p', { class: 'pp-placeholder-kicker' }, 'Layout not registered'),
      h('h2', { class: 'pp-placeholder-title' }, scene.headline || scene.id),
      scene.subhead ? h('p', { class: 'pp-placeholder-sub' }, scene.subhead) : null,
      h('code', { class: 'pp-placeholder-code' }, scene.layout),
    ));
}
