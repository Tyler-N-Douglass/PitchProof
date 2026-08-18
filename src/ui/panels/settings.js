/**
 * The Settings panel.
 *
 * Everything here is per-machine and travels with nothing. Two of the three
 * settings are named in the spec and both carry a law:
 *
 *   - §6.2: the CORS proxy is **a single field the user pastes a base URL into,
 *     empty by default**. No third-party proxy is shipped, suggested, or
 *     pre-filled — the studio would otherwise be sending a prospect's pages
 *     through somebody else's server without being asked.
 *   - §9: the runtime adapter's key **lives in memory and IndexedDB on this
 *     machine only, is never written into an emitted artifact, and the emitter
 *     asserts its absence.** That sentence is on the page, next to the field,
 *     because a user deciding whether to paste a key deserves to read it there
 *     rather than in a README.
 *
 * @module ui/panels/settings
 */

import { h } from '../../core/vdom.js';
import { badge, button, field, notice, pair, pairs, section, toolbar } from '../components.js';
import { plural } from '../format.js';
import { KEY_ATTR } from '../render.js';

/**
 * @param {any} app
 * @returns {import('../../core/vdom.js').VNode}
 */
export function renderSettingsPanel(app) {
  const settings = app.ui.settings;
  const lanes = app.services.lanes ? app.services.lanes() : [];
  const missing = lanes.filter((l) => !l.wired);

  return h('div', { class: 'st-panel' },

    section({
      title: 'You',
      subtitle: '§8 and §9 record who opted a specimen into raw HTML and who promoted a rendition. Both refuse to record “somebody”.',
    },
    field({
      label: 'Your name', act: 'settings.setOperator', value: settings.operator,
      placeholder: 'Alex Mercer', key: 'set-operator',
      hint: 'Stored on this machine. It appears in provenance records inside the project, never in an artifact as a claim about the client.',
    })),

    section({
      title: 'Ingest',
      subtitle: 'A direct fetch is tried first and fails quietly on CORS, which is normal (§6).',
    },
    field({
      label: 'CORS proxy base', act: 'settings.setProxy', value: settings.proxyBase, mono: true,
      placeholder: 'https://proxy.yourcompany.example/fetch?url=',
      key: 'set-proxy',
      hint: 'Empty by default and left empty unless you fill it. PitchProof ships no proxy and will never route a prospect’s pages through a third party you did not choose.',
    }),
    notice('info', 'If you have no proxy, use the saved-page, HAR, MHTML, paste or file import paths instead. They are not second-class — the whole ingest chain is designed to degrade rather than dead-end.')),

    section({
      title: 'Runtime adapter',
      subtitle: 'Optional. The default adapter is you, pasting real output (§9).',
      actions: settings.adapterKey
        ? toolbar(button({ act: 'settings.clearAdapterKey', variant: 'danger' }, 'Forget the key'))
        : null,
    },
    field({
      label: 'Endpoint', act: 'settings.setAdapterEndpoint', value: settings.adapterEndpoint, mono: true,
      placeholder: 'https://your-endpoint.example/generate',
      key: 'set-adapter-endpoint',
    }),
    field({
      label: 'Key', act: 'settings.setAdapterKey', value: settings.adapterKey, type: 'password', mono: true,
      placeholder: 'paste your key',
      key: 'set-adapter-key',
      hint: 'Held in memory and in IndexedDB on this machine only.',
    }),
    notice('warn', h('div', null,
      h('p', null, h('strong', null, 'This key never leaves this machine.'), ' It is not written into a project export, and it is not written into an emitted artifact. The emitter asserts its absence on every emit — if it ever appeared in the output, the emit would be refused rather than shipped.'),
      h('p', null, 'Everything the adapter produces is stamped ', h('code', { class: 'st-mono' }, 'illustrative'), ' and carries a visible label in the artifact until you check it yourself and promote it. There is no setting that changes that.'))),
    settings.adapterKey ? notice('info', `A key is stored (${plural(settings.adapterKey.length, 'character')}). Clear it when you are done.`) : null),

    section({
      title: 'This build',
      subtitle: 'Which lanes are wired in. The studio never pretends a missing lane worked.',
    },
    pairs(...lanes.map((lane) => pair(
      lane.label,
      h('span', null,
        lane.wired ? badge('wired', 'ok') : badge('not wired', 'warn'),
        h('code', { class: 'st-mono st-dim' }, ` ${lane.module}`)),
    ))),
    missing.length
      ? notice('warn', `${plural(missing.length, 'lane')} not wired: ${missing.map((l) => l.label).join(', ')}. Panels that depend on them say so where the result would have been, rather than failing quietly.`)
      : notice('ok', 'Every lane is wired.')),

    section({
      title: 'What this studio never does',
      subtitle: 'Product laws, listed so you can hold the tool to them (§1.1, §18).',
    },
    h('ul', { class: 'st-laws' }, [
      'No telemetry, analytics, beacons or phone-home in an emitted artifact. The emitter scans the output and refuses on any network reference.',
      'No generation during a presentation. An artifact contains only what was baked into it.',
      'No fabricated metrics, third-party logos, testimonials or named customers. There is no sample-stat generator, and there never will be.',
      'No account, no cloud, no backend. Everything is in this browser and in files you control.',
      'No override on a blocking finding. Not here, not behind a modifier, not in the palette.',
    ].map((law, i) => h('li', { [KEY_ATTR]: String(i) }, law)))),
  );
}
