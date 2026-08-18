/**
 * §12's keyboard model. Every key the spec names is bound, every command a
 * binding can produce is handled, and modified keypresses stay the browser's.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { BINDINGS, resolveKey, bindingGroups, keyLabel, allCommands } from '../../src/runtime/keymap.js';
import { Runtime } from '../../src/runtime/runtime.js';
import { makeProof } from '../fixtures/make-proof.mjs';

/** @param {string} key @param {object} [extra] */
const ev = (key, extra = {}) => ({ key, ...extra });

test('every key §12 names is bound to the command §12 names', () => {
  const required = [
    [['ArrowRight', ' '], 'nextBeat'],
    [['ArrowLeft'], 'prevBeat'],
    [['ArrowDown'], 'nextScene'],
    [['ArrowUp'], 'prevScene'],
    [['/'], 'openJump'],
    [['m'], 'toggleMap'],
    [['b'], 'toggleBlank'],
    [['r'], 'returnToSpine'],
    [['p'], 'togglePresenter'],
    [['Escape'], 'escape'],
    [['Home'], 'firstScene'],
  ];
  for (const [keys, command] of required) {
    for (const key of keys) {
      const got = resolveKey(ev(key));
      assert.ok(got, `${key} is unbound`);
      assert.equal(got.command, command, `${key} should run ${command}`);
    }
  }
});

test('upper-case letters resolve the same as lower-case', () => {
  for (const [lower, upper] of [['m', 'M'], ['b', 'B'], ['r', 'R'], ['p', 'P'], ['c', 'C']]) {
    assert.equal(resolveKey(ev(upper)).command, resolveKey(ev(lower)).command);
  }
});

test('a modified keypress belongs to the browser, not the deck', () => {
  for (const mod of ['ctrlKey', 'metaKey', 'altKey']) {
    assert.equal(resolveKey(ev('ArrowRight', { [mod]: true })), null, mod);
    assert.equal(resolveKey(ev('r', { [mod]: true })), null, `${mod} + r must not steal reload`);
  }
  assert.ok(resolveKey(ev('ArrowRight', { shiftKey: true })), 'shift alone is fine');
});

test('while typing, the runtime keeps only Escape', () => {
  const typing = { overlay: 'jump', typing: true };
  assert.equal(resolveKey(ev('m'), typing), null, 'typing "m" into the search box must not open the map');
  assert.equal(resolveKey(ev('/'), typing), null);
  assert.equal(resolveKey(ev('b'), typing), null);
  assert.equal(resolveKey(ev('Escape'), typing).command, 'escape');
  // The arrows belong to the result list the field drives. Handing them to the
  // deck would walk the presentation behind the overlay while the presenter is
  // still typing — filed by L9 as a dispute against this file, and fixed here.
  assert.equal(resolveKey(ev('ArrowDown'), typing), null, 'arrowing the jump results must not advance the deck');
  assert.equal(resolveKey(ev('ArrowUp'), typing), null);
  assert.equal(resolveKey(ev('ArrowRight'), typing), null);
  assert.equal(resolveKey(ev('Enter'), typing), null, 'Enter is the list\'s, not the deck\'s');
});

test('a blank screen swallows navigation keys', () => {
  const blanked = { overlay: null, typing: false, blanked: true };
  assert.equal(resolveKey(ev('ArrowRight'), blanked), null, 'the deck must not advance behind a blank screen');
  assert.equal(resolveKey(ev('ArrowDown'), blanked), null);
  assert.equal(resolveKey(ev('b'), blanked).command, 'toggleBlank');
  assert.equal(resolveKey(ev('Escape'), blanked).command, 'escape');
  assert.equal(resolveKey(ev('p'), blanked).command, 'togglePresenter');
});

test('an unbound key resolves to nothing', () => {
  for (const key of ['q', 'z', 'F5', 'Tab', '1']) assert.equal(resolveKey(ev(key)), null, key);
  assert.equal(resolveKey(null), null);
  assert.equal(resolveKey({}), null);
});

test('every command a binding can produce is handled by the runtime', () => {
  const runtime = new Runtime(makeProof());
  const handled = new Set();
  for (const command of allCommands()) {
    // `run` returning false is legitimate (escape with nothing open); what is
    // not legitimate is falling through to the default branch, which is what
    // this asserts by checking the command is a known case.
    assert.doesNotThrow(() => runtime.run(command, 'bn_approvals'), command);
    handled.add(command);
  }
  assert.equal(handled.size, allCommands().length);
  assert.deepEqual([...handled].sort(), [...new Set(BINDINGS.map((b) => b.command))].sort());
});

test('the help overlay is generated from the binding table', () => {
  const groups = bindingGroups();
  assert.deepEqual(groups.map((g) => g.group), ['Navigate', 'Branch', 'Present']);
  assert.equal(groups.reduce((n, g) => n + g.bindings.length, 0), BINDINGS.length);
  assert.equal(keyLabel(BINDINGS[0]), '→ / Space / PgDn');
  assert.equal(keyLabel({ keys: ['m', 'M'], command: 'x', label: 'x', group: 'x' }), 'M');
});

test('the runtime translates keyboard events into deck movement', () => {
  const runtime = new Runtime(makeProof());
  assert.equal(runtime.nav.beatIndex, 0);
  assert.equal(runtime.handleKey(ev('ArrowRight')), 'nextBeat');
  assert.equal(runtime.nav.beatIndex, 1);
  assert.equal(runtime.handleKey(ev(' ')), 'nextBeat');
  assert.equal(runtime.nav.beatIndex, 2);
  assert.equal(runtime.handleKey(ev('ArrowLeft')), 'prevBeat');
  assert.equal(runtime.nav.beatIndex, 1);
  assert.equal(runtime.handleKey(ev('q')), null);
  assert.equal(runtime.handleKey(ev('ArrowRight'), { typing: true }), null);
});

test('preventDefault is called only for keys the runtime actually consumed', () => {
  const runtime = new Runtime(makeProof());
  let prevented = 0;
  runtime.handleKey({ key: 'ArrowRight', preventDefault: () => { prevented += 1; } });
  assert.equal(prevented, 1);
  runtime.handleKey({ key: 'q', preventDefault: () => { prevented += 1; } });
  assert.equal(prevented, 1);
});
