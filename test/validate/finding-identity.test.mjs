/**
 * **What identifies a finding, and what it must survive.**
 *
 * A finding's id is a hash of its code, its locus and a **key** the rule mints
 * (L11-D13). That key does two jobs at once and they pull in opposite
 * directions: it has to be *stable*, so a dismissal, an auto-fix and the
 * studio's blocking list survive the next sweep, and it has to be *complete*,
 * so two different defects are never the same finding. `sortFindings` drops
 * duplicate ids by design — two rules reaching the same conclusion about the
 * same place should be one finding — which makes an incomplete key silent
 * rather than noisy. Under-reporting is the failure §22.2 cannot tolerate.
 *
 * CRITIQUE-2's C1, second half (L8-D10): `TEXT_OVERFLOW` keyed on
 * `box.elementId`, and `elementId` is the *nearest revealable ancestor* — what
 * a beat reveals, not what a text run is. Every run in one panel shares it, so
 * a headline and a body paragraph that both overflowed produced one finding.
 * Twenty were suppressed on the corpus proof.
 *
 * This file pins both halves of the property, for `TEXT_OVERFLOW` and for the
 * one other key that could collapse the same way (`BEAT_EMPTY`, L11-D27), and
 * pins the two collapses that are **correct** so they stay deliberate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectOverflow, detectBoxOverflow, boxKey, boxOrdinals, runPreflight, sortFindings, makeFinding,
} from '../../src/validate/index.js';
import { cleanProof, copy, NOW } from '../fixtures/validate/defects.mjs';

const clock = () => NOW;

/**
 * A text box wide enough to overflow whatever container it is given.
 * @param {object} over
 */
function box(over = {}) {
  return {
    elementId: 'el_panel',
    role: 'body',
    text: 'Northwind Industrial builds the heat exchangers and separators that '
      + 'run continuously in plants that cannot afford to stop for a shutdown.',
    style: { family: 'Arial', weight: 400, fontSizePx: 18, lineHeight: 1.4, letterSpacingPx: 0, textTransform: 'none' },
    containerWidthPx: 120,
    containerHeightPx: 40,
    textOverflow: 'clip',
    containerId: 'splitCell#1',
    slot: 'splitCell',
    ...over,
  };
}

/** @param {any[]} boxes */
const detect = (boxes, breakpoint = 'md') =>
  detectOverflow({ sceneId: 'sc_x', breakpoint, boxes }, null);

// ---------------------------------------------------------------------------
// The defect: two runs in one cell are two findings
// ---------------------------------------------------------------------------

test('two roles under one revealable element are two findings, not one (C1 / L8-D10)', () => {
  // The exact shape `sceneHead` renders: a headline and a subhead inside one
  // `data-pp-el`, both overflowing. Keying on the element alone made these one.
  const found = detect([
    box({ role: 'headline', text: 'Vom Reinigungsintervall her denken, nicht vom Auslegungspunkt' }),
    box({ role: 'subhead', text: 'https://www.northwind-industrial.example/de/einblicke/verschmutzungsreserve' }),
  ]);
  const roles = new Set(found.map((f) => f.detail.role));
  assert.deepEqual([...roles].sort(), ['headline', 'subhead']);
  assert.equal(new Set(found.map((f) => f.id)).size, found.length,
    'each box must own its finding ids outright');
});

test('two runs of the same role under one element are two findings', () => {
  // Two bullets in one list, two cells with the same role in one panel: the
  // role no longer separates them, so the ordinal has to.
  const found = detect([
    box({ role: 'body', text: 'The published fouling resistances are a starting point, not an answer.' }),
    box({ role: 'body', text: 'A margin chosen from a table is a margin nobody has measured on this duty.' }),
  ]);
  const ordinals = found.map((f) => f.detail.orderInElement).sort();
  assert.deepEqual([...new Set(ordinals)], [0, 1]);
  assert.equal(new Set(found.map((f) => f.id)).size, found.length);
});

test('a box with no revealable ancestor is still told apart from its siblings', () => {
  const found = detect([
    box({ elementId: null, role: 'body', text: 'One long unrevealed run that does not fit its container at all.' }),
    box({ elementId: null, role: 'body', text: 'A second unrevealed run, equally unable to fit the same container.' }),
  ]);
  assert.equal(found.length >= 2, true);
  assert.equal(new Set(found.map((f) => f.id)).size, found.length);
});

test('the ordinal is scoped to the (element, role) pair, so it stays local', () => {
  const boxes = [
    box({ elementId: 'el_a', role: 'headline' }),
    box({ elementId: 'el_b', role: 'body' }),
    box({ elementId: 'el_a', role: 'headline' }),
    box({ elementId: 'el_b', role: 'body' }),
  ];
  assert.deepEqual(boxOrdinals(boxes), [0, 0, 1, 1]);
  // Inserting a box under one element must not renumber the other's.
  const inserted = [boxes[0], box({ elementId: 'el_a', role: 'headline' }), boxes[1], boxes[2], boxes[3]];
  assert.deepEqual(boxOrdinals(inserted), [0, 1, 0, 2, 1]);
  const before = detect(boxes).filter((f) => f.detail.elementId === 'el_b').map((f) => f.id);
  const after = detect(inserted).filter((f) => f.detail.elementId === 'el_b').map((f) => f.id);
  assert.deepEqual(after, before, "el_b's findings must not churn because el_a grew a headline");
});

// ---------------------------------------------------------------------------
// The other half: stability
// ---------------------------------------------------------------------------

test('the id survives a re-render, a re-measurement and an edit to the copy', () => {
  const base = box({ role: 'headline' });
  const id = detect([base]).map((f) => f.id);
  assert.deepEqual(detect([copy(base)]).map((f) => f.id), id, 'a second sweep of the same box');

  // Nothing measured is in the key. A font substitution, a threshold change or
  // a fractional shift in the container must not mint a new finding — the whole
  // point of L11-D13 — and neither must a copy edit, because editing the copy
  // is how a seller *fixes* an overflow. An id that churned there would churn
  // hardest in exactly the workflow it exists to support.
  assert.deepEqual(detect([{ ...base, containerWidthPx: 120.4 }]).map((f) => f.id), id);
  assert.deepEqual(detect([{ ...base, style: { ...base.style, fontSizePx: 19 } }]).map((f) => f.id), id);
  assert.deepEqual(
    detect([{ ...base, text: `${base.text} And one more sentence that also does not fit.` }]).map((f) => f.id),
    id,
    'a rewritten headline that still overflows is the same outstanding defect',
  );
  // And when the edit works, the finding goes away rather than changing id.
  assert.deepEqual(detect([{ ...base, text: 'Short.' }]), []);
});

test('the id does not survive a change to what the finding is about', () => {
  const base = box({ role: 'headline' });
  const id = detect([base])[0].id;
  const different = [
    ['a different breakpoint', detect([base], 'lg')[0].id],
    ['a different role', detect([{ ...base, role: 'subhead' }])[0].id],
    ['a different revealable element', detect([{ ...base, elementId: 'el_other' }])[0].id],
    ['a different scene', detectOverflow({ sceneId: 'sc_y', breakpoint: 'md', boxes: [base] }, null)[0].id],
  ];
  for (const [what, other] of different) assert.notEqual(other, id, `${what} must be a different finding`);
});

test('the three axes of one box are three findings, and only three', () => {
  // Width, height and clamp are separate remedies — shrink, reflow, rewrite —
  // so they are separate findings on purpose. The axis is in the key.
  const found = detect([box({ maxLines: 1, whiteSpace: 'nowrap', containerHeightPx: 12 })]);
  const axes = found.map((f) => f.detail.axis);
  assert.deepEqual([...new Set(axes)].sort(), axes.slice().sort(), 'no axis is reported twice');
  assert.ok(axes.length >= 2, 'this box overflows on more than one axis');
  assert.equal(new Set(found.map((f) => f.id)).size, found.length);
});

test('boxKey names the element, the role and the ordinal, and nothing measured', () => {
  assert.equal(boxKey({ elementId: 'el_1', role: 'headline' }, 0), 'el_1|headline|0');
  assert.equal(boxKey({ elementId: 'el_1', role: 'headline' }, 2), 'el_1|headline|2');
  assert.equal(boxKey({ elementId: null, role: 'body' }, 0), '-|body|0');
  assert.equal(boxKey({ role: 'body' }, undefined), '-|body|0');
  // Two boxes that differ only in text, style or container share a key: the key
  // is a position in a layout, not a measurement of one.
  assert.equal(
    boxKey({ elementId: 'el_1', role: 'body', text: 'a', containerWidthPx: 10 }, 1),
    boxKey({ elementId: 'el_1', role: 'body', text: 'b', containerWidthPx: 900 }, 1),
  );
});

test('detectBoxOverflow called on its own defaults the ordinal rather than guessing', () => {
  // The policy tests call it with a single box and no ordinal (L11-D11); that
  // box is the first of its pair by definition.
  const one = detectBoxOverflow(box(), { sceneId: 'sc_x', breakpoint: 'md', index: 0 }, null);
  assert.ok(one.length > 0);
  for (const f of one) assert.equal(f.detail.orderInElement, 0);
});

// ---------------------------------------------------------------------------
// BEAT_EMPTY — the same collapse, one rule over (L11-D27)
// ---------------------------------------------------------------------------

/** @param {any} proof */
const preflight = (proof) => runPreflight(proof, { clock });

test('two beats declaring the same id are two BEAT_EMPTY findings', async () => {
  // §4 requires `Beat.id` to be a string and never says it is unique, so a
  // proof carrying two beats with one id is a legal proof — and both of them
  // reveal nothing, which is two dead keypresses in front of the room.
  const proof = cleanProof();
  proof.spine[0].beats.push(
    { id: 'sc_a_dup', reveals: [], presenterNote: null, dwellHintMs: null },
    { id: 'sc_a_dup', reveals: [], presenterNote: null, dwellHintMs: null },
  );
  const found = (await preflight(proof)).filter((f) => f.code === 'BEAT_EMPTY');
  assert.equal(found.length, 2, 'both dead beats must be reported');
  assert.equal(new Set(found.map((f) => f.id)).size, 2);
  assert.deepEqual(found.map((f) => f.detail.beatIndex).sort((a, b) => a - b),
    [proof.spine[0].beats.length - 2, proof.spine[0].beats.length - 1]);
});

test('an unnamed beat cannot collide with a beat whose id is its index', async () => {
  const proof = cleanProof();
  const beats = proof.spine[0].beats;
  proof.spine[0].beats = [
    ...beats,
    { id: '', reveals: [], presenterNote: null, dwellHintMs: null },
    { id: String(beats.length), reveals: [], presenterNote: null, dwellHintMs: null },
  ];
  const found = (await preflight(proof)).filter((f) => f.code === 'BEAT_EMPTY');
  assert.equal(found.length, 2);
  assert.equal(new Set(found.map((f) => f.id)).size, 2);
});

test('a scene whose beat ids are unique keeps the ids it had', async () => {
  // The stability half: the ordinal is 0 for every beat of every scene the tool
  // builds, so adding the disambiguator changed no existing finding's identity.
  const proof = cleanProof();
  proof.spine[0].beats.push({ id: 'sc_a_bdead', reveals: [], presenterNote: null, dwellHintMs: null });
  const once = (await preflight(proof)).filter((f) => f.code === 'BEAT_EMPTY');
  const again = (await preflight(copy(proof))).filter((f) => f.code === 'BEAT_EMPTY');
  assert.equal(once.length, 1);
  assert.deepEqual(again.map((f) => f.id), once.map((f) => f.id));
});

// ---------------------------------------------------------------------------
// The collapses that are correct, kept deliberately
// ---------------------------------------------------------------------------

test('two rules reaching one conclusion about one place stay one finding', () => {
  // This is what `sortFindings` de-duplication is *for*, and it is why an
  // incomplete key is silent instead of noisy. Preflight duplicates two of the
  // emitter's checks on purpose (L11-D8) and the two answers must merge.
  const spec = {
    code: 'NETWORK_REFERENCE',
    locus: { assetId: 'md_hero' },
    key: 'media:md_hero',
    message: 'The hero image points at the network and would not load offline.',
  };
  const merged = sortFindings([makeFinding(spec), makeFinding({ ...spec, message: `${spec.message} Again.` })]);
  assert.equal(merged.length, 1);
});

test('a contrast pair measured twice is one finding, and the roles are why', () => {
  // The same foreground/background pair can be reached both as a text role and
  // as a display pair. The colours are the same, the minimum is the same and
  // the remedy is the same, so it is one defect — collapsing it is right, and
  // it is right *because* the key names the pair rather than the visit.
  const a = makeFinding({
    code: 'CONTRAST_FAIL', severity: 1, key: 'pair:onSurface/surface:body',
    message: 'Body text in onSurface on surface measures 3.10:1 — below the 4.5:1 body-text minimum.',
  });
  const b = makeFinding({
    code: 'CONTRAST_FAIL', severity: 1, key: 'pair:onSurface/surface:body',
    message: 'Display text in onSurface on surface measures 3.10:1 — below the 4.5:1 body-text minimum.',
  });
  assert.equal(a.id, b.id);
  assert.equal(sortFindings([a, b]).length, 1);
  // But the same pair held to a *different* minimum is a different defect.
  const nonText = makeFinding({
    code: 'CONTRAST_FAIL', severity: 2, key: 'pair:onSurface/surface:nontext',
    message: 'A border in onSurface against surface measures 2.10:1 — below the 3:1 non-text minimum.',
  });
  assert.notEqual(nonText.id, a.id);
});

test('the corpus sweep names every overflowing box exactly once', async () => {
  // The end-to-end statement of the same property, without a browser: no two
  // TEXT_OVERFLOW findings of one sweep may describe the same box and axis, and
  // no finding id may describe two boxes.
  const proof = cleanProof();
  const findings = (await preflight(proof)).filter((f) => f.code === 'TEXT_OVERFLOW');
  const byBox = new Map();
  for (const f of findings) {
    const d = f.detail;
    const k = `${f.locus.sceneId}|${d.breakpoint}|${d.elementId || '-'}|${d.role}|${d.orderInElement}|${d.axis}`;
    assert.equal(byBox.has(k), false, `two findings describe ${k}`);
    byBox.set(k, f.id);
  }
  assert.equal(new Set(byBox.values()).size, byBox.size, 'one id, one box, one axis');
});
