/**
 * The overlay stack and the runtime's chrome state (§11, §12).
 *
 * Escape closes the topmost overlay and nothing else. Blanking never moves the
 * deck. Presenter view is entered explicitly and is unavailable in a Review
 * build, because a Review build was emitted without the notes it would show.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { OverlayStack, OVERLAY, trapFocus, focusableWithin } from '../../src/runtime/overlays.js';
import { Runtime } from '../../src/runtime/runtime.js';
import { h, toHtml } from '../../src/core/vdom.js';
import { makeProof } from '../fixtures/make-proof.mjs';

function stackWith(...ids) {
  const s = new OverlayStack();
  for (const id of ids) {
    s.register({ id, title: id, takesFocus: id === 'jump', dismissOnNavigate: id === 'help' ? false : undefined, render: () => h('div', null, id) });
  }
  return s;
}

test('overlays stack, and Escape closes the topmost only', () => {
  const s = stackWith('jump', 'map', 'help');
  s.open('jump');
  s.open('map');
  assert.deepEqual(s.stack, ['jump', 'map']);
  assert.equal(s.top, 'map');
  assert.equal(s.close(), 'map');
  assert.equal(s.top, 'jump');
  assert.equal(s.close(), 'jump');
  assert.equal(s.top, null);
  assert.equal(s.close(), null, 'closing nothing is not an error');
});

test('opening an already-open overlay raises it instead of duplicating it', () => {
  const s = stackWith('jump', 'map');
  s.open('jump');
  s.open('map');
  s.open('jump');
  assert.deepEqual(s.stack, ['map', 'jump']);
  assert.equal(s.stack.filter((x) => x === 'jump').length, 1);
});

test('toggle opens, closes and raises', () => {
  const s = stackWith('map', 'help');
  assert.equal(s.toggle('map'), true);
  assert.equal(s.toggle('map'), false);
  s.open('help');
  s.open('map');
  assert.equal(s.toggle('help'), true, 'toggling a buried overlay raises it');
  assert.equal(s.top, 'help');
});

test('an unregistered overlay cannot be opened', () => {
  const s = stackWith('map');
  assert.equal(s.open('ghost'), false);
  assert.deepEqual(s.stack, []);
});

test('closing a named overlay pulls it out of the middle of the stack', () => {
  const s = stackWith('jump', 'map', 'help');
  s.open('jump'); s.open('map'); s.open('help');
  assert.equal(s.close('map'), 'map');
  assert.deepEqual(s.stack, ['jump', 'help']);
  assert.equal(s.close('map'), null);
});

test('navigating dismisses position overlays but keeps the ones that opted out', () => {
  const s = stackWith('jump', 'map', 'help');
  s.open('help');
  s.open('map');
  s.handleNavigation();
  assert.deepEqual(s.stack, ['help'], 'the map describes a position, so moving invalidates it');
});

test('the stack announces every change once', () => {
  const s = stackWith('map');
  const reasons = [];
  s.on('change', (e) => reasons.push(e.reason));
  s.open('map'); s.close(); s.open('map'); s.closeAll(); s.closeAll();
  assert.deepEqual(reasons, ['open', 'close', 'open', 'closeAll']);
});

test('focus is remembered on the way in and handed back on the way out', () => {
  const s = stackWith('jump');
  const button = { name: 'the button that opened it' };
  s.open('jump', { activeElement: button });
  assert.equal(s.takeFocusBefore(), button);
  assert.equal(s.takeFocusBefore(), null, 'it is handed back once');
});

test('focus containment cycles inside the overlay', () => {
  // A minimal DOM stand-in: enough shape for the trap, no browser required.
  const make = (id) => ({ id, focused: false, focus() { this.focused = true; }, hasAttribute: () => false, getAttribute: () => null });
  const a = make('a');
  const b = make('b');
  const root = {
    contains: (el) => el === a || el === b,
    querySelectorAll: () => [a, b],
    ownerDocument: { activeElement: b },
  };
  assert.equal(trapFocus(root, { key: 'Tab', preventDefault() {} }), true);
  assert.equal(a.focused, true, 'Tab past the last control wraps to the first');

  root.ownerDocument.activeElement = a;
  assert.equal(trapFocus(root, { key: 'Tab', shiftKey: true, preventDefault() {} }), true);
  assert.equal(b.focused, true);

  root.ownerDocument.activeElement = a;
  assert.equal(trapFocus(root, { key: 'Enter' }), false, 'only Tab is trapped');
  assert.deepEqual(focusableWithin(null), []);
});

// --------------------------------------------------------------- runtime

test('the help overlay is registered by the runtime and renders the bindings', () => {
  const runtime = new Runtime(makeProof());
  assert.equal(runtime.run('toggleHelp'), true);
  assert.equal(runtime.overlays.top, OVERLAY.help);
  const html = toHtml(runtime.render());
  assert.ok(html.includes('pp-overlay--help'));
  assert.ok(html.includes('Next beat'));
  assert.ok(html.includes('aria-modal="true"'));
  assert.equal(runtime.run('escape'), true);
  assert.equal(runtime.overlays.top, null);
});

test('blanking hides the scene without moving the deck', () => {
  const runtime = new Runtime(makeProof());
  runtime.run('nextBeat');
  const before = runtime.nav.beatIndex;
  assert.equal(runtime.run('toggleBlank'), true);
  assert.equal(runtime.blanked, true);
  assert.equal(runtime.nav.beatIndex, before, 'blanking is not navigation');
  const html = toHtml(runtime.render());
  assert.ok(html.includes('pp-stage--blank'));
  assert.ok(html.includes('class="pp-blank"'));
  assert.ok(html.includes('aria-hidden="true"'));
  assert.equal(runtime.run('escape'), true);
  assert.equal(runtime.blanked, false);
  assert.equal(runtime.nav.beatIndex, before);
});

test('Escape closes an overlay before it un-blanks', () => {
  const runtime = new Runtime(makeProof());
  runtime.run('toggleBlank');
  runtime.run('toggleHelp');
  runtime.run('escape');
  assert.equal(runtime.overlays.top, null);
  assert.equal(runtime.blanked, true, 'one Escape does one thing');
  runtime.run('escape');
  assert.equal(runtime.blanked, false);
});

test('presenter view is explicit, and absent from a Review build (§2)', () => {
  const both = new Runtime(makeProof({ emitOptions: { mode: 'both' } }));
  assert.equal(both.mode, 'review', 'a build a recipient can open defaults to Review');
  assert.equal(both.presenterAvailable, true);
  assert.equal(both.presenterOpen, false, 'presenter view is never assumed');
  assert.equal(both.run('togglePresenter'), true);
  assert.equal(both.presenterOpen, true);
  assert.equal(both.mode, 'presenter');

  const review = new Runtime(makeProof({ emitOptions: { mode: 'review', includePresenterNotes: false } }));
  assert.equal(review.presenterAvailable, false);
  assert.equal(review.run('togglePresenter'), false);
  assert.equal(review.presenterOpen, false);
});

test('the off-spine badge appears only in a branch and names the way back', () => {
  const runtime = new Runtime(makeProof());
  assert.ok(!toHtml(runtime.render()).includes('pp-branch-badge'));
  runtime.run('jump', 'bn_approvals');
  const html = toHtml(runtime.render());
  assert.ok(html.includes('pp-branch-badge'));
  assert.ok(html.includes('Our approvals process would never allow this'));
  assert.ok(html.includes('R to return'));
});

test('the stage carries the state hash, so a test can read it without a browser', () => {
  const runtime = new Runtime(makeProof());
  const html = toHtml(runtime.render());
  assert.ok(html.includes(`data-pp-hash="${runtime.hash()}"`));
  assert.ok(html.includes('data-pp-sequence="spine"'));
  assert.ok(html.includes('data-pp-beat="0"'));
});
