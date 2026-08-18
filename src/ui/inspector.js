/**
 * The right inspector (§15).
 *
 * One column, always about the thing that is selected. It is deliberately not a
 * second editor: the panels own editing, and duplicating a field here would
 * create a second place a value can be changed and a second thing to keep in
 * step. What the inspector owns is *the truth about the selection* — its ids,
 * its provenance, its contribution to the deck, and the findings that name it —
 * plus the two or three actions that belong to it wherever you happen to be.
 *
 * @module ui/inspector
 */

import { h, cx } from '../core/vdom.js';
import { badge, button, empty, pair, pairs, section, toolbar } from './components.js';
import { formatBytes, formatDateTime, humanize, plural, truncate } from './format.js';
import {
  findBranch, findRendition, findScene, findSpecimen, rawOptIn, specimenIsEdited, strippedBlocks,
} from './model.js';
import { PROVENANCE_COPY } from './constants.js';
import { KEY_ATTR } from './render.js';
import { revealedAt } from '../runtime/beats.js';

/**
 * @param {any} app
 * @returns {import('../core/vdom.js').VNode}
 */
export function renderInspector(app) {
  return h('aside', { class: 'st-inspector', 'aria-label': 'Inspector' },
    h('header', { class: 'st-inspector-head' },
      h('h2', { class: 'st-inspector-title' }, 'Inspector'),
      button({ act: 'app.inspector', variant: 'quiet', title: 'Hide the inspector (Alt I)' }, '×')),
    h('div', { class: 'st-inspector-body' }, renderBody(app)));
}

/**
 * @param {any} app
 * @returns {import('../core/vdom.js').VNode}
 */
function renderBody(app) {
  const s = app.ui.selection;
  switch (app.ui.section) {
    case 'specimens': return renderSpecimen(app, findSpecimen(app.proof, s.specimenId));
    case 'recipes': return renderRendition(app, findRendition(app.proof, s.renditionId));
    case 'branches': return renderBranch(app, findBranch(app.proof, s.branchId));
    case 'scenes': return renderScene(app, findScene(app.proof, s.sceneId));
    case 'brand': return renderBrand(app);
    case 'rehearse': return renderRehearse(app);
    case 'emit': return renderEmit(app);
    case 'project': return renderProject(app);
    default: return renderProject(app);
  }
}

/** Findings whose locus names an id. @param {any} app @param {string} id */
function findingsFor(app, id) {
  return (app.ui.sweep.findings || []).filter((f) => {
    const l = f.locus || {};
    return l.sceneId === id || l.branchId === id || l.specimenId === id || l.assetId === id;
  });
}

/**
 * @param {any} app
 * @param {string} id
 */
function renderFindings(app, id) {
  const found = findingsFor(app, id);
  if (!found.length) return null;
  return section({ title: `Findings · ${found.length}`, subtitle: 'From the last sweep.' },
    h('ul', { class: 'st-findings st-findings--compact' }, found.map((f) => h('li', {
      class: cx('st-finding', `st-finding--s${f.severity}`), [KEY_ATTR]: f.id,
    },
    badge(f.code, f.severity === 1 ? 'bad' : f.severity === 2 ? 'warn' : 'dim'),
    h('span', { class: 'st-finding-message' }, f.message)))));
}

/**
 * @param {any} app
 * @param {any} specimen
 */
function renderSpecimen(app, specimen) {
  if (!specimen) return empty('Select a specimen to see what was captured and what was stripped.');
  const stripped = strippedBlocks(specimen);
  const opt = rawOptIn(specimen);
  const mediaBytes = (specimen.media || []).reduce((n, m) => n + (m.bytes || 0), 0);
  const usedBy = usedInScenes(app.proof, (scene) => scene.specimenId === specimen.id);

  return h('div', null,
    section({ title: truncate(specimen.title, 34), subtitle: humanize(specimen.kind) },
      pairs(
        pair('Id', h('code', { class: 'st-mono' }, specimen.id)),
        pair('Source', specimen.sourceUrl ? h('code', { class: 'st-mono' }, truncate(specimen.sourceUrl, 34)) : 'a file'),
        pair('Captured', formatDateTime(specimen.capturedAt)),
        pair('Blocks', h('span', { class: 'st-mono' }, String((specimen.blocks || []).length))),
        pair('Words', h('span', { class: 'st-mono' }, String(specimen.wordCount || 0))),
        pair('Media', h('span', { class: 'st-mono' }, `${(specimen.media || []).length} · ${formatBytes(mediaBytes)}`)),
        pair('Stripped', stripped.length ? badge(`${stripped.length} restorable`, 'warn') : badge('none', 'dim')),
        pair('Raw HTML', opt.allowed ? badge('opted in', 'warn') : badge('off', 'dim')),
        pair('Edited', specimenIsEdited(specimen) ? badge('yes — the artifact says so', 'warn') : badge('no', 'ok')),
      ),
      toolbar(
        button({ act: 'app.section.recipes', variant: 'ghost' }, 'Make a rendition'),
        button({ act: 'specimen.remove', arg: specimen.id, variant: 'quiet' }, 'Remove'))),
    section({ title: `Used in ${plural(usedBy.length, 'scene')}` },
      usedBy.length
        ? h('div', { class: 'st-rows st-rows--compact' }, usedBy.map((scene) => h('button', {
          type: 'button', class: 'st-row-main', [KEY_ATTR]: scene.id,
          'data-st-act': 'scene.select', 'data-st-arg': scene.id,
        }, truncate(scene.headline || scene.id, 34))))
        : h('p', { class: 'st-field-hint' }, 'Not staged anywhere yet.')),
    renderFindings(app, specimen.id));
}

/**
 * @param {any} app
 * @param {any} rendition
 */
function renderRendition(app, rendition) {
  if (!rendition) return empty('Select a rendition to see its provenance.');
  const copy = PROVENANCE_COPY[rendition.provenance] || PROVENANCE_COPY.illustrative;
  const source = findSpecimen(app.proof, rendition.specimenId);
  const usedBy = usedInScenes(app.proof, (scene) => (scene.renditionIds || []).includes(rendition.id));

  return h('div', null,
    section({ title: truncate(rendition.label || '(unnamed)', 34), subtitle: humanize(rendition.producedBy) },
      pairs(
        pair('Id', h('code', { class: 'st-mono' }, rendition.id)),
        pair('Provenance', badge(copy.label, copy.tone)),
        pair('From', source ? truncate(source.title, 30) : 'a removed specimen'),
        pair('Recipe', h('code', { class: 'st-mono' }, rendition.recipeId)),
        pair('Blocks', h('span', { class: 'st-mono' }, String((rendition.blocks || []).length))),
      ),
      h('p', { class: 'st-note' }, copy.describe),
      rendition.notes ? h('p', { class: 'st-note st-dim' }, rendition.notes) : null),
    section({ title: `Staged in ${plural(usedBy.length, 'scene')}` },
      usedBy.length
        ? h('ul', { class: 'st-paths' }, usedBy.map((scene) => h('li', { [KEY_ATTR]: scene.id }, truncate(scene.headline || scene.id, 34))))
        : h('p', { class: 'st-field-hint' }, 'Not attached to a scene yet — attach it in Scenes.')));
}

/**
 * @param {any} app
 * @param {any} branch
 */
function renderBranch(app, branch) {
  if (!branch) return empty('Select a branch to see its coverage.');
  const deck = app.preview.runtime ? app.preview.runtime.deck : null;
  const coverage = deck ? app.services.branchCoverage(deck) : { unreachable: [], noReturn: [] };
  const anchors = (app.proof.spine || []).filter((s) => (s.branchAnchors || []).includes(branch.id));

  return h('div', null,
    section({ title: truncate(branch.objection, 34), subtitle: `Branch ${branch.id}` },
      pairs(
        pair('Scenes', h('span', { class: 'st-mono' }, String((branch.scenes || []).length))),
        pair('Aliases', h('span', { class: 'st-mono' }, String((branch.aliases || []).length))),
        pair('Anchored at', h('span', { class: 'st-mono' }, String(anchors.length))),
        pair('Return policy', humanize(branch.returnPolicy)),
        pair('Reachable', coverage.unreachable.includes(branch.id) ? badge('no', 'bad') : badge('yes', 'ok')),
        pair('Return target', coverage.noReturn.includes(branch.id) ? badge('unresolved', 'bad') : badge('resolved', 'ok')),
      ),
      (branch.aliases || []).length
        ? h('ul', { class: 'st-paths' }, branch.aliases.map((a, i) => h('li', { [KEY_ATTR]: String(i) }, a)))
        : h('p', { class: 'st-field-hint' }, 'No aliases. The jump index only knows the sentence above.')),
    renderFindings(app, branch.id));
}

/**
 * @param {any} app
 * @param {any} at
 */
function renderScene(app, at) {
  if (!at) return empty('Select a scene to see what it stages.');
  const scene = at.scene;
  const beatIndex = Math.min(app.ui.selection.beatIndex || 0, Math.max(0, (scene.beats || []).length - 1));
  const beat = (scene.beats || [])[beatIndex] || null;
  const visible = revealedAt(scene, beatIndex);
  const specimen = findSpecimen(app.proof, scene.specimenId);

  return h('div', null,
    section({ title: truncate(scene.headline || humanize(scene.layout), 34), subtitle: at.sequence === 'spine' ? `Spine position ${at.index + 1}` : 'In a branch' },
      pairs(
        pair('Id', h('code', { class: 'st-mono' }, scene.id)),
        pair('Layout', humanize(scene.layout)),
        pair('Specimen', specimen ? truncate(specimen.title, 28) : badge('none', 'warn')),
        pair('Renditions', h('span', { class: 'st-mono' }, String((scene.renditionIds || []).length))),
        pair('Beats', h('span', { class: 'st-mono' }, String((scene.beats || []).length))),
        pair('Branches offered', h('span', { class: 'st-mono' }, String((scene.branchAnchors || []).length))),
      ),
      toolbar(
        button({ act: 'scene.move', arg: `${scene.id}:-1`, variant: 'ghost' }, 'Move up'),
        button({ act: 'scene.move', arg: `${scene.id}:1`, variant: 'ghost' }, 'Move down'),
        button({ act: 'scene.remove', arg: scene.id, variant: 'quiet' }, 'Remove'))),
    beat
      ? section({ title: `Beat ${beatIndex + 1}`, subtitle: `${visible.size} element${visible.size === 1 ? '' : 's'} visible here` },
        pairs(
          pair('Adds', h('span', { class: 'st-mono' }, String((beat.reveals || []).length))),
          pair('Pacing hint', beat.dwellHintMs ? `${Math.round(beat.dwellHintMs / 1000)}s (display only)` : '—'),
        ),
        beat.presenterNote
          ? h('blockquote', { class: 'st-note-quote' }, beat.presenterNote)
          : h('p', { class: 'st-field-hint' }, 'No presenter note. The second screen will show the scene alone.'),
        toolbar(
          button({ act: 'beat.select', arg: `${scene.id}:${Math.max(0, beatIndex - 1)}`, variant: 'ghost', disabled: beatIndex === 0 }, 'Previous beat'),
          button({ act: 'beat.select', arg: `${scene.id}:${beatIndex + 1}`, variant: 'ghost', disabled: beatIndex >= (scene.beats || []).length - 1 }, 'Next beat')))
      : null,
    renderFindings(app, scene.id));
}

/** @param {any} app */
function renderBrand(app) {
  const brand = app.proof.brand;
  return h('div', null,
    section({ title: 'Brand system', subtitle: brand.sourceUrl || 'entered by hand' },
      pairs(
        pair('Id', h('code', { class: 'st-mono' }, brand.id)),
        pair('Captured', formatDateTime(brand.capturedAt)),
        pair('Colours', h('span', { class: 'st-mono' }, String((brand.colors || []).length))),
        pair('Faces', h('span', { class: 'st-mono' }, String((brand.faces || []).length))),
        pair('Logos', h('span', { class: 'st-mono' }, String((brand.logos || []).length))),
        pair('Overrides', h('span', { class: 'st-mono' }, String((brand.manualOverrides || []).length))),
      )),
    section({ title: 'Theme output', subtitle: 'The `--pp-*` custom properties the artifact reads. The studio never wears them.' },
      h('p', { class: 'st-field-hint' }, app.services.has('theme')
        ? `${plural(Object.keys(app.services.compileTheme(brand).vars || {}).length, 'variable')} compiled for the artifact stylesheet.`
        : 'The theme compiler is not wired into this build, so the preview shows the runtime defaults.')));
}

/** @param {any} app */
function renderRehearse(app) {
  const findings = app.ui.sweep.findings || [];
  const counts = [1, 2, 3].map((severity) => findings.filter((f) => f.severity === severity).length);
  const codes = new Map();
  for (const f of findings) codes.set(f.code, (codes.get(f.code) || 0) + 1);

  return h('div', null,
    section({ title: 'Sweep', subtitle: app.ui.sweep.at ? `Last run ${formatDateTime(app.ui.sweep.at)}` : 'Not yet run' },
      pairs(
        pair('Blocking', counts[0] ? badge(String(counts[0]), 'bad') : badge('0', 'ok')),
        pair('Warnings', h('span', { class: 'st-mono' }, String(counts[1]))),
        pair('Notes', h('span', { class: 'st-mono' }, String(counts[2]))),
      ),
      toolbar(button({ act: 'rehearse.sweep', variant: 'primary' }, 'Run the sweep'))),
    codes.size
      ? section({ title: 'By code' },
        h('ul', { class: 'st-paths' }, [...codes.entries()].sort((a, b) => b[1] - a[1]).map(([code, n]) => h('li', { [KEY_ATTR]: code },
          h('code', { class: 'st-mono' }, code), ' × ', String(n)))))
      : null);
}

/** @param {any} app */
function renderEmit(app) {
  const result = app.ui.emit.result;
  return h('div', null,
    section({ title: 'Emit', subtitle: result ? `Last emitted ${formatDateTime(app.ui.emit.at)}` : 'Nothing emitted yet' },
      result
        ? pairs(
          pair('Size', h('span', { class: 'st-mono' }, formatBytes(result.bytes))),
          pair('Degradations', h('span', { class: 'st-mono' }, String((result.degradations || []).length))),
          pair('Compression', h('span', { class: 'st-mono' }, result.compression ? result.compression.mode : '—')),
        )
        : h('p', { class: 'st-field-hint' }, 'The emit panel shows what is standing in the way.'),
      toolbar(button({ act: 'emit.download', variant: 'primary', disabled: !result }, 'Save the file'))));
}

/** @param {any} app */
function renderProject(app) {
  const proof = app.proof;
  return h('div', null,
    section({ title: app.doc.name, subtitle: proof.prospectName || 'no prospect named yet' },
      pairs(
        pair('Specimens', h('span', { class: 'st-mono' }, String((proof.specimens || []).length))),
        pair('Renditions', h('span', { class: 'st-mono' }, String((proof.renditions || []).length))),
        pair('Spine scenes', h('span', { class: 'st-mono' }, String((proof.spine || []).length))),
        pair('Branches', h('span', { class: 'st-mono' }, String((proof.branches || []).length))),
        pair('Undo depth', h('span', { class: 'st-mono' }, String(app.stack.history().length))),
      ),
      toolbar(
        button({ act: 'project.save', variant: 'primary' }, 'Save'),
        button({ act: 'project.export', variant: 'ghost' }, 'Export'))),
    section({ title: 'Next', subtitle: 'What the definition of done still wants (§1.2).' },
      h('ol', { class: 'st-checklist' }, checklist(app).map((item) => h('li', {
        class: cx('st-check-item', item.done && 'st-check-item--done'),
        [KEY_ATTR]: item.id,
      },
      h('span', { class: 'st-check-mark' }, item.done ? '✓' : '○'),
      h('span', null, item.text))))));
}

/**
 * §1.2's definition of done, as a live checklist rather than a paragraph.
 * @param {any} app
 * @returns {{id: string, text: string, done: boolean}[]}
 */
export function checklist(app) {
  const proof = app.proof;
  const blocking = (app.ui.sweep.findings || []).filter((f) => f.severity === 1).length;
  return [
    { id: 'prospect', text: 'Name the prospect', done: !!proof.prospectName },
    { id: 'brand', text: 'Extract their brand system', done: (proof.brand.colors || []).length >= 4 && !!proof.brand.sourceUrl },
    { id: 'specimens', text: 'Capture their real content', done: (proof.specimens || []).length > 0 },
    { id: 'renditions', text: 'Produce at least one rendition', done: (proof.renditions || []).length > 0 },
    { id: 'spine', text: 'Assemble a scene sequence', done: (proof.spine || []).length >= 3 },
    { id: 'branches', text: 'Attach at least three objection branches', done: (proof.branches || []).length >= 3 },
    { id: 'sweep', text: 'Run rehearsal to a clean pass', done: !!app.ui.sweep.at && blocking === 0 },
    { id: 'emit', text: 'Emit the file', done: !!app.ui.emit.result },
  ];
}

/**
 * @param {any} proof
 * @param {(scene: any) => boolean} pred
 * @returns {any[]}
 */
function usedInScenes(proof, pred) {
  const out = [];
  for (const scene of proof.spine || []) if (pred(scene)) out.push(scene);
  for (const branch of proof.branches || []) for (const scene of branch.scenes || []) if (pred(scene)) out.push(scene);
  return out;
}
