/**
 * The layout registry (§10) and the context every layout signs for.
 *
 * L8 owns the eight layouts. This asserts the boundary they build against:
 * the registry takes only the §4 names, a layout sees the scene and nothing of
 * the runtime's state, and an unregistered layout degrades legibly instead of
 * blanking the screen.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  registerLayout, getLayout, registeredLayouts, missingLayouts, resetLayouts,
  renderLayout, placeholderLayout,
} from '../../src/runtime/layouts.js';
import { SCENE_LAYOUTS } from '../../src/core/contracts.js';
import { Runtime } from '../../src/runtime/runtime.js';
import { h, toHtml } from '../../src/core/vdom.js';
import { makeProof, scene } from '../fixtures/make-proof.mjs';

test('only the eight layouts frozen in §4 can be registered', () => {
  resetLayouts();
  const off = registerLayout('stack', () => h('div', null, 'stack'));
  assert.equal(typeof getLayout('stack'), 'function');
  assert.deepEqual(registeredLayouts(), ['stack']);
  assert.throws(() => registerLayout(/** @type {any} */ ('carousel'), () => null), /not one of the eight layouts/);
  assert.throws(() => registerLayout('stack', /** @type {any} */ ('nope')), /must be a function/);
  off();
  assert.equal(getLayout('stack'), null);
});

test('missingLayouts names what L8 still owes', () => {
  resetLayouts();
  assert.deepEqual(missingLayouts(), SCENE_LAYOUTS);
  const off = registerLayout('stack', () => null);
  assert.ok(!missingLayouts().includes('stack'));
  off();
});

test('the layout context carries the scene and no runtime state', () => {
  resetLayouts();
  /** @type {any} */
  let seen = null;
  const off = registerLayout('splitBeforeAfter', (ctx) => { seen = ctx; return h('div', null, 'ok'); });
  const runtime = new Runtime(makeProof());
  toHtml(runtime.render());
  off();

  assert.ok(seen, 'the layout ran');
  assert.deepEqual(Object.keys(seen).sort(),
    ['brand', 'el', 'labelIllustrative', 'media', 'mode', 'renditions', 'scene', 'specimen'].sort());
  assert.equal(seen.scene.id, 'sc_spine_0');
  assert.equal(typeof seen.el, 'function');
  assert.match(seen.el('before/0'), /^el_[0-9a-f]{10}$/);
  assert.equal(seen.el('before/0'), seen.el('before/0'), 'element ids are stable');
  assert.notEqual(seen.el('before/0'), seen.el('before/1'));
  assert.equal(seen.labelIllustrative, true, '§9: labelling is on unless a build says otherwise');
});

test('an unregistered layout renders a legible placeholder, not a blank screen', () => {
  resetLayouts();
  const runtime = new Runtime(makeProof());
  const html = toHtml(runtime.render());
  assert.ok(html.includes('pp-layout--placeholder'));
  assert.ok(html.includes('Layout not registered'));
  assert.ok(html.includes('splitBeforeAfter'), 'it says which layout is missing');
  assert.ok(html.includes('Headline for sc_spine_0'), 'the scene content is still identifiable');
});

test('the placeholder is a pure function of the scene', () => {
  const ctx = { scene: scene('sc_p', 1, { layout: 'fanOut', subhead: 'Sub' }) };
  assert.equal(toHtml(placeholderLayout(ctx)), toHtml(placeholderLayout(ctx)));
});

test('renderLayout dispatches on the scene layout', () => {
  resetLayouts();
  const offA = registerLayout('stack', () => h('p', null, 'A'));
  const offB = registerLayout('fanOut', () => h('p', null, 'B'));
  assert.equal(toHtml(renderLayout({ scene: scene('s1', 1, { layout: 'stack' }) })), '<p>A</p>');
  assert.equal(toHtml(renderLayout({ scene: scene('s2', 1, { layout: 'fanOut' }) })), '<p>B</p>');
  offA(); offB();
});

test('the scene wrapper names the scene and the layout for the sweep to find', () => {
  resetLayouts();
  const runtime = new Runtime(makeProof());
  const html = toHtml(runtime.renderScene());
  assert.ok(html.includes('data-pp-scene="sc_spine_0"'));
  assert.ok(html.includes('data-pp-layout="splitBeforeAfter"'));
});

test('a proof with no scenes says so instead of rendering nothing', () => {
  const runtime = new Runtime({ ...makeProof(), spine: [], branches: [] });
  assert.ok(toHtml(runtime.render()).includes('This proof has no scenes'));
});
