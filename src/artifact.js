/**
 * The artifact composition root.
 *
 * `src/runtime/**` is deliberately layout-agnostic and branch-agnostic: L8
 * registers layouts *into* the runtime's registry and L9 registers overlays
 * *onto* a runtime instance, so both depend on the runtime and the runtime
 * depends on neither. That is the right layering, and it leaves exactly one
 * thing unowned — somebody has to put the three together before an artifact
 * boots.
 *
 * This file is that somebody. It belongs to no lane; it is the integration
 * seam, and it is the entry `scripts/build.mjs` bundles into
 * `dist/pitchproof-runtime.js`.
 *
 * It exists because of a defect that only appears at the seam and is invisible
 * to every lane's own tests: an emitted artifact painted correctly on open,
 * because the emitter pre-renders the opening beat as static HTML — and then
 * the presenter's first keypress made the runtime re-render, found no layout
 * registered, and replaced the client's own content with "Layout not
 * registered". `/` and `m` opened nothing. Each lane was green.
 *
 * The public surface is identical to `src/runtime/index.js`, so the emitter's
 * `PitchProofRuntime.boot(...)` call is unchanged; `boot` here just wires the
 * branch overlays onto the runtime it creates.
 *
 * @module artifact
 */

export {
  buildDeck, SPINE, sequenceOf, sceneAt, branchesFrom, allBranches, beatCount,
  initialState, navigate, checkInvariants, NavInvariantError, beatsOf,
  offSpine, currentScene, peekNext, stateHash, allPositions,
  revealedAt, newlyRevealedAt, sceneRevealsNothing, visibilityOf, scrollTargetFor,
  beatFrame, beatSignature, transitionMs, dwellHintLabel,
  REVEAL_ATTR, REVEALED_CLASS, ENTERING_CLASS, EXIT_TRANSITION_MS,
  BINDINGS, resolveKey, bindingGroups, keyLabel, allCommands,
  OverlayStack, OVERLAY, trapFocus, focusableWithin, FOCUSABLE_SELECTOR,
  registerLayout, getLayout, registeredLayouts, missingLayouts, resetLayouts,
  renderLayout, placeholderLayout,
  Runtime, applyBeat, renderHelpOverlay,
  RuntimeHost, STAGE_ROOT_ID, PRERENDERED_ATTR, isTextEntry, cssEscape,
  firstPaintTree, renderToNode,
  ManualTimer, renderPresenterView, openPresenterWindow, PRESENTER_CSS, PRESENTER_WINDOW_NAME,
  RUNTIME_VERSION,
} from './runtime/index.js';

export { registerAllLayouts, sceneTemplates, buildScene, measureScene, PROVENANCE_LABEL_CLASS } from './scene/index.js';
export { buildJumpIndex, searchJump, registerBranchOverlays, returnTargetFor, branchCoverage } from './branch/index.js';

import { Runtime } from './runtime/runtime.js';
import { RuntimeHost, STAGE_ROOT_ID } from './runtime/host.js';
import { openPresenterWindow } from './runtime/presenter.js';
import { registerAllLayouts } from './scene/index.js';
import { registerBranchOverlays } from './branch/index.js';
import { installBranchInputBridge } from './branch/bridge.js';

// Layouts are registered into a module-level registry, so this runs once, at
// module evaluation, before anything can render.
registerAllLayouts();

/**
 * Boot an emitted artifact.
 *
 * The emitted document already contains the opening beat as static HTML, so by
 * the time this runs the client is already looking at the first scene. All this
 * does is make the keyboard work — including `/`, `m` and `c`, which need the
 * branch overlays registered onto this particular runtime.
 *
 * @param {object} args
 * @param {import('./core/contracts.d.ts').Proof} args.proof
 * @param {Document} args.document
 * @param {Window} [args.window]
 * @param {Element} [args.root]
 * @param {() => number} [args.nowMs]  clock for the presenter's manual timer
 * @returns {{runtime: Runtime, host: RuntimeHost, presenter: {close: () => void}|null, dispose: () => void}}
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

  // Overlays are per-runtime, and the input bridge listens on the document, so
  // both are wired after the host has attached and painted.
  const offOverlays = registerBranchOverlays(runtime);
  const offBridge = installBranchInputBridge(runtime, { document: doc, root: host.root });

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

  const dispose = () => {
    if (presenter) { presenter.close(); presenter = null; }
    offBridge();
    offOverlays();
    host.detach();
  };

  return { runtime, host, presenter, dispose };
}
