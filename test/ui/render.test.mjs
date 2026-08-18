/**
 * Rendering: deterministic, non-mutating, and patched rather than replaced.
 *
 * The first two are §5 obligations that happen to be easy here — the studio's
 * tree is a pure function of its state and contains no closures, because
 * interaction is declared with `data-st-act` and delegated. The third is the
 * one that costs something: §15's editing surface would be unusable if every
 * keystroke re-mounted the tree and threw the caret away, so `ui/render.js`
 * patches in place, and this file proves it does with a document small enough
 * to reason about.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { h, toHtml } from '../../src/core/vdom.js';
import { Patcher, flatten, actionFor, defaultEventFor, valueOf, ACT_ATTR, ARG_ATTR, KEY_ATTR, PRESERVE_ATTR, RAW_ATTR } from '../../src/ui/render.js';
import { StudioApp } from '../../src/ui/app.js';
import { renderStudio } from '../../src/ui/layout.js';
import { renderAllPanels } from '../../src/ui/panels/index.js';
import { SECTIONS } from '../../src/ui/constants.js';
import { ProjectStore } from '../../src/core/storage.js';
import { fixtureDoc, fakeServices, makeClock } from '../fixtures/ui/studio-fixture.mjs';

// ---------------------------------------------------------------------------
// A document small enough to reason about
// ---------------------------------------------------------------------------

class FakeNode {
  constructor(type) {
    this.nodeType = type;
    this.childNodes = [];
    this.parentNode = null;
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) this.childNodes.splice(i, 1);
    child.parentNode = null;
    return child;
  }

  replaceChild(next, old) {
    const i = this.childNodes.indexOf(old);
    if (i < 0) return old;
    if (next.parentNode) next.parentNode.removeChild(next);
    this.childNodes[i] = next;
    next.parentNode = this;
    old.parentNode = null;
    return old;
  }
}

class FakeText extends FakeNode {
  constructor(value) { super(3); this.nodeValue = String(value); }
}

class FakeElement extends FakeNode {
  constructor(tag) {
    super(1);
    this.tagName = tag.toUpperCase();
    this.attributes = new Map();
    this.value = '';
    this.checked = false;
    this.innerHTMLValue = '';
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }

  set innerHTML(v) { this.innerHTMLValue = String(v); this.childNodes.length = 0; }
  get innerHTML() { return this.innerHTMLValue; }

  get content() { return this; }
  cloneNode() { const copy = new FakeElement(this.tagName); copy.innerHTMLValue = this.innerHTMLValue; return copy; }
}

const fakeDocument = {
  createElement: (tag) => new FakeElement(tag),
  createTextNode: (value) => new FakeText(value),
};

/** @param {any} node @returns {string} */
function serialize(node) {
  if (node instanceof FakeText) return node.nodeValue;
  const attrs = [...node.attributes].map(([k, v]) => ` ${k}="${v}"`).join('');
  return `<${node.tagName.toLowerCase()}${attrs}>${node.childNodes.map(serialize).join('')}${node.innerHTMLValue}</${node.tagName.toLowerCase()}>`;
}

// ---------------------------------------------------------------------------

/** @returns {Promise<any>} */
async function makeApp() {
  const clock = makeClock();
  const store = await ProjectStore.open({ clock, indexedDB: null });
  return new StudioApp({
    document: null, window: null, store, clock,
    services: fakeServices({ clock }), doc: fixtureDoc(),
  });
}

test('the same state renders identical HTML twice, in every section', async () => {
  const app = await makeApp();
  for (const section of SECTIONS) {
    app.ui.section = section.id;
    const first = toHtml(renderStudio(app));
    const second = toHtml(renderStudio(app));
    assert.equal(first, second, `${section.id} does not render deterministically`);
  }
});

test('rendering does not mutate the model', async () => {
  const app = await makeApp();
  const before = structuredClone(app.doc);
  toHtml(renderAllPanels(app));
  toHtml(renderStudio(app));
  assert.deepEqual(structuredClone(app.doc), before, 'a render that changes the model is a render that cannot be trusted');
});

test('two apps built from the same document render the same HTML', async () => {
  const a = await makeApp();
  const b = await makeApp();
  assert.equal(toHtml(renderStudio(a)), toHtml(renderStudio(b)));
});

test('the tree carries no functions, so it can be serialized and compared', async () => {
  const app = await makeApp();
  const seen = [];
  const walk = (node) => {
    for (const item of flatten(node)) {
      if (typeof item === 'function') seen.push('function child');
      if (item && typeof item === 'object' && item.a) {
        for (const [k, v] of Object.entries(item.a)) if (typeof v === 'function') seen.push(`${k} handler`);
        walk(item.c);
      }
    }
  };
  walk(renderStudio(app));
  assert.deepEqual(seen, [], 'interaction is declared with data-st-act, never bound as a closure');
});

test('the patcher updates text in place rather than replacing the node', () => {
  const root = new FakeElement('div');
  const patcher = new Patcher(root, fakeDocument);
  patcher.render(h('p', { class: 'a' }, 'one'));
  const paragraph = root.childNodes[0];
  const text = paragraph.childNodes[0];

  patcher.render(h('p', { class: 'a' }, 'two'));
  assert.equal(root.childNodes[0], paragraph, 'the element survived');
  assert.equal(paragraph.childNodes[0], text, 'and so did its text node');
  assert.equal(text.nodeValue, 'two');
});

test('the patcher writes value as a property and only when it differs', () => {
  const root = new FakeElement('div');
  const patcher = new Patcher(root, fakeDocument);
  patcher.render(h('input', { type: 'text', value: 'abc' }));
  const input = root.childNodes[0];
  assert.equal(input.value, 'abc');
  assert.equal(input.getAttribute('value'), null, 'value is a property, not an attribute — an attribute would fight the user');

  let writes = 0;
  Object.defineProperty(input, 'value', {
    get() { return this._v; },
    set(v) { writes += 1; this._v = v; },
    configurable: true,
  });
  input._v = 'abc';
  patcher.render(h('input', { type: 'text', value: 'abc' }));
  assert.equal(writes, 0, 'an unchanged value is never rewritten, so the caret never moves');
  patcher.render(h('input', { type: 'text', value: 'abcd' }));
  assert.equal(writes, 1);
});

test('an element marked preserve keeps its children', () => {
  const root = new FakeElement('div');
  const patcher = new Patcher(root, fakeDocument);
  patcher.render(h('div', { [PRESERVE_ATTR]: 'preview', class: 'host' }));
  const host = root.childNodes[0];
  const owned = new FakeElement('iframe');
  host.appendChild(owned);

  patcher.render(h('div', { [PRESERVE_ATTR]: 'preview', class: 'host changed' }));
  assert.equal(root.childNodes[0], host, 'the host element survived');
  assert.equal(host.childNodes[0], owned, 'and the runtime keeps the subtree it owns');
  assert.equal(host.getAttribute('class'), 'host changed', 'while its own attributes still update');
});

test('a keyed row that moves is replaced rather than silently mis-updated', () => {
  const root = new FakeElement('div');
  const patcher = new Patcher(root, fakeDocument);
  patcher.render([h('li', { [KEY_ATTR]: 'a' }, 'A'), h('li', { [KEY_ATTR]: 'b' }, 'B')]);
  const first = root.childNodes[0];
  patcher.render([h('li', { [KEY_ATTR]: 'b' }, 'B'), h('li', { [KEY_ATTR]: 'a' }, 'A')]);
  assert.notEqual(root.childNodes[0], first, 'the row whose identity changed was rebuilt');
  assert.equal(serialize(root.childNodes[0]), `<li data-st-key="b">B</li>`);
  assert.equal(serialize(root.childNodes[1]), `<li data-st-key="a">A</li>`);
});

test('raw markup is replaced only when its digest changes', () => {
  const root = new FakeElement('div');
  const patcher = new Patcher(root, fakeDocument);
  patcher.render(h('div', { [RAW_ATTR]: 'abc' }, '<svg></svg>'));
  const box = root.childNodes[0];
  box.marker = 1;
  patcher.render(h('div', { [RAW_ATTR]: 'abc' }, '<svg></svg>'));
  assert.equal(root.childNodes[0].marker, 1, 'the same digest is left alone');
  patcher.render(h('div', { [RAW_ATTR]: 'def' }, '<b>x</b>'));
  assert.equal(root.childNodes[0], box, 'the element itself is reused');
});

test('removed attributes are removed', () => {
  const root = new FakeElement('div');
  const patcher = new Patcher(root, fakeDocument);
  patcher.render(h('button', { class: 'a', disabled: true, title: 'why' }, 'x'));
  const btn = root.childNodes[0];
  assert.equal(btn.getAttribute('disabled'), '');
  patcher.render(h('button', { class: 'a' }, 'x'));
  assert.equal(btn.getAttribute('disabled'), null);
  assert.equal(btn.getAttribute('title'), null);
});

test('a shrinking child list drops exactly the surplus', () => {
  const root = new FakeElement('div');
  const patcher = new Patcher(root, fakeDocument);
  patcher.render([h('p', null, '1'), h('p', null, '2'), h('p', null, '3')]);
  assert.equal(root.childNodes.length, 3);
  patcher.render([h('p', null, '1')]);
  assert.equal(root.childNodes.length, 1);
  assert.equal(serialize(root.childNodes[0]), '<p>1</p>');
});

test('delegation finds the action on the nearest declaring ancestor', () => {
  const root = new FakeElement('div');
  const button = new FakeElement('button');
  button.setAttribute(ACT_ATTR, 'scene.select');
  button.setAttribute(ARG_ATTR, 'sc_1');
  const span = new FakeElement('span');
  button.appendChild(span);
  root.appendChild(button);

  const hit = actionFor(span, root, 'click');
  assert.ok(hit);
  assert.equal(hit.action, 'scene.select');
  assert.equal(hit.arg, 'sc_1');

  assert.equal(actionFor(span, root, 'input'), null, 'a button does not answer an input event');
});

test('controls declare the event that suits them', () => {
  const textarea = new FakeElement('textarea');
  assert.equal(defaultEventFor(textarea), 'input');
  const select = new FakeElement('select');
  assert.equal(defaultEventFor(select), 'change');
  const text = new FakeElement('input');
  text.setAttribute('type', 'text');
  assert.equal(defaultEventFor(text), 'input');
  const check = new FakeElement('input');
  check.setAttribute('type', 'checkbox');
  assert.equal(defaultEventFor(check), 'change');
  check.checked = true;
  assert.equal(valueOf(check), true);
});

test('a full studio render patches into a document without throwing', async () => {
  const app = await makeApp();
  const root = new FakeElement('div');
  const patcher = new Patcher(root, fakeDocument);
  for (const section of SECTIONS) {
    app.ui.section = section.id;
    patcher.render(renderStudio(app));
  }
  const html = serialize(root);
  assert.ok(html.length > 2000, 'something substantial was built');
  assert.match(html, /st-app/);
});

test('a render triggered from inside a render does not nest', async () => {
  const app = await makeApp();
  const root = new FakeElement('div');
  app.patcher = new Patcher(root, fakeDocument);
  app.document = fakeDocument;

  let passes = 0;
  let reentries = 0;
  const realSync = app.syncPreview.bind(app);
  app.syncPreview = () => {
    passes += 1;
    // The real thing does this indirectly: painting the canvas moves the
    // preview's runtime, the runtime announces the move, and the announcement
    // asks for another render.
    if (reentries < 50) { reentries += 1; app.render(); }
    realSync();
  };

  app.render();
  assert.ok(passes <= 3, `a re-entrant render must be coalesced, not nested (${passes} passes)`);
  assert.equal(app.rendering, false, 'and the guard is released afterwards');
  assert.equal(app.renderQueued, false);
});

test('the preview is not entered by the patcher even across many renders', async () => {
  const app = await makeApp();
  const root = new FakeElement('div');
  const patcher = new Patcher(root, fakeDocument);
  for (const section of SECTIONS) {
    app.ui.section = section.id;
    patcher.render(renderStudio(app));
  }
  const html = serialize(root);
  assert.equal(html.split('data-st-preserve').length - 1, 1, 'exactly one preserved subtree: the preview');
});
