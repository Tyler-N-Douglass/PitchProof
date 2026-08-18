/**
 * The one place in this lane that knows a document exists.
 *
 * The overlays are pure VNode renderers, and the vdom substrate carries no
 * event handlers by design (§5: the same tree has to serialize to static HTML
 * for the emitter's first paint). So the jump index needs a thin bridge that
 * turns real events into calls on the `JumpController`: typing into the search
 * field, arrowing through the results, Enter, and clicks on any overlay row
 * that declares a runtime command.
 *
 * Two details make it correct rather than merely working:
 *
 *   - **It listens in the capture phase.** The host binds `keydown` on the
 *     document, and the keymap maps `ArrowDown` to "next scene". While the jump
 *     field has focus, that arrow belongs to the result list, so the bridge has
 *     to see it first and stop it.
 *   - **The document is injected**, never read from a global, so the studio, a
 *     test harness and the artifact all drive the same code path.
 *
 * Nothing here reaches the network, and nothing here is required for the
 * overlays to render — a proof opened without the bridge still shows the jump
 * index; it just cannot type into it.
 *
 * @module branch/bridge
 */

import { JUMP_INPUT_ATTR, COMMAND_ATTR, PAYLOAD_ATTR } from './overlays.js';

/**
 * Wire a runtime's branch overlays to a document.
 * @param {import('../runtime/runtime.js').Runtime} runtime
 * @param {{document: Document, root?: Element|Document}} env
 * @returns {() => void} detach
 */
export function installBranchInputBridge(runtime, env) {
  const doc = env && env.document;
  if (!doc || typeof doc.addEventListener !== 'function') return () => {};
  const root = env.root || doc;

  const controller = () => runtime.branchJump || null;

  const onInput = (event) => {
    if (event.isComposing) return;
    const target = event.target;
    if (!isJumpInput(target)) return;
    const c = controller();
    if (!c) return;
    c.setQuery(target.value === undefined ? '' : String(target.value));
  };

  const onKeyDown = (event) => {
    const c = controller();
    if (!c) return;
    if (!isJumpInput(event.target)) return;
    if (event.isComposing) return;
    // Escape belongs to the overlay stack, not to us: it closes the panel and
    // hands focus back to wherever it came from.
    if (event.key === 'Escape' || event.key === 'Esc') return;
    if (!c.handleKey(event)) return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    if (typeof event.stopPropagation === 'function') event.stopPropagation();
  };

  const onClick = (event) => {
    const target = event.target;
    const el = target && typeof target.closest === 'function' ? target.closest(`[${COMMAND_ATTR}]`) : null;
    if (!el) return;
    const command = el.getAttribute(COMMAND_ATTR);
    const payload = el.getAttribute(PAYLOAD_ATTR);
    if (!command) return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    const c = controller();
    if (c) c.reset();
    runtime.run(command, payload === null ? undefined : payload);
    if (runtime.overlays.isOpen) runtime.overlays.closeAll();
  };

  root.addEventListener('input', onInput, true);
  root.addEventListener('keydown', onKeyDown, true);
  root.addEventListener('click', onClick, false);

  return () => {
    root.removeEventListener('input', onInput, true);
    root.removeEventListener('keydown', onKeyDown, true);
    root.removeEventListener('click', onClick, false);
  };
}

/**
 * @param {any} el
 * @returns {boolean}
 */
function isJumpInput(el) {
  return !!(el && typeof el.hasAttribute === 'function' && el.hasAttribute(JUMP_INPUT_ATTR));
}
