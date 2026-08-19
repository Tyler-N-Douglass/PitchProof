/**
 * CRITIQUE-3's two severity-1 findings, and the apply-all it asked for.
 *
 * Both severity-1s were in this lane and both were invisible to 2007 tests, for
 * one reason the critic named exactly: *"build a proof through `src/ui/` and
 * assert its ids are unique."* Nothing did. Every lane tested its own stage
 * with its own minter; the studio is where the stages meet, and a per-call
 * minter only collides where they meet.
 *
 *   - **P1** — `minterFor(seed)` counted from zero and was constructed fresh
 *     for every capture, so the first id every capture minted was the same
 *     string. Three pasted pages all came back `sp_004ebe5c150e`; the runtime's
 *     `specimenById` map held one entry for three specimens; six scenes staged
 *     across three of the prospect's pages all resolved to the third one.
 *     `validateProofShape` has no uniqueness check, so the artifact shipped.
 *   - **P2** — because the locus pointed at the wrong specimen, the
 *     `ASSET_MISSING` auto-fix was a no-op, and the panel went on offering the
 *     same button: 40 clicks, 232 seconds, the blocking count stuck at 3 from
 *     the seventeenth, `Save the file` never enabled.
 *   - **P11** — L11 published `applyAll` and nothing in the studio called it.
 *   - **P6's follow-on** — L6 now holds a pasted `media` block out of the
 *     stream instead of emitting a reference to bytes nobody captured, which
 *     closed a severity-1 emit blocker on §6's paste route and opened a quieter
 *     hole: the deck emits cleanly with the product photograph missing. Nothing
 *     in `src/ui/**` read `mediaOmitted` or called `unresolvedMediaRefs`, so
 *     nothing said so. It shares P2's shape and not its cause — there a repair
 *     did less than the seller thought, here a capture did — and the answer is
 *     the same both times: the studio says what actually happened.
 *
 * So the assertions here are of two kinds. The id ones are read off a proof
 * built by driving the real adapter through the real capture actions, across
 * every lifetime a minter could have had — captures, undo, redo, reload,
 * import. The loop ones are about termination: a repair loop that cannot make
 * progress has to say so, whatever the cause, because the next cause will not
 * be P1.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toHtml } from '../../src/core/vdom.js';
import { StudioApp } from '../../src/ui/app.js';
import { makeServices, minterFor, captureSalt } from '../../src/ui/services.js';
import { PANELS } from '../../src/ui/panels/index.js';
import { fixAttempt, fixCoverage } from '../../src/ui/gate.js';
import { newDoc, usedIds } from '../../src/ui/model.js';
import { ProjectStore, exportProjectJson, importProjectJson, makeRecord } from '../../src/core/storage.js';
import { fakeImageInput, imageMime } from '../../src/ui/actions.js';
import { fixtureDoc, fakeServices, makeClock, finding } from '../fixtures/ui/studio-fixture.mjs';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Three genuinely different pages off one site, each with an image whose bytes
 * a paste cannot carry — which is what makes them raise `ASSET_MISSING`, the
 * code P2 was measured on.
 * @param {string} title
 * @param {string} body
 * @param {string} image
 * @returns {string}
 */
function page(title, body, image) {
  return [
    `<!doctype html><html lang="en"><head><title>${title} — Northwind Industrial</title>`,
    '<style>body{color:#16181D;background:#FFFFFF;font-family:Inter,Arial,sans-serif}h1{color:#123A8C}</style>',
    '</head><body>',
    '<header><nav><a href="/products">Products</a><a href="/about">About</a></nav></header>',
    `<main><h1>${title}</h1><p>${body}</p>`,
    `<figure><img src="${image}" alt="${title}"><figcaption>${title}</figcaption></figure>`,
    '<ul><li>Offshore platforms</li><li>Rail infrastructure</li><li>Bridge spans</li></ul>',
    `<p>${body} ${body}</p>`,
    '</main>',
    '<footer><p>Northwind Industrial. All rights reserved.</p></footer>',
    '</body></html>',
  ].join('');
}

const PAGES = [
  page('Process equipment that keeps running', 'Forty years of protecting steel in places nobody wants to go twice.', '/assets/hero-plant.png'),
  page('HX-400 shell-and-tube heat exchanger', 'Rated for 40 bar and cleanable in place without a crane.', '/assets/product-hx400.png'),
  page('Designing fouling margin you will actually use', 'Margin you cannot measure is margin you cannot defend.', '/assets/uptime-figure.png'),
];

/**
 * A studio on the real adapter, with no network — §6's degraded path, and the
 * one the studio's own copy calls "Works when nothing else does."
 * @returns {Promise<any>}
 */
async function realApp() {
  const clock = makeClock();
  const store = await ProjectStore.open({ clock, indexedDB: null });
  const services = makeServices({ clock, http: null });
  services.ensureLayouts();
  const app = new StudioApp({ document: null, window: null, store, clock, services });
  app.ui.settings.operator = 'Alex Mercer';
  return app;
}

/**
 * A studio on the fake adapter, for the loop assertions — a fake is what lets a
 * fix be made to fail on purpose.
 * @param {object} [options]
 * @returns {Promise<any>}
 */
async function fakeApp(options = {}) {
  const clock = makeClock();
  const store = await ProjectStore.open({ clock, indexedDB: null });
  const app = new StudioApp({
    document: null, window: null, store, clock,
    services: fakeServices({ clock, ...options }), doc: fixtureDoc(),
  });
  app.ui.settings.operator = 'Alex Mercer';
  return app;
}

/** @param {any} app @param {string} html */
function paste(app, html) {
  app.setDraft('specimen.html', html);
  app.dispatch('specimen.importPaste');
}

/**
 * Every id in a proof, with the path it was found at, so a duplicate names both
 * of the things that share it rather than only a count.
 * @param {any} proof
 * @returns {[string, string][]}
 */
function everyId(proof) {
  /** @type {[string, string][]} */
  const out = [['proof', proof.id]];
  const scene = (s, where) => {
    out.push([`${where}`, s.id]);
    (s.beats || []).forEach((b, i) => out.push([`${where}/beat[${i}]`, b.id]));
  };
  (proof.spine || []).forEach((s, i) => scene(s, `spine[${i}]`));
  (proof.branches || []).forEach((b, i) => {
    out.push([`branch[${i}]`, b.id]);
    (b.scenes || []).forEach((s, j) => scene(s, `branch[${i}]/scene[${j}]`));
  });
  (proof.specimens || []).forEach((s, i) => {
    out.push([`specimen[${i}] "${String(s.title).slice(0, 32)}"`, s.id]);
    (s.media || []).forEach((m, j) => out.push([`specimen[${i}]/media[${j}]`, m.id]));
  });
  (proof.renditions || []).forEach((r, i) => {
    out.push([`rendition[${i}] "${r.label}"`, r.id]);
    (r.media || []).forEach((m, j) => out.push([`rendition[${i}]/media[${j}]`, m.id]));
  });
  (proof.recipes || []).forEach((r, i) => out.push([`recipe[${i}] "${r.name}"`, r.id]));
  if (proof.brand) {
    out.push(['brand', proof.brand.id]);
    (proof.brand.logos || []).forEach((l, i) => out.push([`brand/logo[${i}]`, l.id]));
  }
  return out;
}

/**
 * Assert every id in a proof is its own. The message names the collision the
 * way a person would have to read it to believe it.
 * @param {any} proof
 * @param {string} what
 */
function assertIdsUnique(proof, what) {
  /** @type {Map<string, string[]>} */
  const byId = new Map();
  for (const [where, id] of everyId(proof)) {
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(where);
  }
  const collisions = [...byId.entries()].filter(([, wheres]) => wheres.length > 1);
  assert.deepEqual(collisions, [],
    `${what}: ${collisions.length} id(s) name more than one object — ${collisions.map(([id, wheres]) => `${id} is ${wheres.join(' and ')}`).join('; ')}`);
}

/**
 * Build something worth checking: three pages captured, the brand extracted,
 * the seed library run against every specimen, two scenes per specimen, three
 * branches. This is §1.2's flow, and it is the flow P1 corrupted.
 * @param {any} app
 */
function assembleAcrossPages(app) {
  app.dispatch('project.setProspect', null, { value: 'Northwind Industrial' });
  for (const html of PAGES) paste(app, html);

  const capture = app.services.importHtmlText(PAGES[0], 'https://www.northwind.example');
  if (capture.ok) {
    const brand = app.services.buildBrand([capture.value], { seed: app.doc.seed, proof: app.proof });
    if (brand.ok) app.mutate('Extract brand', (doc) => ({ ...doc, proof: { ...doc.proof, brand: brand.value } }));
  }

  app.dispatch('recipe.loadSeed');
  for (const specimen of app.proof.specimens) {
    app.select({ specimenId: specimen.id, recipeId: app.proof.recipes[0].id });
    app.dispatch('recipe.runAll');
  }

  const layouts = ['splitBeforeAfter', 'quoteCard', 'fanOut', 'sideNote', 'systemMap', 'stack'];
  layouts.forEach((layout, i) => {
    app.select({ specimenId: app.proof.specimens[i % app.proof.specimens.length].id });
    app.dispatch('scene.add', layout);
  });

  for (const objection of [
    'We already have a supplier for heat exchangers',
    'That works for one page, not four hundred',
    'Even approved, this lands in next year’s capital budget',
  ]) {
    app.setDraft('branch.objection', objection);
    app.dispatch('branch.create');
  }
  return app;
}

// --------------------------------------------------------------------- P1 ---

test('P1: a proof built through the studio\'s own services layer has no duplicate ids', async () => {
  const app = await realApp();
  assembleAcrossPages(app);

  assert.equal(app.proof.specimens.length, 3, 'three pages went in');
  assert.ok(app.proof.spine.length >= 6, 'six scenes were staged');
  assert.ok(app.proof.branches.length >= 3, '§1.2 wants at least three branches');
  assertIdsUnique(app.proof, 'a proof assembled across three pages');
});

test('P1: three different pages captured in one session get three different specimen ids', async () => {
  const app = await realApp();
  for (const html of PAGES) paste(app, html);

  const ids = app.proof.specimens.map((s) => s.id);
  assert.equal(new Set(ids).size, 3,
    `three pastes produced ${new Set(ids).size} distinct id(s): ${ids.join(', ')}`);
  const titles = app.proof.specimens.map((s) => s.title);
  assert.equal(new Set(titles).size, 3, 'and they really are three different pages');
});

test('P1: every scene resolves to the specimen it was built from, the way the runtime resolves it', async () => {
  const app = await realApp();
  assembleAcrossPages(app);

  // `src/runtime/runtime.js` builds exactly this map. P1's consequence was that
  // it held one entry for three specimens and every lookup landed on the last.
  const specimenById = new Map(app.proof.specimens.map((s) => [s.id, s]));
  assert.equal(specimenById.size, app.proof.specimens.length,
    `specimenById holds ${specimenById.size} entries for ${app.proof.specimens.length} specimens`);

  const staged = app.proof.spine
    .map((scene) => ({ scene, id: scene.specimenId }))
    .filter((entry) => entry.id);
  assert.ok(staged.length > 0, 'the scenes reference specimens at all');
  const resolvedTitles = new Set(staged.map((entry) => {
    const specimen = specimenById.get(entry.id);
    assert.ok(specimen, `scene ${entry.scene.id} names ${entry.id}, which resolves to nothing`);
    return specimen.title;
  }));
  assert.ok(resolvedTitles.size > 1,
    `every scene resolved to the same page (${[...resolvedTitles][0]}) — this is P1's symptom exactly`);
});

test('P1: capturing after an undo, and after a redo, still collides with nothing', async () => {
  const app = await realApp();
  paste(app, PAGES[0]);
  paste(app, PAGES[1]);
  assertIdsUnique(app.proof, 'two captures');

  app.stack.undo();
  assert.equal(app.proof.specimens.length, 1, 'the second capture came off');
  paste(app, PAGES[2]);
  assertIdsUnique(app.proof, 'a capture made after an undo');

  // The redo of the undone capture is gone — a new mutation drops the redo
  // stack — so undo the third capture and redo it, which is the lifetime a
  // counter-based minter gets wrong in the other direction.
  app.stack.undo();
  app.stack.redo();
  assert.equal(app.proof.specimens.length, 2, 'the redo put it back');
  assertIdsUnique(app.proof, 'a capture undone and redone');
});

test('P1: a project reloaded from storage goes on minting ids that are free in it', async () => {
  const app = await realApp();
  for (const html of PAGES) paste(app, html);
  const before = app.proof.specimens.map((s) => s.id);

  const saved = await app.saveNow();
  assert.ok(saved.ok, saved.ok ? '' : saved.error);
  const loaded = await app.store.load(app.doc.id);
  assert.ok(loaded.ok, loaded.ok ? '' : loaded.error);
  app.loadRecord(loaded.value);

  assert.deepEqual(app.proof.specimens.map((s) => s.id), before, 'a reload does not renumber anything');
  paste(app, PAGES[0]);
  assert.equal(app.proof.specimens.length, 4);
  assertIdsUnique(app.proof, 'a capture made after a reload');
});

test('P1: a project imported from a .pitchproof.json goes on minting ids that are free in it', async () => {
  const app = await realApp();
  for (const html of PAGES) paste(app, html);
  const json = exportProjectJson(makeRecord({
    id: app.doc.id, name: app.doc.name, proof: app.proof, seed: app.doc.seed, clock: app.clock,
  }));

  const other = await realApp();
  const parsed = importProjectJson(json);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
  other.loadRecord(parsed.value);
  assert.equal(other.proof.specimens.length, 3, 'the import brought the specimens with it');

  paste(other, PAGES[1]);
  paste(other, PAGES[2]);
  assert.equal(other.proof.specimens.length, 5);
  assertIdsUnique(other.proof, 'captures made into an imported project');
});

test('P1: capturing the same page twice gives the second capture its own id', async () => {
  const app = await realApp();
  paste(app, PAGES[0]);
  paste(app, PAGES[0]);
  assert.equal(app.proof.specimens.length, 2);
  assert.notEqual(app.proof.specimens[0].id, app.proof.specimens[1].id,
    'two captures of one page are two specimens and must be addressable separately');
  assertIdsUnique(app.proof, 'the same page captured twice');
});

test('P1: the minter cannot be constructed without the ids already in use', () => {
  assert.throws(() => minterFor('seed'), /already used|CRITIQUE-3 P1/i,
    'the shape of the defect was a minter that could not see the project; that shape is now unconstructible');
  assert.throws(() => minterFor('seed', {}), /already used|CRITIQUE-3 P1/i);
  assert.doesNotThrow(() => minterFor('seed', { taken: [] }));
});

test('P1: the minter never hands out an id that is already spoken for', () => {
  const first = minterFor('seed-1', { taken: [], salt: { page: 'a' } });
  const a = first.next('specimen');
  const b = first.next('specimen');
  assert.notEqual(a, b, 'two draws from one minter differ');

  // The same seed and the same salt: without the `taken` set this is precisely
  // the collision P1 shipped.
  const second = minterFor('seed-1', { taken: [a, b], salt: { page: 'a' } });
  const c = second.next('specimen');
  assert.ok(![a, b].includes(c), `${c} was already taken`);

  const third = minterFor('seed-1', { taken: [a, b, c], salt: { page: 'a' } });
  assert.ok(![a, b, c].includes(third.next('specimen')));
});

test('P1: a reset rewinds the sequence but never reissues an id it already gave out', () => {
  const minter = minterFor('seed-1', { taken: [] });
  const first = minter.next('specimen');
  const second = minter.next('specimen');
  minter.reset();
  const third = minter.next('specimen');
  assert.ok(![first, second].includes(third), 'a reset must not be a route back to a used id');
  assert.deepEqual(minter.minted(), [first, second, third]);
});

test('P1: the same capture, minted against the same project, is reproducible', () => {
  const capture = { sourceUrl: 'https://a.example/x', capturedAt: '2026-02-01T09:00:00.000Z', html: '<p>a</p>', meta: { title: 'X' } };
  const one = minterFor('seed', { taken: ['sp_zzz'], salt: captureSalt(capture) });
  const two = minterFor('seed', { taken: ['sp_zzz'], salt: captureSalt(capture) });
  assert.equal(one.next('specimen'), two.next('specimen'), '§5: ids are a function of the seed and the content, not of a clock');
});

test('P1: two different captures salt differently, so they do not have to walk to differ', () => {
  const a = captureSalt({ sourceUrl: 'https://a.example/1', capturedAt: 'T', html: '<p>one</p>', meta: { title: 'One' } });
  const b = captureSalt({ sourceUrl: 'https://a.example/2', capturedAt: 'T', html: '<p>two</p>', meta: { title: 'Two' } });
  assert.notDeepEqual(a, b);
  assert.notEqual(
    minterFor('seed', { taken: [], salt: a }).next('specimen'),
    minterFor('seed', { taken: [], salt: b }).next('specimen'),
  );
});

test('P1: a lane call made without the proof is refused rather than served a colliding id', async () => {
  const app = await realApp();
  const capture = app.services.importHtmlText(PAGES[0], null);
  assert.ok(capture.ok);
  const built = app.services.buildSpecimen(capture.value, { imageQuality: 0.85, seed: app.doc.seed });
  assert.equal(built.ok, false, 'a call that cannot see the project must not mint into it');
  assert.match(built.error, /P1/);
  const brand = app.services.buildBrand([capture.value], { seed: app.doc.seed });
  assert.equal(brand.ok, false);
});

test('P1: a new project never takes an id another project is already using', () => {
  const at = '2026-02-01T09:00:00.000Z';
  const first = newDoc({ seed: 'pitchproof-2026-02-01', at });
  const second = newDoc({ seed: 'pitchproof-2026-02-01', at, taken: [first.id] });
  assert.notEqual(second.id, first.id,
    'the project id is the storage key: two projects sharing one means the second overwrites the first');
  assert.notEqual(second.proof.id, first.proof.id);
  const third = newDoc({ seed: 'pitchproof-2026-02-01', at, taken: [first.id, second.id, first.proof.id, second.proof.id] });
  assert.equal(new Set([first.id, second.id, third.id]).size, 3);
});

test('P1: a fresh project is internally unique, and every capture keeps it that way', async () => {
  const app = await realApp();
  assertIdsUnique(app.proof, 'a brand-new project');
  const seen = new Set(usedIds(app.proof));
  paste(app, PAGES[0]);
  for (const [, id] of everyId(app.proof)) {
    if (seen.has(id)) continue;
    seen.add(id);
  }
  assertIdsUnique(app.proof, 'a project with one capture in it');
});

// --------------------------------------------------------------------- P2 ---

/**
 * A fake fix that runs and leaves the proof exactly as it was — which is what
 * `ASSET_MISSING`'s fix did on every one of P2's twenty-four dead clicks,
 * because the locus named a specimen that did not hold the block.
 * @param {object} [options]
 * @returns {(proof: any, findings: any[]) => any[]}
 */
function inertFixes(options = {}) {
  return (proof, findings) => (findings || [])
    .filter((f) => f.autoFixAvailable)
    .map((f) => ({
      finding: f,
      label: `Remove the block referencing missing media "${f.code}"`,
      effect: options.effect || 'resolves',
      apply: (p) => p,
    }));
}

test('P2: an auto-fix that changes nothing is not committed, and is not offered a second time', async () => {
  const app = await fakeApp({
    findings: [finding({ id: 'fd_inert', code: 'ASSET_MISSING', severity: 1, message: 'Block 2 shows media "/assets/product-hx400.png", and no media reference with that id exists.', locus: { specimenId: 'sp_x' }, autoFixAvailable: true })],
  });
  app.services.autoFixes = inertFixes();
  await app.dispatch('rehearse.sweep');
  const depth = app.stack.history().length;

  await app.dispatch('rehearse.autoFix', '0');

  assert.equal(app.stack.history().length, depth,
    'a fix that changed nothing must not put an entry on the undo stack whose undo does nothing');
  const attempt = fixAttempt(app, 'fd_inert');
  assert.ok(attempt, 'the attempt is on the record');
  assert.equal(attempt.outcome, 'no-change');
  assert.ok(app.ui.notices.some((n) => n.tone === 'warn' && /changed nothing/i.test(n.text)),
    `the seller is told, in the moment: ${app.ui.notices.map((n) => n.text).join(' | ')}`);

  app.ui.section = 'rehearse';
  const html = toHtml(PANELS.rehearse(app));
  assert.doesNotMatch(html, /data-st-act="rehearse\.autoFix"[^>]*data-st-arg="0"/,
    'the button that cannot help must not be offered again');
  assert.match(html, /came back unchanged/i, 'and what happened is on the panel, not only in a notice');
  assert.match(html, /hand edit/i, 'with what to do instead');
});

test('P2: a fix that ran and left its finding standing is withdrawn at the next sweep', async () => {
  const app = await fakeApp({
    findings: [finding({ id: 'fd_returns', code: 'ASSET_MISSING', severity: 1, locus: { specimenId: 'sp_x' }, autoFixAvailable: true })],
  });
  // Changes the proof, so it commits — and the finding comes back anyway,
  // because the fake sweep raises the same list every time.
  app.services.autoFixes = (proof, findings) => (findings || [])
    .filter((f) => f.autoFixAvailable)
    .map((f) => ({ finding: f, label: 'Remove the block', effect: 'resolves', apply: (p) => ({ ...p, prospectName: `${p.prospectName}.` }) }));

  await app.dispatch('rehearse.sweep');
  await app.dispatch('rehearse.autoFix', '0');
  assert.equal(fixAttempt(app, 'fd_returns').outcome, 'applied', 'provisional until a sweep says otherwise');

  await app.dispatch('rehearse.sweep');
  assert.equal(fixAttempt(app, 'fd_returns').outcome, 'returned');

  app.ui.section = 'rehearse';
  const html = toHtml(PANELS.rehearse(app));
  assert.doesNotMatch(html, /data-st-act="rehearse\.autoFix"/, 'the button is withdrawn');
  assert.match(html, /raised again by the next sweep/i);
});

test('P2: a fix that never claimed to clear its finding is not reported as one that failed', async () => {
  const app = await fakeApp({
    findings: [finding({ id: 'fd_plan', code: 'ASSET_OVERSIZE', severity: 2, locus: {}, autoFixAvailable: true })],
  });
  app.services.autoFixes = (proof, findings) => (findings || [])
    .filter((f) => f.autoFixAvailable)
    .map((f) => ({ finding: f, label: 'Ask the emitter to downscale it', effect: 'plan', apply: (p) => ({ ...p, prospectName: `${p.prospectName}.` }) }));

  app.ui.section = 'rehearse';
  await app.dispatch('rehearse.sweep');
  assert.match(toHtml(PANELS.rehearse(app)), /clears when the emitter acts on it/i,
    '§14: a plan fix instructs the emitter, and a seller who is not told reads the survivor as a failure');

  await app.dispatch('rehearse.autoFix', '0');
  await app.dispatch('rehearse.sweep');
  assert.equal(fixAttempt(app, 'fd_plan').outcome, 'applied',
    'a plan fix whose finding stands is the contract, not a failed repair');
  assert.match(toHtml(PANELS.rehearse(app)), /data-st-act="rehearse\.autoFix"/, 'so it stays on offer');
});

test('P2: the panel says how much of the list a button could ever clear, before the first click', async () => {
  const app = await fakeApp({
    findings: [
      finding({ id: 'fd_fixable', code: 'BEAT_EMPTY', severity: 2, autoFixAvailable: true }),
      finding({ id: 'fd_manual', code: 'TEXT_OVERFLOW', severity: 1, message: 'The headline overflows at sm.', locus: { sceneId: 'sc_x' } }),
    ],
  });
  app.ui.section = 'rehearse';
  await app.dispatch('rehearse.sweep');
  const html = toHtml(PANELS.rehearse(app));
  assert.match(html, /(has|have) an auto-fix on offer/i);
  assert.match(html, /need a hand edit|needs a hand edit/i);
  assert.match(html, /Of 2 findings/i, 'the sentence is about the list in front of you, not a general claim');
});

test('P2: when nothing is left that a button can fix, the panel says so instead of offering one', async () => {
  const app = await fakeApp({
    findings: [finding({ id: 'fd_manual', code: 'TEXT_OVERFLOW', severity: 1, message: 'The headline overflows at sm.', locus: { sceneId: 'sc_x' } })],
  });
  app.ui.section = 'rehearse';
  await app.dispatch('rehearse.sweep');
  const html = toHtml(PANELS.rehearse(app));
  assert.doesNotMatch(html, /data-st-act="rehearse\.autoFix/, 'no button at all');
  assert.match(html, /Nothing here has an auto-fix/i);
  assert.match(html, /only you can make/i);
});

test('P2: apply-all that moves nothing says the loop is over and withdraws every button', async () => {
  const app = await fakeApp({
    findings: [
      finding({ id: 'fd_a', code: 'ASSET_MISSING', severity: 1, locus: { specimenId: 'sp_x' }, autoFixAvailable: true }),
      finding({ id: 'fd_b', code: 'ASSET_MISSING', severity: 1, locus: { specimenId: 'sp_y' }, autoFixAvailable: true }),
      finding({ id: 'fd_c', code: 'ASSET_MISSING', severity: 1, locus: { specimenId: 'sp_z' }, autoFixAvailable: true }),
    ],
  });
  app.services.autoFixes = inertFixes();
  app.ui.section = 'rehearse';
  await app.dispatch('rehearse.sweep');
  const depth = app.stack.history().length;

  await app.dispatch('rehearse.autoFixAll');

  assert.equal(app.stack.history().length, depth, 'nothing changed, so nothing was committed');
  for (const id of ['fd_a', 'fd_b', 'fd_c']) {
    assert.equal(fixAttempt(app, id).outcome, 'no-change', `${id} is on the record as inert`);
  }
  assert.ok(app.ui.notices.some((n) => /as far as auto-fix goes/i.test(n.text)),
    `the terminating condition is stated: ${app.ui.notices.map((n) => n.text).join(' | ')}`);

  const html = toHtml(PANELS.rehearse(app));
  assert.doesNotMatch(html, /data-st-act="rehearse\.autoFix"/, 'no per-finding button survives');
  assert.doesNotMatch(html, /data-st-act="rehearse\.autoFixAll"/, 'and neither does apply-all');
  assert.match(html, /as far as auto-fix goes/i);

  // The forty-first click has nowhere to land even if something dispatches it.
  await app.dispatch('rehearse.autoFixAll');
  assert.equal(app.stack.history().length, depth);
});

test('P2: the loop terminates on the real lanes, on the paste route P2 was measured on', async () => {
  const app = await realApp();
  for (const html of PAGES) paste(app, html);
  app.dispatch('recipe.loadSeed');
  for (const specimen of app.proof.specimens) {
    app.select({ specimenId: specimen.id, recipeId: app.proof.recipes[0].id });
    app.dispatch('recipe.runAll');
  }
  ['splitBeforeAfter', 'quoteCard', 'fanOut', 'sideNote', 'systemMap', 'stack'].forEach((layout, i) => {
    app.select({ specimenId: app.proof.specimens[i % app.proof.specimens.length].id });
    app.dispatch('scene.add', layout);
  });

  await app.dispatch('rehearse.sweep');
  const first = app.ui.sweep.findings.filter((f) => f.severity === 1).length;

  // P2's measurement was 40 clicks and 232 seconds with the count stalled from
  // the seventeenth. The assertion is not that auto-fix clears everything —
  // some findings are editorial and never will be — but that the loop reaches a
  // point where it stops offering, and reaches it in a bounded number of passes.
  const counts = [first];
  let rounds = 0;
  for (; rounds < 12; rounds += 1) {
    const fixes = app.services.autoFixes(app.proof, app.ui.sweep.findings);
    const coverage = fixCoverage(app, app.ui.sweep.findings, fixes);
    if (!coverage.offered) break;
    await app.dispatch('rehearse.autoFixAll');
    await app.dispatch('rehearse.sweep');
    counts.push(app.ui.sweep.findings.filter((f) => f.severity === 1).length);
  }
  assert.ok(rounds < 12, `auto-fix went on offering a button for ${rounds} rounds: ${counts.join(' → ')}`);

  app.ui.section = 'rehearse';
  const html = toHtml(PANELS.rehearse(app));
  assert.doesNotMatch(html, /data-st-act="rehearse\.autoFixAll"/,
    'when there is nothing left to apply, the control is gone rather than dead');
  const blocking = app.ui.sweep.findings.filter((f) => f.severity === 1);
  if (blocking.length) {
    assert.match(html, /hand edit|only you can make/i,
      `${blocking.length} blocking findings are left and the panel must say they are yours: ${blocking.map((f) => f.code).join(', ')}`);
  }
  assertIdsUnique(app.proof, 'the proof the loop ran against');
});

test('P2: ASSET_MISSING\'s auto-fix acts on the specimen its locus names, not on the first one', async () => {
  const app = await realApp();
  for (const html of PAGES) paste(app, html);
  assert.equal(app.proof.specimens.length, 3);

  // L6 now holds a pasted `media` block back rather than emitting a reference
  // to bytes that were never captured (its D-L6-21), so the paste route no
  // longer reaches ASSET_MISSING on its own. The defect P2 measured was never
  // about how the block got there: it was that the fix resolved `locus` to the
  // wrong specimen and quietly did nothing. So put one dangling reference into
  // each of the three specimens, at a different index in each, and require the
  // fix to act on the one it names.
  app.mutate('Add a media block to each specimen', (doc) => ({
    ...doc,
    proof: {
      ...doc.proof,
      specimens: doc.proof.specimens.map((specimen, i) => {
        const blocks = specimen.blocks.slice();
        blocks.splice(Math.min(i, blocks.length), 0, {
          type: 'media', ref: `/assets/missing-${i}.png`, caption: `figure ${i}`, alt: null,
        });
        return { ...specimen, blocks };
      }),
    },
  }));

  await app.dispatch('rehearse.sweep');
  const missing = app.ui.sweep.findings.filter((f) => f.code === 'ASSET_MISSING' && f.autoFixAvailable);
  assert.equal(missing.length, 3, `one per dangling reference; got ${missing.length}`);
  assert.equal(new Set(missing.map((f) => f.locus.specimenId)).size, 3,
    'three specimens, three loci — under P1 all three named the same id');

  for (let round = 0; round < 3; round += 1) {
    const fixes = app.services.autoFixes(app.proof, app.ui.sweep.findings);
    const index = fixes.findIndex((fx) => fx.finding.code === 'ASSET_MISSING');
    assert.ok(index >= 0, 'a fix is still on offer');
    const detail = fixes[index].finding.detail;
    const owner = app.proof.specimens.find((sp) => sp.id === detail.ownerId);
    assert.ok(owner, `the locus names ${detail.ownerId}, which resolves to nothing`);
    const block = owner.blocks[detail.blockIndex];
    assert.ok(block && block.type === 'media' && block.ref === detail.ref,
      `the block the fix names is not where it says it is — this is exactly what P1 made true for every specimen but the first (${owner.id}, index ${detail.blockIndex})`);

    const before = owner.blocks.length;
    await app.dispatch('rehearse.autoFix', String(index));
    const after = app.proof.specimens.find((sp) => sp.id === detail.ownerId);
    assert.equal(after.blocks.length, before - 1, 'the fix removed the block it named');
    assert.equal(fixAttempt(app, fixes[index].finding.id).outcome, 'applied');
    await app.dispatch('rehearse.sweep');
  }

  assert.equal(app.ui.sweep.findings.filter((f) => f.code === 'ASSET_MISSING').length, 0,
    'three findings, three clicks, none of them dead');
});

// -------------------------------------------------------------------- P11 ---

test('P11: the studio offers apply-all, and it goes through L11\'s applyAll', async () => {
  const app = await fakeApp({
    findings: [
      finding({ id: 'fd_1', code: 'BEAT_EMPTY', severity: 2, autoFixAvailable: true }),
      finding({ id: 'fd_2', code: 'BRANCH_NO_RETURN', severity: 1, autoFixAvailable: true }),
      finding({ id: 'fd_3', code: 'PROVENANCE_UNLABELED', severity: 1, autoFixAvailable: true }),
    ],
  });
  app.ui.section = 'rehearse';
  await app.dispatch('rehearse.sweep');
  assert.match(toHtml(PANELS.rehearse(app)), /data-st-act="rehearse\.autoFixAll"/,
    '§14 makes rehearsal the last pass; three findings must not cost three sweeps');

  let threaded = null;
  const real = app.services.applyAllFixes;
  app.services.applyAllFixes = (proof, fixes) => { threaded = fixes.length; return real(proof, fixes); };

  const depth = app.stack.history().length;
  await app.dispatch('rehearse.autoFixAll');

  assert.equal(threaded, 3, 'every offered fix went through the lane\'s own threading, in one call');
  assert.equal(app.stack.history().length, depth + 1, 'one click, one undo entry');
  const top = app.stack.history()[0];
  assert.equal(top.meta.autoFix, true, '§14: every auto-fix is logged');
  assert.deepEqual(top.meta.labels.length, 3, 'and the entry names each fix it rolled up');
});

test('P11: one apply-all is one undo, and it takes every fix back together', async () => {
  const app = await fakeApp({
    findings: [
      finding({ id: 'fd_1', code: 'BEAT_EMPTY', severity: 2, autoFixAvailable: true }),
      finding({ id: 'fd_2', code: 'BRANCH_NO_RETURN', severity: 1, autoFixAvailable: true }),
    ],
  });
  await app.dispatch('rehearse.sweep');
  const before = app.proof.prospectName;
  await app.dispatch('rehearse.autoFixAll');
  assert.notEqual(app.proof.prospectName, before, 'the fixes landed');
  app.stack.undo();
  assert.equal(app.proof.prospectName, before, 'and one undo takes all of them back');
});

test('P11: the fix log names every fix an apply-all rolled up', async () => {
  const app = await fakeApp({
    findings: [
      finding({ id: 'fd_1', code: 'BEAT_EMPTY', severity: 2, autoFixAvailable: true }),
      finding({ id: 'fd_2', code: 'BRANCH_NO_RETURN', severity: 1, autoFixAvailable: true }),
    ],
  });
  app.ui.section = 'rehearse';
  await app.dispatch('rehearse.sweep');
  await app.dispatch('rehearse.autoFixAll');
  const html = toHtml(PANELS.rehearse(app));
  assert.match(html, /fix BEAT_EMPTY/);
  assert.match(html, /fix BRANCH_NO_RETURN/);
  assert.match(html, /st-fixlog/);
});

test('P11: apply-all refuses before a sweep rather than pretending to have findings', async () => {
  const app = await fakeApp();
  const depth = app.stack.history().length;
  await app.dispatch('rehearse.autoFixAll');
  assert.equal(app.stack.history().length, depth);
  assert.ok(app.ui.notices.some((n) => /Run the sweep first/i.test(n.text)));
});

test('P11: undoing every auto-fix clears the ledger, so the buttons come back with the proof', async () => {
  const app = await fakeApp({
    findings: [finding({ id: 'fd_returns', code: 'ASSET_MISSING', severity: 1, locus: { specimenId: 'sp_x' }, autoFixAvailable: true })],
  });
  app.services.autoFixes = (proof, findings) => (findings || [])
    .filter((f) => f.autoFixAvailable)
    .map((f) => ({ finding: f, label: 'Remove the block', effect: 'resolves', apply: (p) => ({ ...p, prospectName: `${p.prospectName}.` }) }));

  await app.dispatch('rehearse.sweep');
  await app.dispatch('rehearse.autoFix', '0');
  await app.dispatch('rehearse.sweep');
  assert.equal(fixAttempt(app, 'fd_returns').outcome, 'returned', 'it ran and the finding came back');

  await app.dispatch('rehearse.revertFixes');
  assert.equal(fixAttempt(app, 'fd_returns'), null,
    'the ledger describes attempts against a proof that no longer exists');
  app.ui.section = 'rehearse';
  assert.match(toHtml(PANELS.rehearse(app)), /data-st-act="rehearse\.autoFix"/,
    'and the button comes back with the proof it was withdrawn against');
});


// ---------------------------------------------------- P6's follow-on (L6) ---

test('the studio says, at capture time, that a pasted page brought no images', async () => {
  const app = await realApp();
  paste(app, PAGES[0]);

  const specimen = app.proof.specimens[0];
  const omitted = app.services.omittedMedia(specimen);
  assert.equal(omitted.length, 1, 'the page had one image and the paste carried no bytes for it');
  assert.equal(omitted[0].ref, '/assets/hero-plant.png');
  assert.equal(omitted[0].restorable, true, 'L6 recorded the position it came from');

  assert.ok(app.ui.notices.some((n) => n.tone === 'warn' && /did not come with it/i.test(n.text)),
    `a capture that quietly dropped the pictures must say so: ${app.ui.notices.map((n) => n.text).join(' | ')}`);
  assert.ok(app.ui.notices.some((n) => /hero-plant\.png/.test(n.text)), 'and name which');
});

test('the specimens panel names every image the capture could not bring, and offers a file for each', async () => {
  const app = await realApp();
  paste(app, PAGES[1]);
  app.select({ specimenId: app.proof.specimens[0].id });
  app.ui.section = 'specimens';

  const html = toHtml(PANELS.specimens(app));
  assert.match(html, /Images this capture could not bring/i);
  assert.match(html, /product-hx400\.png/, 'the reference is named');
  assert.match(html, /data-st-act="specimen\.supplyMedia"/, 'and there is a way to put it back');
  assert.match(html, /type="file"/);
  assert.match(html, /HX-400 shell-and-tube heat exchanger/, 'the caption it will come back with');
});

test('a specimen that brought all its images says nothing about missing ones', async () => {
  const app = await fakeApp();
  const clean = { ...app.proof.specimens[0], mediaOmitted: [], mediaUnresolved: [] };
  app.mutate('clean', (doc) => ({ ...doc, proof: { ...doc.proof, specimens: [clean, ...doc.proof.specimens.slice(1)] } }));
  app.select({ specimenId: clean.id });
  app.ui.section = 'specimens';
  assert.doesNotMatch(toHtml(PANELS.specimens(app)), /Images this capture could not bring/i,
    'an empty warning on a clean capture is how a warning stops being read');
});

test('supplying the file puts the image back where it stood, with its caption, undoably', async () => {
  const app = await fakeApp();
  const specimen = app.proof.specimens[0];
  const entry = app.services.omittedMedia(specimen)[0];
  assert.ok(entry && entry.restorable);
  const before = specimen.blocks.length;
  const depth = app.stack.history().length;

  await app.dispatch('specimen.supplyMedia', `${specimen.id}|${entry.id}`, { element: fakeImageInput('hero-plant.png') });

  const after = app.proof.specimens[0];
  assert.equal(after.blocks.length, before + 1, 'the block came back');
  const block = after.blocks[entry.position];
  assert.equal(block.type, 'media', `it came back at position ${entry.position}`);
  assert.equal(block.caption, entry.caption, 'with the caption it was taken with');
  assert.ok((after.media || []).some((m) => m.id === block.ref), 'and the block resolves to a MediaRef');
  assert.equal(app.services.omittedMedia(after).length, 0, 'and it is off the omitted list');
  assert.equal(after.edited, false,
    '§18.3: their picture arriving is not an edit to their page, and the artifact must not claim it was');

  assert.equal(app.stack.history().length, depth + 1);
  app.stack.undo();
  assert.equal(app.proof.specimens[0].blocks.length, before, 'and it is undoable like anything else');
});

test('P1 discipline holds on the restore route: the media id it mints is free in the project', async () => {
  const app = await fakeApp();
  const specimen = app.proof.specimens[0];
  const entry = app.services.omittedMedia(specimen)[0];

  const bad = app.services.restoreOmittedMedia(specimen, entry.id, { name: 'x.png', bytes: new Uint8Array([1]), mime: 'image/png' }, { seed: app.doc.seed });
  assert.equal(bad.ok, false, 'a second minting site must not be reachable without the project');
  assert.match(bad.error, /P1/);

  await app.dispatch('specimen.supplyMedia', `${specimen.id}|${entry.id}`, { element: fakeImageInput('hero-plant.png') });
  assertIdsUnique(app.proof, 'a proof with a supplied image in it');
});

test('a file that is not an image is refused rather than inlined as an unnamed blob', async () => {
  const app = await fakeApp();
  const specimen = app.proof.specimens[0];
  const entry = app.services.omittedMedia(specimen)[0];
  const depth = app.stack.history().length;

  await app.dispatch('specimen.supplyMedia', `${specimen.id}|${entry.id}`, {
    element: { value: '', files: [{ name: 'notes.txt', type: 'text/plain', arrayBuffer: async () => new Uint8Array([1, 2]).buffer }] },
  });

  assert.equal(app.stack.history().length, depth, 'nothing was committed');
  assert.ok(app.ui.notices.some((n) => n.tone === 'bad' && /not an image/i.test(n.text)));
  assert.equal(imageMime('notes.txt', 'text/plain'), null);
  assert.equal(imageMime('hero.PNG'), 'image/png');
  assert.equal(imageMime('hero', 'image/webp'), 'image/webp');
});

test('a block whose ref resolves to nothing is named but offered no picker', async () => {
  const app = await fakeApp();
  const specimen = app.proof.specimens[0];
  const dangling = {
    ...specimen,
    mediaOmitted: [],
    blocks: [...specimen.blocks, { type: 'media', ref: '/assets/gone.png' }],
  };
  app.mutate('dangle', (doc) => ({ ...doc, proof: { ...doc.proof, specimens: [dangling, ...doc.proof.specimens.slice(1)] } }));
  app.select({ specimenId: dangling.id });
  app.ui.section = 'specimens';

  const entries = app.services.omittedMedia(app.proof.specimens[0]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].restorable, false, 'there is no recorded position to put it back at');

  const html = toHtml(PANELS.specimens(app));
  assert.match(html, /gone\.png/, 'it is still named — silence is what this whole surface is against');
  assert.doesNotMatch(html, /data-st-act="specimen\.supplyMedia"/, 'but a picker that cannot work is not offered');
  assert.match(html, /ASSET_MISSING/, 'and the honest route is named');
});

test('the emit panel names the images the file will not contain, beside “every check has passed”', async () => {
  const app = await realApp();
  for (const html of PAGES) paste(app, html);
  app.dispatch('scene.add', 'quoteCard');
  app.ui.section = 'emit';

  const html = toHtml(PANELS.emit(app));
  assert.match(html, /Images this file will not contain · 3/);
  assert.match(html, /hero-plant\.png/);
  assert.match(html, /their own pictures missing/i,
    'the consequence is stated in terms of what the client sees, not in terms of a count');
  assert.match(html, /have no file behind them/,
    'and it reads as a sentence: three images “has no file behind it” is how a working tool reads as a broken one');
  assert.match(html, /data-st-act="app\.section" data-st-arg="specimens"|data-st-arg="specimens"/,
    'with a way to the screen that fixes it');
});

test('a proof whose captures brought everything says nothing on the emit panel about omissions', async () => {
  const app = await fakeApp();
  app.mutate('clean', (doc) => ({
    ...doc,
    proof: { ...doc.proof, specimens: doc.proof.specimens.map((s) => ({ ...s, mediaOmitted: [], mediaUnresolved: [] })) },
  }));
  app.ui.section = 'emit';
  assert.doesNotMatch(toHtml(PANELS.emit(app)), /Images this file will not contain/);
});

test('P2: opening another project does not carry one project\'s dead buttons into it', async () => {
  const app = await fakeApp({
    findings: [finding({ id: 'fd_inert', code: 'ASSET_MISSING', severity: 1, locus: { specimenId: 'sp_x' }, autoFixAvailable: true })],
  });
  app.services.autoFixes = inertFixes();
  await app.dispatch('rehearse.sweep');
  await app.dispatch('rehearse.autoFix', '0');
  assert.equal(fixAttempt(app, 'fd_inert').outcome, 'no-change');

  const saved = await app.saveNow();
  assert.ok(saved.ok, saved.ok ? '' : saved.error);
  const loaded = await app.store.load(app.doc.id);
  app.loadRecord(loaded.value);
  assert.equal(fixAttempt(app, 'fd_inert'), null, 'the ledger belongs to a sweep, and the sweep was thrown away');
});

test('P2: a fix already proven inert refuses even if its control is dispatched again', async () => {
  const app = await fakeApp({
    findings: [finding({ id: 'fd_inert', code: 'ASSET_MISSING', severity: 1, locus: { specimenId: 'sp_x' }, autoFixAvailable: true })],
  });
  app.services.autoFixes = inertFixes();
  await app.dispatch('rehearse.sweep');
  await app.dispatch('rehearse.autoFix', '0');
  const depth = app.stack.history().length;
  const notices = app.ui.notices.length;

  await app.dispatch('rehearse.autoFix', '0');
  assert.equal(app.stack.history().length, depth);
  assert.ok(app.ui.notices.length > notices);
  assert.ok(app.ui.notices.some((n) => /already been applied to this finding/i.test(n.text)));
});
