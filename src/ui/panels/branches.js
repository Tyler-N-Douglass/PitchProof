/**
 * The Branches panel (§11).
 *
 * A branch is an objection in the client's words. That phrasing is not
 * decoration — it is the corpus the jump index searches, so this panel treats
 * it as the primary field and gives aliases equal weight, then lets you test
 * the search here rather than discovering on stage that three characters of
 * "approvals" lands somewhere else.
 *
 * The two coverage rules §11 names are shown against every branch: a branch
 * with no anchor and no jump entry is unreachable, and a branch whose last
 * scene has no resolved return target strands the presenter. Both are checked
 * against the live deck, not against a guess.
 *
 * @module ui/panels/branches
 */

import { h, cx } from '../../core/vdom.js';
import {
  badge, button, empty, field, notice, pair, pairs, row, section, select, textarea, toolbar,
} from '../components.js';
import { humanize, plural, truncate } from '../format.js';
import { findBranch } from '../model.js';
import { ACT_ATTR, ARG_ATTR, KEY_ATTR } from '../render.js';

/**
 * @param {any} app
 * @returns {import('../../core/vdom.js').VNode}
 */
export function renderBranchesPanel(app) {
  const proof = app.proof;
  const branches = proof.branches || [];
  const selected = findBranch(proof, app.ui.selection.branchId) || branches[0] || null;
  // The deck comes from the document-free runtime, so branch coverage is
  // computed whether or not the preview happens to be on screen.
  const model = app.preview.model(app.proof);
  const deck = model ? model.deck : null;
  const coverage = deck ? app.services.branchCoverage(deck) : { unreachable: [], noReturn: [] };

  return h('div', { class: 'st-panel' },
    renderCreate(app, branches, coverage),
    renderList(app, branches, selected, coverage),
    selected ? renderBranch(app, selected, coverage) : null,
    renderJumpTest(app, deck));
}

/**
 * @param {any} app
 * @param {any[]} branches
 * @param {{unreachable: string[], noReturn: string[]}} coverage
 */
function renderCreate(app, branches, coverage) {
  return section({
    title: 'New branch',
    subtitle: 'Write the objection the way a client says it out loud. That sentence is what the jump index searches.',
    actions: toolbar(button({ act: 'branch.create', variant: 'primary' }, 'Create branch')),
  },
  textarea({
    label: 'Objection', act: 'branch.objectionDraft', rows: 2,
    value: app.draft('branch.objection', ''),
    placeholder: 'Our approvals process would never allow this',
    key: 'branch-objection-draft',
    hint: 'Verbatim beats paraphrase. “Legal has to see every claim” finds itself; “compliance considerations” does not.',
  }),
  branches.length < 3
    ? notice('warn', `§1.2 asks for at least three objection branches before a proof is done. There ${branches.length === 1 ? 'is 1' : `are ${branches.length}`}.`)
    : null,
  coverage.unreachable.length || coverage.noReturn.length
    ? notice('bad', h('div', null,
      coverage.unreachable.length
        ? h('p', null, `${plural(coverage.unreachable.length, 'branch', 'branches')} cannot be reached: no anchor and no jump entry. The sweep raises BRANCH_UNREACHABLE.`)
        : null,
      coverage.noReturn.length
        ? h('p', null, `${plural(coverage.noReturn.length, 'branch', 'branches')} have no resolved return target. That strands the presenter mid-pitch (§22.4).`)
        : null))
    : null);
}

/**
 * @param {any} app
 * @param {any[]} branches
 * @param {any} selected
 * @param {{unreachable: string[], noReturn: string[]}} coverage
 */
function renderList(app, branches, selected, coverage) {
  const anchoredIds = new Set();
  for (const scene of app.proof.spine || []) for (const id of scene.branchAnchors || []) anchoredIds.add(id);

  return section({
    title: `Branches · ${branches.length}`,
    subtitle: 'Off-spine sequences, reachable by jump, always returning.',
  },
  branches.length
    ? h('div', { class: 'st-rows' }, branches.map((b) => row({
      act: 'branch.select', arg: b.id, key: b.id, selected: !!selected && b.id === selected.id,
      title: h('span', null,
        truncate(b.objection, 44),
        coverage.unreachable.includes(b.id) ? badge('unreachable', 'bad') : null,
        coverage.noReturn.includes(b.id) ? badge('no return', 'bad') : null,
        anchoredIds.has(b.id) ? null : badge('unanchored', 'warn', 'Reachable only from the jump index')),
      meta: h('span', null,
        `${plural((b.scenes || []).length, 'scene')} · returns to ${b.returnPolicy === 'anchor' ? 'the anchor' : 'the next spine scene'}`,
        (b.aliases || []).length ? ` · ${plural(b.aliases.length, 'alias', 'aliases')}` : ' · no aliases'),
      trailing: button({ act: 'branch.remove', arg: b.id, variant: 'quiet', title: 'Remove this branch' }, '×'),
    })))
    : empty('No branches yet. The generic demo dies to “our situation is different”; a branch is where you answer that in their words.'));
}

/**
 * @param {any} app
 * @param {any} branch
 * @param {{unreachable: string[], noReturn: string[]}} coverage
 */
function renderBranch(app, branch, coverage) {
  const spine = app.proof.spine || [];
  const anchors = spine.filter((s) => (s.branchAnchors || []).includes(branch.id));

  return section({
    title: truncate(branch.objection, 46),
    subtitle: `Branch ${branch.id}`,
    actions: toolbar(button({ act: 'branch.addScene', arg: branch.id, variant: 'ghost' }, 'Add a scene')),
  },
  textarea({
    label: 'Objection', act: 'branch.setObjection', arg: branch.id, rows: 2,
    value: branch.objection, key: `branch-obj-${branch.id}`,
  }),

  h('div', { class: 'st-field' },
    h('span', { class: 'st-field-label' }, `Aliases · ${(branch.aliases || []).length}`),
    (branch.aliases || []).length
      ? h('ul', { class: 'st-aliases' }, branch.aliases.map((alias, i) => h('li', { class: 'st-alias', [KEY_ATTR]: `${branch.id}:${i}` },
        h('span', null, alias),
        button({ act: 'branch.removeAlias', arg: `${branch.id}:${i}`, variant: 'quiet', title: `Remove “${alias}”` }, '×'))))
      : h('p', { class: 'st-field-hint' }, 'No aliases. Add the other ways they might say it — “sign-off”, “review chain”, “legal”.'),
    h('div', { class: 'st-inline-add' },
      h('input', {
        class: 'st-input',
        type: 'text',
        placeholder: 'another phrasing',
        'aria-label': 'New alias',
        value: app.draft('branch.alias', ''),
        [ACT_ATTR]: 'branch.aliasDraft',
        [ARG_ATTR]: branch.id,
        [KEY_ATTR]: `alias-draft-${branch.id}`,
        'data-st-enter': 'branch.addAlias',
      }),
      button({ act: 'branch.addAlias', arg: branch.id, variant: 'ghost' }, 'Add alias'))),

  select({
    label: 'Return policy', act: 'branch.setReturnPolicy', arg: branch.id, value: branch.returnPolicy,
    options: [
      { value: 'anchor', label: 'Back to the scene it was offered from' },
      { value: 'nextSpineScene', label: 'Forward to the next spine scene' },
    ],
    key: `branch-return-${branch.id}`,
    hint: coverage.noReturn.includes(branch.id)
      ? 'This branch currently has no resolved return target. Anchor it to a spine scene below, or switch it to the next-spine-scene policy.'
      : 'The runtime keeps a return stack, so nested jumps unwind in order (§11).',
  }),

  h('div', { class: 'st-field' },
    h('span', { class: 'st-field-label' }, `Anchored to · ${anchors.length}`),
    spine.length
      ? h('div', { class: 'st-chips' }, spine.map((s, i) => {
        const on = (s.branchAnchors || []).includes(branch.id);
        return h('button', {
          type: 'button',
          class: cx('st-chip', on && 'st-chip--on'),
          'aria-pressed': on ? 'true' : 'false',
          title: s.headline || s.id,
          [ACT_ATTR]: 'branch.anchorTo',
          [ARG_ATTR]: `${branch.id}|${s.id}`,
          [KEY_ATTR]: `anchor-${s.id}`,
        }, h('span', { class: 'st-mono' }, String(i + 1)), truncate(s.headline || humanize(s.layout), 26));
      }))
      : h('p', { class: 'st-field-hint' }, 'The spine is empty, so there is nothing to anchor to yet.')),

  h('div', { class: 'st-field' },
    h('span', { class: 'st-field-label' }, `Scenes in this branch · ${(branch.scenes || []).length}`),
    (branch.scenes || []).length
      ? h('div', { class: 'st-rows' }, branch.scenes.map((s, i) => row({
        act: 'scene.select', arg: s.id, key: s.id,
        selected: app.ui.selection.sceneId === s.id,
        title: h('span', null,
          h('span', { class: 'st-row-index st-mono' }, String(i + 1)),
          truncate(s.headline || humanize(s.layout), 38)),
        meta: `${humanize(s.layout)} · ${plural((s.beats || []).length, 'beat')}`,
        trailing: h('div', { class: 'st-row-tools' },
          button({ act: 'scene.move', arg: `${s.id}:-1`, variant: 'quiet', title: 'Earlier', disabled: i === 0 }, '↑'),
          button({ act: 'scene.move', arg: `${s.id}:1`, variant: 'quiet', title: 'Later', disabled: i === branch.scenes.length - 1 }, '↓'),
          button({ act: 'scene.remove', arg: s.id, variant: 'quiet', title: 'Remove' }, '×')),
      })))
      : empty('This branch has no scenes. Add one — the answer to the objection is what the branch is for.')),

  pairs(
    pair('Branch id', h('code', { class: 'st-mono' }, branch.id)),
    pair('Reachable', coverage.unreachable.includes(branch.id) ? badge('no', 'bad') : badge('yes', 'ok')),
    pair('Returns to', renderReturnTarget(app, branch, coverage)),
  ));
}

/**
 * Where this branch actually lands when it exits, resolved against the live
 * deck rather than inferred from the policy. §22.4: an unwind that does not
 * resolve strands the presenter mid-pitch, and "resolved" is a weaker thing to
 * read than the name of the scene they will be standing in.
 * @param {any} app
 * @param {any} branch
 * @param {{noReturn: string[]}} coverage
 * @returns {import('../../core/vdom.js').VNode}
 */
function renderReturnTarget(app, branch, coverage) {
  if (coverage.noReturn.includes(branch.id)) return badge('nowhere — the presenter would be stranded', 'bad');
  const model = app.preview.model(app.proof);
  const target = model ? app.services.returnTargetFor(model.deck, branch.id) : null;
  if (!target) return badge('resolved', 'ok');
  const where = target.sequenceId === 'spine' ? `spine scene ${target.sceneIndex + 1}` : target.sequenceId;
  const title = target.scene ? truncate(target.scene.headline || target.scene.id, 30) : null;
  return h('span', null, title ? `${title} · ` : '', h('span', { class: 'st-mono' }, where));
}

/**
 * Test the jump index the presenter will actually type into. §11 sets the bar:
 * three characters of "approvals" lands in the approval-chain branch in under a
 * second.
 * @param {any} app
 * @param {any} deck
 */
function renderJumpTest(app, deck) {
  const query = String(app.draft('branch.jumpQuery', ''));
  const index = deck ? app.services.buildJumpIndex(deck) : null;
  const results = index && query ? app.services.searchJump(index, query) : [];

  return section({
    title: 'Jump index',
    subtitle: 'What the presenter gets when they press / and start typing.',
  },
  field({
    label: 'Try a query', act: 'branch.jumpTest', value: query,
    placeholder: 'app', key: 'jump-query',
    hint: index ? 'Fuzzy over objection text and aliases.' : 'The branch lane builds this index; it is not wired into this build.',
  }),
  query
    ? (results.length
      ? h('ol', { class: 'st-jump-results' }, results.map((r) => h('li', { class: 'st-jump-result', [KEY_ATTR]: r.branchId },
        h('button', {
          type: 'button', class: 'st-jump-btn',
          [ACT_ATTR]: 'branch.select', [ARG_ATTR]: r.branchId,
        },
        h('span', { class: 'st-jump-rank st-mono' }, Number(r.score).toFixed(2)),
        h('span', { class: 'st-jump-text' }, truncate(r.objection, 52)),
        r.matched ? h('span', { class: 'st-jump-matched' }, `matched “${r.matched}”`) : null))))
      : notice('warn', `Nothing matches “${query}”. If a client would say that, add it as an alias on the branch that answers it.`))
    : null);
}
