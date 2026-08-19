/**
 * `measureScene` — every text box a layout renders, with the style and the
 * container the CSS will actually give it (§14, §22.2).
 *
 * This is the input the overflow detector runs on, and the one property that
 * matters is completeness: **if a layout renders text this does not report, the
 * detector cannot see it.** So the box list is not a parallel description of
 * the layouts maintained by hand — it is produced by rendering the layout and
 * walking the tree it returned. A layout can only render text inside an element
 * carrying `data-pp-tx`, that attribute is what `scenes.css` styles, and
 * test/scene/measure.test.mjs walks the rendered tree independently and fails
 * on any text run that did not come back in the measurement.
 *
 * Three attributes carry container information down the tree, so a box's inner
 * width is derived rather than assumed:
 *
 *   data-pp-box="<slot>"    the named geometry slot (see geometry.js)
 *   data-pp-frac="<k>"      this element is one of k equal columns of its box
 *   data-pp-inset="a,b"     subtract these geometry tokens from the width
 *
 * and three describe the CSS the run is subject to, read straight back off the
 * element the stylesheet matched on:
 *
 *   data-pp-ws="nowrap"     white-space
 *   data-pp-ow="break-word" overflow-wrap
 *   data-pp-clamp="3"       -webkit-line-clamp, and with it `text-overflow`
 *
 * From that last one comes `textOverflow`, the field that tells the detector
 * whether an overflow is *silent* or *visible* (CRITIQUE-1 F6). A clamped run
 * is truncated with an ellipsis the viewer can see — one line clamps declare
 * `text-overflow: ellipsis` outright, multi-line clamps get the ellipsis from
 * `-webkit-line-clamp` — so a clamp is graded as a visible truncation.
 * Everything else is `clip`: if that text does not fit, it is cut or pushed off
 * the frame with nothing on screen to say so, which is the case §22.2 exists to
 * block. A layout may override with `data-pp-to` where it knows better.
 *
 * @module scene/measure
 */

import { elementId } from '../core/ids.js';
import { boxGeometry, breakpointId, mapScale } from './geometry.js';
import { geom, TYPE_ROLES } from './tokens.js';
import { styleForRole } from './type-scale.js';
import { neutralBrand } from './brand-access.js';
import { layoutFunction } from './layouts/all.js';

/**
 * @typedef {object} MeasuredBox
 * @property {string|null} elementId          the nearest revealable ancestor's id
 * @property {string} role                    the `data-pp-tx` role
 * @property {string} text
 * @property {import('../core/text-metrics.js').TextStyle} style
 * @property {number} containerWidthPx
 * @property {number} containerHeightPx
 * @property {string} [whiteSpace]
 * @property {string} [overflowWrap]
 * @property {number} [maxLines]
 * @property {'clip'|'ellipsis'} textOverflow   what the viewer sees when it does not fit
 * @property {string[]} [fontStack]           extension: the stack `style.family` heads
 * @property {string} [containerId]           extension: boxes sharing one container
 * @property {string} [slot]                  extension: the geometry slot's name
 */

/**
 * @typedef {object} SceneMeasurement
 * @property {string} sceneId
 * @property {'sm'|'md'|'lg'} breakpoint
 * @property {MeasuredBox[]} boxes
 */

/**
 * Fill in whatever a caller left out of the layout context, without inventing
 * anything a layout would render as content.
 * @param {import('../core/contracts.d.ts').Scene} scene
 * @param {Partial<import('../runtime/layouts.js').LayoutContext>} ctx
 * @returns {import('../runtime/layouts.js').LayoutContext}
 */
export function normalizeContext(scene, ctx = {}) {
  const target = scene || ctx.scene;
  if (!target || !target.id) throw new Error('scene/measure: a scene with an id is required');
  return {
    scene: target,
    brand: ctx.brand || neutralBrand(),
    specimen: ctx.specimen === undefined ? null : ctx.specimen,
    renditions: Array.isArray(ctx.renditions) ? ctx.renditions : [],
    media: ctx.media instanceof Map ? ctx.media : new Map(),
    el: typeof ctx.el === 'function' ? ctx.el : (path) => elementId(target.id, path),
    labelIllustrative: ctx.labelIllustrative !== false,
    mode: ctx.mode === 'review' ? 'review' : 'presenter',
  };
}

/**
 * Render a scene through its layout — the same call the runtime makes, so the
 * measured tree and the presented tree are the same tree.
 * @param {import('../core/contracts.d.ts').Scene} scene
 * @param {Partial<import('../runtime/layouts.js').LayoutContext>} [ctx]
 * @returns {import('../core/vdom.js').VNode}
 */
export function renderSceneTree(scene, ctx = {}) {
  const full = normalizeContext(scene, ctx);
  return layoutFunction(full.scene.layout)(full);
}

/**
 * Measure a scene at a breakpoint.
 * @param {import('../core/contracts.d.ts').Scene} scene
 * @param {Partial<import('../runtime/layouts.js').LayoutContext>} ctx
 * @param {'sm'|'md'|'lg'|{id: string}} breakpoint
 * @returns {SceneMeasurement}
 */
export function measureScene(scene, ctx, breakpoint) {
  const bp = breakpointId(breakpoint);
  const full = normalizeContext(scene, ctx);
  const tree = layoutFunction(full.scene.layout)(full);
  return {
    sceneId: full.scene.id,
    breakpoint: bp,
    boxes: collectTextBoxes(tree, { breakpoint: bp, brand: full.brand }),
  };
}

/**
 * Walk a rendered tree and report every text run in it.
 * @param {import('../core/vdom.js').VNode} node
 * @param {{breakpoint: 'sm'|'md'|'lg', brand: import('../core/contracts.d.ts').BrandSystem|null}} env
 * @returns {MeasuredBox[]}
 */
export function collectTextBoxes(node, env) {
  const bp = breakpointId(env.breakpoint);
  const brand = env.brand || null;
  /** @type {MeasuredBox[]} */
  const boxes = [];
  /** @type {Map<string, number>} */
  const slotCounts = new Map();

  /**
   * @param {import('../core/vdom.js').VNode} n
   * @param {{elementId: string|null, slot: string|null, containerId: string|null, widthPx: number, heightPx: number, scaleN?: number, ledger?: boolean}} state
   */
  const visit = (n, state) => {
    if (n === null || n === undefined || n === false) return;
    if (Array.isArray(n)) { n.forEach((child) => visit(child, state)); return; }
    if (typeof n === 'string' || typeof n === 'number') return;   // handled by its tx ancestor
    if (typeof n !== 'object' || 'raw' in n) return;

    const attrs = n.a || {};
    let next = state;

    if (typeof attrs['data-pp-el'] === 'string') {
      next = { ...next, elementId: attrs['data-pp-el'] };
    }

    // A provenance ledger in flow at the foot of the stage takes vertical room
    // from everything above it. The layout root states how many rows it added
    // (`withProvenanceLedger`), and every box below inherits the fact, so the
    // slot geometry and the rendered box stay in agreement (§22.2).
    if (attrs['data-pp-ledger'] !== undefined && attrs['data-pp-ledger'] !== null) {
      next = { ...next, ledger: Number(attrs['data-pp-ledger']) > 0 };
    }

    if (typeof attrs['data-pp-box'] === 'string') {
      const slot = attrs['data-pp-box'];
      const params = {
        n: attrs['data-pp-n'] !== undefined ? Number(attrs['data-pp-n']) : undefined,
        unitWidth: attrs['data-pp-unit-w'] !== undefined ? Number(attrs['data-pp-unit-w']) : undefined,
        unitHeight: attrs['data-pp-unit-h'] !== undefined ? Number(attrs['data-pp-unit-h']) : undefined,
        variant: typeof attrs['data-pp-variant'] === 'string' ? attrs['data-pp-variant'] : undefined,
        // The ledger strip itself is not shortened by its own presence.
        ledger: slot === 'provenanceLedger' ? false : next.ledger,
      };
      const size = boxGeometry(slot, bp, params);
      const ordinal = (slotCounts.get(slot) || 0) + 1;
      slotCounts.set(slot, ordinal);
      // A layout that stacks several boxes inside one scrolling column names
      // that column with `data-pp-container`, so every box in it reports the
      // same `containerId` and the detector can sum them for the cumulative
      // case as well as checking each one on its own.
      const group = typeof attrs['data-pp-container'] === 'string' ? attrs['data-pp-container'] : null;
      next = {
        ...next,
        slot,
        containerId: group ? `${slot}:${group}` : `${slot}#${ordinal}`,
        widthPx: size.widthPx,
        heightPx: size.heightPx,
        scaleN: params.n || next.scaleN,
      };
    }

    if (attrs['data-pp-frac'] !== undefined) {
      const k = Math.max(1, Number(attrs['data-pp-frac']) || 1);
      next = { ...next, widthPx: next.widthPx / k };
    }
    if (typeof attrs['data-pp-inset'] === 'string') {
      const total = attrs['data-pp-inset'].split(',')
        .map((t) => t.trim()).filter(Boolean)
        .reduce((sum, token) => sum + geom(bp, token), 0);
      next = { ...next, widthPx: Math.max(0, next.widthPx - total) };
    }

    const role = attrs['data-pp-tx'];
    if (typeof role === 'string') {
      const text = plainText(n);
      if (text.trim()) {
        const spec = TYPE_ROLES[role];
        if (!spec) throw new Error(`scene/measure: element declares unknown text role "${role}"`);
        // SVG roles are drawn in design units and scale with the drawing, whose
        // scale depends on how many legend chips sit under it — the count the
        // element carries as `data-pp-n`.
        const resolved = styleForRole(role, bp, brand, {
          scale: spec.svg ? mapScale(bp, next.scaleN, next.ledger) : 1,
        });
        /** @type {MeasuredBox} */
        const box = {
          elementId: next.elementId,
          role,
          text,
          style: resolved.style,
          containerWidthPx: round3(next.widthPx),
          containerHeightPx: round3(next.heightPx),
        };
        if (typeof attrs['data-pp-ws'] === 'string') box.whiteSpace = attrs['data-pp-ws'];
        if (typeof attrs['data-pp-ow'] === 'string') box.overflowWrap = attrs['data-pp-ow'];
        if (attrs['data-pp-clamp'] !== undefined && attrs['data-pp-clamp'] !== null) {
          box.maxLines = Number(attrs['data-pp-clamp']);
          // A one-line clamp is `white-space: nowrap` plus an ellipsis in the
          // stylesheet rather than a `-webkit-box`, so the run does not wrap and
          // the detector should be checking its width, not its line count.
          if (box.maxLines === 1 && box.whiteSpace === undefined) box.whiteSpace = 'nowrap';
        }
        box.textOverflow = textOverflowOf(attrs);
        box.fontStack = resolved.fontStack;
        box.containerId = next.containerId;
        box.slot = next.slot;
        boxes.push(box);
      }
      // A text role never nests inside another; the coverage test asserts it,
      // so there is nothing below this node that is not already in `text`.
      return;
    }

    (n.c || []).forEach((child) => visit(child, next));
  };

  const root = boxGeometry('stage', bp);
  visit(node, {
    elementId: null,
    slot: 'stage',
    containerId: 'stage#0',
    widthPx: root.widthPx,
    heightPx: root.heightPx,
    scaleN: 1,
    ledger: false,
  });
  return boxes;
}

/**
 * What the viewer sees where a run does not fit its box.
 *
 * Derived from the same attribute that produces the CSS, so the reported value
 * cannot drift from the stylesheet: `[data-pp-clamp]` truncates with an
 * ellipsis (declared outright at one line, produced by `-webkit-line-clamp`
 * above it), and everything else is clipped or pushed out of frame with no mark
 * on screen. `data-pp-to` lets a layout state the answer directly.
 *
 * The two values carry the grading policy §22.2 rests on: `'clip'` is content
 * lost with nothing to show for it; `'ellipsis'` is content truncated where the
 * viewer can see that it was.
 * @param {Record<string, unknown>} attrs
 * @returns {'clip'|'ellipsis'}
 */
export function textOverflowOf(attrs) {
  const declared = attrs['data-pp-to'];
  if (declared === 'ellipsis' || declared === 'clip') return declared;
  const clamp = attrs['data-pp-clamp'];
  if (clamp !== undefined && clamp !== null && Number(clamp) > 0) return 'ellipsis';
  return 'clip';
}

/**
 * The text of a subtree, as one run. Adjacent string children are joined
 * without inserted whitespace — the tree has no whitespace the layout did not
 * put there (core/vdom.js).
 * @param {import('../core/vdom.js').VNode} node
 * @returns {string}
 */
export function plainText(node) {
  if (node === null || node === undefined || node === false) return '';
  if (Array.isArray(node)) return node.map(plainText).join('');
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (typeof node !== 'object' || 'raw' in node) return '';
  return (node.c || []).map(plainText).join('');
}

/** @param {number} n @returns {number} */
function round3(n) {
  return Math.round(n * 1000) / 1000;
}
