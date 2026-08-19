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
import { flowAttrs } from '../direction.js';
import {
  sceneHead, panelHead, provenanceLabel, emptyState, waveGroup,
  specimenMeta, specimenTitle, renditionLabel, withProvenanceLedger,
  editedMark, withEditedNotice,
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

  // A card per rendition, each carrying its own label, so the ledger is empty
  // in every ordinary case. It is asked for on the way out regardless — the
  // empty-state branch renders no cards, and §18.1 has to hold on every branch.
  return withEditedNotice(withProvenanceLedger(h('div', {
    class: 'pp-layout pp-layout--fan',
    'data-pp-layout': 'fanOut',
    'data-pp-box': 'stage',
  },
  sceneHead(ctx, { kicker: 'One source, every variant' }),
  rends.length === 0
    ? emptyState('This scene has no renditions attached yet.', { box: 'body' })
    : h('div', { class: 'pp-fan', 'data-pp-box': 'body' },
      renderSource(ctx, sourceBlocks, rends.length),
      renderGrid(ctx, rends))), ctx), ctx);
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
    // The specimen's scope, so the §18.3 marker sits inside the subtree of the
    // content it is about.
    'data-pp-specimen': ctx.specimen ? ctx.specimen.id : null,
  },
  panelHead({
    title: specimenTitle(ctx.specimen),
    meta: specimenMeta(ctx.specimen),
    tone: 'before',
  }),
  // Above the source body, not below it: `.pp-fan-source-body` is the flexible
  // item in this column and it is `overflow: hidden`, so a marker placed after
  // it would be the run this rail clips first. It squeezes the excerpt instead,
  // which is the right way round — the excerpt is an excerpt already.
  editedMark(ctx.specimen),
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
  // `data-pp-lines`, because `.pp-fan-count-number` is a block in normal flow:
  // its box is its own line, not the 536px `fanSource` column it inherited,
  // which is why no height check on this role could fire at all (DEFERRED.md).
  // One line is what the design gives it, and a badge that needed two would
  // squeeze `.pp-fan-source-body` — which *is* `overflow: hidden` — by exactly
  // that much.
  h('p', { class: 'pp-fan-count-number', 'data-pp-tx': 'badgeNumber', 'data-pp-lines': '1' }, String(count)),
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
      const summary = summarize(blocks);
      const { title, blurb } = summary;
      // C8: a card summarising a right-to-left rendition reads right to left.
      const flow = flowAttrs({ dir: rendition.dir || summary.dir, lang: rendition.lang || summary.lang });
      const group = waveGroup('fan', index, rends.length, WAVE_SIZE);
      return h('article', {
        class: 'pp-fan-card',
        'data-pp-box': 'fanCard',
        'data-pp-n': n,
        'data-pp-el': ctx.el(`fan/rendition/${index}`),
        'data-pp-group': group,
        'data-pp-rendition': rendition.id,
      },
      // The card carries the label, the content and — where §9 requires it —
      // the provenance line. It deliberately does not carry the `producedBy`
      // meta the other layouts show: a fan card is small, and the room's
      // attention belongs on the client's own content in it.
      h('header', { class: 'pp-fan-card-head' },
        h('p', { class: 'pp-fan-card-label', 'data-pp-tx': 'panelTitle', 'data-pp-clamp': '1' }, renditionLabel(rendition, index))),
      h('div', { class: 'pp-fan-card-body' },
        title ? h('p', { class: 'pp-fan-card-title', 'data-pp-tx': 'bh3', 'data-pp-clamp': '2', ...flow }, title) : null,
        blurb ? h('p', { class: 'pp-fan-card-blurb', 'data-pp-tx': 'body', 'data-pp-clamp': '2', ...flow }, blurb) : null,
        !title && !blurb
          ? h('p', { class: 'pp-fan-card-empty', 'data-pp-tx': 'caption' }, 'No content blocks on this rendition.')
          : null),
      provenanceLabel(rendition, ctx));
    }));
}
