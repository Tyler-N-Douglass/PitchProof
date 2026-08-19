/**
 * `splitBeforeAfter` — the workhorse (§4, §10).
 *
 * The prospect's own content on the left, the rendition on the right, aligned
 * block to block. Everything about the construction serves one sentence a
 * client says to themselves without being prompted: *that is our page, and that
 * is what it becomes.*
 *
 *  - **Rows, not panels.** The two sides share one row sequence produced by
 *    `alignColumns`, so their H1s sit on the same line and their paragraphs sit
 *    opposite the paragraphs that replaced them. Grid items in a row stretch to
 *    the row's height, so the alignment holds at every breakpoint and at every
 *    beat — including beats where one side is still hidden, because
 *    `.pp-unrevealed` keeps the box (runtime.css) and nothing reflows when the
 *    reveal lands.
 *  - **More than one rendition is a column, not a tab.** A scene carrying three
 *    renditions renders four aligned columns. If that is too many for the
 *    breakpoint, `measureScene` reports the narrower boxes and the overflow
 *    detector says so before the meeting rather than during it.
 *  - **The source side is untouched (§18.3).** No clamping, no truncation, no
 *    reordering on the specimen column.
 *
 * @module scene/layouts/split-before-after
 */

import { h } from '../../core/vdom.js';
import { alignColumns } from '../align.js';
import { renderBlock } from '../blocks.js';
import {
  sceneHead, panelHead, provenanceLabel, emptyState,
  specimenMeta, specimenTitle, renditionMeta, renditionLabel,
  withProvenanceLedger,
} from '../parts.js';

/**
 * @param {import('../../runtime/layouts.js').LayoutContext} ctx
 * @returns {import('../../core/vdom.js').VNode}
 */
export function splitBeforeAfter(ctx) {
  const { specimen, renditions } = ctx;
  const sourceBlocks = specimen && Array.isArray(specimen.blocks) ? specimen.blocks : [];
  const rends = Array.isArray(renditions) ? renditions.filter(Boolean) : [];
  const columnCount = 1 + rends.length;

  const body = (!specimen && rends.length === 0)
    ? emptyState('This scene has no specimen and no rendition attached yet.', { box: 'body' })
    : renderSplit(ctx, sourceBlocks, rends, columnCount);

  // Every rendition gets a head cell of its own with its label in it, so the
  // ledger is normally empty here. It is still asked for: the empty-state
  // branch above renders no cells at all, and a law that only holds on the
  // branch somebody remembered is not a law (§18.1).
  return withProvenanceLedger(h('div', {
    class: 'pp-layout pp-layout--split',
    'data-pp-layout': 'splitBeforeAfter',
    'data-pp-box': 'stage',
    style: { '--pp-sc-split-cols': String(columnCount) },
  },
  sceneHead(ctx, { kicker: 'Their content, and what it becomes' }),
  body), ctx);
}

/**
 * @param {import('../../runtime/layouts.js').LayoutContext} ctx
 * @param {import('../../core/contracts.d.ts').ContentBlock[]} sourceBlocks
 * @param {import('../../core/contracts.d.ts').Rendition[]} rends
 * @param {number} columnCount
 * @returns {import('../../core/vdom.js').VNode}
 */
function renderSplit(ctx, sourceBlocks, rends, columnCount) {
  const rows = alignColumns(sourceBlocks, rends.map((r) => (Array.isArray(r.blocks) ? r.blocks : [])));
  const n = String(columnCount);

  const headRow = h('div', { class: 'pp-split-row pp-split-row--head' },
    h('div', {
      class: 'pp-split-cell pp-split-cell--head pp-col pp-col--before',
      'data-pp-box': 'splitPanelHead',
      'data-pp-n': n,
      'data-pp-el': ctx.el('before/panel'),
      'data-pp-group': 'before',
    }, panelHead({
      title: specimenTitle(ctx.specimen),
      meta: specimenMeta(ctx.specimen),
      tone: 'before',
    })),
    rends.map((rendition, index) => h('div', {
      class: 'pp-split-cell pp-split-cell--head pp-col pp-col--after',
      'data-pp-box': 'splitPanelHead',
      'data-pp-n': n,
      'data-pp-el': ctx.el(`after/rendition/${index}/panel`),
      'data-pp-group': `after/${index}`,
      'data-pp-rendition': rendition.id,
    }, panelHead({
      title: renditionLabel(rendition, index),
      meta: renditionMeta(rendition),
      tone: 'after',
    }), provenanceLabel(rendition, ctx))));

  const bodyRows = rows.map((row, rowIndex) => h('div', {
    class: 'pp-split-row',
    'data-pp-row': String(rowIndex),
  },
  cell(ctx, {
    columnClass: 'pp-col--before',
    n,
    index: row.cells[0],
    blocks: sourceBlocks,
    path: (i) => `before/block/${i}`,
    group: 'before',
    container: 'before',
    media: ctx.media,
  }),
  rends.map((rendition, colIndex) => cell(ctx, {
    columnClass: 'pp-col--after',
    n,
    index: row.cells[colIndex + 1],
    blocks: Array.isArray(rendition.blocks) ? rendition.blocks : [],
    path: (i) => `after/rendition/${colIndex}/block/${i}`,
    group: `after/${colIndex}`,
    container: `after/${colIndex}`,
    media: ctx.media,
    renditionId: rendition.id,
  }))));

  return h('div', { class: 'pp-split', 'data-pp-box': 'body' },
    headRow,
    h('div', { class: 'pp-split-body' }, bodyRows));
}

/**
 * One aligned cell. A null index renders the empty half of a row, which keeps
 * the columns in step rather than letting one side slide up into the other's
 * line.
 * @returns {import('../../core/vdom.js').VNode}
 */
function cell(ctx, spec) {
  const shared = {
    class: `pp-split-cell pp-col ${spec.columnClass}`,
    'data-pp-box': 'splitCell',
    'data-pp-n': spec.n,
    // Every cell of one column reports the same container, because that is what
    // they actually stack inside — the detector checks each block against the
    // column and can sum the column as well.
    'data-pp-container': spec.container,
  };
  if (spec.index === null || spec.index === undefined) {
    return h('div', { ...shared, class: `${shared.class} pp-split-cell--empty`, 'aria-hidden': 'true' });
  }
  const block = spec.blocks[spec.index];
  return h('div', {
    ...shared,
    'data-pp-el': ctx.el(spec.path(spec.index)),
    'data-pp-group': spec.group,
    'data-pp-rendition': spec.renditionId || null,
  }, renderBlock(block, { media: spec.media, density: 'full' }));
}
