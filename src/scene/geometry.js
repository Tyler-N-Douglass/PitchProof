/**
 * Scene geometry — the box dimensions the CSS gives every text container, at
 * each of the three §14 breakpoints, computed from the same tokens the
 * stylesheet is written from.
 *
 * This module exists because of §22.2. The overflow detector is handed a
 * container width and height per text run; if those numbers are a guess, the
 * highest-value check in the product is a guess. So every number here is
 * derived, and the derivation is stated next to it:
 *
 *   - the viewport comes from `BREAKPOINTS` in core/contracts.js (390/1024/1600);
 *   - the stage padding comes from `--pp-stage-pad` in runtime.css, which is
 *     `clamp(20px, 3.2vw, 56px)` — reproduced by `stagePadPx()` and asserted
 *     against the stylesheet by test/scene/css-agreement.test.mjs;
 *   - everything else comes from `GEOM` in tokens.js, which scenes.css declares
 *     verbatim as `--pp-sc-*` custom properties.
 *
 * Where a dimension is produced by a CSS grid rather than by a token — the two
 * equal columns of `splitBeforeAfter`, the equal cards of a fan — the formula
 * here is the one `1fr` tracks with a gap actually produce, so the agreement is
 * structural rather than copied.
 *
 * @module scene/geometry
 */

import { BREAKPOINTS } from '../core/contracts.js';
import { geom, isProportional, BP_IDS } from './tokens.js';

/**
 * The hairline every structural panel in a scene is drawn with, in px.
 *
 * Scene chrome is deliberately *not* drawn with the brand's `--pp-border-width`:
 * a prospect whose shape language says 4px borders would change every measured
 * container width by 8px, and the geometry would stop matching the stylesheet.
 * Brand border width is honoured where it belongs — on the content inside the
 * panels (tables, CTAs, media frames), where it does not move a text box's
 * inner width. Recorded in docs/decisions/L8-scenes.md.
 */
export const PANEL_BORDER_PX = 1;

/** The `systemMap` drawing's design space. The SVG scales; these do not. */
export const MAP_DESIGN = { width: 960, height: 540 };

/**
 * `--pp-stage-pad` from runtime.css: `clamp(20px, 3.2vw, 56px)`.
 * @param {number} viewportWidthPx
 * @returns {number}
 */
export function stagePadPx(viewportWidthPx) {
  return Math.min(56, Math.max(20, viewportWidthPx * 0.032));
}

/**
 * Normalise whatever a caller passes as a breakpoint into its id.
 * @param {string|{id?: string, width?: number}} bp
 * @returns {'sm'|'md'|'lg'}
 */
export function breakpointId(bp) {
  const id = typeof bp === 'string' ? bp : bp && bp.id;
  if (BP_IDS.includes(id)) return /** @type {'sm'|'md'|'lg'} */ (id);
  if (bp && typeof bp === 'object' && typeof bp.width === 'number') {
    const match = BREAKPOINTS.find((b) => b.width === bp.width);
    if (match) return /** @type {'sm'|'md'|'lg'} */ (match.id);
  }
  throw new Error(`scene/geometry: "${String(id)}" is not one of ${BP_IDS.join(', ')}`);
}

/**
 * @typedef {object} StageBox
 * @property {'sm'|'md'|'lg'} id
 * @property {number} viewportWidthPx
 * @property {number} viewportHeightPx
 * @property {number} stagePadPx
 * @property {number} contentWidthPx    inside .pp-scene's padding
 * @property {number} contentHeightPx
 * @property {number} headHeightPx      the scene header band
 * @property {number} bodyWidthPx       the layout body, below the header
 * @property {number} bodyHeightPx
 */

/**
 * The stage the layout is drawn into at a breakpoint.
 * @param {string|{id?: string}} bp
 * @returns {StageBox}
 */
export function stageBox(bp) {
  const id = breakpointId(bp);
  const view = BREAKPOINTS.find((b) => b.id === id);
  const pad = stagePadPx(view.width);
  const contentWidthPx = view.width - pad * 2;
  const contentHeightPx = view.height - pad * 2;
  const headHeightPx = geom(id, 'head-h');
  return {
    id,
    viewportWidthPx: view.width,
    viewportHeightPx: view.height,
    stagePadPx: pad,
    contentWidthPx,
    contentHeightPx,
    headHeightPx,
    bodyWidthPx: contentWidthPx,
    bodyHeightPx: contentHeightPx - headHeightPx - geom(id, 'head-gap'),
  };
}

/** A width/height pair, both in CSS px, both the *inner* box available to text. */
/**
 * @typedef {object} BoxSize
 * @property {number} widthPx
 * @property {number} heightPx
 */

/**
 * How many columns a fan grid has: the breakpoint's maximum, or the item count
 * when there are fewer items than columns. `scenes.css` expresses exactly this
 * with `--pp-sc-fan-cols` plus one `[data-pp-n="k"]` override per k below the
 * maximum, and test/scene/css-agreement.test.mjs checks each override.
 * @param {'sm'|'md'|'lg'} bp
 * @param {number} n
 * @returns {number}
 */
export function fanColumns(bp, n) {
  const max = geom(bp, 'fan-cols');
  return Math.max(1, Math.min(max, Math.max(1, n)));
}

/**
 * The height the `systemMap` legend takes: one row of chips per
 * `--pp-sc-map-legend-cols`, at `--pp-sc-map-legend-h` each.
 * @param {'sm'|'md'|'lg'} bpIn
 * @param {number} [n]   how many chips the legend holds
 * @returns {number}
 */
export function mapLegendHeight(bpIn, n = 1) {
  const bp = breakpointId(bpIn);
  const cols = Math.max(1, geom(bp, 'map-legend-cols'));
  const rows = Math.max(1, Math.ceil(Math.max(1, n) / cols));
  return rows * geom(bp, 'map-legend-h') + (rows - 1) * geom(bp, 'fan-gap');
}

/**
 * The scale the `systemMap` SVG is drawn at: `preserveAspectRatio="xMidYMid
 * meet"` on a 960x540 viewBox inside the canvas box is exactly `min(w/960,
 * h/540)`, so this is not an approximation of the CSS, it is the CSS.
 *
 * The canvas is what the body box has left once the legend has taken its rows,
 * floored at `--pp-sc-map-canvas-min-h` — the same floor `.pp-map-canvas`
 * declares. At the small breakpoint a five-output map plus its legend is taller
 * than the frame; the scene scrolls, and the floor is what keeps the drawing
 * legible rather than squeezing it to nothing.
 * @param {'sm'|'md'|'lg'} bpIn
 * @param {number} [n]   the legend's chip count
 * @returns {number}
 */
export function mapScale(bpIn, n = 1) {
  const bp = breakpointId(bpIn);
  const s = stageBox(bp);
  const canvasHeight = Math.max(
    geom(bp, 'map-canvas-min-h'),
    s.bodyHeightPx - mapLegendHeight(bp, n) - geom(bp, 'row-gap'),
  );
  return Math.min(s.bodyWidthPx / MAP_DESIGN.width, canvasHeight / MAP_DESIGN.height);
}

/**
 * Equal tracks from a CSS grid: `repeat(cols, minmax(0, 1fr))` with `gap`.
 * @param {number} totalPx
 * @param {number} cols
 * @param {number} gapPx
 * @returns {number}
 */
export function trackWidth(totalPx, cols, gapPx) {
  if (cols <= 0) return 0;
  return (totalPx - gapPx * (cols - 1)) / cols;
}

/** Shrink a box by symmetric padding and the panel hairline. */
function inset(widthPx, heightPx, padPx, border = PANEL_BORDER_PX) {
  return {
    widthPx: Math.max(0, widthPx - padPx * 2 - border * 2),
    heightPx: Math.max(0, heightPx - padPx * 2 - border * 2),
  };
}

/**
 * The inner box of a named layout slot.
 *
 * `slot` is the value a layout stamps as `data-pp-box`; `params.n` is the item
 * count it stamps as `data-pp-n` where the slot's size depends on it. Every
 * text run reported by `measureScene` names the slot it sits in, so a layout
 * cannot report a box it does not draw, and cannot draw a box it does not
 * report.
 *
 * @param {string} slot
 * @param {string|{id?: string}} bpIn
 * @param {{n?: number, unitWidth?: number, unitHeight?: number, variant?: string}} [params]
 * @returns {BoxSize}
 */
export function boxGeometry(slot, bpIn, params = {}) {
  const bp = breakpointId(bpIn);
  const s = stageBox(bp);
  const n = Math.max(1, Math.floor(params.n || 1));
  const stacked = bp === 'sm';

  switch (slot) {
    // ---------------------------------------------------------------- shared
    case 'stage':
      return { widthPx: s.contentWidthPx, heightPx: s.contentHeightPx };
    case 'head':
      return { widthPx: s.contentWidthPx, heightPx: s.headHeightPx };
    case 'body':
      return { widthPx: s.bodyWidthPx, heightPx: s.bodyHeightPx };

    // ------------------------------------------------------ splitBeforeAfter
    case 'splitCol': {
      // `repeat(--pp-sc-split-cols, minmax(0,1fr))` with `--pp-sc-split-gap` at
      // md/lg; one column, stacked, at sm. `n` is the column count: the source
      // column plus one per rendition the scene carries.
      //
      // The *height* is the frame's, not a share of it, at every breakpoint.
      // At md/lg the columns sit side by side and each has the body box. At sm
      // they stack and the scene scrolls, so each still has the body box —
      // dividing it by the column count would claim a five-rendition scene
      // affords its source column a fifth of the screen, which is a fiction
      // that turns ordinary prose into blocking findings (CRITIQUE-1 F6).
      const gap = geom(bp, 'split-gap');
      const cols = Math.max(1, n);
      const w = stacked ? s.contentWidthPx : trackWidth(s.contentWidthPx, cols, gap);
      return inset(w, s.bodyHeightPx, geom(bp, 'panel-pad'));
    }
    case 'splitPanelHead': {
      // `--pp-sc-panel-head-h` is a `min-height`, not a cap: the header grows
      // into the column when its title wraps or a provenance label sits under
      // it. What bounds it is the column, so that is what it is measured
      // against — with the nominal head height charged to the cells below.
      const col = boxGeometry('splitCol', bp, { n });
      return { widthPx: col.widthPx, heightPx: col.heightPx };
    }
    case 'splitCell': {
      // The rows region below the panel header. Reported per cell as the space
      // the column affords it; the cells of one column share a `containerId`,
      // so L11 can also sum them for cumulative overflow
      // (docs/decisions/L8-scenes.md, docs/disputes/L8-scenes.md L8-D2).
      const col = boxGeometry('splitCol', bp, { n });
      return {
        widthPx: col.widthPx,
        heightPx: Math.max(0, col.heightPx - geom(bp, 'panel-head-h') - geom(bp, 'row-gap')),
      };
    }

    // ----------------------------------------------------------------- fanOut
    case 'fanSource': {
      const w = isProportional(bp, 'fan-source-w') ? s.contentWidthPx : geom(bp, 'fan-source-w');
      const h = stacked ? geom(bp, 'fan-source-h') : s.bodyHeightPx;
      return inset(w, h, geom(bp, 'panel-pad'));
    }
    case 'fanGrid': {
      const railW = isProportional(bp, 'fan-source-w') ? s.contentWidthPx : geom(bp, 'fan-source-w');
      const gap = geom(bp, 'fan-source-gap');
      return stacked
        ? { widthPx: s.contentWidthPx, heightPx: Math.max(0, s.bodyHeightPx - geom(bp, 'fan-source-h') - gap) }
        : { widthPx: Math.max(0, s.contentWidthPx - railW - gap), heightPx: s.bodyHeightPx };
    }
    case 'fanCard': {
      const grid = boxGeometry('fanGrid', bp);
      const gap = geom(bp, 'fan-gap');
      const cols = fanColumns(bp, n);
      const rows = Math.max(1, Math.ceil(n / cols));
      // `grid-auto-rows: minmax(--pp-sc-fan-card-min-h, 1fr)`: every card gets
      // an equal share of the height — which is what makes a count *felt* — down
      // to a floor, below which the grid overflows and the scene scrolls rather
      // than showing nine cards too short to read.
      return inset(
        trackWidth(grid.widthPx, cols, gap),
        Math.max(geom(bp, 'fan-card-min-h'), trackWidth(grid.heightPx, rows, gap)),
        geom(bp, 'card-pad'),
      );
    }

    // ------------------------------------------------------------------ stack
    case 'stackStep': {
      const w = s.contentWidthPx - geom(bp, 'stack-rail-w') - geom(bp, 'stack-rail-gap');
      const h = trackWidth(s.bodyHeightPx, n, geom(bp, 'stack-step-gap'));
      return inset(w, h, geom(bp, 'step-pad'));
    }
    case 'stackRail':
      return { widthPx: geom(bp, 'stack-rail-w'), heightPx: s.bodyHeightPx };

    // -------------------------------------------------------------- fullBleed
    // `fullBleed` has no header band — the visual takes the whole content box,
    // and the headline lives in the overlay on top of it.
    case 'bleedMedia':
      return { widthPx: s.contentWidthPx, heightPx: s.contentHeightPx };
    case 'bleedOverlay': {
      const w = Math.min(s.contentWidthPx, geom(bp, 'bleed-max-w'));
      // `.pp-bleed-overlay { max-height: 50% }` of the content box.
      return inset(w, s.contentHeightPx * 0.5, geom(bp, 'bleed-pad'), 0);
    }

    // --------------------------------------------------------------- sideNote
    case 'sideMain': {
      const noteW = isProportional(bp, 'note-w') ? s.contentWidthPx : geom(bp, 'note-w');
      const gap = geom(bp, 'note-gap');
      const w = stacked ? s.contentWidthPx : Math.max(0, s.contentWidthPx - noteW - gap);
      return { widthPx: w, heightPx: s.bodyHeightPx };
    }
    case 'sideNote': {
      // Notes are auto-height and the margin scrolls with the scene, so a note
      // is bounded by the frame rather than by a share of it. The notes of one
      // scene share a `containerId` for the cumulative check.
      const w = isProportional(bp, 'note-w') ? s.contentWidthPx : geom(bp, 'note-w');
      return inset(w, s.bodyHeightPx, geom(bp, 'note-pad'));
    }

    // -------------------------------------------------------------- quoteCard
    case 'quoteBox': {
      const w = Math.min(s.bodyWidthPx, geom(bp, 'quote-max-w'));
      // `variant: 'full'` is the headline-as-statement case, where the layout
      // renders no header band and the card takes the whole content box.
      const h0 = params.variant === 'full' ? s.contentHeightPx : s.bodyHeightPx;
      return inset(w, h0, geom(bp, 'quote-pad'), 0);
    }

    // ---------------------------------------------------------- contentsIndex
    case 'indexRow': {
      // Index rows are auto-height in a scrolling column, like margin notes.
      const w = Math.max(0, s.contentWidthPx - geom(bp, 'index-num-w') - geom(bp, 'index-gap'));
      return { widthPx: w, heightPx: s.bodyHeightPx };
    }
    case 'indexNumber':
      return { widthPx: geom(bp, 'index-num-w'), heightPx: s.bodyHeightPx };

    // -------------------------------------------------------------- systemMap
    case 'mapCanvas': {
      const scale = mapScale(bp, n);
      return { widthPx: MAP_DESIGN.width * scale, heightPx: MAP_DESIGN.height * scale };
    }
    case 'mapLegend': {
      const cols = Math.max(1, geom(bp, 'map-legend-cols'));
      return inset(
        trackWidth(s.contentWidthPx, cols, geom(bp, 'fan-gap')),
        geom(bp, 'map-legend-h'),
        geom(bp, 'card-pad'),
      );
    }
    case 'mapText': {
      const scale = mapScale(bp, n);
      return {
        widthPx: (params.unitWidth || MAP_DESIGN.width) * scale,
        heightPx: (params.unitHeight || MAP_DESIGN.height) * scale,
      };
    }

    default:
      throw new Error(`scene/geometry: unknown slot "${slot}"`);
  }
}

/** Every slot name `boxGeometry` answers for. Used by the completeness test. */
export const SLOTS = [
  'stage', 'head', 'body',
  'splitCol', 'splitPanelHead', 'splitCell',
  'fanSource', 'fanGrid', 'fanCard',
  'stackStep', 'stackRail',
  'bleedMedia', 'bleedOverlay',
  'sideMain', 'sideNote',
  'quoteBox',
  'indexRow', 'indexNumber',
  'mapCanvas', 'mapLegend', 'mapText',
];
