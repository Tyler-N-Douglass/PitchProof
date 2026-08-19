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
 *   data-pp-inset="a,b"     subtract these geometry tokens (or literal px) from the width
 *   data-pp-width="<t>"     this element's inner width *is* this token (or px)
 *   data-pp-max="<t>"       a `max-width` the stylesheet caps this element with
 *   data-pp-fit="<why>"     this element's own box is not the extent at which
 *                           its content is lost; the reported width is the
 *                           *room* it has and is a bound, not an equality.
 *                           Two shapes, two reasons, one consequence:
 *                             shrink — the box is as wide as its words
 *                                      (`inline-flex` pill, `inline-block` CTA)
 *                             spill  — the box is a gutter reserved for a mark,
 *                                      which the stylesheet neither paints at
 *                                      nor clips (the list-marker column)
 *   data-pp-lines="<n>"     this element's block box is exactly n line boxes of
 *                           its own role — the height it is measured against
 *
 * `data-pp-width` and `data-pp-max` exist because `box`, `frac` and `inset`
 * could only ever *narrow* a box by a declared amount, and two shapes in the
 * stylesheet are not that: a fixed grid track (the list marker column, the
 * source chip beside a scene headline) and a `max-width` cap on prose. Both
 * were previously invisible to the model, which then handed the detector a
 * container two to ten times wider than the one Chromium draws — CRITIQUE-2's
 * C1, and the single largest source of the missed truncations it measured.
 *
 * `data-pp-lines` exists because a run whose box is its own content — a block
 * in normal flow — inherited its slot's height, and a slot is the whole column.
 * `badgeNumber` was measured against `fanSource`'s 536px rather than the 40px
 * line box it actually occupies, so **no height check on that role could fire
 * at any content, at any breakpoint** (DEFERRED.md). A hole in the measurement
 * is not made safe by the box happening not to clip; it is made safe by
 * measuring the box. The declared line count is an equality
 * `test/scene/geometry-browser.test.mjs` checks against Chromium's own
 * `clientHeight`, so it cannot drift from the stylesheet either.
 *
 * A token whose value is a percentage (`'100%'`, the stacked-at-`sm` form used
 * throughout `GEOM`) contributes **zero** to an inset and leaves a
 * `data-pp-width` unchanged: it is the stylesheet saying "at this breakpoint
 * this track is the whole row and its siblings stack below it", which is
 * exactly what `isProportional()` already means for `fan-source-w` and
 * `note-w`. One rule, so a layout never has to ask which breakpoint it is on.
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
import { geom, isProportional, TYPE_ROLES } from './tokens.js';
import { styleForRole } from './type-scale.js';
import { neutralBrand, borderWidthFor } from './brand-access.js';
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
 * @property {boolean} [fitsContent]          extension: `containerWidthPx` is the room this box has, not the box it fills
 * @property {'shrink'|'spill'} [fit]         extension: why it is a room and not a box
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
   * @param {{elementId: string|null, slot: string|null, containerId: string|null, widthPx: number, heightPx: number, scaleN?: number, ledger?: boolean, edited?: boolean}} state
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

    // The §18.3 edited notice is the second foot strip, declared the same way by
    // `withEditedNotice` and costing its own room. The two are independent: a
    // scene can carry an unlabelled rendition, an edited specimen, or both.
    if (attrs['data-pp-edited'] !== undefined && attrs['data-pp-edited'] !== null) {
      next = { ...next, edited: Number(attrs['data-pp-edited']) > 0 };
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
        edited: slot === 'editedNotice' ? false : next.edited,
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

    const fit = fitReason(attrs);
    // A `spill` box's declared track is a gutter, not a boundary: the mark in it
    // is painted in full past its edge and nothing clips it, so the track is not
    // the extent at which content is lost and must not be reported as one. The
    // track itself stays on the element, where `scenes.css` sets it and
    // test/scene/geometry-browser.test.mjs checks the browser draws it.
    if (attrs['data-pp-width'] !== undefined && attrs['data-pp-width'] !== null && fit !== 'spill') {
      const fixed = trackWidth(String(attrs['data-pp-width']), bp, next.widthPx);
      next = { ...next, widthPx: fixed };
    }
    if (attrs['data-pp-frac'] !== undefined) {
      const k = Math.max(1, Number(attrs['data-pp-frac']) || 1);
      next = { ...next, widthPx: next.widthPx / k };
    }
    if (typeof attrs['data-pp-inset'] === 'string') {
      const total = attrs['data-pp-inset'].split(',')
        .map((t) => t.trim()).filter(Boolean)
        .reduce((sum, token) => sum + insetLength(token, bp, brand), 0);
      next = { ...next, widthPx: Math.max(0, next.widthPx - total) };
    }
    if (attrs['data-pp-max'] !== undefined && attrs['data-pp-max'] !== null) {
      const cap = trackWidth(String(attrs['data-pp-max']), bp, next.widthPx);
      next = { ...next, widthPx: Math.min(next.widthPx, cap) };
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
          scale: spec.svg ? mapScale(bp, next.scaleN, next.ledger, next.edited) : 1,
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
        // A block in normal flow is as tall as its own lines, not as tall as the
        // slot it sits in. Where the design gives an element a fixed number of
        // them, the layout says so and the height axis has a box to fire
        // against — see the module note on `badgeNumber`.
        if (attrs['data-pp-lines'] !== undefined && attrs['data-pp-lines'] !== null) {
          const lines = Math.max(1, Math.floor(Number(attrs['data-pp-lines'])) || 1);
          box.containerHeightPx = round3(lines * resolved.style.fontSizePx * resolved.style.lineHeight);
        }
        // The shapes whose own box is not the extent at which their content is
        // lost: the `inline-flex` provenance pill and the `inline-block` CTA,
        // which are as wide as their words, and the list-marker gutter, which a
        // long ordinal is painted straight past. For those, `containerWidthPx`
        // is the room the element has rather than the box it fills — what a
        // longer label, or the same label in a brand face with wider advances,
        // would need. Reported with the reason so a reader of the measurement
        // can tell the meanings apart; every other box is an equality
        // `test/scene/geometry-browser.test.mjs` checks against Chromium.
        if (fit) {
          box.fitsContent = true;
          box.fit = fit;
        }
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
    edited: false,
  });
  return boxes;
}

/**
 * Why an element's reported container is the room it has rather than the box it
 * fills, or `null` where it is the box.
 *
 * Both reasons make `containerWidthPx` a **bound**, and §22.2's direction rule
 * is why a bound is acceptable at all: where the model and the page can honestly
 * differ, the model must claim *less* room than the page has, so the error falls
 * towards a warning nobody needed rather than a truncation nobody saw.
 *
 *  - `shrink`: the element is as wide as its words. Its box is narrower than the
 *    room whenever the label is short, and the number that matters is the room —
 *    what a longer label, or the same label in a brand face with wider advances,
 *    would fill.
 *  - `spill`: the element's box is a gutter the layout reserves for a mark. The
 *    stylesheet paints nothing at its edge and clips nothing there, so a mark
 *    wider than the gutter is drawn in full in space the design already leaves
 *    empty, and the extent at which anything is actually lost is the room the
 *    containing box gives it. The claim is not taken on trust: for every element
 *    carrying it, test/scene/geometry-browser.test.mjs asserts in Chromium that
 *    nothing between the mark and the stage clips, and that the mark's own ink
 *    stays inside the room the model reports — so the box stays in the detector's
 *    population and the declaration fails the run it stops being true.
 *
 * A bare `data-pp-fit` with no reason is `shrink`, which is what it meant before
 * there was a second one.
 * @param {Record<string, unknown>} attrs
 * @returns {'shrink'|'spill'|null}
 */
export function fitReason(attrs) {
  const declared = attrs['data-pp-fit'];
  if (declared === undefined || declared === null || declared === false) return null;
  return declared === 'spill' ? 'spill' : 'shrink';
}

/**
 * One entry of a `data-pp-inset` list, in px.
 *
 * A geometry token resolves through `GEOM`; a bare number is a literal the
 * stylesheet spells out in place (`.pp-quote`'s 12px rule gutter plus its 2px
 * rule, `.pp-empty`'s 24px padding inside its 1px dashed frame). Literals are
 * allowed because the guard against them drifting is no longer the token table
 * — it is `test/scene/geometry-browser.test.mjs`, which lays the emitted
 * artifact out in Chromium and fails when any measured container disagrees with
 * the box the browser draws. That check is strictly stronger than a copy of the
 * number in two files, and it catches the padding a token table never saw.
 *
 * A percentage token contributes nothing: see the module note.
 * @param {string} token
 * @param {'sm'|'md'|'lg'} bp
 * @returns {number}
 */
export function insetLength(token, bp, brand = null) {
  const literal = Number(token);
  if (Number.isFinite(literal)) return literal;
  // The one length in the stylesheet that is the *prospect's* rather than the
  // deck's: `.pp-cta { border: var(--pp-border-width) }`, one on each side.
  if (token === BRAND_BORDER_INSET) return borderWidthFor(brand) * 2;
  if (isProportional(bp, token)) return 0;
  return geom(bp, token);
}

/**
 * The `data-pp-inset` token that resolves to twice the brand's border width.
 * Named rather than numeric because its value is not knowable until a brand is
 * in hand, which is the property that distinguishes it from every other inset.
 */
export const BRAND_BORDER_INSET = 'brand-border';

/**
 * A declared track width, in px: a geometry token, a literal, or — for a
 * percentage token — the width the element already had, because at that
 * breakpoint the track is the whole row.
 * @param {string} token
 * @param {'sm'|'md'|'lg'} bp
 * @param {number} currentPx
 * @returns {number}
 */
export function trackWidth(token, bp, currentPx) {
  const literal = Number(token);
  if (Number.isFinite(literal)) return Math.max(0, literal);
  if (isProportional(bp, token)) return currentPx;
  return Math.max(0, geom(bp, token));
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
