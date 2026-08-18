/**
 * The furniture every layout shares: the scene header band, panel headers, the
 * provenance label, source attribution, and the empty states.
 *
 * Keeping these in one place is what makes eight layouts read as one deck. It
 * is also where two of the honesty laws live in code:
 *
 *  - **§9 / §18.1 provenance.** `provenanceLabel()` is the single producer of
 *    `pp-provenance`, it is called by every layout that renders a rendition,
 *    and it never puts `data-pp-el` on the label — a beat can hide anything
 *    carrying that attribute, and a label a beat can hide is not
 *    non-removable. The emitter re-checks the result (§22.6); this is the
 *    render-side half of the same law.
 *  - **§18.2 no invention.** Nothing here writes a number, a customer name, a
 *    testimonial or a logo that is not already in the model. `renditionCount()`
 *    counts renditions the proof actually contains; that is arithmetic over
 *    the model, not a claim about the world.
 *
 * @module scene/parts
 */

import { h } from '../core/vdom.js';

/** The class §18.1 requires on the illustrative label. Owned by runtime.css. */
export const PROVENANCE_LABEL_CLASS = 'pp-provenance';

/** The words the label says. Plain, short, and not softened. */
export const PROVENANCE_LABEL_TEXT = 'Illustrative example — not client-approved content';

/**
 * §9: any rendition not `client-supplied` and not explicitly promoted to
 * `verified-by-user` must carry a visible label. Written as "not one of the two
 * safe values" rather than "equals illustrative", so a provenance value this
 * lane has never heard of is labelled rather than trusted.
 * @param {import('../core/contracts.d.ts').Rendition|null|undefined} rendition
 * @returns {boolean}
 */
export function needsProvenanceLabel(rendition) {
  if (!rendition) return false;
  const p = rendition.provenance;
  return !(p === 'client-supplied' || p === 'verified-by-user');
}

/**
 * The label element, or null when the rendition is the client's own content or
 * the build has labelling switched off.
 *
 * The `labelIllustrative` flag is honoured exactly as given. Forcing it true
 * for review-reachable builds happens upstream — `normalizeEmitOptions()` in
 * core/contracts.js, and again in the emitter — because that is a property of
 * the *build*, which a layout cannot see. See docs/decisions/L8-scenes.md.
 *
 * @param {import('../core/contracts.d.ts').Rendition|null|undefined} rendition
 * @param {{labelIllustrative?: boolean}} ctx
 * @returns {import('../core/vdom.js').VNode}
 */
export function provenanceLabel(rendition, ctx) {
  if (!ctx || ctx.labelIllustrative === false) return null;
  if (!needsProvenanceLabel(rendition)) return null;
  // Deliberately no `data-pp-el`: an element without it is always visible, so
  // no beat can reveal-order this label away from the content it describes.
  return h('p', {
    class: PROVENANCE_LABEL_CLASS,
    'data-pp-tx': 'provenance',
    'data-pp-provenance-for': rendition.id,
  }, PROVENANCE_LABEL_TEXT);
}

/**
 * The scene header band: a kicker naming what kind of scene this is, the
 * headline, and the subhead. Present in every layout at the same height, so a
 * deck's body content starts on the same line from scene to scene.
 *
 * @param {import('../runtime/layouts.js').LayoutContext} ctx
 * @param {{kicker?: string|null, group?: string, path?: string, extra?: import('../core/vdom.js').VNode}} [options]
 * @returns {import('../core/vdom.js').VNode}
 */
export function sceneHead(ctx, options = {}) {
  const { scene } = ctx;
  const path = options.path || 'head';
  const kicker = options.kicker || null;
  if (!kicker && !scene.headline && !scene.subhead && !options.extra) return null;
  return h('header', {
    class: 'pp-scene-head',
    'data-pp-box': 'head',
    'data-pp-el': ctx.el(path),
    'data-pp-group': options.group || 'head',
  },
  h('div', { class: 'pp-scene-head-text' },
    kicker ? h('p', { class: 'pp-kicker', 'data-pp-tx': 'kicker' }, kicker) : null,
    scene.headline ? h('h2', { class: 'pp-headline', 'data-pp-tx': 'headline', 'data-pp-clamp': '2' }, scene.headline) : null,
    scene.subhead ? h('p', { class: 'pp-subhead', 'data-pp-tx': 'subhead', 'data-pp-clamp': '2' }, scene.subhead) : null),
  options.extra || null);
}

/**
 * A panel header: what this column is, and where it came from.
 * @param {{title: string, meta?: string|null, tone?: 'before'|'after'|'neutral', trailing?: import('../core/vdom.js').VNode}} spec
 * @returns {import('../core/vdom.js').VNode}
 */
export function panelHead(spec) {
  return h('div', { class: `pp-panel-head pp-panel-head--${spec.tone || 'neutral'}` },
    h('div', { class: 'pp-panel-head-text' },
      h('p', { class: 'pp-panel-title', 'data-pp-tx': 'panelTitle', 'data-pp-clamp': '1' }, spec.title),
      spec.meta ? h('p', { class: 'pp-panel-meta', 'data-pp-tx': 'panelMeta', 'data-pp-clamp': '1' }, spec.meta) : null),
    spec.trailing || null);
}

/**
 * A source URL as a label a client can read: no scheme, no trailing slash.
 *
 * The scheme is dropped for a reason beyond tidiness — an absolute URL written
 * into the artifact is a `NETWORK_REFERENCE` under §13, and the artifact's own
 * chrome has no business carrying one. The prospect's *content* is rendered
 * verbatim (§18.3); this is our label, not their copy.
 * @param {string|null|undefined} url
 * @returns {string|null}
 */
export function displayUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  const stripped = url.trim()
    .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
    .replace(/^\/\//, '')
    .replace(/\/+$/, '');
  return stripped || null;
}

/**
 * The meta line for a specimen: host and path, capture kind, locale.
 * @param {import('../core/contracts.d.ts').Specimen|null} specimen
 * @returns {string|null}
 */
export function specimenMeta(specimen) {
  if (!specimen) return null;
  const parts = [];
  const url = displayUrl(specimen.sourceUrl);
  if (url) parts.push(url);
  if (specimen.locale) parts.push(specimen.locale);
  if (!url && specimen.kind) parts.push(specimen.kind);
  return parts.length ? parts.join('  ·  ') : null;
}

/**
 * The meta line for a rendition: its label and how it was produced.
 * @param {import('../core/contracts.d.ts').Rendition|null} rendition
 * @returns {string|null}
 */
export function renditionMeta(rendition) {
  if (!rendition) return null;
  const parts = [];
  if (rendition.producedBy) parts.push(PRODUCED_BY_LABEL[rendition.producedBy] || rendition.producedBy);
  if (rendition.provenance === 'client-supplied') parts.push('client supplied');
  else if (rendition.provenance === 'verified-by-user') parts.push('verified');
  return parts.length ? parts.join('  ·  ') : null;
}

/** How each `producedBy` value reads to a client in the room. */
const PRODUCED_BY_LABEL = {
  'manual-paste': 'pasted by the team',
  adapter: 'produced by an adapter',
  template: 'assembled from a template',
};

/**
 * The state every layout needs and no layout should improvise: a scene with
 * nothing to show yet. It says which piece is missing, because the studio
 * preview is where this is seen and a blank panel there costs the user minutes.
 * @param {string} message
 * @param {{box?: string}} [options]
 * @returns {import('../core/vdom.js').VNode}
 */
export function emptyState(message, options = {}) {
  return h('div', { class: 'pp-empty', 'data-pp-box': options.box || null },
    h('p', { class: 'pp-empty-text', 'data-pp-tx': 'caption' }, message));
}

/**
 * A count, rendered as a number and a noun. Arithmetic over the model — never
 * a metric about the world (§18.2).
 * @param {number} n
 * @param {string} singular
 * @param {string} [plural]
 * @returns {string}
 */
export function countLabel(n, singular, plural) {
  const word = n === 1 ? singular : (plural || `${singular}s`);
  return `${n} ${word}`;
}

/**
 * A rendition's display label, falling back to its id rather than to an
 * invented name.
 * @param {import('../core/contracts.d.ts').Rendition|null} rendition
 * @param {number} index
 * @returns {string}
 */
export function renditionLabel(rendition, index) {
  if (!rendition) return `Rendition ${index + 1}`;
  const label = typeof rendition.label === 'string' ? rendition.label.trim() : '';
  return label || `Rendition ${index + 1}`;
}

/**
 * The specimen's display title, falling back to its source or its kind.
 * @param {import('../core/contracts.d.ts').Specimen|null} specimen
 * @returns {string}
 */
export function specimenTitle(specimen) {
  if (!specimen) return 'Their content';
  const title = typeof specimen.title === 'string' ? specimen.title.trim() : '';
  return title || displayUrl(specimen.sourceUrl) || 'Their content';
}
