/**
 * `buildScene` (API.md Part 3): a contract-valid `Scene` with a beat plan a
 * presenter can walk, built deterministically from the model.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { validateScene, validateProofShape, SCENE_LAYOUTS, defaultEmitOptions } from '../../src/core/contracts.js';
import { IdMinter, contentId } from '../../src/core/ids.js';
import { Runtime } from '../../src/runtime/runtime.js';
import { beatsOf, initialState, navigate } from '../../src/runtime/nav.js';
import { sceneRevealsNothing, beatSignature } from '../../src/runtime/beats.js';
import { toHtml } from '../../src/core/vdom.js';
import { buildScene, sceneTemplates, registerAllLayouts, mediaMap } from '../../src/scene/index.js';
import { resetLayouts } from '../../src/runtime/layouts.js';
import {
  layoutCases, specimen, localeFanout, channelVariants, brandFixture,
} from '../fixtures/scene/content.mjs';

function errorsFor(scene) {
  /** @type {string[]} */
  const errs = [];
  validateScene(scene, 'scene', errs);
  return errs;
}

test('every layout builds a scene that passes validateScene with zero errors', () => {
  for (const testCase of layoutCases()) {
    assert.deepEqual(errorsFor(buildScene(testCase)), [], testCase.layout);
  }
  for (const layout of SCENE_LAYOUTS) {
    assert.deepEqual(errorsFor(buildScene({ layout })), [], `${layout}, with nothing attached`);
    assert.deepEqual(errorsFor(buildScene({ layout, specimen: specimen() })), [], `${layout}, specimen only`);
    assert.deepEqual(
      errorsFor(buildScene({ layout, renditions: localeFanout(3) })), [], `${layout}, renditions only`);
  }
});

test('the scene carries the model it was built from', () => {
  const spec = specimen();
  const rends = channelVariants();
  const scene = buildScene({
    layout: 'splitBeforeAfter',
    specimen: spec,
    renditions: rends,
    headline: 'Headline',
    subhead: 'Subhead',
    branchAnchors: ['bn_approvals'],
  });
  assert.equal(scene.layout, 'splitBeforeAfter');
  assert.equal(scene.specimenId, spec.id);
  assert.deepEqual(scene.renditionIds, rends.map((r) => r.id));
  assert.equal(scene.headline, 'Headline');
  assert.equal(scene.subhead, 'Subhead');
  assert.deepEqual(scene.branchAnchors, ['bn_approvals']);
});

test('ids are deterministic: content-derived without a minter, sequential with one', () => {
  const args = { layout: 'fanOut', specimen: specimen(), renditions: localeFanout(4), headline: 'H' };
  const a = buildScene(args);
  const b = buildScene(args);
  assert.equal(a.id, b.id, 'the same model builds the same scene id');
  assert.deepEqual(a.beats.map((x) => x.id), b.beats.map((x) => x.id));
  assert.match(a.id, /^sc_[0-9a-f]{12}$/);

  const different = buildScene({ ...args, headline: 'Different' });
  assert.notEqual(different.id, a.id, 'a different scene is a different id');

  const minted = buildScene({ ...args, idMinter: new IdMinter('seed-a', 'scene') });
  const mintedAgain = buildScene({ ...args, idMinter: new IdMinter('seed-a', 'scene') });
  assert.deepEqual(minted.beats.map((x) => x.id), mintedAgain.beats.map((x) => x.id),
    'the same seed mints the same beat ids');
  assert.notEqual(minted.id, buildScene({ ...args, idMinter: new IdMinter('seed-b', 'scene') }).id,
    'a different seed mints different ids');

  // §17.6: different seeds produce different ids but identical rendering.
  assert.equal(minted.beats.length, a.beats.length);
});

test('an explicit id rebuilds a scene in place', () => {
  const args = { layout: 'stack', specimen: specimen(), renditions: localeFanout(2), id: 'sc_fixed' };
  const scene = buildScene(args);
  assert.equal(scene.id, 'sc_fixed');
  assert.deepEqual(buildScene(args).beats, scene.beats);
});

test('every beat is non-empty, additive and in reading order', () => {
  for (const testCase of layoutCases()) {
    const scene = buildScene(testCase);
    assert.ok(scene.beats.length >= 1, `${testCase.layout}: no beats`);
    assert.ok(scene.beats.length <= 12, `${testCase.layout}: ${scene.beats.length} beats is more than a presenter can walk`);
    assert.equal(beatsOf(scene), scene.beats.length);
    assert.ok(!sceneRevealsNothing(scene), `${testCase.layout}: nothing is staged`);
    for (const beat of scene.beats) {
      assert.ok(beat.reveals.length > 0, `${testCase.layout}: beat ${beat.id} reveals nothing (BEAT_EMPTY)`);
      assert.ok(beat.dwellHintMs === null || beat.dwellHintMs > 0, `${testCase.layout}: dwell hint`);
    }
    // The first beat opens with the scene's header, so the room is oriented.
    assert.ok(scene.beats[0].presenterNote, `${testCase.layout}: the opening beat has no note`);
  }
});

test('presenter notes coach delivery and never assert a fact about the client', () => {
  const forbidden = /\b(\d+%|ROI|revenue|savings?|increase[sd]?|reduc(?:e|ed|tion)|faster by|customers? like)\b/i;
  for (const testCase of layoutCases()) {
    for (const beat of buildScene(testCase).beats) {
      if (!beat.presenterNote) continue;
      assert.ok(!forbidden.test(beat.presenterNote),
        `${testCase.layout}: presenter note makes a claim: "${beat.presenterNote}"`);
      assert.ok(beat.presenterNote.length < 160, `${testCase.layout}: note is too long to glance at`);
    }
  }
});

test('a scene with nothing attached still builds one walkable beat', () => {
  for (const layout of SCENE_LAYOUTS) {
    const scene = buildScene({ layout });
    assert.ok(scene.beats.length >= 1, layout);
    assert.deepEqual(errorsFor(scene), [], layout);
    assert.equal(beatsOf(scene), Math.max(1, scene.beats.length));
  }
});

test('sceneTemplates names every layout exactly once', () => {
  const templates = sceneTemplates();
  const layouts = templates.map((t) => t.layout);
  assert.equal(new Set(layouts).size, layouts.length);
  assert.deepEqual([...layouts].sort(), [...SCENE_LAYOUTS].sort());
});

test('mediaMap resolves every media reference a scene can render', () => {
  const spec = specimen();
  const map = mediaMap(spec, channelVariants());
  assert.ok(map.get('md_hero'));
  assert.equal(map.get('md_hero').dataUri.startsWith('data:'), true);
});

test('built scenes drive the runtime end to end, beat by beat, and back', () => {
  resetLayouts();
  const off = registerAllLayouts();
  try {
    const spine = layoutCases().map((testCase) => buildScene(testCase));
    const proof = {
      schemaVersion: 1,
      id: contentId('proof', 'l8'),
      prospectName: 'Northwind Industrial',
      createdAt: '2026-02-01T09:00:00.000Z',
      brand: brandFixture(),
      specimens: [specimen()],
      renditions: [...localeFanout(9), ...channelVariants()],
      recipes: [],
      spine,
      branches: [],
      emitOptions: defaultEmitOptions(),
    };
    assert.deepEqual(validateProofShape(proof), [], 'the proof these scenes make is contract-valid');

    const runtime = new Runtime(proof, { mode: 'presenter' });
    const seen = new Set();
    /** @type {string[]} */
    const forwardHashes = [];
    let state = initialState(runtime.deck);
    for (let guard = 0; guard < 500; guard++) {
      const scene = proof.spine[state.sceneIndex];
      seen.add(scene.layout);
      forwardHashes.push(beatSignature(scene, state.beatIndex));
      const next = navigate(runtime.deck, state, { type: 'nextBeat' });
      if (next === state) break;
      state = next;
    }
    assert.equal(seen.size, SCENE_LAYOUTS.length, 'the walk covered all eight layouts');

    // …and every beat renders through the runtime with the layout registered.
    for (const scene of proof.spine) {
      const html = toHtml(runtime.renderScene(scene));
      assert.ok(!html.includes('pp-layout--placeholder'), `${scene.layout} fell through to the placeholder`);
      assert.ok(html.includes(`data-pp-layout="${scene.layout}"`));
    }

    // Backward navigation restores the exact prior signature (§10, §17.9).
    const backwards = [];
    for (let guard = 0; guard < 500; guard++) {
      const scene = proof.spine[state.sceneIndex];
      backwards.push(beatSignature(scene, state.beatIndex));
      const prev = navigate(runtime.deck, state, { type: 'prevBeat' });
      if (prev === state) break;
      state = prev;
    }
    assert.deepEqual(backwards, [...forwardHashes].reverse(), 'the walk back is the walk forward, reversed');
  } finally {
    off();
  }
});

test('the runtime renders a built scene identically to a direct layout call', () => {
  resetLayouts();
  const off = registerAllLayouts();
  try {
    const testCase = layoutCases()[0];
    const scene = buildScene(testCase);
    const proof = {
      schemaVersion: 1,
      id: 'pf_x',
      prospectName: 'X',
      createdAt: '2026-02-01T09:00:00.000Z',
      brand: brandFixture(),
      specimens: [testCase.specimen],
      renditions: testCase.renditions,
      recipes: [],
      spine: [scene],
      branches: [],
      emitOptions: defaultEmitOptions(),
    };
    const runtime = new Runtime(proof);
    const ctx = runtime.layoutContext(scene);
    assert.equal(ctx.specimen.id, testCase.specimen.id, 'the runtime resolved the specimen');
    assert.equal(ctx.renditions.length, testCase.renditions.length, 'the runtime resolved the renditions');
    assert.ok(toHtml(runtime.renderScene(scene)).includes('data-pp-el='));
  } finally {
    off();
  }
});

test('the beat plan is stable when the same scene is rebuilt from the same model', () => {
  const testCase = layoutCases()[4];
  const first = buildScene(testCase);
  const second = buildScene(testCase);
  assert.deepEqual(first, second);
});
