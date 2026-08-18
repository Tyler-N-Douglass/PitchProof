/**
 * The three branch overlays and the input bridge (§2, §11, §12).
 *
 * The overlays are pure VNode renderers, so everything below is asserted with
 * no browser: the same trees the emitter serializes and the host mounts. The
 * bridge — the one part of the lane that knows events exist — is driven through
 * a stub document that reproduces the capture/bubble ordering the real one has,
 * because the interesting bug lives exactly there: while the jump field has
 * focus, `ArrowDown` belongs to the result list and must never reach the deck.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Runtime } from '../../src/runtime/runtime.js';
import { OVERLAY } from '../../src/runtime/overlays.js';
import { toHtml, textOf, walk } from '../../src/core/vdom.js';
import { isTextEntry } from '../../src/runtime/host.js';
import {
  registerBranchOverlays, renderJumpOverlay, renderMapOverlay, renderContentsOverlay,
  JumpController, JUMP_INPUT_ATTR, COMMAND_ATTR, PAYLOAD_ATTR,
} from '../../src/branch/overlays.js';
import { installBranchInputBridge } from '../../src/branch/bridge.js';
import { objectionProof } from '../fixtures/branch/objections.mjs';
import { minimalProof } from '../fixtures/make-proof.mjs';

/** @param {object} [options] */
function runtimeWithOverlays(options = {}) {
  const runtime = new Runtime(objectionProof(), { mode: 'presenter', ...options });
  const unregister = registerBranchOverlays(runtime);
  return { runtime, unregister };
}

// -- registration -----------------------------------------------------------

test('all three overlays register, and the jump index takes focus', () => {
  const { runtime, unregister } = runtimeWithOverlays();

  for (const id of [OVERLAY.jump, OVERLAY.map, OVERLAY.contents]) {
    assert.ok(runtime.overlays.registry.has(id), `${id} did not register`);
  }
  assert.equal(runtime.overlays.registry.get(OVERLAY.jump).takesFocus, true,
    'the jump index contains a search field, so it must take focus (API.md)');
  assert.equal(runtime.overlays.registry.get(OVERLAY.map).takesFocus, false);
  assert.equal(runtime.overlays.registry.get(OVERLAY.contents).takesFocus, false);
  assert.equal(runtime.overlays.registry.get(OVERLAY.help).takesFocus, false, 'L2 keeps its help overlay');

  unregister();
  for (const id of [OVERLAY.jump, OVERLAY.map, OVERLAY.contents]) {
    assert.ok(!runtime.overlays.registry.has(id), `${id} survived unregistration`);
  }
  assert.equal(runtime.branchJump, undefined, 'the controller is released with the overlays');
  assert.doesNotThrow(() => unregister(), 'unregistering twice is not an error');
});

test('the keymap opens each overlay by its own key', () => {
  const { runtime, unregister } = runtimeWithOverlays();
  assert.equal(runtime.handleKey({ key: '/' }), 'openJump');
  assert.equal(runtime.overlays.top, OVERLAY.jump);
  assert.equal(runtime.handleKey({ key: 'm' }), 'toggleMap');
  assert.deepEqual(runtime.overlays.stack, [OVERLAY.jump, OVERLAY.map]);
  assert.equal(runtime.handleKey({ key: 'Escape' }), 'escape');
  assert.equal(runtime.overlays.top, OVERLAY.jump, 'Escape closes the topmost overlay only');
  assert.equal(runtime.handleKey({ key: 'Escape' }), 'escape');
  assert.equal(runtime.overlays.isOpen, false);

  assert.equal(runtime.handleKey({ key: 'c' }), 'toggleContents');
  assert.equal(runtime.overlays.top, OVERLAY.contents);
  unregister();
});

// -- purity -----------------------------------------------------------------

test('every overlay renders deterministically and touches no document', () => {
  const { runtime, unregister } = runtimeWithOverlays();
  runtime.run('goToScene', 'sc_spine_1');
  runtime.run('jump', 'bn_approvals');
  runtime.branchJump.setQuery('leg');

  for (const id of [OVERLAY.jump, OVERLAY.map, OVERLAY.contents]) {
    const def = runtime.overlays.registry.get(id);
    const once = def.render(runtime.overlayContext());
    const twice = def.render(runtime.overlayContext());
    assert.equal(toHtml(once), toHtml(twice), `${id} did not render identically twice`);

    // No handlers, no functions, no live objects: a tree that serializes is a
    // tree the emitter can write into the artifact's first paint.
    walk(once, (el) => {
      for (const [key, value] of Object.entries(el.a)) {
        assert.notEqual(typeof value, 'function', `${id}: attribute ${key} carries a function`);
        assert.ok(value === null || value === undefined || ['string', 'number', 'boolean', 'object'].includes(typeof value));
      }
    });
    assert.ok(toHtml(once).length > 40, `${id} rendered almost nothing`);
  }
  assert.equal(typeof globalThis.document, 'undefined', 'these tests must be running without a document');
  unregister();
});

test('the runtime renders the open overlay into the stage', () => {
  const { runtime, unregister } = runtimeWithOverlays();
  runtime.run('openJump');
  const html = toHtml(runtime.render());
  assert.ok(html.includes('pp-overlay-layer'), 'the overlay layer must be in the stage tree');
  assert.ok(html.includes('pp-overlay--jump'));
  assert.ok(html.includes(`${JUMP_INPUT_ATTR}="true"`));
  unregister();
});

// -- jump index -------------------------------------------------------------

test('the jump overlay lists every branch before a query is typed', () => {
  const { runtime, unregister } = runtimeWithOverlays();
  const tree = renderJumpOverlay(runtime.overlayContext(), runtime.branchJump);
  const text = textOf(tree);
  for (const objection of ['Our approvals process would never allow this', 'We already have a DAM']) {
    assert.ok(text.includes(objection), `the empty state must list ${JSON.stringify(objection)}`);
  }
  assert.ok(text.includes('6/6'), 'the count shows what is being searched');
  unregister();
});

test('typing narrows the list, highlights the match and marks the selection', () => {
  const { runtime, unregister } = runtimeWithOverlays();
  runtime.branchJump.setQuery('app');
  const html = toHtml(renderJumpOverlay(runtime.overlayContext(), runtime.branchJump));

  assert.ok(html.includes('<mark class="pp-jump-hit">app</mark>'), 'the matched characters must be marked');
  assert.ok(html.includes('aria-selected="true"'), 'the first result is highlighted');
  assert.equal((html.match(/role="option"/g) || []).length, 1, 'only the matching branch is listed');
  assert.ok(html.includes(`${PAYLOAD_ATTR}="bn_approvals"`));
  assert.ok(html.includes('value="app"'), 'the field renders the query it is searching');
  unregister();
});

test('arrow keys move the selection and clamp at both ends', () => {
  const { runtime, unregister } = runtimeWithOverlays();
  const c = runtime.branchJump;
  assert.equal(c.selection, 0);
  assert.equal(c.handleKey({ key: 'ArrowDown' }), true);
  assert.equal(c.selection, 1);
  assert.equal(c.active.branchId, c.results[1].branchId);
  c.handleKey({ key: 'ArrowUp' });
  assert.equal(c.selection, 0);
  c.handleKey({ key: 'ArrowUp' });
  assert.equal(c.selection, 0, 'the list clamps rather than wrapping');
  c.handleKey({ key: 'End' });
  assert.equal(c.selection, c.results.length - 1);
  c.handleKey({ key: 'ArrowDown' });
  assert.equal(c.selection, c.results.length - 1);
  assert.equal(c.handleKey({ key: 'q' }), false, 'an ordinary character is not the list\'s business');
  unregister();
});

test('Enter jumps to the highlighted branch, closes the overlay and clears the query', () => {
  const { runtime, unregister } = runtimeWithOverlays();
  runtime.run('goToScene', 'sc_spine_2');
  runtime.run('openJump');
  runtime.branchJump.setQuery('leg');
  assert.equal(runtime.branchJump.active.branchId, 'bn_legal');

  runtime.branchJump.handleKey({ key: 'Enter' });
  assert.equal(runtime.nav.sequenceId, 'bn_legal', 'Enter jumps');
  assert.deepEqual(runtime.nav.stack.map((f) => f.sequenceId), ['spine']);
  assert.equal(runtime.overlays.isOpen, false, 'the overlay closes behind the jump');
  assert.equal(runtime.branchJump.query, '', 'the next `/` starts from an empty field');
  unregister();
});

test('Enter on an empty result list does nothing at all', () => {
  const { runtime, unregister } = runtimeWithOverlays();
  runtime.run('openJump');
  const before = runtime.hash();
  runtime.branchJump.setQuery('zzzzz');
  assert.deepEqual(runtime.branchJump.results, []);
  runtime.branchJump.handleKey({ key: 'Enter' });
  assert.equal(runtime.nav.sequenceId, 'spine');
  assert.equal(runtime.hash(), before);
  unregister();
});

test('closing the overlay clears the query, so the next objection starts clean', () => {
  const { runtime, unregister } = runtimeWithOverlays();
  runtime.run('openJump');
  runtime.branchJump.setQuery('dam');
  assert.equal(runtime.branchJump.query, 'dam');
  runtime.overlays.close();
  assert.equal(runtime.branchJump.query, '', 'a closed jump index remembers nothing');
  assert.equal(runtime.branchJump.selection, 0);
  unregister();
});

test('a query change repaints exactly once', () => {
  const { runtime, unregister } = runtimeWithOverlays();
  let changes = 0;
  runtime.on('change', (e) => { if (e.reason === 'branch:jump') changes++; });
  runtime.branchJump.setQuery('da');
  runtime.branchJump.setQuery('da');
  runtime.branchJump.setQuery('dam');
  assert.equal(changes, 2, 'setting the same query again must not repaint');
  unregister();
});

test('a deck with no branches says so instead of rendering an empty box', () => {
  const runtime = new Runtime(minimalProof(), { mode: 'presenter' });
  const unregister = registerBranchOverlays(runtime);
  const text = textOf(renderJumpOverlay(runtime.overlayContext(), runtime.branchJump));
  assert.ok(text.includes('No objection branches are wired into this proof.'));
  assert.ok(textOf(renderMapOverlay(runtime.overlayContext())).includes('No objection branches'));
  unregister();
});

// -- branch map -------------------------------------------------------------

test('the branch map shows where the presenter is, what is shown and what is not', () => {
  const { runtime, unregister } = runtimeWithOverlays();
  runtime.run('goToScene', 'sc_spine_1');
  runtime.run('jump', 'bn_approvals');

  const tree = renderMapOverlay(runtime.overlayContext());
  const html = toHtml(tree);
  const text = textOf(tree);

  assert.ok(text.includes('You are here'));
  assert.ok(text.includes('Our approvals process would never allow this'), 'the branch is named where you are');
  assert.ok(text.includes('scene 1 of 2'), 'the position inside the branch is stated');
  assert.ok(text.includes('Return →'), 'where the return lands is stated, not left to memory');

  // Every spine scene appears, with its state, and the current one is marked.
  assert.equal((html.match(/data-pp-scene="/g) || []).length, 6);
  assert.ok(html.includes('pp-map-scene--shown'), 'shown scenes are marked');
  assert.ok(text.includes('ahead'), 'unshown scenes are marked too');

  // Branch availability is the point of the panel.
  assert.ok(text.includes('1 of 6 branches shown'));
  assert.ok(text.includes('5 still in reserve'));
  assert.ok(html.includes('pp-map-anchor--shown'), 'the branch just entered reads as shown');
  assert.ok(text.includes('Reachable only from the jump index'), 'unanchored branches are called out');
  assert.ok(text.includes("We're mid-replatform"));
  unregister();
});

test('the branch map marks a nested branch under the branch scene that offers it', () => {
  const { runtime, unregister } = runtimeWithOverlays();
  const html = toHtml(renderMapOverlay(runtime.overlayContext()));
  // bn_legal hangs off a scene inside bn_approvals, so it is not on the spine
  // list; it is reachable from the jump index, and the map says so.
  assert.ok(!html.includes('data-pp-branch="bn_legal"><span class="pp-map-anchor-label">Legal'),
    'a nested branch is not offered from the spine');
  assert.ok(html.includes('data-pp-branch="bn_approvals"'));
  unregister();
});

test('the map counts every branch as shown once its scenes have been seen', () => {
  const { runtime, unregister } = runtimeWithOverlays();
  for (const id of ['bn_approvals', 'bn_scale', 'bn_dam', 'bn_brand', 'bn_replatform', 'bn_legal']) {
    runtime.run('jump', id);
    runtime.run('returnToSpine');
  }
  const text = textOf(renderMapOverlay(runtime.overlayContext()));
  assert.ok(text.includes('6 of 6 branches shown'));
  assert.ok(text.includes('0 still in reserve'));
  unregister();
});

// -- contents ---------------------------------------------------------------

test('the contents index lists the spine, numbered and jumpable (§2)', () => {
  const { runtime, unregister } = runtimeWithOverlays({ mode: 'review' });
  const tree = renderContentsOverlay(runtime.overlayContext());
  const html = toHtml(tree);
  const text = textOf(tree);

  const spine = runtime.deck.spine.scenes;
  assert.equal((html.match(/class="pp-contents-item/g) || []).length, spine.length);
  spine.forEach((scene, i) => {
    assert.ok(html.includes(`${PAYLOAD_ATTR}="${scene.id}"`), `${scene.id} is not jumpable`);
    assert.ok(text.includes(String(i + 1)), 'every entry is numbered');
    assert.ok(text.includes(scene.headline), `${scene.id} has no title in the index`);
  });
  assert.ok(html.includes('pp-contents-item--current'), 'the current section is marked');
  assert.ok(text.includes('Pick a section'), 'review mode reads as self-paced');
  assert.ok(!text.includes('Our approvals process'), 'the contents index is the spine, not the branch inventory');
  unregister();
});

test('the contents index falls back to a number when a scene has no headline', () => {
  const proof = objectionProof();
  proof.spine[0].headline = null;
  proof.spine[0].subhead = null;
  const runtime = new Runtime(proof, { mode: 'review' });
  const unregister = registerBranchOverlays(runtime);
  assert.ok(textOf(renderContentsOverlay(runtime.overlayContext())).includes('Scene 1'));
  unregister();
});

// -- the DOM bridge ---------------------------------------------------------

/** A document stub with the capture/bubble ordering the real one has. */
function stubDocument() {
  /** @type {{type: string, fn: Function, capture: boolean}[]} */
  const listeners = [];
  return {
    addEventListener(type, fn, capture) { listeners.push({ type, fn, capture: !!capture }); },
    removeEventListener(type, fn, capture) {
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === !!capture);
      if (i >= 0) listeners.splice(i, 1);
    },
    listenerCount() { return listeners.length; },
    dispatch(event) {
      let stopped = false;
      const e = {
        ...event,
        preventDefault() { e.defaultPrevented = true; },
        stopPropagation() { stopped = true; },
        defaultPrevented: false,
      };
      for (const phase of [true, false]) {
        for (const l of listeners.slice()) {
          if (l.type !== e.type || l.capture !== phase) continue;
          if (stopped && !phase) continue;
          l.fn(e);
        }
      }
      return e;
    },
  };
}

/** The jump field as the bridge sees it. */
function jumpInput(value) {
  return {
    tagName: 'INPUT',
    value,
    hasAttribute: (name) => name === JUMP_INPUT_ATTR,
    getAttribute: (name) => (name === 'type' ? 'text' : null),
    closest: () => null,
  };
}

test('typing into the field searches, and the deck never moves', () => {
  const { runtime, unregister } = runtimeWithOverlays();
  const doc = stubDocument();
  const detach = installBranchInputBridge(runtime, { document: doc });
  // The host's own keydown listener, bound the way host.js binds it.
  doc.addEventListener('keydown', (event) => {
    runtime.handleKey(event, { typing: isTextEntry(event.target), activeElement: event.target });
  }, false);

  runtime.run('openJump');
  const before = runtime.nav.sceneIndex;

  for (const value of ['a', 'ap', 'app']) {
    doc.dispatch({ type: 'keydown', key: value[value.length - 1], target: jumpInput(value) });
    doc.dispatch({ type: 'input', target: jumpInput(value) });
  }
  assert.equal(runtime.branchJump.query, 'app');
  assert.equal(runtime.branchJump.results[0].branchId, 'bn_approvals');
  assert.equal(runtime.nav.sceneIndex, before, 'typing must never move the deck');

  detach();
  assert.equal(doc.listenerCount(), 1, 'the bridge removes exactly what it added');
  unregister();
});

test('ArrowDown moves the result selection instead of advancing the deck', () => {
  const { runtime, unregister } = runtimeWithOverlays();
  const doc = stubDocument();
  const detach = installBranchInputBridge(runtime, { document: doc });
  let deckMoves = 0;
  doc.addEventListener('keydown', (event) => {
    const command = runtime.handleKey(event, { typing: isTextEntry(event.target), activeElement: event.target });
    if (command === 'nextScene' || command === 'prevScene') deckMoves++;
  }, false);

  runtime.run('openJump');
  const input = jumpInput('');
  const down = doc.dispatch({ type: 'keydown', key: 'ArrowDown', target: input });

  assert.equal(runtime.branchJump.selection, 1, 'the list moved');
  assert.equal(deckMoves, 0, 'the deck did not');
  assert.equal(down.defaultPrevented, true, 'the browser must not scroll the field either');

  doc.dispatch({ type: 'keydown', key: 'ArrowUp', target: input });
  assert.equal(runtime.branchJump.selection, 0);

  detach();
  unregister();
});

test('Escape still reaches the runtime and closes the overlay', () => {
  const { runtime, unregister } = runtimeWithOverlays();
  const doc = stubDocument();
  const detach = installBranchInputBridge(runtime, { document: doc });
  doc.addEventListener('keydown', (event) => {
    runtime.handleKey(event, { typing: isTextEntry(event.target), activeElement: event.target });
  }, false);

  runtime.run('openJump');
  runtime.branchJump.setQuery('dam');
  doc.dispatch({ type: 'keydown', key: 'Escape', target: jumpInput('dam') });
  assert.equal(runtime.overlays.isOpen, false, 'Escape belongs to the overlay stack, not to the search field');
  assert.equal(runtime.branchJump.query, '');
  detach();
  unregister();
});

test('Enter in the field jumps, exactly as the arrow-selected row promised', () => {
  const { runtime, unregister } = runtimeWithOverlays();
  const doc = stubDocument();
  const detach = installBranchInputBridge(runtime, { document: doc });

  runtime.run('openJump');
  doc.dispatch({ type: 'input', target: jumpInput('bra') });
  doc.dispatch({ type: 'keydown', key: 'Enter', target: jumpInput('bra') });

  assert.equal(runtime.nav.sequenceId, 'bn_brand');
  assert.equal(runtime.overlays.isOpen, false);
  detach();
  unregister();
});

test('clicking a row in any overlay runs its declared command', () => {
  const { runtime, unregister } = runtimeWithOverlays();
  const doc = stubDocument();
  const detach = installBranchInputBridge(runtime, { document: doc });

  const row = {
    getAttribute: (name) => (name === COMMAND_ATTR ? 'jump' : name === PAYLOAD_ATTR ? 'bn_dam' : null),
  };
  const target = { closest: (sel) => (sel === `[${COMMAND_ATTR}]` ? row : null), hasAttribute: () => false };

  runtime.run('toggleMap');
  const click = doc.dispatch({ type: 'click', target });
  assert.equal(runtime.nav.sequenceId, 'bn_dam', 'the map is a control surface, not a poster');
  assert.equal(click.defaultPrevented, true);
  assert.equal(runtime.overlays.isOpen, false);

  const contentsRow = {
    getAttribute: (name) => (name === COMMAND_ATTR ? 'goToScene' : name === PAYLOAD_ATTR ? 'sc_spine_4' : null),
  };
  runtime.run('toggleContents');
  doc.dispatch({ type: 'click', target: { closest: () => contentsRow, hasAttribute: () => false } });
  assert.equal(runtime.nav.sequenceId, 'spine');
  assert.equal(runtime.deck.spine.scenes[runtime.nav.sceneIndex].id, 'sc_spine_4');

  detach();
  unregister();
});

test('a click outside any command control does nothing', () => {
  const { runtime, unregister } = runtimeWithOverlays();
  const doc = stubDocument();
  const detach = installBranchInputBridge(runtime, { document: doc });
  const before = runtime.hash();
  doc.dispatch({ type: 'click', target: { closest: () => null, hasAttribute: () => false } });
  assert.equal(runtime.hash(), before);
  detach();
  unregister();
});

test('the bridge is optional: without a document it is a no-op, not a crash', () => {
  const { runtime, unregister } = runtimeWithOverlays();
  assert.doesNotThrow(() => installBranchInputBridge(runtime, { document: null })());
  assert.doesNotThrow(() => installBranchInputBridge(runtime, {})());
  unregister();
});

test('a controller can be driven with no runtime listeners attached', () => {
  const runtime = new Runtime(objectionProof(), { mode: 'review' });
  const controller = new JumpController(runtime, { limit: 3 });
  controller.setQuery('legal');
  assert.ok(controller.results.length > 0 && controller.results.length <= 3, 'the limit is honoured');
  assert.equal(controller.active.branchId, 'bn_legal');
  controller.move(1);
  assert.equal(controller.selection, Math.min(1, controller.results.length - 1));
  controller.reset();
  assert.equal(controller.query, '');
});
