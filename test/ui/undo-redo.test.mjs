/**
 * §15: "Undo/redo across all model mutations with a command stack — required,
 * not optional, because scene assembly is destructive editing under time
 * pressure."
 *
 * The word that makes this hard to test honestly is *all*. A hand-written list
 * of mutations drifts from the interface the first time somebody adds an action
 * and forgets the test. So this file enumerates the mutations from the action
 * registry itself: every action marked `mutates` is driven with the argument it
 * declares in `sample()`, and three things are asserted for each one:
 *
 *   - the command stack grew (the mutation went through `app.mutate`, which is
 *     the only writer);
 *   - undo restores the *exact* prior document, deep-equal;
 *   - redo restores the mutated one, deep-equal.
 *
 * An action that mutates without a `sample` cannot load the registry at all —
 * `actionIndex` throws — so a new mutation cannot be added without a test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StudioApp } from '../../src/ui/app.js';
import { ACTIONS, actionIndex } from '../../src/ui/actions.js';
import { ProjectStore } from '../../src/core/storage.js';
import { fixtureDoc, fakeServices, makeClock } from '../fixtures/ui/studio-fixture.mjs';

/**
 * @param {object} [options]
 * @returns {Promise<any>}
 */
async function makeApp(options = {}) {
  const clock = makeClock();
  const store = await ProjectStore.open({ clock, indexedDB: null });
  const app = new StudioApp({
    document: null,
    window: null,
    store,
    clock,
    services: fakeServices({ clock, ...options }),
    doc: fixtureDoc(),
  });
  app.ui.settings.operator = 'Alex Mercer';
  return app;
}

const index = actionIndex(ACTIONS);

test('the registry is well formed and every mutating action declares a sample', () => {
  assert.ok(index.mutating.length >= 40, `expected a real inventory of mutations, found ${index.mutating.length}`);
  for (const action of index.mutating) {
    assert.equal(typeof action.sample, 'function', `${action.id} must declare a sample`);
  }
});

test('app.doc is a getter with no setter — there is exactly one writer', () => {
  const descriptor = Object.getOwnPropertyDescriptor(StudioApp.prototype, 'doc');
  assert.ok(descriptor, 'StudioApp must define a `doc` accessor');
  assert.equal(typeof descriptor.get, 'function');
  assert.equal(descriptor.set, undefined, 'a settable `doc` would be a second writer (§15)');
});

for (const action of index.mutating) {
  test(`${action.id} goes through the command stack and undoes exactly`, async () => {
    const app = await makeApp();
    const sample = action.sample(app) || {};
    const before = structuredClone(app.doc);
    const depthBefore = app.stack.history().length;

    const result = action.run(app, sample.arg === undefined ? null : sample.arg, {
      value: sample.value,
      element: sample.element || null,
      event: null,
    });
    if (result && typeof result.then === 'function') await result;

    const depthAfter = app.stack.history().length;
    const after = structuredClone(app.doc);

    assert.ok(
      depthAfter > depthBefore,
      `${action.id} did not push a command — every model mutation goes through app.mutate (§15)`,
    );
    assert.notDeepEqual(after, before, `${action.id} pushed a command but changed nothing`);

    // Undo the whole run: a single action may legitimately be a transaction.
    while (app.stack.history().length > depthBefore) app.stack.undo();
    assert.deepEqual(structuredClone(app.doc), before, `${action.id}: undo did not restore the prior document exactly`);

    while (app.stack.canRedo) app.stack.redo();
    assert.deepEqual(structuredClone(app.doc), after, `${action.id}: redo did not restore the mutated document exactly`);
  });
}

test('text edits coalesce into one undo step', async () => {
  const app = await makeApp();
  const depth = app.stack.history().length;
  for (const text of ['N', 'No', 'Nor', 'Nort', 'North']) {
    app.dispatch('project.setProspect', null, { value: text });
  }
  assert.equal(app.proof.prospectName, 'North');
  assert.equal(
    app.stack.history().length,
    depth + 1,
    'typing a name must be one undo step, not five (core/command.js coalesceKey)',
  );
  app.stack.undo();
  assert.equal(app.proof.prospectName, 'Northwind Industrial', 'one undo takes the whole run back');
});

test('two different fields do not coalesce into each other', async () => {
  const app = await makeApp();
  const depth = app.stack.history().length;
  app.dispatch('project.setProspect', null, { value: 'A' });
  app.dispatch('project.setName', null, { value: 'B' });
  assert.equal(app.stack.history().length, depth + 2);
});

test('a transaction is one undo entry', async () => {
  const app = await makeApp();
  const depth = app.stack.history().length;
  app.dispatch('brand.reviewAll');
  assert.equal(app.stack.history().length, depth + 1, 'reviewing every pending group is one act');
});

test('undo across a delete restores the deleted object and everything that referenced it', async () => {
  const app = await makeApp();
  const before = structuredClone(app.doc);
  const specimenId = app.proof.specimens[0].id;

  app.dispatch('specimen.remove', specimenId);
  assert.equal(app.proof.specimens.length, 0);
  assert.equal(app.proof.renditions.length, 0, 'removing a specimen removes its renditions');
  assert.equal(app.proof.spine[0].specimenId, null, 'and clears every reference to it');

  app.stack.undo();
  assert.deepEqual(structuredClone(app.doc), before, 'undo restores the specimen, its renditions and every reference');
});

test('an auto-fix is an ordinary command and can be undone with the rest', async () => {
  const app = await makeApp();
  app.ui.sweep = {
    findings: [{ id: 'fd_x', severity: 2, code: 'BEAT_EMPTY', message: 'A beat reveals nothing.', locus: {}, autoFixAvailable: true }],
    at: '2026-02-01T09:00:00.000Z',
    running: false,
    error: null,
    proofHash: null,
  };
  const before = structuredClone(app.doc);
  app.dispatch('rehearse.autoFix', '0');
  assert.notDeepEqual(structuredClone(app.doc), before);

  const entry = app.stack.history().at(-1);
  assert.ok(entry.meta && entry.meta.autoFix, 'an auto-fix is tagged so the log can show it (§14)');

  app.dispatch('rehearse.revertFixes');
  assert.deepEqual(structuredClone(app.doc), before, 'every auto-fix can be taken back');
});

test('a load resets the stack rather than pushing onto it', async () => {
  const app = await makeApp();
  app.dispatch('project.setProspect', null, { value: 'Changed' });
  assert.ok(app.stack.canUndo);
  app.loadRecord({ id: 'pj_other', name: 'Other', seed: 's', proof: fixtureDoc().proof, savedAt: null, revision: 1 });
  assert.equal(app.stack.canUndo, false, 'undo must not reach across a project switch');
});
