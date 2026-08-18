/**
 * The eight rail sections, panel by panel, against what §15 and the sections it
 * points at actually require.
 *
 * These are content assertions rather than snapshots: a snapshot would go green
 * on a panel that renders the right shape with the wrong meaning. What is
 * checked here is the thing the spec asked for by name — the contrast column,
 * the resolved fallback and its metric delta, the stripped block with its
 * reason and a way back, the block-level alignment, the provenance state, the
 * beat plan, the branch coverage, the findings grouped by severity with a
 * clickable locus, and the degradation line items.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHtml } from '../../src/core/vdom.js';
import { StudioApp } from '../../src/ui/app.js';
import { PANELS } from '../../src/ui/panels/index.js';
import { renderStudio } from '../../src/ui/layout.js';
import { ProjectStore } from '../../src/core/storage.js';
import { fixtureDoc, fakeServices, makeClock, finding } from '../fixtures/ui/studio-fixture.mjs';

/**
 * @param {object} [options]
 * @returns {Promise<any>}
 */
async function makeApp(options = {}) {
  const clock = makeClock();
  const store = await ProjectStore.open({ clock, indexedDB: null });
  const app = new StudioApp({
    document: null, window: null, store, clock,
    services: fakeServices({ clock, ...options }), doc: fixtureDoc(),
  });
  app.ui.settings.operator = 'Alex Mercer';
  app.select({
    specimenId: app.proof.specimens[0].id,
    renditionId: app.proof.renditions[0].id,
    recipeId: app.proof.recipes[0].id,
    sceneId: app.proof.spine[0].id,
    branchId: app.proof.branches[0].id,
  });
  return app;
}

/**
 * @param {any} app
 * @param {string} section
 * @returns {string}
 */
function panel(app, section) {
  app.ui.section = section;
  return toHtml(PANELS[section](app));
}

// -------------------------------------------------------------- project ----

test('Project offers new, open, save, duplicate, delete, export and import', async () => {
  const app = await makeApp();
  app.ui.projects = [
    { id: app.doc.id, name: app.doc.name, prospectName: 'Northwind Industrial', savedAt: app.clock(), revision: 2, bytes: 1024, schemaVersion: 1 },
    { id: 'pj_other', name: 'Another', prospectName: 'Other Co', savedAt: app.clock(), revision: 1, bytes: 2048, schemaVersion: 1 },
  ];
  const html = panel(app, 'project');
  for (const act of ['project.new', 'project.save', 'project.duplicate', 'project.open', 'project.delete', 'project.export', 'project.import']) {
    assert.match(html, new RegExp(`data-st-act="${act.replace('.', '\\.')}"`), `${act} must be on the panel`);
  }
  assert.match(html, /data-st-act="project\.setSeed"/, '§5: the project seed is editable');
  assert.match(html, /data-st-act="project\.setProspect"/);
  assert.match(html, /pitchproof\.json/, '§16: the interchange format is named');
  assert.match(html, /never carries your CORS proxy/i, 'and what an export does not carry is stated');
});

// ---------------------------------------------------------------- brand ----

test('Brand shows every colour role with its computed contrast against its pair', async () => {
  const app = await makeApp();
  const html = panel(app, 'brand');
  for (const role of ['primary', 'onPrimary', 'surface', 'onSurface', 'accent', 'onAccent']) {
    assert.match(html, new RegExp(`>${role}<`), `${role} must appear`);
  }
  assert.match(html, /7\.20:1/, 'the contrast is the computed number, shown to two decimals');
  assert.match(html, /Contrast/, 'and the column says what it is');
  assert.match(html, /Pair/, 'next to the role it is computed against');
});

test('Brand shows every face with its fallback and its metric delta', async () => {
  const app = await makeApp();
  const html = panel(app, 'brand');
  assert.match(html, /Inter, Arial, sans-serif/, 'the resolved fallback stack');
  assert.match(html, /×1\.002/, 'and the avgAdvance delta');
  assert.match(html, /×1\.090/, 'including the one that is wide enough to overflow');
  assert.match(html, /Cap height/);
  assert.match(html, /x-height/);
  assert.match(html, /wider than Söhne/, 'with the consequence spelled out');
});

test('Brand shows the logo, the shape and the imagery treatment', async () => {
  const app = await makeApp();
  const html = panel(app, 'brand');
  assert.match(html, /data-st-act="brand\.setLogoVariant"/);
  assert.match(html, /Derive inverse/);
  assert.match(html, /data-st-act="brand\.setRadius"/);
  assert.match(html, /data-st-act="brand\.setShadow"/);
  assert.match(html, /data-st-act="brand\.setImageryTreatment"/);
});

test('Brand surfaces low-confidence fields for review and says what the hold means', async () => {
  const app = await makeApp();
  const html = panel(app, 'brand');
  assert.match(html, /Waiting for your review/);
  assert.match(html, /41%/, 'the confidence figure is shown, not a category');
  assert.match(html, /emit stays closed until each is reviewed/i);
  assert.match(html, /data-st-act="brand\.review"/);
});

test('Brand records every manual override by path', async () => {
  const app = await makeApp();
  app.dispatch('brand.setColor', 'primary', { value: '#2A5BD7' });
  const html = panel(app, 'brand');
  assert.match(html, /brand\.colors\.primary/, '§4 manualOverrides is shown, not just stored');
});

// ------------------------------------------------------------ specimens ----

test('Specimens shows the chrome-stripping result with its reason and its score', async () => {
  const app = await makeApp();
  const html = panel(app, 'specimens');
  assert.match(html, /link density/, 'the reason the block was removed');
  assert.match(html, /score 0\.91/, 'and the score that removed it');
  assert.match(html, /Products Services About Careers Contact/, 'and what was actually taken');
});

test('every stripped block is restorable, individually and all at once', async () => {
  const app = await makeApp();
  const html = panel(app, 'specimens');
  assert.match(html, /data-st-act="specimen\.restore" data-st-arg="[^"]+:0"/);
  assert.match(html, /data-st-act="specimen\.restoreAll"/);

  const before = app.proof.specimens[0].blocks.length;
  app.dispatch('specimen.restore', `${app.proof.specimens[0].id}:0`);
  assert.equal(app.proof.specimens[0].blocks.length, before + 1, 'and restoring really puts it back');
  assert.equal(app.proof.specimens[0].stripped.length, 0);
});

test('raw HTML is opt-in per specimen and the opt-in records who and when', async () => {
  const app = await makeApp();
  const html = panel(app, 'specimens');
  assert.match(html, /data-st-act="specimen\.rawOptIn"/);
  assert.match(html, /per-specimen opt-in/i);

  app.dispatch('specimen.rawOptIn', app.proof.specimens[0].id, { value: true });
  const optIn = app.proof.specimens[0].rawOptIn;
  assert.equal(optIn.allowed, true);
  assert.equal(optIn.by, 'Alex Mercer');
  assert.ok(optIn.at, '§8: the opt-in is recorded with a time');
});

test('an edited specimen is flagged, because the artifact has to say so', async () => {
  const app = await makeApp();
  app.dispatch('specimen.setBlockText', `${app.proof.specimens[0].id}:1`, { value: 'Rewritten.' });
  assert.equal(app.proof.specimens[0].edited, true);
  const html = panel(app, 'specimens');
  assert.match(html, /the artifact will say so/i);
});

// -------------------------------------------------------------- recipes ----

test('Recipes offers the seed library and describes each recipe by its intent', async () => {
  const app = await makeApp();
  const html = panel(app, 'recipes');
  assert.match(html, /data-st-act="recipe\.loadSeed"/);
  assert.match(html, /One page becomes nine markets without nine teams\./);
});

test('the paste surface aligns the pasted blocks to the source specimen block by block', async () => {
  const app = await makeApp();
  app.setDraft('rendition.paste', 'Erste Zeile.\n\nZweite Zeile.');
  const html = panel(app, 'recipes');
  assert.match(html, /st-align-body/, 'the surface is side by side');
  assert.match(html, /Alignment/, 'with an alignment score');
  assert.match(html, /Industrial coatings that hold/, 'the source blocks on the left');
  assert.match(html, /Erste Zeile\./, 'the pasted blocks on the right');
  assert.match(html, /st-align-cell--unmatched/, 'and the blocks that did not pair are marked');
});

test('the paste surface enforces and shows a channel budget', async () => {
  const app = await makeApp();
  app.setDraft('rendition.label', 'SMS');
  const html = panel(app, 'recipes');
  assert.match(html, /160 characters, 30 words/, 'the budget for the channel is stated up front');
});

test('every rendition shows its provenance, and promotion is deliberate and recorded', async () => {
  const app = await makeApp();
  const html = panel(app, 'recipes');
  assert.match(html, /Illustrative/);
  assert.match(html, /cannot be removed or styled away/i);
  assert.match(html, /data-st-act="rendition\.promote"/);
  assert.match(html, /I have verified this/);
  assert.match(html, /recorded against your name/i);

  app.dispatch('rendition.promote', app.proof.renditions[0].id);
  const promoted = app.proof.renditions[0];
  assert.equal(promoted.provenance, 'verified-by-user');
  assert.match(promoted.notes, /promoted by Alex Mercer at /, '§9: who and when');
});

test('promotion without a name is refused rather than recorded as nobody', async () => {
  const app = await makeApp();
  app.ui.settings.operator = '';
  app.dispatch('rendition.promote', app.proof.renditions[0].id);
  assert.equal(app.proof.renditions[0].provenance, 'illustrative');
  assert.ok(app.ui.notices.some((n) => /Settings/.test(n.text)));
});

// --------------------------------------------------------------- scenes ----

test('Scenes assembles the spine from templates and edits headline, subhead and specimen', async () => {
  const app = await makeApp();
  const html = panel(app, 'scenes');
  assert.match(html, /data-st-act="scene\.add"/);
  assert.match(html, /Split before After|Split before\/after/i);
  assert.match(html, /data-st-act="scene\.setHeadline"/);
  assert.match(html, /data-st-act="scene\.setSubhead"/);
  assert.match(html, /data-st-act="scene\.setSpecimen"/);
  assert.match(html, /data-st-act="scene\.setLayout"/);
  assert.match(html, /data-st-act="scene\.toggleRendition"/);
});

test('Scenes edits the beat plan: add, remove, reorder and choose what each reveals', async () => {
  const app = await makeApp();
  const html = panel(app, 'scenes');
  assert.match(html, /data-st-act="beat\.add"/);
  assert.match(html, /data-st-act="beat\.remove"/);
  assert.match(html, /data-st-act="beat\.move"/);
  assert.match(html, /data-st-act="beat\.toggleReveal"/);
  assert.match(html, /data-st-act="beat\.setNote"/);
  assert.match(html, /Beat n shows everything from beats 0\.\.n/);
});

test('a scene keeps at least one beat', async () => {
  const app = await makeApp();
  const scene = app.proof.spine[2];
  assert.equal(scene.beats.length, 1);
  const depth = app.stack.history().length;
  app.dispatch('beat.remove', `${scene.id}:0`);
  assert.equal(app.stack.history().length, depth, 'the last beat cannot be removed');
});

// ------------------------------------------------------------- branches ----

test('Branches creates from an objection, takes aliases, sets the return policy and anchors', async () => {
  const app = await makeApp();
  const html = panel(app, 'branches');
  assert.match(html, /data-st-act="branch\.objectionDraft"/);
  assert.match(html, /data-st-act="branch\.create"/);
  assert.match(html, /data-st-act="branch\.addAlias"/);
  assert.match(html, /data-st-act="branch\.removeAlias"/);
  assert.match(html, /data-st-act="branch\.setReturnPolicy"/);
  assert.match(html, /data-st-act="branch\.anchorTo"/);
  assert.match(html, /the way a client says it out loud/i);
});

test('Branches shows coverage and lets the jump index be tested before the pitch', async () => {
  const app = await makeApp();
  app.setDraft('branch.jumpQuery', 'app');
  const html = panel(app, 'branches');
  assert.match(html, /Jump index/);
  assert.match(html, /Our approvals process would never allow this/);
  assert.match(html, /Reachable/);
  assert.match(html, /Returns/);
});

// ------------------------------------------------------------- rehearse ----

test('Rehearse groups findings by severity with a clickable locus', async () => {
  const app = await makeApp();
  const findings = [
    finding({ id: 'fd_1', severity: 1, code: 'CONTRAST_FAIL', message: 'Body text is 3.2:1.', locus: { sceneId: app.proof.spine[1].id } }),
    finding({ id: 'fd_2', severity: 2, code: 'BEAT_EMPTY', message: 'A beat reveals nothing.', locus: { sceneId: app.proof.spine[0].id }, autoFixAvailable: true }),
    finding({ id: 'fd_3', severity: 3, code: 'STALE_CAPTURE', message: 'This capture is 44 days old.', locus: { specimenId: app.proof.specimens[0].id } }),
  ];
  app.ui.sweep = { findings, at: app.clock(), running: false, error: null, proofHash: null };
  const html = panel(app, 'rehearse');

  assert.match(html, /Blocking · 1/);
  assert.match(html, /Warning · 1/);
  assert.match(html, /Note · 1/);
  assert.match(html, /Blocks the emit\. There is no override\./);
  assert.match(html, /data-st-act="rehearse\.goToLocus" data-st-arg="fd_1"/, 'the locus is clickable');

  app.dispatch('rehearse.goToLocus', 'fd_1');
  assert.equal(app.ui.section, 'scenes', 'and it jumps to what raised it');
  assert.equal(app.ui.selection.sceneId, app.proof.spine[1].id);
});

test('Rehearse offers each available auto-fix and logs what was applied', async () => {
  const app = await makeApp();
  app.ui.sweep = {
    findings: [finding({ id: 'fd_2', severity: 2, code: 'BEAT_EMPTY', message: 'A beat reveals nothing.', autoFixAvailable: true })],
    at: app.clock(), running: false, error: null, proofHash: null,
  };
  let html = panel(app, 'rehearse');
  assert.match(html, /Auto-fix: fix BEAT_EMPTY/);
  assert.match(html, /one undo takes it back/i);

  app.dispatch('rehearse.autoFix', '0');
  html = panel(app, 'rehearse');
  assert.match(html, /Auto-fixes applied/);
  assert.match(html, /Auto-fix: fix BEAT_EMPTY/);
});

test('the dry run walks the deck with a heads-up issue counter', async () => {
  const app = await makeApp({
    findings: [finding({ id: 'fd_1', severity: 1, code: 'CONTRAST_FAIL', locus: { sceneId: 'sc_ui_0' } })],
  });
  await app.dispatch('rehearse.dryRun');
  assert.equal(app.ui.dryRun.active, true);
  assert.ok(app.ui.dryRun.positions.length >= 6, 'every beat of every spine scene is a position');

  app.ui.section = 'rehearse';
  const shell = toHtml(renderStudio(app));
  assert.match(shell, /Dry run/);
  assert.match(shell, /1 \/ \d+/, 'the position counter');
  assert.match(shell, /blocking finding/, 'and the issue counter §14 asks for');

  app.dispatch('rehearse.dryRunStep', '1');
  assert.equal(app.ui.dryRun.index, 1);
});

// ----------------------------------------------------------------- emit ----

test('Emit shows the options, the budget and the preflight, and no override', async () => {
  const app = await makeApp();
  app.ui.sweep = { findings: [], at: app.clock(), running: false, error: null, proofHash: null };
  const html = panel(app, 'emit');
  assert.match(html, /data-st-act="emit\.setMode"/);
  assert.match(html, /data-st-act="emit\.setQuality"/);
  assert.match(html, /data-st-act="emit\.setMaxBytes"/);
  assert.match(html, /data-st-act="emit\.setNotes"/);
  assert.match(html, /Size budget/);
  assert.match(html, /every degradation is a line item/i);
  assert.ok(!/override|emit anyway/i.test(html.replace(/There is no override[^<]*/gi, '')), 'nothing offers a way past');
});

test('Emit lists every degradation with predicted and actual bytes', async () => {
  const app = await makeApp({
    emitResult: {
      html: '<html></html>',
      bytes: 1200000,
      findings: [],
      degradations: [
        { assetId: 'md_hero', rank: 1, from: { w: 2400, h: 1350, quality: 0.92 }, to: { w: 1600, h: 900, quality: 0.75 }, predictedBytes: 420000, actualBytes: 418311, reason: 'over the per-asset ceiling' },
        { assetId: 'md_logo', rank: 7, from: { w: 800, h: 800, quality: 0.85 }, to: { w: 400, h: 400, quality: 0.75 }, predictedBytes: 30000, actualBytes: 41000, reason: 'budget shortfall' },
      ],
      compression: { mode: 'deflate', modelBytes: 22000, mediaBytes: 1100000 },
    },
  });
  app.ui.sweep = { findings: [], at: app.clock(), running: false, error: null, proofHash: null };
  app.dispatch('brand.reviewAll');
  app.ui.sweep.proofHash = null;
  await app.dispatch('emit.run');

  const html = panel(app, 'emit');
  assert.match(html, /md_hero/);
  assert.match(html, /2400×1350 q0\.92/);
  assert.match(html, /1600×900 q0\.75/);
  assert.match(html, /over the per-asset ceiling/);
  assert.match(html, /budget shortfall/);
  assert.match(html, /Predicted/);
  assert.match(html, /Actual/);
  assert.match(html, /st-warn/, 'a prediction that missed by more than 10% is flagged rather than smoothed over');
});

// ------------------------------------------------------------- settings ----

test('Settings ships no proxy and says why the field is empty', async () => {
  const app = await makeApp();
  const html = panel(app, 'settings');
  assert.match(html, /data-st-act="settings\.setProxy"/);
  assert.match(html, /Empty by default/i);
  assert.match(html, /never route a prospect’s pages through a third party/i);
  assert.ok(!/allorigins|corsproxy|thingproxy|cors-anywhere/i.test(html), 'no third-party proxy is suggested anywhere');
});

test('Settings tells the truth about which lanes are wired', async () => {
  const app = await makeApp({ status: { emit: false, validate: false } });
  const html = panel(app, 'settings');
  assert.match(html, /not wired/);
  assert.match(html, /src\/emit\/index\.js/);
});

// ------------------------------------------------------------ the shell ----

test('the rail is the §15 order and every section is one keystroke away', async () => {
  const app = await makeApp();
  const html = toHtml(renderStudio(app));
  const order = ['Project', 'Brand', 'Specimens', 'Recipes', 'Scenes', 'Branches', 'Rehearse', 'Emit'];
  let at = -1;
  for (const label of order) {
    const found = html.indexOf(`>${label}<`);
    assert.ok(found > at, `${label} must come after the previous section in the rail`);
    at = found;
  }
});

test('the canvas hosts the preview and never lets the patcher into it', async () => {
  const app = await makeApp();
  const html = toHtml(renderStudio(app));
  assert.match(html, /data-st-preview-host="true"/);
  assert.match(html, /data-st-preserve="preview"/);
  assert.match(html, /Preview width/, 'and offers the three breakpoints §14 measures at');
});

test('the status bar always says whether the work is saved and what blocks the emit', async () => {
  const app = await makeApp();
  const html = toHtml(renderStudio(app));
  assert.match(html, /Local storage/);
  assert.match(html, /Not saved yet|Saved /);
  assert.match(html, /blocks the emit|Ready to emit/);
});
