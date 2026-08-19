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
 *    chips are numbered to match the nodes. **§18.3's edit marker is in HTML for
 *    the same reason** — the source node names the specimen inside the drawing,
 *    but the marker that says the specimen was edited arrives on the notice
 *    strip below it, where its size and its contrast are facts about CSS.
 *
 * @module scene/layouts/system-map
 */

import { h } from '../../core/vdom.js';
import { layoutText, measureText } from '../../core/text-metrics.js';
import { MAP_DESIGN } from '../geometry.js';
import { styleForRole } from '../type-scale.js';
import { renderedFamily } from '../brand-access.js';
import {
  sceneHead, provenanceLabel, emptyState, URL_LABEL_BUDGET,
  specimenTitle, specimenMeta, renditionLabel, renditionMeta, withProvenanceLedger,
  withEditedNotice,
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
    return withEditedNotice(withProvenanceLedger(h('div', { class: 'pp-layout pp-layout--map', 'data-pp-layout': 'systemMap', 'data-pp-box': 'stage' },
      sceneHead(ctx, { kicker: 'How it runs' }),
      emptyState('This scene has nothing to map yet — attach a specimen or renditions.', { box: 'body' })), ctx), ctx);
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
  // The source node's meta line is a URL, and it is elided against the room a
  // *map node* gives it rather than against the panel-column budget in
  // parts.js — two lines of 172 design units, not one line of a 320px column.
  const nodeInnerW = MAP.nodeW - MAP.nodePad * 2;
  const sourceMeta = fitSourceMeta(ctx.specimen, nodeInnerW, ctx.brand)
    || (ctx.specimen ? ctx.specimen.kind : 'no specimen attached');
  const transformLabel = ctx.scene.subhead ? String(ctx.scene.subhead) : 'Transformation';
  const recipeCount = new Set(rends.map((r) => r.recipeId).filter(Boolean)).size;
  const transformMeta = recipeCount === 1 ? '1 recipe' : `${recipeCount} recipes`;

  // The legend chips carry the labels, and there is a chip only for the outputs
  // the drawing can hold: past `MAP.maxOutputs` the rest collapse into one "N
  // more renditions" node that names no rendition and can scope none. Those are
  // the renditions the ledger picks up — the room is being told they exist, and
  // §18.1 does not stop applying because the drawing ran out of room.
  return withEditedNotice(withProvenanceLedger(h('div', { class: 'pp-layout pp-layout--map', 'data-pp-layout': 'systemMap', 'data-pp-box': 'stage' },
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
          : null))), ctx), ctx);
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
  const title = wrap(spec.title, 'mapNodeTitle', innerW, MAP.titleLines, ctx.brand);
  const meta = spec.meta
    ? wrap(spec.meta, 'mapNodeMeta', innerW, MAP.metaLines, ctx.brand)
    : { lines: [], truncated: false };
  const titleLines = title.lines;
  const metaLines = meta.lines;
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
      // The wrap ellipsises what it had to cut, so a truncation here is one the
      // viewer can see rather than a label that silently stops (§22.2). Only
      // the line that was actually cut says so — the lines above it are whole.
      'data-pp-to': title.truncated && i === titleLines.length - 1 ? 'ellipsis' : null,
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
      'data-pp-to': meta.truncated && i === metaLines.length - 1 ? 'ellipsis' : null,
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
  if (!value) return { lines: [], truncated: false };
  const style = mapStyle(role, brand);
  const laid = layoutText(value, style, {
    maxWidthPx: maxUnits,
    whiteSpace: 'normal',
    overflowWrap: 'anywhere',
    maxLines,
  });

  // A wrapped line keeps the space that ended it. `layoutText` measures the
  // line without it — a break collapses trailing whitespace — but the string it
  // returns still carries it, and SVG puts that string in a `<tspan>` where
  // `measureScene` reads it back and reports a run wider than its node. The
  // overflow was in the measurement, not on the screen; trimming here is what
  // makes the two agree.
  const lines = laid.lines.map((line) => line.text.trim()).filter((line, i, all) => line !== '' || all.length === 1);
  if (!laid.clamped || lines.length === 0) return { lines, truncated: false };

  // Clamped: the tail of the label is gone. SVG cannot ellipsise for us, and a
  // label that simply stops is exactly the silent truncation §22.2 exists to
  // stop — the presenter cannot tell a short URL from a cut one. Mark it, and
  // shorten the last line until the mark fits with it.
  const last = lines.length - 1;
  let text2 = lines[last];
  while (text2.length > 1 && measureText(`${text2}…`, style) > maxUnits) {
    text2 = text2.slice(0, -1).replace(/\s+$/, '');
  }
  lines[last] = `${text2}…`;
  return { lines, truncated: true };
}

/**
 * The style an SVG label is broken and drawn at, in the drawing's design units.
 *
 * The family is the one the artifact will *render* in, not the one the brand
 * asked for. CSS breaks its own lines in whatever face it ended up with; SVG
 * does not, so a break computed from an unavailable family's metrics is a break
 * that holds in the studio and fails on the projector. `renderedFamily` applies
 * the same substitution L11 measures against, so the two cannot disagree.
 * @param {string} role
 * @param {import('../../core/contracts.d.ts').BrandSystem} brand
 * @returns {import('../../core/text-metrics.js').TextStyle}
 */
function mapStyle(role, brand) {
  const spec = styleForRole(role, 'md', brand, { scale: 1 });
  return { ...spec.style, family: renderedFamily(brand, spec.face, spec.style.weight) };
}

/**
 * The source node's meta line, elided until the node can actually hold it.
 *
 * `URL_LABEL_BUDGET` in parts.js is a character count sized for a panel meta
 * line — a 320px column at 10px in a monospace face. A map node is 172 design
 * units wide with two lines to spend, a fifth of that, and eliding a URL
 * against the column's number left the map with a label it could only cut. In
 * SVG a cut is silent: there is no clamp and no ellipsis, so the line simply
 * stopped and the presenter could not tell a short URL from a truncated one.
 *
 * The budget is not estimated from an average advance, because it is not an
 * average that decides: the wrap breaks at hyphens and slashes, so a label of
 * 46 characters may take two lines or three depending on where its breaks fall.
 * This asks the real line breaker and shortens until it stops truncating —
 * deterministic, bounded, and exact for the label in hand.
 *
 * @param {import('../../core/contracts.d.ts').Specimen|null} specimen
 * @param {number} maxUnits   the node's inner width, in design units
 * @param {import('../../core/contracts.d.ts').BrandSystem} brand
 * @returns {string|null}
 */
export function fitSourceMeta(specimen, maxUnits, brand) {
  if (!specimen) return null;
  let budget = URL_LABEL_BUDGET;
  let label = specimenMeta(specimen, { urlBudget: budget });
  if (!label) return null;
  // Two characters a step, down to a floor that still shows a host and a slug.
  while (budget > MIN_URL_BUDGET) {
    if (!wrap(label, 'mapNodeMeta', maxUnits, MAP.metaLines, brand).truncated) return label;
    budget -= 2;
    // Not `break` on an unchanged label: `displayUrl`'s structural elision
    // (host/…/slug) already sits below several budgets in a row, and stopping
    // at the first repeat would stop before the budget ever bit.
    const next = specimenMeta(specimen, { urlBudget: budget });
    if (!next) break;
    label = next;
  }
  return label;
}

/** The shortest a source label may be elided to before it stops being one. */
export const MIN_URL_BUDGET = 12;

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
