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
 *    render-side half of the same law. `withProvenanceLedger()` closes the
 *    gap the fallback branches left: a layout that selects — `quoteCard` takes
 *    one quotation, `fullBleed` one image, `systemMap` five outputs — can leave
 *    a declared illustrative rendition on the scene with no label anywhere, and
 *    every layout now ends by asking for the ones it did not label.
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
 * The class on the strip of labels a layout renders for renditions it declared
 * but did not label inside a subtree of their own.
 */
export const PROVENANCE_LEDGER_CLASS = 'pp-provenance-ledger';

/**
 * The renditions a rendered tree has already labelled: every id that appears as
 * `data-pp-rendition` on some element whose subtree contains a
 * `pp-provenance` label.
 *
 * Derived from the tree rather than declared beside it, for the same reason the
 * beat plan is (decision L8-2): a table of "which layout labels which
 * rendition where" is a second description of the render, and the two drift the
 * first time a layout gains a fallback branch. This walks what was actually
 * emitted.
 *
 * The union across scopes is deliberate. A layout may scope one rendition in
 * more than one place — `splitBeforeAfter` gives it a panel head and a body
 * cell per row — and the label lives in exactly one of them; a rendition
 * labelled anywhere is labelled.
 *
 * @param {import('../core/vdom.js').VNode} tree
 * @returns {Set<string>}
 */
export function labelledRenditionIds(tree) {
  /** @type {Set<string>} */
  const labelled = new Set();

  /**
   * @param {import('../core/vdom.js').VNode} node
   * @param {string[]} scopes  ids of the `data-pp-rendition` ancestors
   */
  const visit = (node, scopes) => {
    if (node === null || node === undefined || node === false) return;
    if (Array.isArray(node)) { node.forEach((child) => visit(child, scopes)); return; }
    if (typeof node !== 'object' || 'raw' in node) return;
    const attrs = node.a || {};
    const owner = attrs['data-pp-rendition'];
    const next = typeof owner === 'string' && owner ? scopes.concat([owner]) : scopes;
    if (String(attrs.class || '').split(/\s+/).includes(PROVENANCE_LABEL_CLASS)) {
      for (const id of next) labelled.add(id);
    }
    (node.c || []).forEach((child) => visit(child, next));
  };

  visit(tree, []);
  return labelled;
}

/**
 * The renditions a scene declares, needs a label for, and has not labelled.
 * @param {import('../runtime/layouts.js').LayoutContext} ctx
 * @param {Set<string>} labelled
 * @returns {import('../core/contracts.d.ts').Rendition[]}
 */
export function unlabelledRenditions(ctx, labelled) {
  const rends = ctx && Array.isArray(ctx.renditions) ? ctx.renditions.filter(Boolean) : [];
  return rends.filter((r) => needsProvenanceLabel(r) && !labelled.has(r.id));
}

/**
 * Append the provenance ledger to a finished layout tree (§9, §18.1, §22.6).
 *
 * **The rule this implements.** A scene's `renditionIds` are the material the
 * scene is built out of, and the room is looking at a scene built out of them
 * whether or not the layout chose to put every one of them on screen. So: every
 * rendition a scene declares that needs a provenance label carries one, in
 * every layout, on every branch the layout can take. Where the layout scopes
 * the rendition and labels it there — a fan card, a split column, a legend chip
 * — nothing is added. Where it does not, the ledger carries the label, named to
 * the rendition it is about.
 *
 * **Why the label names the rendition.** A ledger row appears exactly where the
 * rendition's own material is *not* under the label, so an unnamed label would
 * float beside whatever the layout did render — which, on `quoteCard` and
 * `fullBleed`, is often the prospect's own content. Marking the client's page
 * "illustrative" is the same law read backwards (§18.3). The row names the
 * rendition, so the label is a statement about that rendition and about nothing
 * else on the screen.
 *
 * **Why not "only label what is visibly rendition-derived".** Because a layout
 * cannot tell. `quoteCard` renders `scene.headline`, and in a real proof that
 * headline is frequently the rendition's own leading heading — rendition text
 * on screen with nothing in the layout that knows it. Deciding from what the
 * scene *declares* is the predicate the layout can actually evaluate, and it
 * can only over-state the presence of illustrative material, never hide it.
 * Recorded as decision L8-13.
 *
 * The row is a `data-pp-rendition` scope of its own, so the label sits inside
 * the subtree of the rendition it describes exactly like every other label, and
 * carries no `data-pp-el`, so no beat can hide it.
 *
 * @param {import('../core/vdom.js').VNode} tree   the layout's root element
 * @param {import('../runtime/layouts.js').LayoutContext} ctx
 * @returns {import('../core/vdom.js').VNode}
 */
export function withProvenanceLedger(tree, ctx) {
  if (!tree || typeof tree !== 'object' || Array.isArray(tree) || 'raw' in tree) return tree;
  if (!ctx || ctx.labelIllustrative === false) return tree;

  const pending = unlabelledRenditions(ctx, labelledRenditionIds(tree));
  if (pending.length === 0) return tree;

  const order = new Map((Array.isArray(ctx.renditions) ? ctx.renditions : [])
    .filter(Boolean).map((r, i) => [r.id, i]));

  const rows = pending.map((rendition) => h('li', {
    class: 'pp-provenance-ledger-row',
    'data-pp-box': 'provenanceLedger',
    'data-pp-container': 'ledger',
    'data-pp-rendition': rendition.id,
  },
  h('p', {
    class: 'pp-provenance-ledger-name',
    'data-pp-tx': 'noteLabel',
    'data-pp-clamp': '1',
  }, renditionLabel(rendition, order.has(rendition.id) ? order.get(rendition.id) : 0)),
  provenanceLabel(rendition, ctx)));

  const ledger = h('ul', { class: PROVENANCE_LEDGER_CLASS }, rows);
  // The root states the strip's row count so `measureScene` can take the room
  // it costs out of every box above it (`ledgerAllowance` in geometry.js).
  return {
    ...tree,
    a: { ...(tree.a || {}), 'data-pp-ledger': String(rows.length) },
    c: (tree.c || []).concat([ledger]),
  };
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
 * The longest source label the panel meta line is allowed to be before the
 * middle of the path is elided. Sized against the narrowest container that
 * carries one — a single-column panel at `sm`, 320px at 10px in a monospace
 * face, which holds about 53 characters.
 */
export const URL_LABEL_BUDGET = 48;

/**
 * A source URL as a label a client can read: no scheme, no trailing slash, and
 * the middle of a long path elided rather than the end.
 *
 * The scheme is dropped for a reason beyond tidiness — an absolute URL written
 * into the artifact is a `NETWORK_REFERENCE` under §13, and the artifact's own
 * chrome has no business carrying one. The prospect's *content* is rendered
 * verbatim (§18.3); this is our label, not their copy, which is what makes
 * eliding it a design decision rather than an edit to their page.
 *
 * The elision is from the middle because the two informative ends of a URL are
 * the host and the last path segment — the slug that says which page this is.
 * Letting the CSS truncate from the right instead keeps the host and throws the
 * slug away, which is the half a client actually recognises. Where the label
 * still does not fit, the stylesheet ellipsises it and `measureScene` reports
 * `textOverflow: 'ellipsis'`, so the truncation is graded as visible rather
 * than as data lost silently (CRITIQUE-1 F6).
 *
 * The budget is a parameter because it is a property of the *container*, not of
 * URLs: `URL_LABEL_BUDGET` is sized for a panel meta line, and `systemMap`'s
 * node is a fifth of that width with two lines to spend. A caller that knows
 * its own box passes its own number (`labelBudget` in the map).
 * @param {string|null|undefined} url
 * @param {number} [budget]   characters the label may run to before elision
 * @returns {string|null}
 */
export function displayUrl(url, budget = URL_LABEL_BUDGET) {
  if (typeof url !== 'string' || !url.trim()) return null;
  const stripped = url.trim()
    .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
    .replace(/^\/\//, '')
    .replace(/\/+$/, '');
  if (!stripped) return null;
  if (stripped.length <= budget) return stripped;

  const parts = stripped.split('/').filter(Boolean);
  const host = parts[0];
  const last = parts[parts.length - 1];
  // Host plus one segment has no middle to drop; anything deeper loses it.
  const elided = parts.length < 3 ? stripped : `${host}/…/${last}`;
  const best = elided.length < stripped.length ? elided : stripped;
  if (best.length <= budget) return best;

  // Still over. A caller with a genuinely small box (a `systemMap` node is a
  // fifth of a panel column's width) gets a label that fits it, cut in the same
  // place and for the same reason: the host and the slug are the two ends a
  // client recognises, so the cut is taken out of the middle of what is left
  // rather than off the end. Without this the label simply ran past its box —
  // and in SVG, which cannot ellipsise, ran off it with nothing to say so.
  const room = Math.max(4, Math.floor(budget) - 1);
  const tail = Math.max(2, Math.floor(room / 2));
  const head = Math.max(2, room - tail);
  return `${best.slice(0, head)}…${best.slice(best.length - tail)}`;
}

/**
 * The meta line for a specimen: host and path, capture kind, locale.
 * @param {import('../core/contracts.d.ts').Specimen|null} specimen
 * @param {{urlBudget?: number}} [options]  the container's own label budget
 * @returns {string|null}
 */
export function specimenMeta(specimen, options = {}) {
  if (!specimen) return null;
  const parts = [];
  const url = displayUrl(specimen.sourceUrl, options.urlBudget ?? URL_LABEL_BUDGET);
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
 * A rendition's `notes` as something a client may see, or null.
 *
 * §4 gives `Rendition` one free-text field, and L7's `promoteProvenance` writes
 * its promotion record into it ("promoted: verified by … on …"). That record is
 * internal bookkeeping about who signed something off; putting it on screen in
 * front of the client would be a small but real leak of the seller's process
 * into the client's room. A note that opens with that marker is not rendered.
 * Everything else the user wrote is rendered verbatim.
 *
 * Filed as a dispute against the contract (docs/disputes/L8-scenes.md): one
 * field carrying both an annotation and an audit record is what forces this.
 * @param {import('../core/contracts.d.ts').Rendition|null|undefined} rendition
 * @returns {string|null}
 */
export function presentableNotes(rendition) {
  if (!rendition || typeof rendition.notes !== 'string') return null;
  const text = rendition.notes.trim();
  if (!text) return null;
  if (/^promoted\s*:/i.test(text)) return null;
  return text;
}

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
 * The beat group an item belongs to.
 *
 * Below the threshold every item is its own beat, because a presenter walking
 * three variants wants to talk about each one. Above it, items reveal in waves:
 * nine locale cards landing one keypress at a time is nine keypresses of dead
 * air, and the point of nine cards is the nine, not the ninth.
 * @param {string} prefix
 * @param {number} index
 * @param {number} total
 * @param {number} [max]
 * @returns {string}
 */
export function waveGroup(prefix, index, total, max = 4) {
  return total > max ? `${prefix}/wave/${Math.floor(index / max)}` : `${prefix}/${index}`;
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
