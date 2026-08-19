/**
 * The studio's DOM reconciler and its event plumbing.
 *
 * §15 requires undo/redo across a destructive editing surface used under time
 * pressure. That rules out the obvious approach of re-mounting the whole VNode
 * tree on every change (`vdom.mount`), because re-mounting throws away focus,
 * caret position, scroll offsets and any element another owner is holding — and
 * the studio *does* have such an element: the live preview, whose subtree
 * belongs to `RuntimeHost` (§15 "the studio preview and the artifact are the
 * same code").
 *
 * So this module patches instead of replacing:
 *
 *   - Elements with the same tag and the same `data-st-key` are updated in
 *     place, which is what keeps the caret where the user left it.
 *   - An element carrying `data-st-preserve` has its attributes patched and its
 *     children left completely alone. That is the seam the preview mounts into.
 *   - `value` and `checked` are written as *properties* and only when they
 *     actually differ, so a controlled text field never fights the person typing
 *     into it.
 *
 * Interaction is delegated, not bound. A node declares `data-st-act="<action>"`
 * and optional `data-st-arg`; one listener per event type at the root turns that
 * into a dispatch. Two things follow, and both matter:
 *
 *   - the VNode tree contains no functions, so `toHtml(render(state))` is a pure
 *     string — which is exactly what `test/ui/render-determinism.test.mjs`
 *     asserts twice over;
 *   - every interactive affordance in the studio is discoverable by walking the
 *     rendered HTML for `data-st-act`, which is how the keyboard-reachability
 *     test enumerates the UI instead of trusting a hand-written list (§20.10).
 *
 * @module ui/render
 */

import { styleString } from '../core/vdom.js';

/** Attribute naming the action a node dispatches. */
export const ACT_ATTR = 'data-st-act';
/** Attribute carrying the action's argument. */
export const ARG_ATTR = 'data-st-arg';
/** Attribute naming the DOM event that triggers the action (default: click). */
export const EVENT_ATTR = 'data-st-on';
/** Attribute marking a subtree owned by someone else — patched but never entered. */
export const PRESERVE_ATTR = 'data-st-preserve';
/** Attribute giving a node a stable identity across renders. */
export const KEY_ATTR = 'data-st-key';
/** Attribute marking an element whose innerHTML is raw markup keyed by a digest. */
export const RAW_ATTR = 'data-st-raw';
/** Attribute naming the action Enter runs while focus is inside a text field. */
export const ENTER_ATTR = 'data-st-enter';

/** Events the root listens for. `input` covers typing; `change` covers commit. */
export const DELEGATED_EVENTS = ['click', 'input', 'change', 'keydown', 'submit', 'dblclick', 'focusin'];

/** Attributes that must be written as DOM properties rather than attributes. */
const PROPERTY_ATTRS = new Set(['value', 'checked', 'selected', 'indeterminate']);

/**
 * Flatten a VNode's children into the list the patcher walks: arrays spread,
 * nullish and `false` dropped, numbers stringified.
 * @param {unknown} node
 * @param {unknown[]} [out]
 * @returns {unknown[]}
 */
export function flatten(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out;
  if (Array.isArray(node)) { for (const c of node) flatten(c, out); return out; }
  out.push(node);
  return out;
}

/** @param {unknown} n @returns {boolean} */
function isText(n) { return typeof n === 'string' || typeof n === 'number'; }

/** @param {any} n @returns {boolean} */
function isElement(n) { return !!n && typeof n === 'object' && typeof n.t === 'string'; }

/**
 * Can `dom`, which currently represents `prev`, be updated into `next` in
 * place? Same node kind, same tag and same key.
 * @param {any} prev
 * @param {any} next
 * @returns {boolean}
 */
function compatible(prev, next) {
  if (isText(prev) && isText(next)) return true;
  if (!isElement(prev) || !isElement(next)) return false;
  if (prev.t !== next.t) return false;
  return (prev.a || {})[KEY_ATTR] === (next.a || {})[KEY_ATTR];
}

/**
 * Create real DOM for a VNode. Deliberately narrower than `vdom.toDom`: the
 * studio tree never contains `raw` nodes (they go through `RAW_ATTR` instead),
 * so this always returns a single node and the child indexes stay aligned.
 * @param {any} node
 * @param {Document} doc
 * @returns {Node}
 */
export function create(node, doc) {
  if (isText(node)) return doc.createTextNode(String(node));
  if (!isElement(node)) return doc.createTextNode('');
  const el = doc.createElement(node.t);
  applyAttrs(el, {}, node.a || {});
  if (node.a && node.a[PRESERVE_ATTR] !== undefined) return el;
  for (const child of flatten(node.c)) el.appendChild(create(child, doc));
  return el;
}

/**
 * Write the attribute delta from `prev` to `next` onto an element.
 * @param {Element} el
 * @param {Record<string, unknown>} prev
 * @param {Record<string, unknown>} next
 */
export function applyAttrs(el, prev, next) {
  for (const key of Object.keys(prev)) {
    if (key in next) continue;
    if (PROPERTY_ATTRS.has(key)) { setProperty(el, key, key === 'value' ? '' : false); continue; }
    el.removeAttribute(key);
  }
  for (const [key, raw] of Object.entries(next)) {
    if (key === RAW_ATTR) continue;                 // handled by the child walk
    const value = key === 'style' && raw && typeof raw === 'object'
      ? styleString(/** @type {Record<string, string>} */ (raw))
      : raw;
    if (PROPERTY_ATTRS.has(key)) { setProperty(el, key, value); continue; }
    if (value === null || value === undefined || value === false) { el.removeAttribute(key); continue; }
    if (value === true) { if (el.getAttribute(key) !== '') el.setAttribute(key, ''); continue; }
    const str = String(value);
    if (el.getAttribute(key) !== str) el.setAttribute(key, str);
  }
}

/**
 * Write a controlled property, and only when it differs. Writing `value` when
 * it already matches would still move the caret to the end in some browsers,
 * which is the whole reason this is a separate path.
 * @param {any} el
 * @param {string} key
 * @param {unknown} value
 */
function setProperty(el, key, value) {
  if (key === 'value') {
    const str = value === null || value === undefined ? '' : String(value);
    if (el.value !== str) el.value = str;
    return;
  }
  const bool = !!value;
  if (el[key] !== bool) el[key] = bool;
}

/**
 * Update `dom` (currently rendering `prev`) to render `next`.
 * @param {Node} dom
 * @param {any} prev
 * @param {any} next
 * @param {Document} doc
 */
function update(dom, prev, next, doc) {
  if (isText(next)) {
    const str = String(next);
    if (dom.nodeValue !== str) dom.nodeValue = str;
    return;
  }
  const el = /** @type {Element} */ (dom);
  applyAttrs(el, (prev && prev.a) || {}, next.a || {});

  if (next.a && next.a[PRESERVE_ATTR] !== undefined) return;

  if (next.a && next.a[RAW_ATTR] !== undefined) {
    const before = prev && prev.a ? prev.a[RAW_ATTR] : undefined;
    if (before !== next.a[RAW_ATTR]) {
      el.innerHTML = '';
      const tpl = doc.createElement('template');
      tpl.innerHTML = String(next.c && next.c.length ? rawTextOf(next.c) : '');
      el.appendChild(tpl.content.cloneNode(true));
      el.setAttribute(RAW_ATTR, String(next.a[RAW_ATTR]));
    }
    return;
  }

  patchChildren(el, flatten(prev && prev.c), flatten(next.c), doc);
}

/** @param {unknown[]} children @returns {string} */
function rawTextOf(children) {
  return flatten(children).map((c) => (isText(c) ? String(c) : '')).join('');
}

/**
 * Reconcile a child list by position, replacing whenever the node kind, tag or
 * key changed. Positional matching is right for the studio: its lists are
 * rendered from ordered model arrays, and every row that can move carries a
 * `data-st-key`, so a reorder replaces exactly the rows that moved.
 * @param {Element} el
 * @param {unknown[]} prev
 * @param {unknown[]} next
 * @param {Document} doc
 */
function patchChildren(el, prev, next, doc) {
  const nodes = el.childNodes;
  const shared = Math.min(prev.length, next.length);
  for (let i = 0; i < shared; i++) {
    const dom = nodes[i];
    if (!dom) { el.appendChild(create(next[i], doc)); continue; }
    if (compatible(prev[i], next[i])) update(dom, prev[i], next[i], doc);
    else el.replaceChild(create(next[i], doc), dom);
  }
  for (let i = prev.length; i < next.length; i++) el.appendChild(create(next[i], doc));
  while (nodes.length > next.length) el.removeChild(nodes[nodes.length - 1]);
}

/**
 * A root that keeps its last tree and patches forward.
 */
export class Patcher {
  /**
   * @param {Element} root
   * @param {Document} doc
   */
  constructor(root, doc) {
    this.root = root;
    this.doc = doc;
    /** @type {any} */
    this.prev = null;
  }

  /**
   * Render a tree into the root, patching against the previous one.
   * @param {any} tree
   */
  render(tree) {
    const next = flatten(tree);
    patchChildren(this.root, flatten(this.prev), next, this.doc);
    this.prev = next;
  }

  /** Forget the previous tree so the next render rebuilds from scratch. */
  reset() {
    while (this.root.firstChild) this.root.removeChild(this.root.firstChild);
    this.prev = null;
  }
}

/**
 * Walk up from an event target to the nearest node declaring an action.
 * @param {any} target
 * @param {Element} root
 * @param {string} eventType
 * @returns {{action: string, arg: string|null, element: Element}|null}
 */
export function actionFor(target, root, eventType) {
  let el = target;
  while (el && el !== root && el.nodeType !== 9) {
    if (el.nodeType === 1 && el.hasAttribute && el.hasAttribute(ACT_ATTR)) {
      const declared = el.getAttribute(EVENT_ATTR) || defaultEventFor(el);
      if (declared === eventType) {
        return { action: el.getAttribute(ACT_ATTR), arg: el.getAttribute(ARG_ATTR), element: el };
      }
      return null;
    }
    el = el.parentNode;
  }
  return null;
}

/**
 * The event an element responds to when it does not say. Text entry reacts to
 * every keystroke so edits coalesce into one undo step; everything else reacts
 * to a click, which is also what a keyboard Enter/Space produces on a button.
 * @param {Element} el
 * @returns {string}
 */
export function defaultEventFor(el) {
  const tag = (el.tagName || '').toLowerCase();
  if (tag === 'textarea') return 'input';
  if (tag === 'select') return 'change';
  if (tag === 'input') {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (['checkbox', 'radio', 'file', 'range', 'color'].includes(type)) return 'change';
    return 'input';
  }
  return 'click';
}

/**
 * The value an element carries into its action.
 * @param {any} el
 * @returns {string|boolean|null}
 */
export function valueOf(el) {
  const tag = (el.tagName || '').toLowerCase();
  if (tag === 'input') {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (type === 'checkbox' || type === 'radio') return !!el.checked;
    if (type === 'file') return null;
    return el.value;
  }
  if (tag === 'textarea' || tag === 'select') return el.value;
  return null;
}

/**
 * Attach the delegated listeners.
 * @param {Element} root
 * @param {(dispatch: {action: string, arg: string|null, value: string|boolean|null, element: Element, event: any}) => void} handler
 * @returns {() => void} detach
 */
export function delegate(root, handler) {
  /** @type {(() => void)[]} */
  const off = [];
  for (const type of DELEGATED_EVENTS) {
    const fn = (event) => {
      const hit = actionFor(event.target, root, type);
      if (!hit) return;
      if (type === 'submit' && event.preventDefault) event.preventDefault();
      handler({ action: hit.action, arg: hit.arg, value: valueOf(hit.element), element: hit.element, event });
    };
    root.addEventListener(type, fn);
    off.push(() => root.removeEventListener(type, fn));
  }
  return () => { for (const fn of off) fn(); };
}
