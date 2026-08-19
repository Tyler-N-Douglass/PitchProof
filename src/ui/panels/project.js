/**
 * The Project panel (§15 rail step 1, §16 persistence).
 *
 * Everything about the project as a *thing on this machine*: what it is called,
 * who it is for, what seed drives its ids, which projects exist, and how one
 * moves between machines. §16's three obligations are all visible here rather
 * than implied — autosave state, the `.pitchproof.json` round trip, and storage
 * pressure with the re-compression offer attached to it.
 *
 * @module ui/panels/project
 */

import { h } from '../../core/vdom.js';
import { badge, button, empty, field, meter, notice, pairs, pair, row, section, toolbar } from '../components.js';
import { formatBytes, formatDateTime, plural, truncate } from '../format.js';
import { ACT_ATTR, KEY_ATTR } from '../render.js';

/**
 * @param {any} app
 * @returns {import('../../core/vdom.js').VNode}
 */
export function renderProjectPanel(app) {
  const doc = app.doc;
  const proof = doc.proof;
  const save = app.ui.save;
  const pressure = app.ui.pressure;

  return h('div', { class: 'st-panel' },

    section({
      title: 'This proof',
      subtitle: 'The prospect’s name is what the artifact and the file are named after.',
      actions: toolbar(
        button({ act: 'project.save', variant: 'primary', keyHint: 'Ctrl S' }, 'Save'),
        button({ act: 'project.new', variant: 'ghost' }, 'New'),
        button({ act: 'project.duplicate', variant: 'ghost' }, 'Duplicate'),
      ),
    },
    field({
      label: 'Project name', act: 'project.setName', value: doc.name, key: 'project-name',
      hint: 'Shown in the project list on this machine.',
    }),
    field({
      label: 'Prospect', act: 'project.setProspect', value: proof.prospectName,
      placeholder: 'Northwind Industrial', key: 'project-prospect',
      hint: 'Their name, spelled the way they spell it.',
    }),
    field({
      label: 'Project seed', act: 'project.setSeed', value: doc.seed, mono: true, key: 'project-seed',
      hint: 'Drives every id minted from here on (§5). Changing it does not renumber what already exists — element ids are referenced by beats.',
    }),
    pairs(
      pair('Proof id', h('code', { class: 'st-mono' }, proof.id)),
      pair('Created', formatDateTime(proof.createdAt)),
      pair('Schema', h('code', { class: 'st-mono' }, `v${proof.schemaVersion}`)),
      pair('Contents', `${plural((proof.specimens || []).length, 'specimen')}, ${plural((proof.renditions || []).length, 'rendition')}, ${plural((proof.spine || []).length, 'scene')}, ${plural((proof.branches || []).length, 'branch', 'branches')}`),
    )),

    section({
      title: 'Saved state',
      subtitle: 'Autosaved on every committed change. A failed save is never silent (§16).',
    },
    save.status === 'error'
      ? notice('bad', save.error || 'The last save failed.', button({ act: 'project.save', variant: 'primary' }, 'Try again'))
      : notice(save.status === 'saved' ? 'ok' : 'info',
        save.status === 'saved'
          ? `Saved ${formatDateTime(save.at)} at revision ${save.revision}.`
          : save.status === 'saving' ? 'Writing to local storage…'
            : save.status === 'pending' ? 'Changes are queued and will be written in a moment.'
              : 'Nothing has been written yet.'),
    h('div', { class: 'st-pressure' },
      h('div', { class: 'st-pressure-head' },
        h('span', null, 'Local storage'),
        h('span', { class: 'st-mono' }, pressure.quota
          ? `${formatBytes(pressure.usage)} of ${formatBytes(pressure.quota)} (${Math.round((pressure.ratio || 0) * 100)}%)`
          : pressure.measured
            ? `${formatBytes(pressure.usage)} used · this browser would not report a quota`
            : `${formatBytes(pressure.usage)} used · reading the quota`)),
      meter({
        ratio: pressure.ratio || 0,
        tone: pressure.level === 'critical' ? 'bad' : pressure.level === 'warn' ? 'warn' : 'ok',
        label: 'local storage use',
      }),
      pressure.level !== 'ok'
        ? notice(pressure.level === 'critical' ? 'bad' : 'warn',
          h('div', null,
            h('p', null, `Storage is ${Math.round((pressure.ratio || 0) * 100)}% full. A save will start failing before long.`),
            h('p', null, `Re-compressing steps every image down one quality step (currently ${proof.emitOptions.imageQuality}) and rewrites the budget the emitter works to.`)),
          toolbar(
            button({ act: 'project.recompress', variant: 'primary' }, 'Re-compress assets'),
            button({ act: 'project.export', variant: 'ghost' }, 'Export and archive'),
          ))
        : null),
    app.store && app.store.degraded ? notice('warn', app.store.degraded) : null),

    section({
      title: 'Move this project',
      subtitle: 'One file, assets inline, no side files and nothing fetched on import (§16).',
      actions: toolbar(
        button({ act: 'project.export', variant: 'primary', keyHint: 'Ctrl E' }, 'Export .pitchproof.json'),
      ),
    },
    h('label', { class: 'st-field' },
      h('span', { class: 'st-field-label' }, 'Import a project file'),
      h('input', {
        class: 'st-input st-file',
        type: 'file',
        accept: '.json',
        [ACT_ATTR]: 'project.import',
        [KEY_ATTR]: 'project-import',
      }),
      h('span', { class: 'st-field-hint' }, 'Replaces what is open. Export first if you have not saved elsewhere.')),
    notice('info', 'An export carries the proof and its assets. It never carries your CORS proxy, your adapter endpoint or your adapter key — those live on this machine only.')),

    section({
      title: 'Projects on this machine',
      subtitle: `${plural(app.ui.projects.length, 'project')} in local storage.`,
    },
    app.ui.projects.length
      ? h('div', { class: 'st-rows' }, app.ui.projects.map((p) => row({
        act: 'project.open',
        arg: p.id,
        key: p.id,
        selected: p.id === doc.id,
        title: h('span', null,
          truncate(p.name, 40),
          p.id === doc.id ? badge('open', 'ok') : null),
        meta: h('span', null,
          p.prospectName ? `${truncate(p.prospectName, 28)} · ` : '',
          `rev ${p.revision} · ${formatBytes(p.bytes)} · ${formatDateTime(p.savedAt)}`),
        trailing: button({ act: 'project.delete', arg: p.id, variant: 'danger', title: `Delete ${p.name}` }, 'Delete'),
      })))
      : empty('No projects are stored here yet. The one you are working on appears once it saves.',
        button({ act: 'project.save', variant: 'primary' }, 'Save this one'))),
  );
}
