/**
 * API conformance: every lane exports exactly what `API.md` declares.
 *
 * Ten lanes were written in parallel against a document. This is the test that
 * makes the document binding rather than aspirational: it walks the declared
 * surface for each lane and asserts the export exists and is the declared kind.
 *
 * A lane that has not landed yet is reported as pending rather than failing, so
 * this test is useful during the fan-out. `INTEGRATION_STRICT=1` flips pending
 * into failure — that is the switch integration throws once every lane is in,
 * and CI runs it that way.
 *
 * It deliberately does not check behaviour. Each lane's own suite does that.
 * What this catches is the failure mode parallel work actually produces: a lane
 * that built something good under a different name.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STRICT = process.env.INTEGRATION_STRICT === '1';

/**
 * The declared surface, transcribed from `API.md` Part 3. `fn` means a
 * function, `value` means any defined export, `class` means a constructor.
 * @type {{lane: string, module: string, exports: Record<string, 'fn'|'value'|'class'>}[]}
 */
const SURFACES = [
  {
    lane: 'L3 Ingest',
    module: 'src/ingest/index.js',
    exports: {
      parseHtml: 'fn', querySelectorAll: 'fn', textContent: 'fn', attr: 'fn',
      ingestUrl: 'fn', importSavedPage: 'fn', importHar: 'fn', importMhtml: 'fn',
      importHtmlText: 'fn', importOoxml: 'fn', importPdf: 'fn', importImage: 'fn',
      discoverSitemap: 'fn', rankCandidates: 'fn',
    },
  },
  {
    lane: 'L4 Brand colour',
    module: 'src/brand/color.js',
    exports: {
      srgbToLinear: 'fn', linearToSrgb: 'fn', hexToRgb: 'fn', rgbToHex: 'fn',
      rgbToOklab: 'fn', oklabToRgb: 'fn', oklabToOklch: 'fn', oklchToOklab: 'fn',
      hexToOklch: 'fn', oklchToHex: 'fn', relativeLuminance: 'fn', contrastRatio: 'fn',
      inGamut: 'fn', clampChromaToGamut: 'fn',
      quantize: 'fn', chooseK: 'fn', solveRoles: 'fn', deriveForContrast: 'fn', colorConfidence: 'fn',
    },
  },
  {
    lane: 'L5 Brand type/logo/shape',
    module: 'src/brand/theme.js',
    exports: {
      detectFaces: 'fn', extractLogos: 'fn', inverseVariant: 'fn',
      detectShape: 'fn', classifyImagery: 'fn', buildBrandSystem: 'fn', compileTheme: 'fn',
    },
  },
  {
    lane: 'L6 Specimen',
    module: 'src/specimen/index.js',
    exports: {
      stripChrome: 'fn', toBlocks: 'fn', captureMedia: 'fn',
      detectLocale: 'fn', buildSpecimen: 'fn', restoreBlock: 'fn',
    },
  },
  {
    lane: 'L7 Recipes',
    module: 'src/recipe/index.js',
    exports: {
      SEED_RECIPES: 'value', recipeById: 'fn', alignBlocks: 'fn', parsePasted: 'fn',
      buildRendition: 'fn', promoteProvenance: 'fn', channelBudget: 'fn',
      enforceBudget: 'fn', runAdapter: 'fn',
    },
  },
  {
    lane: 'L8 Scenes',
    module: 'src/scene/index.js',
    exports: {
      registerAllLayouts: 'fn', sceneTemplates: 'fn', buildScene: 'fn', measureScene: 'fn',
      PROVENANCE_LABEL_CLASS: 'value',
    },
  },
  {
    lane: 'L9 Branches',
    module: 'src/branch/index.js',
    exports: {
      buildJumpIndex: 'fn', searchJump: 'fn', registerBranchOverlays: 'fn',
      returnTargetFor: 'fn', branchCoverage: 'fn', randomWalk: 'fn',
    },
  },
  {
    lane: 'L10 Emitter',
    module: 'src/emit/index.js',
    exports: {
      emit: 'fn', scanForNetworkReferences: 'fn', assertProvenance: 'fn',
      budgetAssets: 'fn', inlineRuntime: 'fn',
    },
  },
  {
    lane: 'L11 Validate',
    module: 'src/validate/index.js',
    exports: {
      runPreflight: 'fn', RULES: 'value', detectOverflow: 'fn', checkContrast: 'fn',
      autoFixes: 'fn', dryRun: 'fn', severityOf: 'fn',
    },
  },
  {
    lane: 'L12 Studio UI',
    module: 'src/ui/index.js',
    exports: { mountStudio: 'fn' },
  },
];

/** L1 and L2 are already landed and frozen; drift here breaks every lane. */
const FROZEN_SURFACES = [
  {
    lane: 'L1 Core',
    module: 'src/core/contracts.js',
    exports: {
      COLOR_ROLES: 'value', ROLE_PAIR: 'value', FOREGROUND_ROLES: 'value', BACKGROUND_ROLES: 'value',
      CONTRAST_AA_BODY: 'value', CONTRAST_AA_LARGE: 'value', CONTRAST_AA_NONTEXT: 'value',
      SPECIMEN_KINDS: 'value', SCENE_LAYOUTS: 'value', PROVENANCE_VALUES: 'value',
      PROVENANCE_REQUIRING_LABEL: 'value', BLOCK_TYPES: 'value', FINDING_CODES: 'value',
      FIXED_SEVERITY: 'value', BREAKPOINTS: 'value', MAX_TRANSITION_MS: 'value', QUALITY_STEPS: 'value',
      defaultEmitOptions: 'fn', normalizeEmitOptions: 'fn', validateProofShape: 'fn',
      validateBrand: 'fn', validateSpecimen: 'fn', validateRendition: 'fn',
      validateScene: 'fn', validateBlock: 'fn', validateMedia: 'fn',
      blockText: 'fn', countWords: 'fn',
    },
  },
  {
    lane: 'L1 Core',
    module: 'src/core/text-metrics.js',
    exports: {
      UNITS_PER_EM: 'value', AFM_TABLES: 'value', FAMILY_MODELS: 'value',
      FALLBACK_CANDIDATES: 'value', AVG_ADVANCE_CORPUS: 'value',
      normalizeFamily: 'fn', parseFamilyList: 'fn', lookupFamily: 'fn', guessCategory: 'fn',
      metricsFor: 'fn', advanceOfCodepoint: 'fn', advanceOfString: 'fn', isWideCodepoint: 'fn',
      applyTransform: 'fn', segments: 'fn', measureText: 'fn', layoutText: 'fn',
      capHeightPx: 'fn', xHeightPx: 'fn', metricDelta: 'fn', metricDistance: 'fn',
      resolveFace: 'fn', cssFontFamily: 'fn',
    },
  },
  {
    lane: 'L1 Core',
    module: 'src/core/storage.js',
    exports: {
      SCHEMA_VERSION: 'value', DB_NAME: 'value', STORE_PROJECTS: 'value', STORE_META: 'value',
      PRESSURE_WARN_RATIO: 'value', MIGRATIONS: 'value',
      migrateRecord: 'fn', makeRecord: 'fn', MemoryBackend: 'class', IndexedDbBackend: 'class',
      selectBackend: 'fn', ProjectStore: 'class', exportProjectJson: 'fn', importProjectJson: 'fn',
    },
  },
  {
    lane: 'L1 Core',
    module: 'src/core/command.js',
    exports: { CommandStack: 'class', replaceCommand: 'fn', editCommand: 'fn' },
  },
  {
    lane: 'L1 Core',
    module: 'src/core/zip.js',
    exports: {
      ZipArchive: 'class', readCentralDirectory: 'fn', readEntry: 'fn', crc32: 'fn',
      ooxmlKind: 'fn', readRelationships: 'fn', resolvePart: 'fn',
      parseXmlAttrs: 'fn', decodeXmlEntities: 'fn', xmlText: 'fn', mimeForPart: 'fn',
    },
  },
  {
    lane: 'L2 Runtime',
    module: 'src/runtime/index.js',
    exports: {
      buildDeck: 'fn', SPINE: 'value', sequenceOf: 'fn', sceneAt: 'fn',
      branchesFrom: 'fn', allBranches: 'fn', beatCount: 'fn',
      initialState: 'fn', navigate: 'fn', checkInvariants: 'fn', NavInvariantError: 'class',
      beatsOf: 'fn', offSpine: 'fn', currentScene: 'fn', peekNext: 'fn',
      stateHash: 'fn', allPositions: 'fn',
      revealedAt: 'fn', newlyRevealedAt: 'fn', sceneRevealsNothing: 'fn', visibilityOf: 'fn',
      scrollTargetFor: 'fn', beatFrame: 'fn', beatSignature: 'fn', transitionMs: 'fn',
      dwellHintLabel: 'fn', REVEAL_ATTR: 'value', REVEALED_CLASS: 'value',
      ENTERING_CLASS: 'value', EXIT_TRANSITION_MS: 'value',
      BINDINGS: 'value', resolveKey: 'fn', bindingGroups: 'fn', keyLabel: 'fn', allCommands: 'fn',
      OverlayStack: 'class', OVERLAY: 'value', trapFocus: 'fn', focusableWithin: 'fn',
      FOCUSABLE_SELECTOR: 'value',
      registerLayout: 'fn', getLayout: 'fn', registeredLayouts: 'fn', missingLayouts: 'fn',
      resetLayouts: 'fn', renderLayout: 'fn', placeholderLayout: 'fn',
      Runtime: 'class', applyBeat: 'fn', renderHelpOverlay: 'fn',
      RuntimeHost: 'class', STAGE_ROOT_ID: 'value', PRERENDERED_ATTR: 'value',
      isTextEntry: 'fn', cssEscape: 'fn', firstPaintTree: 'fn', renderToNode: 'fn',
      ManualTimer: 'class', renderPresenterView: 'fn', openPresenterWindow: 'fn',
      PRESENTER_CSS: 'value', PRESENTER_WINDOW_NAME: 'value',
      boot: 'fn', RUNTIME_VERSION: 'value',
    },
  },
];

/**
 * @param {unknown} value
 * @param {'fn'|'value'|'class'} kind
 * @returns {string|null} the failure reason, or null
 */
function kindMismatch(value, kind) {
  if (value === undefined) return 'is not exported';
  if (kind === 'fn' && typeof value !== 'function') return `should be a function, got ${typeof value}`;
  if (kind === 'class') {
    if (typeof value !== 'function') return `should be a class, got ${typeof value}`;
    if (!value.prototype) return 'should be a constructor';
  }
  return null;
}

/** @param {{lane: string, module: string, exports: Record<string, string>}} surface */
async function checkSurface(surface) {
  const path = join(ROOT, surface.module);
  if (!existsSync(path)) return { pending: true, missing: [] };
  const mod = await import(path);
  const missing = [];
  for (const [name, kind] of Object.entries(surface.exports)) {
    const why = kindMismatch(mod[name], /** @type {any} */ (kind));
    if (why) missing.push(`${name} ${why}`);
  }
  return { pending: false, missing };
}

for (const surface of FROZEN_SURFACES) {
  test(`${surface.lane}: ${surface.module} matches API.md (frozen)`, async () => {
    const { pending, missing } = await checkSurface(surface);
    assert.equal(pending, false, `${surface.module} is missing — the frozen core cannot be absent`);
    assert.deepEqual(missing, [], `${surface.module} drifted from API.md:\n  ${missing.join('\n  ')}`);
  });
}

for (const surface of SURFACES) {
  test(`${surface.lane}: ${surface.module} matches API.md`, async (t) => {
    const { pending, missing } = await checkSurface(surface);
    if (pending) {
      if (STRICT) assert.fail(`${surface.module} has not landed (INTEGRATION_STRICT=1)`);
      return t.skip(`${surface.module} has not landed yet`);
    }
    assert.deepEqual(missing, [], `${surface.module} drifted from API.md:\n  ${missing.join('\n  ')}`);
  });
}

test('every lane directory that exists has an index module', async (t) => {
  const lanes = ['ingest', 'brand', 'specimen', 'recipe', 'scene', 'branch', 'emit', 'validate', 'ui'];
  const orphans = lanes.filter((lane) => {
    const dir = join(ROOT, 'src', lane);
    if (!existsSync(dir)) return false;
    // `brand` is split between two lanes and publishes `color.js` and `theme.js`
    // rather than an index; every other lane publishes `index.js`.
    if (lane === 'brand') return !existsSync(join(dir, 'color.js')) || !existsSync(join(dir, 'theme.js'));
    return !existsSync(join(dir, 'index.js'));
  });
  if (orphans.length && !STRICT) return t.skip(`still in flight: ${orphans.join(', ')}`);
  assert.deepEqual(orphans, [], `lane directories with no published surface: ${orphans.join(', ')}`);
});

test('no lane reaches into another lane past its published surface', async (t) => {
  const { readdirSync, statSync, readFileSync } = await import('node:fs');
  /** @param {string} dir @param {string[]} out */
  const walk = (dir, out = []) => {
    if (!existsSync(dir)) return out;
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (name.endsWith('.js')) out.push(p);
    }
    return out;
  };

  // Which module paths a lane may import from another lane. `core` and
  // `runtime` are shared infrastructure; everything else is index-only.
  const published = {
    ingest: ['index.js'],
    brand: ['color.js', 'theme.js'],
    specimen: ['index.js'],
    recipe: ['index.js'],
    scene: ['index.js'],
    branch: ['index.js'],
    emit: ['index.js'],
    validate: ['index.js'],
    ui: ['index.js'],
  };

  /** @type {string[]} */
  const violations = [];
  for (const lane of Object.keys(published)) {
    for (const file of walk(join(ROOT, 'src', lane))) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/from\s+['"](\.\.\/([a-z-]+)\/[^'"]+)['"]/g)) {
        const [, spec, target] = m;
        if (target === lane || target === 'core' || target === 'runtime') continue;
        if (!published[target]) continue;
        const tail = spec.split('/').slice(2).join('/');
        if (!published[target].includes(tail)) {
          violations.push(`${file.slice(ROOT.length + 1)} imports ${spec} — ${target} publishes only ${published[target].join(', ')}`);
        }
      }
    }
  }
  if (violations.length && !STRICT) {
    return t.skip(`cross-lane imports to reconcile at integration:\n  ${violations.join('\n  ')}`);
  }
  assert.deepEqual(violations, [], violations.join('\n'));
});
