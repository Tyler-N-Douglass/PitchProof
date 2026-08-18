/**
 * The action registry: every single thing the studio can do.
 *
 * This is not a convenience layer. It is the studio's inventory, and three
 * tests read it rather than a hand-written list:
 *
 *   - `test/ui/undo-redo.test.mjs` runs every action marked `mutates`, asserts
 *     the command stack grew, and deep-equals the proof before and after an
 *     undo. An action added without a `sample` cannot be tested, so the registry
 *     refuses to be valid without one — which is the point.
 *   - `test/ui/keyboard.test.mjs` asserts every action has a keyboard route:
 *     its own binding, a place in the command palette, or a focusable control
 *     rendered by a panel (§20.10).
 *   - `test/ui/no-override.test.mjs` asserts exactly one action reaches the
 *     emitter, and that it consults `emitBlockers` first (§14).
 *
 * Conventions, held by `actionIndex`:
 *   `mutates`  the action changes the model, therefore it must go through
 *              `app.mutate` and must carry a `sample`.
 *   `keys`     accelerator strings (`ui/keys.js`).
 *   `palette`  reachable from the command palette. Default true.
 *   `control`  reachable by tabbing to a control a panel renders. Set on the
 *              field-level actions, which have no sensible palette form.
 *
 * @module ui/actions
 */

import { ok, err } from '../core/result.js';
import { QUALITY_STEPS, COLOR_ROLES, SPECIMEN_KINDS, SCENE_LAYOUTS } from '../core/contracts.js';
import { exportProjectJson, importProjectJson, makeRecord } from '../core/storage.js';
import { downloadText, readFiles, pickFiles, safeFilename } from './io.js';
import { emitBlockers, proofDigest } from './gate.js';
import { SETTING_KEYS } from './constants.js';
import * as M from './model.js';

// ---------------------------------------------------------------------------
// Small helpers the actions share
// ---------------------------------------------------------------------------

/** @param {any} app @returns {any} */
const sel = (app) => app.ui.selection;

/**
 * Mint an id that is free in this proof and reproducible from the seed.
 * @param {any} app
 * @param {string} kind
 * @param {unknown} salt
 * @returns {string}
 */
function mint(app, kind, salt) {
  return M.mintId(/** @type {any} */ (kind), app.doc.seed, M.usedIds(app.proof), salt);
}

/** @param {any} app @returns {any|null} */
const currentSpecimen = (app) => M.findSpecimen(app.proof, sel(app).specimenId);
/** @param {any} app @returns {any|null} */
const currentRendition = (app) => M.findRendition(app.proof, sel(app).renditionId);
/** @param {any} app @returns {any|null} */
const currentBranch = (app) => M.findBranch(app.proof, sel(app).branchId);
/** @param {any} app @returns {any|null} */
const currentScene = (app) => {
  const at = M.findScene(app.proof, sel(app).sceneId);
  return at ? at.scene : null;
};

/**
 * Parse an argument of the form `id:index` used by the row controls.
 * @param {string|null} arg
 * @returns {{id: string, index: number}}
 */
function idIndex(arg) {
  const text = String(arg || '');
  const cut = text.lastIndexOf(':');
  if (cut < 0) return { id: text, index: 0 };
  return { id: text.slice(0, cut), index: Number(text.slice(cut + 1)) || 0 };
}

/** @param {any} ctx @returns {string} */
const value = (ctx) => (ctx && ctx.value !== undefined && ctx.value !== null ? String(ctx.value) : '');
/** @param {any} ctx @returns {boolean} */
const checked = (ctx) => !!(ctx && ctx.value === true);

/**
 * The operator's name, used wherever §9 requires a promotion or an opt-in to
 * record *who*. Empty means the studio asks before it records anything.
 * @param {any} app
 * @returns {string}
 */
function operator(app) { return String(app.ui.settings.operator || '').trim(); }

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/** @type {any[]} */
export const ACTIONS = [

  // ---- application ------------------------------------------------------

  {
    id: 'app.undo', label: 'Undo', group: 'Studio', keys: ['Mod+z'],
    enabled: (app) => app.stack.canUndo,
    run: (app) => { app.undo(); },
  },
  {
    id: 'app.redo', label: 'Redo', group: 'Studio', keys: ['Mod+Shift+z', 'Mod+y'],
    enabled: (app) => app.stack.canRedo,
    run: (app) => { app.redo(); },
  },
  {
    id: 'app.palette', label: 'Open the command palette', group: 'Studio', keys: ['Mod+k'],
    run: (app) => { app.setUi({ paletteOpen: !app.ui.paletteOpen, paletteQuery: '', paletteIndex: 0 }); },
  },
  {
    id: 'app.palette.query', label: 'Type in the command palette', group: 'Studio', palette: false, control: true,
    run: (app, _arg, ctx) => { app.setUi({ paletteQuery: value(ctx), paletteIndex: 0 }); },
  },
  {
    id: 'app.palette.run', label: 'Run the highlighted command', group: 'Studio', palette: false, control: true,
    run: (app, arg) => { app.setUi({ paletteOpen: false, paletteQuery: '' }); app.dispatch(String(arg)); },
  },
  {
    id: 'app.keys', label: 'Keyboard reference', group: 'Studio', keys: ['Alt+/'],
    run: (app) => { app.setUi({ keysOpen: !app.ui.keysOpen }); },
  },
  {
    id: 'app.history', label: 'Undo history', group: 'Studio', keys: ['Alt+h'],
    run: (app) => { app.setUi({ historyOpen: !app.ui.historyOpen }); },
  },
  {
    id: 'app.inspector', label: 'Show or hide the inspector', group: 'Studio', keys: ['Alt+i'],
    run: (app) => { app.setUi({ inspectorOpen: !app.ui.inspectorOpen }); },
  },
  {
    id: 'app.preview', label: 'Show or hide the preview', group: 'Studio', keys: ['Alt+p'],
    run: (app) => { app.setUi({ layout: app.ui.layout === 'split' ? 'focus' : 'split' }); },
  },
  {
    id: 'app.section', label: 'Go to a section', group: 'Studio', palette: false, control: true,
    run: (app, arg) => { app.setUi({ section: String(arg) }); },
  },
  {
    id: 'app.section.next', label: 'Next section', group: 'Studio', keys: ['Alt+]'],
    run: (app) => stepSection(app, 1),
  },
  {
    id: 'app.section.prev', label: 'Previous section', group: 'Studio', keys: ['Alt+['],
    run: (app) => stepSection(app, -1),
  },
  ...['project', 'brand', 'specimens', 'recipes', 'scenes', 'branches', 'rehearse', 'emit'].map((id, i) => ({
    id: `app.section.${id}`,
    label: `Go to ${id.charAt(0).toUpperCase()}${id.slice(1)}`,
    group: 'Studio',
    keys: [`Alt+${i + 1}`],
    run: (app) => { app.setUi({ section: id }); },
  })),
  {
    id: 'app.section.settings', label: 'Go to Settings', group: 'Studio', keys: ['Alt+9'],
    run: (app) => { app.setUi({ section: 'settings' }); },
  },
  {
    id: 'app.notice.dismiss', label: 'Dismiss a message', group: 'Studio', palette: false, control: true,
    run: (app, arg) => { app.dismissNotice(String(arg)); },
  },
  {
    id: 'app.breakpoint', label: 'Preview at another breakpoint', group: 'Studio', palette: false, control: true,
    run: (app, arg) => { app.setUi({ breakpoint: String(arg) }); },
  },
  {
    id: 'app.preview.focus', label: 'Put the keyboard into the preview', group: 'Studio', keys: ['Alt+Enter'],
    run: (app) => {
      if (!app.preview.focus()) app.notify('warn', 'The preview is not mounted yet.');
    },
  },
  {
    id: 'app.preview.nextBeat', label: 'Preview: next beat', group: 'Studio', keys: ['Alt+ArrowRight'],
    run: (app) => { app.preview.run('nextBeat'); },
  },
  {
    id: 'app.preview.prevBeat', label: 'Preview: previous beat', group: 'Studio', keys: ['Alt+ArrowLeft'],
    run: (app) => { app.preview.run('prevBeat'); },
  },
  {
    id: 'app.preview.nextScene', label: 'Preview: next scene', group: 'Studio', keys: ['Alt+ArrowDown'],
    run: (app) => {
      app.preview.run('nextScene');
      const scene = app.preview.runtime ? app.preview.runtime.scene : null;
      if (scene) app.select({ sceneId: scene.id });
    },
  },
  {
    id: 'app.preview.prevScene', label: 'Preview: previous scene', group: 'Studio', keys: ['Alt+ArrowUp'],
    run: (app) => {
      app.preview.run('prevScene');
      const scene = app.preview.runtime ? app.preview.runtime.scene : null;
      if (scene) app.select({ sceneId: scene.id });
    },
  },

  // ---- project ----------------------------------------------------------

  {
    id: 'project.new', label: 'New project', group: 'Project',
    run: (app) => {
      const doc = M.newDoc({ seed: `pitchproof-${app.clock().slice(0, 10)}`, at: app.clock() });
      app.stack.reset(doc);
      app.setUi({ section: 'project' });
      app.select({ specimenId: null, renditionId: null, sceneId: null, branchId: null });
      return app.saveNow();
    },
  },
  {
    id: 'project.open', label: 'Open a project', group: 'Project', palette: false, control: true,
    run: async (app, arg) => {
      const loaded = await app.store.load(String(arg));
      if (!loaded.ok) { app.notify('bad', loaded.error, { sticky: true }); return; }
      app.loadRecord(loaded.value);
      app.notify('ok', `Opened “${loaded.value.name}”.`);
    },
  },
  {
    id: 'project.save', label: 'Save now', group: 'Project', keys: ['Mod+s'],
    run: async (app) => {
      const result = await app.saveNow();
      if (result.ok) app.notify('ok', `Saved at revision ${result.value.record.revision}.`);
    },
  },
  {
    id: 'project.duplicate', label: 'Duplicate this project', group: 'Project',
    run: async (app) => {
      const doc = app.doc;
      const at = app.clock();
      const copy = {
        ...doc,
        id: M.mintId('project', doc.seed, new Set(app.ui.projects.map((p) => p.id)), { at, of: doc.id }),
        name: `${doc.name} (copy)`,
      };
      app.stack.reset(copy);
      const saved = await app.saveNow();
      if (saved.ok) app.notify('ok', `Duplicated as “${copy.name}”.`);
    },
  },
  {
    id: 'project.delete', label: 'Delete a project', group: 'Project', palette: false, control: true,
    run: async (app, arg) => {
      const id = String(arg);
      const target = app.ui.projects.find((p) => p.id === id);
      const result = await app.store.remove(id);
      if (!result.ok) { app.notify('bad', result.error, { sticky: true }); return; }
      await app.refreshProjects();
      if (id === app.doc.id) app.dispatch('project.new');
      app.notify('ok', `Deleted “${target ? target.name : id}”. Undo does not reach across a delete — re-import the export if you need it back.`);
    },
  },
  {
    id: 'project.export', label: 'Export .pitchproof.json', group: 'Project', keys: ['Mod+e'],
    run: (app) => {
      const doc = app.doc;
      const record = makeRecord({
        id: doc.id, name: doc.name, proof: doc.proof, seed: doc.seed,
        revision: app.ui.save.revision || 1, clock: app.clock,
      });
      const text = exportProjectJson(record);
      const result = downloadText({
        document: app.document, window: app.window,
        filename: safeFilename(doc.name, '.pitchproof.json'),
        text, mime: 'application/json',
      });
      if (result.ok) app.notify('ok', `Exported ${result.value.filename}. It carries no settings and no adapter key.`);
      else app.notify('bad', result.error, { sticky: true });
    },
  },
  {
    id: 'project.import', label: 'Import a .pitchproof.json', group: 'Project', palette: false, control: true,
    run: async (app, _arg, ctx) => {
      const files = ctx.element && ctx.element.files ? await readFiles(ctx.element.files) : await readFiles(await pickFiles({ document: app.document, accept: '.json,.pitchproof.json' }));
      if (!files.length) return;
      const parsed = importProjectJson(files[0].text || '');
      if (!parsed.ok) { app.notify('bad', parsed.error, { sticky: true }); return; }
      app.loadRecord(parsed.value);
      await app.saveNow();
      app.notify('ok', `Imported “${parsed.value.name}”.`);
      if (ctx.element) ctx.element.value = '';
    },
  },
  {
    id: 'project.importPick', label: 'Import a project file…', group: 'Project',
    run: async (app) => {
      const picked = await pickFiles({ document: app.document, accept: '.json', multiple: false });
      if (!picked.length) return;
      const files = await readFiles(picked);
      const parsed = importProjectJson(files[0].text || '');
      if (!parsed.ok) { app.notify('bad', parsed.error, { sticky: true }); return; }
      app.loadRecord(parsed.value);
      await app.saveNow();
      app.notify('ok', `Imported “${parsed.value.name}”.`);
    },
  },
  {
    id: 'project.setName', label: 'Rename the project', group: 'Project', palette: false, control: true,
    mutates: true, sample: () => ({ value: 'Northwind proof' }),
    run: (app, _arg, ctx) => app.mutate('Rename project', (doc) => M.setProjectName(doc, value(ctx)), {
      coalesceKey: 'project.setName', scope: 'project',
    }),
  },
  {
    id: 'project.setProspect', label: 'Set the prospect name', group: 'Project', palette: false, control: true,
    mutates: true, sample: () => ({ value: 'Northwind Industrial' }),
    run: (app, _arg, ctx) => app.mutate('Set prospect name', (doc) => M.setProspectName(doc, value(ctx)), {
      coalesceKey: 'project.setProspect', scope: 'project',
    }),
  },
  {
    id: 'project.setSeed', label: 'Set the project seed', group: 'Project', palette: false, control: true,
    mutates: true, sample: () => ({ value: 'northwind-2026' }),
    run: (app, _arg, ctx) => app.mutate('Set project seed', (doc) => M.setSeed(doc, value(ctx)), {
      coalesceKey: 'project.setSeed', scope: 'project',
    }),
  },
  {
    id: 'project.recompress', label: 'Re-compress assets', group: 'Project',
    mutates: true, sample: () => ({}),
    run: (app) => {
      const current = app.proof.emitOptions.imageQuality;
      const at = QUALITY_STEPS.indexOf(current);
      if (at <= 0) {
        app.notify('warn', 'Image quality is already at its lowest step (0.6). Remove a specimen or export and archive this project instead.');
        return undefined;
      }
      const next = QUALITY_STEPS[at - 1];
      return app.mutate(`Re-compress assets at quality ${next}`, (doc) => M.setEmitOptions(doc, { imageQuality: next }), {
        scope: 'project',
      });
    },
  },

  // ---- brand ------------------------------------------------------------

  {
    id: 'brand.urlDraft', label: 'Type a brand URL', group: 'Brand', palette: false, control: true,
    run: (app, _arg, ctx) => app.setDraft('brand.url', value(ctx)),
  },
  {
    id: 'brand.extract', label: 'Extract brand from a URL', group: 'Brand',
    mutates: true, sample: () => ({}),
    run: async (app) => {
      const url = String(app.draft('brand.url', '')).trim();
      if (!url) { app.notify('warn', 'Type the prospect’s URL first.'); return; }
      const capture = await app.services.ingestUrl(url, { proxyBase: app.ui.settings.proxyBase });
      if (!capture.ok) { app.notify('bad', capture.error, { sticky: true }); return; }
      const brand = app.services.buildBrand([capture.value], { seed: app.doc.seed });
      if (!brand.ok) { app.notify('bad', brand.error, { sticky: true }); return; }
      app.mutate('Extract brand system', (doc) => M.replaceBrand(doc, brand.value), { scope: 'brand' });
      app.notify('ok', 'Brand extracted. Every group below its confidence floor is held for your review before an emit can use it.');
    },
  },
  {
    id: 'brand.extractFiles', label: 'Extract brand from files', group: 'Brand', palette: false, control: true,
    mutates: true, sample: () => ({}),
    run: async (app, _arg, ctx) => {
      const files = ctx.element && ctx.element.files
        ? await readFiles(ctx.element.files)
        : await readFiles(await pickFiles({ document: app.document }));
      if (!files.length) return;
      const captured = await app.services.importFiles(files);
      if (!captured.ok) { app.notify('bad', captured.error, { sticky: true }); return; }
      const brand = app.services.buildBrand(captured.value.captures, { seed: app.doc.seed });
      if (!brand.ok) { app.notify('bad', brand.error, { sticky: true }); return; }
      app.mutate('Extract brand system from files', (doc) => M.replaceBrand(doc, brand.value), { scope: 'brand' });
      if (ctx.element) ctx.element.value = '';
    },
  },
  {
    id: 'brand.setSourceUrl', label: 'Set the brand source URL', group: 'Brand', palette: false, control: true,
    mutates: true, sample: () => ({ value: 'https://example.com' }),
    run: (app, _arg, ctx) => app.mutate('Set brand source', (doc) => M.setBrandSourceUrl(doc, value(ctx)), {
      coalesceKey: 'brand.setSourceUrl', scope: 'brand',
    }),
  },
  {
    id: 'brand.setColor', label: 'Set a colour role', group: 'Brand', palette: false, control: true,
    mutates: true, sample: () => ({ arg: 'primary', value: '#2A5BD7' }),
    run: (app, arg, ctx) => {
      const role = String(arg);
      const hex = normalizeHex(value(ctx));
      if (!hex) return undefined;
      const pair = M.pairedRole(role);
      const pairHex = pair ? hexOfRole(app.proof.brand, pair) : null;
      const computed = {
        oklch: app.services.oklch(hex) || undefined,
        contrastWithPair: pairHex ? app.services.contrast(hex, pairHex) : null,
      };
      return app.mutate(`Set ${role}`, (doc) => M.setBrandColor(doc, role, hex, computed), {
        coalesceKey: `brand.setColor:${role}`, scope: 'brand',
      });
    },
  },
  {
    id: 'brand.addColor', label: 'Add a colour role', group: 'Brand', palette: false, control: true,
    mutates: true, sample: (app) => ({ arg: missingRole(app.proof.brand) || 'accent' }),
    run: (app, arg, ctx) => {
      // The control is a select, so the role arrives as the event's value; the
      // palette and the tests pass it as the argument. Either is fine.
      const role = String(value(ctx) || arg || '');
      if (!COLOR_ROLES.includes(/** @type {any} */ (role))) return undefined;
      return app.mutate(`Add ${role}`, (doc) => M.setBrandColor(doc, role, '#808080', {}), { scope: 'brand' });
    },
  },
  {
    id: 'brand.removeColor', label: 'Remove a colour role', group: 'Brand', palette: false, control: true,
    mutates: true, sample: (app) => ({ arg: (app.proof.brand.colors[0] || {}).role || 'primary' }),
    run: (app, arg) => app.mutate(`Remove ${String(arg)}`, (doc) => M.removeBrandColor(doc, String(arg)), { scope: 'brand' }),
  },
  {
    id: 'brand.deriveOnColor', label: 'Derive a compliant on-colour', group: 'Brand', palette: false, control: true,
    mutates: true, sample: () => ({ arg: 'onPrimary' }),
    run: (app, arg) => {
      const role = String(arg);
      const pair = M.pairedRole(role);
      const base = pair ? hexOfRole(app.proof.brand, pair) : null;
      const current = hexOfRole(app.proof.brand, role) || '#FFFFFF';
      if (!base) { app.notify('warn', `${role} has no paired role to derive against.`); return undefined; }
      const derived = app.services.deriveForContrast(base, current, 4.5);
      if (!derived) {
        app.notify('bad', 'The colour lane is not wired into this build, so a compliant colour cannot be derived. Type a hex that reaches 4.5:1 instead.');
        return undefined;
      }
      return app.mutate(`Derive ${role}`, (doc) => M.setBrandColor(doc, role, derived, {
        oklch: app.services.oklch(derived) || undefined,
        contrastWithPair: app.services.contrast(derived, base),
      }), { scope: 'brand' });
    },
  },
  {
    id: 'brand.setFaceFamily', label: 'Set a face family', group: 'Brand', palette: false, control: true,
    mutates: true, sample: () => ({ arg: '0', value: 'Inter' }),
    run: (app, arg, ctx) => app.mutate('Set face family', (doc) => M.setBrandFace(doc, Number(arg), { family: value(ctx) }), {
      coalesceKey: `brand.setFaceFamily:${arg}`, scope: 'brand',
    }),
  },
  {
    id: 'brand.setFaceRole', label: 'Set a face role', group: 'Brand', palette: false, control: true,
    mutates: true, sample: () => ({ arg: '0', value: 'display' }),
    run: (app, arg, ctx) => app.mutate('Set face role', (doc) => M.setBrandFace(doc, Number(arg), { role: /** @type {any} */ (value(ctx)) }), {
      scope: 'brand',
    }),
  },
  {
    id: 'brand.setFaceStack', label: 'Set a fallback stack', group: 'Brand', palette: false, control: true,
    mutates: true, sample: () => ({ arg: '0', value: 'Inter, Arial, sans-serif' }),
    run: (app, arg, ctx) => app.mutate('Set fallback stack', (doc) => M.setBrandFace(doc, Number(arg), {
      fallbackStack: value(ctx).split(',').map((s) => s.trim()).filter(Boolean),
    }), { coalesceKey: `brand.setFaceStack:${arg}`, scope: 'brand' }),
  },
  {
    id: 'brand.setFaceEmbeddable', label: 'Assert a font licence', group: 'Brand', palette: false, control: true,
    mutates: true, sample: () => ({ arg: '0', value: true }),
    run: (app, arg, ctx) => app.mutate(
      checked(ctx) ? 'Assert font licence' : 'Withdraw font licence assertion',
      (doc) => M.setBrandFace(doc, Number(arg), { embeddable: checked(ctx) }),
      { scope: 'brand' },
    ),
  },
  {
    id: 'brand.addFace', label: 'Add a face', group: 'Brand',
    mutates: true, sample: () => ({}),
    run: (app) => app.mutate('Add face', (doc) => M.addBrandFace(doc, {
      family: '', fallbackStack: ['Arial', 'sans-serif'], weightsSeen: [400],
      role: 'body', metricDelta: null, embeddable: false,
    }), { scope: 'brand' }),
  },
  {
    id: 'brand.removeFace', label: 'Remove a face', group: 'Brand', palette: false, control: true,
    mutates: true, sample: () => ({ arg: '0' }),
    run: (app, arg) => app.mutate('Remove face', (doc) => M.removeBrandFace(doc, Number(arg)), { scope: 'brand' }),
  },
  {
    id: 'brand.setRadius', label: 'Set the corner radius', group: 'Brand', palette: false, control: true,
    mutates: true, sample: () => ({ value: '12' }),
    run: (app, _arg, ctx) => app.mutate('Set corner radius', (doc) => M.setBrandShape(doc, { radiusPx: Number(value(ctx)) || 0 }), {
      coalesceKey: 'brand.setRadius', scope: 'brand',
    }),
  },
  {
    id: 'brand.setBorderWidth', label: 'Set the border width', group: 'Brand', palette: false, control: true,
    mutates: true, sample: () => ({ value: '2' }),
    run: (app, _arg, ctx) => app.mutate('Set border width', (doc) => M.setBrandShape(doc, { borderWidthPx: Number(value(ctx)) || 0 }), {
      coalesceKey: 'brand.setBorderWidth', scope: 'brand',
    }),
  },
  {
    id: 'brand.setShadow', label: 'Set the shadow level', group: 'Brand', palette: false, control: true,
    mutates: true, sample: () => ({ arg: '2' }),
    run: (app, arg) => app.mutate('Set shadow level', (doc) => M.setBrandShape(doc, {
      shadowLevel: /** @type {any} */ (Math.max(0, Math.min(3, Number(arg) || 0))),
    }), { scope: 'brand' }),
  },
  {
    id: 'brand.setImageryTreatment', label: 'Set the imagery treatment', group: 'Brand', palette: false, control: true,
    mutates: true, sample: () => ({ value: 'illustrative' }),
    run: (app, _arg, ctx) => app.mutate('Set imagery treatment', (doc) => M.setBrandImagery(doc, {
      treatment: /** @type {any} */ (value(ctx)),
    }), { scope: 'brand' }),
  },
  {
    id: 'brand.setSaturationBias', label: 'Set the saturation bias', group: 'Brand', palette: false, control: true,
    mutates: true, sample: () => ({ value: '0.3' }),
    run: (app, _arg, ctx) => app.mutate('Set saturation bias', (doc) => M.setBrandImagery(doc, {
      saturationBias: Number(value(ctx)) || 0,
    }), { coalesceKey: 'brand.setSaturationBias', scope: 'brand' }),
  },
  {
    id: 'brand.review', label: 'Mark a brand group reviewed', group: 'Brand', palette: false, control: true,
    mutates: true, sample: () => ({ arg: 'colors', value: true }),
    run: (app, arg, ctx) => app.mutate(
      checked(ctx) ? `Mark ${arg} reviewed` : `Un-review ${arg}`,
      (doc) => M.setBrandReviewed(doc, String(arg), checked(ctx)),
      { scope: 'brand' },
    ),
  },
  {
    id: 'brand.reviewAll', label: 'Mark every low-confidence brand field reviewed', group: 'Brand',
    mutates: true, sample: () => ({}),
    run: (app) => {
      const groups = M.unreviewedBrandGroups(app.proof.brand).map((g) => g.group);
      if (!groups.length) { app.notify('ok', 'Nothing is waiting for review.'); return undefined; }
      return app.transaction('Review brand fields', () => {
        for (const group of groups) app.mutate(`Mark ${group} reviewed`, (doc) => M.setBrandReviewed(doc, group, true), { scope: 'brand' });
      }, { scope: 'brand' });
    },
  },
  {
    id: 'brand.removeLogo', label: 'Remove a logo', group: 'Brand', palette: false, control: true,
    mutates: true, sample: (app) => ({ arg: (app.proof.brand.logos[0] || {}).id || 'lg_none' }),
    run: (app, arg) => app.mutate('Remove logo', (doc) => M.removeLogo(doc, String(arg)), { scope: 'brand' }),
  },
  {
    id: 'brand.setLogoVariant', label: 'Set a logo variant', group: 'Brand', palette: false, control: true,
    mutates: true, sample: (app) => ({ arg: (app.proof.brand.logos[0] || {}).id || 'lg_none', value: 'mark' }),
    run: (app, arg, ctx) => app.mutate('Set logo variant', (doc) => M.setLogoVariant(doc, String(arg), value(ctx)), { scope: 'brand' }),
  },
  {
    id: 'brand.deriveInverse', label: 'Derive an inverse logo', group: 'Brand', palette: false, control: true,
    mutates: true, sample: (app) => ({ arg: (app.proof.brand.logos[0] || {}).id || 'lg_none' }),
    run: (app, arg) => {
      const logo = (app.proof.brand.logos || []).find((l) => l.id === String(arg));
      if (!logo) return undefined;
      const inverse = app.services.inverseLogo(logo);
      if (!inverse) {
        app.notify('warn', 'This logo is not monochrome, so an inverse cannot be derived safely. Ask the client for a proper inverse asset.');
        return undefined;
      }
      return app.mutate('Add inverse logo', (doc) => M.addLogo(doc, inverse), { scope: 'brand' });
    },
  },

  // ---- specimens ---------------------------------------------------------

  {
    id: 'specimen.urlDraft', label: 'Type a specimen URL', group: 'Specimens', palette: false, control: true,
    run: (app, _arg, ctx) => app.setDraft('specimen.url', value(ctx)),
  },
  {
    id: 'specimen.capture', label: 'Capture a specimen from a URL', group: 'Specimens',
    mutates: true, sample: () => ({}),
    run: async (app) => {
      const url = String(app.draft('specimen.url', '')).trim();
      if (!url) { app.notify('warn', 'Type a URL first.'); return; }
      const capture = await app.services.ingestUrl(url, { proxyBase: app.ui.settings.proxyBase });
      if (!capture.ok) { app.notify('bad', capture.error, { sticky: true }); return; }
      addCapture(app, capture.value, 'Capture specimen');
    },
  },
  {
    id: 'specimen.importFiles', label: 'Import specimen files', group: 'Specimens', palette: false, control: true,
    mutates: true, sample: () => ({}),
    run: async (app, _arg, ctx) => {
      const files = ctx.element && ctx.element.files
        ? await readFiles(ctx.element.files)
        : await readFiles(await pickFiles({ document: app.document }));
      if (!files.length) return;
      const captured = await app.services.importFiles(files);
      if (!captured.ok) { app.notify('bad', captured.error, { sticky: true }); return; }
      for (const capture of captured.value.captures) addCapture(app, capture, 'Import specimen');
      for (const problem of captured.value.problems) app.notify('warn', problem);
      if (ctx.element) ctx.element.value = '';
    },
  },
  {
    id: 'specimen.pasteDraft', label: 'Paste specimen HTML', group: 'Specimens', palette: false, control: true,
    run: (app, _arg, ctx) => app.setDraft('specimen.html', value(ctx)),
  },
  {
    id: 'specimen.importPaste', label: 'Capture from pasted HTML', group: 'Specimens',
    mutates: true, sample: () => ({}),
    run: (app) => {
      const html = String(app.draft('specimen.html', ''));
      if (!html.trim()) { app.notify('warn', 'Paste the page source first.'); return undefined; }
      const capture = app.services.importHtmlText(html, app.draft('specimen.url', '') || null);
      if (!capture.ok) { app.notify('bad', capture.error, { sticky: true }); return undefined; }
      addCapture(app, capture.value, 'Capture pasted specimen');
      app.setDraft('specimen.html', '');
      return undefined;
    },
  },
  {
    id: 'specimen.sitemap', label: 'Suggest specimens from the sitemap', group: 'Specimens',
    run: async (app) => {
      const base = String(app.draft('specimen.url', '') || app.proof.brand.sourceUrl || '').trim();
      if (!base) { app.notify('warn', 'Type the site’s address first.'); return; }
      const found = await app.services.discoverSitemap(base);
      if (!found.ok) { app.notify('warn', found.error); return; }
      app.setUi({ sitemap: found.value.slice(0, 24) });
      app.notify('ok', `${found.value.length} candidate pages, ranked by how much structure they carry.`);
    },
  },
  {
    id: 'specimen.useSuggestion', label: 'Use a suggested page', group: 'Specimens', palette: false, control: true,
    run: (app, arg) => { app.setDraft('specimen.url', String(arg)); },
  },
  {
    id: 'specimen.select', label: 'Select a specimen', group: 'Specimens', palette: false, control: true,
    run: (app, arg, ctx) => {
      const id = String(value(ctx) || arg || '');
      if (!id) return;
      app.select({ specimenId: id });
    },
  },
  {
    id: 'specimen.remove', label: 'Remove a specimen', group: 'Specimens', palette: false, control: true,
    mutates: true, sample: (app) => ({ arg: (app.proof.specimens[0] || {}).id || 'sp_none' }),
    run: (app, arg) => app.mutate('Remove specimen', (doc) => M.removeSpecimen(doc, String(arg)), { scope: 'specimens' }),
  },
  {
    id: 'specimen.setTitle', label: 'Rename a specimen', group: 'Specimens', palette: false, control: true,
    mutates: true, sample: (app) => ({ arg: (app.proof.specimens[0] || {}).id || 'sp_none', value: 'Home page' }),
    run: (app, arg, ctx) => app.mutate('Rename specimen', (doc) => M.setSpecimenTitle(doc, String(arg), value(ctx)), {
      coalesceKey: `specimen.setTitle:${arg}`, scope: 'specimens',
    }),
  },
  {
    id: 'specimen.setKind', label: 'Set a specimen kind', group: 'Specimens', palette: false, control: true,
    mutates: true, sample: (app) => ({ arg: (app.proof.specimens[0] || {}).id || 'sp_none', value: 'article' }),
    run: (app, arg, ctx) => app.mutate('Set specimen kind', (doc) => M.setSpecimenKind(doc, String(arg), value(ctx)), { scope: 'specimens' }),
  },
  {
    id: 'specimen.restore', label: 'Restore a stripped block', group: 'Specimens', palette: false, control: true,
    mutates: true, sample: (app) => {
      const s = app.proof.specimens.find((x) => M.strippedBlocks(x).length);
      return { arg: s ? `${s.id}:0` : 'sp_none:0' };
    },
    run: (app, arg) => {
      const { id, index } = idIndex(arg);
      const specimen = M.findSpecimen(app.proof, id);
      if (!specimen) return undefined;
      const entry = M.strippedBlocks(specimen)[index];
      if (!entry) return undefined;
      const restored = app.services.restoreStripped(specimen, entry);
      if (!restored.ok) { app.notify('bad', restored.error, { sticky: true }); return undefined; }
      return app.mutate('Restore stripped block', (doc) => M.replaceSpecimen(doc, restored.value), { scope: 'specimens' });
    },
  },
  {
    id: 'specimen.restoreAll', label: 'Restore every stripped block', group: 'Specimens', palette: false, control: true,
    mutates: true, sample: (app) => {
      const s = app.proof.specimens.find((x) => M.strippedBlocks(x).length) || app.proof.specimens[0];
      return { arg: s ? s.id : 'sp_none' };
    },
    run: (app, arg) => {
      const specimen = M.findSpecimen(app.proof, String(arg));
      if (!specimen) return undefined;
      const restored = app.services.restoreAllStripped(specimen);
      if (!restored.ok) { app.notify('bad', restored.error, { sticky: true }); return undefined; }
      return app.mutate('Restore stripped blocks', (doc) => M.replaceSpecimen(doc, restored.value), { scope: 'specimens' });
    },
  },
  {
    id: 'specimen.rawOptIn', label: 'Allow raw HTML for a specimen', group: 'Specimens', palette: false, control: true,
    mutates: true, sample: (app) => ({ arg: (app.proof.specimens[0] || {}).id || 'sp_none', value: true }),
    run: (app, arg, ctx) => {
      const specimen = M.findSpecimen(app.proof, String(arg));
      if (!specimen) return undefined;
      const who = operator(app);
      if (checked(ctx) && !who) {
        app.notify('warn', 'Put your name in Settings first — §8 records who opted a specimen into raw HTML, and when.');
        return undefined;
      }
      const next = app.services.setRawOptIn(specimen, checked(ctx), who || 'studio user');
      if (!next.ok) { app.notify('bad', next.error, { sticky: true }); return undefined; }
      return app.mutate(
        checked(ctx) ? 'Allow raw HTML' : 'Withdraw raw HTML opt-in',
        (doc) => M.replaceSpecimen(doc, next.value),
        { scope: 'specimens' },
      );
    },
  },
  {
    id: 'specimen.setBlockText', label: 'Edit a block', group: 'Specimens', palette: false, control: true,
    mutates: true, sample: (app) => {
      const s = app.proof.specimens.find((x) => (x.blocks || []).length);
      return { arg: s ? `${s.id}:0` : 'sp_none:0', value: 'Edited copy' };
    },
    run: (app, arg, ctx) => {
      const { id, index } = idIndex(arg);
      const specimen = M.findSpecimen(app.proof, id);
      if (!specimen || !(specimen.blocks || [])[index]) return undefined;
      const blocks = specimen.blocks.slice();
      blocks[index] = M.applyBlockText(blocks[index], value(ctx));
      const edited = app.services.editSpecimenBlocks(specimen, blocks, `block ${index + 1} edited in the studio`);
      if (!edited.ok) { app.notify('bad', edited.error, { sticky: true }); return undefined; }
      return app.mutate('Edit specimen block', (doc) => M.replaceSpecimen(doc, edited.value), {
        coalesceKey: `specimen.setBlockText:${id}:${index}`, scope: 'specimens',
      });
    },
  },
  {
    id: 'specimen.removeBlock', label: 'Delete a block', group: 'Specimens', palette: false, control: true,
    mutates: true, sample: (app) => {
      const s = app.proof.specimens.find((x) => (x.blocks || []).length);
      return { arg: s ? `${s.id}:0` : 'sp_none:0' };
    },
    run: (app, arg) => {
      const { id, index } = idIndex(arg);
      return app.mutate('Delete block', (doc) => M.removeBlockAt(doc, id, index), { scope: 'specimens' });
    },
  },
  {
    id: 'specimen.moveBlock', label: 'Move a block', group: 'Specimens', palette: false, control: true,
    mutates: true, sample: (app) => {
      const s = app.proof.specimens.find((x) => (x.blocks || []).length > 1);
      return { arg: s ? `${s.id}:1:-1` : 'sp_none:1:-1' };
    },
    run: (app, arg) => {
      const parts = String(arg).split(':');
      const delta = Number(parts.pop());
      const index = Number(parts.pop());
      const id = parts.join(':');
      return app.mutate('Move block', (doc) => M.moveBlock(doc, id, index, index + delta), { scope: 'specimens' });
    },
  },

  // ---- recipes and renditions -------------------------------------------

  {
    id: 'recipe.loadSeed', label: 'Load the eight seed recipes', group: 'Recipes',
    mutates: true, sample: () => ({}),
    run: (app) => {
      const recipes = app.services.seedRecipes();
      if (!recipes.length) {
        app.notify('bad', 'The recipe lane is not wired into this build, so the seed library is unavailable.');
        return undefined;
      }
      return app.mutate('Load seed recipes', (doc) => M.addRecipes(doc, recipes), { scope: 'recipes' });
    },
  },
  {
    id: 'recipe.select', label: 'Select a recipe', group: 'Recipes', palette: false, control: true,
    run: (app, arg, ctx) => {
      const id = String(value(ctx) || arg || '');
      if (id) app.select({ recipeId: id });
    },
  },
  {
    id: 'recipe.remove', label: 'Remove a recipe', group: 'Recipes', palette: false, control: true,
    mutates: true, sample: (app) => ({ arg: (app.proof.recipes[0] || {}).id || 'rc_none' }),
    run: (app, arg) => app.mutate('Remove recipe', (doc) => M.removeRecipe(doc, String(arg)), { scope: 'recipes' }),
  },
  {
    id: 'rendition.pasteDraft', label: 'Paste a rendition', group: 'Recipes', palette: false, control: true,
    run: (app, _arg, ctx) => app.setDraft('rendition.paste', value(ctx)),
  },
  {
    id: 'rendition.labelDraft', label: 'Name a rendition', group: 'Recipes', palette: false, control: true,
    run: (app, _arg, ctx) => app.setDraft('rendition.label', value(ctx)),
  },
  {
    id: 'rendition.create', label: 'Create a rendition from the paste', group: 'Recipes',
    mutates: true, sample: (app) => {
      app.setDraft('rendition.paste', 'A pasted rendition paragraph.');
      app.setDraft('rendition.label', 'de-DE');
      return {};
    },
    run: (app) => {
      const specimen = currentSpecimen(app) || (app.proof.specimens || [])[0];
      const recipe = (app.proof.recipes || []).find((r) => r.id === sel(app).recipeId) || (app.proof.recipes || [])[0];
      const text = String(app.draft('rendition.paste', ''));
      if (!specimen) { app.notify('warn', 'Select a specimen first — a rendition is the "after" of something.'); return undefined; }
      if (!recipe) { app.notify('warn', 'Load the recipe library and pick a recipe first.'); return undefined; }
      if (!text.trim()) { app.notify('warn', 'Paste the rendition on the right first.'); return undefined; }
      const blocks = app.services.parsePasted(text);
      const built = app.services.buildRendition({
        specimen, recipe,
        label: String(app.draft('rendition.label', '')).trim() || (recipe.outputLabels || [])[0] || 'Rendition',
        blocks, media: [], producedBy: 'manual-paste',
      });
      if (!built.ok) { app.notify('bad', built.error, { sticky: true }); return undefined; }
      app.setDraft('rendition.paste', '');
      app.select({ renditionId: built.value.id });
      return app.mutate('Add rendition', (doc) => M.addRendition(doc, built.value), { scope: 'recipes' });
    },
  },
  {
    id: 'rendition.select', label: 'Select a rendition', group: 'Recipes', palette: false, control: true,
    run: (app, arg) => { app.select({ renditionId: String(arg) }); },
  },
  {
    id: 'rendition.remove', label: 'Remove a rendition', group: 'Recipes', palette: false, control: true,
    mutates: true, sample: (app) => ({ arg: (app.proof.renditions[0] || {}).id || 'rd_none' }),
    run: (app, arg) => app.mutate('Remove rendition', (doc) => M.removeRendition(doc, String(arg)), { scope: 'recipes' }),
  },
  {
    id: 'rendition.setLabel', label: 'Rename a rendition', group: 'Recipes', palette: false, control: true,
    mutates: true, sample: (app) => ({ arg: (app.proof.renditions[0] || {}).id || 'rd_none', value: 'fr-FR' }),
    run: (app, arg, ctx) => app.mutate('Rename rendition', (doc) => M.setRenditionLabel(doc, String(arg), value(ctx)), {
      coalesceKey: `rendition.setLabel:${arg}`, scope: 'recipes',
    }),
  },
  {
    id: 'rendition.setNotes', label: 'Note a rendition', group: 'Recipes', palette: false, control: true,
    mutates: true, sample: (app) => ({ arg: (app.proof.renditions[0] || {}).id || 'rd_none', value: 'From their own CMS.' }),
    run: (app, arg, ctx) => app.mutate('Note rendition', (doc) => M.setRenditionNotes(doc, String(arg), value(ctx)), {
      coalesceKey: `rendition.setNotes:${arg}`, scope: 'recipes',
    }),
  },
  {
    id: 'rendition.clientSupplied', label: 'Mark a rendition client-supplied', group: 'Recipes', palette: false, control: true,
    mutates: true, sample: (app) => ({ arg: (app.proof.renditions[0] || {}).id || 'rd_none', value: true }),
    run: (app, arg, ctx) => app.mutate(
      checked(ctx) ? 'Mark client-supplied' : 'Mark illustrative',
      (doc) => M.setRenditionClientSupplied(doc, String(arg), checked(ctx)),
      { scope: 'recipes' },
    ),
  },
  {
    id: 'rendition.promote', label: 'Promote a rendition to verified', group: 'Recipes', palette: false, control: true,
    mutates: true, sample: (app) => ({ arg: (app.proof.renditions[0] || {}).id || 'rd_none' }),
    run: (app, arg) => {
      const rendition = M.findRendition(app.proof, String(arg));
      if (!rendition) return undefined;
      const who = operator(app);
      if (!who) {
        app.notify('warn', 'Put your name in Settings first. §9 records who promoted a rendition and when — promotion without a name is not a record.');
        return undefined;
      }
      const promoted = app.services.promoteProvenance(rendition, who);
      if (!promoted.ok) { app.notify('bad', promoted.error, { sticky: true }); return undefined; }
      app.notify('ok', `Promoted “${rendition.label}” to verified-by-user, recorded against ${who}.`);
      return app.mutate('Promote rendition to verified', (doc) => M.replaceRendition(doc, promoted.value), { scope: 'recipes' });
    },
  },
  {
    id: 'rendition.runAdapter', label: 'Generate with the configured adapter', group: 'Recipes',
    mutates: true, sample: () => ({}),
    run: async (app) => {
      const specimen = currentSpecimen(app) || (app.proof.specimens || [])[0];
      const recipe = (app.proof.recipes || []).find((r) => r.id === sel(app).recipeId) || (app.proof.recipes || [])[0];
      if (!specimen || !recipe) { app.notify('warn', 'Pick a specimen and a recipe first.'); return; }
      const result = await app.services.runAdapter(recipe, specimen, {
        endpoint: app.ui.settings.adapterEndpoint, key: app.ui.settings.adapterKey,
      });
      if (!result.ok) { app.notify('bad', result.error, { sticky: true }); return; }
      app.mutate('Add adapter rendition', (doc) => M.addRendition(doc, result.value), { scope: 'recipes' });
      app.notify('warn', 'Adapter output is stamped illustrative. It carries a visible label in the artifact until you check it and promote it yourself.');
    },
  },

  // ---- scenes ------------------------------------------------------------

  {
    id: 'scene.add', label: 'Add a scene', group: 'Scenes', palette: false, control: true,
    mutates: true, sample: () => ({ arg: 'splitBeforeAfter' }),
    run: (app, arg) => {
      const layout = SCENE_LAYOUTS.includes(/** @type {any} */ (arg)) ? String(arg) : 'splitBeforeAfter';
      const id = mint(app, 'scene', { layout, n: (app.proof.spine || []).length });
      const specimen = currentSpecimen(app);
      const scene = M.newScene({ id, layout: /** @type {any} */ (layout), headline: null });
      const withSpecimen = specimen ? { ...scene, specimenId: specimen.id } : scene;
      app.select({ sceneId: id, beatIndex: 0 });
      return app.mutate('Add scene', (doc) => M.addScene(doc, withSpecimen, null), { scope: 'scenes' });
    },
  },
  {
    id: 'scene.addFromTemplate', label: 'Add a scene from a template…', group: 'Scenes',
    mutates: true, sample: () => ({}),
    run: (app) => app.dispatch('scene.add', 'splitBeforeAfter'),
  },
  {
    id: 'scene.select', label: 'Select a scene', group: 'Scenes', palette: false, control: true,
    run: (app, arg) => { app.select({ sceneId: String(arg), beatIndex: 0 }); },
  },
  {
    id: 'scene.remove', label: 'Remove a scene', group: 'Scenes', palette: false, control: true,
    mutates: true, sample: (app) => ({ arg: (app.proof.spine[0] || {}).id || 'sc_none' }),
    run: (app, arg) => app.mutate('Remove scene', (doc) => M.removeScene(doc, String(arg)), { scope: 'scenes' }),
  },
  {
    id: 'scene.move', label: 'Move a scene', group: 'Scenes', palette: false, control: true,
    mutates: true, sample: (app) => ({ arg: `${(app.proof.spine[1] || app.proof.spine[0] || {}).id || 'sc_none'}:-1` }),
    run: (app, arg) => {
      const { id, index } = idIndex(arg);
      return app.mutate('Move scene', (doc) => M.moveScene(doc, id, index), { scope: 'scenes' });
    },
  },
  {
    id: 'scene.setHeadline', label: 'Set a scene headline', group: 'Scenes', palette: false, control: true,
    mutates: true, sample: (app) => ({ arg: (app.proof.spine[0] || {}).id || 'sc_none', value: 'Your own pages, in nine markets' }),
    run: (app, arg, ctx) => app.mutate('Set headline', (doc) => M.patchScene(doc, String(arg), { headline: value(ctx) || null }), {
      coalesceKey: `scene.setHeadline:${arg}`, scope: 'scenes',
    }),
  },
  {
    id: 'scene.setSubhead', label: 'Set a scene subhead', group: 'Scenes', palette: false, control: true,
    mutates: true, sample: (app) => ({ arg: (app.proof.spine[0] || {}).id || 'sc_none', value: 'Same system, nine locales' }),
    run: (app, arg, ctx) => app.mutate('Set subhead', (doc) => M.patchScene(doc, String(arg), { subhead: value(ctx) || null }), {
      coalesceKey: `scene.setSubhead:${arg}`, scope: 'scenes',
    }),
  },
  {
    id: 'scene.setLayout', label: 'Set a scene layout', group: 'Scenes', palette: false, control: true,
    mutates: true, sample: (app) => ({ arg: (app.proof.spine[0] || {}).id || 'sc_none', value: 'fanOut' }),
    run: (app, arg, ctx) => app.mutate('Set layout', (doc) => M.patchScene(doc, String(arg), {
      layout: /** @type {any} */ (value(ctx)),
    }), { scope: 'scenes' }),
  },
  {
    id: 'scene.setSpecimen', label: 'Set a scene specimen', group: 'Scenes', palette: false, control: true,
    mutates: true, sample: (app) => ({
      arg: (app.proof.spine[0] || {}).id || 'sc_none',
      value: (app.proof.specimens[0] || {}).id || '',
    }),
    run: (app, arg, ctx) => app.mutate('Set scene specimen', (doc) => M.patchScene(doc, String(arg), {
      specimenId: value(ctx) || null,
    }), { scope: 'scenes' }),
  },
  {
    id: 'scene.toggleRendition', label: 'Attach or detach a rendition', group: 'Scenes', palette: false, control: true,
    mutates: true, sample: (app) => ({
      arg: `${(app.proof.spine[0] || {}).id || 'sc_none'}|${(app.proof.renditions[0] || {}).id || 'rd_none'}`,
    }),
    run: (app, arg) => {
      const [sceneId, renditionId] = String(arg).split('|');
      return app.mutate('Toggle rendition', (doc) => M.toggleSceneRendition(doc, sceneId, renditionId), { scope: 'scenes' });
    },
  },
  {
    id: 'scene.toggleAnchor', label: 'Offer a branch from this scene', group: 'Scenes', palette: false, control: true,
    mutates: true, sample: (app) => ({
      arg: `${(app.proof.spine[0] || {}).id || 'sc_none'}|${(app.proof.branches[0] || {}).id || 'bn_none'}`,
    }),
    run: (app, arg) => {
      const [sceneId, branchId] = String(arg).split('|');
      return app.mutate('Toggle branch anchor', (doc) => M.toggleBranchAnchor(doc, sceneId, branchId), { scope: 'scenes' });
    },
  },
  {
    id: 'beat.add', label: 'Add a beat', group: 'Scenes', palette: false, control: true,
    mutates: true, sample: (app) => ({ arg: (app.proof.spine[0] || {}).id || 'sc_none' }),
    run: (app, arg) => app.mutate('Add beat', (doc) => M.addBeat(doc, String(arg)), { scope: 'scenes' }),
  },
  {
    id: 'beat.remove', label: 'Remove a beat', group: 'Scenes', palette: false, control: true,
    mutates: true, sample: (app) => {
      const s = app.proof.spine.find((x) => (x.beats || []).length > 1) || app.proof.spine[0];
      return { arg: s ? `${s.id}:1` : 'sc_none:1' };
    },
    run: (app, arg) => {
      const { id, index } = idIndex(arg);
      return app.mutate('Remove beat', (doc) => M.removeBeat(doc, id, index), { scope: 'scenes' });
    },
  },
  {
    id: 'beat.move', label: 'Move a beat', group: 'Scenes', palette: false, control: true,
    mutates: true, sample: (app) => {
      const s = app.proof.spine.find((x) => (x.beats || []).length > 1) || app.proof.spine[0];
      return { arg: s ? `${s.id}:1:-1` : 'sc_none:1:-1' };
    },
    run: (app, arg) => {
      const parts = String(arg).split(':');
      const delta = Number(parts.pop());
      const index = Number(parts.pop());
      return app.mutate('Move beat', (doc) => M.moveBeat(doc, parts.join(':'), index, delta), { scope: 'scenes' });
    },
  },
  {
    id: 'beat.select', label: 'Select a beat', group: 'Scenes', palette: false, control: true,
    run: (app, arg) => {
      const { id, index } = idIndex(arg);
      app.select({ sceneId: id, beatIndex: index });
      if (app.preview.runtime) app.preview.runtime.go({ type: 'goToBeat', sceneId: id, beatIndex: index });
    },
  },
  {
    id: 'beat.toggleReveal', label: 'Toggle what a beat reveals', group: 'Scenes', palette: false, control: true,
    mutates: true, sample: (app) => {
      const s = app.proof.spine[0];
      const el = s ? M.pathElementId(s.id, 'block/0') : 'el_none';
      return { arg: s ? `${s.id}:0|${el}` : `sc_none:0|${el}` };
    },
    run: (app, arg) => {
      const [head, elementId] = String(arg).split('|');
      const { id, index } = idIndex(head);
      return app.mutate('Toggle reveal', (doc) => M.toggleBeatReveal(doc, id, index, elementId), { scope: 'scenes' });
    },
  },
  {
    id: 'beat.setNote', label: 'Write a presenter note', group: 'Scenes', palette: false, control: true,
    mutates: true, sample: (app) => ({
      arg: `${(app.proof.spine[0] || {}).id || 'sc_none'}:0`,
      value: 'Name the objection before they do.',
    }),
    run: (app, arg, ctx) => {
      const { id, index } = idIndex(arg);
      return app.mutate('Write presenter note', (doc) => M.patchBeat(doc, id, index, {
        presenterNote: value(ctx) || null,
      }), { coalesceKey: `beat.setNote:${arg}`, scope: 'scenes' });
    },
  },
  {
    id: 'beat.setDwell', label: 'Set a pacing hint', group: 'Scenes', palette: false, control: true,
    mutates: true, sample: (app) => ({ arg: `${(app.proof.spine[0] || {}).id || 'sc_none'}:0`, value: '20' }),
    run: (app, arg, ctx) => {
      const { id, index } = idIndex(arg);
      const seconds = Number(value(ctx));
      return app.mutate('Set pacing hint', (doc) => M.patchBeat(doc, id, index, {
        dwellHintMs: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null,
      }), { coalesceKey: `beat.setDwell:${arg}`, scope: 'scenes' });
    },
  },

  // ---- branches ----------------------------------------------------------

  {
    id: 'branch.objectionDraft', label: 'Type an objection', group: 'Branches', palette: false, control: true,
    run: (app, _arg, ctx) => app.setDraft('branch.objection', value(ctx)),
  },
  {
    id: 'branch.create', label: 'Create a branch from an objection', group: 'Branches',
    mutates: true, sample: (app) => {
      app.setDraft('branch.objection', 'Our approvals process would never allow this');
      return {};
    },
    run: (app) => {
      const objection = String(app.draft('branch.objection', '')).trim();
      if (!objection) { app.notify('warn', 'Write the objection in the client’s own words first — that phrasing is what the jump index searches.'); return undefined; }
      const id = mint(app, 'branch', { objection });
      const sceneId = M.mintId('scene', app.doc.seed, new Set([...M.usedIds(app.proof), id]), { branch: objection });
      const branch = {
        id,
        objection,
        aliases: [],
        scenes: [M.newScene({ id: sceneId, layout: 'sideNote', headline: objection })],
        returnPolicy: /** @type {any} */ ('anchor'),
      };
      app.setDraft('branch.objection', '');
      app.select({ branchId: id, sceneId });
      return app.mutate('Create branch', (doc) => M.addBranch(doc, branch), { scope: 'branches' });
    },
  },
  {
    id: 'branch.select', label: 'Select a branch', group: 'Branches', palette: false, control: true,
    run: (app, arg) => { app.select({ branchId: String(arg) }); },
  },
  {
    id: 'branch.remove', label: 'Remove a branch', group: 'Branches', palette: false, control: true,
    mutates: true, sample: (app) => ({ arg: (app.proof.branches[0] || {}).id || 'bn_none' }),
    run: (app, arg) => app.mutate('Remove branch', (doc) => M.removeBranch(doc, String(arg)), { scope: 'branches' }),
  },
  {
    id: 'branch.setObjection', label: 'Edit a branch objection', group: 'Branches', palette: false, control: true,
    mutates: true, sample: (app) => ({ arg: (app.proof.branches[0] || {}).id || 'bn_none', value: 'Legal reviews every claim' }),
    run: (app, arg, ctx) => app.mutate('Edit objection', (doc) => M.patchBranch(doc, String(arg), { objection: value(ctx) }), {
      coalesceKey: `branch.setObjection:${arg}`, scope: 'branches',
    }),
  },
  {
    id: 'branch.aliasDraft', label: 'Type an alias', group: 'Branches', palette: false, control: true,
    run: (app, _arg, ctx) => app.setDraft('branch.alias', value(ctx)),
  },
  {
    id: 'branch.addAlias', label: 'Add an alias to a branch', group: 'Branches', palette: false, control: true,
    mutates: true, sample: (app) => {
      app.setDraft('branch.alias', 'sign-off');
      return { arg: (app.proof.branches[0] || {}).id || 'bn_none' };
    },
    run: (app, arg) => {
      const alias = String(app.draft('branch.alias', '')).trim();
      if (!alias) return undefined;
      app.setDraft('branch.alias', '');
      return app.mutate('Add alias', (doc) => M.addBranchAlias(doc, String(arg), alias), { scope: 'branches' });
    },
  },
  {
    id: 'branch.removeAlias', label: 'Remove an alias', group: 'Branches', palette: false, control: true,
    mutates: true, sample: (app) => {
      const b = app.proof.branches.find((x) => (x.aliases || []).length) || app.proof.branches[0];
      return { arg: b ? `${b.id}:0` : 'bn_none:0' };
    },
    run: (app, arg) => {
      const { id, index } = idIndex(arg);
      return app.mutate('Remove alias', (doc) => M.removeBranchAlias(doc, id, index), { scope: 'branches' });
    },
  },
  {
    id: 'branch.setReturnPolicy', label: 'Set a branch return policy', group: 'Branches', palette: false, control: true,
    mutates: true, sample: (app) => ({ arg: (app.proof.branches[0] || {}).id || 'bn_none', value: 'nextSpineScene' }),
    run: (app, arg, ctx) => app.mutate('Set return policy', (doc) => M.patchBranch(doc, String(arg), {
      returnPolicy: /** @type {any} */ (value(ctx) === 'nextSpineScene' ? 'nextSpineScene' : 'anchor'),
    }), { scope: 'branches' }),
  },
  {
    id: 'branch.addScene', label: 'Add a scene to a branch', group: 'Branches', palette: false, control: true,
    mutates: true, sample: (app) => ({ arg: (app.proof.branches[0] || {}).id || 'bn_none' }),
    run: (app, arg) => {
      const branchId = String(arg);
      const branch = M.findBranch(app.proof, branchId);
      if (!branch) return undefined;
      const id = mint(app, 'scene', { branch: branchId, n: (branch.scenes || []).length });
      app.select({ sceneId: id, branchId });
      return app.mutate('Add branch scene', (doc) => M.addScene(doc, M.newScene({
        id, layout: 'sideNote', headline: null,
      }), branchId), { scope: 'branches' });
    },
  },
  {
    id: 'branch.anchorTo', label: 'Anchor a branch to a spine scene', group: 'Branches', palette: false, control: true,
    mutates: true, sample: (app) => ({
      arg: `${(app.proof.branches[0] || {}).id || 'bn_none'}|${(app.proof.spine[0] || {}).id || 'sc_none'}`,
    }),
    run: (app, arg) => {
      const [branchId, sceneId] = String(arg).split('|');
      return app.mutate('Anchor branch', (doc) => M.toggleBranchAnchor(doc, sceneId, branchId), { scope: 'branches' });
    },
  },
  {
    id: 'branch.jumpTest', label: 'Test the jump index', group: 'Branches', palette: false, control: true,
    run: (app, _arg, ctx) => app.setDraft('branch.jumpQuery', value(ctx)),
  },

  // ---- rehearse ----------------------------------------------------------

  {
    id: 'rehearse.sweep', label: 'Run the rehearsal sweep', group: 'Rehearse', keys: ['Alt+r'],
    run: async (app) => {
      app.ui.sweep = { ...app.ui.sweep, running: true, error: null };
      app.render();
      const result = await app.services.runPreflight(app.proof);
      if (!result.ok) {
        app.ui.sweep = { findings: [], at: null, running: false, error: result.error, proofHash: null };
        app.notify('bad', result.error, { sticky: true });
        return;
      }
      app.ui.sweep = {
        findings: result.value,
        at: app.clock(),
        running: false,
        error: null,
        proofHash: proofDigest(app.proof),
      };
      const blocking = result.value.filter((f) => f.severity === 1).length;
      app.notify(
        blocking ? 'bad' : 'ok',
        blocking
          ? `${blocking} blocking finding${blocking === 1 ? '' : 's'}. The emit stays closed until every one is gone.`
          : `Sweep clean across ${result.value.length} check${result.value.length === 1 ? '' : 's'}.`,
      );
    },
  },
  {
    id: 'rehearse.goToLocus', label: 'Go to a finding', group: 'Rehearse', palette: false, control: true,
    run: (app, arg) => {
      const finding = app.ui.sweep.findings.find((f) => f.id === String(arg));
      if (!finding) return;
      const locus = finding.locus || {};
      if (locus.sceneId) {
        app.select({ sceneId: locus.sceneId });
        app.setUi({ section: 'scenes' });
        if (app.preview.runtime && app.preview.runtime.deck.sceneById.has(locus.sceneId)) {
          app.preview.runtime.go({ type: 'goToScene', sceneId: locus.sceneId });
        }
      } else if (locus.branchId) {
        app.select({ branchId: locus.branchId });
        app.setUi({ section: 'branches' });
      } else if (locus.specimenId) {
        app.select({ specimenId: locus.specimenId });
        app.setUi({ section: 'specimens' });
      } else {
        app.setUi({ section: 'brand' });
      }
    },
  },
  {
    id: 'rehearse.autoFix', label: 'Apply an auto-fix', group: 'Rehearse', palette: false, control: true,
    mutates: true, sample: () => ({ arg: '0' }),
    run: (app, arg) => {
      const fixes = app.services.autoFixes(app.proof, app.ui.sweep.findings);
      const fix = fixes[Number(arg) || 0];
      if (!fix) { app.notify('warn', 'That fix is no longer available — re-run the sweep.'); return undefined; }
      const next = app.mutate(`Auto-fix: ${fix.label}`, (doc) => ({ ...doc, proof: fix.apply(doc.proof) }), {
        scope: 'rehearse',
        meta: { autoFix: true, code: fix.finding ? fix.finding.code : null, label: fix.label },
      });
      app.ui.fixes = [...app.ui.fixes, fix.label];
      app.notify('ok', `Applied: ${fix.label}. It is on the undo stack like any other edit.`);
      return next;
    },
  },
  {
    id: 'rehearse.revertFixes', label: 'Undo every auto-fix', group: 'Rehearse',
    run: (app) => {
      const history = app.stack.history();
      const hasFix = history.some((h) => h.meta && /** @type {any} */ (h.meta).autoFix);
      if (!hasFix) { app.notify('warn', 'No auto-fixes have been applied.'); return; }
      app.stack.undoUntil((entry) => !(entry.meta && /** @type {any} */ (entry.meta).autoFix));
      app.ui.fixes = [];
      app.scheduleSave();
      app.notify('ok', 'Every auto-fix has been undone.');
    },
  },
  {
    id: 'rehearse.dryRun', label: 'Start a dry run', group: 'Rehearse', keys: ['Alt+d'],
    run: async (app) => {
      if (app.ui.dryRun.active) { app.setUi({ dryRun: { ...app.ui.dryRun, active: false } }); return; }
      const positions = [];
      const result = await app.services.dryRun(app.proof, (pos) => positions.push(pos));
      if (!result.ok) { app.notify('bad', result.error, { sticky: true }); return; }
      app.setUi({
        dryRun: { active: true, index: 0, positions, findings: result.value.findings || [] },
        layout: 'split',
      });
      if (positions[0] && positions[0].sceneId && app.preview.runtime) {
        app.preview.runtime.go({ type: 'goToScene', sceneId: positions[0].sceneId });
      }
      app.notify('ok', `Dry run over ${positions.length} positions. The counter tracks what would still be wrong when you walk in.`);
    },
  },
  {
    id: 'rehearse.dryRunStep', label: 'Step the dry run', group: 'Rehearse', palette: false, control: true,
    run: (app, arg) => {
      const dry = app.ui.dryRun;
      if (!dry.active || !dry.positions.length) return;
      const next = Math.max(0, Math.min(dry.positions.length - 1, dry.index + (Number(arg) || 1)));
      app.setUi({ dryRun: { ...dry, index: next } });
      const pos = dry.positions[next];
      if (pos && pos.sceneId && app.preview.runtime && app.preview.runtime.deck.sceneById.has(pos.sceneId)) {
        app.preview.runtime.go({ type: 'goToBeat', sceneId: pos.sceneId, beatIndex: pos.beatIndex || 0 });
        app.select({ sceneId: pos.sceneId, beatIndex: pos.beatIndex || 0 });
      }
    },
  },
  {
    id: 'rehearse.dryRunStop', label: 'Stop the dry run', group: 'Rehearse',
    run: (app) => { app.setUi({ dryRun: { active: false, index: 0, positions: [], findings: [] } }); },
  },

  // ---- emit --------------------------------------------------------------

  {
    id: 'emit.setMode', label: 'Set the emit mode', group: 'Emit', palette: false, control: true,
    mutates: true, sample: () => ({ arg: 'review' }),
    run: (app, arg) => app.mutate('Set emit mode', (doc) => M.setEmitOptions(doc, {
      mode: /** @type {any} */ (String(arg)),
    }), { scope: 'emit' }),
  },
  {
    id: 'emit.setNotes', label: 'Include presenter notes', group: 'Emit', palette: false, control: true,
    mutates: true, sample: () => ({ value: false }),
    run: (app, _arg, ctx) => app.mutate('Set presenter notes', (doc) => M.setEmitOptions(doc, {
      includePresenterNotes: checked(ctx),
    }), { scope: 'emit' }),
  },
  {
    id: 'emit.setQuality', label: 'Set the image quality', group: 'Emit', palette: false, control: true,
    mutates: true, sample: () => ({ arg: '0.75' }),
    run: (app, arg) => app.mutate('Set image quality', (doc) => M.setEmitOptions(doc, {
      imageQuality: /** @type {any} */ (Number(arg)),
    }), { scope: 'emit' }),
  },
  {
    id: 'emit.setMaxBytes', label: 'Set the size budget', group: 'Emit', palette: false, control: true,
    mutates: true, sample: () => ({ value: '18' }),
    run: (app, _arg, ctx) => {
      const mb = Number(value(ctx));
      if (!Number.isFinite(mb) || mb <= 0) return undefined;
      return app.mutate('Set size budget', (doc) => M.setEmitOptions(doc, { maxBytes: Math.round(mb * 1000000) }), {
        coalesceKey: 'emit.setMaxBytes', scope: 'emit',
      });
    },
  },
  {
    id: 'emit.run', label: 'Emit the proof', group: 'Emit', keys: ['Mod+Enter'],
    run: async (app) => {
      // §14: the only route to the emitter, and it is closed while anything
      // blocks. There is no argument, flag or second path that opens it.
      const gate = emitBlockers(app);
      if (!gate.canEmit) {
        app.setUi({ section: 'emit' });
        app.notify('bad', `Emit refused: ${gate.blockers[0].message}`, { sticky: true });
        return;
      }
      app.ui.emit = { result: null, running: true, error: null, at: null };
      app.render();
      const result = await app.services.emit(app.proof, app.proof.emitOptions);
      if (!result.ok) {
        app.ui.emit = { result: null, running: false, error: result.error, at: null };
        app.notify('bad', result.error, { sticky: true });
        return;
      }
      const emitted = result.value;
      const blocking = (emitted.findings || []).filter((f) => f.severity === 1);
      if (blocking.length) {
        app.ui.emit = { result: emitted, running: false, error: null, at: app.clock() };
        app.ui.sweep = {
          findings: emitted.findings, at: app.clock(), running: false, error: null, proofHash: proofDigest(app.proof),
        };
        app.notify('bad', `The emitter refused: ${blocking[0].code} — ${blocking[0].message}`, { sticky: true });
        return;
      }
      app.ui.emit = { result: emitted, running: false, error: null, at: app.clock() };
      app.notify('ok', `Emitted ${(emitted.bytes / 1000000).toFixed(2)} MB. Open it with networking off before you rely on it.`);
    },
  },
  {
    id: 'emit.download', label: 'Save the emitted file', group: 'Emit',
    enabled: (app) => !!(app.ui.emit.result && app.ui.emit.result.html),
    run: (app) => {
      const emitted = app.ui.emit.result;
      if (!emitted) return;
      const result = downloadText({
        document: app.document, window: app.window,
        filename: safeFilename(app.proof.prospectName || app.doc.name, '.pitchproof.html'),
        text: emitted.html, mime: 'text/html',
      });
      if (result.ok) app.notify('ok', `Saved ${result.value.filename}.`);
      else app.notify('bad', result.error, { sticky: true });
    },
  },
  {
    id: 'emit.budget', label: 'Recompute the size budget', group: 'Emit',
    run: (app) => {
      const plan = app.services.budgetAssets(app.proof, app.proof.emitOptions.maxBytes);
      if (!plan) { app.notify('warn', 'The emitter is not wired into this build, so the budget cannot be computed.'); return; }
      app.setDraft('emit.plan', plan.plan);
      app.notify('ok', `${plan.plan.length} asset${plan.plan.length === 1 ? '' : 's'} would be degraded to fit the budget.`);
    },
  },

  // ---- settings ----------------------------------------------------------

  {
    id: 'settings.setProxy', label: 'Set the CORS proxy base', group: 'Settings', palette: false, control: true,
    run: (app, _arg, ctx) => app.setSetting(SETTING_KEYS.proxyBase, value(ctx)),
  },
  {
    id: 'settings.setAdapterEndpoint', label: 'Set the adapter endpoint', group: 'Settings', palette: false, control: true,
    run: (app, _arg, ctx) => app.setSetting(SETTING_KEYS.adapterEndpoint, value(ctx)),
  },
  {
    id: 'settings.setAdapterKey', label: 'Set the adapter key', group: 'Settings', palette: false, control: true,
    run: (app, _arg, ctx) => app.setSetting(SETTING_KEYS.adapterKey, value(ctx)),
  },
  {
    id: 'settings.clearAdapterKey', label: 'Forget the adapter key', group: 'Settings',
    run: async (app) => {
      await app.setSetting(SETTING_KEYS.adapterKey, '');
      app.notify('ok', 'The adapter key is gone from this machine. It was never in a project export or an emitted artifact.');
    },
  },
  {
    id: 'settings.setOperator', label: 'Set your name', group: 'Settings', palette: false, control: true,
    run: (app, _arg, ctx) => app.setSetting(SETTING_KEYS.operator, value(ctx)),
  },
];

// ---------------------------------------------------------------------------
// Index and invariants
// ---------------------------------------------------------------------------

/**
 * Index the registry and check the invariants the tests rely on. Throwing here
 * rather than in a test means a malformed action cannot even load the studio.
 * @param {any[]} actions
 * @returns {{all: any[], byId: Map<string, any>, withKeys: any[], inPalette: any[], mutating: any[], byGroup: Map<string, any[]>}}
 */
export function actionIndex(actions) {
  /** @type {Map<string, any>} */
  const byId = new Map();
  for (const action of actions) {
    if (!action.id || !action.label || !action.group) throw new Error(`ui/actions: an action needs id, label and group (${action.id || '?'})`);
    if (typeof action.run !== 'function') throw new Error(`ui/actions: ${action.id} has no run()`);
    if (byId.has(action.id)) throw new Error(`ui/actions: duplicate action id ${action.id}`);
    if (action.mutates && typeof action.sample !== 'function') {
      throw new Error(`ui/actions: ${action.id} mutates the model, so it must carry a sample() the undo test can drive`);
    }
    if (!action.keys && action.palette === false && !action.control) {
      throw new Error(`ui/actions: ${action.id} has no keyboard route — give it keys, leave it in the palette, or mark it control:true`);
    }
    byId.set(action.id, action);
  }
  /** @type {Map<string, any[]>} */
  const byGroup = new Map();
  for (const action of actions) {
    if (!byGroup.has(action.group)) byGroup.set(action.group, []);
    byGroup.get(action.group).push(action);
  }
  return {
    all: actions,
    byId,
    byGroup,
    withKeys: actions.filter((a) => a.keys && a.keys.length),
    inPalette: actions.filter((a) => a.palette !== false),
    mutating: actions.filter((a) => a.mutates),
  };
}

/**
 * The keyboard route an action has, for the reachability test and for the
 * keyboard reference.
 * @param {any} action
 * @returns {'key'|'palette'|'control'}
 */
export function routeOf(action) {
  if (action.keys && action.keys.length) return 'key';
  if (action.palette !== false) return 'palette';
  return 'control';
}

// ---------------------------------------------------------------------------
// Shared behaviour
// ---------------------------------------------------------------------------

/**
 * @param {any} app
 * @param {number} delta
 */
function stepSection(app, delta) {
  const ids = ['project', 'brand', 'specimens', 'recipes', 'scenes', 'branches', 'rehearse', 'emit', 'settings'];
  const at = ids.indexOf(app.ui.section);
  app.setUi({ section: ids[(at + delta + ids.length) % ids.length] });
}

/**
 * Turn a raw capture into a specimen and commit it.
 * @param {any} app
 * @param {any} capture
 * @param {string} label
 */
function addCapture(app, capture, label) {
  const built = app.services.buildSpecimen(capture, {
    imageQuality: app.proof.emitOptions.imageQuality,
    seed: app.doc.seed,
  });
  if (!built.ok) { app.notify('bad', built.error, { sticky: true }); return; }
  app.select({ specimenId: built.value.id });
  app.mutate(label, (doc) => M.addSpecimen(doc, built.value), { scope: 'specimens' });
}

/**
 * @param {string} text
 * @returns {string|null} a normalized `#RRGGBB`, or null when it is not a hex
 */
export function normalizeHex(text) {
  const raw = String(text || '').trim();
  const match = raw.match(/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (!match) return null;
  const body = match[1];
  const full = body.length === 3 ? body.split('').map((c) => c + c).join('') : body;
  return `#${full.toUpperCase()}`;
}

/**
 * @param {any} brand
 * @param {string} role
 * @returns {string|null}
 */
export function hexOfRole(brand, role) {
  const found = (brand.colors || []).find((c) => c.role === role);
  return found ? found.hex : null;
}

/**
 * The first §4 colour role this brand has not defined, for the "add a role"
 * control.
 * @param {any} brand
 * @returns {string|null}
 */
export function missingRole(brand) {
  const have = new Set((brand.colors || []).map((c) => c.role));
  return COLOR_ROLES.find((r) => !have.has(r)) || null;
}

/** The specimen kinds a user can choose, from the frozen §4 set. */
export const KIND_CHOICES = SPECIMEN_KINDS.map((value_) => ({ value: value_, label: `${value_[0].toUpperCase()}${value_.slice(1)}` }));

export { ok, err };
