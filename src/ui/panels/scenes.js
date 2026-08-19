/**
 * The Scenes panel (§10).
 *
 * The spine, its layouts, and — the part that actually decides whether a proof
 * lands — its beats. §10 makes beats additive reveals, so this panel shows the
 * reveal set as a cumulative thing: every element the layout renders, which beat
 * first shows it, and which beats inherit it. A reveal pointing at an element
 * the current layout does not render is called out rather than left to do
 * nothing on stage.
 *
 * The revealable elements come from the *real* rendered tree — the same
 * `Runtime.renderScene` the artifact uses — so what this panel offers to reveal
 * is exactly what will exist in the emitted file.
 *
 * @module ui/panels/scenes
 */

import { h, cx } from '../../core/vdom.js';
import {
  badge, button, empty, field, notice, pair, pairs, row, section, select, textarea, toolbar,
} from '../components.js';
import { humanize, plural, truncate } from '../format.js';
import { danglingReveals, findScene, layoutChoices } from '../model.js';
import { revealedAt } from '../../runtime/beats.js';
import { revealableElements } from '../reveal.js';
import { ACT_ATTR, ARG_ATTR, KEY_ATTR } from '../render.js';
import { BREAKPOINTS } from '../../core/contracts.js';

/**
 * @param {any} app
 * @returns {import('../../core/vdom.js').VNode}
 */
export function renderScenesPanel(app) {
  const proof = app.proof;
  const spine = proof.spine || [];
  const at = findScene(proof, app.ui.selection.sceneId);
  const scene = at ? at.scene : spine[0] || null;

  return h('div', { class: 'st-panel' },
    renderSpine(app, spine, scene),
    scene ? renderScene(app, scene, at) : null,
    scene ? renderOverflow(app, scene) : null,
    scene ? renderBeats(app, scene) : null);
}

/**
 * @param {any} app
 * @param {any[]} spine
 * @param {any} selected
 */
function renderSpine(app, spine, selected) {
  const templates = app.services.sceneTemplates();
  const choices = templates.length
    ? templates.map((t) => ({ value: t.layout, label: t.name, describe: t.describe }))
    : layoutChoices().map((c) => ({ value: c.value, label: c.label, describe: c.describe }));

  return section({
    title: 'Spine',
    subtitle: 'The linear narrative. Branches hang off it; they are not in it (§11).',
    actions: h('div', { class: 'st-inline-add' },
      h('select', {
        class: 'st-input st-select st-input--compact',
        'aria-label': 'Add a scene from a template',
        [ACT_ATTR]: 'scene.add',
        [KEY_ATTR]: 'scene-add',
      },
      h('option', { value: '', selected: true }, 'Add a scene…'),
      choices.map((c) => h('option', { value: c.value, title: c.describe }, c.label)))),
  },
  spine.length
    ? h('div', { class: 'st-rows' }, spine.map((s, i) => row({
      act: 'scene.select', arg: s.id, key: s.id, selected: !!selected && s.id === selected.id,
      title: h('span', null,
        h('span', { class: 'st-row-index st-mono' }, String(i + 1)),
        truncate(s.headline || `(${humanize(s.layout)})`, 42),
        (s.branchAnchors || []).length ? badge(`${s.branchAnchors.length} branch`, 'info') : null),
      meta: h('span', null,
        `${humanize(s.layout)} · ${plural((s.beats || []).length, 'beat')}`,
        s.specimenId ? '' : ' · no specimen',
        (s.renditionIds || []).length ? ` · ${plural(s.renditionIds.length, 'rendition')}` : ''),
      trailing: h('div', { class: 'st-row-tools' },
        button({ act: 'scene.move', arg: `${s.id}:-1`, variant: 'quiet', title: 'Move earlier', disabled: i === 0 }, '↑'),
        button({ act: 'scene.move', arg: `${s.id}:1`, variant: 'quiet', title: 'Move later', disabled: i === spine.length - 1 }, '↓'),
        button({ act: 'scene.remove', arg: s.id, variant: 'quiet', title: 'Remove this scene' }, '×')),
    })))
    : empty('The spine is empty. A proof opens by naming their problem in their words — start with a quote card or a split before/after.'),
  choices.length && !app.services.has('scene')
    ? notice('warn', 'The scene lane is not wired into this build, so the preview renders a placeholder for each layout. Scene structure, beats and branches are all still editable and will render the moment it lands.')
    : null);
}

/**
 * @param {any} app
 * @param {any} scene
 * @param {any} at
 */
function renderScene(app, scene, at) {
  const proof = app.proof;
  const specimens = proof.specimens || [];
  const renditions = proof.renditions || [];
  const branches = proof.branches || [];

  return section({
    title: truncate(scene.headline || humanize(scene.layout), 46),
    subtitle: at && at.sequence === 'branch'
      ? `In branch “${truncate((branches.find((b) => b.id === at.branchId) || {}).objection || '', 40)}”`
      : 'On the spine.',
  },
  h('div', { class: 'st-grid-2' },
    select({
      label: 'Layout', act: 'scene.setLayout', arg: scene.id, value: scene.layout,
      options: layoutChoices().map((c) => ({ value: c.value, label: c.label })),
      key: `scene-layout-${scene.id}`,
      hint: (layoutChoices().find((c) => c.value === scene.layout) || {}).describe,
    }),
    select({
      label: 'Specimen', act: 'scene.setSpecimen', arg: scene.id, value: scene.specimenId || '',
      options: [{ value: '', label: '— none —' }, ...specimens.map((s) => ({ value: s.id, label: truncate(s.title, 36) }))],
      key: `scene-specimen-${scene.id}`,
      hint: 'The “before” side. Their own content, unmodified (§18.3).',
    })),
  field({
    label: 'Headline', act: 'scene.setHeadline', arg: scene.id, value: scene.headline || '',
    key: `scene-headline-${scene.id}`,
    placeholder: 'What a viewer should conclude from this scene',
  }),
  field({
    label: 'Subhead', act: 'scene.setSubhead', arg: scene.id, value: scene.subhead || '',
    key: `scene-subhead-${scene.id}`,
  }),

  h('div', { class: 'st-field' },
    h('span', { class: 'st-field-label' }, `Renditions on this scene · ${(scene.renditionIds || []).length}`),
    renditions.length
      ? h('div', { class: 'st-chips' }, renditions.map((r) => {
        const on = (scene.renditionIds || []).includes(r.id);
        return h('button', {
          type: 'button',
          class: cx('st-chip', on && 'st-chip--on'),
          'aria-pressed': on ? 'true' : 'false',
          [ACT_ATTR]: 'scene.toggleRendition',
          [ARG_ATTR]: `${scene.id}|${r.id}`,
          [KEY_ATTR]: `sr-${r.id}`,
        },
        r.label || '(unnamed)',
        r.provenance === 'illustrative' ? h('span', { class: 'st-chip-flag' }, 'illustrative') : null);
      }))
      : h('p', { class: 'st-field-hint' }, 'No renditions exist yet. Paste one in Recipes, or run a seed recipe there against a captured specimen.')),

  h('div', { class: 'st-field' },
    h('span', { class: 'st-field-label' }, `Branches offered here · ${(scene.branchAnchors || []).length}`),
    branches.length
      ? h('div', { class: 'st-chips' }, branches.map((b) => {
        const on = (scene.branchAnchors || []).includes(b.id);
        return h('button', {
          type: 'button',
          class: cx('st-chip', on && 'st-chip--on'),
          'aria-pressed': on ? 'true' : 'false',
          title: b.objection,
          [ACT_ATTR]: 'scene.toggleAnchor',
          [ARG_ATTR]: `${scene.id}|${b.id}`,
          [KEY_ATTR]: `sa-${b.id}`,
        }, truncate(b.objection, 32));
      }))
      : h('p', { class: 'st-field-hint' }, 'No branches yet. A proof with no branches dies to the first objection.')),

  pairs(
    pair('Scene id', h('code', { class: 'st-mono' }, scene.id)),
    pair('Beats', h('span', { class: 'st-mono' }, String((scene.beats || []).length))),
  ));
}

/**
 * Text overflow on this scene, measured now, at all three breakpoints.
 *
 * §22.2: "the defect that makes a proof look amateur in front of a CMO, and it
 * is invisible until it isn't". It is invisible because it happens after the
 * brand's face is substituted, which is long after anyone looked at the
 * headline. This runs L8's measurement and L11's detector — the same two calls
 * the sweep makes — beside the field the headline is typed into, which is the
 * earliest moment the defect can possibly be seen.
 * @param {any} app
 * @param {any} scene
 * @returns {import('../../core/vdom.js').VNode}
 */
function renderOverflow(app, scene) {
  const runtime = app.preview.model(app.proof);
  if (!runtime) return null;
  let ctx;
  try { ctx = runtime.layoutContext(scene); } catch { return null; }

  const perBreakpoint = BREAKPOINTS.map((bp) => ({
    breakpoint: bp,
    findings: app.services.sceneOverflow(scene, ctx, bp.id),
  }));
  const total = perBreakpoint.reduce((n, e) => n + e.findings.length, 0);
  const blocking = perBreakpoint.reduce((n, e) => n + e.findings.filter((f) => f.severity === 1).length, 0);

  return section({
    title: `Text fit · ${total === 0 ? 'clean' : plural(total, 'finding')}`,
    subtitle: 'Measured against the face that will actually render, at every breakpoint (§14, §22.2).',
  },
  total === 0
    ? notice('ok', 'Every text box on this scene fits its container at 390, 1024 and 1600 — measured after the brand’s type substitution, which is the only measurement that means anything.')
    : notice(blocking ? 'bad' : 'warn', blocking
      ? `${plural(blocking, 'box')} overflow badly enough to block the emit. A fallback face that runs wider than the brand’s own is the usual cause — check the metric delta in Brand.`
      : `${plural(total, 'box')} are tight. They will not block the emit; they will look wrong on somebody else's projector.`),
  total
    ? h('div', { class: 'st-fit' }, perBreakpoint.filter((e) => e.findings.length).map((entry) => h('div', {
      class: 'st-fit-group', [KEY_ATTR]: entry.breakpoint.id,
    },
    h('h4', { class: 'st-fit-head' },
      `${entry.breakpoint.id} · ${entry.breakpoint.width}px`,
      badge(String(entry.findings.length), entry.findings.some((f) => f.severity === 1) ? 'bad' : 'warn')),
    h('ul', { class: 'st-findings' }, entry.findings.slice(0, 6).map((f) => h('li', {
      class: cx('st-finding', `st-finding--s${f.severity}`), [KEY_ATTR]: `${entry.breakpoint.id}-${f.id}`,
    },
    h('div', { class: 'st-finding-head' },
      badge(f.code, f.severity === 1 ? 'bad' : 'warn'),
      h('span', { class: 'st-finding-message' }, f.message))))))))
    : null);
}

/**
 * The beat plan. Reveals are additive, so each row shows what the beat adds and
 * what it inherits — which is the difference between a plan you can reason
 * about and a list of checkboxes.
 * @param {any} app
 * @param {any} scene
 */
function renderBeats(app, scene) {
  const elements = revealableElements(app, scene);
  const available = new Set(elements.map((e) => e.id));
  const dangling = danglingReveals(scene, available);
  const beats = scene.beats || [];

  return section({
    title: 'Beats',
    subtitle: 'Beat n shows everything from beats 0..n. Backward navigation restores the exact prior state (§10).',
    actions: toolbar(
      button({
        act: 'beat.autoPlan', arg: scene.id, variant: 'ghost',
        disabled: elements.length === 0,
        title: elements.length ? 'One beat per element this layout renders' : 'This layout renders nothing revealable',
      }, 'Plan the beats'),
      button({ act: 'beat.add', arg: scene.id, variant: 'ghost' }, 'Add a beat'),
    ),
  },
  dangling.length
    ? notice('warn', `${plural(dangling.length, 'reveal')} on this scene point at elements this layout does not render. They will do nothing on stage. Change the layout back, or clear them below.`)
    : null,
  beats.length
    ? h('ol', { class: 'st-beats' }, beats.map((beat, i) => {
      const inherited = i > 0 ? revealedAt(scene, i - 1) : new Set();
      const active = app.ui.selection.sceneId === scene.id && app.ui.selection.beatIndex === i;
      return h('li', { class: cx('st-beat', active && 'st-beat--active'), [KEY_ATTR]: beat.id },
        h('div', { class: 'st-beat-head' },
          h('button', {
            type: 'button', class: 'st-beat-index st-mono',
            [ACT_ATTR]: 'beat.select', [ARG_ATTR]: `${scene.id}:${i}`,
            'aria-current': active ? 'true' : null,
            title: 'Show this beat in the preview',
          }, String(i + 1)),
          h('span', { class: 'st-beat-summary' },
            (beat.reveals || []).length
              ? `${plural((beat.reveals || []).length, 'element')} revealed`
              : 'reveals nothing'),
          h('div', { class: 'st-row-tools' },
            button({ act: 'beat.move', arg: `${scene.id}:${i}:-1`, variant: 'quiet', title: 'Earlier', disabled: i === 0 }, '↑'),
            button({ act: 'beat.move', arg: `${scene.id}:${i}:1`, variant: 'quiet', title: 'Later', disabled: i === beats.length - 1 }, '↓'),
            button({ act: 'beat.remove', arg: `${scene.id}:${i}`, variant: 'quiet', title: beats.length > 1 ? 'Remove this beat' : 'A scene keeps at least one beat', disabled: beats.length <= 1 }, '×'))),
        elements.length
          ? h('div', { class: 'st-reveals' }, elements.map((el) => {
            const here = (beat.reveals || []).includes(el.id);
            const before = inherited.has(el.id);
            return h('button', {
              type: 'button',
              class: cx('st-reveal', here && 'st-reveal--on', before && 'st-reveal--inherited'),
              'aria-pressed': here ? 'true' : 'false',
              title: before ? `Already revealed by an earlier beat · ${el.id}` : el.id,
              [ACT_ATTR]: 'beat.toggleReveal',
              [ARG_ATTR]: `${scene.id}:${i}|${el.id}`,
              [KEY_ATTR]: `rv-${beat.id}-${el.id}`,
            },
            h('span', { class: 'st-reveal-label' }, truncate(el.label, 34)),
            before ? h('span', { class: 'st-reveal-flag' }, 'inherited') : null);
          }))
          : h('p', { class: 'st-field-hint' }, 'This layout renders nothing revealable, so the scene shows in full from beat one.'),
        (beat.reveals || []).filter((id) => !available.has(id)).length
          ? h('div', { class: 'st-reveals st-reveals--dangling' },
            (beat.reveals || []).filter((id) => !available.has(id)).map((id) => h('button', {
              type: 'button', class: 'st-reveal st-reveal--dangling',
              [ACT_ATTR]: 'beat.toggleReveal', [ARG_ATTR]: `${scene.id}:${i}|${id}`,
              [KEY_ATTR]: `dg-${beat.id}-${id}`,
              title: 'This element does not exist in the current layout. Click to clear it.',
            }, h('span', { class: 'st-mono' }, id), h('span', { class: 'st-reveal-flag' }, 'missing'))))
          : null,
        h('div', { class: 'st-grid-2' },
          textarea({
            label: 'Presenter note', act: 'beat.setNote', arg: `${scene.id}:${i}`, rows: 2,
            value: beat.presenterNote || '', key: `bn-${beat.id}`,
            hint: 'Second screen only. Never shown to the room.',
          }),
          field({
            label: 'Pacing hint (seconds)', act: 'beat.setDwell', arg: `${scene.id}:${i}`, type: 'number',
            value: beat.dwellHintMs ? String(Math.round(beat.dwellHintMs / 1000)) : '',
            key: `bd-${beat.id}`,
            hint: 'A hint for the presenter view. Nothing ever advances on its own (§10).',
          })));
    }))
    : empty('This scene has no beats, which the sweep raises as BEAT_EMPTY.',
      button({ act: 'beat.add', arg: scene.id, variant: 'primary' }, 'Add the first beat')));
}

export { revealableElements };
