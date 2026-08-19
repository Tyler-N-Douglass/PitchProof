/**
 * The consuming side of `API.md` Part 3.
 *
 * `test/core/api-conformance.test.mjs` checks that each lane **publishes** the
 * surface it declared. Nothing checked that anyone **consumes** it — and that
 * asymmetry is exactly how §9's seed recipe library came to be built, tested,
 * published and unreachable from the shipped studio for a whole pass
 * (CRITIQUE-1 F14). A dependency stated in a document, tested from one end, is
 * not a dependency; it is a note.
 *
 * So: for every lane surface `src/ui/services.js` imports, every export
 * `API.md` declares must either be **called** in the adapter or **explained**
 * in `LANE_SURFACE_NOTES`. Wiring one costs a line; declining one costs a
 * sentence; forgetting one fails here.
 *
 * The lane list, the module paths and the export names are all read from
 * `API.md` and from the adapter's own import statements, so nothing in this
 * file has to be kept in step by hand.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANE_SURFACE_NOTES, LANE_MODULES, makeServices } from '../../src/ui/services.js';
import { makeClock } from '../fixtures/ui/studio-fixture.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const API = readFileSync(join(ROOT, 'API.md'), 'utf8');
const SERVICES = readFileSync(join(ROOT, 'src', 'ui', 'services.js'), 'utf8');

/**
 * The surfaces `API.md` Part 3 declares, per module path.
 * @returns {Map<string, string[]>}
 */
function declaredSurfaces() {
  const part3 = API.slice(API.indexOf('## Part 3'), API.indexOf('## Part 4'));
  // L12's own entry is the surface the studio *publishes*, not one it consumes.
  const headings = [...part3.matchAll(/^### (L\d+)[^\n]*—\s*`([^`]+)`\s*$/gm)]
    .map((m) => ({ module: m[2], at: m.index }));
  /** @type {Map<string, string[]>} */
  const out = new Map();
  headings.forEach((h, i) => {
    const body = part3.slice(h.at, i + 1 < headings.length ? headings[i + 1].at : part3.length);
    const fence = body.match(/```js\n([\s\S]*?)```/);
    if (!fence) return;
    const names = new Set();
    for (const line of fence[1].split('\n')) {
      const m = line.match(/^([A-Za-z_$][\w$]*)\s*[(:=]/);
      if (m) names.add(m[1]);
    }
    if (h.module !== 'src/ui/index.js') out.set(h.module, [...names]);
  });
  return out;
}

/**
 * The lane namespaces the adapter imports, read from its own import statements.
 * @returns {{ns: string, module: string}[]}
 */
function adapterImports() {
  return [...SERVICES.matchAll(/^import \* as (\w+) from '\.\.\/(.+?)';$/gm)]
    .map((m) => ({ ns: m[1], module: `src/${m[2]}` }));
}

const DECLARED = declaredSurfaces();
const IMPORTS = adapterImports();

test('API.md Part 3 declares a surface for every lane the studio imports', () => {
  assert.ok(DECLARED.size >= 9, `expected nine lane surfaces in API.md Part 3, parsed ${DECLARED.size}`);
  for (const { module } of IMPORTS) {
    assert.ok(DECLARED.has(module), `${module} is imported by the studio but declared nowhere in API.md Part 3`);
  }
});

test('the studio imports exactly the nine declared lane surfaces and nothing else', () => {
  const modules = IMPORTS.map((i) => i.module).sort();
  assert.deepEqual(modules, [...DECLARED.keys()].sort(), 'the adapter is the whole cross-lane seam');
  assert.equal(IMPORTS.length, LANE_MODULES.length);
});

test('no file under src/ui/** other than services.js imports another lane', () => {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.js')) files.push(p);
    }
  };
  walk(join(ROOT, 'src', 'ui'));
  const laneDirs = ['ingest', 'brand', 'specimen', 'recipe', 'scene', 'branch', 'emit', 'validate'];
  const offenders = [];
  for (const file of files) {
    if (file.endsWith(`${'services'}.js`)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/from '\.\.?\/(?:\.\.\/)?([a-z-]+)\//);
      if (m && laneDirs.includes(m[1])) offenders.push(`${file}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], 'every cross-lane call goes through the one adapter');
});

for (const { ns, module } of IMPORTS) {
  test(`every declared surface of ${module} is consumed or explained`, () => {
    const declared = DECLARED.get(module) || [];
    assert.ok(declared.length > 0, `${module} declares nothing, which cannot be right`);
    const notes = LANE_SURFACE_NOTES[module] || {};
    const unexplained = [];
    for (const name of declared) {
      const called = new RegExp(`\\b${ns}\\.${name}\\b`).test(SERVICES);
      if (called) continue;
      const note = notes[name];
      if (!note) { unexplained.push(name); continue; }
      assert.ok(
        typeof note === 'string' && note.length > 30,
        `${module}.${name} is declined with a note too short to be a reason: "${note}"`,
      );
    }
    assert.deepEqual(
      unexplained,
      [],
      `${module} declares ${unexplained.join(', ')} and the studio neither calls them nor says why. `
      + 'Wire them in src/ui/services.js, or add a reason to LANE_SURFACE_NOTES.',
    );
  });
}

test('LANE_SURFACE_NOTES explains only surfaces that exist and are unused', () => {
  const stale = [];
  for (const [module, notes] of Object.entries(LANE_SURFACE_NOTES)) {
    const declared = new Set(DECLARED.get(module) || []);
    const entry = IMPORTS.find((i) => i.module === module);
    for (const name of Object.keys(notes)) {
      if (!declared.has(name)) { stale.push(`${module}.${name} is not declared in API.md`); continue; }
      if (entry && new RegExp(`\\b${entry.ns}\\.${name}\\b`).test(SERVICES)) {
        stale.push(`${module}.${name} is explained as unused but is called`);
      }
    }
  }
  assert.deepEqual(stale, [], 'a stale note is worse than none: it explains away a wiring that exists');
});

test('the §9 seed recipe library is reachable from the studio, not merely published', async () => {
  // The regression this whole file exists for. Every one of these is a route a
  // seller can actually take: the library loads, it says which recipes fit the
  // specimen in hand, one runs, and all of them run.
  const services = makeServices({ clock: makeClock(), http: null });
  assert.equal(typeof services.renderRecipe, 'function');
  assert.equal(typeof services.renderAllRecipes, 'function');
  assert.equal(typeof services.recipesFor, 'function');
  assert.equal(typeof services.recipeAccepts, 'function');
  assert.equal(services.seedRecipes().length, 8, '§9: all eight');

  const { ACTIONS, actionIndex } = await import('../../src/ui/actions.js');
  const index = actionIndex(ACTIONS);
  for (const id of ['recipe.loadSeed', 'recipe.run', 'recipe.runAll']) {
    assert.ok(index.byId.has(id), `${id} must exist — a library nothing can run is a library nobody has`);
  }
  assert.ok(index.byId.get('recipe.run').mutates, 'running a recipe changes the model');
  assert.ok(index.byId.get('recipe.runAll').mutates);
});
