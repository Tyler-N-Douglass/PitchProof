/**
 * Every mutation the studio can perform, as a pure function.
 *
 * §15 makes undo/redo a requirement rather than a feature, and the way to make
 * that true rather than mostly-true is to have exactly one shape of writer:
 * a pure `(doc) => doc` that never touches the old value. The command stack
 * (`core/command.js`) then holds the before and after directly, so undo is exact
 * — `test/ui/undo-redo.test.mjs` deep-equals the restored proof against the
 * original for every mutating action in the registry.
 *
 * The editable document is the proof *plus* the two things the proof does not
 * carry but the user still edits: the project's display name and its PRNG seed.
 * Both belong on the undo stack for the same reason the proof does — renaming a
 * project the day before a pitch and being unable to take it back is the same
 * class of defect as deleting a scene and being unable to take it back.
 *
 * Nothing here reads a clock or a random source. Timestamps arrive as `at`
 * arguments; ids are content-derived and de-duplicated against what already
 * exists, so adding the same object to the same document twice in a row still
 * produces two distinct, reproducible ids.
 *
 * @module ui/model
 */

import { contentId, elementId } from '../core/ids.js';
import { defaultEmitOptions, normalizeEmitOptions, SCENE_LAYOUTS, COLOR_ROLES, ROLE_PAIR } from '../core/contracts.js';

/**
 * @typedef {import('../core/contracts.d.ts').Proof} Proof
 * @typedef {import('../core/contracts.d.ts').Scene} Scene
 * @typedef {import('../core/contracts.d.ts').Branch} Branch
 * @typedef {import('../core/contracts.d.ts').Specimen} Specimen
 * @typedef {import('../core/contracts.d.ts').Rendition} Rendition
 * @typedef {import('../core/contracts.d.ts').BrandSystem} BrandSystem
 * @typedef {import('../core/contracts.d.ts').ContentBlock} ContentBlock
 */

/**
 * @typedef {object} Doc
 * @property {string} id        project id (pj_*)
 * @property {string} name      display name, shown in the project list
 * @property {string} seed      the project's PRNG seed (§5)
 * @property {Proof} proof
 */


/** The brand groups §7 attaches a confidence to, and therefore a review gate. */
export const BRAND_GROUPS = ['colors', 'faces', 'logos', 'shape', 'imagery'];

/** Below this confidence, §7 requires the studio to hold the field for review. */
export const LOW_CONFIDENCE = 0.7;

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/**
 * A content-derived id that is unique within a set. Deterministic: the same
 * document plus the same salt always yields the same id, and adding a second
 * object with the same salt walks to the next free one rather than colliding.
 * @param {keyof typeof import('../core/ids.js').ID_PREFIX} kind
 * @param {string} seed
 * @param {Set<string>} taken
 * @param {unknown} salt
 * @returns {string}
 */
export function mintId(kind, seed, taken, salt) {
  for (let i = 0; i < 100000; i++) {
    const id = contentId(kind, { seed, salt, i });
    if (!taken.has(id)) return id;
  }
  throw new Error(`ui/model: could not mint a free ${String(kind)} id`);
}

/** @param {Proof} proof @returns {Set<string>} every id the proof already uses */
export function usedIds(proof) {
  const out = new Set([proof.id]);
  const addScene = (s) => { out.add(s.id); for (const b of s.beats || []) out.add(b.id); };
  for (const s of proof.spine || []) addScene(s);
  for (const b of proof.branches || []) { out.add(b.id); for (const s of b.scenes || []) addScene(s); }
  for (const s of proof.specimens || []) { out.add(s.id); for (const m of s.media || []) out.add(m.id); }
  for (const r of proof.renditions || []) { out.add(r.id); for (const m of r.media || []) out.add(m.id); }
  for (const r of proof.recipes || []) out.add(r.id);
  if (proof.brand) { out.add(proof.brand.id); for (const l of proof.brand.logos || []) out.add(l.id); }
  return out;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * A brand system with nothing extracted yet: the roles a proof needs, at zero
 * confidence, so the §7 review gate starts closed rather than open.
 * @param {string} seed
 * @param {string} at   ISO
 * @returns {BrandSystem}
 */
export function emptyBrand(seed, at) {
  return {
    id: contentId('brand', { seed, at }),
    sourceUrl: null,
    capturedAt: at,
    colors: [
      { role: 'surface', hex: '#FFFFFF', oklch: [1, 0, 0], source: 'manual', contrastWithPair: 21 },
      { role: 'onSurface', hex: '#111318', oklch: [0.2, 0.01, 260], source: 'manual', contrastWithPair: 21 },
      { role: 'primary', hex: '#1F3A93', oklch: [0.38, 0.15, 264], source: 'manual', contrastWithPair: 11.1 },
      { role: 'onPrimary', hex: '#FFFFFF', oklch: [1, 0, 0], source: 'manual', contrastWithPair: 11.1 },
    ],
    faces: [
      {
        family: 'system-ui', fallbackStack: ['system-ui', 'Arial', 'sans-serif'], weightsSeen: [400, 700],
        role: 'body', metricDelta: null, embeddable: false,
      },
    ],
    logos: [],
    shape: { radiusPx: 8, borderWidthPx: 1, shadowLevel: 1 },
    imagery: { treatment: 'unknown', saturationBias: 0 },
    confidence: { colors: 0, faces: 0, logos: 0, shape: 0, imagery: 0 },
    manualOverrides: [],
  };
}

/**
 * A brand-new project.
 * @param {object} args
 * @param {string} args.seed
 * @param {string} args.at            ISO, from the injected clock
 * @param {string} [args.name]
 * @param {string} [args.prospectName]
 * @returns {Doc}
 */
export function newDoc({ seed, at, name = 'Untitled proof', prospectName = '' }) {
  const proof = {
    schemaVersion: /** @type {1} */ (1),
    id: contentId('proof', { seed, at }),
    prospectName,
    createdAt: at,
    brand: emptyBrand(seed, at),
    specimens: [],
    renditions: [],
    recipes: [],
    spine: [],
    branches: [],
    emitOptions: defaultEmitOptions(),
  };
  return { id: contentId('project', { seed, at }), name, seed, proof };
}

/**
 * A scene with one empty beat, ready to be filled in. Layouts that stage
 * nothing (`quoteCard`, `contentsIndex`) still get a beat, because §14 raises
 * `BEAT_EMPTY` on a scene with none.
 * @param {object} args
 * @param {string} args.id
 * @param {import('../core/contracts.d.ts').SceneLayout} args.layout
 * @param {string|null} [args.headline]
 * @param {string|null} [args.subhead]
 * @returns {Scene}
 */
export function newScene({ id, layout, headline = null, subhead = null }) {
  return {
    id,
    layout,
    headline,
    subhead,
    specimenId: null,
    renditionIds: [],
    beats: [{ id: `${id}_b0`, reveals: [], presenterNote: null, dwellHintMs: null }],
    branchAnchors: [],
  };
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/**
 * Every scene in the proof with where it lives.
 * @param {Proof} proof
 * @returns {{scene: Scene, sequence: 'spine'|'branch', branchId: string|null, index: number}[]}
 */
export function allScenes(proof) {
  const out = [];
  (proof.spine || []).forEach((scene, index) => out.push({ scene, sequence: 'spine', branchId: null, index }));
  for (const branch of proof.branches || []) {
    (branch.scenes || []).forEach((scene, index) => out.push({ scene, sequence: 'branch', branchId: branch.id, index }));
  }
  return out;
}

/**
 * @param {Proof} proof
 * @param {string} sceneId
 * @returns {{scene: Scene, sequence: 'spine'|'branch', branchId: string|null, index: number}|null}
 */
export function findScene(proof, sceneId) {
  return allScenes(proof).find((e) => e.scene.id === sceneId) || null;
}

/** @param {Proof} proof @param {string} id @returns {Specimen|null} */
export function findSpecimen(proof, id) { return (proof.specimens || []).find((s) => s.id === id) || null; }
/** @param {Proof} proof @param {string} id @returns {Rendition|null} */
export function findRendition(proof, id) { return (proof.renditions || []).find((r) => r.id === id) || null; }
/** @param {Proof} proof @param {string} id @returns {Branch|null} */
export function findBranch(proof, id) { return (proof.branches || []).find((b) => b.id === id) || null; }

/**
 * The brand groups §7 will not let an emit use until the user has reviewed
 * them: confidence below the floor and not yet reviewed.
 * @param {BrandSystem} brand
 * @returns {{group: string, confidence: number}[]}
 */
export function unreviewedBrandGroups(brand) {
  if (!brand) return [];
  const reviewed = new Set(reviewedGroups(brand));
  return BRAND_GROUPS
    .filter((g) => !reviewed.has(g))
    .map((g) => ({ group: g, confidence: Number(brand.confidence?.[g] ?? 0) }))
    .filter((e) => e.confidence < LOW_CONFIDENCE);
}

/**
 * Which brand groups the user has signed off. Stored as an optional extension
 * field, which §4 permits ("lanes may extend with optional fields only"), so
 * the review state travels with the project export and survives a reload.
 * @param {BrandSystem} brand
 * @returns {string[]}
 */
export function reviewedGroups(brand) {
  const raw = /** @type {any} */ (brand || {}).reviewedGroups;
  return Array.isArray(raw) ? raw.filter((s) => typeof s === 'string') : [];
}

// ---------------------------------------------------------------------------
// Generic updaters
// ---------------------------------------------------------------------------

/** @param {Doc} doc @param {(p: Proof) => Proof} fn @returns {Doc} */
export function withProof(doc, fn) {
  return { ...doc, proof: fn(doc.proof) };
}

/**
 * Replace a scene wherever it lives.
 * @param {Proof} proof
 * @param {string} sceneId
 * @param {(s: Scene) => Scene} fn
 * @returns {Proof}
 */
export function updateScene(proof, sceneId, fn) {
  let touched = false;
  const spine = (proof.spine || []).map((s) => (s.id === sceneId ? (touched = true, fn(s)) : s));
  const branches = (proof.branches || []).map((b) => ({
    ...b,
    scenes: (b.scenes || []).map((s) => (s.id === sceneId ? (touched = true, fn(s)) : s)),
  }));
  return touched ? { ...proof, spine, branches } : proof;
}

/**
 * @param {Proof} proof
 * @param {string} branchId
 * @param {(b: Branch) => Branch} fn
 * @returns {Proof}
 */
export function updateBranch(proof, branchId, fn) {
  return { ...proof, branches: (proof.branches || []).map((b) => (b.id === branchId ? fn(b) : b)) };
}

/**
 * @param {Proof} proof
 * @param {string} specimenId
 * @param {(s: Specimen) => Specimen} fn
 * @returns {Proof}
 */
export function updateSpecimen(proof, specimenId, fn) {
  return { ...proof, specimens: (proof.specimens || []).map((s) => (s.id === specimenId ? fn(s) : s)) };
}

/**
 * @param {Proof} proof
 * @param {string} renditionId
 * @param {(r: Rendition) => Rendition} fn
 * @returns {Proof}
 */
export function updateRendition(proof, renditionId, fn) {
  return { ...proof, renditions: (proof.renditions || []).map((r) => (r.id === renditionId ? fn(r) : r)) };
}

/**
 * Move an item within an array, clamped. Returns the same array when nothing
 * moves, so a no-op reorder does not land on the undo stack as a change.
 * @template T
 * @param {T[]} list
 * @param {number} from
 * @param {number} to
 * @returns {T[]}
 */
export function moveItem(list, from, to) {
  if (from < 0 || from >= list.length) return list;
  const target = Math.max(0, Math.min(list.length - 1, to));
  if (target === from) return list;
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(target, 0, item);
  return next;
}

// ---------------------------------------------------------------------------
// Project-level mutations
// ---------------------------------------------------------------------------

/** @param {Doc} doc @param {string} name @returns {Doc} */
export function setProjectName(doc, name) { return { ...doc, name: String(name) }; }

/** @param {Doc} doc @param {string} prospectName @returns {Doc} */
export function setProspectName(doc, prospectName) {
  return withProof(doc, (p) => ({ ...p, prospectName: String(prospectName) }));
}

/**
 * Change the project seed. Existing ids keep their values — re-deriving them
 * would break every `Beat.reveals` entry pointing at an element id — so the
 * seed governs ids minted from here on.
 * @param {Doc} doc
 * @param {string} seed
 * @returns {Doc}
 */
export function setSeed(doc, seed) { return { ...doc, seed: String(seed) }; }

/**
 * @param {Doc} doc
 * @param {Partial<import('../core/contracts.d.ts').EmitOptions>} patch
 * @returns {Doc}
 */
export function setEmitOptions(doc, patch) {
  return withProof(doc, (p) => ({ ...p, emitOptions: normalizeEmitOptions({ ...p.emitOptions, ...patch }) }));
}

// ---------------------------------------------------------------------------
// Brand mutations
// ---------------------------------------------------------------------------

/**
 * Record that the user edited a brand field, per §7's `manualOverrides`.
 * @param {BrandSystem} brand
 * @param {string} path
 * @returns {BrandSystem}
 */
export function recordOverride(brand, path) {
  const existing = brand.manualOverrides || [];
  return existing.includes(path) ? brand : { ...brand, manualOverrides: [...existing, path] };
}

/** @param {Doc} doc @param {(b: BrandSystem) => BrandSystem} fn @returns {Doc} */
export function withBrand(doc, fn) { return withProof(doc, (p) => ({ ...p, brand: fn(p.brand) })); }

/**
 * Set a colour role's hex. Recomputes nothing: the contrast against the pair is
 * supplied by the caller from `brand/color.js`, because §7 says contrast is
 * "computed, never assumed" and this module owns no colour science.
 * @param {Doc} doc
 * @param {string} role
 * @param {string} hex
 * @param {{oklch?: [number,number,number], contrastWithPair?: number|null}} [computed]
 * @returns {Doc}
 */
export function setBrandColor(doc, role, hex, computed = {}) {
  return withBrand(doc, (brand) => {
    const colors = (brand.colors || []).slice();
    const i = colors.findIndex((c) => c.role === role);
    const next = {
      role: /** @type {any} */ (role),
      hex,
      oklch: computed.oklch || (i >= 0 ? colors[i].oklch : [0, 0, 0]),
      source: /** @type {'manual'} */ ('manual'),
      contrastWithPair: computed.contrastWithPair !== undefined
        ? computed.contrastWithPair
        : (i >= 0 ? colors[i].contrastWithPair : null),
    };
    if (i >= 0) colors[i] = next; else colors.push(next);
    colors.sort((a, b) => COLOR_ROLES.indexOf(a.role) - COLOR_ROLES.indexOf(b.role));
    return recordOverride({ ...brand, colors }, `brand.colors.${role}`);
  });
}

/** @param {Doc} doc @param {string} role @returns {Doc} */
export function removeBrandColor(doc, role) {
  return withBrand(doc, (brand) => recordOverride(
    { ...brand, colors: (brand.colors || []).filter((c) => c.role !== role) },
    `brand.colors.${role}`,
  ));
}

/**
 * @param {Doc} doc
 * @param {number} index
 * @param {Partial<import('../core/contracts.d.ts').TypeFace>} patch
 * @returns {Doc}
 */
export function setBrandFace(doc, index, patch) {
  return withBrand(doc, (brand) => {
    const faces = (brand.faces || []).slice();
    if (index < 0 || index >= faces.length) return brand;
    faces[index] = { ...faces[index], ...patch };
    return recordOverride({ ...brand, faces }, `brand.faces[${index}]`);
  });
}

/** @param {Doc} doc @param {import('../core/contracts.d.ts').TypeFace} face @returns {Doc} */
export function addBrandFace(doc, face) {
  return withBrand(doc, (brand) => recordOverride(
    { ...brand, faces: [...(brand.faces || []), face] },
    `brand.faces[${(brand.faces || []).length}]`,
  ));
}

/** @param {Doc} doc @param {number} index @returns {Doc} */
export function removeBrandFace(doc, index) {
  return withBrand(doc, (brand) => recordOverride(
    { ...brand, faces: (brand.faces || []).filter((_, i) => i !== index) },
    `brand.faces[${index}]`,
  ));
}

/** @param {Doc} doc @param {Partial<BrandSystem['shape']>} patch @returns {Doc} */
export function setBrandShape(doc, patch) {
  return withBrand(doc, (brand) => recordOverride({ ...brand, shape: { ...brand.shape, ...patch } }, 'brand.shape'));
}

/** @param {Doc} doc @param {Partial<BrandSystem['imagery']>} patch @returns {Doc} */
export function setBrandImagery(doc, patch) {
  return withBrand(doc, (brand) => recordOverride({ ...brand, imagery: { ...brand.imagery, ...patch } }, 'brand.imagery'));
}

/** @param {Doc} doc @param {string|null} url @returns {Doc} */
export function setBrandSourceUrl(doc, url) {
  return withBrand(doc, (brand) => recordOverride({ ...brand, sourceUrl: url || null }, 'brand.sourceUrl'));
}

/** @param {Doc} doc @param {import('../core/contracts.d.ts').LogoAsset} logo @returns {Doc} */
export function addLogo(doc, logo) {
  return withBrand(doc, (brand) => ({ ...brand, logos: [...(brand.logos || []), logo] }));
}

/** @param {Doc} doc @param {string} logoId @returns {Doc} */
export function removeLogo(doc, logoId) {
  return withBrand(doc, (brand) => recordOverride(
    { ...brand, logos: (brand.logos || []).filter((l) => l.id !== logoId) },
    `brand.logos.${logoId}`,
  ));
}

/** @param {Doc} doc @param {string} logoId @param {string} variant @returns {Doc} */
export function setLogoVariant(doc, logoId, variant) {
  return withBrand(doc, (brand) => recordOverride({
    ...brand,
    logos: (brand.logos || []).map((l) => (l.id === logoId ? { ...l, variant: /** @type {any} */ (variant) } : l)),
  }, `brand.logos.${logoId}.variant`));
}

/**
 * Mark a low-confidence brand group as reviewed, which is what releases §7's
 * hold on the emit. Reviewing is not editing, so it does not touch
 * `manualOverrides`; it is recorded separately and shown separately.
 * @param {Doc} doc
 * @param {string} group
 * @param {boolean} reviewed
 * @returns {Doc}
 */
export function setBrandReviewed(doc, group, reviewed) {
  return withBrand(doc, (brand) => {
    const current = new Set(reviewedGroups(brand));
    if (reviewed) current.add(group); else current.delete(group);
    return { ...brand, reviewedGroups: BRAND_GROUPS.filter((g) => current.has(g)) };
  });
}

/** @param {Doc} doc @param {BrandSystem} brand @returns {Doc} */
export function replaceBrand(doc, brand) { return withProof(doc, (p) => ({ ...p, brand })); }

// ---------------------------------------------------------------------------
// Specimen mutations
// ---------------------------------------------------------------------------

/** @param {Doc} doc @param {Specimen} specimen @returns {Doc} */
export function addSpecimen(doc, specimen) {
  return withProof(doc, (p) => ({ ...p, specimens: [...(p.specimens || []), specimen] }));
}

/**
 * Remove a specimen and every reference to it. A scene pointing at a deleted
 * specimen would raise `SPECIMEN_EMPTY` at rehearsal, so the delete cleans up
 * rather than leaving a dangling id for validation to find later.
 * @param {Doc} doc
 * @param {string} specimenId
 * @returns {Doc}
 */
export function removeSpecimen(doc, specimenId) {
  return withProof(doc, (p) => {
    const renditions = (p.renditions || []).filter((r) => r.specimenId !== specimenId);
    const keptRenditions = new Set(renditions.map((r) => r.id));
    const fix = (s) => ({
      ...s,
      specimenId: s.specimenId === specimenId ? null : s.specimenId,
      renditionIds: (s.renditionIds || []).filter((id) => keptRenditions.has(id)),
    });
    return {
      ...p,
      specimens: (p.specimens || []).filter((s) => s.id !== specimenId),
      renditions,
      spine: (p.spine || []).map(fix),
      branches: (p.branches || []).map((b) => ({ ...b, scenes: (b.scenes || []).map(fix) })),
    };
  });
}

/** @param {Doc} doc @param {string} id @param {string} title @returns {Doc} */
export function setSpecimenTitle(doc, id, title) {
  return withProof(doc, (p) => updateSpecimen(p, id, (s) => ({ ...s, title: String(title) })));
}

/** @param {Doc} doc @param {string} id @param {string} kind @returns {Doc} */
export function setSpecimenKind(doc, id, kind) {
  return withProof(doc, (p) => updateSpecimen(p, id, (s) => ({ ...s, kind: /** @type {any} */ (kind) })));
}

/**
 * Put a whole specimen back, which is how every L6-owned operation lands: the
 * lane produces the new specimen (restore a stripped block, record an edit, set
 * the raw opt-in) and the studio commits it through the command stack.
 * @param {Doc} doc
 * @param {Specimen} specimen
 * @returns {Doc}
 */
export function replaceSpecimen(doc, specimen) {
  return withProof(doc, (p) => updateSpecimen(p, specimen.id, () => specimen));
}

/**
 * The blocks a capture stripped as chrome. L6 keeps them on the specimen with
 * the reason and the score that removed them, which is what §8's "every
 * stripped block restorable" needs in order to survive a save and a reload.
 * @param {any} specimen
 * @returns {{id?: string, reason: string, score: number, text?: string, blocks?: ContentBlock[]}[]}
 */
export function strippedBlocks(specimen) {
  const list = /** @type {any} */ (specimen || {}).stripped;
  return Array.isArray(list) ? list : [];
}

/**
 * Has this specimen been edited by hand? §18.3 requires the artifact to say so.
 * @param {any} specimen
 * @returns {boolean}
 */
export function specimenIsEdited(specimen) { return !!(/** @type {any} */ (specimen || {}).edited); }

/**
 * The per-specimen raw-HTML opt-in (§8), never assumed.
 * @param {any} specimen
 * @returns {{allowed: boolean, by: string|null, at: string|null}}
 */
export function rawOptIn(specimen) {
  const value = /** @type {any} */ (specimen || {}).rawOptIn;
  return value && typeof value === 'object'
    ? { allowed: !!value.allowed, by: value.by || null, at: value.at || null }
    : { allowed: false, by: null, at: null };
}

/**
 * Delete a block outright. Distinct from chrome stripping, which is L6's and is
 * restorable: this is the user saying the block does not belong in the proof.
 * Undo is the route back, which is why it goes through the stack like the rest.
 * @param {Doc} doc
 * @param {string} specimenId
 * @param {number} index
 * @returns {Doc}
 */
export function removeBlockAt(doc, specimenId, index) {
  return withProof(doc, (p) => updateSpecimen(p, specimenId, (s) => {
    const blocks = s.blocks || [];
    if (index < 0 || index >= blocks.length) return s;
    const next = blocks.filter((_, i) => i !== index);
    return { ...s, blocks: next, wordCount: countBlockWords(next) };
  }));
}

/**
 * Write a text value into whichever field of a block carries its prose.
 * @param {ContentBlock} block
 * @param {string} text
 * @returns {ContentBlock}
 */
export function applyBlockText(block, text) {
  switch (block.type) {
    case 'heading': case 'paragraph': case 'quote': return { ...block, text };
    case 'cta': return { ...block, label: text };
    case 'list': return { ...block, items: text.split('\n').map((s) => s.trim()).filter(Boolean) };
    case 'table': return { ...block, rows: text.split('\n').map((line) => line.split('\t')) };
    case 'media': return { ...block, caption: text };
    case 'raw': return { ...block, html: text };
    default: return block;
  }
}

/**
 * The editable text of a block, the inverse of `applyBlockText`.
 * @param {ContentBlock} block
 * @returns {string}
 */
export function blockEditableText(block) {
  switch (block.type) {
    case 'heading': case 'paragraph': case 'quote': return block.text || '';
    case 'cta': return block.label || '';
    case 'list': return (block.items || []).join('\n');
    case 'table': return (block.rows || []).map((r) => r.join('\t')).join('\n');
    case 'media': return block.caption || '';
    case 'raw': return block.html || '';
    default: return '';
  }
}

/**
 * A one-line description of a block for the library rows.
 * @param {ContentBlock} block
 * @returns {string}
 */
export function blockSummary(block) {
  if (!block) return '';
  if (block.type === 'media') return block.caption || block.ref || 'media';
  if (block.type === 'table') return `${(block.rows || []).length} rows`;
  return blockEditableText(block).replace(/\s+/g, ' ').trim();
}

/**
 * Word count over blocks, kept in step with `Specimen.wordCount` whenever the
 * studio changes a block. Mirrors `core/contracts.countWords`, which counts the
 * same runs; duplicating the two-line loop here keeps this module free of a
 * dependency it would otherwise need only for this.
 * @param {ContentBlock[]} blocks
 * @returns {number}
 */
export function countBlockWords(blocks) {
  let n = 0;
  for (const block of blocks || []) {
    const text = blockEditableText(block);
    if (text) n += text.split(/\s+/).filter(Boolean).length;
  }
  return n;
}

/** @param {Doc} doc @param {string} specimenId @param {number} from @param {number} to @returns {Doc} */
export function moveBlock(doc, specimenId, from, to) {
  return withProof(doc, (p) => updateSpecimen(p, specimenId, (s) => {
    const blocks = moveItem(s.blocks || [], from, to);
    return blocks === s.blocks ? s : { ...s, blocks };
  }));
}

// ---------------------------------------------------------------------------
// Recipe and rendition mutations
// ---------------------------------------------------------------------------

/**
 * Install recipes that are not already present, by id. Idempotent, so the
 * "load the seed library" button can be pressed twice without duplicating.
 * @param {Doc} doc
 * @param {import('../core/contracts.d.ts').Recipe[]} recipes
 * @returns {Doc}
 */
export function addRecipes(doc, recipes) {
  return withProof(doc, (p) => {
    const have = new Set((p.recipes || []).map((r) => r.id));
    const added = recipes.filter((r) => !have.has(r.id));
    return added.length ? { ...p, recipes: [...(p.recipes || []), ...added] } : p;
  });
}

/** @param {Doc} doc @param {string} recipeId @returns {Doc} */
export function removeRecipe(doc, recipeId) {
  return withProof(doc, (p) => ({ ...p, recipes: (p.recipes || []).filter((r) => r.id !== recipeId) }));
}

/** @param {Doc} doc @param {Rendition} rendition @returns {Doc} */
export function addRendition(doc, rendition) {
  return withProof(doc, (p) => ({ ...p, renditions: [...(p.renditions || []), rendition] }));
}

/** @param {Doc} doc @param {string} id @returns {Doc} */
export function removeRendition(doc, id) {
  return withProof(doc, (p) => {
    const drop = (s) => ({ ...s, renditionIds: (s.renditionIds || []).filter((r) => r !== id) });
    return {
      ...p,
      renditions: (p.renditions || []).filter((r) => r.id !== id),
      spine: (p.spine || []).map(drop),
      branches: (p.branches || []).map((b) => ({ ...b, scenes: (b.scenes || []).map(drop) })),
    };
  });
}

/** @param {Doc} doc @param {string} id @param {string} label @returns {Doc} */
export function setRenditionLabel(doc, id, label) {
  return withProof(doc, (p) => updateRendition(p, id, (r) => ({ ...r, label: String(label) })));
}

/** @param {Doc} doc @param {string} id @param {string} notes @returns {Doc} */
export function setRenditionNotes(doc, id, notes) {
  return withProof(doc, (p) => updateRendition(p, id, (r) => ({ ...r, notes: notes ? String(notes) : null })));
}

/**
 * Mark a rendition as the client's own material. §9 allows exactly two states
 * that suppress the illustrative label, and this is the one that does not need
 * a promotion record: the user is asserting provenance, not upgrading it.
 * @param {Doc} doc
 * @param {string} id
 * @param {boolean} clientSupplied
 * @returns {Doc}
 */
export function setRenditionClientSupplied(doc, id, clientSupplied) {
  return withProof(doc, (p) => updateRendition(p, id, (r) => ({
    ...r,
    provenance: /** @type {any} */ (clientSupplied ? 'client-supplied' : 'illustrative'),
  })));
}

/** @param {Doc} doc @param {Rendition} rendition @returns {Doc} */
export function replaceRendition(doc, rendition) {
  return withProof(doc, (p) => updateRendition(p, rendition.id, () => rendition));
}

/**
 * @param {Doc} doc
 * @param {string} id
 * @param {ContentBlock[]} blocks
 * @returns {Doc}
 */
export function setRenditionBlocks(doc, id, blocks) {
  return withProof(doc, (p) => updateRendition(p, id, (r) => ({ ...r, blocks })));
}

// ---------------------------------------------------------------------------
// Scene mutations
// ---------------------------------------------------------------------------

/**
 * Append a scene to the spine or to a branch.
 * @param {Doc} doc
 * @param {Scene} scene
 * @param {string|null} [branchId]
 * @returns {Doc}
 */
export function addScene(doc, scene, branchId = null) {
  return withProof(doc, (p) => (branchId
    ? updateBranch(p, branchId, (b) => ({ ...b, scenes: [...(b.scenes || []), scene] }))
    : { ...p, spine: [...(p.spine || []), scene] }));
}

/**
 * Remove a scene and every anchor pointing at it.
 * @param {Doc} doc
 * @param {string} sceneId
 * @returns {Doc}
 */
export function removeScene(doc, sceneId) {
  return withProof(doc, (p) => ({
    ...p,
    spine: (p.spine || []).filter((s) => s.id !== sceneId),
    branches: (p.branches || []).map((b) => ({ ...b, scenes: (b.scenes || []).filter((s) => s.id !== sceneId) })),
  }));
}

/** @param {Doc} doc @param {string} sceneId @param {number} delta @returns {Doc} */
export function moveScene(doc, sceneId, delta) {
  return withProof(doc, (p) => {
    const at = findScene(p, sceneId);
    if (!at) return p;
    if (at.sequence === 'spine') {
      const spine = moveItem(p.spine || [], at.index, at.index + delta);
      return spine === p.spine ? p : { ...p, spine };
    }
    return updateBranch(p, /** @type {string} */ (at.branchId), (b) => {
      const scenes = moveItem(b.scenes || [], at.index, at.index + delta);
      return scenes === b.scenes ? b : { ...b, scenes };
    });
  });
}

/** @param {Doc} doc @param {string} sceneId @param {Partial<Scene>} patch @returns {Doc} */
export function patchScene(doc, sceneId, patch) {
  return withProof(doc, (p) => updateScene(p, sceneId, (s) => ({ ...s, ...patch })));
}

/**
 * Attach or detach a rendition from a scene.
 * @param {Doc} doc
 * @param {string} sceneId
 * @param {string} renditionId
 * @returns {Doc}
 */
export function toggleSceneRendition(doc, sceneId, renditionId) {
  return withProof(doc, (p) => updateScene(p, sceneId, (s) => {
    const ids = s.renditionIds || [];
    return { ...s, renditionIds: ids.includes(renditionId) ? ids.filter((r) => r !== renditionId) : [...ids, renditionId] };
  }));
}

/**
 * @param {Doc} doc
 * @param {string} sceneId
 * @param {string} branchId
 * @returns {Doc}
 */
export function toggleBranchAnchor(doc, sceneId, branchId) {
  return withProof(doc, (p) => updateScene(p, sceneId, (s) => {
    const ids = s.branchAnchors || [];
    return { ...s, branchAnchors: ids.includes(branchId) ? ids.filter((b) => b !== branchId) : [...ids, branchId] };
  }));
}

// ---------------------------------------------------------------------------
// Beat mutations
// ---------------------------------------------------------------------------

/**
 * Add a beat at the end of a scene.
 * @param {Doc} doc
 * @param {string} sceneId
 * @returns {Doc}
 */
export function addBeat(doc, sceneId) {
  return withProof(doc, (p) => updateScene(p, sceneId, (s) => {
    const taken = new Set((s.beats || []).map((b) => b.id));
    let n = (s.beats || []).length;
    let id = `${s.id}_b${n}`;
    while (taken.has(id)) { n += 1; id = `${s.id}_b${n}`; }
    return { ...s, beats: [...(s.beats || []), { id, reveals: [], presenterNote: null, dwellHintMs: null }] };
  }));
}

/**
 * Remove a beat. A scene always keeps at least one, because §14 raises
 * `BEAT_EMPTY` on a scene with none and a scene you cannot stand on is not a
 * scene.
 * @param {Doc} doc
 * @param {string} sceneId
 * @param {number} index
 * @returns {Doc}
 */
export function removeBeat(doc, sceneId, index) {
  return withProof(doc, (p) => updateScene(p, sceneId, (s) => {
    const beats = s.beats || [];
    if (beats.length <= 1 || index < 0 || index >= beats.length) return s;
    return { ...s, beats: beats.filter((_, i) => i !== index) };
  }));
}

/** @param {Doc} doc @param {string} sceneId @param {number} index @param {number} delta @returns {Doc} */
export function moveBeat(doc, sceneId, index, delta) {
  return withProof(doc, (p) => updateScene(p, sceneId, (s) => {
    const beats = moveItem(s.beats || [], index, index + delta);
    return beats === s.beats ? s : { ...s, beats };
  }));
}

/**
 * Toggle whether a beat reveals an element. Reveals are additive over the scene
 * (§10), so an element already revealed by an earlier beat is shown as inherited
 * rather than togglable — that check lives in the panel, which has the earlier
 * beats to hand.
 * @param {Doc} doc
 * @param {string} sceneId
 * @param {number} index
 * @param {string} elementId_
 * @returns {Doc}
 */
export function toggleBeatReveal(doc, sceneId, index, elementId_) {
  return withProof(doc, (p) => updateScene(p, sceneId, (s) => {
    const beats = (s.beats || []).slice();
    if (index < 0 || index >= beats.length) return s;
    const reveals = beats[index].reveals || [];
    beats[index] = {
      ...beats[index],
      reveals: reveals.includes(elementId_) ? reveals.filter((r) => r !== elementId_) : [...reveals, elementId_],
    };
    return { ...s, beats };
  }));
}

/** @param {Doc} doc @param {string} sceneId @param {number} index @param {Partial<import('../core/contracts.d.ts').Beat>} patch @returns {Doc} */
export function patchBeat(doc, sceneId, index, patch) {
  return withProof(doc, (p) => updateScene(p, sceneId, (s) => {
    const beats = (s.beats || []).slice();
    if (index < 0 || index >= beats.length) return s;
    beats[index] = { ...beats[index], ...patch };
    return { ...s, beats };
  }));
}

// ---------------------------------------------------------------------------
// Branch mutations
// ---------------------------------------------------------------------------

/** @param {Doc} doc @param {Branch} branch @returns {Doc} */
export function addBranch(doc, branch) {
  return withProof(doc, (p) => ({ ...p, branches: [...(p.branches || []), branch] }));
}

/**
 * Remove a branch and every anchor to it, so no scene is left offering a jump
 * that goes nowhere.
 * @param {Doc} doc
 * @param {string} branchId
 * @returns {Doc}
 */
export function removeBranch(doc, branchId) {
  return withProof(doc, (p) => {
    const drop = (s) => ({ ...s, branchAnchors: (s.branchAnchors || []).filter((b) => b !== branchId) });
    return {
      ...p,
      branches: (p.branches || []).filter((b) => b.id !== branchId).map((b) => ({ ...b, scenes: (b.scenes || []).map(drop) })),
      spine: (p.spine || []).map(drop),
    };
  });
}

/** @param {Doc} doc @param {string} branchId @param {Partial<Branch>} patch @returns {Doc} */
export function patchBranch(doc, branchId, patch) {
  return withProof(doc, (p) => updateBranch(p, branchId, (b) => ({ ...b, ...patch })));
}

/** @param {Doc} doc @param {string} branchId @param {string} alias @returns {Doc} */
export function addBranchAlias(doc, branchId, alias) {
  const text = String(alias || '').trim();
  if (!text) return doc;
  return withProof(doc, (p) => updateBranch(p, branchId, (b) => (
    (b.aliases || []).includes(text) ? b : { ...b, aliases: [...(b.aliases || []), text] })));
}

/** @param {Doc} doc @param {string} branchId @param {number} index @returns {Doc} */
export function removeBranchAlias(doc, branchId, index) {
  return withProof(doc, (p) => updateBranch(p, branchId, (b) => ({
    ...b, aliases: (b.aliases || []).filter((_, i) => i !== index),
  })));
}

// ---------------------------------------------------------------------------
// Derived reads the panels and the emit gate share
// ---------------------------------------------------------------------------

/**
 * The element ids a scene's beats already reference but that the current
 * layout does not render. These are the reveals that will silently do nothing,
 * which is worth showing next to the beat rather than discovering on stage.
 * @param {Scene} scene
 * @param {Set<string>} available
 * @returns {string[]}
 */
export function danglingReveals(scene, available) {
  const out = new Set();
  for (const beat of scene.beats || []) {
    for (const id of beat.reveals || []) if (!available.has(id)) out.add(id);
  }
  return [...out];
}

/**
 * The element id a scene would mint for a structural path. Exposed so the beat
 * editor can label an element id with the path it came from.
 * @param {string} sceneId
 * @param {string} path
 * @returns {string}
 */
export function pathElementId(sceneId, path) { return elementId(sceneId, path); }

/**
 * Layout choices, with the human name and a one-line description of what the
 * layout is for. Kept here rather than read from L8 so the scene panel can
 * offer every layout in the frozen §4 set even before L8 has registered them.
 * @returns {{value: string, label: string, describe: string}[]}
 */
export function layoutChoices() {
  const describe = {
    splitBeforeAfter: 'Their page on the left, the rendition on the right.',
    fanOut: 'One source, many renditions, spread to make volume physical.',
    stack: 'Renditions layered in sequence — good for approval states.',
    fullBleed: 'A single asset at full size, nothing competing with it.',
    sideNote: 'Content with a margin note for the claim you are making.',
    systemMap: 'How the pieces connect, for the "how would this work here" question.',
    quoteCard: 'One sentence, in their words. No decoration.',
    contentsIndex: 'What this proof covers — the map you open or close on.',
  };
  return SCENE_LAYOUTS.map((value) => ({
    value,
    label: value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()),
    describe: describe[value] || '',
  }));
}

/**
 * The role a colour is paired against, for the contrast column.
 * @param {string} role
 * @returns {string|null}
 */
export function pairedRole(role) { return ROLE_PAIR[/** @type {any} */ (role)] || null; }
