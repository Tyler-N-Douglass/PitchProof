/**
 * Fixtures for the studio tests.
 *
 * Two things live here: a document rich enough that every mutating action in
 * the registry has something real to act on, and a fake lane adapter with the
 * same surface as `src/ui/services.js`. The fake is what lets the panels be
 * tested before L3, L4, L5, L7, L8, L10 and L11 have landed — and, more
 * importantly, what keeps the tests from asserting anything about those lanes'
 * behaviour rather than the studio's.
 *
 * Nothing here reads a clock or a random source: the clock is a counter and
 * every id is content-derived, so a test run is reproducible.
 */

import { contentId, elementId } from '../../../src/core/ids.js';
import { defaultEmitOptions } from '../../../src/core/contracts.js';
import { ok, err } from '../../../src/core/result.js';
import { registerAllLayouts, sceneTemplates } from '../../../src/scene/index.js';
import { usedIds } from '../../../src/ui/model.js';

/**
 * The sentence the real adapter returns for a lane call made without the proof
 * whose ids the new ones must not collide with (CRITIQUE-3 P1). The fake says
 * the same thing for the same reason.
 * @param {string} method
 * @returns {string}
 */
const NO_PROOF = (method) => `${method} was called without the project's proof, so the ids it mints could collide with ids the project already uses. Nothing was changed. This is a wiring fault in the studio (CRITIQUE-3 P1), not something you did.`;

const AT = '2026-02-01T09:00:00.000Z';

/**
 * A monotonic ISO clock, so `savedAt` and promotion records are deterministic.
 * @param {number} [start]
 * @returns {() => string}
 */
export function makeClock(start = 0) {
  let n = start;
  return () => new Date(Date.UTC(2026, 1, 1, 9, 0, 0) + (n++) * 1000).toISOString();
}

/**
 * A brand system with one group deliberately below the §7 confidence floor, so
 * the review gate has something to hold.
 * @returns {any}
 */
export function fixtureBrand() {
  return {
    id: contentId('brand', 'ui-fixture'),
    sourceUrl: 'https://www.northwind.example',
    capturedAt: AT,
    colors: [
      { role: 'primary', hex: '#123A8C', oklch: [0.36, 0.14, 264], source: 'extracted', contrastWithPair: 10.2 },
      { role: 'onPrimary', hex: '#FFFFFF', oklch: [1, 0, 0], source: 'derived', contrastWithPair: 10.2 },
      { role: 'surface', hex: '#FFFFFF', oklch: [1, 0, 0], source: 'extracted', contrastWithPair: 16.4 },
      { role: 'onSurface', hex: '#16181D', oklch: [0.22, 0.01, 264], source: 'extracted', contrastWithPair: 16.4 },
      { role: 'accent', hex: '#E2574C', oklch: [0.62, 0.18, 28], source: 'extracted', contrastWithPair: 4.7 },
      { role: 'onAccent', hex: '#FFFFFF', oklch: [1, 0, 0], source: 'derived', contrastWithPair: 4.7 },
    ],
    faces: [
      {
        family: 'Inter', fallbackStack: ['Inter', 'Arial', 'sans-serif'], weightsSeen: [400, 600],
        role: 'body', metricDelta: { capHeight: 1.015, xHeight: 0.996, avgAdvance: 1.002 }, embeddable: false,
      },
      {
        family: 'Söhne', fallbackStack: ['Söhne', 'Helvetica', 'Arial', 'sans-serif'], weightsSeen: [700],
        role: 'display', metricDelta: { capHeight: 0.94, xHeight: 0.91, avgAdvance: 1.09 }, embeddable: false,
      },
    ],
    logos: [
      {
        id: contentId('logo', 'ui-fixture'),
        kind: 'svg',
        data: '<svg viewBox="0 0 20 20"><rect width="20" height="20" fill="#123A8C"></rect></svg>',
        variant: 'primary',
        intrinsic: { w: 20, h: 20 },
        hasTransparency: false,
      },
    ],
    shape: { radiusPx: 6, borderWidthPx: 1, shadowLevel: 2 },
    imagery: { treatment: 'photographic', saturationBias: 0.12 },
    // `logos` is deliberately below the floor so the §7 review gate has work.
    confidence: { colors: 0.86, faces: 0.74, logos: 0.41, shape: 0.78, imagery: 0.71 },
    manualOverrides: [],
  };
}

/**
 * A specimen with real blocks, one stripped chrome entry and no raw opt-in.
 * @returns {any}
 */
export function fixtureSpecimen() {
  const id = contentId('specimen', 'ui-fixture-home');
  return {
    id,
    kind: 'page',
    title: 'Industrial coatings that hold',
    sourceUrl: 'https://www.northwind.example/coatings',
    capturedAt: AT,
    blocks: [
      { type: 'heading', level: 1, text: 'Industrial coatings that hold' },
      { type: 'paragraph', text: 'Forty years of protecting steel in places nobody wants to go twice.' },
      { type: 'list', ordered: false, items: ['Offshore', 'Rail', 'Bridge'] },
      { type: 'cta', label: 'Talk to an engineer', href: null },
    ],
    media: [],
    meta: { title: 'Industrial coatings that hold', lang: 'en' },
    wordCount: 24,
    locale: 'en',
    raw: '<html><body><h1>Industrial coatings that hold</h1></body></html>',
    rawOptIn: { allowed: false, by: null, at: null },
    edited: false,
    editNotes: [],
    stripped: [
      {
        id: contentId('block', 'ui-fixture-nav'),
        reason: 'link density',
        score: 0.91,
        selector: 'body > header > nav',
        path: [0, 0],
        text: 'Products Services About Careers Contact',
        blocks: [{ type: 'paragraph', text: 'Products Services About Careers Contact' }],
        positions: [0],
      },
    ],
    restored: [],
    blockPositions: [1, 2, 3, 4],
    chrome: { locator: 'main', root: 'body > main', removedCount: 1, siblingPages: 0 },
  };
}

/**
 * @param {string} specimenId
 * @param {string} recipeId
 * @returns {any}
 */
export function fixtureRendition(specimenId, recipeId) {
  return {
    id: contentId('rendition', 'ui-fixture-de'),
    specimenId,
    recipeId,
    label: 'de-DE',
    blocks: [
      { type: 'heading', level: 1, text: 'Industrielle Beschichtungen, die halten' },
      { type: 'paragraph', text: 'Vierzig Jahre Stahlschutz an Orten, an die niemand zweimal möchte.' },
    ],
    media: [],
    provenance: 'illustrative',
    producedBy: 'manual-paste',
    notes: null,
  };
}

/** @returns {any} */
export function fixtureRecipe() {
  return {
    id: contentId('recipe', 'locale-fanout'),
    name: 'Locale fan-out',
    intent: 'One page becomes nine markets without nine teams.',
    inputKinds: ['page', 'article', 'product'],
    outputLabels: ['de-DE', 'fr-FR', 'ja-JP'],
    adapterPrompt: null,
  };
}

/**
 * @param {string} id
 * @param {number} beats
 * @param {Partial<any>} [overrides]
 * @returns {any}
 */
export function fixtureScene(id, beats = 2, overrides = {}) {
  return {
    id,
    layout: 'splitBeforeAfter',
    headline: `Headline for ${id}`,
    subhead: null,
    specimenId: null,
    renditionIds: [],
    beats: Array.from({ length: beats }, (_, i) => ({
      id: `${id}_b${i}`,
      reveals: [elementId(id, `block/${i}`)],
      presenterNote: i === 0 ? 'Name the problem in their words.' : null,
      dwellHintMs: i === 0 ? 20000 : null,
    })),
    branchAnchors: [],
    ...overrides,
  };
}

/**
 * A document with every kind of object the studio edits, so the undo test can
 * drive every mutating action against something real.
 * @returns {import('../../../src/ui/model.js').Doc}
 */
export function fixtureDoc() {
  const specimen = fixtureSpecimen();
  const recipe = fixtureRecipe();
  const rendition = fixtureRendition(specimen.id, recipe.id);

  const spine = [
    fixtureScene('sc_ui_0', 2, { specimenId: specimen.id, renditionIds: [rendition.id], branchAnchors: ['bn_ui_0'] }),
    fixtureScene('sc_ui_1', 3, { specimenId: specimen.id }),
    fixtureScene('sc_ui_2', 1, { layout: 'quoteCard' }),
  ];

  const branches = [
    {
      id: 'bn_ui_0',
      objection: 'Our approvals process would never allow this',
      aliases: ['sign-off', 'review chain'],
      scenes: [fixtureScene('sc_ui_b0', 2, { layout: 'sideNote' })],
      returnPolicy: 'anchor',
    },
    {
      id: 'bn_ui_1',
      objection: 'That works for one page, not four hundred',
      aliases: ['at scale'],
      scenes: [fixtureScene('sc_ui_b1', 1, { layout: 'fanOut' })],
      returnPolicy: 'nextSpineScene',
    },
  ];

  return {
    id: contentId('project', 'ui-fixture'),
    name: 'Northwind proof',
    seed: 'ui-fixture-seed',
    proof: {
      schemaVersion: 1,
      id: contentId('proof', 'ui-fixture'),
      prospectName: 'Northwind Industrial',
      createdAt: AT,
      brand: fixtureBrand(),
      specimens: [specimen],
      renditions: [rendition],
      recipes: [recipe],
      spine,
      branches,
      emitOptions: defaultEmitOptions(),
    },
  };
}

/**
 * A lane adapter with the same surface as the real one. Every method is
 * deterministic and none of them touch a network, a clock they were not given,
 * or a lane.
 * @param {object} [options]
 * @param {() => string} [options.clock]
 * @param {Partial<Record<string, boolean>>} [options.status]
 * @param {any[]} [options.findings]
 * @param {any} [options.emitResult]
 * @returns {any}
 */
export function fakeServices(options = {}) {
  const clock = options.clock || makeClock();
  const status = {
    ingest: true, color: true, theme: true, specimen: true, recipe: true,
    scene: true, branch: true, emit: true, validate: true,
    ...(options.status || {}),
  };
  const calls = [];
  const record = (name, args) => { calls.push({ name, args }); };

  const services = {
    status,
    calls,
    missing: () => Object.keys(status).filter((k) => !status[k]),
    lanes: () => Object.keys(status).map((k) => ({ key: k, module: `src/${k}/index.js`, label: k, wired: !!status[k] })),
    has: (key) => !!status[key],

    async ingestUrl(url) {
      record('ingestUrl', [url]);
      if (!status.ingest) return err('ingest is not wired');
      return ok({ kind: 'html', sourceUrl: url, capturedAt: clock(), html: '<html></html>', doc: null, blocks: null, assets: [], meta: {}, strategy: 'fake' });
    },
    async importFiles(files) {
      record('importFiles', [files.length]);
      return ok({ captures: [{ kind: 'html', sourceUrl: null, capturedAt: clock(), html: '', doc: null, blocks: null, assets: [], meta: {}, strategy: 'fake' }], problems: [] });
    },
    importHtmlText(html, sourceUrl) {
      record('importHtmlText', [sourceUrl]);
      return ok({ kind: 'html', sourceUrl, capturedAt: clock(), html, doc: null, blocks: null, assets: [], meta: {}, strategy: 'fake-paste' });
    },
    async discoverSitemap() { return ok([{ url: 'https://www.northwind.example/a', score: 0.9 }]); },

    contrast: (a, b) => (a === b ? 1 : 7.2),
    oklch: () => [0.5, 0.1, 200],
    deriveForContrast: () => '#0A0A0A',
    // The `proof` precondition is the real adapter's, and the fake enforces it
    // for the reason CRITIQUE-3 P1 exists: the fake minted unique ids by an
    // accident of its own call counter while the real adapter minted the same
    // id every time, so every studio test agreed with a defect none of them
    // could see. A fake that accepts a call the real one refuses is not a fake.
    buildBrand: (captures, options) => {
      if (!options || !options.proof) return err(NO_PROOF('buildBrand'));
      return ok({
        ...fixtureBrand(),
        capturedAt: clock(),
        sourceUrl: (captures[0] && captures[0].sourceUrl) || 'file://import',
        confidence: { colors: 0.9, faces: 0.8, logos: 0.75, shape: 0.8, imagery: 0.78 },
      });
    },
    compileTheme: () => ({ css: ':root{--pp-primary:#123A8C}', vars: { '--pp-primary': '#123A8C' } }),
    artifactThemeCss: () => ':root{--pp-primary:#123A8C}',
    // §7's only route to `embeddable: true`, shaped like L5's: a file and a
    // rights assertion, or nothing (CRITIQUE-2 C3). The fake refuses on the same
    // two conditions the real one does, so a caller that skips either fails here
    // rather than only in the studio.
    attachUserFont: (faces, supply) => {
      record('attachUserFont', [supply && supply.family]);
      if (!supply || !supply.family) return err('attachUserFont: a family is required');
      if (!supply.bytes && !supply.dataUri) return err('attachUserFont: a font file (bytes or dataUri) is required');
      const assertion = supply.rightsAssertion;
      if (!assertion || !assertion.assertedBy || !assertion.statement) {
        return err('attachUserFont: a rights assertion naming who asserted it is required before a font may be embedded');
      }
      const list = faces.slice();
      const at = list.findIndex((f) => f.family === supply.family);
      const before = at >= 0 ? list[at] : { family: supply.family, role: 'body', fallbackStack: [supply.family], weightsSeen: [400], metricDelta: null };
      const face = {
        ...before,
        embeddable: true,
        available: true,
        confidence: 1,
        primaryWeight: (supply.weights || [])[0] || 400,
        fontFile: {
          fileName: supply.fileName,
          mime: supply.mime || 'font/woff2',
          style: supply.style || 'normal',
          bytes: supply.bytes ? supply.bytes.length : null,
          dataUri: supply.dataUri || null,
        },
        rightsAssertion: { assertedBy: assertion.assertedBy, statement: assertion.statement, assertedAt: clock() },
      };
      if (at >= 0) list[at] = face; else list.push(face);
      return ok({ faces: list, face, assertion: { family: face.family, fileName: supply.fileName, assertedBy: assertion.assertedBy, statement: assertion.statement, assertedAt: face.rightsAssertion.assertedAt, bytes: supply.bytes ? supply.bytes.length : 0 } });
    },
    inverseLogo: (logo) => ({ ...logo, id: `${logo.id}_inv`, variant: 'inverse' }),

    buildSpecimen: (capture, options) => {
      if (!options || !options.proof) return err(NO_PROOF('buildSpecimen'));
      const taken = usedIds(options.proof);
      let id = contentId('specimen', `fake-${calls.length}`);
      for (let i = 1; taken.has(id); i += 1) id = contentId('specimen', `fake-${calls.length}-${i}`);
      return ok({ ...fixtureSpecimen(), id });
    },
    setRawOptIn: (specimen, allowed, by) => ok({ ...specimen, rawOptIn: { allowed, by: allowed ? by : null, at: allowed ? clock() : null } }),
    restoreStripped: (specimen, entry) => ok({
      ...specimen,
      blocks: [...specimen.blocks, ...(entry.blocks || [])],
      stripped: (specimen.stripped || []).filter((e) => e !== entry),
    }),
    restoreAllStripped: (specimen) => ok({
      ...specimen,
      blocks: [...specimen.blocks, ...(specimen.stripped || []).flatMap((e) => e.blocks || [])],
      stripped: [],
    }),
    editSpecimenBlocks: (specimen, blocks, note) => ok({
      ...specimen, blocks, edited: true, editNotes: [...(specimen.editNotes || []), note],
    }),
    rawFallback: () => ({ blocks: [], allowed: false, reason: 'not opted in' }),

    seedRecipes: () => [fixtureRecipe(), {
      id: contentId('recipe', 'channel-variants'),
      name: 'Channel variants',
      intent: 'One page becomes an email, a paid social set, an in-product message and an SMS.',
      inputKinds: ['page', 'article'],
      outputLabels: ['Email', 'Paid social', 'In-product', 'SMS'],
      adapterPrompt: null,
    }],
    alignBlocks: (a, b) => ({ pairs: (a || []).map((_, i) => [i, i < (b || []).length ? i : null]), score: 0.8 }),
    parsePasted: (text) => String(text).split(/\n{2,}/).filter(Boolean).map((t) => ({ type: 'paragraph', text: t.trim() })),
    recipesFor: (specimen) => (specimen ? [fixtureRecipe()] : []),
    recipeAccepts: (recipe, specimen) => !!(recipe && specimen && (recipe.inputKinds || []).includes(specimen.kind)),
    renderRecipe: (recipe, specimen) => {
      const id = typeof recipe === 'string' ? recipe : recipe.id;
      if (!specimen || !(specimen.blocks || []).length) return err(`renderRecipe: ${id} cannot run on an empty specimen`);
      return ok([{
        id: contentId('rendition', `tpl-${id}-${calls.length}`),
        specimenId: specimen.id, recipeId: id, label: 'de-DE',
        blocks: [{ type: 'paragraph', text: 'from a seed recipe' }], media: [],
        provenance: 'illustrative', producedBy: 'template', notes: null,
      }]);
    },
    renderAllRecipes: (specimen) => {
      record('renderAllRecipes', [specimen && specimen.id]);
      if (!specimen) return err('renderAll: a specimen is required');
      return ok({
        renditions: [{
          id: contentId('rendition', `all-${calls.length}`),
          specimenId: specimen.id, recipeId: fixtureRecipe().id, label: 'fr-FR',
          blocks: [{ type: 'paragraph', text: 'from the library' }], media: [],
          provenance: 'illustrative', producedBy: 'template', notes: null,
        }],
        failures: [],
      });
    },
    buildRendition: (args) => ok({
      id: contentId('rendition', `fake-${args.label}-${calls.length}`),
      specimenId: args.specimen.id,
      recipeId: args.recipe.id,
      label: args.label,
      blocks: args.blocks,
      media: args.media || [],
      provenance: 'illustrative',
      producedBy: args.producedBy,
      notes: null,
    }),
    promoteProvenance: (rendition, by) => ok({
      ...rendition,
      provenance: 'verified-by-user',
      notes: `${rendition.notes ? `${rendition.notes}\n` : ''}promoted by ${by} at ${clock()}`,
    }),
    promotionRecord: (rendition) => {
      const match = String((rendition && rendition.notes) || '').match(/promoted by (.+?) at (\S+)/);
      return match ? { by: match[1], at: match[2], from: 'illustrative', signatureValid: true } : null;
    },
    // The real adapter returns L7's `PROMOTION_RECORD_LIMIT` verbatim. The fake
    // returns a stand-in of the same shape rather than importing the lane, so a
    // test that means to check L7's actual wording has to use real services.
    promotionRecordLimit: () => 'A promotion record is checked against itself, not against an authority.',
    visibleNotes: (rendition) => String((rendition && rendition.notes) || '').split('\n').filter((l) => !/^promoted by /.test(l)).join('\n'),
    composeNotes: (rendition, prose) => {
      const records = String((rendition && rendition.notes) || '').split('\n').filter((l) => /^promoted by /.test(l)).join('\n');
      const joined = [String(prose || '').trim(), records].filter(Boolean).join('\n');
      return joined || null;
    },
    channelBudget: (label) => (label === 'SMS' ? { maxChars: 160, maxWords: 30 } : null),
    enforceBudget: (blocks) => ({ blocks, overBy: 0 }),
    async runAdapter(recipe, specimen) {
      record('runAdapter', [recipe.id, specimen.id]);
      return ok({
        id: contentId('rendition', `adapter-${calls.length}`),
        specimenId: specimen.id, recipeId: recipe.id, label: 'Adapter output',
        blocks: [{ type: 'paragraph', text: 'generated' }], media: [],
        provenance: 'illustrative', producedBy: 'adapter', notes: null,
      });
    },

    // The layout registry is L2's and global. A fake that left it empty would
    // make the beat editor look as though no layout renders anything, so the
    // fake registers the real eight — the panels under test then see what the
    // artifact would.
    ensureLayouts: () => { record('ensureLayouts', []); registerAllLayouts(); },
    sceneTemplates: () => sceneTemplates(),
    buildScene: (args) => ok(fixtureScene(args.id || 'sc_fake', 1)),

    buildJumpIndex: () => ({ entries: [] }),
    searchJump: () => [{ branchId: 'bn_ui_0', objection: 'Our approvals process would never allow this', score: 0.9, matched: 'approvals' }],
    branchCoverage: () => ({ unreachable: [], noReturn: [] }),
    registerBranchOverlays: () => () => {},

    fetchStrategies: () => [
      { id: 'direct-fetch', label: 'Direct fetch', describe: 'Ask the browser for the page.', kind: 'network', automatic: true, requires: ['http', 'clock'] },
      { id: 'saved-page', label: 'Saved page', describe: 'Save the page from your browser and drop it here.', kind: 'file', automatic: false, requires: ['clock'] },
    ],
    preflightRules: () => [
      { code: 'CONTRAST_FAIL', severity: 1, describe: 'Every text/background pair, computed.' },
      { code: 'TEXT_OVERFLOW', severity: 1, describe: 'Text measured against its container post-substitution.' },
      { code: 'STALE_CAPTURE', severity: 3, describe: 'A specimen older than 30 days at emit time.' },
    ],
    checkContrast: (brand) => ((brand && (brand.colors || []).some((c) => c.role === 'onAccent' && c.contrastWithPair !== null && c.contrastWithPair < 4.5))
      ? [{ id: 'fd_contrast', severity: 1, code: 'CONTRAST_FAIL', message: 'onAccent on accent measures 4.10:1.', locus: {}, autoFixAvailable: true }]
      : []),
    sceneOverflow: () => [],
    returnTargetFor: (deck, branchId) => ({ sequenceId: 'spine', sceneIndex: 0, scene: { id: 'sc_ui_0', headline: 'Headline for sc_ui_0' } }),
    verifyArtifact: (proof, html) => ({
      findings: [], network: [], provenance: [], clean: !String(html).includes('http'),
    }),
    async runPreflight() {
      if (!status.validate) return err('validate is not wired');
      return ok(options.findings || []);
    },
    autoFixes: (proof, findings) => (findings || [])
      .filter((f) => f.autoFixAvailable)
      .map((finding) => ({
        finding,
        label: `fix ${finding.code}`,
        effect: 'resolves',
        apply: (p) => ({ ...p, prospectName: `${p.prospectName} (fixed)` }),
      })),
    // L11's `applyAll`, threaded the same way the lane threads it (CRITIQUE-3
    // P11). A fix that cannot find its target hands back the proof it was
    // given, which is what makes the caller's digest comparison meaningful.
    applyAllFixes: (proof, fixes) => {
      if (!status.validate) return err('validate is not wired');
      let current = proof;
      for (const fix of fixes || []) current = fix.apply(current);
      return ok(current);
    },
    async dryRun(proof, onPosition) {
      const positions = [];
      for (const scene of proof.spine || []) {
        (scene.beats || []).forEach((_, beatIndex) => {
          const pos = { sequenceId: 'spine', sceneId: scene.id, beatIndex };
          positions.push(pos);
          if (onPosition) onPosition(pos);
        });
      }
      return ok({ positions: positions.length, findings: options.findings || [] });
    },
    severityOf: () => 2,

    async emit(proof) {
      record('emit', [proof.id]);
      if (!status.emit) return err('emit is not wired');
      return ok(options.emitResult || {
        html: '<!doctype html><html><body>emitted</body></html>',
        bytes: 42,
        findings: [],
        degradations: [],
        compression: { mode: 'deflate', modelBytes: 20, mediaBytes: 0 },
      });
    },
    budgetAssets: () => ({ plan: [], proof: null }),
  };
  return services;
}

/**
 * A finding shaped the way L11 produces them.
 * @param {object} args
 * @returns {any}
 */
export function finding({ id = 'fd_1', severity = 1, code = 'CONTRAST_FAIL', message = 'Body text is below 4.5:1.', locus = {}, autoFixAvailable = false }) {
  return { id, severity, code, message, locus, autoFixAvailable };
}
