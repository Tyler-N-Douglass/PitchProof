/**
 * STAND-IN for L8's `measureScene(scene, ctx, breakpoint)` (`API.md` Part 3 → L8).
 *
 * L8 owns the real one, and it is authoritative because only the layout knows
 * the container the CSS actually gives a text box. This stand-in exists so L11's
 * preflight, dry-run and rules could be built and tested before L8 landed; it
 * models the stage geometry and type scale the eight §4 layouts imply, and
 * produces the same `SceneMeasurement` shape.
 *
 * It deliberately covers the boxes that matter for §22.2 — headline, subhead,
 * and every text run on the before and after sides, plus the provenance label —
 * rather than pretending to reproduce a layout it does not own.
 *
 * @module validate/standin/scene-measure
 */

import { BREAKPOINTS } from '../../core/contracts.js';
import { blockText } from '../../core/contracts.js';

/** Stage padding, per breakpoint id. */
const STAGE_PAD = { sm: 20, md: 48, lg: 72 };
/** Gap between the two halves of a split layout. */
const COLUMN_GAP = { sm: 16, md: 32, lg: 48 };
/** Vertical space the scene chrome (headline block, badges) takes off the stage. */
const CHROME_HEIGHT = { sm: 150, md: 190, lg: 230 };

/**
 * The type scale, in CSS px, per role and breakpoint. Documented rather than
 * tuned: a modular scale at 1.25 from a 16px body at `md`.
 */
const TYPE_SCALE = {
  headline: { sm: 28, md: 40, lg: 52 },
  subhead: { sm: 17, md: 20, lg: 24 },
  heading: { sm: 19, md: 24, lg: 28 },
  body: { sm: 15, md: 16, lg: 18 },
  caption: { sm: 12, md: 13, lg: 14 },
  provenance: { sm: 11, md: 12, lg: 12 },
};

/** Layouts that split the stage into a before and an after column. */
const SPLIT_LAYOUTS = new Set(['splitBeforeAfter', 'sideNote', 'systemMap']);
/** Layouts that lay their content out in a multi-column grid. */
const GRID_COLUMNS = { fanOut: 3, stack: 1, fullBleed: 1, quoteCard: 1, contentsIndex: 1 };

/**
 * @param {import('../../core/contracts.d.ts').BrandSystem} brand
 * @param {'display'|'body'|'mono'} role
 * @returns {{family: string, weight: number}}
 */
function faceFor(brand, role) {
  const faces = (brand && brand.faces) || [];
  const face = faces.find((f) => f.role === role) || faces[0];
  if (!face) return { family: 'sans-serif', weight: role === 'display' ? 700 : 400 };
  const weights = (face.weightsSeen || []).slice().sort((a, b) => a - b);
  const weight = role === 'display' ? (weights[weights.length - 1] || 700) : (weights[0] || 400);
  return { family: face.family, weight };
}

/**
 * @param {import('../../core/contracts.d.ts').Scene} scene
 * @param {any} ctx  a LayoutContext
 * @param {'sm'|'md'|'lg'|{id: string, width: number, height: number}} breakpoint
 * @returns {{sceneId: string, breakpoint: string, boxes: any[]}}
 */
export function measureScene(scene, ctx, breakpoint) {
  const bp = typeof breakpoint === 'string'
    ? BREAKPOINTS.find((b) => b.id === breakpoint)
    : breakpoint;
  if (!bp) throw new Error(`measureScene: unknown breakpoint ${String(breakpoint)}`);
  const brand = (ctx && ctx.brand) || { faces: [] };
  const pad = STAGE_PAD[bp.id] ?? 48;
  const gap = COLUMN_GAP[bp.id] ?? 32;
  const stageW = bp.width - pad * 2;
  const stageH = bp.height - pad * 2;
  const split = SPLIT_LAYOUTS.has(scene.layout);
  const columns = split ? 2 : (GRID_COLUMNS[scene.layout] || 1);
  const columnW = (stageW - gap * (columns - 1)) / columns;
  const bodyH = Math.max(0, stageH - (CHROME_HEIGHT[bp.id] ?? 190));

  const display = faceFor(brand, 'display');
  const body = faceFor(brand, 'body');

  /** @type {any[]} */
  const boxes = [];
  const el = (ctx && typeof ctx.el === 'function') ? ctx.el : () => null;

  if (scene.headline) {
    boxes.push({
      elementId: el('headline'),
      role: 'headline',
      text: scene.headline,
      style: {
        family: display.family, weight: display.weight,
        fontSizePx: TYPE_SCALE.headline[bp.id], lineHeight: 1.1,
      },
      containerWidthPx: stageW,
      containerHeightPx: TYPE_SCALE.headline[bp.id] * 1.1 * 2,
      whiteSpace: 'normal',
      overflowWrap: 'normal',
      maxLines: 2,
    });
  }
  if (scene.subhead) {
    boxes.push({
      elementId: el('subhead'),
      role: 'subhead',
      text: scene.subhead,
      style: {
        family: body.family, weight: body.weight,
        fontSizePx: TYPE_SCALE.subhead[bp.id], lineHeight: 1.35,
      },
      containerWidthPx: Math.min(stageW, 900),
      containerHeightPx: TYPE_SCALE.subhead[bp.id] * 1.35 * 2,
      whiteSpace: 'normal',
      overflowWrap: 'normal',
    });
  }

  /**
   * @param {import('../../core/contracts.d.ts').ContentBlock[]} blocks
   * @param {string} side
   */
  const pushBlocks = (blocks, side) => {
    (blocks || []).forEach((block, i) => {
      const isHeading = block.type === 'heading';
      const sizeRole = isHeading ? 'heading' : block.type === 'media' ? 'caption' : 'body';
      blockText(block).forEach((text, j) => {
        if (!String(text).trim()) return;
        boxes.push({
          elementId: el(`${side}/block/${i}/${j}`),
          role: `${side}.${block.type}`,
          text,
          style: {
            family: isHeading ? display.family : body.family,
            weight: isHeading ? display.weight : body.weight,
            fontSizePx: TYPE_SCALE[sizeRole][bp.id],
            lineHeight: isHeading ? 1.2 : 1.5,
          },
          containerWidthPx: columnW,
          containerHeightPx: bodyH,
          whiteSpace: 'normal',
          overflowWrap: 'normal',
        });
      });
    });
  };

  if (ctx && ctx.specimen) pushBlocks(ctx.specimen.blocks, 'before');
  for (const rendition of (ctx && ctx.renditions) || []) {
    pushBlocks(rendition.blocks, `after:${rendition.id}`);
    if (ctx.labelIllustrative && rendition.provenance === 'illustrative') {
      boxes.push({
        elementId: el(`after:${rendition.id}/provenance`),
        role: 'provenance',
        text: 'Illustrative — not client-approved content',
        style: {
          family: body.family, weight: 600,
          fontSizePx: TYPE_SCALE.provenance[bp.id], lineHeight: 1.3, letterSpacingPx: 0.2,
        },
        containerWidthPx: columnW,
        containerHeightPx: TYPE_SCALE.provenance[bp.id] * 1.3,
        whiteSpace: 'nowrap',
        overflowWrap: 'normal',
      });
    }
  }

  return { sceneId: scene.id, breakpoint: bp.id, boxes };
}
