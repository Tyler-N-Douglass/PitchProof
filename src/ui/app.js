/**
 * The studio application object.
 *
 * Three properties of this file are load-bearing, and each one exists because
 * §15 or §16 asked for it in so many words:
 *
 * **There is exactly one writer.** `app.doc` is a getter over
 * `CommandStack.state`; the class defines no setter and nothing anywhere in
 * `src/ui/**` assigns to it. Every mutation goes through `app.mutate`, which is
 * a single call to `stack.run`. That is what makes "undo/redo across all model
 * mutations" true by construction rather than by discipline, and it is what
 * `test/ui/undo-redo.test.mjs` asserts by enumerating the action registry.
 *
 * **Autosave is a consequence of a commit, not a separate habit.** The stack
 * emits `change`; the app listens and saves. A mutation that did not reach the
 * stack would therefore also not be saved, which makes a second writer visibly
 * broken rather than quietly wrong.
 *
 * **A failed save is never silent.** §16 says so directly. Every storage error
 * becomes a sticky notice with the sentence the store produced, and storage
 * pressure at 80% raises a warning with the re-compression offer attached.
 *
 * @module ui/app
 */

import { Emitter } from '../core/events.js';
import { CommandStack, replaceCommand } from '../core/command.js';
import { Patcher, delegate } from './render.js';
import { Preview } from './preview.js';
import { newDoc } from './model.js';
import { makeServices } from './services.js';
import { ACTIONS, actionIndex } from './actions.js';
import { renderStudio } from './layout.js';
import { keyStringOf, matchesBinding } from './keys.js';
import { SETTING_KEYS } from './constants.js';

export { SETTING_KEYS, SECTIONS, WIDE_SECTIONS } from './constants.js';

/**
 * @typedef {import('./model.js').Doc} Doc
 */

/** The studio. */
export class StudioApp extends Emitter {
  /**
   * @param {object} env
   * @param {Document} env.document
   * @param {any} env.window
   * @param {any} env.store                  a `ProjectStore`
   * @param {() => string} env.clock         ISO clock, injected (§5)
   * @param {string} [env.runtimeJs]
   * @param {string} [env.runtimeCss]
   * @param {any} [env.services]             injected for tests; defaults to the real lanes
   * @param {Doc} [env.doc]                  an initial document, for tests
   */
  constructor(env) {
    super();
    this.doc_ = null;
    this.document = env.document;
    this.window = env.window || (env.document ? env.document.defaultView : null);
    this.store = env.store;
    this.clock = env.clock;
    this.runtimeJs = env.runtimeJs || '';
    this.runtimeCss = env.runtimeCss || '';
    this.services = env.services || makeServices({
      clock: env.clock,
      runtimeJs: this.runtimeJs,
      runtimeCss: this.runtimeCss,
      view: this.window,
    });
    this.actions = actionIndex(ACTIONS);

    const initial = env.doc || newDoc({ seed: 'pitchproof-v1', at: env.clock() });
    /** The only writer in the studio. @type {CommandStack<Doc>} */
    this.stack = new CommandStack(initial, { limit: 400 });

    /** Everything that is not the model: selection, drafts, transient results. */
    this.ui = {
      section: 'project',
      layout: 'split',
      inspectorOpen: true,
      historyOpen: false,
      paletteOpen: false,
      paletteQuery: '',
      paletteIndex: 0,
      keysOpen: false,
      breakpoint: 'lg',
      selection: {
        specimenId: null, renditionId: null, sceneId: null, branchId: null,
        recipeId: null, beatIndex: 0, colorRole: null, faceIndex: null, logoId: null,
      },
      /** transient text the user is typing that is not yet a model change */
      drafts: {},
      /** @type {{id: string, tone: string, text: string, sticky: boolean}[]} */
      notices: [],
      /** @type {string[]} action ids currently running */
      busy: [],
      projects: [],
      pressure: { level: 'ok', usage: 0, quota: 0, ratio: 0 },
      save: { status: 'idle', at: null, error: null, revision: 0 },
      settings: { proxyBase: '', adapterEndpoint: '', adapterKey: '', operator: '' },
      /** @type {{findings: any[], at: string|null, running: boolean, error: string|null}} */
      sweep: { findings: [], at: null, running: false, error: null },
      /** @type {{active: boolean, index: number, positions: any[], findings: any[]}} */
      dryRun: { active: false, index: 0, positions: [], findings: [] },
      /** @type {any} */
      emit: { result: null, running: false, error: null, at: null },
      /** @type {any[]} */
      sitemap: [],
      /** @type {string[]} auto-fix labels applied this session, for the history panel */
      fixes: [],
    };

    this.noticeSeq = 0;
    /** @type {Patcher|null} */
    this.patcher = null;
    /** @type {(() => void)|null} */
    this.undelegate = null;
    /** @type {(() => void)|null} */
    this.unkey = null;
    /** @type {any} */
    this.saveTimer = null;
    this.destroyed = false;
    /** Guards against a render triggering another render inside itself. */
    this.rendering = false;
    this.renderQueued = false;

    this.preview = new Preview({
      document: this.document,
      window: this.window,
      runtimeCss: this.runtimeCss,
      services: this.services,
    });
    this.preview.onChange = () => this.render();

    this.stack.on('change', (e) => {
      if (e.kind === 'reset') return;   // a load is not an edit, so it is not a save
      this.scheduleSave();
    });

    if (this.store && typeof this.store.onPressure === 'function') {
      this.store.onPressure((p) => this.reportPressure(p));
    }
  }

  // -- the single writer ----------------------------------------------------

  /** The editable document. Read-only by construction: there is no setter. */
  get doc() { return this.stack.state; }

  /** @returns {import('../core/contracts.d.ts').Proof} */
  get proof() { return this.stack.state.proof; }

  /**
   * Commit a mutation. The one route from a user action to the model.
   * @param {string} label            imperative, as it will read in the undo menu
   * @param {(doc: Doc) => Doc} updater
   * @param {{coalesceKey?: string, scope?: string, meta?: unknown}} [options]
   * @returns {Doc}
   */
  mutate(label, updater, options = {}) {
    const before = this.stack.state;
    const after = updater(before);
    // A reducer that changed nothing returns the document it was given. That is
    // the signal that this was not an edit: pushing it would put an entry on the
    // undo stack whose undo does nothing, which is how an undo stack stops being
    // trustworthy under pressure.
    if (after === before) return before;
    const next = this.stack.run(replaceCommand(label, before, after, options));
    this.emit('mutated', { label, doc: next });
    return next;
  }

  /**
   * Group several mutations into one undo entry.
   * @param {string} label
   * @param {() => void} body
   * @param {{scope?: string, meta?: unknown}} [options]
   */
  transaction(label, body, options = {}) {
    return this.stack.transaction(label, body, options);
  }

  /** @returns {boolean} */
  undo() {
    if (!this.stack.canUndo) return false;
    const label = this.stack.undoLabel;
    this.stack.undo();
    this.scheduleSave();
    this.notify('info', `Undone: ${label}`);
    return true;
  }

  /** @returns {boolean} */
  redo() {
    if (!this.stack.canRedo) return false;
    const label = this.stack.redoLabel;
    this.stack.redo();
    this.scheduleSave();
    this.notify('info', `Redone: ${label}`);
    return true;
  }

  // -- transient state ------------------------------------------------------

  /**
   * @param {Record<string, unknown>} patch
   */
  setUi(patch) { Object.assign(this.ui, patch); return this.ui; }

  /**
   * @param {Record<string, unknown>} patch
   */
  select(patch) { Object.assign(this.ui.selection, patch); return this.ui.selection; }

  /**
   * A draft is text the user is typing that is not a model change yet — a URL
   * about to be fetched, a paste about to become a rendition, an alias about to
   * be added. Drafts are deliberately outside the command stack: undoing a
   * half-typed URL is noise, and §15's undo is about model mutations.
   * @param {string} key
   * @param {unknown} value
   */
  setDraft(key, value) { this.ui.drafts = { ...this.ui.drafts, [key]: value }; }

  /**
   * @param {string} key
   * @param {any} [fallback]
   * @returns {any}
   */
  draft(key, fallback = '') {
    const v = this.ui.drafts[key];
    return v === undefined ? fallback : v;
  }

  /**
   * @param {string} tone   ok | warn | bad | info
   * @param {string} text
   * @param {{sticky?: boolean}} [options]
   */
  notify(tone, text, options = {}) {
    this.noticeSeq += 1;
    const id = `nt_${this.noticeSeq}`;
    this.ui.notices = [...this.ui.notices.filter((n) => n.text !== text), {
      id, tone, text, sticky: !!options.sticky,
    }].slice(-6);
    if (!options.sticky && this.window && typeof this.window.setTimeout === 'function') {
      this.window.setTimeout(() => { this.dismissNotice(id); this.render(); }, 6000);
    }
    return id;
  }

  /** @param {string} id */
  dismissNotice(id) { this.ui.notices = this.ui.notices.filter((n) => n.id !== id); }

  /** @param {string} id @param {boolean} on */
  setBusy(id, on) {
    this.ui.busy = on ? [...new Set([...this.ui.busy, id])] : this.ui.busy.filter((b) => b !== id);
  }

  /** @param {string} id @returns {boolean} */
  isBusy(id) { return this.ui.busy.includes(id); }

  // -- persistence ----------------------------------------------------------

  /**
   * Autosave, debounced just enough to survive a burst of keystrokes. §16 asks
   * for a save on every committed mutation; coalescing a run of coalesced text
   * edits into one write is the same thing, and it is what keeps the store from
   * being hammered while somebody types a headline.
   */
  scheduleSave() {
    if (!this.store) return;
    this.ui.save = { ...this.ui.save, status: 'pending' };
    if (this.window && typeof this.window.setTimeout === 'function') {
      if (this.saveTimer) this.window.clearTimeout(this.saveTimer);
      this.saveTimer = this.window.setTimeout(() => { this.saveTimer = null; void this.saveNow(); }, 350);
      return;
    }
    void this.saveNow();
  }

  /**
   * Write now. Returns the store's `Result` so a caller (the Save action) can
   * report precisely what happened.
   * @returns {Promise<any>}
   */
  async saveNow() {
    if (!this.store) return { ok: false, error: 'No project store is attached.' };
    const doc = this.doc;
    this.ui.save = { ...this.ui.save, status: 'saving' };
    const result = await this.store.save({ id: doc.id, name: doc.name, proof: doc.proof, seed: doc.seed });
    if (result.ok) {
      this.ui.save = {
        status: 'saved',
        at: result.value.record.savedAt,
        error: null,
        revision: result.value.record.revision,
      };
      this.reportPressure(result.value.pressure);
      await this.refreshProjects();
    } else {
      // §16: never fail a save silently.
      this.ui.save = { ...this.ui.save, status: 'error', error: result.error };
      this.notify('bad', result.error, { sticky: true });
    }
    this.render();
    return result;
  }

  /**
   * Surface storage pressure. §16 requires a warning at 80% of estimated quota
   * and an offer of asset re-compression, which the notice carries by naming
   * the action the user can run.
   * @param {{level: string, usage: number, quota: number, ratio: number}} pressure
   */
  reportPressure(pressure) {
    if (!pressure) return;
    const before = this.ui.pressure.level;
    this.ui.pressure = pressure;
    if (pressure.level === 'ok' || pressure.level === before) return;
    const pct = Math.round((pressure.ratio || 0) * 100);
    this.notify(
      pressure.level === 'critical' ? 'bad' : 'warn',
      `Local storage is ${pct}% full. Re-compress the project's images (Project → Re-compress assets) or export the project and delete one you have finished with.`,
      { sticky: true },
    );
  }

  /** Refresh the project list and the pressure reading. */
  async refreshProjects() {
    if (!this.store) return;
    this.ui.projects = await this.store.list();
    try { this.ui.pressure = await this.store.pressure(); } catch { /* an unknown quota is not an error */ }
  }

  /** Read the per-machine settings out of the meta store. */
  async loadSettings() {
    if (!this.store) return;
    const [proxyBase, adapterEndpoint, adapterKey, operator] = await Promise.all([
      this.store.getSetting(SETTING_KEYS.proxyBase, ''),
      this.store.getSetting(SETTING_KEYS.adapterEndpoint, ''),
      this.store.getSetting(SETTING_KEYS.adapterKey, ''),
      this.store.getSetting(SETTING_KEYS.operator, ''),
    ]);
    this.ui.settings = {
      proxyBase: proxyBase || '',
      adapterEndpoint: adapterEndpoint || '',
      adapterKey: adapterKey || '',
      operator: operator || '',
    };
  }

  /**
   * @param {string} key   one of `SETTING_KEYS`' values
   * @param {string} value
   */
  async setSetting(key, value) {
    this.ui.settings = { ...this.ui.settings, ...settingPatch(key, value) };
    if (!this.store) return;
    const result = await this.store.setSetting(key, value);
    if (!result.ok) this.notify('bad', result.error, { sticky: true });
  }

  /**
   * Load a project into the studio. A load resets the stack rather than
   * pushing onto it: undoing across a project switch would be a lie.
   * @param {any} record
   */
  loadRecord(record) {
    this.stack.reset({ id: record.id, name: record.name, seed: record.seed, proof: record.proof });
    this.ui.selection = {
      specimenId: null, renditionId: null, sceneId: (record.proof.spine || [])[0]?.id || null,
      branchId: null, recipeId: null, beatIndex: 0, colorRole: null, faceIndex: null, logoId: null,
    };
    this.ui.sweep = { findings: [], at: null, running: false, error: null };
    this.ui.emit = { result: null, running: false, error: null, at: null };
    this.ui.save = { status: 'saved', at: record.savedAt || null, error: null, revision: record.revision || 1 };
    if (this.store) void this.store.setSetting(SETTING_KEYS.lastProject, record.id);
  }

  // -- dispatch -------------------------------------------------------------

  /**
   * Run an action by id. Everything the interface can do arrives here — a
   * click, a keystroke, a command-palette selection — which is what makes the
   * registry a complete inventory of the studio rather than a subset of it.
   * @param {string} id
   * @param {string|null} [arg]
   * @param {{value?: unknown, element?: any, event?: any}} [ctx]
   * @returns {Promise<void>|void}
   */
  dispatch(id, arg, ctx = {}) {
    const action = this.actions.byId.get(id);
    if (!action) { this.notify('bad', `The studio has no action called "${id}".`); this.render(); return; }
    if (action.enabled && !action.enabled(this)) { this.render(); return; }
    let result;
    try {
      result = action.run(this, arg === undefined ? null : arg, ctx);
    } catch (e) {
      this.notify('bad', `${action.label} failed: ${e instanceof Error ? e.message : String(e)}`, { sticky: true });
      this.render();
      return;
    }
    if (result && typeof result.then === 'function') {
      this.setBusy(id, true);
      this.render();
      return result
        .catch((e) => this.notify('bad', `${action.label} failed: ${e instanceof Error ? e.message : String(e)}`, { sticky: true }))
        .then(() => { this.setBusy(id, false); this.render(); });
    }
    this.render();
    return undefined;
  }

  // -- keyboard -------------------------------------------------------------

  /**
   * The studio's key router. Bindings live on the actions, so the keyboard
   * reference and the command palette cannot drift from what the keys do.
   * @param {any} event
   * @returns {string|null} the action that ran
   */
  handleKey(event) {
    const combo = keyStringOf(event);
    if (!combo) return null;
    const typing = isTextEntry(event.target);

    if (this.ui.paletteOpen) {
      const handled = this.handlePaletteKey(combo, event);
      if (handled) return handled;
    }
    if (combo === 'Escape') {
      if (this.ui.paletteOpen) { this.setUi({ paletteOpen: false, paletteQuery: '' }); this.render(); return 'app.palette.close'; }
      if (this.ui.keysOpen) { this.setUi({ keysOpen: false }); this.render(); return 'app.keys.close'; }
      if (this.ui.historyOpen) { this.setUi({ historyOpen: false }); this.render(); return 'app.history.close'; }
    }

    for (const action of this.actions.withKeys) {
      if (!matchesBinding(combo, action.keys)) continue;
      // A bare letter must not fire while somebody is typing into a field.
      if (typing && !/\+/.test(combo)) continue;
      if (event.preventDefault) event.preventDefault();
      this.dispatch(action.id, null, { event });
      return action.id;
    }
    return null;
  }

  /**
   * @param {string} combo
   * @param {any} event
   * @returns {string|null}
   */
  handlePaletteKey(combo, event) {
    const matches = this.paletteMatches();
    if (combo === 'ArrowDown' || combo === 'ArrowUp') {
      const delta = combo === 'ArrowDown' ? 1 : -1;
      const next = matches.length ? (this.ui.paletteIndex + delta + matches.length) % matches.length : 0;
      this.setUi({ paletteIndex: next });
      if (event.preventDefault) event.preventDefault();
      this.render();
      return 'app.palette.move';
    }
    if (combo === 'Enter') {
      const chosen = matches[this.ui.paletteIndex];
      if (event.preventDefault) event.preventDefault();
      this.setUi({ paletteOpen: false, paletteQuery: '', paletteIndex: 0 });
      if (chosen) { this.dispatch(chosen.id, null, { event }); return chosen.id; }
      this.render();
      return 'app.palette.close';
    }
    return null;
  }

  /**
   * The palette's current result list. Every action that declares itself
   * palette-reachable is here, which is the keyboard route of last resort for
   * anything without its own binding (§20.10).
   * @returns {any[]}
   */
  paletteMatches() {
    const query = String(this.ui.paletteQuery || '').trim().toLowerCase();
    const pool = this.actions.inPalette.filter((a) => !a.enabled || a.enabled(this));
    if (!query) return pool.slice(0, 40);
    const scored = [];
    for (const action of pool) {
      const label = action.label.toLowerCase();
      // The label is what the user is thinking of; the group is context. Typing
      // "brand" should reach "Extract brand from a URL" before it reaches every
      // action that happens to live in the Brand group.
      const context = `${action.group} ${label} ${action.keywords || ''}`;
      const score = Math.max(fuzzyScore(label, query) * 2, fuzzyScore(context, query))
        + (label.includes(query) ? 20 : 0)
        + (action.keywords && String(action.keywords).includes(query) ? 8 : 0);
      if (score > 0) scored.push({ action, score });
    }
    scored.sort((a, b) => (b.score - a.score) || a.action.label.localeCompare(b.action.label));
    return scored.slice(0, 40).map((s) => s.action);
  }

  // -- lifecycle ------------------------------------------------------------

  /**
   * Attach to a root element and start rendering.
   * @param {Element} root
   */
  mount(root) {
    this.root = root;
    this.patcher = new Patcher(root, this.document);
    this.undelegate = delegate(root, ({ action, arg, value, element, event }) => {
      this.dispatch(action, arg, { value, element, event });
    });
    if (this.document && this.document.addEventListener) {
      const onKey = (event) => this.handleKey(event);
      this.document.addEventListener('keydown', onKey);
      this.unkey = () => this.document.removeEventListener('keydown', onKey);
    }
    this.render();
    return this;
  }

  /** Read settings and the project list, then open the last project. */
  async start() {
    await this.loadSettings();
    await this.refreshProjects();
    if (this.store && this.store.degraded) this.notify('warn', this.store.degraded, { sticky: true });
    const lastId = this.store ? await this.store.getSetting(SETTING_KEYS.lastProject, null) : null;
    if (lastId) {
      const loaded = await this.store.load(lastId);
      if (loaded.ok) this.loadRecord(loaded.value);
    }
    this.services.ensureLayouts();
    this.render();
    return this;
  }

  /**
   * Render the whole studio and patch the difference into the document.
   *
   * Re-entrant by nature and guarded against it: painting the canvas can move
   * the preview's runtime, the runtime announces the move, and the announcement
   * asks for another render. Left alone that nests renders until the stack
   * gives out. So a render in flight records that another is wanted and the
   * outer call drains it, with a hard cap — a render that keeps asking for
   * another render is a bug, and burning the stack would hide it rather than
   * show it.
   */
  render() {
    if (this.destroyed || !this.patcher) return;
    if (this.rendering) { this.renderQueued = true; return; }
    this.rendering = true;
    try {
      let passes = 0;
      do {
        this.renderQueued = false;
        this.patcher.render(renderStudio(this));
        this.syncPreview();
        passes += 1;
      } while (this.renderQueued && passes < 3);
    } finally {
      this.rendering = false;
      this.renderQueued = false;
    }
  }

  /**
   * Keep the preview pointed at the current model. Called after every render,
   * and cheap when nothing changed: the preview only reboots when the deck's
   * shape actually moved.
   */
  syncPreview() {
    if (!this.root || !this.root.querySelector) return;
    const host = this.root.querySelector('[data-st-preview-host]');
    if (!host) { return; }
    this.preview.attach(host);
    this.preview.update({
      proof: this.proof,
      breakpoint: this.ui.breakpoint,
      sceneId: this.ui.selection.sceneId,
      mode: 'presenter',
    });
    this.preview.fit();
  }

  /** Release every listener and the preview. */
  destroy() {
    this.destroyed = true;
    if (this.undelegate) { this.undelegate(); this.undelegate = null; }
    if (this.unkey) { this.unkey(); this.unkey = null; }
    if (this.saveTimer && this.window && this.window.clearTimeout) this.window.clearTimeout(this.saveTimer);
    this.preview.detach();
    this.clear();
  }
}

/**
 * @param {string} key
 * @param {string} value
 * @returns {Record<string, string>}
 */
function settingPatch(key, value) {
  if (key === SETTING_KEYS.proxyBase) return { proxyBase: value };
  if (key === SETTING_KEYS.adapterEndpoint) return { adapterEndpoint: value };
  if (key === SETTING_KEYS.adapterKey) return { adapterKey: value };
  if (key === SETTING_KEYS.operator) return { operator: value };
  return {};
}

/**
 * Subsequence scoring for the command palette: every character of the query in
 * order, with contiguous runs and word starts worth more. Enough to make
 * "adsc" find "Add scene" without a fuzzy-search dependency.
 * @param {string} haystack
 * @param {string} needle
 * @returns {number}
 */
export function fuzzyScore(haystack, needle) {
  let score = 0;
  let at = 0;
  let streak = 0;
  for (const ch of needle) {
    if (ch === ' ') continue;
    const found = haystack.indexOf(ch, at);
    if (found < 0) return 0;
    const wordStart = found === 0 || /\s/.test(haystack[found - 1]);
    streak = found === at ? streak + 1 : 0;
    score += 1 + streak * 2 + (wordStart ? 3 : 0);
    at = found + 1;
  }
  return score;
}

/**
 * @param {any} el
 * @returns {boolean}
 */
export function isTextEntry(el) {
  if (!el || !el.tagName) return false;
  const tag = String(el.tagName).toLowerCase();
  if (tag === 'textarea') return true;
  if (tag === 'input') {
    const type = (el.getAttribute ? el.getAttribute('type') : 'text') || 'text';
    return !['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'file'].includes(type.toLowerCase());
  }
  return !!(el.getAttribute && el.getAttribute('contenteditable') === 'true');
}
