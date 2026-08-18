/**
 * The DOM binding for the runtime (§12).
 *
 * Everything above this file is document-free. This is where a `Runtime`
 * becomes something a presenter can stand in front of: it mounts the stage,
 * re-renders on state change, applies the canonical scroll for the beat, wires
 * the keyboard, and honours the motion budget.
 *
 * Two properties matter more than anything else here:
 *
 *   - **It hydrates rather than replaces.** The emitter writes the opening beat
 *     into the document as static HTML so the artifact paints before a line of
 *     script runs; if the host cleared and re-rendered on boot, that first paint
 *     would flash. It re-renders only from the first state change onward.
 *   - **It never reaches the network.** There is no loading of any kind in this
 *     file, by construction and by the emitter's scanner (§13).
 *
 * @module runtime/host
 */

import { mount, toDom } from '../core/vdom.js';
import { transitionMs } from './beats.js';
import { trapFocus, focusableWithin } from './overlays.js';
import { MAX_TRANSITION_MS } from '../core/contracts.js';

/** Marks the element the emitter pre-rendered, so the host can hydrate it. */
export const STAGE_ROOT_ID = 'pp-stage-root';

/** Data attribute the pre-rendered first paint carries. */
export const PRERENDERED_ATTR = 'data-pp-prerendered';

/**
 * Bind a runtime to a document.
 */
export class RuntimeHost {
  /**
   * @param {import('./runtime.js').Runtime} runtime
   * @param {object} env
   * @param {Document} env.document
   * @param {Element} [env.root]
   * @param {Window} [env.window]
   */
  constructor(runtime, env) {
    this.runtime = runtime;
    this.doc = env.document;
    this.win = env.window || (this.doc.defaultView || null);
    this.root = env.root || this.doc.getElementById(STAGE_ROOT_ID) || this.doc.body;
    this.attached = false;
    /** @type {(() => void)[]} */
    this.teardown = [];
    this.hydrated = false;
  }

  /**
   * Start listening and take over rendering.
   * @returns {this}
   */
  attach() {
    if (this.attached) return this;
    this.attached = true;

    this.applyMotionPreference();
    // The first paint is already in the document. Adopt it instead of
    // replacing it, so the artifact never flashes on open.
    if (this.root.hasAttribute && this.root.hasAttribute(PRERENDERED_ATTR)) {
      this.hydrated = true;
      this.root.removeAttribute(PRERENDERED_ATTR);
      this.applyScroll();
    } else {
      this.paint();
    }

    const onChange = () => this.paint();
    this.teardown.push(this.runtime.on('change', onChange));

    const onKey = (event) => {
      const active = this.doc.activeElement;
      const typing = isTextEntry(active);
      if (trapFocus(this.overlayElement(), event)) return;
      this.runtime.handleKey(event, { typing, activeElement: active });
    };
    if (this.doc.addEventListener) {
      this.doc.addEventListener('keydown', onKey);
      this.teardown.push(() => this.doc.removeEventListener('keydown', onKey));
    }

    const onRequest = (req) => { if (req && req.kind === 'fullscreen') this.toggleFullscreen(); };
    this.teardown.push(this.runtime.on('request', onRequest));

    if (this.win && this.win.matchMedia) {
      const mq = this.win.matchMedia('(prefers-reduced-motion: reduce)');
      const onMotion = () => { this.runtime.reducedMotion = mq.matches; this.applyMotionPreference(); };
      if (mq.addEventListener) {
        mq.addEventListener('change', onMotion);
        this.teardown.push(() => mq.removeEventListener('change', onMotion));
      }
      this.runtime.reducedMotion = this.runtime.reducedMotion || mq.matches;
    }

    return this;
  }

  /** Stop listening and release every handler. */
  detach() {
    for (const fn of this.teardown.splice(0)) {
      try { fn(); } catch { /* a listener that is already gone is not an error */ }
    }
    this.attached = false;
  }

  /** Render the current state into the root. */
  paint() {
    mount(this.root, this.runtime.render());
    this.applyScroll();
    this.focusOverlay();
  }

  /**
   * The canonical scroll for the beat (DECISIONS D12). Derived from the beat,
   * never remembered, so stepping back always frames the same way.
   */
  applyScroll() {
    const frame = this.runtime.frame;
    const scroller = this.root.querySelector ? this.root.querySelector('.pp-scene') : null;
    if (!scroller) return;
    if (!frame || !frame.scrollTarget) {
      scroller.scrollTop = 0;
      return;
    }
    const target = this.root.querySelector(`[data-pp-el="${cssEscape(frame.scrollTarget)}"]`);
    if (!target || typeof target.getBoundingClientRect !== 'function') { scroller.scrollTop = 0; return; }
    const box = target.getBoundingClientRect();
    const frameBox = scroller.getBoundingClientRect();
    const already = box.top >= frameBox.top && box.bottom <= frameBox.bottom;
    if (already) return;
    const delta = box.top - frameBox.top - Math.max(0, (frameBox.height - box.height) / 3);
    const behavior = this.runtime.reducedMotion ? 'auto' : 'smooth';
    if (typeof scroller.scrollTo === 'function') {
      scroller.scrollTo({ top: Math.max(0, scroller.scrollTop + delta), behavior });
    } else {
      scroller.scrollTop = Math.max(0, scroller.scrollTop + delta);
    }
  }

  /** Move focus into an overlay when one opens, and back out when it closes. */
  focusOverlay() {
    const overlayEl = this.overlayElement();
    if (overlayEl) {
      const def = this.runtime.overlays.topDefinition();
      if (def && def.takesFocus) {
        const focusables = focusableWithin(overlayEl);
        if (focusables.length) focusables[0].focus();
      }
      return;
    }
    const back = this.runtime.overlays.takeFocusBefore();
    if (back && typeof back.focus === 'function' && this.doc.contains && this.doc.contains(back)) back.focus();
  }

  /** @returns {Element|null} */
  overlayElement() {
    return this.root.querySelector ? this.root.querySelector('.pp-overlay-layer') : null;
  }

  /**
   * The motion budget as a CSS variable, so every transition in the stylesheet
   * reads one number and `prefers-reduced-motion` is honoured in one place.
   */
  applyMotionPreference() {
    const ms = transitionMs(MAX_TRANSITION_MS, this.runtime.reducedMotion);
    const target = this.doc.documentElement || this.root;
    if (target && target.style) target.style.setProperty('--pp-transition-ms', `${ms}ms`);
    if (target && target.setAttribute) target.setAttribute('data-pp-reduced-motion', this.runtime.reducedMotion ? 'true' : 'false');
  }

  /** Full screen, when the browser offers it. Silent when it does not. */
  toggleFullscreen() {
    const el = this.doc.documentElement;
    if (!el) return;
    if (this.doc.fullscreenElement) {
      if (typeof this.doc.exitFullscreen === 'function') void this.doc.exitFullscreen().catch(() => {});
      return;
    }
    if (typeof el.requestFullscreen === 'function') void el.requestFullscreen().catch(() => {});
  }
}

/**
 * Is focus in a control where typing means text, not commands?
 * @param {Element|null} el
 * @returns {boolean}
 */
export function isTextEntry(el) {
  if (!el) return false;
  const tag = (el.tagName || '').toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag === 'input') {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    return !['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'file'].includes(type);
  }
  return el.getAttribute && el.getAttribute('contenteditable') === 'true';
}

/**
 * Escape a value for use inside an attribute selector. Element ids are minted
 * hex (`el_1a2b3c…`), so this only ever has work to do if a lane hands us
 * something else — and then it should still not break the selector.
 * @param {string} value
 * @returns {string}
 */
export function cssEscape(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}

/**
 * Serialize the opening beat to static HTML for the emitter's first paint.
 * Exported here rather than in the emitter so the markup the artifact opens
 * with is produced by the same code path that renders every later beat.
 * @param {import('./runtime.js').Runtime} runtime
 * @returns {import('../core/vdom.js').VNode}
 */
export function firstPaintTree(runtime) {
  return runtime.render();
}

/**
 * Mount a tree into a detached element. Used by the studio's live preview,
 * which renders the same tree the artifact will.
 * @param {import('../core/vdom.js').VNode} tree
 * @param {Document} doc
 * @returns {Node}
 */
export function renderToNode(tree, doc) {
  return toDom(tree, doc);
}
