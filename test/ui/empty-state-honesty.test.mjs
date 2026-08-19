/**
 * §18 turned on the studio itself.
 *
 * The honesty laws are about what the *artifact* claims, but the same
 * discipline has to hold one level up: a tool that misstates its own
 * capability is lying to the person deciding whether to trust it. CRITIQUE-1
 * F22 is the whole argument in one string — with zero branches the jump-index
 * hint read "The branch lane builds this index; it is **not wired into this
 * build**". The lane was wired. There were simply no branches. A seller who
 * reads that reasonably concludes the jump index does not work, and stops using
 * the interaction §11 names as the product's headline.
 *
 * One false empty-state string is a category rather than an incident, so this
 * file guards the category:
 *
 *   - **No rendered string may assert that something is absent from the build.**
 *     The nine lanes have all landed, so "not wired", "not implemented", "not
 *     in this build", "coming soon" and their relatives are now false wherever
 *     they reach the screen. The studio *does* carry honest versions of those
 *     sentences — `services.has(lane)` gates every one of them — so the test
 *     first asserts every lane really is wired, and then that none of those
 *     sentences renders. If a lane genuinely goes missing, the first assertion
 *     fails and names it, rather than the second one flagging a true sentence.
 *
 *   - **Assertions are made against the rendered tree, not the source text.** A
 *     banned phrase in a comment, in a JSDoc block or in a string the panel
 *     never returns is not a lie to anybody; a banned phrase inside a `title`
 *     or `placeholder` attribute is on screen and must not hide from a grep of
 *     text nodes. So the walk collects text nodes, raw markup, and the four
 *     attributes that paint: `title`, `placeholder`, `aria-label`, `alt`.
 *
 *   - **The empty states must still say something true and actionable.** A
 *     banned-phrase test alone is passed by deleting the sentence, which trades
 *     a false empty state for a blank one. The positive assertions below pin
 *     what each fixed string now has to say and what it must not go back to.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StudioApp } from '../../src/ui/app.js';
import { PANELS } from '../../src/ui/panels/index.js';
import { renderInspector } from '../../src/ui/inspector.js';
import { renderStudio } from '../../src/ui/layout.js';
import { emitBlockers } from '../../src/ui/gate.js';
import { ProjectStore } from '../../src/core/storage.js';
import { makeClock } from '../fixtures/ui/studio-fixture.mjs';

/**
 * A studio on the **real** lane adapter. The fake adapter would prove nothing
 * here: the question this file asks is whether the shipped studio tells the
 * truth about the shipped build.
 * @returns {Promise<any>}
 */
async function studio() {
  const clock = makeClock();
  const store = await ProjectStore.open({ clock, indexedDB: null });
  return new StudioApp({ document: null, window: null, store, clock });
}

/** Attributes that paint. Everything else in a VNode is machinery. */
const VISIBLE_ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];

/**
 * Every string a viewer of this tree could read, in render order.
 * @param {any} node
 * @param {string[]} [out]
 * @returns {string[]}
 */
function visibleStrings(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out;
  if (Array.isArray(node)) { for (const child of node) visibleStrings(child, out); return out; }
  if (typeof node === 'string' || typeof node === 'number') {
    const s = String(node).trim();
    if (s) out.push(s);
    return out;
  }
  if (typeof node !== 'object') return out;
  if ('raw' in node) {
    // Raw markup paints too. Strip the tags and keep whatever text was inside.
    const s = String(node.raw).replace(/<[^>]*>/g, ' ').trim();
    if (s) out.push(s);
    return out;
  }
  for (const attr of VISIBLE_ATTRS) {
    const v = node.a ? node.a[attr] : null;
    if (typeof v === 'string' && v.trim()) out.push(v.trim());
  }
  for (const child of node.c || []) visibleStrings(child, out);
  return out;
}

/**
 * The phrases that assert absence, each with the reason it is a lie in a build
 * where every lane has landed. The reason is printed on failure, so whoever
 * trips this reads the argument rather than only the rule.
 */
const ABSENCE_PHRASES = [
  [/not wired/i, 'every lane is wired; an empty collection is not an unwired lane'],
  [/unwired/i, 'every lane is wired'],
  [/into this build/i, 'the "…not X into this build" family; all nine lanes have landed'],
  [/not in this build/i, 'all nine lanes have landed'],
  [/not implemented/i, 'nothing on these panels is unimplemented'],
  [/unimplemented/i, 'nothing on these panels is unimplemented'],
  [/\bnot built\b/i, 'nothing on these panels is unbuilt'],
  [/coming soon/i, 'nothing here is a promise of future work'],
  [/\bTODO\b/i, 'a TODO on screen is an unfinished product, not an empty project'],
  [/\bFIXME\b/i, 'a FIXME on screen is an unfinished product'],
  [/\bstubs?\b/i, 'no control on these panels is a stub'],
  [/work in progress/i, 'the studio is not shipped as a work in progress'],
  [/under construction/i, 'the studio is not shipped under construction'],
  [/has not landed/i, 'every lane has landed'],
  [/(until|when|once) it lands/i, 'every lane has landed'],
  [/not yet (available|supported|wired|implemented)/i, 'all of it is available'],
  [/(is|are) not supported/i, 'nothing a panel offers is unsupported'],
  [/\bunsupported\b/i, 'nothing a panel offers is unsupported'],
  [/\bno-?op\b/i, 'no control on these panels does nothing'],
  [/\bplaceholder for\b/i, 'nothing rendered here stands in for a real result'],
  [/\bdummy\b/i, 'nothing rendered here is fabricated filler'],
  [/\bmock(ed)?\b/i, 'nothing rendered here is mocked'],
];

/**
 * Assert nothing this tree paints asserts absence.
 * @param {any} tree
 * @param {string} where
 */
function assertNoAbsenceClaims(tree, where) {
  const strings = visibleStrings(tree);
  assert.ok(strings.length > 0, `${where} rendered nothing at all`);
  for (const s of strings) {
    for (const [pattern, why] of ABSENCE_PHRASES) {
      assert.ok(
        !pattern.test(s),
        `${where} paints an absence claim matching ${pattern} — ${why}.\n  “${s}”`,
      );
    }
  }
}

/**
 * Every surface the studio can paint, in one state.
 * @param {any} app
 * @returns {{where: string, tree: any}[]}
 */
function surfaces(app) {
  const out = [];
  const section = app.ui.section;
  for (const id of Object.keys(PANELS)) {
    app.ui.section = id;
    out.push({ where: `panel:${id}`, tree: PANELS[id](app) });
  }
  app.ui.section = section;
  out.push({ where: 'inspector', tree: renderInspector(app) });
  out.push({ where: 'shell', tree: renderStudio(app) });
  return out;
}

// ------------------------------------------------------------- the guard ---

test('every lane really is wired, so an absence claim would be a lie', async () => {
  const app = await studio();
  assert.deepEqual(
    app.services.missing(),
    [],
    'a lane is genuinely missing — fix that first; the honesty sweep below assumes all nine landed',
  );
});

test('no panel, inspector or shell asserts absence in a brand-new project', async () => {
  const app = await studio();
  for (const { where, tree } of surfaces(app)) assertNoAbsenceClaims(tree, `${where} (new project)`);
});

test('no surface asserts absence with a spine scene and no branches', async () => {
  const app = await studio();
  app.dispatch('scene.add', 'quoteCard');
  for (const { where, tree } of surfaces(app)) assertNoAbsenceClaims(tree, `${where} (one scene)`);
});

test('no surface asserts absence with a branch and no spine', async () => {
  const app = await studio();
  app.dispatch('branch.objectionDraft', undefined, { value: 'Our approvals process would never allow this' });
  app.dispatch('branch.create');
  for (const { where, tree } of surfaces(app)) assertNoAbsenceClaims(tree, `${where} (one branch, no spine)`);
});

test('no surface asserts absence once a scene and a branch both exist', async () => {
  const app = await studio();
  app.dispatch('scene.add', 'quoteCard');
  app.dispatch('branch.objectionDraft', undefined, { value: 'Legal has to see every claim' });
  app.dispatch('branch.create');
  for (const { where, tree } of surfaces(app)) assertNoAbsenceClaims(tree, `${where} (scene and branch)`);
});

// ----------------------------------------------------------------- F22 -----

/**
 * Every element in a tree matching a predicate, in render order.
 * @param {any} node
 * @param {(n: any) => boolean} match
 * @param {any[]} [out]
 * @returns {any[]}
 */
function find(node, match, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const c of node) find(c, match, out); return out; }
  if ('raw' in node) return out;
  if (match(node)) out.push(node);
  for (const c of node.c || []) find(c, match, out);
  return out;
}

/** The `<input>` the jump-index query is typed into. @param {any} tree @returns {any} */
function jumpInput(tree) {
  const found = find(tree, (n) => n.t === 'input' && n.a && n.a['data-st-key'] === 'jump-query');
  assert.equal(found.length, 1, 'the jump-index query field is still on the branches panel');
  return found[0];
}

/**
 * The hint rendered beneath the jump-index query field — the string F22 was
 * about. Found through the field's own structure rather than by counting
 * strings, so a placeholder appearing or disappearing cannot shift it.
 * @param {any} app
 * @returns {string}
 */
function jumpHint(app) {
  app.ui.section = 'branches';
  const fields = find(PANELS.branches(app), (n) => n.t === 'label'
    && find(n, (m) => m.t === 'input' && m.a && m.a['data-st-key'] === 'jump-query').length > 0);
  assert.equal(fields.length, 1, 'exactly one jump-index field');
  const hints = find(fields[0], (n) => n.a && String(n.a.class || '').includes('st-field-hint'));
  assert.equal(hints.length, 1, 'the jump-index field always carries a hint');
  return visibleStrings(hints[0]).join(' ');
}

test('F22: with no branches the jump hint says there are no branches, not that the lane is unwired', async () => {
  const app = await studio();
  const hint = jumpHint(app);
  assert.match(hint, /no branches yet/i, 'it names the real, empty-collection reason');
  assert.match(hint, /create one/i, 'and gives the seller the next move');
  assert.doesNotMatch(hint, /wired|lane/i, 'and does not blame the build');
});

test('F22: with branches but no spine the hint names the missing deck, not the lane', async () => {
  const app = await studio();
  app.dispatch('branch.objectionDraft', undefined, { value: 'Our approvals process would never allow this' });
  app.dispatch('branch.create');
  const hint = jumpHint(app);
  assert.match(hint, /spine/i, 'the deck is what is missing');
  assert.match(hint, /scenes/i, 'and it names where to go');
  assert.doesNotMatch(hint, /wired/i);
});

test('F22: with a deck and a branch the hint describes a working index', async () => {
  const app = await studio();
  app.dispatch('scene.add', 'quoteCard');
  app.dispatch('branch.objectionDraft', undefined, { value: 'Our approvals process would never allow this' });
  app.dispatch('branch.create');
  const hint = jumpHint(app);
  assert.match(hint, /fuzzy/i);
  assert.match(hint, /1 branch in the index/i, 'and says how much is in it');
});

test('F22: the query box is disabled exactly while it cannot answer, with the reason beside it', async () => {
  const empty = await studio();
  empty.ui.section = 'branches';
  assert.equal(jumpInput(PANELS.branches(empty)).a.disabled, true, 'nothing to search, so nothing to type into');

  const open = await studio();
  open.dispatch('scene.add', 'quoteCard');
  open.dispatch('branch.objectionDraft', undefined, { value: 'Our approvals process would never allow this' });
  open.dispatch('branch.create');
  open.ui.section = 'branches';
  assert.ok(!jumpInput(PANELS.branches(open)).a.disabled, 'and enabled the moment there is an index to search');
});

// ------------------------------------------ empty is not the same as broken --

test('a brand nobody has extracted reads as unmeasured, not as a failed extraction', async () => {
  const app = await studio();
  const blockers = emitBlockers(app).blockers;
  const kinds = blockers.map((b) => b.kind);

  assert.ok(kinds.includes('BRAND_DEFAULTS'), 'the untouched groups are named as untouched');
  assert.ok(
    !kinds.includes('BRAND_UNREVIEWED'),
    'and not reported as a low-confidence measurement, because nothing was measured',
  );

  const defaults = blockers.filter((b) => b.kind === 'BRAND_DEFAULTS');
  for (const b of defaults) {
    assert.doesNotMatch(b.message, /came out/i, 'nothing "came out" of an extraction that never ran');
    assert.doesNotMatch(b.message, /against the source/i, 'there is no source to check it against');
    assert.match(b.message, /nothing has been extracted/i, 'it says what is actually true');
    assert.match(b.message, /extract their brand|set (them|it) yourself/i, 'and what to do next');
  }

  app.ui.section = 'brand';
  const strings = visibleStrings(PANELS.brand(app)).join('\n');
  assert.match(strings, /not measured/i, 'the confidence bars explain what 0% means here');
});

test('the emit blockers are grammatical sentences, not template debris', async () => {
  const app = await studio();
  const messages = emitBlockers(app).blockers.map((b) => b.message);
  const joined = messages.join('\n');
  assert.match(joined, /The shape language is empty/, 'singular groups take a singular verb');
  assert.match(joined, /The logo assets are empty/, 'plural groups take a plural verb');
  assert.doesNotMatch(joined, /language are|treatment are/, 'and never the wrong one');
  assert.doesNotMatch(joined, /\b1 (roles|faces|assets)\b/, 'and one of a thing is not plural');
});

test('an unread storage quota is not reported as a browser that refuses to report one', async () => {
  const app = await studio();
  const before = visibleStrings(renderStudio(app)).join('\n');
  assert.doesNotMatch(before, /would not report|will not report/i, 'the browser has not been asked yet');

  await app.refreshProjects();
  assert.equal(app.ui.pressure.measured, true, 'and once asked, the reading is marked as taken');
});

test('an empty state names the thing that is empty and the way out of it', async () => {
  const app = await studio();
  /** @param {string} id @returns {string} */
  const panelText = (id) => { app.ui.section = id; return visibleStrings(PANELS[id](app)).join('\n'); };

  assert.match(panelText('branches'), /No branches yet/i);
  assert.match(panelText('scenes'), /The spine is empty/i);
  assert.match(panelText('specimens'), /Nothing captured yet/i);
  assert.match(panelText('recipes'), /No renditions yet/i);
  assert.match(panelText('recipes'), /run a seed recipe/i, 'both routes to a rendition, since F14 wired the library');
  assert.match(panelText('rehearse'), /No sweep has been run/i);
  assert.match(panelText('emit'), /has not been computed yet/i);
});

// ----------------------------------------------------------------- F23 -----

/**
 * The same discipline applied to a comment rather than to a rendered string.
 *
 * `services.promotionRecord` documented L7's token as one that "cannot be
 * hand-forged". It can: `promotionSignature` is `shortHash({v, by, at, of,
 * from}, 16)` — unkeyed — and `formatPromotionRecord` is exported, so anyone
 * holding the repo can compute a valid digest. There is no better option
 * available (§1.1 forbids a backend and accounts, so any key would ship inside
 * the artifact the forger already has), which is exactly why the wording has to
 * be right: the guarantee is tamper-evidence, not authenticity.
 *
 * A doc comment does not reach the screen, so the phrase sweep above cannot see
 * it and is not stretched to try. This asserts the source directly, which is
 * the appropriate instrument for a claim that lives in the source.
 */
test('F23: the adapter does not claim a promotion record cannot be forged', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const src = readFileSync(fileURLToPath(new URL('../../src/ui/services.js', import.meta.url)), 'utf8');
  assert.doesNotMatch(src, /cannot be (hand-)?forged/i, 'the digest is unkeyed and the formatter is exported');
  assert.match(src, /tamper-evidence, not authenticity/i, 'and the adapter says what it actually is');
});

test('F23: the studio shows L7’s sentence about the limit rather than paraphrasing it', async () => {
  const { PROMOTION_RECORD_LIMIT } = await import('../../src/recipe/index.js');
  const app = await studio();
  assert.equal(
    app.services.promotionRecordLimit(),
    PROMOTION_RECORD_LIMIT,
    'one description of one guarantee, owned by the lane that provides it',
  );
  assert.match(PROMOTION_RECORD_LIMIT, /does not prove/i, 'and it is the honest half of the sentence');
});
