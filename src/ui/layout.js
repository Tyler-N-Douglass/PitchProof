/**
 * The studio shell: the rail, the canvas, the inspector and the chrome around
 * them (§15).
 *
 * The arrangement is the one §15 fixes — left rail in flow order, centre canvas
 * carrying the live preview at true aspect, right inspector for whatever is
 * selected — with three additions that §20.10 forces rather than decorates:
 *
 *   - a status bar that always says whether the work is saved, how full local
 *     storage is, and what is currently standing between this proof and an
 *     emitted file;
 *   - a command palette, so every action has a keyboard route even when it has
 *     no accelerator of its own;
 *   - a keyboard reference generated from the same bindings the router reads.
 *
 * Everything here is `--st-*`. The artifact's `--pp-*` namespace does not appear
 * in this file or in any other file under `src/ui/**`, and
 * `test/ui/theme-isolation.test.mjs` asserts it (D11).
 *
 * @module ui/layout
 */

import { h, cx } from '../core/vdom.js';
import { badge, button, meter } from './components.js';
import { PREVIEW_BREAKPOINTS, SECTIONS, WIDE_SECTIONS } from './constants.js';
import { formatBytes, formatDateTime, plural, truncate } from './format.js';
import { keyLabel, MOD_NOTE, bindingGroups } from './keys.js';
import { gateSummary } from './gate.js';
import { renderPanel } from './panels/index.js';
import { renderInspector } from './inspector.js';
import { routeOf } from './actions.js';
import { ACT_ATTR, ARG_ATTR, EVENT_ATTR, KEY_ATTR, PRESERVE_ATTR } from './render.js';

/**
 * The whole studio.
 * @param {any} app
 * @returns {import('../core/vdom.js').VNode}
 */
export function renderStudio(app) {
  const wide = WIDE_SECTIONS.has(app.ui.section);
  return h('div', {
    class: cx('st-app', wide && 'st-app--wide', app.ui.layout === 'focus' && 'st-app--focus',
      !app.ui.inspectorOpen && 'st-app--no-inspector'),
    'data-st-section': app.ui.section,
  },
  renderTopBar(app),
  h('div', { class: 'st-body' },
    renderRail(app),
    h('main', { class: 'st-work', id: 'st-work', 'aria-label': sectionLabel(app.ui.section) },
      renderNotices(app),
      renderPanel(app)),
    app.ui.layout === 'split' ? renderCanvas(app) : null,
    app.ui.inspectorOpen ? renderInspector(app) : null),
  renderStatusBar(app),
  app.ui.historyOpen ? renderHistory(app) : null,
  app.ui.keysOpen ? renderKeyboard(app) : null,
  app.ui.paletteOpen ? renderPalette(app) : null);
}

/** @param {string} id @returns {string} */
function sectionLabel(id) {
  const found = SECTIONS.find((s) => s.id === id);
  return found ? found.label : id;
}

// ---------------------------------------------------------------------------
// Top bar
// ---------------------------------------------------------------------------

/**
 * @param {any} app
 * @returns {import('../core/vdom.js').VNode}
 */
export function renderTopBar(app) {
  const doc = app.doc;
  const save = app.ui.save;
  const saveTone = save.status === 'error' ? 'bad' : save.status === 'saved' ? 'ok' : 'dim';
  const saveText = save.status === 'error' ? 'Save failed'
    : save.status === 'saving' ? 'Saving…'
      : save.status === 'pending' ? 'Unsaved changes'
        : save.at ? `Saved ${formatDateTime(save.at)}` : 'Not saved yet';
  return h('header', { class: 'st-topbar' },
    h('div', { class: 'st-brand' },
      h('span', { class: 'st-brand-mark', 'aria-hidden': 'true' }, '◆'),
      h('span', { class: 'st-brand-name' }, 'PitchProof'),
      h('span', { class: 'st-brand-sub' }, 'studio')),
    h('div', { class: 'st-topbar-doc' },
      h('span', { class: 'st-topbar-title' }, truncate(doc.name, 48)),
      doc.proof.prospectName
        ? h('span', { class: 'st-topbar-prospect' }, `for ${truncate(doc.proof.prospectName, 40)}`)
        : h('span', { class: 'st-topbar-prospect st-topbar-prospect--empty' }, 'no prospect named yet')),
    h('div', { class: 'st-topbar-actions' },
      badge(saveText, saveTone),
      button({ act: 'app.undo', variant: 'ghost', disabled: !app.stack.canUndo, title: app.stack.undoLabel ? `Undo ${app.stack.undoLabel}` : 'Nothing to undo', keyHint: 'Ctrl Z' }, 'Undo'),
      button({ act: 'app.redo', variant: 'ghost', disabled: !app.stack.canRedo, title: app.stack.redoLabel ? `Redo ${app.stack.redoLabel}` : 'Nothing to redo' }, 'Redo'),
      button({ act: 'app.history', variant: 'ghost', pressed: app.ui.historyOpen ? 'true' : 'false' }, 'History'),
      button({ act: 'app.palette', variant: 'primary', keyHint: 'Ctrl K' }, 'Commands')));
}

// ---------------------------------------------------------------------------
// Rail
// ---------------------------------------------------------------------------

/**
 * The left rail. Each entry carries the count of what it holds, so the flow
 * reads as progress rather than as a menu.
 * @param {any} app
 * @returns {import('../core/vdom.js').VNode}
 */
export function renderRail(app) {
  const counts = railCounts(app);
  return h('nav', { class: 'st-rail', 'aria-label': 'Studio sections' },
    h('ol', { class: 'st-rail-list' }, SECTIONS.map((section, i) => {
      const active = app.ui.section === section.id;
      const info = counts[section.id];
      return h('li', { class: 'st-rail-item', [KEY_ATTR]: section.id },
        h('button', {
          type: 'button',
          class: cx('st-rail-btn', active && 'st-rail-btn--active', info && info.tone && `st-rail-btn--${info.tone}`),
          [ACT_ATTR]: 'app.section',
          [ARG_ATTR]: section.id,
          'aria-current': active ? 'page' : null,
          title: `${section.hint} (Alt ${i < 8 ? i + 1 : 9})`,
        },
        h('span', { class: 'st-rail-step st-mono' }, section.step),
        h('span', { class: 'st-rail-body' },
          h('span', { class: 'st-rail-label' }, section.label),
          h('span', { class: 'st-rail-hint' }, section.hint)),
        info && info.text ? h('span', { class: cx('st-rail-count', 'st-mono', info.tone && `st-rail-count--${info.tone}`) }, info.text) : null));
    })));
}

/**
 * @param {any} app
 * @returns {Record<string, {text: string, tone?: string}>}
 */
function railCounts(app) {
  const proof = app.proof;
  const blocking = (app.ui.sweep.findings || []).filter((f) => f.severity === 1).length;
  const gate = gateSummary(app);
  return {
    project: { text: app.ui.projects.length ? String(app.ui.projects.length) : '' },
    brand: {
      text: proof.brand && proof.brand.colors ? String(proof.brand.colors.length) : '0',
      tone: brandNeedsReview(proof) ? 'warn' : undefined,
    },
    specimens: { text: String((proof.specimens || []).length), tone: (proof.specimens || []).length ? undefined : 'dim' },
    recipes: { text: String((proof.renditions || []).length) },
    scenes: { text: String((proof.spine || []).length), tone: (proof.spine || []).length ? undefined : 'dim' },
    branches: {
      text: String((proof.branches || []).length),
      tone: (proof.branches || []).length >= 3 ? 'ok' : 'warn',
    },
    rehearse: {
      text: app.ui.sweep.at ? String((app.ui.sweep.findings || []).length) : '—',
      tone: blocking ? 'bad' : app.ui.sweep.at ? 'ok' : undefined,
    },
    emit: { text: gate.tone === 'ok' ? '✓' : '×', tone: gate.tone },
    settings: { text: '' },
  };
}

/** @param {any} proof @returns {boolean} */
function brandNeedsReview(proof) {
  const conf = proof.brand ? proof.brand.confidence || {} : {};
  const reviewed = new Set(Array.isArray(/** @type {any} */ (proof.brand || {}).reviewedGroups) ? /** @type {any} */ (proof.brand).reviewedGroups : []);
  return ['colors', 'faces', 'logos', 'shape', 'imagery'].some((g) => (conf[g] || 0) < 0.7 && !reviewed.has(g));
}

// ---------------------------------------------------------------------------
// Canvas
// ---------------------------------------------------------------------------

/**
 * The centre canvas: the live preview, at the exact pixel size of the chosen
 * breakpoint, scaled to fit. The frame's contents belong to `RuntimeHost`, so
 * the element carries `data-st-preserve` and the patcher never enters it.
 * @param {any} app
 * @returns {import('../core/vdom.js').VNode}
 */
export function renderCanvas(app) {
  const runtime = app.preview.runtime;
  const scene = runtime ? runtime.scene : null;
  const progress = runtime ? runtime.progress() : null;
  const spine = app.proof.spine || [];
  const dry = app.ui.dryRun;

  return h('section', { class: 'st-canvas', 'aria-label': 'Live preview' },
    h('div', { class: 'st-canvas-bar' },
      h('div', { class: 'st-canvas-where' },
        scene
          ? h('span', { class: 'st-canvas-scene' }, truncate(scene.headline || scene.id, 46))
          : h('span', { class: 'st-canvas-scene st-canvas-scene--empty' }, 'Nothing staged yet'),
        progress
          ? h('span', { class: 'st-canvas-progress st-mono' }, `scene ${progress.scene}/${progress.sceneCount} · beat ${progress.beat}/${progress.beatCount}`)
          : null),
      h('div', { class: 'st-canvas-tools' },
        h('div', { class: 'st-segmented', role: 'group', 'aria-label': 'Preview width' },
          PREVIEW_BREAKPOINTS.map((b) => button({
            act: 'app.breakpoint', arg: b.value, className: 'st-segment',
            variant: app.ui.breakpoint === b.value ? 'primary' : 'ghost',
            pressed: app.ui.breakpoint === b.value ? 'true' : 'false',
          }, b.label))),
        button({ act: 'app.preview.prevBeat', variant: 'ghost', title: 'Previous beat (Alt ←)' }, '‹ Beat'),
        button({ act: 'app.preview.nextBeat', variant: 'ghost', title: 'Next beat (Alt →)' }, 'Beat ›'),
        button({ act: 'app.preview.focus', variant: 'ghost', title: 'Give the preview the keyboard (Alt Enter)' }, 'Drive'),
        button({ act: 'app.preview', variant: 'ghost', title: 'Hide the preview (Alt P)' }, 'Hide'))),
    dry.active ? renderDryRunBar(app) : null,
    h('div', { class: 'st-canvas-stage' },
      h('div', {
        class: 'st-preview-host',
        'data-st-preview-host': 'true',
        [PRESERVE_ATTR]: 'preview',
      }),
      spine.length ? null : h('div', { class: 'st-canvas-empty' },
        h('p', null, 'The spine is empty. Add a scene and it appears here, at the size it will be presented.'),
        button({ act: 'app.section.scenes', variant: 'primary' }, 'Go to Scenes')),
      app.preview.degraded ? h('p', { class: 'st-canvas-degraded' }, app.preview.degraded) : null));
}

/**
 * §14's dry run: the full deck with a heads-up issue counter.
 * @param {any} app
 * @returns {import('../core/vdom.js').VNode}
 */
export function renderDryRunBar(app) {
  const dry = app.ui.dryRun;
  const at = dry.positions[dry.index] || {};
  const here = (dry.findings || []).filter((f) => f.locus && f.locus.sceneId && f.locus.sceneId === at.sceneId);
  const blocking = (dry.findings || []).filter((f) => f.severity === 1).length;
  return h('div', { class: cx('st-dryrun', blocking && 'st-dryrun--blocking'), role: 'status' },
    h('span', { class: 'st-dryrun-label' }, 'Dry run'),
    h('span', { class: 'st-dryrun-pos st-mono' }, `${dry.index + 1} / ${dry.positions.length}`),
    h('span', { class: 'st-dryrun-count' },
      blocking
        ? `${plural(blocking, 'blocking finding')} across the deck`
        : `${plural((dry.findings || []).length, 'finding')} across the deck`),
    here.length ? h('span', { class: 'st-dryrun-here' }, `${plural(here.length, 'issue')} on this scene`) : null,
    h('div', { class: 'st-dryrun-controls' },
      button({ act: 'rehearse.dryRunStep', arg: '-1', variant: 'ghost' }, 'Back'),
      button({ act: 'rehearse.dryRunStep', arg: '1', variant: 'primary' }, 'Next'),
      button({ act: 'rehearse.dryRunStop', variant: 'ghost' }, 'End')));
}

// ---------------------------------------------------------------------------
// Notices and status
// ---------------------------------------------------------------------------

/**
 * @param {any} app
 * @returns {import('../core/vdom.js').VNode}
 */
export function renderNotices(app) {
  if (!app.ui.notices.length) return null;
  return h('div', { class: 'st-notices', 'aria-live': 'polite' }, app.ui.notices.map((n) => h('div', {
    class: cx('st-notice', `st-notice--${n.tone}`),
    [KEY_ATTR]: n.id,
    role: n.tone === 'bad' ? 'alert' : 'status',
  },
  h('div', { class: 'st-notice-body' }, n.text),
  button({ act: 'app.notice.dismiss', arg: n.id, variant: 'quiet', title: 'Dismiss' }, '×'))));
}

/**
 * @param {any} app
 * @returns {import('../core/vdom.js').VNode}
 */
export function renderStatusBar(app) {
  const pressure = app.ui.pressure;
  const gate = gateSummary(app);
  const missing = app.services.missing ? app.services.missing() : [];
  return h('footer', { class: 'st-status' },
    h('div', { class: 'st-status-group' },
      badge(gate.text, gate.tone),
      h('span', { class: 'st-status-sep' }, '·'),
      h('span', { class: 'st-status-text' }, `${plural((app.proof.spine || []).length, 'scene')}, ${plural((app.proof.branches || []).length, 'branch', 'branches')}`)),
    h('div', { class: 'st-status-group' },
      h('span', { class: 'st-status-text' }, 'Local storage'),
      meter({ ratio: pressure.ratio || 0, tone: pressure.level === 'critical' ? 'bad' : pressure.level === 'warn' ? 'warn' : 'ok', label: 'local storage' }),
      h('span', { class: 'st-status-text st-mono' },
        pressure.quota ? `${formatBytes(pressure.usage)} / ${formatBytes(pressure.quota)}` : 'quota unknown')),
    missing.length
      ? h('div', { class: 'st-status-group st-status-group--warn' },
        h('span', { class: 'st-status-text' }, `${plural(missing.length, 'lane')} not wired: ${missing.join(', ')}`))
      : null,
    h('div', { class: 'st-status-group' },
      button({ act: 'app.keys', variant: 'quiet', title: 'Keyboard reference (Alt /)' }, 'Keys'),
      button({ act: 'app.inspector', variant: 'quiet', pressed: app.ui.inspectorOpen ? 'true' : 'false' }, 'Inspector')));
}

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------

/**
 * The command palette: the keyboard route to everything that has no
 * accelerator of its own.
 * @param {any} app
 * @returns {import('../core/vdom.js').VNode}
 */
export function renderPalette(app) {
  const matches = app.paletteMatches();
  return h('div', { class: 'st-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command palette' },
    h('div', { class: 'st-palette' },
      h('input', {
        class: 'st-palette-input',
        type: 'text',
        autofocus: true,
        placeholder: 'Type a command…',
        'aria-label': 'Command',
        value: app.ui.paletteQuery,
        [ACT_ATTR]: 'app.palette.query',
        [KEY_ATTR]: 'palette-input',
      }),
      h('ul', { class: 'st-palette-list', role: 'listbox' }, matches.length
        ? matches.map((action, i) => h('li', { class: 'st-palette-item', [KEY_ATTR]: action.id, role: 'option', 'aria-selected': i === app.ui.paletteIndex ? 'true' : 'false' },
          h('button', {
            type: 'button',
            class: cx('st-palette-btn', i === app.ui.paletteIndex && 'st-palette-btn--active'),
            [ACT_ATTR]: 'app.palette.run',
            [ARG_ATTR]: action.id,
          },
          h('span', { class: 'st-palette-group' }, action.group),
          h('span', { class: 'st-palette-label' }, action.label),
          action.keys ? h('span', { class: 'st-palette-keys' }, keyLabel(action.keys[0]).map((k) => h('kbd', { class: 'st-kbd' }, k))) : null)))
        : h('li', { class: 'st-palette-empty' }, 'Nothing matches that.')),
      h('p', { class: 'st-palette-foot' }, 'Enter runs · ↑ ↓ moves · Esc closes')));
}

/**
 * The keyboard reference, generated from the registry so it cannot describe a
 * key that does not work.
 * @param {any} app
 * @returns {import('../core/vdom.js').VNode}
 */
export function renderKeyboard(app) {
  const groups = bindingGroups(app.actions.all);
  const noKey = app.actions.all.filter((a) => routeOf(a) === 'palette').length;
  const control = app.actions.all.filter((a) => routeOf(a) === 'control').length;
  return h('div', { class: 'st-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Keyboard reference' },
    h('div', { class: 'st-keysheet' },
      h('header', { class: 'st-keysheet-head' },
        h('h2', null, 'Keyboard'),
        button({ act: 'app.keys', variant: 'quiet' }, 'Close')),
      h('p', { class: 'st-keysheet-note' }, MOD_NOTE),
      h('div', { class: 'st-keysheet-groups' }, groups.map((g) => h('section', { class: 'st-keysheet-group', [KEY_ATTR]: g.group },
        h('h3', null, g.group),
        h('dl', { class: 'st-keysheet-list' }, g.bindings.map((b) => [
          h('dt', null, keyLabel(b.keys[0]).map((k) => h('kbd', { class: 'st-kbd' }, k))),
          h('dd', null, b.label),
        ]))))),
      h('p', { class: 'st-keysheet-foot' },
        `${noKey} more commands are in the palette (Ctrl K); ${control} are the fields and buttons themselves, reachable by Tab. Every action in the studio has one of those three routes.`)));
}

/**
 * The undo history, including auto-fixes, which §14 requires to be logged and
 * undoable.
 * @param {any} app
 * @returns {import('../core/vdom.js').VNode}
 */
export function renderHistory(app) {
  const entries = app.stack.history().slice().reverse();
  return h('aside', { class: 'st-history', 'aria-label': 'Undo history' },
    h('header', { class: 'st-history-head' },
      h('h2', null, 'History'),
      button({ act: 'app.history', variant: 'quiet' }, 'Close')),
    entries.length
      ? h('ol', { class: 'st-history-list' }, entries.map((entry, i) => h('li', {
        class: cx('st-history-item', i === 0 && 'st-history-item--top', entry.meta && /** @type {any} */ (entry.meta).autoFix && 'st-history-item--fix'),
        [KEY_ATTR]: String(entry.seq),
      },
      h('span', { class: 'st-history-seq st-mono' }, String(entry.seq)),
      h('span', { class: 'st-history-label' }, entry.label),
      entry.scope ? h('span', { class: 'st-history-scope' }, entry.scope) : null,
      entry.meta && /** @type {any} */ (entry.meta).autoFix ? badge('auto-fix', 'warn') : null)))
      : h('p', { class: 'st-history-empty' }, 'Nothing has been changed yet.'),
    h('footer', { class: 'st-history-foot' },
      button({ act: 'app.undo', variant: 'ghost', disabled: !app.stack.canUndo }, 'Undo'),
      button({ act: 'app.redo', variant: 'ghost', disabled: !app.stack.canRedo }, 'Redo'),
      button({ act: 'rehearse.revertFixes', variant: 'ghost' }, 'Undo every auto-fix')));
}

export { ACT_ATTR, ARG_ATTR, EVENT_ATTR };
