/**
 * `systemMap` — a structural diagram of components and flow, drawn as inline
 * SVG (§4).
 *
 * The scene for "how does this actually work": where the content comes in, what
 * acts on it, and what comes out. It is drawn rather than bulleted because a
 * flow with three shapes and two arrows is understood in the second it appears,
 * and the same flow as a list is read aloud by the presenter while the room
 * waits.
 *
 * Constraints that shaped it:
 *  - **Inline SVG only.** No external assets, no icon font, no image request —
 *    §13's scanner treats any of those as a `NETWORK_REFERENCE`. Everything
 *    here is markup and CSS.
 *  - **Deterministic line breaking.** Node labels are wrapped by
 *    `layoutText()` from core/text-metrics into explicit `<tspan>` lines, in
 *    the drawing's design units. SVG does not wrap text, so a label that is not
 *    broken here is a label that runs out of its box on someone's projector.
 *    Because the wrapping is computed from published metrics it is identical in
 *    the studio, in the sweep and in the artifact (D7).
 *  - **Provenance lives in HTML.** The output legend under the drawing carries
 *    one chip per rendition, and that chip is where the `pp-provenance` label
 *    goes. §18.1 makes the label's computed size and contrast a check the
 *    emitter runs against the final stylesheet; an SVG `<text>` has no
 *    background and takes `fill` rather than `color`, so a label placed inside
 *    the drawing would be a label whose legibility could not be verified. The
 *    chips are numbered to match the nodes.
 *
 * @module scene/layouts/system-map
 */

import { h } from '../../core/vdom.js';
import { layoutText } from '../../core/text-metrics.js';
import { MAP_DESIGN } from '../geometry.js';
import { styleForRole } from '../type-scale.js';
import {
  sceneHead, provenanceLabel, emptyState,
  specimenTitle, specimenMeta, renditionLabel, renditionMeta, withProvenanceLedger,
} from '../parts.js';

/** The drawing's design geometry, in viewBox units. */
export const MAP = {
  nodeW: 200,
  nodePad: 14,
  sourceX: 40,
  transformX: 380,
  outputX: 720,
  top: 48,
  bottom: 492,
  outputGap: 16,
  minOutputH: 56,
  maxOutputs: 5,
  titleLines: 3,
  metaLines: 2,
  lineStep: { title: 20, meta: 15 },
};

/**
 * @param {import('../../runtime/layouts.js').LayoutContext} ctx
 * @returns {import('../../core/vdom.js').VNode}
 */
export function systemMap(ctx) {
  const rends = Array.isArray(ctx.renditions) ? ctx.renditions.filter(Boolean) : [];
  const hasSubject = !!ctx.specimen || rends.length > 0;

  if (!hasSubject) {
    return withProvenanceLedger(h('div', { class: 'pp-layout pp-layout--map', 'data-pp-layout': 'systemMap', 'data-pp-box': 'stage' },
      sceneHead(ctx, { kicker: 'How it runs' }),
      emptyState('This scene has nothing to map yet — attach a specimen or renditions.', { box: 'body' })), ctx);
  }

  const shown = rends.slice(0, MAP.maxOutputs);
  const overflow = rends.length - shown.length;
  const outputCount = shown.length + (overflow > 0 ? 1 : 0);
  const outputs = outputBoxes(outputCount);

  const arrowId = ctx.el('map/arrow');
  // The legend's chip count decides how much height is left for the drawing,
  // so it travels with every element whose size scales with the drawing.
  const legendCount = Math.max(1, shown.length);
  const source = { x: MAP.sourceX, y: 210, w: MAP.nodeW, h: 120 };
  const transform = { x: MAP.transformX, y: 210, w: MAP.nodeW, h: 120 };

  const sourceLabel = specimenTitle(ctx.specimen);
  const sourceMeta = specimenMeta(ctx.specimen) || (ctx.specimen ? ctx.specimen.kind : 'no specimen attached');
  const transformLabel = ctx.scene.subhead ? String(ctx.scene.subhead) : 'Transformation';
  const recipeCount = new Set(rends.map((r) => r.recipeId).filter(Boolean)).size;
  const transformMeta = recipeCount === 1 ? '1 recipe' : `${recipeCount} recipes`;

  // The legend chips carry the labels, and there is a chip only for the outputs
  // the drawing can hold: past `MAP.maxOutputs` the rest collapse into one "N
  // more renditions" node that names no rendition and can scope none. Those are
  // the renditions the ledger picks up — the room is being told they exist, and
  // §18.1 does not stop applying because the drawing ran out of room.
  return withProvenanceLedger(h('div', { class: 'pp-layout pp-layout--map', 'data-pp-layout': 'systemMap', 'data-pp-box': 'stage' },
    sceneHead(ctx, { kicker: 'How it runs' }),
    h('div', { class: 'pp-map', 'data-pp-box': 'body' },
      h('div', { class: 'pp-map-canvas' },
        h('svg', {
          class: 'pp-map-svg',
          'data-pp-box': 'mapCanvas',
          'data-pp-n': String(legendCount),
          viewBox: `0 0 ${MAP_DESIGN.width} ${MAP_DESIGN.height}`,
          preserveAspectRatio: 'xMidYMid meet',
          role: 'img',
          'aria-label': `${sourceLabel} through ${transformLabel} to ${outputCount} outputs`,
          focusable: 'false',
        },
        h('defs', null,
          h('marker', {
            id: arrowId, markerWidth: '10', markerHeight: '8', refX: '9', refY: '4', orient: 'auto',
          }, h('path', { class: 'pp-map-arrow', d: 'M0,0 L10,4 L0,8 z' }))),

        h('g', {
          class: 'pp-map-edges',
          'data-pp-el': ctx.el('map/edge/source'),
          'data-pp-group': 'map/transform',
        },
        h('line', {
          class: 'pp-map-edge',
          x1: String(source.x + source.w), y1: '270',
          x2: String(transform.x - 12), y2: '270',
          'marker-end': `url(#${arrowId})`,
        })),

        h('g', {
          class: 'pp-map-edges',
          'data-pp-el': ctx.el('map/edge/outputs'),
          'data-pp-group': 'map/outputs',
        },
        outputs.map((box) => h('path', {
          class: 'pp-map-edge',
          d: fanPath(transform.x + transform.w, 270, MAP.outputX - 12, box.y + box.h / 2),
          'marker-end': `url(#${arrowId})`,
          fill: 'none',
        }))),

        node(ctx, {
          box: source, path: 'map/source', group: 'map/source', tone: 'source',
          title: sourceLabel, meta: sourceMeta, index: null, legendCount,
        }),
        node(ctx, {
          box: transform, path: 'map/transform', group: 'map/transform', tone: 'transform',
          title: transformLabel, meta: transformMeta, index: null, legendCount,
        }),
        shown.map((rendition, i) => node(ctx, {
          box: outputs[i],
          path: `map/output/${i}`,
          group: 'map/outputs',
          tone: 'output',
          title: renditionLabel(rendition, i),
          meta: renditionMeta(rendition),
          index: i + 1,
          legendCount,
        })),
        overflow > 0
          ? node(ctx, {
            box: outputs[outputs.length - 1],
            path: 'map/output/more',
            group: 'map/outputs',
            tone: 'more',
            title: `${overflow} more ${overflow === 1 ? 'rendition' : 'renditions'}`,
            meta: 'in this scene',
            index: null,
            legendCount,
          })
          : null)),

      h('ul', { class: 'pp-map-legend', 'data-pp-n': String(legendCount) },
        shown.map((rendition, i) => h('li', {
          class: 'pp-map-chip',
          'data-pp-box': 'mapLegend',
          'data-pp-n': String(legendCount),
          'data-pp-el': ctx.el(`map/legend/${i}`),
          'data-pp-group': 'map/outputs',
          'data-pp-rendition': rendition.id,
        },
        // Number, label, and — where §9 requires it — the provenance line. The
        // chip is the labelled subtree for the output node of the same number.
        h('p', { class: 'pp-map-chip-label', 'data-pp-tx': 'panelTitle', 'data-pp-clamp': '1' },
          `${i + 1}. ${renditionLabel(rendition, i)}`),
        provenanceLabel(rendition, ctx))),
        shown.length === 0
          ? h('li', { class: 'pp-map-chip pp-map-chip--empty', 'data-pp-box': 'mapLegend', 'data-pp-n': '1' },
            h('p', { class: 'pp-map-chip-label', 'data-pp-tx': 'caption' }, 'No renditions attached to this scene.'))
          : null))), ctx);
}

/**
 * Where the output nodes sit, top to bottom, filling the drawing's height so a
 * flow with two outputs and one with six both look composed.
 * @param {number} count
 * @returns {{x: number, y: number, w: number, h: number}[]}
 */
export function outputBoxes(count) {
  const n = Math.max(1, count);
  const span = MAP.bottom - MAP.top;
  const height = Math.max(MAP.minOutputH, (span - MAP.outputGap * (n - 1)) / n);
  const total = height * n + MAP.outputGap * (n - 1);
  const start = MAP.top + Math.max(0, (span - total) / 2);
  return Array.from({ length: n }, (_, i) => ({
    x: MAP.outputX,
    y: start + i * (height + MAP.outputGap),
    w: MAP.nodeW,
    h: height,
  }));
}

/**
 * A node: a rounded rect and its wrapped label. The label's lines are computed,
 * not guessed — SVG has no line breaking of its own.
 * @returns {import('../../core/vdom.js').VNode}
 */
function node(ctx, spec) {
  const { box } = spec;
  const innerW = box.w - MAP.nodePad * 2;
  const titleLines = wrap(spec.title, 'mapNodeTitle', innerW, MAP.titleLines, ctx.brand);
  const metaLines = spec.meta ? wrap(spec.meta, 'mapNodeMeta', innerW, MAP.metaLines, ctx.brand) : [];
  const blockH = titleLines.length * MAP.lineStep.title + metaLines.length * MAP.lineStep.meta;
  const firstBaseline = box.y + (box.h - blockH) / 2 + MAP.lineStep.title * 0.75;
  const x = box.x + MAP.nodePad;

  return h('g', {
    class: `pp-map-node pp-map-node--${spec.tone}`,
    'data-pp-el': ctx.el(spec.path),
    'data-pp-group': spec.group,
  },
  h('rect', {
    class: 'pp-map-box',
    x: String(box.x), y: String(box.y), width: String(box.w), height: String(box.h),
    rx: '10', ry: '10',
  }),
  spec.index !== null && spec.index !== undefined
    ? h('text', { class: 'pp-map-index', x: String(box.x + box.w - MAP.nodePad), y: String(box.y + 22), 'text-anchor': 'end' },
      h('tspan', {
        'data-pp-tx': 'mapNodeMeta',
        'data-pp-box': 'mapText',
        'data-pp-n': String(spec.legendCount || 1),
        'data-pp-unit-w': String(innerW),
        'data-pp-unit-h': String(MAP.lineStep.meta),
        'data-pp-ws': 'nowrap',
      }, String(spec.index)))
    : null,
  h('text', { class: 'pp-map-title', x: String(x), y: String(firstBaseline) },
    titleLines.map((line, i) => h('tspan', {
      x: String(x),
      dy: i === 0 ? '0' : String(MAP.lineStep.title),
      'data-pp-tx': 'mapNodeTitle',
      'data-pp-box': 'mapText',
      'data-pp-n': String(spec.legendCount || 1),
      'data-pp-unit-w': String(innerW),
      'data-pp-unit-h': String(MAP.lineStep.title),
      'data-pp-ws': 'nowrap',
    }, line))),
  metaLines.length
    ? h('text', {
      class: 'pp-map-meta',
      x: String(x),
      y: String(firstBaseline + titleLines.length * MAP.lineStep.title),
    },
    metaLines.map((line, i) => h('tspan', {
      x: String(x),
      dy: i === 0 ? '0' : String(MAP.lineStep.meta),
      'data-pp-tx': 'mapNodeMeta',
      'data-pp-box': 'mapText',
      'data-pp-n': String(spec.legendCount || 1),
      'data-pp-unit-w': String(innerW),
      'data-pp-unit-h': String(MAP.lineStep.meta),
      'data-pp-ws': 'nowrap',
    }, line)))
    : null);
}

/**
 * Break a label into lines that fit a node, in design units.
 *
 * The breakpoint passed to `styleForRole` is immaterial for SVG roles — their
 * design size is the same at all three, by construction in tokens.js — so the
 * wrapping is one answer for the whole document, which is what a single SVG
 * tree rendered at every breakpoint requires.
 * @param {string} text
 * @param {string} role
 * @param {number} maxUnits
 * @param {number} maxLines
 * @param {import('../../core/contracts.d.ts').BrandSystem} brand
 * @returns {string[]}
 */
export function wrap(text, role, maxUnits, maxLines, brand) {
  const value = String(text ?? '').trim();
  if (!value) return [];
  const { style } = styleForRole(role, 'md', brand, { scale: 1 });
  const laid = layoutText(value, style, {
    maxWidthPx: maxUnits,
    whiteSpace: 'normal',
    overflowWrap: 'anywhere',
    maxLines,
  });
  return laid.lines.map((line) => line.text);
}

/**
 * A cubic from the transform node's edge to an output node's edge. Curves
 * rather than elbows: a fan of curves reads as one flow branching, which is
 * what it is.
 * @returns {string}
 */
function fanPath(x1, y1, x2, y2) {
  const dx = Math.max(40, (x2 - x1) / 2);
  return `M${round(x1)},${round(y1)} C${round(x1 + dx)},${round(y1)} ${round(x2 - dx)},${round(y2)} ${round(x2)},${round(y2)}`;
}

/** @param {number} n @returns {string} */
function round(n) {
  return String(Math.round(n * 100) / 100);
}
