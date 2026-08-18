/**
 * Presenter view (§12).
 *
 * "Opens in a second window: current beat, next beat preview, presenter note,
 * branch availability, and a manual timer the presenter starts — never an
 * automatic countdown."
 *
 * Two design consequences follow from the offline law:
 *
 *   - The second window is opened blank and written into directly from the
 *     parent. There is no channel between the windows and nothing is loaded by
 *     URL, so presenter view works from a `file://` document, from a USB stick,
 *     and from an email attachment on a desktop — the three cases §13 names.
 *   - The timer is started by the presenter and by nobody else. `dwellHintMs`
 *     is displayed as a hint and never drives anything, because §10 makes a
 *     proof that moves on its own a defect.
 *
 * @module runtime/presenter
 */

import { h, toHtml } from '../core/vdom.js';
import { dwellHintLabel } from './beats.js';
import { branchesFrom } from './deck.js';
import { bindingGroups, keyLabel } from './keymap.js';

/** Window name, so re-opening reuses the same second screen. */
export const PRESENTER_WINDOW_NAME = 'pitchproof-presenter';

/**
 * A manual stopwatch. Started, paused and reset by the presenter; it reports
 * elapsed milliseconds from a clock the caller injects, which keeps the model
 * free of a wall-clock read and lets a test drive it.
 */
export class ManualTimer {
  /** @param {() => number} nowMs */
  constructor(nowMs) {
    this.nowMs = nowMs;
    this.running = false;
    this.startedAt = 0;
    this.accumulated = 0;
  }

  start() {
    if (this.running) return this;
    this.startedAt = this.nowMs();
    this.running = true;
    return this;
  }

  pause() {
    if (!this.running) return this;
    this.accumulated += this.nowMs() - this.startedAt;
    this.running = false;
    return this;
  }

  toggle() { return this.running ? this.pause() : this.start(); }

  reset() {
    this.running = false;
    this.startedAt = 0;
    this.accumulated = 0;
    return this;
  }

  /** @returns {number} elapsed milliseconds */
  elapsed() {
    return this.accumulated + (this.running ? this.nowMs() - this.startedAt : 0);
  }

  /** @returns {string} `mm:ss`, counting up — never down */
  label() {
    const total = Math.max(0, Math.floor(this.elapsed() / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
}

/**
 * Render the presenter view as a VNode tree. Pure, so the studio can show the
 * same panel inline during rehearsal without opening a window.
 * @param {import('./runtime.js').Runtime} runtime
 * @param {{timerLabel?: string, timerRunning?: boolean}} [chrome]
 * @returns {import('../core/vdom.js').VNode}
 */
export function renderPresenterView(runtime, chrome = {}) {
  const scene = runtime.scene;
  const frame = runtime.frame;
  const next = runtime.upNext();
  const progress = runtime.progress();
  const branches = scene ? branchesFrom(runtime.deck, scene.id) : [];
  const beat = scene && scene.beats ? scene.beats[runtime.nav.beatIndex] : null;
  const hint = dwellHintLabel(beat);

  return h('div', { class: 'ppv-root' },
    h('header', { class: 'ppv-head' },
      h('div', { class: 'ppv-progress' },
        h('span', { class: 'ppv-progress-scene' }, `Scene ${progress.scene} / ${progress.sceneCount}`),
        h('span', { class: 'ppv-progress-beat' }, `Beat ${progress.beat} / ${progress.beatCount}`)),
      h('div', { class: `ppv-timer${chrome.timerRunning ? ' ppv-timer--running' : ''}` },
        h('span', { class: 'ppv-timer-value' }, chrome.timerLabel || '00:00'),
        h('button', { type: 'button', class: 'ppv-timer-toggle', 'data-ppv-action': 'timer-toggle' },
          chrome.timerRunning ? 'Pause' : 'Start'),
        h('button', { type: 'button', class: 'ppv-timer-reset', 'data-ppv-action': 'timer-reset' }, 'Reset')),
      runtime.offSpine
        ? h('div', { class: 'ppv-branch-flag' }, 'Off spine — press R to return')
        : null),

    h('section', { class: 'ppv-now' },
      h('h1', { class: 'ppv-now-title' }, scene ? (scene.headline || scene.id) : 'No scene'),
      scene && scene.subhead ? h('p', { class: 'ppv-now-sub' }, scene.subhead) : null,
      hint ? h('p', { class: 'ppv-dwell' }, `Pacing hint: ${hint} — the deck never advances on its own.`) : null),

    h('section', { class: 'ppv-note' },
      h('h2', { class: 'ppv-section-title' }, 'Presenter note'),
      h('div', { class: 'ppv-note-body' },
        frame && frame.presenterNote
          ? frame.presenterNote
          : h('span', { class: 'ppv-empty' }, 'No note for this beat.'))),

    h('section', { class: 'ppv-next' },
      h('h2', { class: 'ppv-section-title' }, 'Up next'),
      next.isSame
        ? h('p', { class: 'ppv-empty' }, 'End of the deck.')
        : h('div', { class: 'ppv-next-body' },
          h('p', { class: 'ppv-next-title' }, next.scene ? (next.scene.headline || next.scene.id) : ''),
          h('p', { class: 'ppv-next-beat' }, `Beat ${next.beatIndex + 1}`))),

    h('section', { class: 'ppv-branches' },
      h('h2', { class: 'ppv-section-title' }, 'Available here'),
      branches.length === 0
        ? h('p', { class: 'ppv-empty' }, 'No branches anchored to this scene. Press / to search all of them.')
        : h('ul', { class: 'ppv-branch-list' },
          branches.map((b) => h('li', { class: 'ppv-branch' },
            h('button', { type: 'button', class: 'ppv-branch-button', 'data-ppv-jump': b.id }, b.objection || b.id))))),

    h('footer', { class: 'ppv-keys' },
      bindingGroups().map((g) => h('div', { class: 'ppv-key-group' },
        h('span', { class: 'ppv-key-group-title' }, g.group),
        g.bindings.map((b) => h('span', { class: 'ppv-key' },
          h('kbd', null, keyLabel(b)), ' ', b.label))))));
}

/** The presenter window's own stylesheet. Deliberately unbranded: this screen
 *  is the presenter's instrument panel, not part of the proof. It shares no
 *  variable with the artifact theme or the studio chrome. */
export const PRESENTER_CSS = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  background: #101317; color: #e9edf2; font: 16px/1.5 system-ui, sans-serif;
  padding: 20px; -webkit-font-smoothing: antialiased;
}
.ppv-root { display: grid; gap: 16px; grid-template-columns: 3fr 2fr;
  grid-template-areas: "head head" "now next" "note branches" "keys keys"; height: 100%; }
.ppv-head { grid-area: head; display: flex; align-items: center; gap: 16px;
  border-bottom: 1px solid #2a3038; padding-bottom: 12px; }
.ppv-progress { display: flex; gap: 12px; font-variant-numeric: tabular-nums; color: #9aa6b2; }
.ppv-timer { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.ppv-timer-value { font-size: 28px; font-variant-numeric: tabular-nums; letter-spacing: 0.02em; }
.ppv-timer--running .ppv-timer-value { color: #8fe3a4; }
.ppv-timer button { background: #1c222a; color: inherit; border: 1px solid #2f3742;
  border-radius: 6px; padding: 6px 12px; font: inherit; cursor: pointer; }
.ppv-timer button:hover { background: #242c36; }
.ppv-branch-flag { background: #3a2a12; color: #ffcf8b; border-radius: 6px; padding: 6px 10px; font-size: 14px; }
.ppv-now { grid-area: now; }
.ppv-now-title { font-size: 34px; line-height: 1.15; margin: 0 0 8px; }
.ppv-now-sub { margin: 0; color: #9aa6b2; font-size: 18px; }
.ppv-dwell { margin: 12px 0 0; color: #7d8896; font-size: 14px; }
.ppv-next { grid-area: next; }
.ppv-note { grid-area: note; }
.ppv-branches { grid-area: branches; }
.ppv-section-title { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em;
  color: #7d8896; margin: 0 0 8px; }
.ppv-note-body { font-size: 20px; line-height: 1.45; white-space: pre-wrap; }
.ppv-next-title { font-size: 18px; margin: 0 0 4px; }
.ppv-next-beat, .ppv-empty { color: #7d8896; margin: 0; }
.ppv-branch-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.ppv-branch-button { width: 100%; text-align: left; background: #1c222a; color: inherit;
  border: 1px solid #2f3742; border-radius: 6px; padding: 8px 10px; font: inherit; cursor: pointer; }
.ppv-branch-button:hover { background: #242c36; }
.ppv-keys { grid-area: keys; border-top: 1px solid #2a3038; padding-top: 10px;
  display: flex; flex-wrap: wrap; gap: 16px; font-size: 12px; color: #7d8896; }
.ppv-key-group { display: flex; flex-wrap: wrap; gap: 10px; align-items: baseline; }
.ppv-key-group-title { text-transform: uppercase; letter-spacing: 0.08em; color: #5d6874; }
.ppv-key kbd { background: #1c222a; border: 1px solid #2f3742; border-radius: 4px;
  padding: 1px 5px; font: inherit; color: #c3ccd6; }
@media (max-width: 900px) {
  .ppv-root { grid-template-columns: 1fr; grid-template-areas: "head" "now" "note" "next" "branches" "keys"; }
}
`;

/**
 * Open (or reuse) the presenter window and keep it in step with the runtime.
 *
 * The window is opened with no URL and its document is written directly, so
 * nothing is ever requested. Returns a controller with `close()`; if the
 * browser blocked the pop-up, `opened` is false and the caller can say so
 * rather than leaving the presenter pressing `p` at nothing.
 *
 * @param {import('./runtime.js').Runtime} runtime
 * @param {object} env
 * @param {Window} env.window
 * @param {() => number} env.nowMs   injected clock for the manual timer
 * @returns {{opened: boolean, close: () => void, refresh: () => void, timer: ManualTimer}}
 */
export function openPresenterWindow(runtime, env) {
  const timer = new ManualTimer(env.nowMs);
  const target = env.window && typeof env.window.open === 'function'
    ? env.window.open('', PRESENTER_WINDOW_NAME, 'width=1100,height=760')
    : null;

  if (!target) {
    return { opened: false, close: () => {}, refresh: () => {}, timer };
  }

  const doc = target.document;
  doc.open();
  doc.write(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Presenter view</title><style>${PRESENTER_CSS}</style></head><body><div id="ppv-root"></div></body></html>`);
  doc.close();

  const paint = () => {
    const root = doc.getElementById('ppv-root');
    if (!root) return;
    root.innerHTML = toHtml(renderPresenterView(runtime, {
      timerLabel: timer.label(),
      timerRunning: timer.running,
    }));
  };

  const onClick = (event) => {
    const el = event.target && event.target.closest ? event.target.closest('[data-ppv-action],[data-ppv-jump]') : null;
    if (!el) return;
    const jump = el.getAttribute('data-ppv-jump');
    if (jump) { runtime.run('jump', jump); return; }
    const action = el.getAttribute('data-ppv-action');
    if (action === 'timer-toggle') timer.toggle();
    if (action === 'timer-reset') timer.reset();
    paint();
  };
  doc.addEventListener('click', onClick);

  // The presenter window shares the main window's keyboard model, so the
  // presenter can drive the deck from whichever screen their hands are on.
  const onKey = (event) => runtime.handleKey(event, { typing: false });
  doc.addEventListener('keydown', onKey);

  const off = runtime.on('change', paint);
  // One tick a second keeps the stopwatch readable. It moves the clock display
  // and nothing else — the deck does not advance, ever.
  const tick = target.setInterval(() => { if (timer.running) paint(); }, 1000);

  paint();

  const close = () => {
    off();
    target.clearInterval(tick);
    doc.removeEventListener('click', onClick);
    doc.removeEventListener('keydown', onKey);
    if (!target.closed) target.close();
  };

  return { opened: true, close, refresh: paint, timer };
}
