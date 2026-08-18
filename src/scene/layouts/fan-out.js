/**
 * `fanOut` — one source, many renditions, arranged so the count is felt (§4).
 *
 * This is the layout for `locale-fanout` and `channel-variants`, and its whole
 * job is to make a number physical. A sentence claiming nine markets is an
 * assertion; nine cards filling the frame, each carrying the client's own
 * content in a different market's structure, is an observation the room makes
 * for itself.
 *
 * Three things make that work:
 *  - the source stays on screen, small, on the left, so the fan is visibly *of*
 *    something rather than free-floating;
 *  - the count is rendered once, large, from `renditions.length` — arithmetic
 *    over the model, never a claim about the world (§18.2);
 *  - every card is the same size, because uniform cards read as a quantity
 *    while ragged ones read as a list.
 *
 * Cards clamp their prose and report the clamp (`maxLines`) to `measureScene`,
 * so content that does not fit is a finding rather than a silent trim.
 *
 * @module scene/layouts/fan-out
 */

import { h } from '../../core/vdom.js';
import { renderBlock, summarize } from '../blocks.js';
import {
  sceneHead, panelHead, provenanceLabel, emptyState,
  specimenMeta, specimenTitle, renditionLabel, renditionMeta,
} from '../parts.js';

/** Cards past this count reveal in waves rather than one at a time. */
export const WAVE_SIZE = 4;

/**
 * @param {import('../../runtime/layouts.js').LayoutContext} ctx
 * @returns {import('../../core/vdom.js').VNode}
 */
export function fanOut(ctx) {
  const { specimen } = ctx;
  const rends = Array.isArray(ctx.renditions) ? ctx.renditions.filter(Boolean) : [];
  const sourceBlocks = specimen && Array.isArray(specimen.blocks) ? specimen.blocks : [];

  return h('div', {
    class: 'pp-layout pp-layout--fan',
    'data-pp-layout': 'fanOut',
    'data-pp-box': 'stage',
  },
  sceneHead(ctx, { kicker: 'One source, every variant' }),
  rends.length === 0
    ? emptyState('This scene has no renditions attached yet.', { box: 'body' })
    : h('div', { class: 'pp-fan', 'data-pp-box': 'body' },
      renderSource(ctx, sourceBlocks, rends.length),
      renderGrid(ctx, rends)));
}

/**
 * The source rail: what every card in the fan came from, plus the count.
 * @returns {import('../../core/vdom.js').VNode}
 */
function renderSource(ctx, sourceBlocks, count) {
  const lead = sourceBlocks.slice(0, 2);
  return h('aside', {
    class: 'pp-fan-source',
    'data-pp-box': 'fanSource',
    'data-pp-el': ctx.el('source/panel'),
    'data-pp-group': 'source',
  },
  panelHead({
    title: specimenTitle(ctx.specimen),
    meta: specimenMeta(ctx.specimen),
    tone: 'before',
  }),
  h('div', { class: 'pp-fan-source-body' },
    lead.length
      ? lead.map((block) => renderBlock(block, {
        media: ctx.media,
        density: 'condensed',
        clampParagraph: 4,
        clampHeading: 2,
        maxListItems: 3,
        maxTableRows: 3,
      }))
      : h('p', { class: 'pp-fan-source-empty', 'data-pp-tx': 'caption' }, 'No source specimen attached.')),
  h('div', {
    class: 'pp-fan-count',
    'data-pp-el': ctx.el('source/count'),
    'data-pp-group': 'source',
  },
  h('p', { class: 'pp-fan-count-number', 'data-pp-tx': 'badgeNumber' }, String(count)),
  h('p', { class: 'pp-fan-count-label', 'data-pp-tx': 'badgeLabel' }, count === 1 ? 'rendition' : 'renditions')));
}

/**
 * The fan itself. `data-pp-n` drives both the CSS column count and the
 * measured card width, so the two cannot disagree.
 * @returns {import('../../core/vdom.js').VNode}
 */
function renderGrid(ctx, rends) {
  const n = String(rends.length);
  return h('div', { class: 'pp-fan-grid', 'data-pp-n': n },
    rends.map((rendition, index) => {
      const blocks = Array.isArray(rendition.blocks) ? rendition.blocks : [];
      const { title, blurb } = summarize(blocks);
      const group = rends.length > WAVE_SIZE ? `fan/wave/${Math.floor(index / WAVE_SIZE)}` : `fan/${index}`;
      return h('article', {
        class: 'pp-fan-card',
        'data-pp-box': 'fanCard',
        'data-pp-n': n,
        'data-pp-el': ctx.el(`fan/rendition/${index}`),
        'data-pp-group': group,
        'data-pp-rendition': rendition.id,
      },
      h('header', { class: 'pp-fan-card-head' },
        h('p', { class: 'pp-fan-card-label', 'data-pp-tx': 'panelTitle', 'data-pp-clamp': '1' }, renditionLabel(rendition, index)),
        renditionMeta(rendition)
          ? h('p', { class: 'pp-fan-card-meta', 'data-pp-tx': 'panelMeta', 'data-pp-clamp': '1' }, renditionMeta(rendition))
          : null),
      h('div', { class: 'pp-fan-card-body' },
        title ? h('p', { class: 'pp-fan-card-title', 'data-pp-tx': 'bh3', 'data-pp-clamp': '2' }, title) : null,
        blurb ? h('p', { class: 'pp-fan-card-blurb', 'data-pp-tx': 'body', 'data-pp-clamp': '4' }, blurb) : null,
        !title && !blurb
          ? h('p', { class: 'pp-fan-card-empty', 'data-pp-tx': 'caption' }, 'No content blocks on this rendition.')
          : null),
      provenanceLabel(rendition, ctx));
    }));
}
