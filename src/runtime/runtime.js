/**
 * The runtime state machine (§12).
 *
 * This is the part of the presentation runtime that has no document: deck plus
 * navigation state plus chrome state, with `render()` producing a VNode tree.
 * The DOM binding lives in `host.js`, the second-screen view in `presenter.js`.
 *
 * Splitting it this way is what makes §14's automated sweep possible — the
 * sweep walks every beat of every scene and measures the rendered tree with no
 * browser at all — and it is what lets the emitter serialize the opening beat
 * to static HTML so the artifact paints before any script runs (§12 cold-boot
 * budget).
 *
 * @module runtime/runtime
 */

import { Emitter } from '../core/events.js';
import { h } from '../core/vdom.js';
import { elementId } from '../core/ids.js';
import { buildDeck, SPINE, branchesFrom, allBranches, sequenceOf } from './deck.js';
import { initialState, navigate, currentScene, stateHash, offSpine, beatsOf, peekNext } from './nav.js';
import { beatFrame, REVEAL_ATTR } from './beats.js';
import { renderLayout } from './layouts.js';
import { OverlayStack, OVERLAY } from './overlays.js';
import { resolveKey, allCommands, bindingGroups, keyLabel } from './keymap.js';

/**
 * @typedef {object} RuntimeOptions
 * @property {'presenter'|'review'} [mode]
 * @property {boolean} [reducedMotion]
 * @property {boolean} [labelIllustrative]
 * @property {boolean} [presenterAvailable]
 */

/**
 * @typedef {object} ChromeState
 * @property {boolean} blanked
 * @property {string|null} overlay
 * @property {boolean} presenterOpen
 */

/** The presentation runtime, minus the document. */
export class Runtime extends Emitter {
  /**
   * @param {import('../core/contracts.d.ts').Proof} proof
   * @param {RuntimeOptions} [options]
   */
  constructor(proof, options = {}) {
    super();
    this.proof = proof;
    this.deck = buildDeck(proof);
    this.nav = initialState(this.deck);
    this.overlays = new OverlayStack();
    this.blanked = false;
    this.presenterOpen = false;
    const emit = proof.emitOptions || {};
    // §2: the artifact detects its own context. A build a recipient can open
    // defaults to Review; presenter view is available when the build carries
    // presenter notes, and is entered explicitly — never assumed.
    this.presenterAvailable = options.presenterAvailable !== undefined
      ? !!options.presenterAvailable
      : emit.mode !== 'review' && emit.includePresenterNotes !== false;
    this.mode = options.mode || (emit.mode === 'presenter' ? 'presenter' : 'review');
    this.reducedMotion = !!options.reducedMotion;
    this.labelIllustrative = options.labelIllustrative !== false && emit.labelIllustrativeContent !== false;
    this.includePresenterNotes = this.presenterAvailable;

    /** @type {Map<string, import('../core/contracts.d.ts').Specimen>} */
    this.specimenById = new Map((proof.specimens || []).map((s) => [s.id, s]));
    /** @type {Map<string, import('../core/contracts.d.ts').Rendition>} */
    this.renditionById = new Map((proof.renditions || []).map((r) => [r.id, r]));
    /** @type {Map<string, import('../core/contracts.d.ts').MediaRef>} */
    this.mediaById = new Map();
    for (const s of proof.specimens || []) for (const m of s.media || []) this.mediaById.set(m.id, m);
    for (const r of proof.renditions || []) for (const m of r.media || []) this.mediaById.set(m.id, m);

    this.overlays.on('change', (e) => this.emit('change', { reason: `overlay:${e.reason}`, state: this.snapshot() }));

    this.registerCoreOverlays();
  }

  // -- state ---------------------------------------------------------------

  /** @returns {import('./nav.js').NavState & ChromeState & {sceneId: string|null, hash: string}} */
  snapshot() {
    const scene = currentScene(this.deck, this.nav);
    return {
      ...this.nav,
      sceneId: scene ? scene.id : null,
      blanked: this.blanked,
      overlay: this.overlays.top,
      presenterOpen: this.presenterOpen,
      hash: this.hash(),
    };
  }

  /** @returns {string} */
  hash() {
    return stateHash(this.deck, this.nav, { blanked: this.blanked, overlay: this.overlays.top });
  }

  /** @returns {import('../core/contracts.d.ts').Scene|null} */
  get scene() { return currentScene(this.deck, this.nav); }

  /** @returns {import('./beats.js').BeatFrame|null} */
  get frame() { return this.scene ? beatFrame(this.scene, this.nav.beatIndex) : null; }

  /** @returns {boolean} */
  get offSpine() { return offSpine(this.nav); }

  /**
   * Progress through the spine, for the presenter view. Branch scenes report
   * the progress of the spine position they will return to, because a detour is
   * not progress through the pitch.
   * @returns {{scene: number, sceneCount: number, beat: number, beatCount: number}}
   */
  progress() {
    const anchor = this.nav.stack.length ? this.nav.stack[0] : this.nav;
    const spineIndex = anchor.sequenceId === SPINE ? anchor.sceneIndex : 0;
    const scene = this.scene;
    return {
      scene: spineIndex + 1,
      sceneCount: this.deck.spine.scenes.length,
      beat: this.nav.beatIndex + 1,
      beatCount: scene ? beatsOf(scene) : 0,
    };
  }

  // -- transitions ---------------------------------------------------------

  /**
   * Apply a navigation action and announce the result.
   * @param {import('./nav.js').NavAction} action
   * @returns {boolean} whether the state changed
   */
  go(action) {
    const before = this.hash();
    const next = navigate(this.deck, this.nav, action);
    const changed = next !== this.nav;
    this.nav = next;
    if (this.hash() !== before) {
      this.overlays.handleNavigation();
      this.emit('change', { reason: action.type, state: this.snapshot() });
      return true;
    }
    return changed;
  }

  /**
   * Run a keymap command. Every command `allCommands()` can produce is handled
   * here; `test/runtime/keymap.test.mjs` asserts that, so adding a binding
   * without wiring it fails a test rather than doing nothing on stage.
   * @param {string} command
   * @param {any} [payload]
   * @returns {boolean}
   */
  run(command, payload) {
    switch (command) {
      case 'nextBeat': return this.go({ type: 'nextBeat' });
      case 'prevBeat': return this.go({ type: 'prevBeat' });
      case 'nextScene': return this.go({ type: 'nextScene' });
      case 'prevScene': return this.go({ type: 'prevScene' });
      case 'firstScene': return this.go({ type: 'firstScene' });
      case 'lastScene': return this.go({ type: 'lastScene' });
      case 'returnToSpine': return this.go({ type: 'returnToSpine' });
      case 'returnOnce': return this.go({ type: 'return' });
      case 'jump': return this.go({ type: 'jump', branchId: payload });
      case 'goToScene': return this.go({ type: 'goToScene', sceneId: payload });

      case 'openJump': this.overlays.open(OVERLAY.jump, payload); return true;
      case 'toggleMap': this.overlays.toggle(OVERLAY.map, payload); return true;
      case 'toggleContents': this.overlays.toggle(OVERLAY.contents, payload); return true;
      case 'toggleHelp': this.overlays.toggle(OVERLAY.help, payload); return true;

      case 'toggleBlank': return this.setBlanked(!this.blanked);
      case 'togglePresenter': return this.setPresenterOpen(!this.presenterOpen);
      case 'toggleFullscreen': this.emit('request', { kind: 'fullscreen' }); return true;

      case 'escape': {
        if (this.overlays.isOpen) { this.overlays.close(); return true; }
        if (this.blanked) return this.setBlanked(false);
        return false;
      }
      default:
        return false;
    }
  }

  /**
   * Handle a raw keyboard event. Returns the command that ran, or null.
   * @param {{key: string, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean, shiftKey?: boolean, preventDefault?: () => void}} event
   * @param {{typing?: boolean, activeElement?: Element|null}} [env]
   * @returns {string|null}
   */
  handleKey(event, env = {}) {
    const resolved = resolveKey(event, {
      overlay: this.overlays.top,
      typing: !!env.typing,
      blanked: this.blanked,
    });
    if (!resolved) return null;
    const handled = this.run(resolved.command, { activeElement: env.activeElement });
    if (handled && event.preventDefault) event.preventDefault();
    return handled ? resolved.command : null;
  }

  /**
   * §12: "one key to a neutral brand-coloured screen for when the room needs to
   * talk without a slide competing for attention". Blanking never changes the
   * deck position, so un-blanking returns to exactly the beat that was showing.
   * @param {boolean} value
   * @returns {boolean}
   */
  setBlanked(value) {
    if (this.blanked === !!value) return false;
    this.blanked = !!value;
    this.emit('change', { reason: 'blank', state: this.snapshot() });
    return true;
  }

  /**
   * @param {boolean} value
   * @returns {boolean}
   */
  setPresenterOpen(value) {
    // §2: a Review build has no presenter notes to show, so there is nothing to
    // open. This is enforced here rather than in the UI because a Review build
    // must not carry a second path to notes it was emitted without.
    if (!this.presenterAvailable) return false;
    if (this.presenterOpen === !!value) return false;
    this.presenterOpen = !!value;
    if (this.presenterOpen) this.mode = 'presenter';
    this.emit('presenter', { open: this.presenterOpen });
    this.emit('change', { reason: 'presenter', state: this.snapshot() });
    return true;
  }

  // -- rendering -----------------------------------------------------------

  /**
   * The layout context for a scene.
   * @param {import('../core/contracts.d.ts').Scene} scene
   * @returns {import('./layouts.js').LayoutContext}
   */
  layoutContext(scene) {
    return {
      scene,
      brand: this.proof.brand,
      specimen: scene.specimenId ? this.specimenById.get(scene.specimenId) || null : null,
      renditions: (scene.renditionIds || []).map((id) => this.renditionById.get(id)).filter(Boolean),
      media: this.mediaById,
      el: (path) => elementId(scene.id, path),
      labelIllustrative: this.labelIllustrative,
      mode: this.mode,
    };
  }

  /**
   * The scene's content, laid out. Independent of the beat: what the beat
   * decides is visibility, applied over this tree.
   * @param {import('../core/contracts.d.ts').Scene} [scene]
   * @returns {import('../core/vdom.js').VNode}
   */
  renderScene(scene = this.scene) {
    if (!scene) return h('div', { class: 'pp-scene pp-scene--empty' }, h('p', null, 'This proof has no scenes.'));
    return h('div', {
      class: 'pp-scene',
      'data-pp-scene': scene.id,
      'data-pp-layout': scene.layout,
    }, renderLayout(this.layoutContext(scene)));
  }

  /**
   * The whole stage: the scene, the beat's visibility applied, and the chrome
   * the artifact always carries. Overlays render on top.
   * @returns {import('../core/vdom.js').VNode}
   */
  render() {
    const scene = this.scene;
    const frame = this.frame;
    const overlay = this.overlays.topDefinition();
    return h('div', {
      class: `pp-stage${this.blanked ? ' pp-stage--blank' : ''}${this.offSpine ? ' pp-stage--branch' : ''}`,
      'data-pp-mode': this.mode,
      'data-pp-sequence': this.nav.sequenceId,
      'data-pp-beat': String(this.nav.beatIndex),
      'data-pp-hash': this.hash(),
    },
    h('div', { class: 'pp-stage-scene', 'aria-hidden': this.blanked ? 'true' : null },
      applyBeat(this.renderScene(scene), frame)),
    this.blanked ? h('div', { class: 'pp-blank', role: 'presentation' }) : null,
    this.offSpine ? this.renderBranchBadge() : null,
    overlay
      ? h('div', { class: 'pp-overlay-layer', role: 'dialog', 'aria-modal': 'true', 'aria-label': overlay.title },
        overlay.render(this.overlayContext()))
      : null);
  }

  /**
   * The off-spine indicator. A presenter who has jumped needs to know they are
   * in a branch without opening the map — that is the difference between
   * returning cleanly and losing the thread.
   * @returns {import('../core/vdom.js').VNode}
   */
  renderBranchBadge() {
    const seq = sequenceOf(this.deck, this.nav.sequenceId);
    return h('div', { class: 'pp-branch-badge', 'data-pp-branch': seq.id },
      h('span', { class: 'pp-branch-badge-label' }, seq.objection || 'Branch'),
      h('span', { class: 'pp-branch-badge-key' }, 'R to return'));
  }

  /** @returns {any} the context every overlay renderer receives */
  overlayContext() {
    return {
      runtime: this,
      deck: this.deck,
      nav: this.nav,
      scene: this.scene,
      branches: allBranches(this.deck),
      branchesHere: this.scene ? branchesFrom(this.deck, this.scene.id) : [],
      visited: this.nav.visited,
      mode: this.mode,
      run: (command, payload) => this.run(command, payload),
    };
  }

  /** Register the overlays L2 owns. L9 replaces the jump and map renderers. */
  registerCoreOverlays() {
    this.overlays.register({
      id: OVERLAY.help,
      title: 'Keyboard help',
      takesFocus: false,
      dismissOnNavigate: true,
      render: () => renderHelpOverlay(),
    });
  }

  /** @returns {string[]} */
  static commands() { return allCommands(); }

  /**
   * The next position, for the presenter view's "up next" panel. Never moves
   * the deck.
   * @returns {{scene: import('../core/contracts.d.ts').Scene|null, beatIndex: number, isSame: boolean}}
   */
  upNext() {
    const next = peekNext(this.deck, this.nav);
    const scene = currentScene(this.deck, next);
    return {
      scene,
      beatIndex: next.beatIndex,
      isSame: next.sequenceId === this.nav.sequenceId
        && next.sceneIndex === this.nav.sceneIndex
        && next.beatIndex === this.nav.beatIndex,
    };
  }
}

/**
 * Stamp the beat's visibility onto a rendered scene tree. Elements carrying
 * `data-pp-el` that the beat has not revealed get `hidden` and `aria-hidden`,
 * so the tree the emitter serializes for first paint is already correct for
 * beat 0 and needs no script to become presentable.
 * @param {import('../core/vdom.js').VNode} node
 * @param {import('./beats.js').BeatFrame|null} frame
 * @returns {import('../core/vdom.js').VNode}
 */
export function applyBeat(node, frame) {
  if (!frame || frame.revealsEverything) return node;
  const visit = (n) => {
    if (n === null || n === undefined || n === false) return n;
    if (Array.isArray(n)) return n.map(visit);
    if (typeof n !== 'object' || 'raw' in n) return n;
    const id = n.a[REVEAL_ATTR];
    let attrs = n.a;
    if (typeof id === 'string') {
      const visible = frame.revealed.has(id);
      const entering = frame.entering.includes(id);
      attrs = {
        ...n.a,
        class: [n.a.class, visible ? 'pp-revealed' : 'pp-unrevealed', entering ? 'pp-entering' : null]
          .filter(Boolean).join(' '),
        'aria-hidden': visible ? null : 'true',
        inert: visible ? null : true,
      };
    }
    return { t: n.t, a: attrs, c: n.c.map(visit) };
  };
  return visit(node);
}

/**
 * The help overlay. Built from the binding table, so it can never drift from
 * what the keys actually do.
 * @returns {import('../core/vdom.js').VNode}
 */
export function renderHelpOverlay() {
  return h('div', { class: 'pp-overlay pp-overlay--help' },
    h('h2', { class: 'pp-overlay-title' }, 'Keyboard'),
    h('div', { class: 'pp-help-groups' },
      bindingGroups().map((g) => h('section', { class: 'pp-help-group' },
        h('h3', { class: 'pp-help-group-title' }, g.group),
        h('dl', { class: 'pp-help-list' },
          g.bindings.map((b) => [
            h('dt', { class: 'pp-help-key' }, keyLabel(b)),
            h('dd', { class: 'pp-help-label' }, b.label),
          ]))))),
    h('p', { class: 'pp-overlay-foot' }, 'Esc closes this.'));
}
