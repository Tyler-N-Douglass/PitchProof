/**
 * The Rehearse panel (§14).
 *
 * §14 insists rehearsal is "a first-class mode, not a lint pass", and this panel
 * is built to that: the sweep, the findings grouped by severity with the locus
 * clickable so a finding is one keystroke from the thing that caused it, the
 * auto-fixes that are safe and reversible — logged in the undo history like any
 * other edit — and the dry run, which walks the whole deck with a heads-up issue
 * counter so the last pass before walking in is a real rehearsal that also
 * validates.
 *
 * Severity is what L11 says it is. Nothing here lowers one, and there is no
 * control that dismisses a finding: the only way past a severity-1 is to fix it.
 *
 * @module ui/panels/rehearse
 */

import { h, cx } from '../../core/vdom.js';
import {
  badge, button, empty, notice, pair, pairs, section, toolbar,
} from '../components.js';
import { formatDateTime, plural, severityLabel, severityMeaning, truncate } from '../format.js';
import { deckPositions, deckScenes, findScene } from '../model.js';
import { emitBlockers } from '../gate.js';
import { ACT_ATTR, ARG_ATTR, KEY_ATTR } from '../render.js';

/**
 * @param {any} app
 * @returns {import('../../core/vdom.js').VNode}
 */
export function renderRehearsePanel(app) {
  const sweep = app.ui.sweep;
  const findings = sweep.findings || [];
  const bySeverity = [1, 2, 3].map((severity) => ({
    severity,
    items: findings.filter((f) => f.severity === severity),
  }));
  const fixes = app.services.autoFixes(app.proof, findings);
  // One gate reading for the whole panel: `emitBlockers` digests the proof, and
  // the status bar is already paying for that once per render.
  const gate = emitBlockers(app);

  return h('div', { class: 'st-panel' },
    renderSweepHeader(app, sweep, findings),
    renderDryRun(app),
    ...bySeverity.map((group) => renderSeverityGroup(app, group, fixes, gate)),
    renderFixLog(app));
}

/**
 * @param {any} app
 * @param {any} sweep
 * @param {any[]} findings
 */
function renderSweepHeader(app, sweep, findings) {
  const blocking = findings.filter((f) => f.severity === 1).length;
  // CRITIQUE-2 C11: a sweep that walked nothing is not clean, it is vacuous, and
  // this panel already holds the count. "Sweep clean" over "Scenes walked 0" was
  // printed on the one screen §14 calls "the last pass before you walk in".
  const vacuous = deckPositions(app.proof) === 0;
  return section({
    title: 'Automated sweep',
    subtitle: 'Every scene, every beat, every branch, at all three breakpoints, after the brand’s type substitution (§14).',
    actions: toolbar(
      button({
        act: 'rehearse.sweep', variant: 'primary',
        disabled: sweep.running,
        keyHint: 'Alt R',
      }, sweep.running ? 'Sweeping…' : 'Run the sweep'),
      button({ act: 'rehearse.dryRun', variant: 'ghost', keyHint: 'Alt D' },
        app.ui.dryRun.active ? 'End the dry run' : 'Dry run'),
    ),
  },
  sweep.error
    ? notice('bad', sweep.error)
    : sweep.at
      ? notice(blocking ? 'bad' : vacuous ? 'warn' : 'ok', h('div', null,
        h('p', null, blocking
          ? `${plural(blocking, 'blocking finding')}. The emit is closed until every one is gone — there is no override, here or anywhere.`
          : vacuous
            ? 'Nothing was raised, and nothing was walked: this proof has no scenes yet, so the checks §14 leans on hardest — text overflow after the type substitution, and contrast, at all three breakpoints — had nothing to measure. Add a scene and sweep again.'
            : 'No blocking findings. The emit is open once nothing else is outstanding.'),
        h('p', { class: 'st-dim' }, `Swept ${formatDateTime(sweep.at)} · ${plural(findings.length, 'finding')} total.`)))
      : notice('info', 'No sweep has been run against this proof yet. The emit stays closed until one has been.'),
  pairs(
    pair('Scenes walked', h('span', { class: 'st-mono' }, String(deckScenes(app.proof)))),
    pair('Beat positions walked', h('span', { class: 'st-mono' }, String(deckPositions(app.proof)))),
    pair('Breakpoints', h('span', { class: 'st-mono' }, 'sm 390 · md 1024 · lg 1600')),
  ),
  app.services.has('validate') ? null : notice('warn', 'The validation lane is not wired into this build. Until it lands, no sweep can run — and a proof that was never validated is not emitted.'),
  sweep.at ? null : renderRules(app));
}

/**
 * What a sweep checks. Shown before the first one has run, because "no sweep
 * has been run" tells a user nothing about what running one would buy them.
 * @param {any} app
 * @returns {import('../../core/vdom.js').VNode}
 */
function renderRules(app) {
  const rules = app.services.preflightRules();
  if (!rules.length) return null;
  const bySeverity = [1, 2, 3].map((severity) => rules.filter((r) => r.severity === severity));
  return h('details', { class: 'st-details' },
    h('summary', null, `What a sweep checks · ${rules.length} rules, ${bySeverity[0].length} of them blocking`),
    h('ul', { class: 'st-rules' }, rules.map((rule) => h('li', { class: 'st-rule', [KEY_ATTR]: rule.code },
      badge(rule.code, rule.severity === 1 ? 'bad' : rule.severity === 2 ? 'warn' : 'dim'),
      rule.describe ? h('span', { class: 'st-rule-describe' }, rule.describe) : null))));
}


/**
 * §14's dry-run mode: the full deck with a heads-up issue counter.
 * @param {any} app
 */
function renderDryRun(app) {
  const dry = app.ui.dryRun;
  if (!dry.active) return null;
  const at = dry.positions[dry.index] || {};
  const scene = at.sceneId ? findScene(app.proof, at.sceneId) : null;
  const here = (dry.findings || []).filter((f) => f.locus && f.locus.sceneId === at.sceneId);
  return section({
    title: 'Dry run',
    subtitle: 'The deck as you will present it, with what is still wrong in the corner of your eye.',
    actions: toolbar(
      button({ act: 'rehearse.dryRunStep', arg: '-1', variant: 'ghost' }, 'Back'),
      button({ act: 'rehearse.dryRunStep', arg: '1', variant: 'primary' }, 'Next'),
      button({ act: 'rehearse.dryRunStop', variant: 'quiet' }, 'End'),
    ),
  },
  pairs(
    pair('Position', h('span', { class: 'st-mono' }, `${dry.index + 1} / ${dry.positions.length}`)),
    pair('Scene', scene ? truncate(scene.scene.headline || scene.scene.id, 40) : '—'),
    pair('Sequence', h('span', { class: 'st-mono' }, at.sequenceId || 'spine')),
    pair('Issues on this scene', here.length ? badge(String(here.length), 'bad') : badge('none', 'ok')),
  ),
  here.length
    ? h('ul', { class: 'st-findings' }, here.map((f) => renderFinding(app, f, [])))
    : null);
}

/**
 * @param {any} app
 * @param {{severity: number, items: any[]}} group
 * @param {any[]} fixes
 * @param {{blockers: any[], canEmit: boolean}} gate
 */
function renderSeverityGroup(app, group, fixes, gate) {
  const severity = /** @type {1|2|3} */ (group.severity);
  if (!group.items.length && !app.ui.sweep.at) return null;
  return section({
    title: `${severityLabel(severity)} · ${group.items.length}`,
    subtitle: severityMeaning(severity),
  },
  group.items.length
    ? h('ul', { class: cx('st-findings', `st-findings--s${severity}`) },
      group.items.map((f) => renderFinding(app, f, fixes)))
    : h('p', { class: 'st-field-hint' }, severity === 1
      ? blockingNothingText(gate)
      : `No ${severityLabel(severity).toLowerCase()} findings.`));
}

/**
 * What to say when the sweep raised no severity-1 finding.
 *
 * "Nothing blocks the emit" is a claim about the *gate*, and a finding list is
 * only one of the gate's inputs. With zero scenes it was printed beside a status
 * bar reading "This proof has no spine. Add at least one scene before emitting"
 * — two sentences about one question, disagreeing, on the same screen
 * (CRITIQUE-2 C11). So the sentence is now taken from the gate itself: it says
 * "nothing blocks the emit" exactly when nothing does, and otherwise says which
 * blocker is still standing, in the gate's own words.
 * @param {{blockers: any[], canEmit: boolean}} gate
 * @returns {string}
 */
function blockingNothingText(gate) {
  if (gate.canEmit) return 'Nothing blocks the emit.';
  const others = gate.blockers.filter((b) => b.kind !== 'NO_PREFLIGHT' && b.kind !== 'STALE_PREFLIGHT');
  const first = others[0] || gate.blockers[0];
  return others.length > 1
    ? `The sweep raised no blocking finding, but ${others.length} other things close the emit. The first: ${first.message}`
    : `The sweep raised no blocking finding. The emit is still closed: ${first.message}`;
}

/**
 * @param {any} app
 * @param {any} finding
 * @param {any[]} fixes
 */
function renderFinding(app, finding, fixes) {
  const fixIndex = fixes.findIndex((fx) => fx.finding && fx.finding.id === finding.id);
  const locus = finding.locus || {};
  const where = locus.sceneId || locus.branchId || locus.specimenId || locus.assetId || null;
  return h('li', { class: cx('st-finding', `st-finding--s${finding.severity}`), [KEY_ATTR]: finding.id },
    h('div', { class: 'st-finding-head' },
      badge(finding.code, finding.severity === 1 ? 'bad' : finding.severity === 2 ? 'warn' : 'dim'),
      h('span', { class: 'st-finding-message' }, finding.message),
      where
        ? h('button', {
          type: 'button', class: 'st-finding-locus st-mono',
          [ACT_ATTR]: 'rehearse.goToLocus', [ARG_ATTR]: finding.id,
          title: 'Jump to what raised this',
        }, truncate(where, 22))
        : null),
    finding.autoFixAvailable && fixIndex >= 0
      ? h('div', { class: 'st-finding-fix' },
        button({ act: 'rehearse.autoFix', arg: String(fixIndex), variant: 'ghost' }, `Auto-fix: ${fixes[fixIndex].label}`),
        h('span', { class: 'st-field-hint' }, 'Applied through the command stack, so one undo takes it back.'))
      : finding.autoFixAvailable
        ? h('p', { class: 'st-field-hint' }, 'An auto-fix exists for this code but is not offered for this instance. Re-run the sweep after any edit.')
        : null);
}

/**
 * §14: "Every auto-fix is logged and undoable." The log is the undo history —
 * this is the view of it filtered to fixes, so the record and the undo are the
 * same thing rather than two things that can disagree.
 * @param {any} app
 */
function renderFixLog(app) {
  const entries = app.stack.history().filter((e) => e.meta && /** @type {any} */ (e.meta).autoFix);
  return section({
    title: 'Auto-fixes applied',
    subtitle: 'The log is the undo stack, so nothing can be recorded here that cannot be taken back.',
    actions: entries.length ? toolbar(button({ act: 'rehearse.revertFixes', variant: 'ghost' }, 'Undo every auto-fix')) : null,
  },
  entries.length
    ? h('ol', { class: 'st-fixlog' }, entries.map((e) => h('li', { class: 'st-fixlog-item', [KEY_ATTR]: String(e.seq) },
      h('span', { class: 'st-mono' }, String(e.seq)),
      h('span', null, e.label),
      /** @type {any} */ (e.meta).code ? badge(/** @type {any} */ (e.meta).code, 'dim') : null)))
    : empty('No auto-fixes have been applied.'));
}
