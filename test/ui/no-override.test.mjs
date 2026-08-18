/**
 * §14: "Severity 1 findings block emit. There is no override flag. If a lane
 * proposes one, the critic rejects it."
 *
 * Two ways to check that, and both are here because either alone is weak.
 *
 * **Behavioural.** With a severity-1 finding present, every route to the
 * emitter — the action, the palette, the keyboard, the button — refuses, and
 * `services.emit` is never called.
 *
 * **Mechanical.** The source of `src/ui/**` is scanned: exactly one call site
 * reaches `services.emit`, it is inside `emit.run`, and `emit.run` consults
 * `emitBlockers` first. No file anywhere carries a bypass token. This is the
 * half that survives somebody adding a second path later.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toHtml } from '../../src/core/vdom.js';
import { StudioApp } from '../../src/ui/app.js';
import { ACTIONS, actionIndex } from '../../src/ui/actions.js';
import { emitBlockers } from '../../src/ui/gate.js';
import { renderAllPanels } from '../../src/ui/panels/index.js';
import { ProjectStore } from '../../src/core/storage.js';
import { fixtureDoc, fakeServices, makeClock, finding } from '../fixtures/ui/studio-fixture.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const UI = join(ROOT, 'src', 'ui');
const index = actionIndex(ACTIONS);

/** @param {string} dir @param {string[]} [out] @returns {string[]} */
function jsFiles(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) jsFiles(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

/**
 * @param {object} [options]
 * @returns {Promise<{app: any, calls: any[]}>}
 */
async function makeApp(options = {}) {
  const clock = makeClock();
  const store = await ProjectStore.open({ clock, indexedDB: null });
  const app = new StudioApp({
    document: null, window: null, store, clock,
    services: fakeServices({ clock, ...options }), doc: fixtureDoc(),
  });
  const calls = [];
  const realEmit = app.services.emit;
  app.services.emit = async (...args) => { calls.push(args); return realEmit(...args); };
  app.dispatch('brand.reviewAll');
  return { app, calls };
}

/**
 * Put the app into the one state where an emit is legal, so the tests that
 * expect a refusal are refusing for the reason under test and nothing else.
 * @param {any} app
 * @param {any[]} findings
 */
function withSweep(app, findings) {
  app.ui.sweep = { findings, at: app.clock(), running: false, error: null, proofHash: null };
}

test('a clean proof emits', async () => {
  const { app, calls } = await makeApp();
  withSweep(app, []);
  assert.equal(emitBlockers(app).canEmit, true, emitBlockers(app).blockers.map((b) => b.message).join(' | '));
  await app.dispatch('emit.run');
  assert.equal(calls.length, 1);
  assert.ok(app.ui.emit.result);
});

test('a severity-1 finding closes the emit and the emitter is never called', async () => {
  const { app, calls } = await makeApp();
  withSweep(app, [finding({ severity: 1, code: 'PROVENANCE_UNLABELED', message: 'An illustrative rendition has no label.' })]);

  const gate = emitBlockers(app);
  assert.equal(gate.canEmit, false);
  assert.ok(gate.blockers.some((b) => b.kind === 'PROVENANCE_UNLABELED'));

  await app.dispatch('emit.run');
  assert.equal(calls.length, 0, 'the emitter is not even asked');
  assert.equal(app.ui.emit.result, null);
  assert.ok(app.ui.notices.some((n) => n.tone === 'bad' && /Emit refused/.test(n.text)));
});

test('the refusal says exactly what and why', async () => {
  const { app } = await makeApp();
  withSweep(app, [
    finding({ id: 'fd_1', severity: 1, code: 'CONTRAST_FAIL', message: 'Body text on surfaceAlt is 3.1:1.', locus: { sceneId: 'sc_ui_1' } }),
    finding({ id: 'fd_2', severity: 1, code: 'NETWORK_REFERENCE', message: 'A stylesheet link survived inlining.' }),
  ]);
  app.ui.section = 'emit';
  const html = toHtml(renderAllPanels(app));
  assert.match(html, /CONTRAST_FAIL/);
  assert.match(html, /Body text on surfaceAlt is 3\.1:1\./);
  assert.match(html, /NETWORK_REFERENCE/);
  assert.match(html, /A stylesheet link survived inlining\./);
  assert.match(html, /There is no override/i, 'and it says so out loud');
});

test('no sweep at all is itself a blocker', async () => {
  const { app, calls } = await makeApp();
  app.ui.sweep = { findings: [], at: null, running: false, error: null, proofHash: null };
  assert.equal(emitBlockers(app).canEmit, false);
  await app.dispatch('emit.run');
  assert.equal(calls.length, 0, 'a proof that was never validated is not emitted');
});

test('a sweep that predates the current proof is a blocker', async () => {
  const { app, calls } = await makeApp();
  withSweep(app, []);
  app.ui.sweep.proofHash = 'a-hash-of-some-older-proof';
  const gate = emitBlockers(app);
  assert.equal(gate.canEmit, false);
  assert.ok(gate.blockers.some((b) => b.kind === 'STALE_PREFLIGHT'));
  await app.dispatch('emit.run');
  assert.equal(calls.length, 0);
});

test('an unreviewed low-confidence brand group is a blocker (§7)', async () => {
  const clock = makeClock();
  const store = await ProjectStore.open({ clock, indexedDB: null });
  const app = new StudioApp({
    document: null, window: null, store, clock, services: fakeServices({ clock }), doc: fixtureDoc(),
  });
  withSweep(app, []);
  const gate = emitBlockers(app);
  assert.ok(gate.blockers.some((b) => b.kind === 'BRAND_UNREVIEWED'), 'the fixture brand has a group below the floor');
  assert.equal(gate.canEmit, false);
  app.dispatch('brand.reviewAll');
  app.ui.sweep.proofHash = null;
  assert.equal(emitBlockers(app).canEmit, true, 'reviewing it releases the hold');
});

test('an unavailable validator is a blocker, not a shortcut', async () => {
  const { app, calls } = await makeApp({ status: { validate: false } });
  withSweep(app, []);
  const gate = emitBlockers(app);
  assert.ok(gate.blockers.some((b) => b.kind === 'VALIDATE_UNAVAILABLE'));
  await app.dispatch('emit.run');
  assert.equal(calls.length, 0);
});

test('the emitter refusing is honoured even when the studio gate was open', async () => {
  const { app } = await makeApp({
    emitResult: {
      html: '<html></html>',
      bytes: 10,
      findings: [{ id: 'fd_e', severity: 1, code: 'PROVENANCE_UNLABELED', message: 'An illustrative rendition rendered with no label.', locus: {}, autoFixAvailable: false }],
      degradations: [],
      compression: { mode: 'raw', modelBytes: 5, mediaBytes: 0 },
    },
  });
  withSweep(app, []);
  await app.dispatch('emit.run');
  assert.ok(app.ui.notices.some((n) => n.tone === 'bad' && /PROVENANCE_UNLABELED/.test(n.text)));
  assert.equal(index.byId.get('emit.download').enabled(app), true, 'the result is held for inspection');
  const html = toHtml(renderAllPanels(app));
  assert.match(html, /The emitter refused this proof/);
});

test('there is exactly one call site for the emitter in src/ui/**', () => {
  const hits = [];
  for (const file of jsFiles(UI)) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (/services\.emit\s*\(/.test(line)) hits.push(`${relative(ROOT, file)}:${i + 1}`);
    });
  }
  assert.equal(hits.length, 1, `expected one emit call site, found: ${hits.join(', ')}`);
  assert.match(hits[0], /src\/ui\/actions\.js/, 'and it is the emit action');
});

test('the one call site consults the gate first', () => {
  const source = readFileSync(join(UI, 'actions.js'), 'utf8');
  const start = source.indexOf("id: 'emit.run'");
  assert.ok(start > 0, 'the emit action exists');
  const body = source.slice(start, source.indexOf("id: 'emit.download'"));
  const gateAt = body.indexOf('emitBlockers(app)');
  const emitAt = body.indexOf('services.emit(');
  assert.ok(gateAt > 0, 'emit.run consults emitBlockers');
  assert.ok(emitAt > gateAt, 'and it does so before reaching the emitter');
  assert.match(body, /if \(!gate\.canEmit\)/, 'and returns when the gate is closed');
});

test('no bypass token exists anywhere in src/ui/**', () => {
  const banned = [
    /forceEmit/i, /emitAnyway/i, /overrideBlock/i, /ignoreFindings/i, /skipPreflight/i,
    /allowSeverity/i, /bypassGate/i, /--force/, /ignoreSeverity/i, /suppressFinding/i,
  ];
  const offenders = [];
  for (const file of jsFiles(UI)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const re of banned) {
        if (re.test(line)) offenders.push(`${relative(ROOT, file)}:${i + 1} ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [], 'a bypass token is a §14 violation regardless of whether it is reachable');
});

test('the gate function takes no bypass parameter', () => {
  assert.equal(emitBlockers.length, 1, 'emitBlockers(app) and nothing else — a second parameter is where an override would live');
});

test('no action in the registry offers an override', () => {
  for (const action of index.all) {
    assert.ok(
      !/override|force|anyway|bypass/i.test(action.label),
      `${action.id} is labelled "${action.label}", which reads like an override`,
    );
  }
  const emitting = index.all.filter((a) => /emit/i.test(a.id) && /run|emit the/i.test(a.label));
  assert.equal(emitting.length, 1, 'there is exactly one action that emits');
});
