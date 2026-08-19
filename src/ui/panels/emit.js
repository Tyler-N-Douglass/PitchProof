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
    renderOmissions(app),
    renderOptions(app),
    renderBudget(app),
    renderResult(app));
}

/**
 * What this file will not contain, said on the screen that writes it.
 *
 * L6 holds a `media` block whose bytes were never captured out of the stream
 * rather than emitting a reference the artifact would render as a broken image
 * (its D-L6-21, for CRITIQUE-3 P6). That closed a severity-1 blocker on §6's
 * paste route and left the emit open — which is the point, and the hazard: the
 * sentence one section above this one reads "Every check has passed", and a
 * seller can read that as "and the deck is complete".
 *
 * §18's honesty laws are about the artifact, and this is the studio's half of
 * the same obligation: a proof that ships without the prospect's product
 * photograph is a proof the seller has to have decided to ship. This does not
 * block anything — nothing here lowers or raises a finding — it makes the
 * decision a decision.
 *
 * @param {any} app
 */
function renderOmissions(app) {
  const rows = (app.proof.specimens || [])
    .map((specimen) => ({ specimen, omitted: app.services.omittedMedia(specimen) || [] }))
    .filter((row) => row.omitted.length);
  if (!rows.length) return null;
  const total = rows.reduce((n, row) => n + row.omitted.length, 0);
  return section({
    title: `Images this file will not contain · ${total}`,
    subtitle: 'Not a blocker, and not an oversight either: the capture could not bring these, so the deck goes without them unless you supply the files.',
    actions: toolbar(button({ act: 'app.section', arg: 'specimens', variant: 'ghost' }, 'Go to Specimens')),
  },
  notice('warn', `${plural(total, 'image')} referenced by ${plural(rows.length, 'specimen')} ${total === 1 ? 'has no file behind it' : 'have no file behind them'}. The artifact will render the words around ${total === 1 ? 'it' : 'them'} and say nothing about ${total === 1 ? 'it' : 'them'} on stage — a client looking at the page they wrote will see their own ${total === 1 ? 'picture' : 'pictures'} missing. Specimens → “Images this capture could not bring” takes a file for each.`),
  h('ul', { class: 'st-blockers' }, rows.map((row) => h('li', {
    class: 'st-blocker', [KEY_ATTR]: row.specimen.id,
  },
  h('span', { class: 'st-blocker-code st-mono' }, String(row.omitted.length)),
  h('span', { class: 'st-blocker-message' },
    `${truncate(row.specimen.title, 48)} — ${row.omitted.map((e) => e.ref).slice(0, 3).join(', ')}${row.omitted.length > 3 ? `, and ${row.omitted.length - 3} more` : ''}`)))));
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

/**
 * The independent verification, when it has been run. §18.4 says the no-network
 * law is "verified at emit, not asserted in a README" — this is the same scan,
 * re-run on demand over the file itself, for the moment somebody in the room
 * asks how you know.
 * @param {any} app
 * @returns {import('../../core/vdom.js').VNode}
 */
function renderVerification(app) {
  const report = app.draft('emit.verify', null);
  if (!report) return null;
  return h('div', { class: 'st-subsection' },
    h('h4', { class: 'st-subsection-title' }, 'Independent verification'),
    report.clean
      ? notice('ok', 'The network scanner found nothing to fetch, and every illustrative rendition carries a label the stylesheet cannot hide. Scanned over the emitted bytes, not over the model they came from.')
      : notice('bad', h('div', null,
        h('p', null, 'The emitted file violates a product law. Do not send it — and tell the integrator, because the emitter should have refused it.'),
        h('ul', { class: 'st-paths' }, report.findings.map((f, i) => h('li', { [KEY_ATTR]: `${f.code}:${i}` }, `${f.code}: ${f.message}`))))),
    pairs(
      pair('Network references', report.network.length ? badge(String(report.network.length), 'bad') : badge('none', 'ok')),
      pair('Provenance', report.provenance.length ? badge(String(report.provenance.length), 'bad') : badge('every label present', 'ok')),
    ));
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
    actions: toolbar(
      button({ act: 'emit.verify', variant: 'ghost', title: 'Re-run the network scan and the provenance assertion over these exact bytes' }, 'Verify'),
      button({ act: 'emit.download', variant: 'primary', disabled: blocking.length > 0 }, 'Save the file'),
    ),
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
  renderVerification(app),
  (result.degradations || []).length
    ? h('p', { class: 'st-note' }, `${plural(result.degradations.length, 'asset')} were degraded to fit the budget. Every one is listed above with the bytes it actually saved.`)
    : h('p', { class: 'st-note' }, 'Nothing was degraded: the project fitted its budget as captured.'));
}
