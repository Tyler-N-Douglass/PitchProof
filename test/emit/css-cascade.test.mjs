/**
 * The cascade evaluator the provenance law leans on.
 *
 * §18.1 says the label's contrast and size floors are "enforced at emit", which
 * means the emitter has to compute what the browser would compute. This file
 * pins the parts of the cascade that decide it: specificity, `!important`,
 * inline style, inheritance, custom properties, and which at-rule conditions
 * count. Where the evaluator is deliberately incomplete, the limit is asserted
 * here too, so `docs/decisions/L10-emit.md` and the code cannot drift.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseStylesheet, parseSelector, specificityOf, matchesSelector, computeCascade,
  parseDeclarations, resolveVars, resolveFontSize, parseOpacity, backgroundColorOf,
  conditionsApply, splitSelectorList,
} from '../../src/emit/css.js';

/** @param {string} tag @param {string[]} classes @param {object} [extra] */
const el = (tag, classes = [], extra = {}) => ({
  tag, id: extra.id || null, classes, attrs: { class: classes.join(' '), ...(extra.attrs || {}) },
  inlineStyle: extra.inlineStyle || '', childIndex: extra.childIndex || 0, siblingsBefore: extra.siblingsBefore || [],
});

const CHAIN = [el('html'), el('body'), el('div', ['pp-scene']), el('figure', ['pp-rendition']), el('span', ['pp-provenance'])];

/** @param {string} css @param {import('../../src/emit/css.js').ElementDesc[]} [chain] */
function computeLabel(css, chain = CHAIN) {
  const { rules } = parseStylesheet(css);
  return computeCascade(chain, rules)[chain.length - 1];
}

test('specificity is counted the way CSS counts it', () => {
  assert.deepEqual(specificityOf(parseSelector('*')), [0, 0, 0]);
  assert.deepEqual(specificityOf(parseSelector('span')), [0, 0, 1]);
  assert.deepEqual(specificityOf(parseSelector('.a')), [0, 1, 0]);
  assert.deepEqual(specificityOf(parseSelector('#a')), [1, 0, 0]);
  assert.deepEqual(specificityOf(parseSelector('div.a span')), [0, 1, 2]);
  assert.deepEqual(specificityOf(parseSelector('a[href]:first-child')), [0, 2, 1]);
  assert.deepEqual(specificityOf(parseSelector('span::before')), [0, 0, 2]);
  assert.deepEqual(specificityOf(parseSelector(':not(.a)')), [0, 1, 0]);
});

test('more specific wins, and source order breaks the tie', () => {
  assert.equal(computeLabel('.pp-provenance{color:red}span{color:blue}').props.color, 'red');
  assert.equal(computeLabel('.pp-provenance{color:red}.pp-provenance{color:blue}').props.color, 'blue');
  assert.equal(computeLabel('.pp-scene .pp-provenance{color:red}.pp-provenance{color:blue}').props.color, 'red');
});

test('!important beats specificity', () => {
  assert.equal(computeLabel('.pp-scene .pp-provenance{color:red}.pp-provenance{color:blue !important}').props.color, 'blue');
});

test('an inline style beats a stylesheet, and !important in the sheet does not save it', () => {
  const chain = CHAIN.slice(0, -1).concat([el('span', ['pp-provenance'], { inlineStyle: 'color:green' })]);
  assert.equal(computeLabel('.pp-provenance{color:red}', chain).props.color, 'green');
});

test('combinators resolve against the real ancestor chain', () => {
  const { rules } = parseStylesheet(
    '.pp-scene > .pp-provenance{color:red}'
    + '.pp-scene .pp-provenance{color:blue}'
    + 'figure > .pp-provenance{color:green}',
  );
  const matched = rules.filter((r) => matchesSelector(r.selector, CHAIN, CHAIN.length - 1)).map((r) => r.selectorText);
  assert.deepEqual(matched, ['.pp-scene .pp-provenance', 'figure > .pp-provenance']);
});

test('inherited properties flow down and non-inherited ones do not', () => {
  const inherited = computeLabel('.pp-scene{color:#123456;display:none}');
  assert.equal(inherited.props.color, '#123456');
  assert.equal(inherited.props.display, undefined, 'display is not inherited');
});

test('custom properties are inherited and var() resolves through them', () => {
  const style = computeLabel(':root{--brand:#abcdef}.pp-provenance{color:var(--brand)}');
  assert.equal(style.props.color, '#abcdef');
  assert.equal(resolveVars('var(--missing, #fallback)', {}), '#fallback');
  assert.equal(resolveVars('var(--a)', { '--a': 'var(--b)', '--b': '#111' }), '#111');
  assert.equal(resolveVars('1px solid var(--c, red)', {}), '1px solid red');
});

test('a var() redefined closer to the element wins', () => {
  const style = computeLabel(':root{--x:#000}.pp-rendition{--x:#fff}.pp-provenance{color:var(--x)}');
  assert.equal(style.props.color, '#fff');
});

test('font-size resolves through every unit that can hide a label', () => {
  assert.equal(resolveFontSize('12px', 16, 16), 12);
  assert.equal(resolveFontSize('0.5em', 20, 16), 10);
  assert.equal(resolveFontSize('0.5rem', 20, 16), 8);
  assert.equal(resolveFontSize('50%', 20, 16), 10);
  assert.equal(resolveFontSize('9pt', 16, 16), 12);
  assert.equal(resolveFontSize('smaller', 12, 16), 10);
  assert.equal(resolveFontSize(undefined, 14, 16), 14);
  assert.equal(resolveFontSize('clamp(2px, 4vw, 40px)', 16, 16), 2, 'a clamp() can render at its floor, so the floor is what a size law judges');
  assert.equal(resolveFontSize('min(3px, 20px)', 16, 16), 3);
});

test('font-size inherits down the chain and compounds', () => {
  const chain = [el('html'), el('body'), el('div', ['a'], { inlineStyle: 'font-size:20px' }), el('span', ['pp-provenance'], { inlineStyle: 'font-size:0.5em' })];
  assert.equal(computeLabel('', chain).fontSizePx, 10);
});

test('opacity multiplies down the chain', () => {
  const chain = [el('html'), el('body'), el('div', ['a'], { inlineStyle: 'opacity:0.5' }), el('span', ['pp-provenance'], { inlineStyle: 'opacity:0.5' })];
  assert.equal(computeLabel('', chain).effectiveOpacity, 0.25);
  assert.equal(parseOpacity('0'), 0);
  assert.equal(parseOpacity('50%'), 0.5);
  assert.equal(parseOpacity(undefined), 1);
  assert.equal(parseOpacity('nonsense'), 1);
});

test('a background shorthand yields its colour, and a gradient does not pretend to', () => {
  assert.equal(backgroundColorOf({ props: { background: 'url(data:image/gif;base64,AA) #fff no-repeat' } }), '#fff');
  assert.equal(backgroundColorOf({ props: { background: '#123456' } }), '#123456');
  assert.equal(backgroundColorOf({ props: { 'background-color': 'red', background: '#fff' } }), 'red');
  assert.equal(backgroundColorOf({ props: {} }), null);
});

test('@media print is skipped and every other condition is treated as applying', () => {
  assert.equal(conditionsApply([]), true);
  assert.equal(conditionsApply(['@media print']), false);
  assert.equal(conditionsApply(['@media speech']), false);
  assert.equal(conditionsApply(['@media screen']), true);
  assert.equal(conditionsApply(['@media (min-width: 600px)']), true);
  assert.equal(conditionsApply(['@media (max-width: 1px)']), true, 'a width nobody uses is still treated as applying — the fail-safe direction');
  assert.equal(conditionsApply(['@supports (display: grid)']), true);
  assert.equal(conditionsApply(['@media print, screen']), true);
});

test('nested at-rules keep their conditions and still contribute', () => {
  const { rules } = parseStylesheet('@supports (display:grid){@media (min-width:600px){.pp-provenance{opacity:0}}}');
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0].conditions, ['@supports (display:grid)', '@media (min-width:600px)']);
  assert.equal(computeLabel('@supports (display:grid){@media (min-width:600px){.pp-provenance{opacity:0}}}').effectiveOpacity, 0);
});

test('interaction pseudo-classes are ignored — a documented limit', () => {
  assert.equal(computeLabel('.pp-provenance:hover{display:none}').props.display, undefined);
  assert.equal(computeLabel('.pp-provenance:focus{opacity:0}').effectiveOpacity, 1);
});

test('pseudo-element rules do not style the element itself — a documented limit', () => {
  assert.equal(computeLabel('.pp-provenance::before{content:"x";display:none}').props.display, undefined);
});

test('comments cannot smuggle a declaration past the parser', () => {
  assert.equal(computeLabel('.pp-provenance{/* display:none; */ color:red}').props.display, undefined);
  assert.equal(computeLabel('.pp-provenance{/* } */ color:red}').props.color, 'red');
});

test('declarations parse with values that contain colons, commas and functions', () => {
  const decls = parseDeclarations('background:url(data:image/gif;base64,AA);font:12px/1.4 "A, B";color:rgb(1,2,3) !important');
  assert.deepEqual(decls.map((d) => d.prop), ['background', 'font', 'color']);
  assert.equal(decls[2].important, true);
  assert.equal(decls[2].value, 'rgb(1,2,3)');
});

test('a selector list splits on top-level commas only', () => {
  assert.deepEqual(splitSelectorList('a, b').map((s) => s.trim()), ['a', 'b']);
  assert.deepEqual(splitSelectorList(':is(a, b), c').map((s) => s.trim()), [':is(a, b)', 'c']);
  assert.deepEqual(splitSelectorList('[title="a,b"], c').map((s) => s.trim()), ['[title="a,b"]', 'c']);
});

test('the real runtime stylesheet parses into rules with the label rule intact', async () => {
  const { runtimeBundle } = await import('../fixtures/emit/runtime-bundle.mjs');
  const { rules } = parseStylesheet(runtimeBundle().css);
  assert.ok(rules.length > 20, 'the runtime stylesheet should parse into many rules');
  const label = rules.find((r) => r.selectorText === '.pp-provenance');
  assert.ok(label, 'the .pp-provenance rule must be found');
  const props = Object.fromEntries(label.declarations.map((d) => [d.prop, d.value]));
  assert.equal(props['font-size'], '12px');
  assert.equal(props.opacity, '1');
  assert.equal(props.visibility, 'visible');
});
