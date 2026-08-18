/**
 * The eight layouts (§4, §10): they all render real content, they are pure
 * functions of their context, and none of them touches a document.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { toHtml, walk } from '../../src/core/vdom.js';
import { SCENE_LAYOUTS } from '../../src/core/contracts.js';
import {
  registeredLayouts, missingLayouts, resetLayouts, renderLayout, getLayout,
} from '../../src/runtime/layouts.js';
import {
  registerAllLayouts, LAYOUT_FUNCTIONS, layoutFunction, buildScene, sceneTemplates, renderSceneTree,
} from '../../src/scene/index.js';
import { layoutCases, contextFor, specimen, brandFixture } from '../fixtures/scene/content.mjs';

const SRC_SCENE = new URL('../../src/scene/', import.meta.url).pathname;

/** Every `.js` file the lane owns. */
function sceneSources(dir = SRC_SCENE, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sceneSources(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('all eight §4 layouts are registered, and only those', () => {
  resetLayouts();
  const off = registerAllLayouts();
  assert.deepEqual(registeredLayouts(), [...SCENE_LAYOUTS].sort());
  assert.deepEqual(missingLayouts(), []);
  for (const name of SCENE_LAYOUTS) assert.equal(typeof getLayout(name), 'function', name);
  off();
  assert.deepEqual(registeredLayouts(), []);
});

test('every layout renders realistic content: headings, prose, lists, tables, media, renditions', () => {
  for (const testCase of layoutCases()) {
    const scene = buildScene(testCase);
    const ctx = contextFor(scene, { specimen: testCase.specimen, renditions: testCase.renditions });
    const html = toHtml(renderSceneTree(scene, ctx));

    assert.ok(html.length > 400, `${testCase.layout} rendered ${html.length} bytes`);
    assert.ok(html.includes(`data-pp-layout="${testCase.layout}"`), `${testCase.layout} identifies itself`);
    assert.ok(html.includes('data-pp-el='), `${testCase.layout} has at least one revealable element`);
    assert.ok(html.includes('data-pp-tx='), `${testCase.layout} has at least one measured text run`);
    assert.ok(!/undefined|\[object Object\]|NaN/.test(html), `${testCase.layout} rendered a stringified nothing`);
  }
});

test('a layout is a pure function: the same context renders byte-identical HTML twice', () => {
  for (const testCase of layoutCases()) {
    const scene = buildScene(testCase);
    const ctx = contextFor(scene, { specimen: testCase.specimen, renditions: testCase.renditions });
    const first = toHtml(renderSceneTree(scene, ctx));
    const second = toHtml(renderSceneTree(scene, ctx));
    assert.equal(first, second, `${testCase.layout} is not deterministic`);

    // …and a second, independently built context with the same model agrees.
    const ctxAgain = contextFor(scene, { specimen: testCase.specimen, renditions: testCase.renditions });
    assert.equal(toHtml(renderSceneTree(scene, ctxAgain)), first, `${testCase.layout} depends on context identity`);
  }
});

test('no layout reads a document, a window, or a clock', () => {
  const banned = [
    /\bdocument\b/, /\bwindow\b/, /\bglobalThis\b/, /\bnavigator\b/,
    /\bgetComputedStyle\b/, /\brequestAnimationFrame\b/,
    /\bMath\s*\.\s*random\b/, /\bDate\s*\.\s*now\b/, /\bnew\s+Date\b/,
  ];
  for (const file of sceneSources()) {
    const source = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');
    for (const re of banned) {
      assert.ok(!re.test(source), `${file} references ${re}`);
    }
  }
});

test('layouts run with no document in scope at all', () => {
  const trap = new Proxy({}, {
    get() { throw new Error('a layout touched the document'); },
    set() { throw new Error('a layout touched the document'); },
  });
  const hadDocument = 'document' in globalThis;
  Object.defineProperty(globalThis, 'document', { value: trap, configurable: true, writable: true });
  try {
    for (const testCase of layoutCases()) {
      const scene = buildScene(testCase);
      const ctx = contextFor(scene, { specimen: testCase.specimen, renditions: testCase.renditions });
      toHtml(renderSceneTree(scene, ctx));
    }
  } finally {
    if (hadDocument) delete globalThis.document;
    else delete globalThis.document;
  }
});

test('every layout survives an empty scene, and says what is missing rather than blanking', () => {
  for (const layout of SCENE_LAYOUTS) {
    const scene = buildScene({ layout, specimen: null, renditions: [], headline: null, subhead: null });
    const ctx = contextFor(scene, { specimen: null, renditions: [] });
    const html = toHtml(renderSceneTree(scene, ctx));
    assert.ok(html.length > 0, `${layout} rendered nothing`);
    assert.ok(/pp-empty|pp-layout/.test(html), `${layout} produced no recognisable frame`);
  }
});

test('every layout survives a brandless context, a medialess context and a headline-only scene', () => {
  for (const layout of SCENE_LAYOUTS) {
    const scene = buildScene({ layout, specimen: specimen(), renditions: [], headline: 'Only a headline' });
    const bare = { ...contextFor(scene, { specimen: specimen(), renditions: [] }), brand: null, media: new Map() };
    const html = toHtml(renderSceneTree(scene, bare));
    assert.ok(html.includes('data-pp-layout'), layout);
    assert.ok(!html.includes('undefined'), `${layout} leaked an undefined`);
  }
});

test('renderLayout dispatches every scene through the registered function', () => {
  resetLayouts();
  const off = registerAllLayouts();
  try {
    for (const testCase of layoutCases()) {
      const scene = buildScene(testCase);
      const ctx = contextFor(scene, { specimen: testCase.specimen, renditions: testCase.renditions });
      const viaRegistry = toHtml(renderLayout(ctx));
      const viaFunction = toHtml(layoutFunction(testCase.layout)(ctx));
      assert.equal(viaRegistry, viaFunction, testCase.layout);
      assert.ok(!viaRegistry.includes('pp-layout--placeholder'), `${testCase.layout} fell through to the placeholder`);
    }
  } finally { off(); }
});

test('sceneTemplates offers all eight, each with a name and a one-line description', () => {
  const templates = sceneTemplates();
  assert.equal(templates.length, SCENE_LAYOUTS.length);
  assert.deepEqual([...templates.map((t) => t.layout)].sort(), [...SCENE_LAYOUTS].sort());
  for (const t of templates) {
    assert.ok(t.name && t.name.length <= 40, `${t.layout}: name`);
    assert.ok(t.describe && t.describe.length > 40, `${t.layout}: description is a real sentence`);
    assert.ok(!t.describe.includes('\n'), `${t.layout}: one line`);
    assert.equal(typeof LAYOUT_FUNCTIONS[t.layout], 'function');
  }
});

test('a layout never renders a raw block as markup, nor a call-to-action href', () => {
  const withRaw = specimen();
  const scene = buildScene({ layout: 'splitBeforeAfter', specimen: withRaw, renditions: [], headline: 'Raw' });
  const ctx = contextFor(scene, { specimen: withRaw, renditions: [] });
  const html = toHtml(renderSceneTree(scene, ctx));
  assert.ok(!html.includes('<div class="legacy-widget">'), 'raw markup reached the artifact');
  assert.ok(html.includes('Stock availability updates every fifteen minutes.'), 'raw content is shown as text');
  assert.ok(html.includes('Request a fit check'), 'the CTA label is shown');
  assert.ok(!/href=/.test(html), 'no href reached the artifact');
});

test('a media reference that is not a data URI renders a visible gap, never a request', () => {
  const blocks = [{ type: 'media', ref: 'md_broken', caption: 'A diagram' }];
  const spec = specimen({ blocks });
  const scene = buildScene({ layout: 'splitBeforeAfter', specimen: spec, renditions: [], headline: 'Missing asset' });
  const ctx = contextFor(scene, { specimen: spec, renditions: [] });
  const html = toHtml(renderSceneTree(scene, ctx));
  assert.ok(html.includes('Image not included in this build'));
  assert.ok(!html.includes('blob:'), 'a non-data URI reached the markup');
});

test('every src attribute a layout emits is a data URI', () => {
  for (const testCase of layoutCases()) {
    const scene = buildScene(testCase);
    const ctx = contextFor(scene, { specimen: testCase.specimen, renditions: testCase.renditions });
    const tree = renderSceneTree(scene, ctx);
    walk(tree, (el) => {
      for (const [key, value] of Object.entries(el.a || {})) {
        if (key !== 'src' && key !== 'href') continue;
        assert.ok(typeof value === 'string' && value.startsWith('data:'),
          `${testCase.layout}: ${key}="${String(value).slice(0, 40)}"`);
      }
      return undefined;
    });
  }
});

test('the brand drives the type, not a constant in a layout', () => {
  const testCase = layoutCases()[0];
  const scene = buildScene(testCase);
  const ctx = contextFor(scene, { specimen: testCase.specimen, renditions: testCase.renditions, brand: brandFixture() });
  const html = toHtml(renderSceneTree(scene, ctx));
  assert.ok(!/font-family:/i.test(html), 'a layout hard-coded a font family into the markup');
  assert.ok(!/#[0-9a-fA-F]{6}/.test(html), 'a layout hard-coded a colour into the markup');
});
