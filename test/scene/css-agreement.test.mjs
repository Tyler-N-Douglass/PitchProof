/**
 * The stylesheet and the measurement agree — and the stylesheet obeys the
 * artifact's laws (§10 motion budget, §13 zero network, §15/D11 theme
 * isolation).
 *
 * `scenes.css` is parsed here rather than eyeballed. Every number
 * `measureScene` reports is a number this file asserts the stylesheet
 * declares, so the two cannot drift; every duration is checked against the
 * 240ms budget; and the studio's variable namespace is asserted absent from
 * the whole directory.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { MAX_TRANSITION_MS, BREAKPOINTS } from '../../src/core/contracts.js';
import {
  sceneVars, TYPE_ROLES, scenesCssRoles, cssRoleName, BP_QUERY, GEOM,
  stagePadPx, fanColumns, SLOTS, boxGeometry, textOverflowOf,
} from '../../src/scene/index.js';
import { buildScene, renderSceneTree, measureScene } from '../../src/scene/index.js';
import { BRAND_BORDER_INSET, insetLength } from '../../src/scene/measure.js';
import { layoutCases, contextFor, specimen } from '../fixtures/scene/content.mjs';

const SCENE_DIR = new URL('../../src/scene/', import.meta.url).pathname;
const SCENES_CSS = readFileSync(join(SCENE_DIR, 'scenes.css'), 'utf8');
const RUNTIME_CSS = readFileSync(new URL('../../src/runtime/runtime.css', import.meta.url).pathname, 'utf8');

/** Every file the lane owns. */
function laneFiles(dir = SCENE_DIR, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) laneFiles(p, out);
    else out.push(p);
  }
  return out;
}

/** Strip comments, then flatten the sheet into rules with their media context. */
function parseCss(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  /** @type {{media: string|null, selector: string, decls: Record<string,string>}[]} */
  const rules = [];
  let i = 0;

  const parseDecls = (body) => {
    /** @type {Record<string,string>} */
    const out = {};
    for (const part of body.split(';')) {
      const at = part.indexOf(':');
      if (at < 0) continue;
      const prop = part.slice(0, at).trim();
      const value = part.slice(at + 1).trim();
      if (prop) out[prop] = value;
    }
    return out;
  };

  const parse = (media) => {
    let buf = '';
    while (i < src.length) {
      const ch = src[i++];
      if (ch === '}') return;
      if (ch !== '{') { buf += ch; continue; }
      const prelude = buf.trim();
      buf = '';
      if (prelude.startsWith('@media')) {
        parse(prelude.replace(/^@media\s*/, '').trim());
        continue;
      }
      let body = '';
      let depth = 1;
      while (i < src.length) {
        const c = src[i++];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) break; }
        body += c;
      }
      rules.push({ media, selector: prelude, decls: parseDecls(body) });
    }
  };
  parse(null);
  return rules;
}

const RULES = parseCss(SCENES_CSS);

/** The rule for a selector in a media context. */
function rule(selector, media = null) {
  return RULES.find((r) => r.selector === selector && r.media === media) || null;
}

test('each breakpoint block declares exactly the variables the measurement uses', () => {
  const roots = RULES.filter((r) => r.selector === ':root');
  assert.equal(roots.length, 3, 'one :root block per breakpoint, and no more');

  const expected = { sm: null, md: BP_QUERY.md, lg: BP_QUERY.lg };
  for (const [bp, media] of Object.entries(expected)) {
    const block = roots.find((r) => r.media === media);
    assert.ok(block, `no :root block for ${bp} (${media || 'base'})`);
    assert.deepEqual(block.decls, sceneVars(bp),
      `scenes.css and src/scene/tokens.js disagree at ${bp}`);
  }
});

test('the breakpoint queries match the viewports the geometry is computed for', () => {
  const widths = Object.fromEntries(BREAKPOINTS.map((b) => [b.id, b.width]));
  const md = Number(/(\d+)/.exec(BP_QUERY.md)[1]);
  const lg = Number(/(\d+)/.exec(BP_QUERY.lg)[1]);
  assert.ok(widths.sm < md, 'the sm viewport falls in the base block');
  assert.ok(widths.md >= md && widths.md < lg, 'the md viewport selects the md block only');
  assert.ok(widths.lg >= lg, 'the lg viewport selects the lg block');
});

test('every text role is styled exactly as the type scale declares', () => {
  for (const role of scenesCssRoles()) {
    const spec = TYPE_ROLES[role];
    const selector = spec.svg
      ? `.pp-scene .pp-map-svg [data-pp-tx="${role}"]`
      : `.pp-scene [data-pp-tx="${role}"]`;
    const found = rule(selector);
    assert.ok(found, `no rule for text role ${role}`);
    assert.equal(found.decls['font-family'], `var(--pp-font-${spec.face})`, `${role}: face`);
    assert.equal(found.decls['font-size'],
      spec.svg ? `${spec.sizes.md}px` : `var(--pp-sc-fs-${cssRoleName(role)})`, `${role}: size`);
    assert.equal(found.decls['line-height'], String(spec.lineHeight), `${role}: line-height`);
    assert.equal(found.decls['font-weight'], String(spec.weight), `${role}: weight`);
    assert.equal(found.decls['letter-spacing'],
      spec.letterSpacingEm ? `${spec.letterSpacingEm}em` : '0', `${role}: letter-spacing`);
    assert.equal(found.decls['text-transform'], spec.textTransform, `${role}: text-transform`);
  }
});

test('the provenance label takes its type from runtime.css, and this sheet does not touch it', () => {
  const spec = TYPE_ROLES.provenance;
  assert.equal(spec.definedIn, 'runtime.css');
  assert.ok(!SCENES_CSS.includes('--pp-sc-fs-provenance'), 'the label is re-declared here');

  const runtime = parseCss(RUNTIME_CSS).find((r) => r.selector === '.pp-provenance');
  assert.ok(runtime, 'runtime.css declares .pp-provenance');
  assert.equal(runtime.decls['font-size'], `${spec.sizes.md}px`, 'measured size matches the stylesheet');
  assert.equal(runtime.decls['line-height'], String(spec.lineHeight));
  assert.equal(runtime.decls['font-weight'], String(spec.weight));
  assert.equal(runtime.decls['letter-spacing'], `${spec.letterSpacingEm}em`);
  assert.ok(Number(/(\d+)/.exec(runtime.decls['font-size'])[1]) >= 11, '§18.1 size floor');

  // Nothing in this sheet may push the label towards invisibility — and that
  // holds for *every* rule that reaches it, not only the one that positions it.
  // The provenance ledger added a second such rule (L8-25); a ban written
  // against a single selector would not have covered it.
  const ours = rule('.pp-scene .pp-provenance');
  assert.ok(ours, 'this sheet positions the label');
  const reaching = RULES.filter((r) => r.selector.split(',')
    .some((sel) => /(^|[\s>+~])\.pp-provenance(\s|$|[.:[])/.test(`${sel.trim()} `)));
  assert.ok(reaching.length >= 1, 'no rule in this sheet touches the label');
  for (const r of reaching) {
    for (const banned of ['display', 'opacity', 'visibility', 'font-size', 'color', 'background']) {
      assert.equal(r.decls[banned], undefined, `${r.selector} sets ${banned} on the provenance label`);
    }
  }
});

test('the stage padding the geometry assumes is the one runtime.css declares', () => {
  const root = parseCss(RUNTIME_CSS).find((r) => r.selector === ':root');
  assert.equal(root.decls['--pp-stage-pad'], 'clamp(20px, 3.2vw, 56px)',
    'geometry.js reproduces this formula in stagePadPx()');
  const [, min, vw, max] = /clamp\((\d+)px,\s*([\d.]+)vw,\s*(\d+)px\)/.exec(root.decls['--pp-stage-pad']);
  for (const bp of BREAKPOINTS) {
    const fromCss = Math.min(Number(max), Math.max(Number(min), bp.width * Number(vw) / 100));
    assert.equal(stagePadPx(bp.width), fromCss, `${bp.id}: padding`);
  }
});

test('the fan column count in the stylesheet is the one the geometry measures with', () => {
  const applicable = { sm: [null], md: [null, BP_QUERY.md], lg: [null, BP_QUERY.md, BP_QUERY.lg] };
  for (const [bp, contexts] of Object.entries(applicable)) {
    for (let n = 1; n <= 6; n++) {
      let cols = GEOM[bp]['fan-cols'];
      for (const media of contexts) {
        const override = rule(`.pp-fan-grid[data-pp-n="${n}"]`, media);
        if (override && override.decls['--pp-sc-fan-cols']) cols = Number(override.decls['--pp-sc-fan-cols']);
      }
      assert.equal(cols, fanColumns(bp, n), `${bp}: ${n} cards`);
    }
  }
});

test('every clamp, white-space and overflow-wrap the layouts stamp has a rule behind it', () => {
  /** @type {Set<string>} */
  const clamps = new Set();
  /** @type {Set<string>} */
  const spaces = new Set();
  /** @type {Set<string>} */
  const wraps = new Set();
  /** @type {Set<string>} */
  const slots = new Set();
  /** @type {Set<string>} */
  const insets = new Set();
  /** @type {Set<string>} */
  const tracks = new Set();

  const scan = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(scan); return; }
    if ('raw' in node) return;
    const a = node.a || {};
    if (a['data-pp-clamp'] !== undefined && a['data-pp-clamp'] !== null) clamps.add(String(a['data-pp-clamp']));
    if (typeof a['data-pp-ws'] === 'string') spaces.add(a['data-pp-ws']);
    if (typeof a['data-pp-ow'] === 'string') wraps.add(a['data-pp-ow']);
    if (typeof a['data-pp-box'] === 'string') slots.add(a['data-pp-box']);
    if (typeof a['data-pp-inset'] === 'string') a['data-pp-inset'].split(',').forEach((t) => insets.add(t.trim()));
    if (a['data-pp-width'] !== undefined && a['data-pp-width'] !== null) tracks.add(String(a['data-pp-width']));
    if (a['data-pp-max'] !== undefined && a['data-pp-max'] !== null) tracks.add(String(a['data-pp-max']));
    (node.c || []).forEach(scan);
  };
  for (const testCase of layoutCases()) {
    const scene = buildScene(testCase);
    scan(renderSceneTree(scene, contextFor(scene, { specimen: testCase.specimen, renditions: testCase.renditions })));
  }

  assert.ok(clamps.size > 0 && slots.size > 0, 'the layouts stamp something to check');
  for (const value of clamps) {
    const found = rule(`.pp-scene [data-pp-clamp="${value}"]`);
    assert.ok(found && found.decls['-webkit-line-clamp'] === value, `no clamp rule for ${value} lines`);
  }
  for (const value of spaces) {
    assert.ok(rule(`.pp-scene [data-pp-ws="${value}"]`), `no white-space rule for ${value}`);
  }
  for (const value of wraps) {
    assert.ok(rule(`.pp-scene [data-pp-ow="${value}"]`), `no overflow-wrap rule for ${value}`);
  }
  for (const slot of slots) {
    assert.ok(SLOTS.includes(slot), `slot "${slot}" has no geometry`);
    for (const bp of ['sm', 'md', 'lg']) {
      const size = boxGeometry(slot, bp, { n: 3, unitWidth: 100, unitHeight: 20 });
      assert.ok(size.widthPx > 0 && size.heightPx > 0, `slot "${slot}" measures ${JSON.stringify(size)} at ${bp}`);
    }
  }
  // An inset or a declared track is either a geometry token — which must exist in
  // `GEOM` for every breakpoint — or a literal px count the stylesheet spells out
  // in place (`.pp-quote`'s rule gutter, `.pp-empty`'s frame, `.pp-provenance`'s
  // own padding, which runtime.css owns). A literal must at least be a
  // non-negative finite number; what keeps it equal to the stylesheet is
  // test/scene/geometry-browser.test.mjs, which measures the real box in
  // Chromium. Nothing may name a token that does not exist.
  for (const token of [...insets, ...tracks]) {
    const literal = Number(token);
    if (Number.isFinite(literal)) {
      assert.ok(literal >= 0, `inset literal "${token}" is negative`);
      continue;
    }
    // `brand-border` is the one length whose value is the prospect's rather than
    // the deck's, so it is resolved from the `BrandSystem` at measure time
    // instead of from `GEOM`. `.pp-cta` is where the stylesheet spends it.
    if (token === BRAND_BORDER_INSET) {
      assert.ok(/var\(--pp-border-width\)/.test(SCENES_CSS),
        'nothing in the sheet draws with the brand border width, so the inset is stale');
      for (const width of [0, 1, 4]) {
        assert.equal(insetLength(token, 'md', { shape: { borderWidthPx: width } }), width * 2);
      }
      continue;
    }
    for (const bp of ['sm', 'md', 'lg']) {
      assert.ok(GEOM[bp][token] !== undefined, `token "${token}" is not a geometry token at ${bp}`);
    }
  }
});

test('§10 motion budget: nothing animates for longer than 240ms, and only opacity and transform', () => {
  const durations = [];
  const properties = new Set();
  for (const r of RULES) {
    for (const [prop, value] of Object.entries(r.decls)) {
      if (!/^(transition|animation)/.test(prop)) continue;
      if (prop === 'transition-property') value.split(',').forEach((p) => properties.add(p.trim()));
      for (const [, num, unit] of value.matchAll(/(-?[\d.]+)(ms|s)\b/g)) {
        durations.push({ ms: unit === 's' ? Number(num) * 1000 : Number(num), where: `${r.selector} { ${prop} }` });
      }
    }
  }
  for (const d of durations) {
    assert.ok(d.ms <= MAX_TRANSITION_MS, `${d.where} runs for ${d.ms}ms, over the ${MAX_TRANSITION_MS}ms budget`);
  }
  assert.ok(!/@keyframes/.test(SCENES_CSS), 'a keyframe animation cannot be interrupted cleanly; none is used');
  for (const prop of properties) {
    assert.ok(['opacity', 'transform', 'none'].includes(prop),
      `${prop} is animated; only opacity and transform are interruptible without a partial state`);
  }
  // The one transition that exists is driven by the runtime's own variable.
  const reveal = rule('.pp-layout [data-pp-el]');
  assert.ok(reveal, 'the reveal transition is declared');
  assert.equal(reveal.decls['transition-duration'], 'var(--pp-transition-ms)');
});

test('§10: prefers-reduced-motion removes every transition and animation in the sheet', () => {
  const reduced = RULES.filter((r) => r.media === '(prefers-reduced-motion: reduce)');
  assert.ok(reduced.length > 0, 'no reduced-motion block');
  const covers = reduced.some((r) => r.selector.split(',').some((s) => s.trim() === '.pp-layout *')
    && r.decls.transition === 'none' && r.decls.animation === 'none');
  assert.ok(covers, 'the reduced-motion block does not clear transitions and animations for the whole layout');
});

test('D11: the studio variable namespace appears nowhere in the lane', () => {
  const studioPrefix = `--${'st'}-`;
  for (const file of laneFiles()) {
    const source = readFileSync(file, 'utf8');
    assert.ok(!source.includes(studioPrefix), `${file} references the studio namespace`);
  }
  // …and every custom property the sheet declares or reads is --pp-*.
  const declarations = SCENES_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const names = [
    ...[...declarations.matchAll(/var\(\s*(--[a-z][\w-]*)/g)].map((m) => m[1]),
    ...[...declarations.matchAll(/[{;\s](--[a-z][\w-]*)\s*:/g)].map((m) => m[1]),
  ];
  assert.ok(names.length > 50, 'the sheet reads and declares custom properties');
  for (const name of names) {
    assert.ok(name.startsWith('--pp-'), `scenes.css uses ${name}`);
  }
});

test('§13: the lane carries no network reference of any kind', () => {
  const scheme = `ht${'tp'}`;
  const banned = [scheme, '@import', 'fetch(', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon', 'importScripts'];
  for (const file of laneFiles()) {
    const source = readFileSync(file, 'utf8');
    for (const token of banned) {
      assert.ok(!source.includes(token), `${file} contains "${token}"`);
    }
    if (file.endsWith('.css')) {
      for (const [, url] of source.matchAll(/url\(([^)]*)\)/g)) {
        assert.ok(url.trim().startsWith('data:'), `${file}: url(${url})`);
      }
    }
  }
});

test('the sheet colours itself from the brand theme, never from a literal', () => {
  const withoutComments = SCENES_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(withoutComments), 'a literal colour is in the scene stylesheet');
  assert.ok(!/\brgba?\(/.test(withoutComments), 'a literal colour is in the scene stylesheet');
});

test('the reported textOverflow is what the stylesheet declares for that clamp', () => {
  // The grading policy for CRITIQUE-1 F6 rests on this field, so the value the
  // measurement reports has to be the value the CSS produces — checked here per
  // clamp value the layouts actually stamp, the same way the clamp itself is.
  const base = rule('.pp-scene [data-pp-clamp]');
  assert.ok(base, 'the clamp base rule exists');
  assert.equal(base.decls.overflow, 'hidden', 'a clamped run hides its overflow');

  const one = rule('.pp-scene [data-pp-clamp="1"]');
  assert.ok(one, 'the one-line clamp rule exists');
  assert.equal(one.decls['text-overflow'], 'ellipsis', 'a one-line clamp truncates visibly');
  assert.equal(one.decls['white-space'], 'nowrap', 'and does not wrap — measureScene reports both');
  assert.equal(textOverflowOf({ 'data-pp-clamp': '1' }), 'ellipsis');

  // Every multi-line clamp goes through `-webkit-line-clamp`, which truncates
  // with an ellipsis of its own; the base rule is what makes that true.
  for (const r of RULES) {
    const match = /^\.pp-scene \[data-pp-clamp="(\d+)"\]$/.exec(r.selector);
    if (!match) continue;
    assert.equal(r.decls['-webkit-line-clamp'], match[1], `clamp ${match[1]}`);
    assert.equal(textOverflowOf({ 'data-pp-clamp': match[1] }), 'ellipsis', `clamp ${match[1]}`);
  }
  assert.equal(textOverflowOf({}), 'clip', 'an unclamped run has nothing on screen to mark a cut');
});

test('every declaration of overflow-wrap in the sheet is reported by a box that carries it', () => {
  // `.pp-table th/td { overflow-wrap: break-word }` was declared and not
  // reported, so the detector read a wrapped word as an unbreakable overflow.
  const wrapping = RULES.filter((r) => r.decls['overflow-wrap'] && !r.selector.includes('[data-pp-ow'));
  assert.ok(wrapping.length > 0, 'the sheet sets overflow-wrap somewhere outside the attribute rules');
  for (const r of wrapping) {
    assert.equal(r.decls['overflow-wrap'], 'break-word', r.selector);
    assert.ok(/\.pp-table/.test(r.selector), `${r.selector}: only table cells wrap this way`);
  }
  const spec = specimen();
  const scene = buildScene({ layout: 'splitBeforeAfter', specimen: spec, renditions: [], headline: 'T' });
  const cells = measureScene(scene, contextFor(scene, { specimen: spec, renditions: [] }), 'md').boxes
    .filter((b) => b.role === 'cell' || b.role === 'cellHead');
  assert.ok(cells.length > 0 && cells.every((b) => b.overflowWrap === 'break-word'),
    'the cells report the wrap the stylesheet gives them');
});
