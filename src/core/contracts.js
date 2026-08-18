/**
 * Runtime companions to the frozen TypeScript contracts in `contracts.d.ts`:
 * the closed enumerations, the role pairing table, the defaults, and a shape
 * validator. Nothing here may widen a frozen type.
 *
 * @module core/contracts
 */

/** @typedef {import('./contracts.d.ts').ColorRole} ColorRole */

/** Every ColorRole, in the order declared by the contract. @type {ColorRole[]} */
export const COLOR_ROLES = [
  'primary', 'onPrimary', 'secondary', 'onSecondary',
  'surface', 'onSurface', 'surfaceAlt', 'onSurfaceAlt',
  'accent', 'onAccent', 'border', 'success', 'warning', 'danger',
];

/**
 * The designated pairing for each role: the role its contrast is computed
 * against. `contrastWithPair` is null for roles with no designated pair.
 * @type {Record<ColorRole, ColorRole|null>}
 */
export const ROLE_PAIR = {
  primary: 'onPrimary',
  onPrimary: 'primary',
  secondary: 'onSecondary',
  onSecondary: 'secondary',
  surface: 'onSurface',
  onSurface: 'surface',
  surfaceAlt: 'onSurfaceAlt',
  onSurfaceAlt: 'surfaceAlt',
  accent: 'onAccent',
  onAccent: 'accent',
  border: 'surface',
  success: 'surface',
  warning: 'surface',
  danger: 'surface',
};

/** Foreground roles, each of which must reach 4.5:1 against its pair. @type {ColorRole[]} */
export const FOREGROUND_ROLES = ['onPrimary', 'onSecondary', 'onSurface', 'onSurfaceAlt', 'onAccent'];

/** Background roles that a foreground role sits on. @type {ColorRole[]} */
export const BACKGROUND_ROLES = ['primary', 'secondary', 'surface', 'surfaceAlt', 'accent'];

/** WCAG 2.1 AA normal-text minimum. */
export const CONTRAST_AA_BODY = 4.5;
/** WCAG 2.1 AA large-text minimum (>=24px, or >=18.66px bold). */
export const CONTRAST_AA_LARGE = 3.0;
/** WCAG 2.1 AA non-text (UI component / graphical object) minimum. */
export const CONTRAST_AA_NONTEXT = 3.0;

/** @type {import('./contracts.d.ts').SpecimenKind[]} */
export const SPECIMEN_KINDS = ['page', 'article', 'product', 'campaign', 'document', 'image', 'fragment'];

/** @type {import('./contracts.d.ts').SceneLayout[]} */
export const SCENE_LAYOUTS = [
  'splitBeforeAfter', 'fanOut', 'stack', 'fullBleed',
  'sideNote', 'systemMap', 'quoteCard', 'contentsIndex',
];

/** @type {import('./contracts.d.ts').Provenance[]} */
export const PROVENANCE_VALUES = ['client-supplied', 'illustrative', 'verified-by-user'];

/** Provenance values that require a visible, non-removable label in the artifact. */
export const PROVENANCE_REQUIRING_LABEL = ['illustrative'];

/** @type {import('./contracts.d.ts').ContentBlock['type'][]} */
export const BLOCK_TYPES = ['heading', 'paragraph', 'list', 'quote', 'table', 'cta', 'media', 'raw'];

/** @type {import('./contracts.d.ts').FindingCode[]} */
export const FINDING_CODES = [
  'ASSET_MISSING', 'ASSET_OVERSIZE', 'FONT_UNAVAILABLE', 'TEXT_OVERFLOW',
  'CONTRAST_FAIL', 'BRANCH_UNREACHABLE', 'BRANCH_NO_RETURN', 'BEAT_EMPTY',
  'PROVENANCE_UNLABELED', 'NETWORK_REFERENCE', 'STALE_CAPTURE',
  'SPECIMEN_EMPTY', 'DUPLICATE_SCENE', 'SIZE_BUDGET_EXCEEDED',
];

/**
 * Finding codes whose severity is fixed by the spec and may never be lowered.
 * §14: severity 1 findings block emit; there is no override flag.
 * @type {Record<string, 1|2|3>}
 */
export const FIXED_SEVERITY = {
  PROVENANCE_UNLABELED: 1,
  NETWORK_REFERENCE: 1,
  STALE_CAPTURE: 3,
};

/** Breakpoints every layout is measured at. Widths in CSS px. */
export const BREAKPOINTS = [
  { id: 'sm', width: 390, height: 844 },
  { id: 'md', width: 1024, height: 768 },
  { id: 'lg', width: 1600, height: 900 },
];

/** §10 motion budget. */
export const MAX_TRANSITION_MS = 240;

/** §13 default emit options. @returns {import('./contracts.d.ts').EmitOptions} */
export function defaultEmitOptions() {
  return {
    mode: 'both',
    includePresenterNotes: true,
    maxBytes: 25_000_000,
    imageQuality: 0.85,
    labelIllustrativeContent: true,
  };
}

/**
 * §9 provenance law: `labelIllustrativeContent` is true by default and cannot be
 * disabled for a build a recipient can open in Review mode. Normalisation is
 * applied at emit time, not only in the UI.
 * @param {import('./contracts.d.ts').EmitOptions} options
 * @returns {import('./contracts.d.ts').EmitOptions}
 */
export function normalizeEmitOptions(options) {
  const merged = { ...defaultEmitOptions(), ...(options || {}) };
  if (merged.mode === 'review' || merged.mode === 'both') merged.labelIllustrativeContent = true;
  if (!QUALITY_STEPS.includes(merged.imageQuality)) merged.imageQuality = 0.85;
  if (!(merged.maxBytes > 0)) merged.maxBytes = 25_000_000;
  if (merged.mode !== 'presenter' && merged.mode !== 'review' && merged.mode !== 'both') merged.mode = 'both';
  merged.includePresenterNotes = merged.includePresenterNotes !== false && merged.mode !== 'review';
  return merged;
}

/** The four legal image quality steps from EmitOptions. */
export const QUALITY_STEPS = [0.6, 0.75, 0.85, 0.92];

// ---------------------------------------------------------------------------
// Shape validation
// ---------------------------------------------------------------------------

const isStr = (v) => typeof v === 'string';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isArr = Array.isArray;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Validate a value against a frozen contract shape. Returns a list of human
 * readable paths that violate the contract; empty means valid.
 *
 * @param {unknown} proof
 * @returns {string[]}
 */
export function validateProofShape(proof) {
  /** @type {string[]} */
  const errs = [];
  const need = (cond, path, msg) => { if (!cond) errs.push(`${path}: ${msg}`); return cond; };

  if (!need(isObj(proof), 'proof', 'must be an object')) return errs;
  const p = /** @type {any} */ (proof);
  need(p.schemaVersion === 1, 'proof.schemaVersion', 'must be 1');
  need(isStr(p.id) && p.id.length > 0, 'proof.id', 'must be a non-empty string');
  need(isStr(p.prospectName), 'proof.prospectName', 'must be a string');
  need(isStr(p.createdAt), 'proof.createdAt', 'must be an ISO string');

  if (need(isObj(p.brand), 'proof.brand', 'must be an object')) validateBrand(p.brand, 'proof.brand', errs);

  if (need(isArr(p.specimens), 'proof.specimens', 'must be an array')) {
    p.specimens.forEach((s, i) => validateSpecimen(s, `proof.specimens[${i}]`, errs));
  }
  if (need(isArr(p.renditions), 'proof.renditions', 'must be an array')) {
    p.renditions.forEach((r, i) => validateRendition(r, `proof.renditions[${i}]`, errs));
  }
  if (need(isArr(p.recipes), 'proof.recipes', 'must be an array')) {
    p.recipes.forEach((r, i) => {
      const at = `proof.recipes[${i}]`;
      need(isStr(r?.id), `${at}.id`, 'must be a string');
      need(isStr(r?.name), `${at}.name`, 'must be a string');
      need(isStr(r?.intent), `${at}.intent`, 'must be a string');
      need(isArr(r?.inputKinds) && r.inputKinds.every((k) => SPECIMEN_KINDS.includes(k)), `${at}.inputKinds`, 'must be SpecimenKind[]');
      need(isArr(r?.outputLabels), `${at}.outputLabels`, 'must be string[]');
      need(r?.adapterPrompt === null || isStr(r?.adapterPrompt), `${at}.adapterPrompt`, 'must be string|null');
    });
  }
  if (need(isArr(p.spine), 'proof.spine', 'must be an array')) {
    p.spine.forEach((s, i) => validateScene(s, `proof.spine[${i}]`, errs));
  }
  if (need(isArr(p.branches), 'proof.branches', 'must be an array')) {
    p.branches.forEach((b, i) => {
      const at = `proof.branches[${i}]`;
      need(isStr(b?.id), `${at}.id`, 'must be a string');
      need(isStr(b?.objection), `${at}.objection`, 'must be a string');
      need(isArr(b?.aliases) && b.aliases.every(isStr), `${at}.aliases`, 'must be string[]');
      need(b?.returnPolicy === 'anchor' || b?.returnPolicy === 'nextSpineScene', `${at}.returnPolicy`, "must be 'anchor'|'nextSpineScene'");
      if (need(isArr(b?.scenes), `${at}.scenes`, 'must be an array')) {
        b.scenes.forEach((s, j) => validateScene(s, `${at}.scenes[${j}]`, errs));
      }
    });
  }
  if (need(isObj(p.emitOptions), 'proof.emitOptions', 'must be an object')) {
    const at = 'proof.emitOptions';
    const o = p.emitOptions;
    need(['presenter', 'review', 'both'].includes(o.mode), `${at}.mode`, "must be 'presenter'|'review'|'both'");
    need(typeof o.includePresenterNotes === 'boolean', `${at}.includePresenterNotes`, 'must be boolean');
    need(isNum(o.maxBytes) && o.maxBytes > 0, `${at}.maxBytes`, 'must be a positive number');
    need(QUALITY_STEPS.includes(o.imageQuality), `${at}.imageQuality`, 'must be one of 0.6|0.75|0.85|0.92');
    need(typeof o.labelIllustrativeContent === 'boolean', `${at}.labelIllustrativeContent`, 'must be boolean');
  }
  return errs;
}

/** @param {any} b @param {string} at @param {string[]} errs */
export function validateBrand(b, at, errs) {
  const need = (cond, path, msg) => { if (!cond) errs.push(`${path}: ${msg}`); return cond; };
  need(isStr(b.id), `${at}.id`, 'must be a string');
  need(b.sourceUrl === null || isStr(b.sourceUrl), `${at}.sourceUrl`, 'must be string|null');
  need(isStr(b.capturedAt), `${at}.capturedAt`, 'must be an ISO string');
  if (need(isArr(b.colors), `${at}.colors`, 'must be an array')) {
    b.colors.forEach((c, i) => {
      const ca = `${at}.colors[${i}]`;
      need(COLOR_ROLES.includes(c?.role), `${ca}.role`, 'must be a ColorRole');
      need(isStr(c?.hex) && /^#[0-9a-fA-F]{6}$/.test(c.hex), `${ca}.hex`, 'must be #RRGGBB');
      need(isArr(c?.oklch) && c.oklch.length === 3 && c.oklch.every(isNum), `${ca}.oklch`, 'must be [L,C,H]');
      need(['extracted', 'derived', 'manual'].includes(c?.source), `${ca}.source`, 'must be extracted|derived|manual');
      need(c?.contrastWithPair === null || isNum(c?.contrastWithPair), `${ca}.contrastWithPair`, 'must be number|null');
    });
  }
  if (need(isArr(b.faces), `${at}.faces`, 'must be an array')) {
    b.faces.forEach((f, i) => {
      const fa = `${at}.faces[${i}]`;
      need(isStr(f?.family), `${fa}.family`, 'must be a string');
      need(isArr(f?.fallbackStack) && f.fallbackStack.every(isStr), `${fa}.fallbackStack`, 'must be string[]');
      need(isArr(f?.weightsSeen) && f.weightsSeen.every(isNum), `${fa}.weightsSeen`, 'must be number[]');
      need(['display', 'body', 'mono'].includes(f?.role), `${fa}.role`, 'must be display|body|mono');
      need(f?.metricDelta === null || (isObj(f?.metricDelta) && isNum(f.metricDelta.capHeight) && isNum(f.metricDelta.xHeight) && isNum(f.metricDelta.avgAdvance)), `${fa}.metricDelta`, 'must be {capHeight,xHeight,avgAdvance}|null');
      need(typeof f?.embeddable === 'boolean', `${fa}.embeddable`, 'must be boolean');
    });
  }
  if (need(isArr(b.logos), `${at}.logos`, 'must be an array')) {
    b.logos.forEach((l, i) => {
      const la = `${at}.logos[${i}]`;
      need(isStr(l?.id), `${la}.id`, 'must be a string');
      need(l?.kind === 'svg' || l?.kind === 'raster', `${la}.kind`, "must be 'svg'|'raster'");
      need(isStr(l?.data), `${la}.data`, 'must be a string');
      need(['primary', 'mark', 'wordmark', 'inverse', 'favicon'].includes(l?.variant), `${la}.variant`, 'must be a logo variant');
      need(isObj(l?.intrinsic) && isNum(l.intrinsic.w) && isNum(l.intrinsic.h), `${la}.intrinsic`, 'must be {w,h}');
      need(typeof l?.hasTransparency === 'boolean', `${la}.hasTransparency`, 'must be boolean');
    });
  }
  need(isObj(b.shape) && isNum(b.shape.radiusPx) && isNum(b.shape.borderWidthPx) && [0, 1, 2, 3].includes(b.shape.shadowLevel), `${at}.shape`, 'must be {radiusPx,borderWidthPx,shadowLevel}');
  need(isObj(b.imagery) && ['photographic', 'illustrative', 'mixed', 'unknown'].includes(b.imagery.treatment) && isNum(b.imagery.saturationBias), `${at}.imagery`, 'must be {treatment,saturationBias}');
  if (need(isObj(b.confidence), `${at}.confidence`, 'must be an object')) {
    for (const k of ['colors', 'faces', 'logos', 'shape', 'imagery']) {
      need(isNum(b.confidence[k]) && b.confidence[k] >= 0 && b.confidence[k] <= 1, `${at}.confidence.${k}`, 'must be 0..1');
    }
  }
  need(isArr(b.manualOverrides) && b.manualOverrides.every(isStr), `${at}.manualOverrides`, 'must be string[]');
}

/** @param {any} s @param {string} at @param {string[]} errs */
export function validateSpecimen(s, at, errs) {
  const need = (cond, path, msg) => { if (!cond) errs.push(`${path}: ${msg}`); return cond; };
  need(isStr(s?.id), `${at}.id`, 'must be a string');
  need(SPECIMEN_KINDS.includes(s?.kind), `${at}.kind`, 'must be a SpecimenKind');
  need(isStr(s?.title), `${at}.title`, 'must be a string');
  need(s?.sourceUrl === null || isStr(s?.sourceUrl), `${at}.sourceUrl`, 'must be string|null');
  need(isStr(s?.capturedAt), `${at}.capturedAt`, 'must be an ISO string');
  if (need(isArr(s?.blocks), `${at}.blocks`, 'must be an array')) {
    s.blocks.forEach((b, i) => validateBlock(b, `${at}.blocks[${i}]`, errs));
  }
  if (need(isArr(s?.media), `${at}.media`, 'must be an array')) {
    s.media.forEach((m, i) => validateMedia(m, `${at}.media[${i}]`, errs));
  }
  need(isObj(s?.meta) && Object.values(s.meta).every(isStr), `${at}.meta`, 'must be Record<string,string>');
  need(isNum(s?.wordCount), `${at}.wordCount`, 'must be a number');
  need(s?.locale === null || isStr(s?.locale), `${at}.locale`, 'must be string|null');
}

/** @param {any} r @param {string} at @param {string[]} errs */
export function validateRendition(r, at, errs) {
  const need = (cond, path, msg) => { if (!cond) errs.push(`${path}: ${msg}`); return cond; };
  need(isStr(r?.id), `${at}.id`, 'must be a string');
  need(isStr(r?.specimenId), `${at}.specimenId`, 'must be a string');
  need(isStr(r?.recipeId), `${at}.recipeId`, 'must be a string');
  need(isStr(r?.label), `${at}.label`, 'must be a string');
  if (need(isArr(r?.blocks), `${at}.blocks`, 'must be an array')) {
    r.blocks.forEach((b, i) => validateBlock(b, `${at}.blocks[${i}]`, errs));
  }
  if (need(isArr(r?.media), `${at}.media`, 'must be an array')) {
    r.media.forEach((m, i) => validateMedia(m, `${at}.media[${i}]`, errs));
  }
  need(PROVENANCE_VALUES.includes(r?.provenance), `${at}.provenance`, 'must be a Provenance');
  need(['manual-paste', 'adapter', 'template'].includes(r?.producedBy), `${at}.producedBy`, 'must be manual-paste|adapter|template');
  need(r?.notes === null || isStr(r?.notes), `${at}.notes`, 'must be string|null');
}

/** @param {any} sc @param {string} at @param {string[]} errs */
export function validateScene(sc, at, errs) {
  const need = (cond, path, msg) => { if (!cond) errs.push(`${path}: ${msg}`); return cond; };
  need(isStr(sc?.id), `${at}.id`, 'must be a string');
  need(SCENE_LAYOUTS.includes(sc?.layout), `${at}.layout`, 'must be a SceneLayout');
  need(sc?.headline === null || isStr(sc?.headline), `${at}.headline`, 'must be string|null');
  need(sc?.subhead === null || isStr(sc?.subhead), `${at}.subhead`, 'must be string|null');
  need(sc?.specimenId === null || isStr(sc?.specimenId), `${at}.specimenId`, 'must be string|null');
  need(isArr(sc?.renditionIds) && sc.renditionIds.every(isStr), `${at}.renditionIds`, 'must be string[]');
  need(isArr(sc?.branchAnchors) && sc.branchAnchors.every(isStr), `${at}.branchAnchors`, 'must be string[]');
  if (need(isArr(sc?.beats), `${at}.beats`, 'must be an array')) {
    sc.beats.forEach((b, i) => {
      const ba = `${at}.beats[${i}]`;
      need(isStr(b?.id), `${ba}.id`, 'must be a string');
      need(isArr(b?.reveals) && b.reveals.every(isStr), `${ba}.reveals`, 'must be string[]');
      need(b?.presenterNote === null || isStr(b?.presenterNote), `${ba}.presenterNote`, 'must be string|null');
      need(b?.dwellHintMs === null || isNum(b?.dwellHintMs), `${ba}.dwellHintMs`, 'must be number|null');
    });
  }
}

/** @param {any} b @param {string} at @param {string[]} errs */
export function validateBlock(b, at, errs) {
  const need = (cond, path, msg) => { if (!cond) errs.push(`${path}: ${msg}`); return cond; };
  if (!need(isObj(b) && BLOCK_TYPES.includes(b.type), `${at}.type`, 'must be a ContentBlock type')) return;
  switch (b.type) {
    case 'heading':
      need([1, 2, 3, 4, 5, 6].includes(b.level), `${at}.level`, 'must be 1..6');
      need(isStr(b.text), `${at}.text`, 'must be a string');
      break;
    case 'paragraph': need(isStr(b.text), `${at}.text`, 'must be a string'); break;
    case 'list':
      need(typeof b.ordered === 'boolean', `${at}.ordered`, 'must be boolean');
      need(isArr(b.items) && b.items.every(isStr), `${at}.items`, 'must be string[]');
      break;
    case 'quote':
      need(isStr(b.text), `${at}.text`, 'must be a string');
      need(b.attribution === undefined || isStr(b.attribution), `${at}.attribution`, 'must be string|undefined');
      break;
    case 'table':
      need(isArr(b.rows) && b.rows.every((r) => isArr(r) && r.every(isStr)), `${at}.rows`, 'must be string[][]');
      need(typeof b.header === 'boolean', `${at}.header`, 'must be boolean');
      break;
    case 'cta':
      need(isStr(b.label), `${at}.label`, 'must be a string');
      need(b.href === null || isStr(b.href), `${at}.href`, 'must be string|null');
      break;
    case 'media':
      need(isStr(b.ref), `${at}.ref`, 'must be a string');
      need(b.caption === undefined || isStr(b.caption), `${at}.caption`, 'must be string|undefined');
      break;
    case 'raw': need(isStr(b.html), `${at}.html`, 'must be a string'); break;
    default: break;
  }
}

/** @param {any} m @param {string} at @param {string[]} errs */
export function validateMedia(m, at, errs) {
  const need = (cond, path, msg) => { if (!cond) errs.push(`${path}: ${msg}`); return cond; };
  need(isStr(m?.id), `${at}.id`, 'must be a string');
  need(isStr(m?.dataUri), `${at}.dataUri`, 'must be a string');
  need(m?.alt === null || isStr(m?.alt), `${at}.alt`, 'must be string|null');
  need(isObj(m?.intrinsic) && isNum(m.intrinsic.w) && isNum(m.intrinsic.h), `${at}.intrinsic`, 'must be {w,h}');
  need(isNum(m?.bytes), `${at}.bytes`, 'must be a number');
}

/**
 * Plain-text extraction from a ContentBlock, used by measurement, word counts
 * and the jump index. Never returns markup.
 * @param {import('./contracts.d.ts').ContentBlock} block
 * @returns {string[]} one string per rendered text run
 */
export function blockText(block) {
  switch (block.type) {
    case 'heading': case 'paragraph': return [block.text];
    case 'list': return block.items.slice();
    case 'quote': return block.attribution ? [block.text, block.attribution] : [block.text];
    case 'table': return block.rows.flat();
    case 'cta': return [block.label];
    case 'media': return block.caption ? [block.caption] : [];
    case 'raw': return [String(block.html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()].filter(Boolean);
    default: return [];
  }
}

/**
 * Word count over a block list, matching the definition used for
 * `Specimen.wordCount` and `SPECIMEN_EMPTY`.
 * @param {import('./contracts.d.ts').ContentBlock[]} blocks
 * @returns {number}
 */
export function countWords(blocks) {
  let n = 0;
  for (const b of blocks) for (const t of blockText(b)) {
    const m = t.trim(); if (m) n += m.split(/\s+/).length;
  }
  return n;
}
