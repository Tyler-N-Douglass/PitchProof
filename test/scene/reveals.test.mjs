/**
 * The reveal system (§10, §4 `Beat.reveals`).
 *
 * Two properties, for every one of the eight layouts:
 *   - every element id a beat reveals exists in the tree the layout renders;
 *   - `applyBeat` at beat n shows exactly the union of beats 0..n — no more, no
 *     less — which is what makes backward navigation exact.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { collectByAttr, walk } from '../../src/core/vdom.js';
import { elementId } from '../../src/core/ids.js';
import { applyBeat } from '../../src/runtime/runtime.js';
import { beatFrame, revealedAt, REVEAL_ATTR } from '../../src/runtime/beats.js';
import { buildScene, renderSceneTree, collectGroups } from '../../src/scene/index.js';
import { layoutCases, contextFor } from '../fixtures/scene/content.mjs';

/** Element ids present in a rendered tree, in document order. */
function idsIn(tree) {
  return collectByAttr(tree, REVEAL_ATTR).map((el) => el.a[REVEAL_ATTR]);
}

/** The ids `applyBeat` marked revealed. */
function revealedIn(tree) {
  /** @type {string[]} */
  const out = [];
  walk(tree, (el) => {
    const id = el.a[REVEAL_ATTR];
    if (typeof id !== 'string') return undefined;
    const cls = String(el.a.class || '');
    if (cls.split(/\s+/).includes('pp-revealed')) out.push(id);
    return undefined;
  });
  return out;
}

function casesWithScenes() {
  return layoutCases().map((testCase) => {
    const scene = buildScene(testCase);
    const ctx = contextFor(scene, { specimen: testCase.specimen, renditions: testCase.renditions });
    return { testCase, scene, ctx, tree: renderSceneTree(scene, ctx) };
  });
}

test('every id a beat reveals exists in the rendered tree', () => {
  for (const { testCase, scene, tree } of casesWithScenes()) {
    const present = new Set(idsIn(tree));
    assert.ok(present.size > 0, `${testCase.layout} renders nothing revealable`);
    for (const beat of scene.beats) {
      for (const id of beat.reveals) {
        assert.ok(present.has(id), `${testCase.layout}: beat ${beat.id} reveals ${id}, which is not rendered`);
      }
    }
  }
});

test('the beat plan reveals every revealable element exactly once', () => {
  for (const { testCase, scene, tree } of casesWithScenes()) {
    const rendered = idsIn(tree);
    const revealed = scene.beats.flatMap((b) => b.reveals);
    assert.deepEqual([...revealed].sort(), [...rendered].sort(),
      `${testCase.layout}: the plan and the tree disagree`);
    assert.equal(new Set(revealed).size, revealed.length, `${testCase.layout}: an id is revealed twice`);
  }
});

test('reveals are additive: beat n shows exactly the union of beats 0..n', () => {
  for (const { testCase, scene, tree } of casesWithScenes()) {
    for (let n = 0; n < scene.beats.length; n++) {
      const applied = applyBeat(tree, beatFrame(scene, n));
      const expected = [...revealedAt(scene, n)].sort();
      const actual = [...revealedIn(applied)].sort();
      assert.deepEqual(actual, expected, `${testCase.layout} at beat ${n}`);

      // strictly additive: nothing shown at n-1 is hidden at n
      if (n > 0) {
        const before = [...revealedAt(scene, n - 1)];
        for (const id of before) assert.ok(actual.includes(id), `${testCase.layout}: beat ${n} hid ${id}`);
      }
    }
  }
});

test('applying a beat does not change the tree it was applied to', () => {
  for (const { testCase, scene, tree } of casesWithScenes()) {
    const before = JSON.stringify(tree);
    applyBeat(tree, beatFrame(scene, scene.beats.length - 1));
    assert.equal(JSON.stringify(tree), before, `${testCase.layout}: applyBeat mutated the layout's output`);
  }
});

test('elements not carrying data-pp-el are always visible — the provenance label among them', () => {
  for (const { testCase, scene, tree } of casesWithScenes()) {
    const applied = applyBeat(tree, beatFrame(scene, 0));
    walk(applied, (el) => {
      const cls = String(el.a.class || '');
      if (!cls.split(/\s+/).includes('pp-unrevealed')) return undefined;
      assert.ok(typeof el.a[REVEAL_ATTR] === 'string',
        `${testCase.layout}: an element without ${REVEAL_ATTR} was hidden`);
      return undefined;
    });
  }
});

test('element ids are the structural path minted by ctx.el, and stable across renders', () => {
  for (const { testCase, scene, ctx, tree } of casesWithScenes()) {
    const again = renderSceneTree(scene, ctx);
    assert.deepEqual(idsIn(again), idsIn(tree), `${testCase.layout}: ids moved between renders`);
    for (const id of idsIn(tree)) {
      assert.match(id, /^el_[0-9a-f]{10}$/, `${testCase.layout}: ${id} is not a minted element id`);
    }
  }
});

test('the same scene rendered in a different context mints the same ids', () => {
  for (const testCase of layoutCases()) {
    const scene = buildScene(testCase);
    const a = contextFor(scene, { specimen: testCase.specimen, renditions: testCase.renditions, mode: 'presenter' });
    const b = contextFor(scene, { specimen: testCase.specimen, renditions: testCase.renditions, mode: 'review' });
    assert.deepEqual(idsIn(renderSceneTree(scene, a)), idsIn(renderSceneTree(scene, b)),
      `${testCase.layout}: element ids depend on the mode`);
  }
});

test('element ids are a pure function of the scene id and the structural path', () => {
  const testCase = layoutCases()[0];
  const scene = buildScene(testCase);
  const ctx = contextFor(scene, { specimen: testCase.specimen, renditions: testCase.renditions });
  const tree = renderSceneTree(scene, ctx);
  const ids = new Set(idsIn(tree));
  for (const path of ['head', 'before/panel', 'before/block/0', 'after/rendition/0/panel', 'after/rendition/0/block/0']) {
    assert.ok(ids.has(elementId(scene.id, path)), `path "${path}" is not in the tree`);
  }
});

test('beat groups are contiguous and in document order', () => {
  for (const { testCase, scene, tree } of casesWithScenes()) {
    const groups = collectGroups(tree);
    assert.equal(groups.length, scene.beats.length, testCase.layout);
    groups.forEach((group, i) => {
      assert.deepEqual(scene.beats[i].reveals, group.ids, `${testCase.layout}: beat ${i} is not group "${group.key}"`);
    });
    const order = idsIn(tree);
    const flattened = groups.flatMap((g) => g.ids);
    // Every group's ids appear in document order within the group.
    for (const group of groups) {
      const positions = group.ids.map((id) => order.indexOf(id));
      assert.deepEqual(positions, [...positions].sort((x, y) => x - y), `${testCase.layout}: group "${group.key}"`);
    }
    assert.equal(new Set(flattened).size, flattened.length, `${testCase.layout}: an id is in two groups`);
  }
});
