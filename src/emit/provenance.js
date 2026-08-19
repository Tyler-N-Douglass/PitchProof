/**
 * The §18 honesty laws about the rendered artifact, enforced in the emit path
 * (§9, §18.1, §18.3, §22.6).
 *
 * §22.6 names this "the single reputational risk in this product": a proof that
 * implies generated sample content is the client's approved copy. §9 says
 * "enforce this in the emitter, not just in the UI", and §18.1 adds that the
 * label "cannot be styled to invisibility (contrast and size floors enforced at
 * emit)". Everything in this module exists to make those sentences into code
 * that refuses.
 *
 * §18.3 — *"The prospect's own content is presented unmodified on the 'before'
 * side. If a specimen was edited, the artifact says so"* — is the same law with
 * a different subject, and it is enforced here for the same reason. The model
 * records the edit (L6's `markEdited`), L11's `ASSET_MISSING` fix calls it when
 * it removes the prospect's own content, and L8 renders `.pp-edited` for it in
 * all eight layouts. None of that is worth anything if nothing checks that the
 * marker arrived: a layout that stopped rendering it, or a brand stylesheet
 * that faded it, would ship in silence — and what ships is a client being shown
 * material the presenting team changed, as if it were their own page as
 * captured. That is §22.6's sentence with "generated sample content" replaced
 * by "edited client content", so it is graded where §22.6 puts it: severity 1,
 * `PROVENANCE_UNLABELED`, emit refused (E43).
 *
 * Six things are checked, and each one is a distinct attack:
 *
 *   1. **The claim.** A rendition marked `verified-by-user` with no promotion
 *      record behind it is not verified by anyone (`emit/promotion.js`).
 *   2. **The option.** `labelIllustrativeContent: false` on a build a recipient
 *      can open in Review mode is a request §9 forbids. `normalizeEmitOptions`
 *      forces the flag back to true so nothing unlabelled can ship even if this
 *      check were removed — and this check still refuses the emit, because
 *      silently overriding a user's explicit instruction and shipping anyway
 *      teaches them nothing about the law they just ran into.
 *   3. **The markup.** Every rendition that needs a label must have one inside
 *      the scene subtree that renders it.
 *   4. **The stylesheet.** The marker has to survive the *final* CSS — runtime,
 *      brand theme, and any user CSS — with a computed contrast of at least
 *      4.5:1 against its own background, a computed font size of at least 11px,
 *      and no rule anywhere that hides it: `display:none`, `visibility:hidden`,
 *      `opacity:0`, zero size, a clip, or a position off the screen. This runs
 *      over **every** class in `PROTECTED_MARKERS`, not over the provenance
 *      label alone, because the detector never read a class name in the first
 *      place — it reads a chain and a cascade (E41).
 *   5. **The edit record.** Every scene whose specimen was edited after capture
 *      must render `.pp-edited` inside that specimen's subtree, checked with
 *      L8's own `markedSpecimenIds` against the tree the artifact will show.
 *   6. **The file.** The opening scene is pre-rendered into the document, so
 *      both markers are looked for in the emitted bytes as well as in the tree.
 *
 * **The honest limits of check 4** — the same list is in
 * `docs/decisions/L10-emit.md`, and every one of them fails safe:
 *
 *   - It resolves the cascade, not a layout. A label pushed out of a scrolling
 *     container by its siblings, or covered by a later sibling with a higher
 *     `z-index`, is not detected. Nothing in the runtime stylesheet does that,
 *     and `scripts/verify-offline.mjs` looks at the real rendered artifact.
 *   - Interaction pseudo-classes (`:hover`, `:focus`) are ignored, so a rule
 *     that hides the label on hover passes. It is transient by definition.
 *   - `@media print` is ignored; every other at-rule condition is treated as
 *     applying, which will occasionally reject a stylesheet that only hides the
 *     label at a width the artifact never uses. That trade is deliberate: the
 *     cost of the false positive is one CSS edit, and the cost of the false
 *     negative is §22.6.
 *   - Content injected by `::before`/`::after` is not counted as the label.
 *   - Markup inside a `raw()` VNode is opaque to the tree walk, so a label that
 *     exists only inside raw HTML is not seen — and therefore counted as
 *     missing, which is the safe direction.
 *
 * @module emit/provenance
 */

import { contentId } from '../core/ids.js';
import { styleString } from '../core/vdom.js';
import { CONTRAST_AA_BODY } from '../core/contracts.js';
import { parseStylesheet, computeCascade, backgroundColorOf, resolveLengthPx, resolveLineHeightPx } from './css.js';
import { parseColor, contrastRatio, compositeOver, toHex } from './color-value.js';
import { requiresProvenanceLabel, isUnearnedVerification, promotionRecord } from './promotion.js';
import {
  PROVENANCE_LABEL_CLASS, EDITED_MARK_CLASS,
  specimenEdited, editRecordCount, markedSpecimenIds,
} from '../scene/index.js';

/**
 * The two classes §18 protects, read from L8 rather than spelled again here
 * (E40). `PROVENANCE_LABEL_CLASS` used to be a string literal in this file, and
 * a second spelling of a class name is a defect waiting for someone to rename
 * the first one: the emitter would look for a label that no longer exists,
 * find none, and refuse every proof — or, if the rename went the other way,
 * find one that nothing styles and pass everything.
 */
export { PROVENANCE_LABEL_CLASS, EDITED_MARK_CLASS };

/** §18.1's size floor, in CSS px. */
export const MIN_LABEL_FONT_PX = 11;

/**
 * How much room the label's own text needs, in multiples of its font size
 * (C9).
 *
 * §18.1 says the label "cannot be styled to invisibility (contrast and size
 * floors enforced at emit)". The first version of this check read that as a
 * list of ways to hide a box and answered each one: `display:none`,
 * `visibility:hidden`, `opacity:0`, `clip-path`, off-screen positioning,
 * `transform:scale(0)`, and a `width`/`height` that was the literal string `0`.
 * Thirteen attacks bounced off it, and two walked through:
 *
 * ```css
 * .pp-provenance{height:1px!important;overflow:hidden!important}
 * .pp-provenance{letter-spacing:-1em!important}
 * ```
 *
 * Neither is a new trick. `height:1px` is `height:0` with a typo, and a list of
 * literal values will always be one property behind whoever is writing the
 * stylesheet. So the question the check asks changed: not *"is this declaration
 * one of the ones we know about"* but **"is there room for the label's own line
 * of text, in CSS pixels"**. A box is judged against the line box the label's
 * own `font-size` and `line-height` produce; tracking is judged against the
 * font size it is applied to. Both are measurements, and both are units the
 * next attack has to survive rather than a spelling it has to avoid.
 *
 * The widths are generous on purpose. `LABEL_MIN_WIDTH_EM` at the 11px floor is
 * 66px — about eleven characters of a fifty-character sentence — so a design
 * that puts the label in a genuinely narrow column still clears it, and a
 * nineteen-pixel smear does not.
 */
export const LABEL_MIN_WIDTH_EM = 6;

/**
 * The tightest negative tracking a label may carry, as a fraction of its font
 * size. Real typography uses down to about -0.05em on display sizes; at -0.1em
 * glyphs begin to touch, and `-1em` — the attack — stacks every character on
 * the one before it.
 */
export const LABEL_MIN_TRACKING_EM = -0.1;

/**
 * The blurriest a label may be, as a fraction of its own font size (P8).
 *
 * `filter: blur(r)` is a Gaussian of standard deviation `r`, and what it
 * destroys is stroke structure. A regular text face draws its stems at roughly
 * an eighth of its font size — about 1.5px on 12px type — and a Gaussian whose
 * σ approaches that spreads each stem across its neighbours until the word is a
 * smear. At 0.04em the blur is a third of a pixel on 12px type: a softness a
 * designer might want and a reader will not notice. At 20px, the attack, it is
 * fifty times the stem.
 *
 * This is deliberately a *ratio*, not a pixel count, for the same reason the
 * size floor is measured against the line box rather than listed: the next
 * spelling of the attack is `blur(1.6em)`, and a ratio has already answered it.
 */
export const LABEL_MAX_BLUR_EM = 0.04;

/** Overflow values that cut the label off rather than letting it spill. */
const CLIPPING_OVERFLOW = new Set(['hidden', 'clip']);

/** Attribute a layout may use to scope a rendition's subtree. */
export const RENDITION_ATTR = 'data-pp-rendition';

/** Attribute a layout uses to scope a specimen's subtree (L8's `markedSpecimenIds`). */
export const SPECIMEN_ATTR = 'data-pp-specimen';

/**
 * The attribute `editedMark()` puts on the pill, naming the specimen it is
 * about. A **second, independent attribution**, not the primary one: the
 * primary reader is L8's own `markedSpecimenIds`, which walks
 * `data-pp-specimen` scopes.
 *
 * Both are read because either alone would refuse a marker a client can see.
 * `stack` renders one `data-pp-specimen` scope per step, so "there is a
 * `.pp-edited` somewhere in this scene" is not enough to conclude the *scene's*
 * specimen was marked — but a pill that names the specimen in its own attribute
 * says so whether or not the layout wrapped it in a scope. The law is about a
 * client being told, so it refuses a marker that is missing or unreadable, not
 * one that is attributed unconventionally.
 */
export const EDITED_FOR_ATTR = 'data-pp-edited-for';

/**
 * The markers §18 will not let a stylesheet take away — **a set, not a
 * special case** (E41).
 *
 * `judgeLabelStyle` and `judgeLabelRoom` never read a class name: they are
 * handed an ancestor chain and a cascade and they answer *"can this text be
 * read"*. The class only ever decided which elements got asked. So the
 * generalisation is not a rewrite of the detector, it is a widening of its
 * input — and the twenty-odd routes P8 and C9 closed against `.pp-provenance`
 * (`display:none`, `opacity:0`, a one-pixel clipping box, `-1em` tracking,
 * `scale(0.2)`, `-webkit-text-fill-color`, `filter:blur`, an ancestor's
 * `filter` at zero alpha, a contrast attack through the theme's own custom
 * properties) close against `.pp-edited` with no second implementation and no
 * second list to keep in step.
 *
 * Each entry carries the noun the refusal should use and the law it is
 * refusing under, because "display:none on the label" is the wrong sentence to
 * print about the edit marker and §18.1 is the wrong section to cite for it.
 * A third marker is one more entry here.
 *
 * @type {{className: string, noun: string, law: string, what: string}[]}
 */
export const PROTECTED_MARKERS = [
  {
    className: PROVENANCE_LABEL_CLASS,
    noun: 'the label',
    title: 'The provenance label',
    law: '§18.1',
    what: 'illustrative content presented without its label',
    emptyText: 'A label that says nothing labels nothing',
    nonRemovable: '§18.1 makes the label non-removable, and that includes styling it away.',
  },
  {
    className: EDITED_MARK_CLASS,
    noun: 'the edit marker',
    title: 'The edit marker',
    law: '§18.3',
    what: 'an edited specimen presented as captured',
    emptyText: 'A marker that says nothing does not say the specimen was edited',
    nonRemovable: '§18.3 makes the marker non-removable, and that includes styling it away.',
  },
];

/** The provenance label's descriptor — the default subject of every judgement. */
export const LABEL_MARKER = PROTECTED_MARKERS[0];

/** The §18.3 edit marker's descriptor. */
export const EDITED_MARKER = PROTECTED_MARKERS[1];

/**
 * Which protected marker, if any, this element is.
 * @param {import('./css.js').ElementDesc} desc
 * @param {{className: string, noun: string, law: string, what: string}[]} [markers]
 * @returns {{className: string, noun: string, law: string, what: string}|null}
 */
export function markerFor(desc, markers = PROTECTED_MARKERS) {
  for (const marker of markers) if (desc.classes.includes(marker.className)) return marker;
  return null;
}

/** The page background the artifact falls back to when the theme resolves nothing. */
const DEFAULT_PAGE_BACKGROUND = { r: 255, g: 255, b: 255, a: 1 };

/**
 * @param {string} message
 * @param {Record<string, unknown>} locus
 * @returns {import('../core/contracts.d.ts').Finding}
 */
export function provenanceFinding(message, locus) {
  return {
    id: contentId('finding', { code: 'PROVENANCE_UNLABELED', message, locus }),
    severity: 1,
    code: 'PROVENANCE_UNLABELED',
    message,
    locus,
    autoFixAvailable: false,
  };
}

/**
 * Every scene in the proof, with the sequence it belongs to.
 * @param {import('../core/contracts.d.ts').Proof} proof
 * @returns {{scene: import('../core/contracts.d.ts').Scene, branchId: string|null}[]}
 */
export function allScenesOf(proof) {
  /** @type {{scene: import('../core/contracts.d.ts').Scene, branchId: string|null}[]} */
  const out = [];
  for (const scene of proof.spine || []) out.push({ scene, branchId: null });
  for (const branch of proof.branches || []) {
    for (const scene of branch.scenes || []) out.push({ scene, branchId: branch.id });
  }
  return out;
}

/**
 * Describe one VNode element for the cascade evaluator.
 * @param {any} node
 * @param {number} childIndex
 * @param {import('./css.js').ElementDesc[]} siblingsBefore
 * @returns {import('./css.js').ElementDesc}
 */
export function describeElement(node, childIndex = 0, siblingsBefore = []) {
  const attrs = node.a || {};
  /** @type {Record<string, string>} */
  const flat = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'style') continue;
    flat[k.toLowerCase()] = v === true ? '' : String(v);
  }
  const rawStyle = attrs.style;
  const inlineStyle = rawStyle && typeof rawStyle === 'object'
    ? styleString(/** @type {any} */ (rawStyle))
    : String(rawStyle || '');
  const classes = String(attrs.class || '').split(/\s+/).filter(Boolean);
  return {
    tag: String(node.t || '').toLowerCase(),
    id: attrs.id ? String(attrs.id) : null,
    classes,
    attrs: { ...flat, class: classes.join(' ') },
    inlineStyle,
    childIndex,
    siblingsBefore,
  };
}

/**
 * Walk a VNode tree, yielding each element with its ancestor chain.
 * @param {any} node
 * @param {(el: any, chain: import('./css.js').ElementDesc[]) => void} visit
 * @param {import('./css.js').ElementDesc[]} [chain]
 */
export function walkWithChain(node, visit, chain = []) {
  /**
   * @param {any} n
   * @param {import('./css.js').ElementDesc[]} ancestors
   * @param {number} index
   * @param {import('./css.js').ElementDesc[]} before
   */
  const step = (n, ancestors, index, before) => {
    if (n === null || n === undefined || n === false) return;
    if (Array.isArray(n)) {
      let i = index;
      const siblings = before;
      for (const child of n) {
        step(child, ancestors, i, siblings);
        if (child && typeof child === 'object' && !('raw' in child) && child.t) {
          siblings.push(describeElement(child, i, []));
          i++;
        }
      }
      return;
    }
    if (typeof n !== 'object' || 'raw' in n || !n.t) return;
    const desc = describeElement(n, index, before.slice());
    const nextChain = ancestors.concat([desc]);
    visit(n, nextChain);
    /** @type {import('./css.js').ElementDesc[]} */
    const childSiblings = [];
    let ci = 0;
    for (const child of n.c || []) {
      step(child, nextChain, ci, childSiblings);
      if (child && typeof child === 'object' && !('raw' in child) && child.t) {
        childSiblings.push(describeElement(child, ci, []));
        ci++;
      }
    }
  };
  step(node, chain, 0, []);
}

/**
 * The ancestor chain the artifact actually gives a scene: `html > body >
 * #pp-stage-root`, then the scene tree.
 * @returns {import('./css.js').ElementDesc[]}
 */
export function documentChainPrefix() {
  return [
    { tag: 'html', id: null, classes: [], attrs: { 'data-pp-artifact': '1' }, inlineStyle: '', childIndex: 0, siblingsBefore: [] },
    { tag: 'body', id: null, classes: [], attrs: {}, inlineStyle: '', childIndex: 0, siblingsBefore: [] },
    { tag: 'div', id: 'pp-stage-root', classes: [], attrs: { id: 'pp-stage-root' }, inlineStyle: '', childIndex: 0, siblingsBefore: [] },
  ];
}


/**
 * A specimen's name, for a refusal a seller has to act on.
 *
 * The title if it has one, else the source URL, else the id — the same fallback
 * order L8's `specimenTitle()` uses on stage. A refusal that names only an
 * opaque id makes the seller go looking for which page it is, and §18.3's
 * remedy is to look at that page.
 *
 * @param {import('../core/contracts.d.ts').Specimen} specimen
 * @returns {string}
 */
function specimenTitleOf(specimen) {
  const title = typeof specimen.title === 'string' ? specimen.title.trim() : '';
  if (title) return title;
  const url = typeof specimen.sourceUrl === 'string' ? specimen.sourceUrl.trim() : '';
  return url || specimen.id;
}

/**
 * Concatenated text of a VNode, for the "the label says something" check.
 * @param {any} node
 * @returns {string}
 */
export function nodeText(node) {
  if (node === null || node === undefined || node === false) return '';
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (typeof node !== 'object') return '';
  if ('raw' in node) return String(node.raw).replace(/<[^>]*>/g, '');
  return nodeText(node.c || []);
}

/**
 * Does this rendition appear in a rendered scene at all?
 *
 * A layout is free to select: `quoteCard` pulls one quotation, `sideNote` shows
 * one note. A rendition the scene lists but does not put on screen has nothing
 * to label, and demanding a label for it would refuse a perfectly honest proof.
 *
 * The check is content-based rather than declaration-based on purpose. Reading
 * only `data-pp-rendition` would let a layout render illustrative content and
 * escape the law simply by not declaring it, so the rendition's own label text,
 * its block text and its media are looked for in the tree as well.
 *
 * @param {any} tree
 * @param {import('../core/contracts.d.ts').Rendition} rendition
 * @returns {boolean}
 */
export function renditionAppearsIn(tree, rendition) {
  const text = nodeText(tree).replace(/\s+/g, ' ');
  const label = String(rendition.label || '').trim();
  if (label.length >= 3 && text.includes(label)) return true;
  for (const block of rendition.blocks || []) {
    for (const run of blockTextRuns(block)) {
      const probe = run.replace(/\s+/g, ' ').trim().slice(0, 40);
      if (probe.length >= 12 && text.includes(probe)) return true;
    }
  }
  const uris = new Set((rendition.media || []).map((m) => m.dataUri).filter(Boolean));
  if (uris.size === 0) return false;
  let found = false;
  walkWithChain(tree, (node) => {
    if (found) return;
    for (const value of Object.values(node.a || {})) {
      if (typeof value === 'string' && uris.has(value)) { found = true; return; }
    }
  });
  return found;
}

/**
 * The text runs a content block renders. A local reader rather than
 * `core/contracts.blockText`, because this only needs the strings and must not
 * throw on a block shape it has not seen.
 * @param {any} block
 * @returns {string[]}
 */
function blockTextRuns(block) {
  if (!block || typeof block !== 'object') return [];
  /** @type {string[]} */
  const out = [];
  if (typeof block.text === 'string') out.push(block.text);
  if (typeof block.label === 'string') out.push(block.label);
  if (typeof block.attribution === 'string') out.push(block.attribution);
  if (typeof block.caption === 'string') out.push(block.caption);
  if (Array.isArray(block.items)) for (const item of block.items) if (typeof item === 'string') out.push(item);
  if (Array.isArray(block.rows)) for (const row of block.rows) if (Array.isArray(row)) for (const cell of row) if (typeof cell === 'string') out.push(cell);
  return out;
}

/**
 * Judge one protected marker against the final stylesheet.
 *
 * `marker` decides only the two words the refusal is written in — the noun for
 * the element itself and the section of §18 it is refused under. Every
 * measurement below is about the cascade and the type, and none of them reads
 * a class name, which is why `.pp-edited` needed no second detector (E41).
 *
 * @param {import('./css.js').ElementDesc[]} chain  html → marker
 * @param {import('./css.js').StyleRule[]} rules
 * @param {{noun: string, law: string}} [marker]  defaults to the provenance label
 * @returns {{ok: boolean, reasons: string[], detail: Record<string, unknown>}}
 */
export function judgeLabelStyle(chain, rules, marker = LABEL_MARKER) {
  const computed = computeCascade(chain, rules);
  const self = computed[computed.length - 1];
  const noun = marker.noun;
  const law = marker.law;
  /** @type {string[]} */
  const reasons = [];

  for (let i = 0; i < chain.length; i++) {
    const style = computed[i];
    const who = i === chain.length - 1 ? noun : `an ancestor <${chain[i].tag}${chain[i].classes.length ? `.${chain[i].classes.join('.')}` : ''}>`;

    const display = (style.props.display || '').trim().toLowerCase();
    if (display === 'none') reasons.push(`display:none on ${who}`);
    if ((style.props['content-visibility'] || '').trim().toLowerCase() === 'hidden') reasons.push(`content-visibility:hidden on ${who}`);

    const visibility = (style.props.visibility || '').trim().toLowerCase();
    if (visibility === 'hidden' || visibility === 'collapse') reasons.push(`visibility:${visibility} on ${who}`);

    for (const prop of ['width', 'height', 'max-width', 'max-height']) {
      const raw = (style.props[prop] || '').trim().toLowerCase();
      if (!raw) continue;
      if (/^0(px|%|em|rem|vh|vw)?$/.test(raw)) reasons.push(`${prop}:0 on ${who}`);
    }

    const clip = (style.props.clip || '').replace(/\s+/g, '').toLowerCase();
    if (/^rect\(0(px)?,?0(px)?,?0(px)?,?0(px)?\)$/.test(clip)) reasons.push(`clip:rect(0,0,0,0) on ${who}`);
    const clipPath = (style.props['clip-path'] || '').replace(/\s+/g, '').toLowerCase();
    if (/^inset\((100%|5[0-9]%|[6-9][0-9]%)\)$/.test(clipPath) || clipPath === 'circle(0)' || clipPath === 'circle(0%)') {
      reasons.push(`clip-path:${style.props['clip-path']} on ${who}`);
    }

    const position = (style.props.position || '').trim().toLowerCase();
    if (position === 'absolute' || position === 'fixed') {
      for (const prop of ['left', 'top', 'right', 'bottom']) {
        const value = (style.props[prop] || '').trim();
        const n = parseFloat(value);
        if (Number.isFinite(n) && n <= -1000) reasons.push(`${prop}:${value} on ${who} puts it off screen`);
      }
    }
    const indent = parseFloat(style.props['text-indent'] || '');
    if (Number.isFinite(indent) && indent <= -1000) reasons.push(`text-indent:${style.props['text-indent']} on ${who} pushes the text off screen`);

    const transform = (style.props.transform || '').replace(/\s+/g, '').toLowerCase();
    if (/scale\(0(\.0*)?[,)]/.test(transform) || /scale\(0(\.0*)?\)/.test(transform)) reasons.push(`transform:${style.props.transform} on ${who} collapses it`);
    const translateOff = /translate[xy]?\((-\d{4,})(px)?/.exec(transform);
    if (translateOff) reasons.push(`transform:${style.props.transform} on ${who} moves it off screen`);
    if ((style.props.scale || '').trim() === '0') reasons.push(`scale:0 on ${who}`);

    // A filter on an *ancestor* paints that ancestor's whole subtree, label and
    // illustrative content together, so a colour transfer there is a broken
    // deck rather than a hidden label and the contrast measurement below —
    // which reads the label's own filter — is not the right instrument for it.
    // The one case worth naming here is the one that erases without touching
    // anything else's legibility: a fully transparent layer.
    if (i < chain.length - 1) {
      const ancestorFilter = parseFilter(style.props.filter || '', style.fontSizePx);
      if (ancestorFilter.transfer) {
        const probe = ancestorFilter.transfer({ r: 255, g: 255, b: 255, a: 1 });
        if (probe.a === 0) reasons.push(`filter:${String(style.props.filter).trim()} on ${who} paints it at zero alpha`);
      }
    }
  }

  if (self.effectiveOpacity === 0) reasons.push(`opacity:0 — ${noun} is styled to invisibility`);

  const fontSizePx = self.fontSizePx;
  if (!(fontSizePx >= MIN_LABEL_FONT_PX)) {
    reasons.push(`font-size computes to ${round(fontSizePx)}px, below the ${MIN_LABEL_FONT_PX}px floor ${law} enforces`);
  }

  // C9. The size floor, measured rather than spelled: room for the marker's own
  // line of text, and tracking that leaves the characters apart.
  const room = judgeLabelRoom(chain, computed, marker);
  reasons.push(...room.reasons);

  // The floor again, on the size the label is actually painted at. A chain that
  // scales the label to a fifth renders 12px type at 2.4px, and no list of
  // `transform` spellings would have caught `scale(0.2)` while catching
  // `scale(0)`.
  if (room.scale < 1) {
    const rendered = fontSizePx * room.scale;
    if (!(rendered >= MIN_LABEL_FONT_PX)) {
      reasons.push(`${noun} is scaled by ${round(room.scale)}, so ${round(fontSizePx)}px type renders at ${round(rendered)}px — below the ${MIN_LABEL_FONT_PX}px floor ${law} enforces`);
    }
  }

  // C9/P8. The contrast floor is measured on the paint that reaches the glyph,
  // after the label's own filter has had its way with it — not on the `color`
  // declaration, which is only where the paint usually comes from. That is what
  // makes `-webkit-text-fill-color:transparent` and `filter:brightness(0)` the
  // same finding as `color:transparent`, rather than three rules.
  const background = resolveBackground(chain, computed);
  const paint = glyphPaint(self);
  const ownFilter = parseFilter(self.props.filter || '', self.fontSizePx);
  const painted = ownFilter.transfer ? ownFilter.transfer(paint.color) : paint.color;
  // The marker's own filter paints its own background too; the backdrop
  // it sits on belongs to an ancestor and is not filtered with it. Applying the
  // transfer to the backdrop as well would be right only when the label paints
  // an opaque background of its own, and that is exactly when it does.
  const ownBackground = parseColor(backgroundColorOf(self) || '');
  const filteredBackground = ownFilter.transfer && ownBackground && ownBackground.a >= 0.95
    ? ownFilter.transfer(ownBackground)
    : background;
  const foreground = compositeOver({ ...painted, a: painted.a * self.effectiveOpacity }, filteredBackground);
  const ratio = contrastRatio(foreground, filteredBackground);
  if (!(ratio >= CONTRAST_AA_BODY)) {
    const source = paint.via === 'color' ? '' : ` (the glyph paint comes from ${paint.via})`;
    const filtered = ownFilter.transfer ? ` after filter:${String(self.props.filter).trim()}` : '';
    reasons.push(
      `computed contrast is ${ratio.toFixed(2)}:1 (${toHex(foreground)} on ${toHex(filteredBackground)})${source}${filtered}, `
      + `below the ${CONTRAST_AA_BODY}:1 floor ${law} enforces`,
    );
  }

  return {
    ok: reasons.length === 0,
    reasons,
    detail: {
      fontSizePx: round(fontSizePx),
      contrast: Number(ratio.toFixed(3)),
      foreground: toHex(foreground),
      background: toHex(background),
      opacity: Number(self.effectiveOpacity.toFixed(3)),
      glyphPaint: toHex(painted),
      glyphPaintFrom: paint.via,
      blurPx: round(room.blurPx),
      lineBoxPx: round(room.lineBoxPx),
      boxHeightPx: room.boxHeightPx === null ? null : round(room.boxHeightPx),
      boxWidthPx: room.boxWidthPx === null ? null : round(room.boxWidthPx),
      clipped: room.clipped,
      trackingPx: round(room.trackingPx),
      scale: round(room.scale),
    },
  };
}

/**
 * Is there room for the label's own line of text? (C9)
 *
 * Three measurements, taken off the cascade rather than off the spelling of any
 * one declaration:
 *
 *   1. **The line box** the label's `font-size` and `line-height` produce. That
 *      is the height a single line of it needs.
 *   2. **The tightest fixed box** anywhere on the chain from `<html>` to the
 *      label — the smallest resolvable `height`/`max-height` and
 *      `width`/`max-width` — together with whether anything on that chain
 *      clips. A short box that lets its content spill is a layout choice; a
 *      short box that cuts it off is the label being hidden. `height:1px;
 *      overflow:hidden` is the second, and so is every other number below the
 *      line box.
 *   3. **Tracking**, as a fraction of the size it is applied at. `letter-spacing`
 *      and `word-spacing` inherit, so the whole chain is read and the tightest
 *      wins.
 *
 * A dimension whose pixel value depends on layout — `50%`, `auto`, `calc()` —
 * is not judged at all, because the emitter does not lay the document out and a
 * law resting on a guess is worse than no law. `resolveLengthPx` returns `null`
 * for those, and `null` means "this one says nothing", not "this one is fine".
 *
 * Scroll containers are deliberately **not** counted as clipping: `overflow:
 * auto` on a short box leaves the label reachable, and the runtime's own scene
 * container is exactly that. `hidden` and `clip` are not reachable.
 *
 * A fourth measurement joined the three above for P8. `filter: blur(20px)`
 * leaves every one of them satisfied — the box is the right size, the tracking
 * is normal, the contrast between the two colours is unchanged — and the label
 * is an unreadable smear, because blur is the one thing a filter does that is
 * not a function of colour. So the blur radius is measured against the type it
 * is applied to, the same way the box is measured against the line box: a
 * ratio, in the units the attack has to survive.
 *
 * @param {import('./css.js').ElementDesc[]} chain     html → marker
 * @param {import('./css.js').ComputedStyle[]} computed
 * @param {{noun: string, law: string}} [marker]  defaults to the provenance label
 * @returns {{reasons: string[], lineBoxPx: number, boxHeightPx: number|null, boxWidthPx: number|null, clipped: boolean, trackingPx: number, scale: number, blurPx: number}}
 */
export function judgeLabelRoom(chain, computed, marker = LABEL_MARKER) {
  const noun = marker.noun;
  const law = marker.law;
  const self = computed[computed.length - 1];
  const rootPx = computed.length ? computed[0].fontSizePx : 16;
  const fontSizePx = self.fontSizePx;
  const lineBoxPx = Math.max(fontSizePx, resolveLineHeightPx(self.props['line-height'], fontSizePx, rootPx));

  const widthFloor = LABEL_MIN_WIDTH_EM * fontSizePx;
  /** @type {string[]} */
  const reasons = [];
  /** @type {number|null} */
  let boxHeightPx = null;
  /** @type {number|null} */
  let boxWidthPx = null;
  let clipped = false;
  let trackingPx = 0;
  let scale = 1;
  let blurPx = 0;

  for (let i = 0; i < computed.length; i++) {
    const style = computed[i];
    const el = chain[i];
    const who = i === chain.length - 1 ? noun : `an ancestor <${el.tag}${el.classes.length ? `.${el.classes.join('.')}` : ''}>`;

    // Clipping is judged **on the element that declares the small box**, never
    // across the chain. A one-pixel marker inside a clipping stage still shows
    // its text: the text spills out of the marker and the stage clips at the
    // stage's own edge, which is nowhere near it. It is the element that is
    // both too small and cutting its own content off that hides the marker —
    // `.pp-provenance{height:1px;overflow:hidden}`, exactly.
    const cuts = clipsContent(style);
    if (cuts) clipped = true;

    for (const prop of ['height', 'max-height']) {
      const px = resolveLengthPx(style.props[prop], style.fontSizePx, rootPx);
      if (px === null) continue;
      if (boxHeightPx === null || px < boxHeightPx) boxHeightPx = px;
      if (cuts && px < lineBoxPx) {
        reasons.push(
          `${prop}:${String(style.props[prop]).trim()} on ${who} leaves ${round(px)}px for a line box of ${round(lineBoxPx)}px, `
          + `and that element clips what does not fit — a box too short to hold one line of ${noun} is ${noun} styled to invisibility (${law})`,
        );
      }
    }
    for (const prop of ['width', 'max-width']) {
      const px = resolveLengthPx(style.props[prop], style.fontSizePx, rootPx);
      if (px === null) continue;
      if (boxWidthPx === null || px < boxWidthPx) boxWidthPx = px;
      if (cuts && px < widthFloor) {
        reasons.push(
          `${prop}:${String(style.props[prop]).trim()} on ${who} leaves ${round(px)}px against a ${round(widthFloor)}px floor `
          + `(${LABEL_MIN_WIDTH_EM}em of ${round(fontSizePx)}px type), and that element clips what does not fit — there is not room to read it (${law})`,
        );
      }
    }

    for (const prop of ['letter-spacing', 'word-spacing']) {
      const raw = String(style.props[prop] || '').trim().toLowerCase();
      if (!raw || raw === 'normal') continue;
      const px = resolveLengthPx(raw, style.fontSizePx, rootPx);
      if (px === null) continue;
      const floor = LABEL_MIN_TRACKING_EM * style.fontSizePx;
      if (px < trackingPx) trackingPx = px;
      if (px < floor) {
        reasons.push(
          `${prop}:${String(style.props[prop]).trim()} on ${who} computes to ${round(px)}px against ${round(style.fontSizePx)}px type, `
          + `past the ${LABEL_MIN_TRACKING_EM}em floor — the characters collapse onto one another`,
        );
      }
    }

    // Blur composes down the chain: a blurred ancestor blurs the marker inside
    // it, and a marker blurred inside a blurred ancestor is blurred twice. Two
    // Gaussians add in quadrature, which is what σ means.
    const own = parseFilter(style.props.filter || '', style.fontSizePx).blurPx;
    if (own > 0) blurPx = Math.sqrt(blurPx * blurPx + own * own);

    scale *= scaleFactorOf(style);
  }

  const blurFloor = LABEL_MAX_BLUR_EM * fontSizePx;
  if (blurPx > blurFloor) {
    reasons.push(
      `${noun} is painted under a ${round(blurPx)}px blur against ${round(fontSizePx)}px type — `
      + `past the ${LABEL_MAX_BLUR_EM}em ceiling (${round(blurFloor)}px), which is where the strokes of the glyphs stop resolving (${law})`,
    );
  }

  return { reasons, lineBoxPx, boxHeightPx, boxWidthPx, clipped, trackingPx, scale, blurPx };
}

/**
 * Does this element cut its content off rather than let it spill?
 * @param {import('./css.js').ComputedStyle} style
 * @returns {boolean}
 */
export function clipsContent(style) {
  const shorthand = String(style.props.overflow || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const values = [
    ...shorthand,
    String(style.props['overflow-x'] || '').trim().toLowerCase(),
    String(style.props['overflow-y'] || '').trim().toLowerCase(),
  ];
  return values.some((v) => CLIPPING_OVERFLOW.has(v));
}

/**
 * The smallest scale factor an element applies to itself, from `transform`,
 * the `scale` property, or `zoom`. 1 when it applies none.
 * @param {import('./css.js').ComputedStyle} style
 * @returns {number}
 */
export function scaleFactorOf(style) {
  let factor = 1;

  const transform = String(style.props.transform || '').toLowerCase();
  const fn = /scale(x|y|3d)?\(([^)]*)\)/g;
  let hit;
  while ((hit = fn.exec(transform)) !== null) {
    const parts = hit[2].split(',').map((p) => parseFloat(p.trim())).filter((n) => Number.isFinite(n));
    if (!parts.length) continue;
    factor *= Math.min(...parts.map(Math.abs));
  }

  const scaleProp = String(style.props.scale || '').trim().toLowerCase();
  if (scaleProp && scaleProp !== 'none') {
    const parts = scaleProp.split(/\s+/).map((p) => (p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p))).filter((n) => Number.isFinite(n));
    if (parts.length) factor *= Math.min(...parts.map(Math.abs));
  }

  const zoom = String(style.props.zoom || '').trim().toLowerCase();
  if (zoom && zoom !== 'normal') {
    const n = zoom.endsWith('%') ? parseFloat(zoom) / 100 : parseFloat(zoom);
    if (Number.isFinite(n) && n >= 0) factor *= n;
  }

  return factor;
}

/** @param {number} n @returns {number} */
function round(n) { return Math.round(n * 100) / 100; }

/**
 * What actually fills the label's glyphs (P8).
 *
 * `color` is the *default* source of the glyph paint, not the paint itself.
 * `-webkit-text-fill-color` replaces it — in Chromium, WebKit and Gecko alike —
 * and `.pp-provenance{-webkit-text-fill-color:transparent}` therefore leaves
 * `color` reading a perfectly compliant `#3d4350` while the text is not there.
 * A check that reads `color` is checking a declaration; a check that reads the
 * paint is checking the thing §18.1 is about.
 *
 * A glyph with no fill can still be legible if it is *stroked*, so a zero-alpha
 * fill falls through to `-webkit-text-stroke-color` when there is a stroke wide
 * enough to draw — that is outlined type, which is a design, not a hiding
 * place. A stroke of zero width paints nothing and does not rescue it.
 *
 * @param {import('./css.js').ComputedStyle} style
 * @returns {{color: import('./color-value.js').Rgba, via: string}}
 */
export function glyphPaint(style) {
  const props = style.props || {};
  const named = parseColor(props.color || '') || { r: 0, g: 0, b: 0, a: 1 };

  const fillRaw = String(props['-webkit-text-fill-color'] || '').trim();
  let paint = named;
  let via = 'color';
  if (fillRaw && fillRaw.toLowerCase() !== 'currentcolor') {
    const parsed = parseColor(fillRaw);
    if (parsed) { paint = parsed; via = '-webkit-text-fill-color'; }
  }
  if (paint.a >= 0.05) return { color: paint, via };

  // Nothing fills the glyph. Is anything drawing its outline?
  const strokeShorthand = String(props['-webkit-text-stroke'] || '').trim();
  const widthRaw = String(props['-webkit-text-stroke-width'] || '').trim()
    || (strokeShorthand ? strokeShorthand.split(/\s+/)[0] : '');
  const widthPx = resolveLengthPx(widthRaw, style.fontSizePx, style.fontSizePx);
  if (!(widthPx !== null && widthPx > 0)) return { color: paint, via };

  const strokeColourRaw = String(props['-webkit-text-stroke-color'] || '').trim()
    || (strokeShorthand ? strokeShorthand.split(/\s+/).slice(1).join(' ') : '');
  const stroke = strokeColourRaw && strokeColourRaw.toLowerCase() !== 'currentcolor'
    ? parseColor(strokeColourRaw)
    : named;
  if (!stroke || stroke.a < 0.05) return { color: paint, via };
  return { color: stroke, via: '-webkit-text-stroke-color' };
}

/**
 * A `filter` value, read as the two different things a filter does (P8).
 *
 * Every filter function is either a **colour transfer** — a function from the
 * pixel it was going to paint to the pixel it paints instead — or a **spatial**
 * operation that moves light between pixels. The first can be evaluated exactly
 * on the two colours §18.1 already measures, which is what turns
 * `filter:opacity(0)`, `brightness(0)`, `invert(1)`, `grayscale(1)` and every
 * combination of them from a list of spellings into one contrast measurement.
 * The second cannot, and for text there is only one that matters: blur.
 *
 * Unknown functions are ignored rather than guessed at. `drop-shadow` adds a
 * shadow behind the glyphs without touching them, and a filter nobody has
 * implemented is not a hiding place until somebody does.
 *
 * @param {string} value
 * @param {number} fontSizePx  for `em`-relative blur radii
 * @returns {{transfer: ((c: import('./color-value.js').Rgba) => import('./color-value.js').Rgba)|null, blurPx: number, names: string[]}}
 */
export function parseFilter(value, fontSizePx = 16) {
  const text = String(value || '').trim();
  if (!text || text.toLowerCase() === 'none') return { transfer: null, blurPx: 0, names: [] };

  /** @type {((c: any) => any)[]} */
  const steps = [];
  /** @type {string[]} */
  const names = [];
  let blurPx = 0;

  const fn = /([a-z-]+)\(([^)]*)\)/gi;
  let hit;
  while ((hit = fn.exec(text)) !== null) {
    const name = hit[1].toLowerCase();
    const raw = hit[2].trim();
    names.push(name);
    if (name === 'blur') {
      const px = resolveLengthPx(raw, fontSizePx, fontSizePx);
      if (px !== null && px > blurPx) blurPx = px;
      continue;
    }
    const amount = filterAmount(raw);
    if (amount === null) continue;
    if (name === 'opacity') steps.push((c) => ({ ...c, a: c.a * amount }));
    else if (name === 'brightness') steps.push((c) => channels(c, (v) => v * amount));
    else if (name === 'contrast') steps.push((c) => channels(c, (v) => (v - 127.5) * amount + 127.5));
    else if (name === 'invert') steps.push((c) => channels(c, (v) => v * (1 - amount) + (255 - v) * amount));
    else if (name === 'grayscale') steps.push((c) => mixToward(c, luma(c), amount));
    else if (name === 'saturate') steps.push((c) => saturate(c, amount));
    else if (name === 'sepia') steps.push((c) => sepia(c, amount));
  }

  const transfer = steps.length
    ? (/** @type {import('./color-value.js').Rgba} */ c) => steps.reduce((acc, step) => step(acc), c)
    : null;
  return { transfer, blurPx, names };
}

/** `50%`, `0.5`, `0` — the number a filter function takes. @param {string} raw @returns {number|null} */
function filterAmount(raw) {
  const text = String(raw).trim();
  if (!text) return 1;
  const n = parseFloat(text);
  if (!Number.isFinite(n)) return null;
  return text.endsWith('%') ? n / 100 : n;
}

/** @param {import('./color-value.js').Rgba} c @param {(v: number) => number} f */
function channels(c, f) {
  const clamp = (v) => Math.max(0, Math.min(255, v));
  return { r: clamp(f(c.r)), g: clamp(f(c.g)), b: clamp(f(c.b)), a: c.a };
}

/** @param {import('./color-value.js').Rgba} c */
function luma(c) { return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; }

/** @param {import('./color-value.js').Rgba} c @param {number} grey @param {number} amount */
function mixToward(c, grey, amount) {
  const mix = (v) => v * (1 - amount) + grey * amount;
  return channels(c, mix);
}

/** @param {import('./color-value.js').Rgba} c @param {number} amount */
function saturate(c, amount) {
  const grey = luma(c);
  return channels(c, (v) => grey + (v - grey) * amount);
}

/** @param {import('./color-value.js').Rgba} c @param {number} amount */
function sepia(c, amount) {
  const r = 0.393 * c.r + 0.769 * c.g + 0.189 * c.b;
  const g = 0.349 * c.r + 0.686 * c.g + 0.168 * c.b;
  const b = 0.272 * c.r + 0.534 * c.g + 0.131 * c.b;
  const clamp = (v) => Math.max(0, Math.min(255, v));
  return {
    r: clamp(c.r * (1 - amount) + r * amount),
    g: clamp(c.g * (1 - amount) + g * amount),
    b: clamp(c.b * (1 - amount) + b * amount),
    a: c.a,
  };
}

/**
 * The colour actually behind the label: the nearest painted ancestor, with any
 * translucent layers above it composited on top.
 * @param {import('./css.js').ElementDesc[]} chain
 * @param {import('./css.js').ComputedStyle[]} computed
 * @returns {import('./color-value.js').Rgba}
 */
export function resolveBackground(chain, computed) {
  /** @type {import('./color-value.js').Rgba[]} */
  const layers = [];
  for (let i = computed.length - 1; i >= 0; i--) {
    const value = backgroundColorOf(computed[i]);
    if (!value) continue;
    const colour = parseColor(value);
    if (!colour || colour.a === 0) continue;
    layers.push(colour);
    if (colour.a >= 1) break;
  }
  let result = { ...DEFAULT_PAGE_BACKGROUND };
  for (let i = layers.length - 1; i >= 0; i--) result = compositeOver(layers[i], result);
  return result;
}

/**
 * The scenes whose specimen was edited after capture (§18.3).
 *
 * Derived from the proof exactly the way the runtime derives `ctx.specimen` —
 * `proof.specimens` looked up by `scene.specimenId` — so the expectation the
 * emitter checks is computed from the model rather than read back off the
 * render it is checking. `Runtime.layoutContext` resolves the same map, which
 * is what makes "L8 renders a marker whenever `ctx.specimen` is edited" and
 * "L10 requires one whenever the scene's specimen is edited" the same sentence
 * rather than two that can drift.
 *
 * `specimenEdited` is L8's reader, not a second one (E17): the model says
 * `edited === true` *or* carries edit notes, and a specimen with notes and a
 * false flag was edited by something that half-remembered to say so.
 *
 * @param {import('../core/contracts.d.ts').Proof} proof
 * @returns {Map<string, import('../core/contracts.d.ts').Specimen>} scene id → the edited specimen
 */
export function editedScenesOf(proof) {
  const specimenById = new Map((proof.specimens || []).map((sp) => [sp.id, sp]));
  /** @type {Map<string, import('../core/contracts.d.ts').Specimen>} */
  const out = new Map();
  for (const { scene } of allScenesOf(proof)) {
    if (!scene.specimenId) continue;
    const specimen = specimenById.get(scene.specimenId);
    if (specimen && specimenEdited(specimen)) out.set(scene.id, specimen);
  }
  return out;
}

/**
 * Does the serialized document carry an element with this class?
 *
 * Written against the class *tokens* rather than as `\bpp-edited\b`, because
 * `\b` matches at a hyphen: the word-boundary form answers "yes" to
 * `class="pp-edited-notice"`, which is the strip the marker sits in and not the
 * marker. That would have let a layout that renders the container and drops the
 * pill pass the one check that reads the emitted file.
 *
 * @param {string} html
 * @param {string} className
 * @returns {boolean}
 */
export function htmlHasClass(html, className) {
  if (typeof html !== 'string' || !html) return false;
  const attr = /\sclass\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
  let match = attr.exec(html);
  while (match) {
    const value = match[2] !== undefined ? match[2] : (match[3] !== undefined ? match[3] : match[4] || '');
    if (value.split(/\s+/).includes(className)) return true;
    match = attr.exec(html);
  }
  return false;
}

/**
 * Enforce the §18 honesty laws over a whole proof.
 *
 * Two laws, one walk. §18.1 asks whether illustrative content carries its
 * label; §18.3 asks whether an edited specimen says so. They are checked in
 * the same loop, against the same rendered trees and the same resolved
 * cascade, because they are the same shape — derive the expectation from the
 * model, look for it in the render, refuse when it is missing or unreadable —
 * and because rendering every scene twice to ask two questions about it would
 * be the only thing a second entry point bought (E42).
 *
 * @param {import('../core/contracts.d.ts').Proof} proof
 * @param {string} html      the emitted document (used to confirm the markers
 *                           survived serialization into the first paint)
 * @param {string} css       the final stylesheet: runtime + theme + user CSS
 * @param {object} [options]
 * @param {(scene: import('../core/contracts.d.ts').Scene) => any} [options.renderScene]
 *        renders a scene to a VNode tree; supplied by `emit()` so the check
 *        runs against the same trees the artifact will render
 * @param {boolean} [options.labelDisableRequested]
 *        the caller explicitly asked for `labelIllustrativeContent: false`
 * @param {'presenter'|'review'|'both'} [options.mode]
 * @returns {import('../core/contracts.d.ts').Finding[]}
 */
export function assertProvenance(proof, html, css, options = {}) {
  /** @type {import('../core/contracts.d.ts').Finding[]} */
  const findings = [];
  const { rules } = parseStylesheet(css || '');
  const renditionById = new Map((proof.renditions || []).map((r) => [r.id, r]));
  const renderScene = options.renderScene || null;
  const mode = options.mode || (proof.emitOptions && proof.emitOptions.mode) || 'both';
  const reviewReachable = mode === 'review' || mode === 'both';

  // 1. Claims that were never earned.
  for (const rendition of proof.renditions || []) {
    if (isUnearnedVerification(rendition)) {
      findings.push(provenanceFinding(
        `Rendition "${rendition.label}" (${rendition.id}) claims provenance "verified-by-user" with no promotion record. `
        + 'Only an explicit promotion recording who verified it and when can produce that value (§9); '
        + 'until then the artifact must label it as illustrative.',
        { specimenId: rendition.specimenId, renditionId: rendition.id, check: 'promotion-record' },
      ));
    }
  }

  const needingLabel = (proof.renditions || []).filter(requiresProvenanceLabel);

  // 2. An option the law does not allow.
  const optionFinding = labelOptionFinding(proof, {
    labelDisableRequested: options.labelDisableRequested,
    mode,
  });
  if (optionFinding) findings.push(optionFinding);

  // §18.3's half of the expectation, derived from the model exactly as §18.1's
  // is: which scenes put an edited specimen on screen.
  const editedScenes = editedScenesOf(proof);

  if (needingLabel.length === 0 && editedScenes.size === 0) return findings;

  // 3 and 4. Markup and stylesheet, scene by scene.
  const prefix = documentChainPrefix();
  let labelsSeenAnywhere = 0;

  for (const { scene, branchId } of allScenesOf(proof)) {
    const needed = (scene.renditionIds || [])
      .map((id) => renditionById.get(id))
      .filter((r) => r && requiresProvenanceLabel(r));
    const editedSpecimen = editedScenes.get(scene.id) || null;
    if (needed.length === 0 && !editedSpecimen) continue;

    if (!renderScene) {
      if (needed.length > 0) {
        findings.push(provenanceFinding(
          `Scene ${scene.id} renders ${needed.length} rendition(s) that must carry a provenance label, but the emitter was given no way to render the scene, `
          + 'so the label could not be verified. The emit is refused rather than assumed correct.',
          { sceneId: scene.id, branchId: branchId || undefined, check: 'render' },
        ));
      }
      if (editedSpecimen) {
        findings.push(provenanceFinding(
          `Scene ${scene.id} renders specimen "${specimenTitleOf(editedSpecimen)}" (${editedSpecimen.id}), which was edited after capture, `
          + 'but the emitter was given no way to render the scene, so the §18.3 marker could not be verified. '
          + 'The emit is refused rather than assumed correct.',
          { sceneId: scene.id, branchId: branchId || undefined, specimenId: editedSpecimen.id, check: 'edited-render' },
        ));
      }
      continue;
    }

    const tree = renderScene(scene);
    /** @type {{marker: typeof PROTECTED_MARKERS[number], node: any, chain: import('./css.js').ElementDesc[]}[]} */
    const markers = [];
    /** @type {Map<string, {node: any, chain: import('./css.js').ElementDesc[]}[]>} */
    const scoped = new Map();
    /** @type {{id: string, chain: import('./css.js').ElementDesc[]}[]} */
    const scopes = [];
    /** Specimen ids an edit marker names in its own attribute. */
    const namedByMarker = new Set();

    walkWithChain(tree, (node, chain) => {
      const desc = chain[chain.length - 1];
      const renditionId = desc.attrs[RENDITION_ATTR];
      if (renditionId) scopes.push({ id: renditionId, chain });
      const marker = markerFor(desc);
      if (marker) {
        markers.push({ marker, node, chain: prefix.concat(chain) });
        const names = desc.attrs[EDITED_FOR_ATTR];
        if (marker === EDITED_MARKER && names) namedByMarker.add(names);
      }
    });

    /** @type {{node: any, chain: import('./css.js').ElementDesc[]}[]} */
    const labels = markers.filter((m) => m.marker === LABEL_MARKER).map((m) => ({ node: m.node, chain: m.chain }));
    labelsSeenAnywhere += labels.length;

    // A rendition can be rendered by more than one element in a scene — a
    // panel head and a body cell, say — and the label lives in exactly one of
    // them. Union across every subtree carrying the id, rather than letting the
    // last one seen decide, which would report a labelled rendition as bare.
    for (const scope of scopes) {
      const inside = labels.filter((l) => chainStartsWith(l.chain.slice(prefix.length), scope.chain));
      const already = scoped.get(scope.id) || [];
      for (const hit of inside) if (!already.includes(hit)) already.push(hit);
      scoped.set(scope.id, already);
    }

    // A layout may select: `quoteCard` pulls one quotation out of the scene's
    // renditions and shows only that. What is not on screen has nothing to
    // label, so the requirement is scoped to what the scene actually rendered.
    const unscopedShown = needed.filter((r) => !scoped.has(r.id) && renditionAppearsIn(tree, r));

    for (const rendition of needed) {
      const own = scoped.get(rendition.id);
      if (own !== undefined) {
        if (own.length === 0) {
          findings.push(provenanceFinding(
            `Rendition "${rendition.label}" (${rendition.id}) is rendered in scene ${scene.id} with provenance "${rendition.provenance}" `
            + `but its subtree carries no .${PROVENANCE_LABEL_CLASS} element. §9 requires a visible, non-removable label.`,
            { sceneId: scene.id, branchId: branchId || undefined, renditionId: rendition.id, specimenId: rendition.specimenId, check: 'label-present' },
          ));
        }
        continue;
      }
      if (!unscopedShown.includes(rendition)) continue;   // not on screen, nothing to label

      // On screen but not scoped: the scene must at least carry one label per
      // rendition that needs one.
      const scopedLabelCount = [...scoped.values()].reduce((sum, list) => sum + list.length, 0);
      const spareLabels = labels.length - scopedLabelCount;
      if (spareLabels < unscopedShown.length) {
        findings.push(provenanceFinding(
          `Scene ${scene.id} renders ${unscopedShown.length} unscoped rendition(s) needing a provenance label but has ${spareLabels} spare `
          + `.${PROVENANCE_LABEL_CLASS} element(s). Rendition "${rendition.label}" (${rendition.id}, provenance "${rendition.provenance}") is unlabelled.`,
          { sceneId: scene.id, branchId: branchId || undefined, renditionId: rendition.id, specimenId: rendition.specimenId, check: 'label-count' },
        ));
      }
    }

    // §18.3, the markup half. "If a specimen was edited, the artifact says so."
    // The expectation came off the model above; this is the render answering.
    //
    // `markedSpecimenIds` is L8's own reader — the one `withEditedNotice` uses
    // to decide whether a layout already marked the specimen before it appends
    // the notice strip. Asking the render with the same function the render
    // asked itself is what makes this a check rather than a second opinion: a
    // layout that stops rendering the pill, or a sweep that stops appending the
    // strip, fails here on the next emit.
    if (editedSpecimen) {
      const marked = markedSpecimenIds(tree);
      if (!marked.has(editedSpecimen.id) && !namedByMarker.has(editedSpecimen.id)) {
        const records = editRecordCount(editedSpecimen);
        findings.push(provenanceFinding(
          `Scene ${scene.id} renders specimen "${specimenTitleOf(editedSpecimen)}" (${editedSpecimen.id}), which the presenting team edited after capture`
          + `${records ? ` and which carries ${records} edit record(s)` : ''}, but the scene rendered no .${EDITED_MARK_CLASS} element for it — `
          + `neither inside a [${SPECIMEN_ATTR}="${editedSpecimen.id}"] subtree nor carrying ${EDITED_FOR_ATTR}="${editedSpecimen.id}". `
          + '§18.3 requires the artifact to say a specimen was edited, '
          + 'and a client reading the "before" side of this scene would be shown changed material as if it were their own page as captured.',
          {
            sceneId: scene.id,
            branchId: branchId || undefined,
            specimenId: editedSpecimen.id,
            editRecords: records,
            check: 'edited-present',
          },
        ));
      }
    }

    // The stylesheet half, over **every** protected marker the scene rendered
    // rather than over the provenance label alone (E41). One loop, one
    // detector, two laws: a `.pp-edited` faded to `opacity:0`, crushed into a
    // one-pixel clipping box, tracked to `-1em`, blurred, or painted at 3:1
    // through the theme's own custom properties is refused by exactly the code
    // that refuses it on `.pp-provenance`.
    for (const found of markers) {
      const { marker } = found;
      const text = nodeText(found.node).replace(/\s+/g, ' ').trim();
      if (!text) {
        findings.push(provenanceFinding(
          `A .${marker.className} element in scene ${scene.id} renders no text. ${marker.emptyText} (${marker.law}).`,
          {
            sceneId: scene.id,
            branchId: branchId || undefined,
            marker: marker.className,
            check: marker === LABEL_MARKER ? 'label-text' : 'edited-text',
          },
        ));
      }
      const verdict = judgeLabelStyle(found.chain, rules, marker);
      if (!verdict.ok) {
        findings.push(provenanceFinding(
          `${marker.title} in scene ${scene.id} does not survive the emitted stylesheet: ${verdict.reasons.join('; ')}. `
          + marker.nonRemovable,
          {
            sceneId: scene.id,
            branchId: branchId || undefined,
            marker: marker.className,
            check: marker === LABEL_MARKER ? 'label-style' : 'edited-style',
            ...verdict.detail,
          },
        ));
      }
    }
  }

  // 5. The marker has to be in the file, not just in the tree we rendered.
  //
  // Only the opening scene is pre-rendered into the document; the rest are
  // rendered at presentation time from the model payload, and the loop above
  // has already checked those trees. This is the one check that reads the
  // bytes, and it reads them for both laws.
  if (typeof html === 'string' && html.length > 0) {
    const firstScene = (proof.spine || [])[0];
    const firstNeeds = firstScene
      ? (firstScene.renditionIds || []).map((id) => renditionById.get(id)).filter((r) => r && requiresProvenanceLabel(r)).length
      : 0;
    if (labelsSeenAnywhere > 0 && firstNeeds > 0 && !htmlHasClass(html, PROVENANCE_LABEL_CLASS)) {
      findings.push(provenanceFinding(
        `The opening scene renders ${firstNeeds} rendition(s) needing a provenance label, but no .${PROVENANCE_LABEL_CLASS} element reached the emitted document. `
        + 'The first thing the client sees would be unlabelled illustrative content.',
        { sceneId: firstScene.id, check: 'label-serialized' },
      ));
    }
    const firstEdited = firstScene ? editedScenes.get(firstScene.id) : null;
    if (firstEdited && renderScene && !htmlHasClass(html, EDITED_MARK_CLASS)) {
      findings.push(provenanceFinding(
        `The opening scene renders specimen "${specimenTitleOf(firstEdited)}" (${firstEdited.id}), which was edited after capture, `
        + `but no .${EDITED_MARK_CLASS} element reached the emitted document. `
        + 'The first thing the client sees would be edited material presented as their own page as captured (§18.3).',
        { sceneId: firstScene.id, specimenId: firstEdited.id, check: 'edited-serialized' },
      ));
    }
  }

  return findings;
}

/**
 * The §9 check that `labelIllustrativeContent` may not be disabled for a build
 * a recipient can open in Review mode.
 *
 * Extracted because it has two call sites and must have one implementation.
 * `normalizeEmitOptions` forces the flag back to true before the model is
 * serialized, so by the time L11's `provenanceUnlabeled` rule reads
 * `proof.emitOptions` the evidence of the request is gone — which is why the
 * rule skips L10's copy of this finding and why `emit()` has to raise it from
 * the options it was actually handed. See decision E10.
 *
 * @param {import('../core/contracts.d.ts').Proof} proof
 * @param {{labelDisableRequested?: boolean, mode?: string}} options
 * @returns {import('../core/contracts.d.ts').Finding|null}
 */
export function labelOptionFinding(proof, options = {}) {
  if (!options.labelDisableRequested) return null;
  const mode = options.mode || (proof.emitOptions && proof.emitOptions.mode) || 'both';
  if (mode !== 'review' && mode !== 'both') return null;
  const needingLabel = (proof.renditions || []).filter(requiresProvenanceLabel);
  if (needingLabel.length === 0) return null;
  return provenanceFinding(
    `This build is reachable in Review mode (mode: "${mode}") and carries ${needingLabel.length} rendition(s) that are not client-supplied, `
    + 'so `labelIllustrativeContent` cannot be disabled (§9). The emit is refused rather than quietly overridden.',
    { check: 'label-option' },
  );
}

/**
 * Is `chain` rooted at `prefixChain`?
 * @param {import('./css.js').ElementDesc[]} chain
 * @param {import('./css.js').ElementDesc[]} prefixChain
 * @returns {boolean}
 */
function chainStartsWith(chain, prefixChain) {
  if (chain.length < prefixChain.length) return false;
  for (let i = 0; i < prefixChain.length; i++) {
    if (chain[i] !== prefixChain[i] && !sameElement(chain[i], prefixChain[i])) return false;
  }
  return true;
}

/**
 * @param {import('./css.js').ElementDesc} a
 * @param {import('./css.js').ElementDesc} b
 * @returns {boolean}
 */
function sameElement(a, b) {
  return a.tag === b.tag
    && a.id === b.id
    && a.childIndex === b.childIndex
    && a.classes.join(' ') === b.classes.join(' ')
    && (a.attrs[RENDITION_ATTR] || '') === (b.attrs[RENDITION_ATTR] || '');
}

export { requiresProvenanceLabel, hasPromotionRecord, promotionRecord } from './promotion.js';
