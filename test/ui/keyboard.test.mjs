/**
 * §20.10: a critic assembles a proof end to end and reports "every place the
 * flow stalls, requires a mouse where a key would do, or loses work".
 *
 * The middle clause is the one a test can settle, and it is settled from the
 * action registry rather than from a list somebody maintained. Every action has
 * exactly one of three keyboard routes:
 *
 *   key      — its own accelerator, resolved by `ui/keys.js`;
 *   palette  — reachable by Ctrl K, typing, Enter;
 *   control  — it *is* a control, reachable by Tab, and this test proves such a
 *              control is actually rendered somewhere and is focusable.
 *
 * The third is the one that would otherwise be a promise. An action marked
 * `control: true` that no panel renders would be unreachable by any means, so
 * the test renders every panel and every overlay and looks for the element.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHtml } from '../../src/core/vdom.js';
import { StudioApp } from '../../src/ui/app.js';
import { ACTIONS, actionIndex, routeOf, fakeFontInput } from '../../src/ui/actions.js';
import { renderStudio } from '../../src/ui/layout.js';
import { renderAllPanels } from '../../src/ui/panels/index.js';
import { renderInspector } from '../../src/ui/inspector.js';
import { keyStringOf, matchesBinding, keyLabel, bindingGroups } from '../../src/ui/keys.js';
import { SECTIONS } from '../../src/ui/constants.js';
import { ProjectStore } from '../../src/core/storage.js';
import { fixtureDoc, fakeServices, makeClock, finding } from '../fixtures/ui/studio-fixture.mjs';

const index = actionIndex(ACTIONS);

/** Tags a keyboard can reach without a `tabindex`. */
const FOCUSABLE_TAGS = new Set(['button', 'input', 'select', 'textarea', 'a']);

/**
 * Every element in a rendered HTML string that declares an action, with the tag
 * it is on and whether it is disabled.
 * @param {string} html
 * @returns {{action: string, tag: string, disabled: boolean, tabindex: string|null}[]}
 */
function controlsIn(html) {
  const out = [];
  const tagRe = /<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'=<>`/]+(?:\s*=\s*"[^"]*")?)*)\s*\/?>/g;
  for (const match of html.matchAll(tagRe)) {
    const attrs = match[2] || '';
    const act = attrs.match(/\sdata-st-act\s*=\s*"([^"]*)"/);
    if (!act) continue;
    const tabindex = attrs.match(/\stabindex\s*=\s*"([^"]*)"/);
    out.push({
      action: act[1],
      tag: match[1].toLowerCase(),
      disabled: /\sdisabled(?:\s|=|$)/.test(attrs),
      tabindex: tabindex ? tabindex[1] : null,
    });
  }
  return out;
}

/**
 * An app in the state that exposes the most interface: something selected in
 * every library, a notice on screen, findings from a sweep, a dry run in
 * progress, an emitted file, and sitemap suggestions.
 * @returns {Promise<any>}
 */
async function makeFullApp() {
  const clock = makeClock();
  const store = await ProjectStore.open({ clock, indexedDB: null });
  const doc = fixtureDoc();
  const findings = [
    finding({ id: 'fd_a', severity: 1, code: 'CONTRAST_FAIL', locus: { sceneId: doc.proof.spine[0].id } }),
    finding({ id: 'fd_b', severity: 2, code: 'BEAT_EMPTY', message: 'A beat reveals nothing.', locus: { sceneId: doc.proof.spine[1].id }, autoFixAvailable: true }),
    finding({ id: 'fd_c', severity: 3, code: 'STALE_CAPTURE', message: 'This capture is 44 days old.', locus: { specimenId: doc.proof.specimens[0].id } }),
  ];
  const app = new StudioApp({
    document: null,
    window: null,
    store,
    clock,
    services: fakeServices({ clock, findings }),
    doc,
  });
  app.ui.settings = { proxyBase: 'https://proxy.example/', adapterEndpoint: 'https://a.example', adapterKey: 'k', operator: 'Alex Mercer' };
  app.ui.projects = [{ id: doc.id, name: doc.name, prospectName: 'Northwind Industrial', savedAt: clock(), revision: 3, bytes: 4096, schemaVersion: 1 }];
  app.ui.notices = [{ id: 'nt_1', tone: 'info', text: 'A message.', sticky: false }];
  app.ui.sweep = { findings, at: clock(), running: false, error: null, proofHash: null };
  app.ui.dryRun = {
    active: true,
    index: 0,
    positions: [{ sequenceId: 'spine', sceneId: doc.proof.spine[0].id, beatIndex: 0 }],
    findings,
  };
  app.ui.emit = {
    result: { html: '<html></html>', bytes: 900, findings: [], degradations: [], compression: { mode: 'raw', modelBytes: 100, mediaBytes: 0 } },
    running: false, error: null, at: clock(),
  };
  app.ui.sitemap = [{ url: 'https://www.northwind.example/a', score: 0.92 }];
  app.ui.paletteOpen = true;
  app.ui.keysOpen = true;
  app.ui.historyOpen = true;
  app.select({
    specimenId: doc.proof.specimens[0].id,
    renditionId: doc.proof.renditions[0].id,
    recipeId: doc.proof.recipes[0].id,
    sceneId: doc.proof.spine[0].id,
    branchId: doc.proof.branches[0].id,
    beatIndex: 0,
  });
  // One face carrying a licensed file, so both halves of §7's font route render:
  // the attach control on the face without one, and the withdrawal beside the
  // file on the face with one (CRITIQUE-2 C3).
  await app.dispatch('brand.attachFont', '0', { element: fakeFontInput('Inter-Regular.woff2') });
  app.setDraft('branch.jumpQuery', 'app');
  app.setDraft('rendition.paste', 'A pasted block.\n\nAnother one.');
  app.setDraft('rendition.label', 'SMS');
  app.mutate('seed an undo entry', (d) => ({ ...d, name: `${d.name} ` }), { scope: 'test' });
  return app;
}

/**
 * Every control the studio can render, across every section and overlay.
 * @param {any} app
 * @returns {Map<string, {tag: string, disabled: boolean, tabindex: string|null}[]>}
 */
function everyControl(app) {
  const parts = [toHtml(renderAllPanels(app))];
  for (const section of SECTIONS) {
    app.ui.section = section.id;
    parts.push(toHtml(renderStudio(app)));
    parts.push(toHtml(renderInspector(app)));
  }
  /** @type {Map<string, any[]>} */
  const map = new Map();
  for (const control of controlsIn(parts.join('\n'))) {
    if (!map.has(control.action)) map.set(control.action, []);
    map.get(control.action).push(control);
  }
  return map;
}

test('every action has exactly one keyboard route, and the route is real', async () => {
  const app = await makeFullApp();
  const controls = everyControl(app);

  /** @type {string[]} */
  const unreachable = [];
  for (const action of index.all) {
    const route = routeOf(action);
    if (route === 'key') {
      assert.ok(action.keys.length, `${action.id} claims a key route with no keys`);
      continue;
    }
    if (route === 'palette') {
      assert.notEqual(action.palette, false, `${action.id} claims a palette route but is excluded from it`);
      continue;
    }
    const rendered = controls.get(action.id) || [];
    const usable = rendered.filter((c) => FOCUSABLE_TAGS.has(c.tag) && !c.disabled && c.tabindex !== '-1');
    if (!usable.length) {
      unreachable.push(`${action.id} (rendered ${rendered.length}× as ${rendered.map((r) => r.tag).join('/') || 'nothing'})`);
    }
  }
  assert.deepEqual(unreachable, [], 'every control-routed action must render a focusable control somewhere');
});

test('every rendered control names an action the registry knows', async () => {
  const app = await makeFullApp();
  const controls = everyControl(app);
  const unknown = [...controls.keys()].filter((id) => !index.byId.has(id));
  assert.deepEqual(unknown, [], 'a control wired to a missing action is a dead button');
});

test('every control-routed action sits on a natively focusable element', async () => {
  const app = await makeFullApp();
  const controls = everyControl(app);
  const wrong = [];
  for (const [id, list] of controls) {
    for (const control of list) {
      if (!FOCUSABLE_TAGS.has(control.tag) && control.tabindex === null) {
        wrong.push(`${id} on <${control.tag}> with no tabindex`);
      }
    }
  }
  assert.deepEqual(wrong, [], 'a clickable element that is not a control needs an explicit tabindex');
});

test('no two actions claim the same accelerator', () => {
  /** @type {Map<string, string>} */
  const seen = new Map();
  for (const action of index.withKeys) {
    for (const combo of action.keys) {
      const owner = seen.get(combo);
      assert.equal(owner, undefined, `${combo} is claimed by both ${owner} and ${action.id}`);
      seen.set(combo, action.id);
    }
  }
});

test('the flow itself is reachable: every rail section has an accelerator', () => {
  for (const section of SECTIONS) {
    const action = index.byId.get(`app.section.${section.id}`);
    assert.ok(action, `${section.id} has no direct accelerator action`);
    assert.ok(action.keys && action.keys.length, `${section.id} has no key`);
  }
  assert.ok(index.byId.get('app.section.next').keys.length, 'stepping forward through the flow needs a key');
  assert.ok(index.byId.get('app.section.prev').keys.length, 'stepping back through the flow needs a key');
});

test('the essential edit operations have their conventional keys', () => {
  const expect = {
    'app.undo': 'Mod+z',
    'app.redo': 'Mod+Shift+z',
    'app.palette': 'Mod+k',
    'project.save': 'Mod+s',
    'project.export': 'Mod+e',
    'rehearse.sweep': 'Alt+r',
    'emit.run': 'Mod+Enter',
  };
  for (const [id, combo] of Object.entries(expect)) {
    const action = index.byId.get(id);
    assert.ok(action, `${id} is missing from the registry`);
    assert.ok(action.keys.includes(combo), `${id} should answer to ${combo}, has ${action.keys.join(', ')}`);
  }
});

test('the key router turns events into the combos the registry declares', () => {
  assert.equal(keyStringOf({ key: 'z', ctrlKey: true }), 'Mod+z');
  assert.equal(keyStringOf({ key: 'z', metaKey: true }), 'Mod+z', 'Command and Control are the same binding');
  assert.equal(keyStringOf({ key: 'Z', metaKey: true, shiftKey: true }), 'Mod+Shift+z');
  assert.equal(keyStringOf({ key: '1', altKey: true }), 'Alt+1');
  assert.equal(keyStringOf({ key: 'Escape' }), 'Escape');
  assert.equal(keyStringOf({ key: 'ArrowRight', altKey: true }), 'Alt+ArrowRight');
  assert.equal(keyStringOf({ key: ' ' }), 'Space');
  assert.equal(keyStringOf({ key: 'Dead' }), null);
  assert.equal(keyStringOf({}), null);
  assert.ok(matchesBinding('Mod+z', ['Mod+z']));
  assert.ok(!matchesBinding('Mod+z', ['Mod+y']));
});

test('a bare letter does not fire a command while somebody is typing', async () => {
  const app = await makeFullApp();
  app.ui.paletteOpen = false;
  const typed = app.handleKey({
    key: 'r', altKey: false, target: { tagName: 'INPUT', getAttribute: () => 'text' }, preventDefault() {},
  });
  assert.equal(typed, null, 'typing an "r" into a field must not run a command');
});

test('the keyboard reference is generated from the bindings, not written by hand', () => {
  const groups = bindingGroups(index.all);
  const described = groups.flatMap((g) => g.bindings).length;
  assert.equal(described, index.withKeys.length, 'the reference lists exactly the bound actions');
  assert.deepEqual(keyLabel('Mod+Shift+z'), ['Ctrl', 'Shift', 'Z']);
  assert.deepEqual(keyLabel('Alt+ArrowLeft'), ['Alt', '←']);
});

test('the command palette finds an action by a subsequence of its name', async () => {
  const app = await makeFullApp();
  app.setUi({ paletteQuery: 'emit' });
  const matches = app.paletteMatches();
  assert.ok(matches.length, 'a palette that finds nothing is not a route');
  assert.ok(matches.some((a) => a.id === 'emit.run'), 'typing "emit" must reach the emit action');

  app.setUi({ paletteQuery: 'undo' });
  assert.ok(app.paletteMatches().some((a) => a.id === 'app.undo'));
});

test('Escape closes the overlays in the order they stack', async () => {
  const app = await makeFullApp();
  app.setUi({ paletteOpen: true, keysOpen: true, historyOpen: true });
  app.handleKey({ key: 'Escape', target: null, preventDefault() {} });
  assert.equal(app.ui.paletteOpen, false);
  app.handleKey({ key: 'Escape', target: null, preventDefault() {} });
  assert.equal(app.ui.keysOpen, false);
  app.handleKey({ key: 'Escape', target: null, preventDefault() {} });
  assert.equal(app.ui.historyOpen, false);
});

test('the palette runs the highlighted command on Enter', async () => {
  const app = await makeFullApp();
  app.setUi({ paletteOpen: true, paletteQuery: 'go to brand', paletteIndex: 0 });
  const chosen = app.paletteMatches()[0];
  app.handleKey({ key: 'Enter', target: null, preventDefault() {} });
  assert.equal(app.ui.paletteOpen, false, 'Enter closes the palette');
  assert.ok(chosen, 'the palette had something highlighted');
});

test('the palette answers what a seller would actually type', async () => {
  const app = await makeFullApp();
  const cases = {
    proxy: 'app.section.settings',
    contrast: 'app.section.brand',
    stripped: 'app.section.specimens',
    objection: 'branch.create',
    budget: 'emit.budget',
    dry: 'rehearse.dryRun',
    sweep: 'rehearse.sweep',
    undo: 'app.undo',
  };
  for (const [query, expected] of Object.entries(cases)) {
    app.setUi({ paletteQuery: query, paletteIndex: 0 });
    const top = app.paletteMatches()[0];
    assert.ok(top, `"${query}" found nothing — the palette is the route of last resort`);
    assert.equal(top.id, expected, `"${query}" should reach ${expected}, reached ${top.id}`);
  }
});

test('a field-level action that the palette cannot run is still reachable by its section', async () => {
  const app = await makeFullApp();
  // `settings.setProxy` is a control, not a command. Typing what it does must
  // still land somewhere useful rather than nowhere at all (§20.10).
  app.setUi({ paletteQuery: 'cors' });
  const top = app.paletteMatches()[0];
  assert.ok(top && top.id === 'app.section.settings');
});

test('Enter in a field that says what Enter means runs it, with the field’s own argument', async () => {
  const app = await makeFullApp();
  app.ui.paletteOpen = false;
  app.ui.section = 'branches';
  const branch = app.proof.branches[0];
  app.select({ branchId: branch.id });
  app.setDraft('branch.alias', 'procurement gate');

  const target = {
    tagName: 'INPUT',
    value: 'procurement gate',
    getAttribute: (name) => ({
      type: 'text',
      'data-st-enter': 'branch.addAlias',
      'data-st-arg': branch.id,
    }[name] ?? null),
  };
  const ran = app.handleKey({ key: 'Enter', target, preventDefault() {} });
  assert.equal(ran, 'branch.addAlias');
  assert.ok(
    app.proof.branches.find((b) => b.id === branch.id).aliases.includes('procurement gate'),
    'the alias landed on the branch whose field it was typed into',
  );
});

test('every field that expects Enter names an action the registry knows', async () => {
  const app = await makeFullApp();
  const html = toHtml(renderAllPanels(app));
  const named = [...html.matchAll(/data-st-enter="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(named.length >= 3, 'the URL and alias fields at least');
  for (const id of new Set(named)) {
    assert.ok(index.byId.has(id), `${id} is wired to Enter but is not an action`);
  }
});
