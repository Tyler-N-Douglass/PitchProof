/**
 * The Emit panel (§13, §14).
 *
 * Three things this panel does and one it deliberately does not.
 *
 * It shows the **options**, the **size budget with every degradation as a line
 * item** — §13 says report exactly what was degraded and by how much, never
 * silently — and the **preflight result**, with the emit itself at the end.
 *
 * What it does not have is an override. §14: "Severity 1 findings block emit.
 * There is no override flag." So the button is disabled, the reasons are listed
 * in full with a route to each one, and there is no control anywhere on this
 * page, or behind a modifier, or in the palette, that emits anyway.
 * `test/ui/no-override.test.mjs` asserts that mechanically.
 *
 * @module ui/panels/emit
 */

import { h, cx } from '../../core/vdom.js';
import {
  badge, button, checkbox, empty, field, notice, pair, pairs, section, segmented, toolbar,
} from '../components.js';
import { formatBytes, formatDateTime, formatPercent, plural, truncate } from '../format.js';
import { emitBlockers } from '../gate.js';
import { SECTIONS } from '../constants.js';
import { QUALITY_STEPS } from '../../core/contracts.js';
import { ACT_ATTR, ARG_ATTR, KEY_ATTR } from '../render.js';

/**
 * @param {any} app
 * @returns {import('../../core/vdom.js').VNode}
 */
export function renderEmitPanel(app) {
  const gate = emitBlockers(app);
  return h('div', { class: 'st-panel' },
    renderGate(app, gate),
    renderOptions(app),
    renderBudget(app),
    renderResult(app));
}

/**
 * @param {any} app
 * @param {{blockers: any[], canEmit: boolean}} gate
 */
function renderGate(app, gate) {
  return section({
    title: gate.canEmit ? 'Ready' : 'Blocked',
    subtitle: gate.canEmit
      ? 'Nothing stands between this proof and a file.'
      : `${plural(gate.blockers.length, 'thing')} must be fixed first. There is no override.`,
    actions: toolbar(
      button({
        act: 'emit.run',
        variant: gate.canEmit ? 'primary' : 'ghost',
        disabled: !gate.canEmit || app.ui.emit.running,
        keyHint: 'Ctrl ↵',
        title: gate.canEmit ? 'Write the single-file artifact' : gate.blockers[0].message,
      }, app.ui.emit.running ? 'Emitting…' : 'Emit the proof'),
    ),
  },
  gate.canEmit
    ? notice('ok', 'Every check has passed. Open the emitted file with networking disabled before you rely on it — that is the only test that counts.')
    : h('div', null,
      notice('bad', 'A severity-1 finding blocks the emit. This is a product law, not a setting: there is no override control in this studio, and the emitter refuses independently of anything this panel does.'),
      h('ul', { class: 'st-blockers' }, gate.blockers.map((b, i) => h('li', {
        class: 'st-blocker', [KEY_ATTR]: `${b.kind}:${i}`,
      },
      h('span', { class: 'st-blocker-code st-mono' }, b.kind),
      h('span', { class: 'st-blocker-message' }, b.message),
      b.where
        ? h('button', {
          type: 'button', class: 'st-blocker-go',
          [ACT_ATTR]: 'app.section', [ARG_ATTR]: b.where,
        }, `Go to ${sectionLabel(b.where)}`)
        : null)))));
}

/** @param {string} id @returns {string} */
function sectionLabel(id) {
  const found = SECTIONS.find((s) => s.id === id);
  return found ? found.label : id;
}

/** @param {any} app */
function renderOptions(app) {
  const options = app.proof.emitOptions;
  const reviewReachable = options.mode === 'review' || options.mode === 'both';
  return section({
    title: 'Options',
    subtitle: 'What kind of file this is, and what it is allowed to weigh.',
  },
  segmented({
    label: 'Mode', act: 'emit.setMode', value: options.mode,
    options: [
      { value: 'presenter', label: 'Presenter' },
      { value: 'review', label: 'Review' },
      { value: 'both', label: 'Both' },
    ],
    hint: 'Presenter carries notes and the second-screen view. Review adds a contents index and drops the notes. Both detects which it is being opened as (§2).',
  }),
  checkbox({
    label: 'Include presenter notes',
    act: 'emit.setNotes',
    checked: !!options.includePresenterNotes,
    disabled: options.mode === 'review',
    hint: options.mode === 'review'
      ? 'A Review build carries no notes at all — there is no second path to them.'
      : 'Notes appear only in the presenter window, never on the stage.',
  }),
  h('div', { class: 'st-field', role: 'group', 'aria-label': 'Image quality' },
    h('span', { class: 'st-field-label' }, 'Image quality'),
    h('div', { class: 'st-segmented' }, QUALITY_STEPS.map((q) => button({
      act: 'emit.setQuality', arg: String(q), className: 'st-segment',
      variant: options.imageQuality === q ? 'primary' : 'ghost',
      pressed: options.imageQuality === q ? 'true' : 'false',
    }, String(q)))),
    h('span', { class: 'st-field-hint' }, 'Applied when media is re-encoded to fit the budget. Lower steps are what re-compression walks down.')),
  field({
    label: 'Size budget (MB)', act: 'emit.setMaxBytes', type: 'number',
    value: String(Math.round(options.maxBytes / 1000000)),
    key: 'emit-maxbytes',
    hint: 'A 60 MB artifact that takes eleven seconds to open is a failed artifact (§22.5). 25 MB is the default for a reason.',
  }),
  notice('info', h('div', null,
    h('p', null, 'Illustrative content is always labelled, and the label cannot be styled to invisibility. The emitter enforces it, not this panel.'),
    reviewReachable
      ? h('p', null, 'This build is openable in Review mode, so labelling cannot be disabled at all (§9).')
      : null)));
}

/** @param {any} app */
function renderBudget(app) {
  const options = app.proof.emitOptions;
  const plan = app.draft('emit.plan', null) || (app.ui.emit.result ? app.ui.emit.result.degradations : null);
  const estimate = estimateBytes(app.proof);
  const over = estimate - options.maxBytes;

  return section({
    title: 'Size budget',
    subtitle: '§13: every degradation is a line item, with predicted and actual bytes. Never silent.',
    actions: toolbar(button({ act: 'emit.budget', variant: 'ghost' }, 'Recompute')),
  },
  pairs(
    pair('Media in the project', h('span', { class: 'st-mono' }, formatBytes(estimate))),
    pair('Budget', h('span', { class: 'st-mono' }, formatBytes(options.maxBytes))),
    pair('Headroom', h('span', { class: cx('st-mono', over > 0 && 'st-bad') },
      over > 0 ? `${formatBytes(over)} over` : `${formatBytes(-over)} spare`)),
  ),
  plan && plan.length
    ? h('table', { class: 'st-table st-table--budget' },
      h('thead', null, h('tr', null,
        h('th', null, 'Rank'),
        h('th', null, 'Asset'),
        h('th', null, 'From'),
        h('th', null, 'To'),
        h('th', null, 'Predicted'),
        h('th', null, 'Actual'),
        h('th', null, 'Why'))),
      h('tbody', null, plan.map((line, i) => h('tr', { class: 'st-tr', [KEY_ATTR]: `${line.assetId}:${i}` },
        h('td', { class: 'st-mono' }, String(line.rank)),
        h('td', { class: 'st-mono' }, truncate(line.assetId, 16)),
        h('td', { class: 'st-mono' }, sizeOf(line.from)),
        h('td', { class: 'st-mono' }, sizeOf(line.to)),
        h('td', { class: 'st-mono' }, formatBytes(line.predictedBytes)),
        h('td', {
          class: cx('st-mono', line.actualBytes !== undefined && Math.abs(line.actualBytes - line.predictedBytes) > line.predictedBytes * 0.1 && 'st-warn'),
        }, line.actualBytes === undefined ? '—' : formatBytes(line.actualBytes)),
        h('td', null, line.reason)))))
    : plan
      ? notice('ok', 'Nothing needs degrading: the project fits its budget as captured.')
      : empty('The budget has not been computed yet.', button({ act: 'emit.budget', variant: 'primary' }, 'Compute it')));
}

/** @param {{w?: number, h?: number, quality?: number}} box @returns {string} */
function sizeOf(box) {
  if (!box) return '—';
  return `${box.w ?? '?'}×${box.h ?? '?'} q${box.quality ?? '?'}`;
}

/** @param {any} proof @returns {number} */
function estimateBytes(proof) {
  let n = 0;
  for (const s of proof.specimens || []) for (const m of s.media || []) n += m.bytes || 0;
  for (const r of proof.renditions || []) for (const m of r.media || []) n += m.bytes || 0;
  for (const l of (proof.brand && proof.brand.logos) || []) n += (l.data || '').length;
  return n;
}

/** @param {any} app */
function renderResult(app) {
  const state = app.ui.emit;
  if (state.error) {
    return section({ title: 'Last emit', subtitle: 'It did not produce a file.' }, notice('bad', state.error));
  }
  if (!state.result) {
    return section({
      title: 'The file',
      subtitle: 'One `.html`, everything inline, opens from a USB stick with no network.',
    }, empty('Nothing has been emitted from this proof yet.'));
  }
  const result = state.result;
  const blocking = (result.findings || []).filter((f) => f.severity === 1);
  return section({
    title: 'The file',
    subtitle: `Emitted ${formatDateTime(state.at)}.`,
    actions: toolbar(button({
      act: 'emit.download', variant: 'primary', disabled: blocking.length > 0,
    }, 'Save the file')),
  },
  blocking.length
    ? notice('bad', h('div', null,
      h('p', null, 'The emitter refused this proof, which is the enforcement that matters — the studio’s gate is the courtesy in front of it.'),
      h('ul', { class: 'st-paths' }, blocking.map((f) => h('li', { [KEY_ATTR]: f.id }, `${f.code}: ${f.message}`)))))
    : notice('ok', 'The file is ready. Open it with networking disabled, walk it end to end on the keyboard, then hand it over.'),
  pairs(
    pair('Size', h('span', { class: 'st-mono' }, formatBytes(result.bytes))),
    pair('Model payload', h('span', { class: 'st-mono' },
      result.compression ? `${result.compression.mode} · ${formatBytes(result.compression.modelBytes)}` : '—')),
    pair('Media payload', h('span', { class: 'st-mono' },
      result.compression ? formatBytes(result.compression.mediaBytes) : '—')),
    pair('Budget used', h('span', { class: 'st-mono' },
      formatPercent(result.bytes / (app.proof.emitOptions.maxBytes || 1), 1))),
    pair('Findings', h('span', null,
      badge(`${(result.findings || []).length} total`, 'dim'),
      blocking.length ? badge(`${blocking.length} blocking`, 'bad') : badge('none blocking', 'ok'))),
  ),
  (result.degradations || []).length
    ? h('p', { class: 'st-note' }, `${plural(result.degradations.length, 'asset')} were degraded to fit the budget. Every one is listed above with the bytes it actually saved.`)
    : h('p', { class: 'st-note' }, 'Nothing was degraded: the project fitted its budget as captured.'));
}
