/**
 * The Recipes panel (§9).
 *
 * §9 is explicit that the manual paste path "must be excellent, not a fallback:
 * a side-by-side paste surface with block-level alignment to the source
 * specimen". That surface is the centre of this panel, not an alternative
 * hidden behind an adapter:
 *
 *   - the source specimen's blocks on the left, the pasted rendition's parsed
 *     blocks on the right, aligned row by row, with the alignment score and
 *     every unmatched block called out — because an unmatched block is either a
 *     deliberate structural change worth seeing or a paste that went wrong;
 *   - the channel budget for the chosen label enforced and *visible*, so a
 *     "SMS" rendition that is 400 characters long says so before it reaches a
 *     scene;
 *   - provenance on every rendition, with promotion to `verified-by-user` as a
 *     deliberate, recorded act rather than a toggle. §9 forbids defaulting to
 *     it, §18 forbids implying it, and the emitter enforces both — this panel
 *     makes the state impossible to miss on the way there.
 *
 * @module ui/panels/recipes
 */

import { h, cx } from '../../core/vdom.js';
import {
  badge, button, checkbox, empty, field, notice, pair, pairs, row, section, select, textarea, toolbar,
} from '../components.js';
import { formatDateTime, formatPercent, humanize, plural, truncate } from '../format.js';
import { blockSummary, findRendition, findSpecimen } from '../model.js';
import { PROVENANCE_COPY } from '../constants.js';
import { ACT_ATTR, KEY_ATTR } from '../render.js';

/**
 * @param {any} app
 * @returns {import('../../core/vdom.js').VNode}
 */
export function renderRecipesPanel(app) {
  const proof = app.proof;
  const recipes = proof.recipes || [];
  const specimens = proof.specimens || [];
  const specimen = findSpecimen(proof, app.ui.selection.specimenId) || specimens[0] || null;
  const recipe = recipes.find((r) => r.id === app.ui.selection.recipeId) || recipes[0] || null;

  return h('div', { class: 'st-panel' },
    renderLibrary(app, recipes, recipe),
    renderPasteSurface(app, specimen, recipe),
    renderRenditions(app, proof));
}

/**
 * @param {any} app
 * @param {any[]} recipes
 * @param {any} selected
 */
function renderLibrary(app, recipes, selected) {
  const specimen = findSpecimen(app.proof, app.ui.selection.specimenId) || (app.proof.specimens || [])[0] || null;
  const applicable = specimen ? app.services.recipesFor(specimen) : [];
  const applicableIds = new Set(applicable.map((r) => r.id));

  return section({
    title: 'Recipe library',
    subtitle: 'The eight from §9. Each one is a transformation you can run on a specimen, and the point you are making with it.',
    actions: toolbar(
      button({ act: 'recipe.loadSeed', variant: recipes.length ? 'ghost' : 'primary' },
        recipes.length ? 'Reload the library' : 'Load the eight seed recipes'),
      button({
        act: 'recipe.runAll', variant: 'primary',
        disabled: !recipes.length || !specimen || applicable.length === 0,
        title: !specimen ? 'Capture a specimen first'
          : applicable.length === 0 ? 'No seed recipe accepts this specimen’s kind'
            : `Run ${applicable.length} recipes against “${truncate(specimen.title, 30)}”`,
      }, 'Run every recipe that fits'),
    ),
  },
  recipes.length
    ? h('div', { class: 'st-rows' }, recipes.map((r) => {
      const fits = applicableIds.has(r.id);
      const made = (app.proof.renditions || []).filter((rd) => rd.recipeId === r.id).length;
      return row({
        act: 'recipe.select', arg: r.id, key: r.id, selected: !!selected && r.id === selected.id,
        title: h('span', null,
          r.name,
          made ? badge(`${made} made`, 'ok') : null,
          specimen && !fits ? badge('does not fit this specimen', 'dim', `Takes ${(r.inputKinds || []).join(', ')}`) : null),
        meta: h('span', null, r.intent),
        trailing: h('div', { class: 'st-row-tools' },
          button({
            act: 'recipe.run', arg: r.id, variant: fits ? 'primary' : 'ghost',
            disabled: !specimen || !fits,
            title: !specimen ? 'Capture a specimen first'
              : fits ? `Run “${r.name}” on “${truncate(specimen.title, 28)}”`
                : `“${r.name}” takes ${(r.inputKinds || []).join(', ')}`,
          }, 'Run'),
          button({ act: 'recipe.remove', arg: r.id, variant: 'quiet', title: `Remove ${r.name}` }, '×')),
      });
    }))
    : empty('The library is empty. These eight are the reframe: one page becoming nine markets, four channels, three breakpoints, five review states (§9).',
      button({ act: 'recipe.loadSeed', variant: 'primary' }, 'Load the eight seed recipes')),

  recipes.length && !specimen
    ? notice('warn', 'A recipe transforms a specimen. Capture one in Specimens and every recipe here becomes runnable.')
    : null,

  selected
    ? pairs(
      pair('Intent', selected.intent),
      pair('Takes', h('span', { class: 'st-mono' }, (selected.inputKinds || []).join(', ') || 'any specimen')),
      pair('Produces', h('span', { class: 'st-mono' }, (selected.outputLabels || []).join(' · ') || '—')),
    )
    : null,

  recipes.length
    ? notice('info', 'A recipe writes the "after" side from their own content. It fabricates no metric, no logo, no testimonial and no named customer — §18.2 — and everything it produces is stamped illustrative until you check it yourself.')
    : null);
}

/**
 * The side-by-side surface §9 calls the default way renditions get made.
 * @param {any} app
 * @param {any} specimen
 * @param {any} recipe
 */
function renderPasteSurface(app, specimen, recipe) {
  const paste = String(app.draft('rendition.paste', ''));
  const label = String(app.draft('rendition.label', ''));
  const parsed = paste.trim() ? app.services.parsePasted(paste) : [];
  const sourceBlocks = specimen ? specimen.blocks || [] : [];
  const alignment = parsed.length ? app.services.alignBlocks(sourceBlocks, parsed) : { pairs: [], score: 0 };
  const budget = label ? app.services.channelBudget(label) : null;
  const budgeted = budget ? app.services.enforceBudget(parsed, budget) : null;

  return section({
    title: 'Paste a rendition',
    subtitle: 'Their page on the left, your output on the right, aligned block by block. Bring real output and paste it here; run a seed recipe above when you want the shape of the argument first.',
    actions: toolbar(
      button({
        act: 'rendition.create', variant: 'primary',
        disabled: !specimen || !recipe || !paste.trim(),
        title: !specimen ? 'Pick a specimen first' : !recipe ? 'Pick a recipe first' : 'Create the rendition',
      }, 'Create rendition'),
      button({
        act: 'rendition.runAdapter', variant: 'ghost',
        disabled: !app.ui.settings.adapterEndpoint,
        title: app.ui.settings.adapterEndpoint ? 'Call the configured adapter' : 'No adapter is configured (Settings)',
      }, 'Use the adapter'),
    ),
  },
  h('div', { class: 'st-grid-2' },
    select({
      label: 'Source specimen', act: 'specimen.select',
      value: specimen ? specimen.id : '',
      options: (app.proof.specimens || []).map((s) => ({ value: s.id, label: truncate(s.title, 40) })),
      disabled: !(app.proof.specimens || []).length,
      key: 'paste-specimen',
      hint: specimen ? `${plural(sourceBlocks.length, 'block')} on the left.` : 'Capture a specimen first.',
    }),
    select({
      label: 'Recipe', act: 'recipe.select',
      value: recipe ? recipe.id : '',
      options: (app.proof.recipes || []).map((r) => ({ value: r.id, label: r.name })),
      disabled: !(app.proof.recipes || []).length,
      key: 'paste-recipe',
      hint: recipe ? recipe.intent : 'Load the recipe library first.',
    })),

  field({
    label: 'Rendition label', act: 'rendition.labelDraft', value: label,
    placeholder: (recipe && (recipe.outputLabels || [])[0]) || 'de-DE',
    key: 'paste-label',
    hint: budget
      ? `“${label}” is a channel with a budget: ${budget.maxChars} characters, ${budget.maxWords} words.`
      : (recipe && (recipe.outputLabels || []).length
        ? `Expected labels for this recipe: ${(recipe.outputLabels || []).join(', ')}.`
        : 'What this variant is — a locale, a channel, a breakpoint, a review state.'),
  }),

  h('textarea', {
    class: 'st-input st-textarea st-align-paste',
    rows: '9',
    placeholder: 'Paste the rendition here.\n\nBlank lines separate blocks. A leading # makes a heading, a leading - makes a list, a leading > makes a quote.',
    value: paste,
    'aria-label': 'Rendition paste',
    [ACT_ATTR]: 'rendition.pasteDraft',
    [KEY_ATTR]: 'paste-body',
  }),

  // The alignment itself: one row per pair, so a block that matched sits beside
  // the block it matched, and a block that did not sits beside a gap. §9 asks
  // for "block-level alignment to the source specimen"; a gap is the part of
  // that which is worth seeing.
  h('div', { class: 'st-align' },
    h('div', { class: 'st-align-head' },
      h('span', { class: 'st-align-title' }, specimen ? `Source · ${truncate(specimen.title, 28)}` : 'Source'),
      h('span', { class: 'st-align-title' }, 'Rendition'),
      h('span', { class: 'st-align-score' }, parsed.length
        ? h('span', null, 'Aligned ', h('strong', { class: cx('st-mono', alignment.score < 0.5 && 'st-warn') }, formatPercent(alignment.score)))
        : 'nothing pasted yet')),
    h('div', { class: 'st-align-rows' }, alignRows(alignment, sourceBlocks, parsed).map((pairRow, i) => h('div', {
      class: cx('st-align-row', (pairRow.left === null || pairRow.right === null) && 'st-align-row--gap'),
      [KEY_ATTR]: `row-${i}`,
    },
    renderCell(sourceBlocks[pairRow.left], pairRow.left === null),
    renderCell(parsed[pairRow.right], pairRow.right === null)))),
    sourceBlocks.length ? null : h('p', { class: 'st-align-empty' }, 'Pick a specimen to see its blocks here.')),

  parsed.length && alignment.score < 0.5
    ? notice('warn', `Only ${formatPercent(alignment.score)} of the blocks line up. That is fine when the rendition deliberately restructures the page — and a sign the paste lost its shape when it does not.`)
    : null,

  budgeted && budgeted.overBy > 0
    ? notice('bad', `This rendition is ${budgeted.overBy} over the ${label} budget. A channel variant that does not fit its channel is not a proof of anything — trim it before creating it.`)
    : null,

  notice('info', 'A rendition created here is stamped illustrative. It carries a visible label in the artifact until you mark it client-supplied or promote it, and the emitter enforces that rather than this panel (§9, §22.6).'),

  app.services.has('recipe') ? null : notice('warn', 'The recipe lane is not wired into this build. Pasting still parses and aligns using the studio’s own fallback, but renditions cannot be created until it lands.'));
}

/**
 * The rows to draw: L7's pairs when it gave any, otherwise one row per position
 * so the two sides still line up rather than collapsing into two lists.
 * @param {{pairs: [number|null, number|null][]}} alignment
 * @param {any[]} source
 * @param {any[]} parsed
 * @returns {{left: number|null, right: number|null}[]}
 */
function alignRows(alignment, source, parsed) {
  const pairs = alignment && Array.isArray(alignment.pairs) ? alignment.pairs : [];
  if (pairs.length) return pairs.map(([left, right]) => ({ left, right }));
  const n = Math.max(source.length, parsed.length);
  return Array.from({ length: n }, (_, i) => ({
    left: i < source.length ? i : null,
    right: i < parsed.length ? i : null,
  }));
}

/**
 * One side of an alignment row. An absent block renders as an explicit gap
 * rather than as nothing, because "this block has no counterpart" is the
 * finding the surface exists to show.
 * @param {any} block
 * @param {boolean} empty
 * @returns {import('../../core/vdom.js').VNode}
 */
function renderCell(block, empty) {
  if (empty || !block) return h('div', { class: 'st-align-cell st-align-cell--gap' }, h('span', { class: 'st-align-gap' }, 'no counterpart'));
  return h('div', { class: 'st-align-cell' },
    badge(block.type, 'dim'),
    h('span', { class: 'st-align-text' }, truncate(blockSummary(block), 200)));
}

/**
 * @param {any} app
 * @param {any} proof
 */
function renderRenditions(app, proof) {
  const renditions = proof.renditions || [];
  const selected = findRendition(proof, app.ui.selection.renditionId) || renditions[0] || null;
  const illustrative = renditions.filter((r) => r.provenance === 'illustrative').length;

  return section({
    title: `Renditions · ${renditions.length}`,
    subtitle: illustrative
      ? `${plural(illustrative, 'rendition')} will carry a visible illustrative label in the artifact.`
      : 'Every rendition here is either the client’s own or verified by you.',
  },
  renditions.length
    ? h('div', { class: 'st-rows' }, renditions.map((r) => {
      const copy = PROVENANCE_COPY[r.provenance] || PROVENANCE_COPY.illustrative;
      const source = findSpecimen(proof, r.specimenId);
      return row({
        act: 'rendition.select', arg: r.id, key: r.id, selected: !!selected && r.id === selected.id,
        title: h('span', null, r.label || '(unnamed)', badge(copy.label, copy.tone, copy.describe)),
        meta: h('span', null,
          `${plural((r.blocks || []).length, 'block')} · from ${source ? truncate(source.title, 26) : 'a removed specimen'} · ${humanize(r.producedBy)}`),
        trailing: button({ act: 'rendition.remove', arg: r.id, variant: 'quiet', title: `Remove ${r.label}` }, '×'),
      });
    }))
    : empty('No renditions yet. Paste one above, or run a seed recipe against a captured specimen — the “after” side is what makes a before/after scene mean anything.'),

  selected ? renderRenditionDetail(app, selected) : null);
}

/**
 * @param {any} app
 * @param {any} rendition
 */
function renderRenditionDetail(app, rendition) {
  const copy = PROVENANCE_COPY[rendition.provenance] || PROVENANCE_COPY.illustrative;
  const promoted = rendition.provenance === 'verified-by-user';
  const record = app.services.promotionRecord(rendition);
  const budget = app.services.channelBudget(rendition.label);
  const chars = (rendition.blocks || []).map(blockSummary).join(' ').length;

  return h('div', { class: 'st-subsection' },
    h('h4', { class: 'st-subsection-title' }, `Provenance · ${rendition.label}`),
    h('div', { class: 'st-grid-2' },
      field({
        label: 'Label', act: 'rendition.setLabel', arg: rendition.id, value: rendition.label,
        key: `rd-label-${rendition.id}`,
      }),
      h('div', { class: 'st-field' },
        h('span', { class: 'st-field-label' }, 'Current provenance'),
        h('div', null, badge(copy.label, copy.tone)),
        h('span', { class: 'st-field-hint' }, copy.describe))),
    textarea({
      label: 'Notes', act: 'rendition.setNotes', arg: rendition.id, rows: 3,
      value: app.services.visibleNotes(rendition), key: `rd-notes-${rendition.id}`,
      hint: 'Where this came from, in a sentence. The promotion record is stored separately and editing this cannot destroy it.',
    }),
    record
      ? pairs(
        pair('Promoted by', record.by || '—'),
        pair('Promoted at', formatDateTime(record.at)),
        pair('Promoted from', humanize(record.from || '')),
        pair('Record', record.signatureValid ? badge('verifies against itself', 'ok') : badge('does not verify', 'bad')),
      )
      : null,
    budget
      ? pairs(
        pair('Channel budget', h('span', { class: 'st-mono' }, `${budget.maxChars} chars · ${budget.maxWords} words`)),
        pair('This rendition', h('span', {
          class: cx('st-mono', chars > budget.maxChars && 'st-bad'),
        }, `${chars} chars`)),
      )
      : null,
    checkbox({
      label: 'This is the client’s own material',
      act: 'rendition.clientSupplied',
      arg: rendition.id,
      checked: rendition.provenance === 'client-supplied',
      disabled: promoted,
      hint: 'Only tick this for content they published or supplied. It suppresses the illustrative label.',
    }),
    promoted
      ? notice('ok', record
        ? `Promoted to verified-by-user by ${record.by} on ${formatDateTime(record.at)}. The record travels with the project and the emitter checks it.`
        : 'This rendition claims verified-by-user with no promotion record behind it. The emitter treats that as a forgery and refuses.')
      : notice('warn', h('div', null,
        h('p', null, 'Promotion to verified-by-user is a deliberate act. It says you have checked this against what the client would actually publish, and it is recorded against your name.'),
        h('p', null, 'The tool will never do it for you, and there is no setting that makes it the default (§9).')),
      button({
        act: 'rendition.promote', arg: rendition.id, variant: 'primary',
        disabled: !app.ui.settings.operator,
        title: app.ui.settings.operator ? 'Record the promotion' : 'Put your name in Settings first',
      }, 'I have verified this')));
}
