/**
 * The rendering substrate (DECISIONS D4). Layouts are pure functions to a VNode
 * tree; `toHtml` is what the emitter writes and what every headless test reads,
 * so its escaping and determinism are load-bearing for §13's network scan.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { h, raw, cx, styleString, toHtml, escapeAttr, escapeText, walk, textOf, findByAttr, collectByAttr, VOID_ELEMENTS } from '../../src/core/vdom.js';

test('elements serialize with attributes in declaration order', () => {
  assert.equal(toHtml(h('div', { id: 'a', class: 'b' }, 'x')), '<div id="a" class="b">x</div>');
  assert.equal(toHtml(h('div', { class: 'b', id: 'a' }, 'x')), '<div class="b" id="a">x</div>');
});

test('void elements never get a closing tag', () => {
  for (const tag of VOID_ELEMENTS) {
    assert.equal(toHtml(h(tag, { a: '1' })), `<${tag} a="1">`);
  }
});

test('boolean, null and false attributes behave like the DOM', () => {
  assert.equal(toHtml(h('input', { disabled: true, checked: false, value: null })), '<input disabled>');
});

test('text and attribute escaping closes every injection route', () => {
  assert.equal(escapeText('<script>&"'), '&lt;script&gt;&amp;"');
  assert.equal(escapeAttr('a"b<c>&'), 'a&quot;b&lt;c&gt;&amp;');
  const evil = '"><img src=x onerror=alert(1)>';
  const html = toHtml(h('div', { title: evil }, evil));
  assert.ok(!html.includes('<img'), html);
});

test('raw nodes pass through untouched, which is why the emitter re-scans output', () => {
  assert.equal(toHtml(raw('<svg viewBox="0 0 1 1"></svg>')), '<svg viewBox="0 0 1 1"></svg>');
});

test('script and style children are not entity-escaped', () => {
  assert.equal(toHtml(h('style', null, '.a > .b { color: red }')), '<style>.a > .b { color: red }</style>');
  assert.equal(toHtml(h('script', null, 'if (a < b) {}')), '<script>if (a < b) {}</script>');
});

test('style objects serialize deterministically with px defaults and unitless exceptions', () => {
  assert.equal(styleString({ width: 10, opacity: 0.5, lineHeight: 1.4, '--pp-x': 'red' }), 'width:10px;opacity:0.5;line-height:1.4;--pp-x:red');
  assert.equal(styleString({ width: null, height: undefined, top: false, left: '' }), '');
});

test('cx composes class names from strings, arrays and conditionals', () => {
  assert.equal(cx('a', ['b', null], { c: true, d: false }, undefined), 'a b c');
});

test('arrays and falsy children flatten without introducing whitespace', () => {
  assert.equal(toHtml([h('i', null, 'a'), null, false, undefined, h('i', null, 'b')]), '<i>a</i><i>b</i>');
});

test('walk, textOf and attribute queries traverse in document order', () => {
  const tree = h('section', { 'data-el': 'root' },
    h('h1', { 'data-el': 'a' }, 'Head'),
    h('p', { 'data-el': 'b' }, 'One ', h('em', null, 'two')),
  );
  const seen = [];
  walk(tree, (el) => { seen.push(el.t); return undefined; });
  assert.deepEqual(seen, ['section', 'h1', 'p', 'em']);
  assert.equal(textOf(tree), 'HeadOne two');
  assert.equal(findByAttr(tree, 'data-el', 'b').t, 'p');
  assert.equal(findByAttr(tree, 'data-el', 'zzz'), null);
  assert.deepEqual(collectByAttr(tree, 'data-el').map((e) => e.a['data-el']), ['root', 'a', 'b']);
});

test('walk can prune a subtree', () => {
  const tree = h('a', null, h('b', null, h('c', null)), h('d', null));
  const seen = [];
  walk(tree, (el) => { seen.push(el.t); return el.t === 'b' ? false : undefined; });
  assert.deepEqual(seen, ['a', 'b', 'd']);
});

test('serializing the same tree twice yields identical bytes', () => {
  const build = () => h('div', { class: 'x' }, [h('p', null, 'one'), h('p', null, 'two')]);
  assert.equal(toHtml(build()), toHtml(build()));
});
