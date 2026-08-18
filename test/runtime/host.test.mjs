/**
 * The DOM binding and the presenter view (§12).
 *
 * The host is exercised against a small document double rather than a real
 * browser: what matters here is the wiring — that the pre-rendered first paint
 * is adopted rather than replaced, that the keyboard is bound once, that the
 * motion budget reaches CSS, and that the presenter's timer counts up only when
 * the presenter starts it. The real browser check lives in
 * `scripts/verify-offline.mjs`, where it can also prove the network law.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { RuntimeHost, STAGE_ROOT_ID, PRERENDERED_ATTR, isTextEntry, cssEscape } from '../../src/runtime/host.js';
import { Runtime } from '../../src/runtime/runtime.js';
import { ManualTimer, renderPresenterView, PRESENTER_CSS, openPresenterWindow } from '../../src/runtime/presenter.js';
import { toHtml } from '../../src/core/vdom.js';
import { makeProof } from '../fixtures/make-proof.mjs';

/** A document double with just the surface the host touches. */
function fakeDocument({ prerendered = false } = {}) {
  const listeners = new Map();
  const root = {
    id: STAGE_ROOT_ID,
    attrs: prerendered ? { [PRERENDERED_ATTR]: '' } : {},
    children: [],
    mountCount: 0,
    ownerDocument: null,
    hasAttribute(n) { return n in this.attrs; },
    removeAttribute(n) { delete this.attrs[n]; },
    get firstChild() { return this.children[0] || null; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); },
    appendChild(c) { this.children.push(c); this.mountCount += 1; return c; },
    querySelector() { return null; },
  };
  const doc = {
    documentElement: { style: { props: {}, setProperty(k, v) { this.props[k] = v; } }, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } },
    body: root,
    activeElement: null,
    listeners,
    getElementById: (id) => (id === STAGE_ROOT_ID ? root : null),
    createTextNode: (t) => ({ text: t }),
    createElement: (t) => ({ tag: t, children: [], setAttribute() {}, appendChild(c) { this.children.push(c); } }),
    createElementNS: (ns, t) => ({ tag: t, ns, children: [], setAttribute() {}, appendChild(c) { this.children.push(c); } }),
    createDocumentFragment: () => ({ children: [], appendChild(c) { this.children.push(c); } }),
    addEventListener(type, fn) { listeners.set(type, (listeners.get(type) || []).concat(fn)); },
    removeEventListener(type, fn) { listeners.set(type, (listeners.get(type) || []).filter((f) => f !== fn)); },
    contains: () => true,
  };
  root.ownerDocument = doc;
  doc.root = root;
  return doc;
}

test('a pre-rendered first paint is adopted, not replaced', () => {
  const runtime = new Runtime(makeProof());
  const doc = fakeDocument({ prerendered: true });
  const host = new RuntimeHost(runtime, { document: doc, window: null }).attach();
  assert.equal(doc.root.mountCount, 0, 'the artifact must not repaint over what the browser already showed');
  assert.equal(doc.root.hasAttribute(PRERENDERED_ATTR), false, 'the marker is consumed once');
  runtime.run('nextBeat');
  assert.equal(doc.root.mountCount, 1, 'the first state change takes over rendering');
  host.detach();
});

test('a document with no pre-render is painted on attach', () => {
  const runtime = new Runtime(makeProof());
  const doc = fakeDocument();
  const host = new RuntimeHost(runtime, { document: doc, window: null }).attach();
  assert.equal(doc.root.mountCount, 1);
  host.detach();
});

test('the keyboard is bound on attach and released on detach', () => {
  const runtime = new Runtime(makeProof());
  const doc = fakeDocument();
  const host = new RuntimeHost(runtime, { document: doc, window: null }).attach();
  assert.equal(doc.listeners.get('keydown').length, 1);

  doc.listeners.get('keydown')[0]({ key: 'ArrowRight', preventDefault() {} });
  assert.equal(runtime.nav.beatIndex, 1);

  host.detach();
  assert.equal(doc.listeners.get('keydown').length, 0);
  doc.listeners.set('keydown', []);
  assert.equal(runtime.nav.beatIndex, 1, 'a detached host stops driving the deck');
});

test('detaching twice is safe', () => {
  const runtime = new Runtime(makeProof());
  const host = new RuntimeHost(runtime, { document: fakeDocument(), window: null }).attach();
  host.detach();
  assert.doesNotThrow(() => host.detach());
});

test('the motion budget reaches CSS as one variable', () => {
  const runtime = new Runtime(makeProof(), { reducedMotion: false });
  const doc = fakeDocument();
  new RuntimeHost(runtime, { document: doc, window: null }).attach();
  assert.equal(doc.documentElement.style.props['--pp-transition-ms'], '240ms');
  assert.equal(doc.documentElement.attrs['data-pp-reduced-motion'], 'false');

  const reduced = new Runtime(makeProof(), { reducedMotion: true });
  const doc2 = fakeDocument();
  new RuntimeHost(reduced, { document: doc2, window: null }).attach();
  assert.equal(doc2.documentElement.style.props['--pp-transition-ms'], '0ms');
  assert.equal(doc2.documentElement.attrs['data-pp-reduced-motion'], 'true');
});

test('a reduced-motion media query is honoured and watched', () => {
  const runtime = new Runtime(makeProof());
  const doc = fakeDocument();
  let handler = null;
  const win = {
    matchMedia: () => ({ matches: true, addEventListener: (_, fn) => { handler = fn; }, removeEventListener() {} }),
  };
  new RuntimeHost(runtime, { document: doc, window: win }).attach();
  assert.equal(runtime.reducedMotion, true);
  assert.equal(typeof handler, 'function');
});

test('text entry is detected so typing never drives the deck', () => {
  assert.equal(isTextEntry(null), false);
  assert.equal(isTextEntry({ tagName: 'TEXTAREA', getAttribute: () => null }), true);
  assert.equal(isTextEntry({ tagName: 'INPUT', getAttribute: (n) => (n === 'type' ? 'search' : null) }), true);
  assert.equal(isTextEntry({ tagName: 'INPUT', getAttribute: (n) => (n === 'type' ? 'checkbox' : null) }), false);
  assert.equal(isTextEntry({ tagName: 'DIV', getAttribute: (n) => (n === 'contenteditable' ? 'true' : null) }), true);
  assert.equal(isTextEntry({ tagName: 'BUTTON', getAttribute: () => null }), false);
});

test('attribute selector values are escaped', () => {
  assert.equal(cssEscape('el_1a2b'), 'el_1a2b');
  assert.equal(cssEscape('a"b'), 'a\\"b');
  assert.equal(cssEscape('a\\b'), 'a\\\\b');
});

// --------------------------------------------------------------- presenter

test('the manual timer counts up only once the presenter starts it', () => {
  let now = 0;
  const t = new ManualTimer(() => now);
  assert.equal(t.elapsed(), 0);
  assert.equal(t.label(), '00:00');

  now = 5000;
  assert.equal(t.elapsed(), 0, 'a timer nobody started has not started');

  t.start();
  now = 65000;
  assert.equal(t.elapsed(), 60000);
  assert.equal(t.label(), '01:00');

  t.pause();
  now = 200000;
  assert.equal(t.elapsed(), 60000, 'a paused timer stays paused');

  t.start();
  now = 210000;
  assert.equal(t.elapsed(), 70000);
  assert.equal(t.label(), '01:10');

  t.reset();
  assert.equal(t.elapsed(), 0);
  assert.equal(t.running, false);
});

test('the timer counts up, never down (§12)', () => {
  let now = 0;
  const t = new ManualTimer(() => now).start();
  const readings = [];
  for (const at of [1000, 2000, 3000, 10000]) { now = at; readings.push(t.elapsed()); }
  assert.deepEqual(readings, [1000, 2000, 3000, 10000]);
  assert.ok(readings.every((v, i) => i === 0 || v > readings[i - 1]));
});

test('the presenter view shows the beat, the note, what is next and the branches here', () => {
  const runtime = new Runtime(makeProof(), { mode: 'presenter' });
  runtime.run('nextBeat');
  runtime.run('nextBeat');
  runtime.run('nextBeat');       // into spine scene 1, which anchors bn_approvals
  const html = toHtml(renderPresenterView(runtime, { timerLabel: '02:13', timerRunning: true }));
  assert.ok(html.includes('02:13'));
  assert.ok(html.includes('Presenter note'));
  assert.ok(html.includes('Up next'));
  assert.ok(html.includes('Our approvals process would never allow this'));
  assert.ok(html.includes('Scene 2 / 5'));
  assert.ok(html.includes('Pause'), 'a running timer offers Pause');
});

test('the presenter view shows the pacing hint as a hint, not a countdown', () => {
  const runtime = new Runtime(makeProof(), { mode: 'presenter' });
  const html = toHtml(renderPresenterView(runtime, {}));
  assert.ok(html.includes('Pacing hint: 20s'));
  assert.ok(html.includes('never advances on its own'));
});

test('the presenter view flags being off the spine', () => {
  const runtime = new Runtime(makeProof(), { mode: 'presenter' });
  runtime.run('jump', 'bn_approvals');
  assert.ok(toHtml(renderPresenterView(runtime, {})).includes('Off spine'));
});

test('the presenter stylesheet shares no variable with the artifact or the studio', () => {
  assert.ok(!PRESENTER_CSS.includes('--pp-'), 'the presenter screen is not part of the proof');
  assert.ok(!PRESENTER_CSS.includes('--st-'), 'nor part of the studio chrome');
});

test('a blocked pop-up is reported rather than leaving the presenter pressing p at nothing', () => {
  const runtime = new Runtime(makeProof(), { mode: 'presenter' });
  const result = openPresenterWindow(runtime, { window: { open: () => null }, nowMs: () => 0 });
  assert.equal(result.opened, false);
  assert.doesNotThrow(() => result.close());
  assert.ok(result.timer instanceof ManualTimer);
});
