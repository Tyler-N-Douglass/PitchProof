/**
 * `contentsIndex` — the Review-mode contents list (§2, §4).
 *
 * §2 gives a forwarded recipient a contents index, and this is the scene form
 * of it: a numbered list of what the proof covers, sitting in the deck as a
 * scene the presenter can also open with. (The *overlay* contents index, opened
 * with a key during presentation, is L9's; this is the scene, and the two are
 * deliberately separate — a layout sees only its own scene, never the deck.)
 *
 * Entries are derived from the model, in this order:
 *   1. the specimen's headings, each with the prose that follows it as a blurb;
 *   2. failing that, the renditions, each with its label;
 *   3. failing that, an empty state that says which piece is missing.
 *
 * Nothing is written that is not already in the proof (§18.2).
 *
 * @module scene/layouts/contents-index
 */

import { h } from '../../core/vdom.js';
import { blockText } from '../../core/contracts.js';
import {
  sceneHead, provenanceLabel, emptyState, waveGroup,
  specimenTitle, renditionLabel, renditionMeta,
} from '../parts.js';

/**
 * @param {import('../../runtime/layouts.js').LayoutContext} ctx
 * @returns {import('../../core/vdom.js').VNode}
 */
export function contentsIndex(ctx) {
  const entries = entriesFor(ctx);

  return h('div', {
    class: 'pp-layout pp-layout--index',
    'data-pp-layout': 'contentsIndex',
    'data-pp-box': 'stage',
  },
  sceneHead(ctx, { kicker: 'Contents' }),
  entries.length === 0
    ? emptyState('This contents scene has nothing to list yet — attach a specimen or renditions.', { box: 'body' })
    : h('ol', { class: 'pp-index', 'data-pp-box': 'body', 'data-pp-n': String(entries.length) },
      entries.map((entry, index) => h('li', {
        class: 'pp-index-row',
        'data-pp-el': ctx.el(`index/entry/${index}`),
        'data-pp-group': waveGroup('index', index, entries.length, 5),
        'data-pp-rendition': entry.rendition ? entry.rendition.id : null,
      },
      h('div', { class: 'pp-index-num', 'data-pp-box': 'indexNumber', 'data-pp-n': String(entries.length) },
        h('span', { class: 'pp-index-num-text', 'data-pp-tx': 'indexNumber' }, pad2(index + 1))),
      h('div', { class: 'pp-index-text', 'data-pp-box': 'indexRow', 'data-pp-n': String(entries.length) },
        h('p', { class: 'pp-index-title', 'data-pp-tx': 'indexTitle', 'data-pp-clamp': '2' }, entry.title),
        entry.blurb
          ? h('p', { class: 'pp-index-blurb', 'data-pp-tx': 'indexBlurb', 'data-pp-clamp': '2' }, entry.blurb)
          : null,
        provenanceLabel(entry.rendition, ctx))))));
}

/**
 * @param {import('../../runtime/layouts.js').LayoutContext} ctx
 * @returns {{title: string, blurb: string|null, rendition: any}[]}
 */
function entriesFor(ctx) {
  /** @type {{title: string, blurb: string|null, rendition: any}[]} */
  const entries = [];
  const blocks = ctx.specimen && Array.isArray(ctx.specimen.blocks) ? ctx.specimen.blocks : [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!block || block.type !== 'heading' || !block.text) continue;
    if ((Number(block.level) || 1) > 3) continue;
    let blurb = null;
    for (let j = i + 1; j < blocks.length && !blurb; j++) {
      const next = blocks[j];
      if (!next || next.type === 'heading') break;
      const text = blockText(next).join(' ').trim();
      if (text) blurb = text;
    }
    entries.push({ title: String(block.text), blurb, rendition: null });
  }

  // Renditions are listed too, after the sections — a contents scene that
  // silently dropped the variants the scene carries would be a contents list
  // that is not a list of the contents.
  const rends = Array.isArray(ctx.renditions) ? ctx.renditions.filter(Boolean) : [];
  rends.forEach((rendition, index) => {
    entries.push({
      title: renditionLabel(rendition, index),
      blurb: renditionMeta(rendition),
      rendition,
    });
  });

  if (entries.length === 0 && ctx.specimen) {
    entries.push({ title: specimenTitle(ctx.specimen), blurb: null, rendition: null });
  }
  return entries;
}

/** Two-digit row numbers, so the column does not jitter at ten. */
function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}
