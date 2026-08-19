/**
 * `stack` — sequential states of the same asset (§4).
 *
 * The layout for `governed-iteration` and `approval-chain`: one asset, shown at
 * each state it passes through, in order, on one screen. The point is not each
 * state individually — it is that the brand and the claims hold across all of
 * them, which you can only see when they are stacked where the eye can compare
 * them without scrolling.
 *
 * The rail on the left is a real spine: every step is numbered, the numbers are
 * text (so they are measured like any other text), and each step is its own
 * reveal so the presenter can walk the chain one state at a time. Steps share
 * the body height equally — a flex column of `flex: 1 1 0` — so a chain of
 * three and a chain of six both fill the frame, and `measureScene` reports the
 * per-step height that follows from the count.
 *
 * @module scene/layouts/stack
 */

import { h } from '../../core/vdom.js';
import { renderBlock, summarize } from '../blocks.js';
import { flowAttrs, flowOf } from '../direction.js';
import {
  sceneHead, provenanceLabel, emptyState,
  specimenTitle, specimenMeta, renditionLabel, renditionMeta, withProvenanceLedger,
  editedMark, withEditedNotice,
} from '../parts.js';

/**
 * @param {import('../../runtime/layouts.js').LayoutContext} ctx
 * @returns {import('../../core/vdom.js').VNode}
 */
export function stack(ctx) {
  const steps = stepsOf(ctx);

  // One step per rendition, each labelled in its own header, so the ledger is
  // empty in every ordinary case — and asked for anyway, because the
  // empty-state branch renders no steps at all.
  return withEditedNotice(withProvenanceLedger(h('div', {
    class: 'pp-layout pp-layout--stack',
    'data-pp-layout': 'stack',
    'data-pp-box': 'stage',
  },
  sceneHead(ctx, { kicker: 'The same asset, at every state' }),
  steps.length === 0
    ? emptyState('This scene has no states to show yet — attach a specimen or renditions.', { box: 'body' })
    : h('ol', { class: 'pp-stack', 'data-pp-box': 'body', 'data-pp-n': String(steps.length) },
      steps.map((step, index) => renderStep(ctx, step, index, steps.length)))), ctx), ctx);
}

/**
 * The states, in order: the specimen as it starts, then one per rendition.
 * A scene with no specimen starts at its first rendition rather than inventing
 * a starting state.
 * @param {import('../../runtime/layouts.js').LayoutContext} ctx
 * @returns {{kind: 'source'|'rendition', title: string, meta: string|null, blocks: any[], rendition: any, specimen?: any, path: string, group: string}[]}
 */
function stepsOf(ctx) {
  /** @type {any[]} */
  const steps = [];
  if (ctx.specimen) {
    steps.push({
      kind: 'source',
      title: specimenTitle(ctx.specimen),
      meta: specimenMeta(ctx.specimen),
      blocks: Array.isArray(ctx.specimen.blocks) ? ctx.specimen.blocks : [],
      rendition: null,
      // The first state in the chain is the client's own content, so it is the
      // step that owes §18.3's marker if the seller changed it.
      specimen: ctx.specimen,
      path: 'stack/source',
      group: 'stack/0',
    });
  }
  const rends = Array.isArray(ctx.renditions) ? ctx.renditions.filter(Boolean) : [];
  rends.forEach((rendition, index) => {
    steps.push({
      kind: 'rendition',
      title: renditionLabel(rendition, index),
      meta: renditionMeta(rendition),
      blocks: Array.isArray(rendition.blocks) ? rendition.blocks : [],
      rendition,
      path: `stack/step/${index}`,
      group: `stack/${steps.length}`,
      ...flowOf(rendition),
    });
  });
  return steps;
}

/** @returns {import('../../core/vdom.js').VNode} */
function renderStep(ctx, step, index, total) {
  const { title, blurb, dir, lang } = summarize(step.blocks);
  const lead = step.blocks.length ? step.blocks[0] : null;
  const n = String(total);
  const flow = { dir: step.dir || dir || null, lang: step.lang || lang || null };
  return h('li', {
    class: `pp-stack-step pp-stack-step--${step.kind}`,
    'data-pp-n': n,
    'data-pp-el': ctx.el(step.path),
    'data-pp-group': step.group,
    'data-pp-rendition': step.rendition ? step.rendition.id : null,
    'data-pp-specimen': step.specimen ? step.specimen.id : null,
  },
  // The rail is a declared grid track (`--pp-sc-stack-rail-w`) and the badge in
  // it is exactly that wide, so `stackRail` is the box the number is measured
  // against rather than the whole step (CRITIQUE-2 C1).
  h('div', { class: 'pp-stack-rail', 'data-pp-box': 'stackRail', 'data-pp-n': n, 'aria-hidden': 'true' },
    h('span', { class: 'pp-stack-index', 'data-pp-tx': 'stepIndex', 'data-pp-width': 'stack-rail-w' }, String(index + 1))),
  // `stackStep` names the panel the step's text is laid out in — the body, not
  // the row that also holds the rail. The box and the geometry now describe the
  // same element.
  h('div', { class: 'pp-stack-body', 'data-pp-box': 'stackStep', 'data-pp-n': n },
    h('div', { class: 'pp-stack-head' },
      // A declared two-track row: the meta column is `--pp-sc-step-meta-w` and
      // the label is what is left. It used to be two shrink-to-fit flex items
      // with the right-hand one at `flex: 0 0 auto`, which crushed the label to
      // a zero-width box at `sm` while the model reported 284px.
      h('p', {
        class: 'pp-stack-label',
        'data-pp-tx': 'stepLabel',
        'data-pp-clamp': '1',
        'data-pp-inset': 'step-meta-w,step-meta-gap',
        ...flowAttrs(flow),
      }, step.title),
      // The provenance label rides in the header rather than under the content:
      // a state in a chain is one or two lines tall, and a label below the copy
      // would push that copy out of its own step.
      h('div', { class: 'pp-stack-head-right', 'data-pp-width': 'step-meta-w' },
        step.meta ? h('p', { class: 'pp-stack-meta', 'data-pp-tx': 'panelMeta', 'data-pp-clamp': '1' }, step.meta) : null,
        provenanceLabel(step.rendition, ctx),
        // The source step's counterpart to the provenance label, in the same
        // corner and for the same reason: a state in a chain is one or two lines
        // tall, and a marker below the copy would push that copy out of its step.
        editedMark(step.specimen))),
    h('div', { class: 'pp-stack-content' },
      lead && lead.type !== 'paragraph' && lead.type !== 'heading'
        ? renderBlock(lead, { media: ctx.media, density: 'condensed', clampParagraph: 2, maxListItems: 3, maxTableRows: 3, ...flow })
        : [
          title ? h('p', { class: 'pp-stack-title', 'data-pp-tx': 'bh3', 'data-pp-clamp': '1', ...flowAttrs(flow) }, title) : null,
          blurb ? h('p', { class: 'pp-stack-blurb', 'data-pp-tx': 'body', 'data-pp-clamp': '2', ...flowAttrs(flow) }, blurb) : null,
          !title && !blurb ? h('p', { class: 'pp-stack-empty', 'data-pp-tx': 'caption' }, 'No content blocks at this state.') : null,
        ])));
}
