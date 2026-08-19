/**
 * `sideNote` — content with a margin annotation (§4).
 *
 * The layout for the moment in a pitch where the content is the client's and
 * the commentary is yours: their page runs down the main column, and each
 * change, constraint or observation sits in the margin *opposite the block it
 * is about*. Annotation that floats away from its subject is decoration; this
 * one is anchored by construction, because notes are placed on the row of the
 * source block they were aligned to.
 *
 * Notes come from the model and nowhere else — a rendition's blocks aligned
 * against the specimen, and the rendition's `notes` string. Nothing is
 * invented (§18.2).
 *
 * @module scene/layouts/side-note
 */

import { h } from '../../core/vdom.js';
import { alignPair } from '../align.js';
import { renderBlock } from '../blocks.js';
import { flowOf } from '../direction.js';
import { blockText } from '../../core/contracts.js';
import {
  sceneHead, provenanceLabel, emptyState, waveGroup, presentableNotes,
  specimenMeta, specimenTitle, renditionLabel, withProvenanceLedger,
  editedMark, withEditedNotice,
} from '../parts.js';

/**
 * @param {import('../../runtime/layouts.js').LayoutContext} ctx
 * @returns {import('../../core/vdom.js').VNode}
 */
export function sideNote(ctx) {
  const { specimen } = ctx;
  const mainBlocks = specimen && Array.isArray(specimen.blocks) ? specimen.blocks : [];
  const notes = notesFor(ctx, mainBlocks);
  const rowCount = Math.max(mainBlocks.length, notes.length, 1);

  if (mainBlocks.length === 0 && notes.length === 0) {
    return withEditedNotice(withProvenanceLedger(h('div', {
      class: 'pp-layout pp-layout--side',
      'data-pp-layout': 'sideNote',
      'data-pp-box': 'stage',
    },
    sceneHead(ctx, { kicker: 'Their content, annotated' }),
    emptyState('This scene has no specimen and no notes attached yet.', { box: 'body' })), ctx), ctx);
  }

  // One row per main block, with any notes anchored to that row beside it, plus
  // trailing rows for notes that outlive the main column.
  const rows = [];
  const maxRow = Math.max(mainBlocks.length, ...notes.map((note) => note.row + 1), 0);
  for (let row = 0; row < maxRow; row++) {
    rows.push({ block: row < mainBlocks.length ? row : null, notes: notes.filter((note) => note.row === row) });
  }

  // A rendition only reaches the margin if it produced a note: `notesFor`
  // keeps a written note and every aligned block that carries text, and drops
  // the rest. So a rendition of nothing but media blocks, or one whose blocks
  // align to nothing in the client's page, contributes no note and would sit in
  // the scene unlabelled. The ledger is what covers it.
  return withEditedNotice(withProvenanceLedger(h('div', {
    class: 'pp-layout pp-layout--side',
    'data-pp-layout': 'sideNote',
    'data-pp-box': 'stage',
  },
  sceneHead(ctx, {
    kicker: 'Their content, annotated',
    // The source chip is where this layout names the client's page, so it is
    // where §18.3's marker belongs: the main column below is their content
    // block by block, with no head of its own to hang it on.
    extra: specimen
      ? h('div', { class: 'pp-side-source-group', 'data-pp-specimen': specimen.id },
        h('p', { class: 'pp-side-source', 'data-pp-tx': 'panelMeta', 'data-pp-clamp': '1' },
          [specimenTitle(specimen), specimenMeta(specimen)].filter(Boolean).join('  ·  ')),
        editedMark(specimen))
      : null,
  }),
  h('div', { class: 'pp-side', 'data-pp-box': 'body' },
    rows.map((row, index) => h('div', { class: 'pp-side-row', 'data-pp-row': String(index) },
      h('div', {
        class: 'pp-side-main',
        'data-pp-box': 'sideMain',
        'data-pp-container': 'main',
      },
      row.block === null
        ? null
        : h('div', {
          class: 'pp-side-block',
          'data-pp-el': ctx.el(`main/block/${row.block}`),
          'data-pp-group': 'main',
        }, renderBlock(mainBlocks[row.block], { media: ctx.media, density: 'full' }))),
      h('div', { class: 'pp-side-margin' },
        row.notes.map((note) => renderNote(ctx, note, rowCount))))))), ctx), ctx);
}

/**
 * The notes, each carrying the row of the main block it belongs beside.
 * @param {import('../../runtime/layouts.js').LayoutContext} ctx
 * @param {import('../../core/contracts.d.ts').ContentBlock[]} mainBlocks
 * @returns {{row: number, index: number, label: string, kind: 'block'|'note', block: any, text: string|null, rendition: any}[]}
 */
function notesFor(ctx, mainBlocks) {
  const rends = Array.isArray(ctx.renditions) ? ctx.renditions.filter(Boolean) : [];
  /** @type {any[]} */
  const notes = [];
  rends.forEach((rendition, rIndex) => {
    const label = renditionLabel(rendition, rIndex);
    const written = presentableNotes(rendition);
    if (written) {
      notes.push({ row: 0, index: notes.length, label, kind: 'note', block: null, text: written, rendition });
    }
    const blocks = Array.isArray(rendition.blocks) ? rendition.blocks : [];
    const pairs = alignPair(mainBlocks, blocks);
    let lastRow = 0;
    for (const [source, target] of pairs) {
      if (source !== null) lastRow = source;
      if (target === null) continue;
      const block = blocks[target];
      const text = blockText(block).join(' ').trim();
      if (!text) continue;
      notes.push({
        row: source === null ? lastRow : source,
        index: notes.length,
        label,
        kind: 'block',
        block,
        text: null,
        rendition,
      });
    }
  });
  // Notes that anchor to the same block would otherwise pile into one row and
  // stretch it, pushing the next paragraph of the client's page a screen down.
  // Spreading them — one per row, never above the block they belong to, order
  // preserved — keeps each note beside its subject without deforming the
  // column it annotates.
  let cursor = -1;
  return notes
    .map((note, i) => ({ ...note, index: i }))
    .sort((a, b) => (a.row === b.row ? a.index - b.index : a.row - b.row))
    .map((note) => {
      cursor = Math.max(note.row, cursor + 1);
      return { ...note, row: cursor };
    })
    .sort((a, b) => a.index - b.index);
}

/** @returns {import('../../core/vdom.js').VNode} */
function renderNote(ctx, note, rowCount) {
  return h('aside', {
    class: `pp-side-note pp-side-note--${note.kind}`,
    'data-pp-box': 'sideNote',
    'data-pp-n': String(rowCount),
    'data-pp-container': 'notes',
    'data-pp-el': ctx.el(`note/${note.index}`),
    'data-pp-group': waveGroup('notes', note.index, rowCount),
    'data-pp-rendition': note.rendition ? note.rendition.id : null,
  },
  h('p', { class: 'pp-side-note-label', 'data-pp-tx': 'noteLabel', 'data-pp-clamp': '1' }, note.label),
  note.kind === 'note'
    ? h('p', { class: 'pp-side-note-text', 'data-pp-tx': 'note', 'data-pp-clamp': '6' }, note.text)   // the note is the seller's own annotation, not the rendition's copy
    : renderBlock(note.block, { media: ctx.media, density: 'condensed', clampParagraph: 6, clampHeading: 2, maxListItems: 4, maxTableRows: 3, ...flowOf(note.rendition) }),
  provenanceLabel(note.rendition, ctx));
}
