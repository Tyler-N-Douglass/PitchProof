/**
 * The presentation runtime's public surface.
 *
 * This module is the entry point `scripts/build.mjs` bundles into
 * `dist/pitchproof-runtime.js`, which the studio embeds as a string and the
 * emitter inlines into every artifact. It is also what the studio's live
 * preview imports, so the preview and the artifact are the same code — a
 * rehearsal pass in the studio means something precisely because of that.
 *
 * Nothing in this file, or anything it reaches, performs input or output of any
 * kind beyond the document it is given. §13's scanner verifies that on every
 * emit and `scripts/verify-offline.mjs` proves it again in a headless browser
 * with every request blocked.
 *
 * @module runtime/index
 */

export { buildDeck, SPINE, sequenceOf, sceneAt, branchesFrom, allBranches, beatCount } from './deck.js';
export {
  initialState, navigate, checkInvariants, NavInvariantError, beatsOf,
  offSpine, currentScene, peekNext, stateHash, allPositions,
} from './nav.js';
export {
  revealedAt, newlyRevealedAt, sceneRevealsNothing, visibilityOf, scrollTargetFor,
  beatFrame, beatSignature, transitionMs, dwellHintLabel,
  REVEAL_ATTR, REVEALED_CLASS, ENTERING_CLASS, EXIT_TRANSITION_MS,
} from './beats.js';
export { BINDINGS, resolveKey, bindingGroups, keyLabel, allCommands } from './keymap.js';
export { OverlayStack, OVERLAY, trapFocus, focusableWithin, FOCUSABLE_SELECTOR } from './overlays.js';
export {
  registerLayout, getLayout, registeredLayouts, missingLayouts, resetLayouts,
  renderLayout, placeholderLayout,
} from './layouts.js';
export { Runtime, applyBeat, renderHelpOverlay } from './runtime.js';
export {
  RuntimeHost, STAGE_ROOT_ID, PRERENDERED_ATTR, isTextEntry, cssEscape,
  firstPaintTree, renderToNode,
} from './host.js';
export { ManualTimer, renderPresenterView, openPresenterWindow, PRESENTER_CSS, PRESENTER_WINDOW_NAME } from './presenter.js';

import { Runtime } from './runtime.js';
import { RuntimeHost, STAGE_ROOT_ID } from './host.js';
import { openPresenterWindow } from './presenter.js';

/**
 * Boot an emitted artifact.
 *
 * The emitted document already contains the opening beat as static HTML, so by
 * the time this runs the client is already looking at the first scene. All this
 * does is make the keyboard work.
 *
 * @param {object} args
 * @param {import('../core/contracts.d.ts').Proof} args.proof
 * @param {Document} args.document
 * @param {Window} [args.window]
 * @param {Element} [args.root]
 * @param {() => number} [args.nowMs]  clock for the presenter's manual timer
 * @returns {{runtime: Runtime, host: RuntimeHost, presenter: {close: () => void}|null}}
 */
export function boot({ proof, document: doc, window: win, root, nowMs }) {
  const view = win || doc.defaultView;
  const reducedMotion = !!(view && view.matchMedia && view.matchMedia('(prefers-reduced-motion: reduce)').matches);

  const runtime = new Runtime(proof, { reducedMotion });
  const host = new RuntimeHost(runtime, {
    document: doc,
    window: view,
    root: root || doc.getElementById(STAGE_ROOT_ID) || doc.body,
  }).attach();

  /** @type {{close: () => void}|null} */
  let presenter = null;
  runtime.on('presenter', ({ open }) => {
    if (open && !presenter) {
      const clock = nowMs || (view && view.performance
        ? () => view.performance.now()   // determinism-quarantine: presenter stopwatch display only
        : () => 0);
      const opened = openPresenterWindow(runtime, { window: view, nowMs: clock });
      presenter = opened.opened ? opened : null;
      if (!opened.opened) runtime.presenterOpen = false;
    } else if (!open && presenter) {
      presenter.close();
      presenter = null;
    }
  });

  return { runtime, host, presenter };
}

/** The runtime's version, stamped into every artifact for support. */
export const RUNTIME_VERSION = '1.0.0';
