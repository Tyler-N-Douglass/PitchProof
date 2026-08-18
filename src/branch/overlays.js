/**
 * The three branch overlays (§2, §11, §12).
 *
 *   `/`  jump      — search the objections, arrow through the results, Enter jumps.
 *   `m`  map       — where you are, what you have shown, what is still in the bag.
 *   `c`  contents  — the §2 Review-mode index of the spine, self-paced and jumpable.
 *
 * Every renderer here is a pure function from the overlay context to a VNode.
 * None of them touches `document`: the same tree is asserted in `node --test`,
 * serialized by the emitter, and mounted by the host, and that is the only
 * reason a rehearsal pass over these overlays means anything (§14).
 *
 * The interactive state of the jump index — the query and the highlighted row —
 * lives in a `JumpController`, not in the DOM. The overlay renders the
 * controller; a keystroke updates the controller and the host repaints. A
 * search field whose state lived in the input element would lose its place on
 * every repaint, and would be unreachable from a test.
 *
 * @module branch/overlays
 */

import { h } from '../core/vdom.js';
import { OVERLAY } from '../runtime/overlays.js';
import { SPINE, allBranches, sequenceOf } from '../runtime/deck.js';
import { beatsOf } from '../runtime/nav.js';
import { buildJumpIndex, searchJump, highlightRuns, DEFAULT_LIMIT } from './jump-index.js';
import { anchorsOf, liveReturnTarget, returnTargetFor } from './graph.js';

/** Attribute the input bridge looks for. */
export const JUMP_INPUT_ATTR = 'data-pp-jump-input';
/** Attribute a clickable overlay control carries: a runtime command and its payload. */
export const COMMAND_ATTR = 'data-pp-command';
/** Attribute carrying the payload for `COMMAND_ATTR`. */
export const PAYLOAD_ATTR = 'data-pp-payload';

/**
 * The jump index's live state.
 *
 * Deliberately tiny and deliberately synchronous: a keystroke in a live room
 * must produce a new result list in the same tick it was typed.
 */
export class JumpController {
  /**
   * @param {import('../runtime/runtime.js').Runtime} runtime
   * @param {{limit?: number}} [options]
   */
  constructor(runtime, options = {}) {
    this.runtime = runtime;
    /** @type {import('./jump-index.js').JumpIndex|null} */
    this.builtIndex = null;
    this.limit = options.limit === undefined ? DEFAULT_LIMIT : options.limit;
    this.query = '';
    this.selection = 0;
    /** @type {{query: string, results: import('./jump-index.js').JumpMatch[]}|null} */
    this.cache = null;
  }

  /**
   * The index, built on first use rather than at registration.
   *
   * Registration happens during boot, and §12 gives the artifact 1.5s to first
   * meaningful paint from a local file. Nothing about the opening beat needs the
   * jump index, and a deck large enough for the build to cost anything is
   * exactly the deck that can least afford it before first paint. The first `/`
   * pays instead — single-digit milliseconds on a real deck, once per session.
   * @returns {import('./jump-index.js').JumpIndex}
   */
  get index() {
    if (!this.builtIndex) this.builtIndex = buildJumpIndex(this.runtime.deck);
    return this.builtIndex;
  }

  /** @returns {import('./jump-index.js').JumpMatch[]} */
  get results() {
    if (!this.cache || this.cache.query !== this.query) {
      this.cache = { query: this.query, results: searchJump(this.index, this.query, { limit: this.limit }) };
    }
    return this.cache.results;
  }

  /** @returns {import('./jump-index.js').JumpMatch|null} */
  get active() {
    const rows = this.results;
    if (rows.length === 0) return null;
    return rows[Math.max(0, Math.min(rows.length - 1, this.selection))] || null;
  }

  /**
   * @param {string} value
   * @returns {boolean} whether anything changed
   */
  setQuery(value) {
    const next = typeof value === 'string' ? value : '';
    if (next === this.query) return false;
    this.query = next;
    // A new query means a new list; keeping the old row index would jump the
    // presenter to whatever happened to land in that position.
    this.selection = 0;
    this.notify();
    return true;
  }

  /**
   * Move the highlighted row. Clamps rather than wrapping: wrapping past the
   * end of a short list is disorienting when you are not looking at the screen.
   * @param {number} delta
   * @returns {boolean}
   */
  move(delta) {
    const rows = this.results;
    if (rows.length === 0) return false;
    const next = Math.max(0, Math.min(rows.length - 1, this.selection + delta));
    if (next === this.selection) return false;
    this.selection = next;
    this.notify();
    return true;
  }

  /**
   * Jump to the highlighted branch and close the overlay.
   * @returns {boolean}
   */
  commit() {
    const row = this.active;
    if (!row) return false;
    const moved = this.runtime.run('jump', row.branchId);
    // Navigation closes the overlay through `handleNavigation`; a jump that
    // changed nothing (already inside that branch) still has to close, or the
    // presenter is left staring at a search field they already used.
    if (this.runtime.overlays.has(OVERLAY.jump)) this.runtime.overlays.close(OVERLAY.jump);
    this.reset();
    return moved;
  }

  /** Clear the query and the selection, without repainting. */
  reset() {
    this.query = '';
    this.selection = 0;
    this.cache = null;
  }

  /**
   * Handle a key pressed while the search field has focus. The runtime's keymap
   * hands arrows to the deck, which is right everywhere except here.
   * @param {{key: string}} event
   * @returns {boolean} whether the key was consumed
   */
  handleKey(event) {
    if (!event || typeof event.key !== 'string') return false;
    switch (event.key) {
      case 'ArrowDown': this.move(1); return true;
      case 'ArrowUp': this.move(-1); return true;
      case 'PageDown': this.move(5); return true;
      case 'PageUp': this.move(-5); return true;
      case 'Home': this.move(-this.results.length); return true;
      case 'End': this.move(this.results.length); return true;
      case 'Enter': this.commit(); return true;
      default: return false;
    }
  }

  /** Ask the host for a repaint. The overlay is a projection of this object. */
  notify() {
    if (this.runtime && typeof this.runtime.emit === 'function') {
      this.runtime.emit('change', { reason: 'branch:jump', state: this.runtime.snapshot() });
    }
  }
}

/**
 * Register the jump index, the branch map and the contents index on a runtime.
 *
 * The controller is exposed as `runtime.branchJump` so the DOM bridge, the
 * studio's rehearsal panel and the tests all drive the same object rather than
 * three copies of the same state.
 *
 * @param {import('../runtime/runtime.js').Runtime} runtime
 * @returns {() => void} unregister
 */
export function registerBranchOverlays(runtime) {
  const controller = new JumpController(runtime);
  runtime.branchJump = controller;

  /** @type {(() => void)[]} */
  const offs = [];

  offs.push(runtime.overlays.register({
    id: OVERLAY.jump,
    title: 'Jump to an objection',
    takesFocus: true,
    render: (ctx) => renderJumpOverlay(ctx, controller),
  }));

  offs.push(runtime.overlays.register({
    id: OVERLAY.map,
    title: 'Branch map',
    takesFocus: false,
    render: (ctx) => renderMapOverlay(ctx),
  }));

  offs.push(runtime.overlays.register({
    id: OVERLAY.contents,
    title: 'Contents',
    takesFocus: false,
    render: (ctx) => renderContentsOverlay(ctx),
  }));

  // Reopening `/` always starts from an empty field: the last search is a
  // record of the last objection, and the room has moved on.
  offs.push(runtime.overlays.on('change', (e) => {
    if (!e.open.includes(OVERLAY.jump) && (controller.query || controller.selection)) controller.reset();
  }));

  return () => {
    for (const off of offs.splice(0)) {
      try { off(); } catch { /* an already-removed registration is not an error */ }
    }
    if (runtime.branchJump === controller) delete runtime.branchJump;
  };
}

// -- jump -------------------------------------------------------------------

/**
 * The jump index overlay: a search field and an arrow-navigable result list.
 * @param {any} ctx      the runtime's overlay context
 * @param {JumpController} controller
 * @returns {import('../core/vdom.js').VNode}
 */
export function renderJumpOverlay(ctx, controller) {
  const rows = controller.results;
  const total = controller.index.entries.length;
  const selection = rows.length ? Math.max(0, Math.min(rows.length - 1, controller.selection)) : -1;
  const visited = new Set(ctx.visited || []);

  return h('div', { class: 'pp-overlay pp-overlay--jump', 'data-pp-overlay': OVERLAY.jump },
    h('h2', { class: 'pp-overlay-title', id: 'pp-jump-title' }, 'Jump to an objection'),
    h('div', { class: 'pp-jump-field' },
      h('input', {
        class: 'pp-jump-input',
        type: 'text',
        value: controller.query,
        placeholder: total ? 'Type the objection — three letters is usually enough' : 'This proof has no branches',
        autocomplete: 'off',
        autocapitalize: 'off',
        spellcheck: 'false',
        role: 'combobox',
        'aria-expanded': rows.length ? 'true' : 'false',
        'aria-controls': 'pp-jump-results',
        'aria-activedescendant': selection >= 0 ? `pp-jump-option-${selection}` : null,
        'aria-label': 'Search objections',
        [JUMP_INPUT_ATTR]: 'true',
      }),
      h('span', { class: 'pp-jump-count' }, `${rows.length}/${total}`)),
    rows.length
      ? h('ul', { class: 'pp-jump-results', id: 'pp-jump-results', role: 'listbox', 'aria-labelledby': 'pp-jump-title' },
        rows.map((row, i) => renderJumpRow(ctx, row, i, i === selection, visited)))
      : h('p', { class: 'pp-jump-empty' },
        total ? `Nothing matches “${controller.query}”.` : 'No objection branches are wired into this proof.'),
    h('p', { class: 'pp-overlay-foot' }, '↑↓ choose · Enter jumps · Esc closes'));
}

/**
 * One result row.
 * @param {any} ctx
 * @param {import('./jump-index.js').JumpMatch} row
 * @param {number} i
 * @param {boolean} selected
 * @param {Set<string>} visited
 * @returns {import('../core/vdom.js').VNode}
 */
function renderJumpRow(ctx, row, i, selected, visited) {
  const seq = ctx.deck.sequences.get(row.branchId);
  const shown = !!(seq && seq.scenes.some((s) => visited.has(s.id)));
  const objectionRanges = row.matchedField === 'objection' ? row.matched : [];
  const aliasHit = row.matchedField === 'alias' ? row : null;

  return h('li', {
    class: `pp-jump-result${selected ? ' pp-jump-result--active' : ''}${shown ? ' pp-jump-result--shown' : ''}`,
    id: `pp-jump-option-${i}`,
    role: 'option',
    'aria-selected': selected ? 'true' : 'false',
    'data-pp-branch': row.branchId,
    [COMMAND_ATTR]: 'jump',
    [PAYLOAD_ATTR]: row.branchId,
    tabindex: '-1',
  },
  h('span', { class: 'pp-jump-objection' },
    marked(row.objection || row.branchId, objectionRanges)),
  aliasHit
    ? h('span', { class: 'pp-jump-alias' }, 'also: ', marked(aliasHit.matchedText, aliasHit.matched))
    : null,
  h('span', { class: 'pp-jump-meta' },
    `${row.sceneCount} ${row.sceneCount === 1 ? 'scene' : 'scenes'}`,
    shown ? ' · shown' : '',
    row.anchored ? '' : ' · jump only'));
}

/**
 * Wrap the matched ranges of a string in `<mark>`, leaving the rest as text.
 * @param {string} text
 * @param {{start: number, end: number}[]} ranges
 * @returns {import('../core/vdom.js').VNode[]}
 */
export function marked(text, ranges) {
  return highlightRuns(text, ranges)
    .map((run) => (run.hit ? h('mark', { class: 'pp-jump-hit' }, run.text) : run.text));
}

// -- map --------------------------------------------------------------------

/**
 * The branch map (§11): where the presenter is, what has been shown, and what
 * is still available.
 *
 * "Knowing what you haven't shown yet is the difference between closing cleanly
 * and rambling" — so the unshown branches are the loudest thing on this panel,
 * and the count is stated in words rather than left to be counted.
 *
 * @param {any} ctx
 * @returns {import('../core/vdom.js').VNode}
 */
export function renderMapOverlay(ctx) {
  const { deck, nav } = ctx;
  const visited = new Set(ctx.visited || []);
  const branches = allBranches(deck);
  const shownOf = (seq) => seq.scenes.some((s) => visited.has(s.id));
  const shownCount = branches.filter(shownOf).length;
  const anchoredIds = new Set();
  for (const seq of branches) if (anchorsOf(deck, seq.id).length) anchoredIds.add(seq.id);

  return h('div', { class: 'pp-overlay pp-overlay--map', 'data-pp-overlay': OVERLAY.map },
    h('h2', { class: 'pp-overlay-title' }, 'Branch map'),
    renderHere(ctx),
    h('section', { class: 'pp-map-section' },
      h('h3', { class: 'pp-map-heading' }, 'The spine'),
      h('ol', { class: 'pp-map-spine' }, deck.spine.scenes.map((scene, i) => {
        const current = nav.sequenceId === SPINE && nav.sceneIndex === i;
        const anchorHere = (deck.anchorsByScene.get(scene.id) || [])
          .map((id) => deck.sequences.get(id)).filter(Boolean);
        return h('li', {
          class: `pp-map-scene${current ? ' pp-map-scene--current' : ''}${visited.has(scene.id) ? ' pp-map-scene--shown' : ''}`,
          'data-pp-scene': scene.id,
          [COMMAND_ATTR]: 'goToScene',
          [PAYLOAD_ATTR]: scene.id,
        },
        h('span', { class: 'pp-map-index' }, String(i + 1)),
        h('span', { class: 'pp-map-title' }, sceneTitle(scene, i)),
        h('span', { class: 'pp-map-state' }, current ? 'here' : visited.has(scene.id) ? 'shown' : 'ahead'),
        anchorHere.length
          ? h('ul', { class: 'pp-map-anchors' },
            anchorHere.map((seq) => renderBranchItem(deck, seq, visited, shownOf, new Set(), 0)))
          : null);
      }))),
    renderUnanchored(ctx, branches.filter((seq) => !anchoredIds.has(seq.id)), shownOf),
    h('p', { class: 'pp-map-summary' },
      branches.length === 0
        ? 'No objection branches are wired into this proof.'
        : `${shownCount} of ${branches.length} ${branches.length === 1 ? 'branch' : 'branches'} shown · ${branches.length - shownCount} still in reserve`),
    h('p', { class: 'pp-overlay-foot' }, '/ jumps · R returns to the spine · Esc closes'));
}

/**
 * One branch in the map, with the branches *it* offers nested underneath.
 *
 * A branch anchored from inside another branch is invisible on the spine, and
 * an available branch a presenter cannot see is an available branch they will
 * not use — so the map draws the anchor tree, not just its first level. Depth is
 * capped and the trail is tracked, because a proof may declare an anchor cycle
 * and a validation finding is a better answer than a hung overlay.
 *
 * @param {import('../runtime/deck.js').Deck} deck
 * @param {import('../runtime/deck.js').Sequence} seq
 * @param {Set<string>} visited
 * @param {(seq: import('../runtime/deck.js').Sequence) => boolean} shownOf
 * @param {Set<string>} trail
 * @param {number} depth
 * @returns {import('../core/vdom.js').VNode}
 */
function renderBranchItem(deck, seq, visited, shownOf, trail, depth) {
  const shown = shownOf(seq);
  const children = depth < 4 && !trail.has(seq.id) ? childBranches(deck, seq) : [];
  const nextTrail = new Set(trail).add(seq.id);

  return h('li', {
    class: `pp-map-anchor${shown ? ' pp-map-anchor--shown' : ''}`,
    'data-pp-branch': seq.id,
    [COMMAND_ATTR]: 'jump',
    [PAYLOAD_ATTR]: seq.id,
  },
  h('span', { class: 'pp-map-anchor-label' }, seq.objection || seq.id),
  h('span', { class: 'pp-map-state' }, shown ? 'shown' : 'ready'),
  children.length
    ? h('ul', { class: 'pp-map-anchors pp-map-anchors--nested' },
      children.map((child) => renderBranchItem(deck, child, visited, shownOf, nextTrail, depth + 1)))
    : null);
}

/**
 * The branches a branch's own scenes offer, in scene order.
 * @param {import('../runtime/deck.js').Deck} deck
 * @param {import('../runtime/deck.js').Sequence} seq
 * @returns {import('../runtime/deck.js').Sequence[]}
 */
function childBranches(deck, seq) {
  /** @type {import('../runtime/deck.js').Sequence[]} */
  const out = [];
  const seen = new Set();
  for (const scene of seq.scenes) {
    for (const id of deck.anchorsByScene.get(scene.id) || []) {
      if (seen.has(id) || id === seq.id) continue;
      seen.add(id);
      const child = deck.sequences.get(id);
      if (child) out.push(child);
    }
  }
  return out;
}

/**
 * The "you are here" block, including where a return would land.
 * @param {any} ctx
 * @returns {import('../core/vdom.js').VNode}
 */
function renderHere(ctx) {
  const { deck, nav, scene } = ctx;
  const seq = sequenceOf(deck, nav.sequenceId);
  const beats = scene ? beatsOf(scene) : 1;
  const back = liveReturnTarget(deck, nav);
  const backScene = back ? (deck.sequences.get(back.sequenceId) || { scenes: [] }).scenes[back.sceneIndex] : null;

  return h('section', { class: 'pp-map-here' },
    h('h3', { class: 'pp-map-heading' }, 'You are here'),
    h('p', { class: 'pp-map-here-line' },
      h('span', { class: 'pp-map-here-seq' }, seq.kind === 'spine' ? 'Spine' : (seq.objection || seq.id)),
      h('span', { class: 'pp-map-here-scene' },
        ` · scene ${nav.sceneIndex + 1} of ${seq.scenes.length} · beat ${nav.beatIndex + 1} of ${beats}`)),
    scene ? h('p', { class: 'pp-map-here-title' }, sceneTitle(scene, nav.sceneIndex)) : null,
    back
      ? h('p', { class: 'pp-map-here-return' },
        `Return → ${backScene ? sceneTitle(backScene, back.sceneIndex) : 'the spine'}`,
        h('span', { class: 'pp-map-here-policy' },
          back.unwindsAll ? ' (unwinds the whole detour)' : ` (depth ${nav.stack.length})`))
      : null);
}

/**
 * Branches with no anchor: reachable only from the jump index. They are listed
 * separately because a presenter cannot stumble into them — they have to be
 * remembered.
 * @param {any} ctx
 * @param {import('../runtime/deck.js').Sequence[]} loose
 * @param {(seq: import('../runtime/deck.js').Sequence) => boolean} shownOf
 * @returns {import('../core/vdom.js').VNode}
 */
function renderUnanchored(ctx, loose, shownOf) {
  if (loose.length === 0) return null;
  return h('section', { class: 'pp-map-section' },
    h('h3', { class: 'pp-map-heading' }, 'Reachable only from the jump index'),
    h('ul', { class: 'pp-map-loose' }, loose.map((seq) => h('li', {
      class: `pp-map-anchor${shownOf(seq) ? ' pp-map-anchor--shown' : ''}`,
      'data-pp-branch': seq.id,
      [COMMAND_ATTR]: 'jump',
      [PAYLOAD_ATTR]: seq.id,
    },
    h('span', { class: 'pp-map-anchor-label' }, seq.objection || seq.id),
    h('span', { class: 'pp-map-state' },
      returnTargetFor(ctx.deck, seq.id) ? (shownOf(seq) ? 'shown' : 'ready') : 'no declared return')))));
}

// -- contents ---------------------------------------------------------------

/**
 * The §2 contents index: the spine, numbered, jumpable, self-paced.
 *
 * Review mode is a document someone reads on their own after the meeting, so
 * this panel names scenes and nothing else — no presenter notes, no branch
 * inventory, no sense that they are missing a performance.
 *
 * @param {any} ctx
 * @returns {import('../core/vdom.js').VNode}
 */
export function renderContentsOverlay(ctx) {
  const { deck, nav } = ctx;
  const visited = new Set(ctx.visited || []);
  const scenes = deck.spine.scenes;

  return h('div', { class: 'pp-overlay pp-overlay--contents', 'data-pp-overlay': OVERLAY.contents },
    h('h2', { class: 'pp-overlay-title' }, 'Contents'),
    scenes.length
      ? h('ol', { class: 'pp-contents-list' }, scenes.map((scene, i) => {
        const current = nav.sequenceId === SPINE && nav.sceneIndex === i;
        return h('li', {
          class: `pp-contents-item${current ? ' pp-contents-item--current' : ''}${visited.has(scene.id) ? ' pp-contents-item--seen' : ''}`,
          'data-pp-scene': scene.id,
          [COMMAND_ATTR]: 'goToScene',
          [PAYLOAD_ATTR]: scene.id,
          tabindex: '0',
          role: 'link',
        },
        h('span', { class: 'pp-contents-index' }, String(i + 1)),
        h('span', { class: 'pp-contents-title' }, sceneTitle(scene, i)),
        scene.subhead ? h('span', { class: 'pp-contents-sub' }, scene.subhead) : null,
        h('span', { class: 'pp-contents-beats' },
          `${beatsOf(scene)} ${beatsOf(scene) === 1 ? 'step' : 'steps'}`));
      }))
      : h('p', { class: 'pp-jump-empty' }, 'This proof has no scenes.'),
    h('p', { class: 'pp-overlay-foot' },
      ctx.mode === 'review' ? 'Pick a section · Esc closes' : 'C closes this · / jumps to an objection'));
}

/**
 * A scene's display name, never empty — an untitled scene in a contents index
 * is worse than a numbered one.
 * @param {import('../core/contracts.d.ts').Scene} scene
 * @param {number} index
 * @returns {string}
 */
export function sceneTitle(scene, index) {
  if (!scene) return `Scene ${index + 1}`;
  const text = (scene.headline || scene.subhead || '').trim();
  return text || `Scene ${index + 1}`;
}
