/**
 * Provenance enforcement, in the emit path (§9, §18.1, §22.6).
 *
 * §22.6 names this "the single reputational risk in this product": a proof that
 * implies generated sample content is the client's approved copy. §9 says
 * "enforce this in the emitter, not just in the UI", and §18.1 adds that the
 * label "cannot be styled to invisibility (contrast and size floors enforced at
 * emit)". Everything in this module exists to make those sentences into code
 * that refuses.
 *
 * Four things are checked, and each one is a distinct attack:
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
 *   4. **The stylesheet.** The label has to survive the *final* CSS — runtime,
 *      brand theme, and any user CSS — with a computed contrast of at least
 *      4.5:1 against its own background, a computed font size of at least 11px,
 *      and no rule anywhere that hides it: `display:none`, `visibility:hidden`,
 *      `opacity:0`, zero size, a clip, or a position off the screen.
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

/** The class L8 puts on every provenance label (`PROVENANCE_LABEL_CLASS`). */
export const PROVENANCE_LABEL_CLASS = 'pp-provenance';

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

/** Overflow values that cut the label off rather than letting it spill. */
const CLIPPING_OVERFLOW = new Set(['hidden', 'clip']);

/** Attribute a layout may use to scope a rendition's subtree. */
export const RENDITION_ATTR = 'data-pp-rendition';

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
 * @param {import('./css.js').ElementDesc} desc
 * @returns {boolean}
 */
const isLabel = (desc) => desc.classes.includes(PROVENANCE_LABEL_CLASS);

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
 * Judge one label against the final stylesheet.
 *
 * @param {import('./css.js').ElementDesc[]} chain  html → label
 * @param {import('./css.js').StyleRule[]} rules
 * @returns {{ok: boolean, reasons: string[], detail: Record<string, unknown>}}
 */
export function judgeLabelStyle(chain, rules) {
  const computed = computeCascade(chain, rules);
  const self = computed[computed.length - 1];
  /** @type {string[]} */
  const reasons = [];

  for (let i = 0; i < chain.length; i++) {
    const style = computed[i];
    const who = i === chain.length - 1 ? 'the label' : `an ancestor <${chain[i].tag}${chain[i].classes.length ? `.${chain[i].classes.join('.')}` : ''}>`;

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

    const filter = (style.props.filter || '').replace(/\s+/g, '').toLowerCase();
    const filterOpacity = /opacity\(([\d.]+)%?\)/.exec(filter);
    if (filterOpacity && parseFloat(filterOpacity[1]) === 0) reasons.push(`filter:opacity(0) on ${who}`);
  }

  if (self.effectiveOpacity === 0) reasons.push('opacity:0 — the label is styled to invisibility');

  const fontSizePx = self.fontSizePx;
  if (!(fontSizePx >= MIN_LABEL_FONT_PX)) {
    reasons.push(`font-size computes to ${round(fontSizePx)}px, below the ${MIN_LABEL_FONT_PX}px floor §18.1 enforces`);
  }

  // C9. The size floor, measured rather than spelled: room for the label's own
  // line of text, and tracking that leaves the characters apart.
  const room = judgeLabelRoom(chain, computed);
  reasons.push(...room.reasons);

  // The floor again, on the size the label is actually painted at. A chain that
  // scales the label to a fifth renders 12px type at 2.4px, and no list of
  // `transform` spellings would have caught `scale(0.2)` while catching
  // `scale(0)`.
  if (room.scale < 1) {
    const rendered = fontSizePx * room.scale;
    if (!(rendered >= MIN_LABEL_FONT_PX)) {
      reasons.push(`the label is scaled by ${round(room.scale)}, so ${round(fontSizePx)}px type renders at ${round(rendered)}px — below the ${MIN_LABEL_FONT_PX}px floor §18.1 enforces`);
    }
  }

  const background = resolveBackground(chain, computed);
  const foregroundRaw = parseColor(self.props.color || '') || { r: 0, g: 0, b: 0, a: 1 };
  const foreground = compositeOver({ ...foregroundRaw, a: foregroundRaw.a * self.effectiveOpacity }, background);
  const ratio = contrastRatio(foreground, background);
  if (!(ratio >= CONTRAST_AA_BODY)) {
    reasons.push(
      `computed contrast is ${ratio.toFixed(2)}:1 (${toHex(foreground)} on ${toHex(background)}), below the ${CONTRAST_AA_BODY}:1 floor §18.1 enforces`,
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
 * @param {import('./css.js').ElementDesc[]} chain     html → label
 * @param {import('./css.js').ComputedStyle[]} computed
 * @returns {{reasons: string[], lineBoxPx: number, boxHeightPx: number|null, boxWidthPx: number|null, clipped: boolean, trackingPx: number, scale: number}}
 */
export function judgeLabelRoom(chain, computed) {
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

  for (let i = 0; i < computed.length; i++) {
    const style = computed[i];
    const el = chain[i];
    const who = i === chain.length - 1 ? 'the label' : `an ancestor <${el.tag}${el.classes.length ? `.${el.classes.join('.')}` : ''}>`;

    // Clipping is judged **on the element that declares the small box**, never
    // across the chain. A one-pixel label inside a clipping stage still shows
    // its text: the text spills out of the label and the stage clips at the
    // stage's own edge, which is nowhere near it. It is the element that is
    // both too small and cutting its own content off that hides the label —
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
          + 'and that element clips what does not fit — a box too short to hold one line of the label is the label styled to invisibility (§18.1)',
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
          + `(${LABEL_MIN_WIDTH_EM}em of ${round(fontSizePx)}px type), and that element clips what does not fit — there is not room to read it (§18.1)`,
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

    scale *= scaleFactorOf(style);
  }

  return { reasons, lineBoxPx, boxHeightPx, boxWidthPx, clipped, trackingPx, scale };
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
 * Enforce the provenance law over a whole proof.
 *
 * @param {import('../core/contracts.d.ts').Proof} proof
 * @param {string} html      the emitted document (used to confirm the labels
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

  if (needingLabel.length === 0) return findings;

  // 3 and 4. Markup and stylesheet, scene by scene.
  const prefix = documentChainPrefix();
  let labelsSeenAnywhere = 0;

  for (const { scene, branchId } of allScenesOf(proof)) {
    const needed = (scene.renditionIds || [])
      .map((id) => renditionById.get(id))
      .filter((r) => r && requiresProvenanceLabel(r));
    if (needed.length === 0) continue;

    if (!renderScene) {
      findings.push(provenanceFinding(
        `Scene ${scene.id} renders ${needed.length} rendition(s) that must carry a provenance label, but the emitter was given no way to render the scene, `
        + 'so the label could not be verified. The emit is refused rather than assumed correct.',
        { sceneId: scene.id, branchId: branchId || undefined, check: 'render' },
      ));
      continue;
    }

    const tree = renderScene(scene);
    /** @type {{node: any, chain: import('./css.js').ElementDesc[]}[]} */
    const labels = [];
    /** @type {Map<string, {node: any, chain: import('./css.js').ElementDesc[]}[]>} */
    const scoped = new Map();
    /** @type {{id: string, chain: import('./css.js').ElementDesc[]}[]} */
    const scopes = [];

    walkWithChain(tree, (node, chain) => {
      const desc = chain[chain.length - 1];
      const renditionId = desc.attrs[RENDITION_ATTR];
      if (renditionId) scopes.push({ id: renditionId, chain });
      if (isLabel(desc)) labels.push({ node, chain: prefix.concat(chain) });
    });

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

    for (const label of labels) {
      const text = nodeText(label.node).replace(/\s+/g, ' ').trim();
      if (!text) {
        findings.push(provenanceFinding(
          `A .${PROVENANCE_LABEL_CLASS} element in scene ${scene.id} renders no text. A label that says nothing labels nothing (§18.1).`,
          { sceneId: scene.id, branchId: branchId || undefined, check: 'label-text' },
        ));
      }
      const verdict = judgeLabelStyle(label.chain, rules);
      if (!verdict.ok) {
        findings.push(provenanceFinding(
          `The provenance label in scene ${scene.id} does not survive the emitted stylesheet: ${verdict.reasons.join('; ')}. `
          + '§18.1 makes the label non-removable, and that includes styling it away.',
          {
            sceneId: scene.id, branchId: branchId || undefined, check: 'label-style',
            ...verdict.detail,
          },
        ));
      }
    }
  }

  // 5. The label has to be in the file, not just in the tree we rendered.
  if (labelsSeenAnywhere > 0 && typeof html === 'string' && html.length > 0) {
    const firstScene = (proof.spine || [])[0];
    const firstNeeds = firstScene
      ? (firstScene.renditionIds || []).map((id) => renditionById.get(id)).filter((r) => r && requiresProvenanceLabel(r)).length
      : 0;
    if (firstNeeds > 0 && !new RegExp(`class="[^"]*\\b${PROVENANCE_LABEL_CLASS}\\b`).test(html)) {
      findings.push(provenanceFinding(
        `The opening scene renders ${firstNeeds} rendition(s) needing a provenance label, but no .${PROVENANCE_LABEL_CLASS} element reached the emitted document. `
        + 'The first thing the client sees would be unlabelled illustrative content.',
        { sceneId: firstScene.id, check: 'label-serialized' },
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
