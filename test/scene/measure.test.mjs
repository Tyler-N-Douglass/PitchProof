/**
 * `measureScene` completeness (§14, §22.2).
 *
 * The one property that matters: **every text run a layout renders comes back
 * in the measurement.** This is written as a real cross-check — the rendered
 * tree is walked here, in this file, by a walker that knows nothing about
 * `measure.js`, and every text node it finds must be accounted for. A layout
 * that renders text without reporting it fails here rather than shipping an
 * overflow the detector cannot see.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { BREAKPOINTS } from '../../src/core/contracts.js';
import { measureText, resolveFace } from '../../src/core/text-metrics.js';
import {
  buildScene, renderSceneTree, measureScene, stageBox, boxGeometry, TYPE_ROLES, styleForRole,
  textOverflowOf, displayUrl,
} from '../../src/scene/index.js';
import { layoutCases, contextFor, brandFixture, specimen, localeFanout } from '../fixtures/scene/content.mjs';

const BPS = ['sm', 'md', 'lg'];

/**
 * Every text node in a tree, with the `data-pp-tx` role of its nearest
 * ancestor. Written independently of src/scene/measure.js on purpose.
 */
function textRuns(node, role = null, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (Array.isArray(node)) { node.forEach((child) => textRuns(child, role, out)); return out; }
  if (typeof node === 'string' || typeof node === 'number') {
    const text = String(node);
    if (text.trim()) out.push({ text, role });
    return out;
  }
  if (typeof node !== 'object') return out;
  if ('raw' in node) { out.push({ text: node.raw, role: '<raw>' }); return out; }
  const own = typeof node.a['data-pp-tx'] === 'string' ? node.a['data-pp-tx'] : role;
  (node.c || []).forEach((child) => textRuns(child, own, out));
  return out;
}

/** Elements carrying a text role, and whether they sit inside another one. */
function roleElements(node, insideRole = false, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (Array.isArray(node)) { node.forEach((c) => roleElements(c, insideRole, out)); return out; }
  if (typeof node !== 'object' || 'raw' in node) return out;
  const isRole = typeof node.a['data-pp-tx'] === 'string';
  if (isRole) out.push({ role: node.a['data-pp-tx'], nested: insideRole });
  (node.c || []).forEach((c) => roleElements(c, insideRole || isRole, out));
  return out;
}

function cases() {
  return layoutCases().map((testCase) => {
    const scene = buildScene(testCase);
    const ctx = contextFor(scene, { specimen: testCase.specimen, renditions: testCase.renditions });
    return { testCase, scene, ctx, tree: renderSceneTree(scene, ctx) };
  });
}

function round3(n) { return Math.round(n * 1000) / 1000; }

test('every text run a layout renders is inside an element carrying a text role', () => {
  for (const { testCase, tree } of cases()) {
    for (const run of textRuns(tree)) {
      assert.ok(run.role && run.role !== '<raw>',
        `${testCase.layout}: "${run.text.slice(0, 48)}" is rendered outside any data-pp-tx element`);
      assert.ok(TYPE_ROLES[run.role], `${testCase.layout}: unknown role "${run.role}"`);
    }
  }
});

test('text roles never nest, so no run is measured twice', () => {
  for (const { testCase, tree } of cases()) {
    for (const el of roleElements(tree)) {
      assert.ok(!el.nested, `${testCase.layout}: role "${el.role}" is inside another text role`);
    }
  }
});

test('every text run appears in measureScene, at every breakpoint', () => {
  for (const { testCase, scene, ctx, tree } of cases()) {
    const rendered = textRuns(tree);
    assert.ok(rendered.length > 0, `${testCase.layout} renders no text`);

    for (const bp of BPS) {
      const measurement = measureScene(scene, ctx, bp);
      assert.equal(measurement.sceneId, scene.id);
      assert.equal(measurement.breakpoint, bp);

      for (const run of rendered) {
        const covered = measurement.boxes.some((box) => box.role === run.role && box.text.includes(run.text));
        assert.ok(covered,
          `${testCase.layout} @${bp}: "${run.text.slice(0, 48)}" (${run.role}) is rendered but not measured`);
      }
    }
  }
});

test('every box carries the shape API.md declares', () => {
  for (const { testCase, scene, ctx } of cases()) {
    for (const bp of BPS) {
      for (const box of measureScene(scene, ctx, bp).boxes) {
        const where = `${testCase.layout} @${bp} ${box.role}`;
        assert.ok(box.elementId === null || /^el_[0-9a-f]{10}$/.test(box.elementId), `${where}: elementId`);
        assert.equal(typeof box.role, 'string', `${where}: role`);
        assert.equal(typeof box.text, 'string', `${where}: text`);
        assert.ok(box.text.trim().length > 0, `${where}: empty text was reported`);
        assert.equal(typeof box.style, 'object', `${where}: style`);
        assert.equal(typeof box.style.family, 'string', `${where}: family`);
        assert.ok(box.style.fontSizePx > 0, `${where}: fontSizePx`);
        assert.ok(box.style.lineHeight > 0, `${where}: lineHeight`);
        assert.equal(typeof box.style.weight, 'number', `${where}: weight`);
        assert.equal(typeof box.style.letterSpacingPx, 'number', `${where}: letterSpacingPx`);
        assert.ok(['none', 'uppercase', 'lowercase', 'capitalize'].includes(box.style.textTransform), `${where}: textTransform`);
        assert.ok(box.containerWidthPx > 0, `${where}: containerWidthPx is ${box.containerWidthPx}`);
        assert.ok(box.containerHeightPx > 0, `${where}: containerHeightPx is ${box.containerHeightPx}`);
        if (box.maxLines !== undefined) assert.ok(box.maxLines >= 1, `${where}: maxLines`);
        if (box.whiteSpace !== undefined) assert.equal(typeof box.whiteSpace, 'string', `${where}: whiteSpace`);
        if (box.overflowWrap !== undefined) assert.equal(typeof box.overflowWrap, 'string', `${where}: overflowWrap`);
      }
    }
  }
});

test('the style reported is the brand type system, not a default', () => {
  const testCase = layoutCases()[0];
  const scene = buildScene(testCase);
  const brand = brandFixture();
  const ctx = contextFor(scene, { specimen: testCase.specimen, renditions: testCase.renditions, brand });
  const boxes = measureScene(scene, ctx, 'lg').boxes;

  const headline = boxes.find((b) => b.role === 'headline');
  assert.equal(headline.style.family, 'Georgia', 'display roles take the brand display face');
  assert.deepEqual(headline.fontStack, ['Georgia', 'Times New Roman', 'serif']);
  const body = boxes.find((b) => b.role === 'body');
  assert.equal(body.style.family, 'Arial', 'body roles take the brand body face');
  const meta = boxes.find((b) => b.role === 'panelMeta');
  assert.equal(meta.style.family, 'Courier New', 'mono roles take the brand mono face');

  // The requested family is what L11 resolves post-substitution.
  assert.equal(resolveFace(headline.style.family, { available: ['Arial', 'Times New Roman'] }).resolved, 'Times New Roman');
});

test('container widths follow the breakpoint, and are the widths the geometry declares', () => {
  const testCase = layoutCases()[0];
  const scene = buildScene(testCase);
  const ctx = contextFor(scene, { specimen: testCase.specimen, renditions: testCase.renditions });

  for (const bp of BPS) {
    const stage = stageBox(bp);
    const cell = boxGeometry('splitCell', bp, { n: 2 });
    const boxes = measureScene(scene, ctx, bp).boxes;

    const headline = boxes.find((b) => b.role === 'headline');
    assert.equal(headline.containerWidthPx, round3(stage.contentWidthPx), `${bp}: headline container`);

    const bh1 = boxes.find((b) => b.role === 'bh1');
    assert.equal(bh1.containerWidthPx, round3(cell.widthPx), `${bp}: aligned cell container`);
    assert.ok(bh1.containerWidthPx < stage.contentWidthPx, `${bp}: a column is narrower than the stage`);
  }

  const small = measureScene(scene, ctx, 'sm').boxes.find((b) => b.role === 'bh1');
  const large = measureScene(scene, ctx, 'lg').boxes.find((b) => b.role === 'bh1');
  assert.ok(large.containerWidthPx > small.containerWidthPx, 'wider breakpoints give wider containers');
  assert.ok(large.style.fontSizePx > small.style.fontSizePx, 'wider breakpoints set larger type');
});

test('list items are measured inside the marker inset, and table cells inside their column', () => {
  const spec = specimen();
  const scene = buildScene({ layout: 'splitBeforeAfter', specimen: spec, renditions: [], headline: 'Spec' });
  const ctx = contextFor(scene, { specimen: spec, renditions: [] });
  const boxes = measureScene(scene, ctx, 'lg').boxes;
  const cell = boxGeometry('splitCell', 'lg', { n: 1 });

  const item = boxes.find((b) => b.role === 'listItem');
  assert.ok(item, 'a list item was measured');
  assert.equal(item.containerWidthPx, round3(cell.widthPx - 18), 'the marker column is subtracted');

  const td = boxes.find((b) => b.role === 'cell');
  assert.ok(td, 'a table cell was measured');
  assert.equal(td.containerWidthPx, round3(cell.widthPx / 4 - 18), 'four equal columns, less cell padding');
});

test('SVG text scales with the drawing, and is reported in real px', () => {
  const spec = specimen();
  const rends = localeFanout(5);
  const scene = buildScene({ layout: 'systemMap', specimen: spec, renditions: rends, headline: 'Flow' });
  const ctx = contextFor(scene, { specimen: spec, renditions: rends });

  const sm = measureScene(scene, ctx, 'sm').boxes.filter((b) => b.role === 'mapNodeTitle');
  const lg = measureScene(scene, ctx, 'lg').boxes.filter((b) => b.role === 'mapNodeTitle');
  assert.ok(sm.length > 0 && lg.length > 0, 'map labels are measured');
  assert.ok(lg[0].style.fontSizePx > sm[0].style.fontSizePx, 'the drawing scales its type with its box');
  assert.ok(lg[0].containerWidthPx > sm[0].containerWidthPx, 'and its containers with it');
  for (const box of sm.concat(lg)) {
    assert.equal(box.whiteSpace, 'nowrap', 'SVG text does not wrap, and says so');
    // Lines were broken by layoutText at author time; each one fits its node.
    assert.ok(measureText(box.text, box.style) <= box.containerWidthPx + 0.5,
      `a map label line overflows its node: "${box.text}"`);
  }
});

test('a clamped run reports its clamp, and an unclamped one does not', () => {
  const testCase = layoutCases()[1];   // fanOut clamps its cards
  const scene = buildScene(testCase);
  const ctx = contextFor(scene, { specimen: testCase.specimen, renditions: testCase.renditions });
  const boxes = measureScene(scene, ctx, 'md').boxes;
  assert.ok(boxes.some((b) => b.maxLines !== undefined), 'the fan clamps something');
  const kicker = boxes.find((b) => b.role === 'kicker');
  assert.equal(kicker.maxLines, undefined, 'an unclamped run reports no clamp');
});

test('boxes sharing a container are identifiable, so cumulative overflow can be summed', () => {
  const testCase = layoutCases()[0];
  const scene = buildScene(testCase);
  const ctx = contextFor(scene, { specimen: testCase.specimen, renditions: testCase.renditions });
  const boxes = measureScene(scene, ctx, 'md').boxes;
  const containers = new Map();
  for (const box of boxes) {
    if (!box.containerId) continue;
    containers.set(box.containerId, (containers.get(box.containerId) || 0) + 1);
  }
  assert.ok(containers.size > 1, 'boxes are attributed to more than one container');
  assert.ok([...containers.values()].some((n) => n > 1), 'some container holds more than one run');
  for (const box of boxes) assert.equal(typeof box.slot, 'string', 'every box names its geometry slot');
});

test('measurement is deterministic and independent of measurement order', () => {
  for (const { testCase, scene, ctx } of cases()) {
    for (const bp of BPS) {
      assert.deepEqual(measureScene(scene, ctx, bp), measureScene(scene, ctx, bp), `${testCase.layout} @${bp}`);
    }
    const reversed = [...BPS].reverse().map((bp) => measureScene(scene, ctx, bp)).reverse();
    const forward = BPS.map((bp) => measureScene(scene, ctx, bp));
    assert.deepEqual(reversed, forward, `${testCase.layout}: order affected the result`);
  }
});

test('a breakpoint may be named by id or by its BREAKPOINTS entry', () => {
  const testCase = layoutCases()[0];
  const scene = buildScene(testCase);
  const ctx = contextFor(scene, { specimen: testCase.specimen, renditions: testCase.renditions });
  for (const bp of BREAKPOINTS) {
    assert.deepEqual(measureScene(scene, ctx, bp), measureScene(scene, ctx, bp.id));
  }
  assert.throws(() => measureScene(scene, ctx, 'xl'), /not one of/);
});

test('measureScene fills in a partial context rather than throwing', () => {
  const scene = buildScene({ layout: 'quoteCard', specimen: specimen(), renditions: [], headline: 'Bare' });
  const measurement = measureScene(scene, {}, 'md');
  assert.ok(measurement.boxes.length > 0);
  assert.equal(measurement.sceneId, scene.id);
});

test('the type scale is legible at every breakpoint', () => {
  // Nothing below 9px, and body copy never below 12 — a proof is read from the
  // back of a room, and a 7px caption is a defect on a projector.
  for (const role of Object.keys(TYPE_ROLES)) {
    for (const bp of BPS) {
      const { style } = styleForRole(role, bp, brandFixture());
      assert.ok(style.fontSizePx >= 9, `${role} @${bp} is ${style.fontSizePx}px`);
      if (role === 'body' || role === 'listItem') assert.ok(style.fontSizePx >= 12, `${role} @${bp}`);
    }
  }
});

test('every box says whether an overflow would be visible or silent', () => {
  // CRITIQUE-1 F6: the detector graded a designed ellipsis as data lost
  // silently, because nothing in the measurement told the two apart.
  for (const { testCase, scene, ctx } of cases()) {
    for (const bp of BPS) {
      for (const box of measureScene(scene, ctx, bp).boxes) {
        const where = `${testCase.layout} @${bp} ${box.role}`;
        assert.ok(box.textOverflow === 'clip' || box.textOverflow === 'ellipsis', `${where}: textOverflow`);
        if (box.maxLines !== undefined) {
          assert.equal(box.textOverflow, 'ellipsis', `${where}: a clamped run truncates visibly`);
        } else {
          assert.equal(box.textOverflow, 'clip', `${where}: an unclamped run has nothing to mark a cut`);
        }
      }
    }
  }
});

test('textOverflowOf reads the attribute the stylesheet is written from', () => {
  assert.equal(textOverflowOf({}), 'clip');
  assert.equal(textOverflowOf({ 'data-pp-clamp': '1' }), 'ellipsis');
  assert.equal(textOverflowOf({ 'data-pp-clamp': 3 }), 'ellipsis');
  assert.equal(textOverflowOf({ 'data-pp-clamp': null }), 'clip');
  // A layout may state it directly where it knows better than the derivation.
  assert.equal(textOverflowOf({ 'data-pp-to': 'ellipsis' }), 'ellipsis');
  assert.equal(textOverflowOf({ 'data-pp-to': 'clip', 'data-pp-clamp': '2' }), 'clip');
});

test('a table cell reports the break-word its stylesheet gives it', () => {
  const spec = specimen();
  const scene = buildScene({ layout: 'splitBeforeAfter', specimen: spec, renditions: [], headline: 'Spec' });
  const ctx = contextFor(scene, { specimen: spec, renditions: [] });
  const cells = measureScene(scene, ctx, 'sm').boxes.filter((b) => b.role === 'cell' || b.role === 'cellHead');
  assert.ok(cells.length > 0);
  for (const cell of cells) assert.equal(cell.overflowWrap, 'break-word', cell.text);
});

test('the boxes of one column share a container, so a column can be summed', () => {
  const testCase = layoutCases()[0];
  const scene = buildScene(testCase);
  const ctx = contextFor(scene, { specimen: testCase.specimen, renditions: testCase.renditions });
  const boxes = measureScene(scene, ctx, 'md').boxes.filter((b) => b.slot === 'splitCell');
  const containers = new Set(boxes.map((b) => b.containerId));
  assert.deepEqual([...containers].sort(), ['splitCell:after/0', 'splitCell:before'],
    'one container per column, not one per cell');
  for (const id of containers) {
    const inColumn = boxes.filter((b) => b.containerId === id);
    assert.ok(inColumn.length > 1, `${id} holds several blocks`);
    const heights = new Set(inColumn.map((b) => b.containerHeightPx));
    assert.equal(heights.size, 1, `${id}: every box in a column reports the same column height`);
  }
});

test('a column is afforded the frame, not a share of it, however many it has', () => {
  // CRITIQUE-1 F6: dividing the body height between stacked columns at `sm`
  // claimed a five-rendition scene gave its source column a fifth of the
  // screen, and turned ordinary prose into blocking findings.
  const spec = specimen();
  for (const bp of BPS) {
    const one = boxGeometry('splitCell', bp, { n: 1 });
    const five = boxGeometry('splitCell', bp, { n: 5 });
    assert.equal(one.heightPx, five.heightPx, `${bp}: column height is independent of the column count`);
    // Width is not: at md and lg the columns share the frame side by side; at
    // sm they stack, so each keeps the full width and the scene scrolls.
    if (bp === 'sm') assert.equal(five.widthPx, one.widthPx, 'sm stacks rather than divides');
    else assert.ok(five.widthPx < one.widthPx, `${bp}: columns divide the width`);
    const rendered = measureScene(
      buildScene({ layout: 'splitBeforeAfter', specimen: spec, renditions: [], headline: 'H' }),
      contextFor(buildScene({ layout: 'splitBeforeAfter', specimen: spec, renditions: [], headline: 'H' }), { specimen: spec, renditions: [] }),
      bp,
    ).boxes.find((b) => b.slot === 'splitCell');
    assert.ok(rendered.containerHeightPx > 200, `${bp}: a column affords real height (${rendered.containerHeightPx})`);
  }
});

test('a source URL label elides its middle, keeping the host and the slug', () => {
  assert.equal(displayUrl('https://acme.example/a/b'), 'acme.example/a/b');
  assert.equal(
    displayUrl('https://www.northwind-industrial.example/equipment/heat-exchangers/hx-400/'),
    'www.northwind-industrial.example/…/hx-400',
  );
  assert.equal(displayUrl('https://www.northwind-industrial.example/'), 'www.northwind-industrial.example');
  assert.equal(displayUrl(null), null);
  // Never longer than what it replaced, and never carrying a scheme.
  for (const url of ['https://a.example/one/two/three/four', 'https://a-very-long-host-name.example/x/y']) {
    const label = displayUrl(url);
    assert.ok(label.length <= url.replace(/^https:\/\//, '').length);
    assert.ok(!label.includes('//'));
  }
});
