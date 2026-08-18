/**
 * The overlay system (§11, §12).
 *
 * Overlays are a stack, not a boolean per panel. Escape closes the topmost one
 * and nothing else; opening the branch map from the jump index and pressing
 * Escape twice puts the presenter back on the scene, in that order, every time.
 *
 * The stack also owns focus. An overlay that takes keyboard focus has to give
 * it back to exactly the element that had it, because a presenter who opens the
 * jump index by accident and closes it must not lose their place in the deck.
 *
 * L2 owns the mechanism. The *contents* of the jump index and the branch map
 * belong to L9 and register themselves through `registerOverlay`.
 *
 * @module runtime/overlays
 */

import { Emitter } from '../core/events.js';

/** Overlay ids the runtime knows about. Lanes may register more. */
export const OVERLAY = {
  jump: 'jump',
  map: 'map',
  contents: 'contents',
  help: 'help',
};

/**
 * @typedef {object} OverlayDefinition
 * @property {string} id
 * @property {string} title
 * @property {boolean} takesFocus     the overlay contains a focusable control
 * @property {boolean} [dismissOnNavigate]  close when the deck moves under it
 * @property {(ctx: any) => import('../core/vdom.js').VNode} render
 */

/**
 * A stack of open overlays over one host.
 */
export class OverlayStack extends Emitter {
  constructor() {
    super();
    /** @type {Map<string, OverlayDefinition>} */
    this.registry = new Map();
    /** @type {string[]} */
    this.stack = [];
    /** @type {Element|null} */
    this.focusBefore = null;
  }

  /**
   * @param {OverlayDefinition} def
   * @returns {() => void} unregister
   */
  register(def) {
    if (!def || !def.id) throw new Error('overlays: a definition needs an id');
    this.registry.set(def.id, def);
    return () => this.registry.delete(def.id);
  }

  /** @returns {string|null} the topmost open overlay */
  get top() { return this.stack.length ? this.stack[this.stack.length - 1] : null; }
  /** @returns {boolean} */
  get isOpen() { return this.stack.length > 0; }

  /** @param {string} id @returns {boolean} */
  has(id) { return this.stack.includes(id); }

  /**
   * Open an overlay. Opening one that is already open raises it to the top
   * rather than stacking a duplicate.
   * @param {string} id
   * @param {{activeElement?: Element|null}} [env]
   * @returns {boolean} whether anything changed
   */
  open(id, env = {}) {
    const def = this.registry.get(id);
    if (!def) return false;
    if (this.stack.length === 0 && env.activeElement !== undefined) this.focusBefore = env.activeElement;
    const at = this.stack.indexOf(id);
    if (at >= 0) {
      if (at === this.stack.length - 1) return false;
      this.stack.splice(at, 1);
    }
    this.stack.push(id);
    this.emit('change', { open: this.stack.slice(), top: id, reason: 'open' });
    return true;
  }

  /**
   * Close the topmost overlay, or a named one wherever it sits in the stack.
   * @param {string} [id]
   * @returns {string|null} the id that closed
   */
  close(id) {
    if (this.stack.length === 0) return null;
    let closed;
    if (id === undefined) closed = this.stack.pop();
    else {
      const at = this.stack.indexOf(id);
      if (at < 0) return null;
      closed = this.stack.splice(at, 1)[0];
    }
    this.emit('change', { open: this.stack.slice(), top: this.top, reason: 'close', closed });
    return closed;
  }

  /** Close every overlay at once. */
  closeAll() {
    if (this.stack.length === 0) return;
    const was = this.stack.slice();
    this.stack = [];
    this.emit('change', { open: [], top: null, reason: 'closeAll', closed: was });
  }

  /**
   * Toggle: open if closed, close if it is the topmost, raise if it is buried.
   * @param {string} id
   * @param {{activeElement?: Element|null}} [env]
   * @returns {boolean} whether the overlay is open afterwards
   */
  toggle(id, env = {}) {
    if (this.top === id) { this.close(id); return false; }
    return this.open(id, env) || this.has(id);
  }

  /**
   * Called by the host when the deck moves. Overlays that describe a position
   * (the branch map, the contents index) close; the jump index closes because
   * the jump it performed is the reason the deck moved.
   */
  handleNavigation() {
    const survivors = this.stack.filter((id) => {
      const def = this.registry.get(id);
      return def && def.dismissOnNavigate === false;
    });
    if (survivors.length === this.stack.length) return;
    const closed = this.stack.filter((id) => !survivors.includes(id));
    this.stack = survivors;
    this.emit('change', { open: this.stack.slice(), top: this.top, reason: 'navigate', closed });
  }

  /**
   * The element focus should return to once every overlay is closed.
   * @returns {Element|null}
   */
  takeFocusBefore() {
    const el = this.focusBefore;
    this.focusBefore = null;
    return el;
  }

  /** @returns {OverlayDefinition|null} */
  topDefinition() {
    return this.top ? this.registry.get(this.top) || null : null;
  }
}

/**
 * Focus containment for a live overlay element. Tab and Shift-Tab cycle inside
 * the overlay rather than walking out into the scene behind it.
 * @param {Element} root
 * @param {{key: string, shiftKey?: boolean, preventDefault?: () => void}} event
 * @returns {boolean} whether the event was handled
 */
export function trapFocus(root, event) {
  if (!root || event.key !== 'Tab') return false;
  const focusable = focusableWithin(root);
  if (focusable.length === 0) return false;
  const doc = root.ownerDocument;
  const active = doc ? doc.activeElement : null;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && (active === first || !root.contains(active))) {
    if (event.preventDefault) event.preventDefault();
    last.focus();
    return true;
  }
  if (!event.shiftKey && (active === last || !root.contains(active))) {
    if (event.preventDefault) event.preventDefault();
    first.focus();
    return true;
  }
  return false;
}

/** Selector for the controls an overlay can contain. */
export const FOCUSABLE_SELECTOR = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * @param {Element} root
 * @returns {HTMLElement[]}
 */
export function focusableWithin(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return [];
  return [...root.querySelectorAll(FOCUSABLE_SELECTOR)]
    .filter((el) => !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true');
}
