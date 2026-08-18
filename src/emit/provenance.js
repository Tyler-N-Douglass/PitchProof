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
import { parseStylesheet, computeCascade, backgroundColorOf } from './css.js';
import { parseColor, contrastRatio, compositeOver, toHex } from './color-value.js';
import { requiresProvenanceLabel, isUnearnedVerification, promotionRecord } from './promotion.js';

/** The class L8 puts on every provenance label (`PROVENANCE_LABEL_CLASS`). */
export const PROVENANCE_LABEL_CLASS = 'pp-provenance';

/** §18.1's size floor, in CSS px. */
export const MIN_LABEL_FONT_PX = 11;

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
    },
  };
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
  if (options.labelDisableRequested && reviewReachable && needingLabel.length > 0) {
    findings.push(provenanceFinding(
      `This build is reachable in Review mode (mode: "${mode}") and carries ${needingLabel.length} rendition(s) that are not client-supplied, `
      + 'so `labelIllustrativeContent` cannot be disabled (§9). The emit is refused rather than quietly overridden.',
      { check: 'label-option' },
    ));
  }

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

    for (const scope of scopes) {
      const inside = labels.filter((l) => chainStartsWith(l.chain.slice(prefix.length), scope.chain));
      scoped.set(scope.id, inside);
    }

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
      // No scoping attribute: the scene must at least carry one label per
      // rendition that needs one.
      if (labels.length < needed.length) {
        findings.push(provenanceFinding(
          `Scene ${scene.id} renders ${needed.length} rendition(s) needing a provenance label but contains ${labels.length} .${PROVENANCE_LABEL_CLASS} element(s). `
          + `Rendition "${rendition.label}" (${rendition.id}, provenance "${rendition.provenance}") is unlabelled.`,
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
