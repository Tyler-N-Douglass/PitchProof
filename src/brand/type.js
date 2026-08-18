/**
 * Type detection and metric-compatible fallback selection (§7).
 *
 * Three things this module refuses to do, each of them deliberate:
 *
 *  1. **It never loads a font.** Google Fonts links are *detected* — their
 *     families and weight axes are read straight out of the href — and then left
 *     alone. §7 and §18 are explicit: a foundry's webfont does not get fetched
 *     and embedded into an artifact handed to a client.
 *  2. **`embeddable` is false for every detected family.** The only route to
 *     `true` is `attachUserFont`, which requires the user to supply the file and
 *     to assert, in words that are recorded, that they hold the rights.
 *  3. **It never measures with a canvas.** `metricDelta` comes from
 *     `core/text-metrics.js` (DECISIONS D7), so a face's numbers are the same in
 *     Node, in the studio and in CI.
 *
 * Detection reads four independent sources — `@font-face` rules, stylesheet
 * `font-family`/`font` declarations, inline `style` attributes, and Google Fonts
 * `<link>` hrefs — and the number of them that agree is one of the three inputs
 * to a face's confidence.
 *
 * @module brand/type
 */

import {
  parseFamilyList, normalizeFamily, lookupFamily, guessCategory,
  resolveFace, metricDelta, metricsFor, FALLBACK_CANDIDATES,
} from '../core/text-metrics.js';
import {
  parseCssRules, parseDeclarations, splitComponents, splitTopLevel,
  parseLength, percentageOf, rootFontSize, DEFAULT_ROOT_FONT_SIZE_PX,
} from './shape.js';

// ---------------------------------------------------------------- constants

/**
 * Hosts that serve webfonts. A family named only by one of these is *known
 * about*, never fetched. The list exists so the studio can tell a user "this
 * face comes from Google Fonts and will not be embedded" rather than silently
 * substituting.
 */
export const WEBFONT_HOSTS = [
  'fonts.googleapis.com', 'fonts.gstatic.com',
  'use.typekit.net', 'p.typekit.net', 'use.fontawesome.com',
  'fast.fonts.net', 'fonts.net', 'cloud.typography.com', 'use.typography.com',
  'fonts.cdnfonts.com', 'fonts.bunny.net', 'rsms.me',
];

/** CSS generic families, which are never a brand's face. */
export const GENERIC_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji', 'fangsong',
  'inherit', 'initial', 'unset', 'revert', 'revert-layer',
]);

/**
 * Font size at or above which a declaration is display type rather than body
 * type. 24px is the smallest size at which WCAG 2.1 SC 1.4.3 treats text as
 * "large scale" (18.66px bold / 24px regular), which is the only published line
 * anywhere between body copy and headline sizes.
 */
export const DISPLAY_SIZE_PX = 24;

/** A second, stronger display threshold: nothing sets body copy at 32px. */
export const STRONG_DISPLAY_SIZE_PX = 32;

/** The size band body copy lives in, from the same WCAG boundary downward. */
export const BODY_SIZE_RANGE_PX = { min: 12, max: 20 };

/** Selectors that mean "heading" in essentially every stylesheet. */
export const DISPLAY_SELECTOR_RE =
  /(^|[\s>+~,([])h[1-3]\b|\b(display|headline|heading|hero|title|masthead|jumbotron|banner-title|lede|eyebrow|kicker)\b/i;

/** Selectors that mean "body copy". */
export const BODY_SELECTOR_RE =
  /(^|[\s>+~,([])(body|p|li|dd|dt|td|blockquote|article|main|section)\b|\b(body-?copy|prose|rich-?text|paragraph|content|text)\b/i;

/** Selectors that mean "code". */
export const MONO_SELECTOR_RE =
  /(^|[\s>+~,([])(pre|code|kbd|samp|tt|var)\b|\b(mono|monospace|code|hljs|prism|highlight|terminal|console|snippet|numeral|tabular)\b/i;

/**
 * Evidence weight beyond which a face is as certain as it is going to get. Six
 * declarations is the point at which a family is part of the design rather than
 * a one-off; below that the studio should still be asking.
 */
export const FACE_SAMPLE_SATURATION = 6;

/** Two independent sources naming the same family is agreement. */
export const FACE_SOURCE_SATURATION = 2;

/**
 * How a face's confidence is composed. The three terms are exactly the three
 * §7 names: sample size, agreement across sources, and how much the fallback
 * substitution moves the metrics (which is what `resolveFace().confidence`
 * measures). Weights sum to 1.
 */
export const FACE_CONFIDENCE_WEIGHTS = { sample: 0.4, agreement: 0.25, substitution: 0.35 };

// ------------------------------------------------------------- doc utilities

/**
 * Walk an L3 `DocNode` tree. Kept local rather than imported so this lane has no
 * build-order dependency on L3; the node shape is the one declared in `API.md`.
 * @param {any} node
 * @param {(node: any, ancestors: any[]) => void} visit
 * @param {any[]} [ancestors]
 */
export function walkDoc(node, visit, ancestors = []) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const n of node) walkDoc(n, visit, ancestors); return; }
  visit(node, ancestors);
  const kids = node.children;
  if (!kids || !kids.length) return;
  const next = ancestors.concat([node]);
  for (const child of kids) walkDoc(child, visit, next);
}

/**
 * Concatenated text of a node's subtree.
 * @param {any} node
 * @returns {string}
 */
export function docText(node) {
  let out = '';
  walkDoc(node, (n) => { if (n.type === 'text' && typeof n.text === 'string') out += n.text; });
  return out;
}

/**
 * A stable, human-readable selector for an element carrying an inline style, so
 * inline evidence can be scored by the same selector heuristics as stylesheet
 * evidence.
 * @param {any} node
 * @returns {string}
 */
export function inlineSelector(node) {
  const tag = String(node.tag || 'div').toLowerCase();
  const attrs = node.attrs || {};
  const cls = String(attrs.class || '').trim().split(/\s+/).filter(Boolean).slice(0, 3).map((c) => `.${c}`).join('');
  const id = attrs.id ? `#${attrs.id}` : '';
  return `${tag}${id}${cls}`;
}

// ----------------------------------------------------------- value utilities

/**
 * Numeric weights for the CSS `font-weight` keywords. `bolder`/`lighter` are
 * relative to an inherited value this module does not have, so they resolve to
 * the values they take against the initial `normal`, per CSS Fonts 4 §2.2.1.
 */
const WEIGHT_KEYWORDS = { normal: 400, bold: 700, bolder: 700, lighter: 100 };

/**
 * Parse a `font-weight` declaration into every weight it names. A variable-font
 * range (`font-weight: 100 900`) names both ends.
 * @param {string} value
 * @returns {number[]}
 */
export function parseFontWeight(value) {
  /** @type {number[]} */
  const out = [];
  for (const token of splitComponents(String(value || '').toLowerCase())) {
    if (token in WEIGHT_KEYWORDS) { out.push(WEIGHT_KEYWORDS[token]); continue; }
    const n = Number(token);
    if (Number.isFinite(n) && n >= 1 && n <= 1000) out.push(Math.round(n));
  }
  return out;
}

/**
 * Parse the `font` shorthand. Returns null for the system-font keywords, which
 * name a UA font rather than a family.
 * @param {string} value
 * @param {{rootFontSizePx?: number}} [ctx]
 * @returns {{weights: number[], sizePx: number|null, families: string[]}|null}
 */
export function parseFontShorthand(value, ctx = {}) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^(caption|icon|menu|message-box|small-caption|status-bar|inherit|initial|unset|revert)$/i.test(raw)) return null;

  const components = splitComponents(raw);
  /** @type {number[]} */
  const weights = [];
  let sizePx = null;
  let sizeIndex = -1;

  for (let i = 0; i < components.length; i++) {
    const token = components[i];
    const [sizeToken] = token.split('/');
    const pct = percentageOf(sizeToken);
    const len = pct !== null
      ? (pct / 100) * (ctx.rootFontSizePx ?? DEFAULT_ROOT_FONT_SIZE_PX)
      : parseLength(sizeToken, { rootFontSizePx: ctx.rootFontSizePx, fontSizePx: ctx.rootFontSizePx });
    if (len !== null && len > 0 && /[a-z%]/i.test(sizeToken)) { sizePx = len; sizeIndex = i; break; }
    if (/^(xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large)$/i.test(sizeToken)) {
      sizePx = ABSOLUTE_SIZE_PX[sizeToken.toLowerCase()];
      sizeIndex = i;
      break;
    }
    weights.push(...parseFontWeight(token));
  }
  if (sizeIndex < 0) return null;

  // Everything after the size (and its optional /line-height) is the family list.
  const tail = components.slice(sizeIndex + 1).join(' ');
  const families = parseFamilyList(tail);
  if (families.length === 0) return null;
  return { weights, sizePx, families };
}

/**
 * The absolute font-size keywords, at the CSS Fonts 4 §3.5 scaling factors
 * against a 16px medium.
 */
const ABSOLUTE_SIZE_PX = {
  'xx-small': 9, 'x-small': 10, small: 13, medium: 16,
  large: 18, 'x-large': 24, 'xx-large': 32, 'xxx-large': 48,
};

/**
 * Resolve a `font-size` declaration to pixels.
 * @param {string} value
 * @param {{rootFontSizePx?: number}} [ctx]
 * @returns {number|null}
 */
export function parseFontSize(value, ctx = {}) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (raw in ABSOLUTE_SIZE_PX) return ABSOLUTE_SIZE_PX[raw];
  const root = ctx.rootFontSizePx ?? DEFAULT_ROOT_FONT_SIZE_PX;
  const pct = percentageOf(raw);
  if (pct !== null) return (pct / 100) * root;
  return parseLength(raw, { rootFontSizePx: root, fontSizePx: root });
}

/**
 * The families in a `font-family` list that are real families, in order, with a
 * flag saying whether the list ended in a monospace generic — which is how a
 * stylesheet says "this is code" even when the family name gives no hint.
 * @param {string} value
 * @returns {{families: string[], generics: string[], monoGeneric: boolean}}
 */
export function parseFamilyDeclaration(value) {
  /** @type {string[]} */
  const families = [];
  /** @type {string[]} */
  const generics = [];
  for (const entry of parseFamilyList(value)) {
    const key = normalizeFamily(entry);
    if (!key) continue;
    if (key.startsWith('var(')) continue;
    if (GENERIC_FAMILIES.has(key)) { generics.push(key); continue; }
    families.push(entry.replace(/^\s*["']|["']\s*$/g, '').trim());
  }
  return { families, generics, monoGeneric: generics.includes('monospace') || generics.includes('ui-monospace') };
}

/**
 * Read the families and weight axes out of a Google Fonts (or compatible) href.
 * Both API versions are handled: v1 `?family=Open+Sans:400,700|Lora` and v2
 * `?family=Inter:wght@400;700&family=Lora:ital,wght@0,400;1,700`.
 *
 * The href is parsed. It is never requested.
 *
 * @param {string} href
 * @returns {{family: string, weights: number[]}[]}
 */
export function parseGoogleFontsHref(href) {
  const raw = String(href || '');
  const q = raw.indexOf('?');
  if (q < 0) return [];
  /** @type {{family: string, weights: number[]}[]} */
  const out = [];
  for (const param of raw.slice(q + 1).split('&')) {
    const eq = param.indexOf('=');
    if (eq < 0) continue;
    if (param.slice(0, eq).toLowerCase() !== 'family') continue;
    const value = decodeURIComponent(param.slice(eq + 1).replace(/\+/g, ' '));
    for (const spec of value.split('|')) {
      const parsed = parseGoogleFamilySpec(spec);
      if (parsed) out.push(parsed);
    }
  }
  return out;
}

/**
 * @param {string} spec
 * @returns {{family: string, weights: number[]}|null}
 */
function parseGoogleFamilySpec(spec) {
  const text = String(spec || '').trim();
  if (!text) return null;
  const colon = text.indexOf(':');
  const family = (colon < 0 ? text : text.slice(0, colon)).trim();
  if (!family) return null;
  /** @type {number[]} */
  const weights = [];
  if (colon >= 0) {
    const axes = text.slice(colon + 1);
    const at = axes.indexOf('@');
    if (at >= 0) {
      // v2: `wght@400;700` or `ital,wght@0,400;1,700`
      const names = axes.slice(0, at).split(',').map((s) => s.trim().toLowerCase());
      const wIndex = names.indexOf('wght');
      for (const tuple of axes.slice(at + 1).split(';')) {
        const parts = tuple.split(',');
        const value = wIndex >= 0 ? parts[wIndex] : parts[parts.length - 1];
        for (const n of expandWeightToken(value)) weights.push(n);
      }
    } else {
      // v1: `400,700italic` or `bold`
      for (const token of axes.split(',')) {
        const clean = token.replace(/italic|i$/gi, '').trim();
        for (const n of expandWeightToken(clean)) weights.push(n);
      }
    }
  }
  return { family, weights: dedupeSorted(weights) };
}

/**
 * A weight token from a font URL, which may be a number, a keyword, or a
 * variable-font range written `400..700`.
 * @param {string} token
 * @returns {number[]}
 */
function expandWeightToken(token) {
  const t = String(token || '').trim().toLowerCase();
  if (!t) return [];
  const range = /^(\d{2,4})\.\.(\d{2,4})$/.exec(t);
  if (range) return [Number(range[1]), Number(range[2])];
  if (t in WEIGHT_KEYWORDS) return [WEIGHT_KEYWORDS[t]];
  const n = Number(t);
  return Number.isFinite(n) && n >= 1 && n <= 1000 ? [Math.round(n)] : [];
}

/** @param {number[]} xs @returns {number[]} */
function dedupeSorted(xs) {
  return [...new Set(xs.filter((n) => Number.isFinite(n)))].sort((a, b) => a - b);
}

/** @param {string} url @returns {string|null} */
export function hostOf(url) {
  const m = /^(?:[a-z][a-z0-9+.-]*:)?\/\/([^/?#]+)/i.exec(String(url || ''));
  return m ? m[1].toLowerCase().replace(/^.*@/, '').replace(/:\d+$/, '') : null;
}

/** @param {string} url @returns {boolean} */
export function isWebfontHost(url) {
  const host = hostOf(url);
  return host !== null && WEBFONT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/** Extract the urls out of a `src:` descriptor. */
export function srcUrls(value) {
  /** @type {string[]} */
  const out = [];
  const re = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi;
  let m;
  while ((m = re.exec(String(value || '')))) {
    const url = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (url) out.push(url);
  }
  return out;
}

// ------------------------------------------------------------------ evidence

/**
 * @typedef {object} FaceEvidence
 * @property {string} family            canonical spelling
 * @property {string} key               normalized lookup key
 * @property {Set<number>} weights
 * @property {Set<string>} sources      'font-face' | 'stylesheet' | 'inline' | 'link' | 'preload'
 * @property {string[]} selectors
 * @property {number[]} sizesPx
 * @property {number} occurrences       declarations naming this family
 * @property {number} stackPosition     lowest index the family took in a stack
 * @property {boolean} monoGeneric      appeared in a stack ending in a monospace generic
 * @property {boolean} webfontLinked    named by a webfont host
 * @property {string[]} hosts
 * @property {Record<string, number>} spellings
 */

/**
 * @param {Map<string, FaceEvidence>} index
 * @param {string} family
 * @returns {FaceEvidence}
 */
function evidenceFor(index, family) {
  const key = normalizeFamily(family);
  let ev = index.get(key);
  if (!ev) {
    ev = {
      family, key, weights: new Set(), sources: new Set(), selectors: [], sizesPx: [],
      occurrences: 0, stackPosition: 99, monoGeneric: false, webfontLinked: false,
      hosts: [], spellings: {},
    };
    index.set(key, ev);
  }
  const clean = String(family || '').trim();
  if (clean) ev.spellings[clean] = (ev.spellings[clean] || 0) + 1;
  return ev;
}

/**
 * Normalize the `css` argument: a string, a list of strings, or a list of
 * `{text, href}` records from `<link rel=stylesheet>` fetches.
 * @param {string|string[]|{text?: string, css?: string, href?: string}[]} css
 * @returns {{text: string, href: string|null}[]}
 */
export function normalizeStylesheets(css) {
  if (!css) return [];
  if (typeof css === 'string') return [{ text: css, href: null }];
  if (!Array.isArray(css)) return [];
  /** @type {{text: string, href: string|null}[]} */
  const out = [];
  for (const entry of css) {
    if (typeof entry === 'string') { out.push({ text: entry, href: null }); continue; }
    if (entry && typeof entry === 'object') {
      const text = typeof entry.text === 'string' ? entry.text : (typeof entry.css === 'string' ? entry.css : '');
      out.push({ text, href: typeof entry.href === 'string' ? entry.href : null });
    }
  }
  return out;
}

/**
 * Collect every piece of type evidence in a document and its stylesheets.
 * @param {any} doc     an L3 DocNode tree, or null
 * @param {string|string[]|object[]} css
 * @returns {{index: Map<string, FaceEvidence>, rootFontSizePx: number, googleLinks: string[], declarations: number}}
 */
export function collectTypeEvidence(doc, css) {
  const sheets = normalizeStylesheets(css);
  /** @type {Map<string, FaceEvidence>} */
  const index = new Map();
  /** @type {string[]} */
  const googleLinks = [];
  let declarations = 0;

  // `<style>` blocks are stylesheets too, and inline `style` attributes are
  // declarations without a selector.
  /** @type {{node: any, selector: string}[]} */
  const inlineStyles = [];
  if (doc) {
    walkDoc(doc, (node) => {
      if (node.type !== 'element') return;
      const tag = String(node.tag || '').toLowerCase();
      const attrs = node.attrs || {};
      if (tag === 'style') { sheets.push({ text: docText(node), href: null }); return; }
      if (tag === 'link') {
        const href = String(attrs.href || '');
        const rel = String(attrs.rel || '').toLowerCase();
        if (!href) return;
        if (isWebfontHost(href) || /fonts\.(googleapis|bunny)\.[a-z]+/i.test(href)) {
          if (rel.includes('stylesheet') || rel.includes('preload') || rel === '') googleLinks.push(href);
          for (const g of parseGoogleFontsHref(href)) {
            const ev = evidenceFor(index, g.family);
            ev.sources.add(rel.includes('preload') ? 'preload' : 'link');
            ev.occurrences += 1;
            ev.webfontLinked = true;
            const host = hostOf(href);
            if (host && !ev.hosts.includes(host)) ev.hosts.push(host);
            for (const w of g.weights) ev.weights.add(w);
            ev.stackPosition = Math.min(ev.stackPosition, 0);
          }
        }
        return;
      }
      if (typeof attrs.style === 'string' && attrs.style.trim()) {
        inlineStyles.push({ node, selector: inlineSelector(node) });
      }
    });
  }

  const allRules = sheets.map((s) => ({ href: s.href, rules: parseCssRules(s.text) }));
  const rootFontSizePx = allRules.reduce((acc, s) => rootFontSize(s.rules, { rootFontSizePx: acc }), DEFAULT_ROOT_FONT_SIZE_PX);

  for (const sheet of allRules) {
    for (const rule of sheet.rules) {
      if (rule.at === 'font-face') {
        const decl = rule.declarations;
        const parsed = parseFamilyDeclaration(decl['font-family'] || '');
        const urls = srcUrls(decl.src || '');
        for (const family of parsed.families) {
          const ev = evidenceFor(index, family);
          ev.sources.add('font-face');
          ev.occurrences += 1;
          ev.stackPosition = 0;
          for (const w of parseFontWeight(decl['font-weight'] || '')) ev.weights.add(w);
          for (const url of urls) {
            const host = hostOf(url);
            if (host && !ev.hosts.includes(host)) ev.hosts.push(host);
            if (isWebfontHost(url)) ev.webfontLinked = true;
          }
          declarations += 1;
        }
        continue;
      }
      if (rule.at) continue;
      const selector = rule.selectors.join(', ');
      recordDeclarations(index, rule.declarations, selector, rootFontSizePx, 'stylesheet', () => { declarations += 1; });
    }
  }

  for (const inline of inlineStyles) {
    recordDeclarations(index, parseDeclarations(String(inline.node.attrs.style)), inline.selector, rootFontSizePx, 'inline', () => { declarations += 1; });
  }

  return { index, rootFontSizePx, googleLinks, declarations };
}

/**
 * Record one declaration block's type evidence.
 * @param {Map<string, FaceEvidence>} index
 * @param {Record<string, string>} decl
 * @param {string} selector
 * @param {number} rootFontSizePx
 * @param {'stylesheet'|'inline'} source
 * @param {() => void} onDeclaration
 */
function recordDeclarations(index, decl, selector, rootFontSizePx, source, onDeclaration) {
  const shorthand = decl.font ? parseFontShorthand(decl.font, { rootFontSizePx }) : null;
  const familyValue = decl['font-family'];
  const weights = parseFontWeight(decl['font-weight'] || '');
  const sizePx = decl['font-size'] !== undefined ? parseFontSize(decl['font-size'], { rootFontSizePx }) : null;

  /** @param {{families: string[], monoGeneric: boolean}} parsed @param {number[]} w @param {number|null} size */
  const apply = (parsed, w, size) => {
    parsed.families.forEach((family, i) => {
      const ev = evidenceFor(index, family);
      ev.sources.add(source);
      ev.occurrences += 1;
      ev.selectors.push(selector);
      ev.stackPosition = Math.min(ev.stackPosition, i);
      if (parsed.monoGeneric) ev.monoGeneric = true;
      for (const weight of w) ev.weights.add(weight);
      if (size !== null && size > 0) ev.sizesPx.push(size);
      onDeclaration();
    });
  };

  if (familyValue !== undefined) apply(parseFamilyDeclaration(familyValue), weights, sizePx);
  if (shorthand) {
    apply(
      parseFamilyDeclaration(shorthand.families.join(', ')),
      weights.concat(shorthand.weights),
      shorthand.sizePx,
    );
  }
  // A `font-weight` or `font-size` on a rule that does not name a family still
  // belongs to whatever family the selector inherits, which this module cannot
  // resolve — so it is deliberately not attributed to anyone.
}

// ---------------------------------------------------------------- role solve

/**
 * @typedef {object} RoleScores
 * @property {number} display
 * @property {number} body
 * @property {number} mono
 */

/**
 * Score a family's evidence for each of the three §4 roles. Every term is named
 * and additive, so a studio inspector can show a user *why* a face was called a
 * display face.
 * @param {FaceEvidence} ev
 * @returns {{role: 'display'|'body'|'mono', scores: RoleScores, margin: number}}
 */
export function scoreRole(ev) {
  const model = lookupFamily(ev.family);
  const category = model ? model.category : guessCategory(ev.family);
  /** @type {RoleScores} */
  const scores = { display: 0, body: 0, mono: 0 };

  // 1. What the family itself is.
  if (category === 'mono') scores.mono += 3;
  if (category === 'display') scores.display += 2;
  if (category === 'serif' || category === 'sans') scores.body += 0.5;

  // 2. What it sits next to in a stack.
  if (ev.monoGeneric) scores.mono += 3;

  // 3. What selectors use it.
  for (const selector of ev.selectors) {
    if (MONO_SELECTOR_RE.test(selector)) scores.mono += 2;
    if (DISPLAY_SELECTOR_RE.test(selector)) scores.display += 2;
    if (BODY_SELECTOR_RE.test(selector)) scores.body += 2;
  }

  // 4. What sizes it is set at.
  const sizes = ev.sizesPx.slice().sort((a, b) => a - b);
  if (sizes.length) {
    const max = sizes[sizes.length - 1];
    const median = sizes[Math.floor((sizes.length - 1) / 2)];
    if (max >= STRONG_DISPLAY_SIZE_PX) scores.display += 3;
    else if (max >= DISPLAY_SIZE_PX) scores.display += 2;
    if (median >= BODY_SIZE_RANGE_PX.min && median <= BODY_SIZE_RANGE_PX.max) scores.body += 2;
  }

  // 5. What weights it is set at. A family only ever seen at 600+ is a display
  //    cut; a family seen at 400 is carrying copy.
  const weights = [...ev.weights];
  if (weights.length) {
    if (weights.every((w) => w >= 600)) scores.display += 1;
    if (weights.some((w) => w <= 400)) scores.body += 1;
  }

  const entries = /** @type {['display'|'body'|'mono', number][]} */ (Object.entries(scores));
  // Ranking order breaks ties: a mono signal is the most specific claim, a
  // display signal the next, and body is the residual role.
  const order = { mono: 0, display: 1, body: 2 };
  entries.sort((a, b) => (b[1] - a[1]) || (order[a[0]] - order[b[0]]));
  const margin = entries[0][1] - entries[1][1];
  return { role: entries[0][0], scores, margin };
}

// ------------------------------------------------------------------- surface

/**
 * @typedef {object} DetectFacesOptions
 * @property {string[]} [available]     families guaranteed to render in the artifact
 * @property {number} [maxFaces]        cap on returned faces, default 12
 * @property {number} [minOccurrences]  drop families seen fewer times, default 1
 * @property {boolean} [includeFallbackFamilies]  keep families only ever named
 *   as a fallback inside someone else's stack, default false
 */

/**
 * Detect the type faces a page uses (§7).
 *
 * A family that only ever appears *behind* another family in a `font-family`
 * stack is a fallback, not a face the brand chose, and is dropped unless
 * `includeFallbackFamilies` is set. Without that rule every extraction reports
 * Arial and Georgia as brand faces, which is how a "brand system" becomes
 * noise.
 *
 * @param {any} doc          an L3 DocNode tree, or null
 * @param {string|string[]|object[]} css
 * @param {DetectFacesOptions} [options]
 * @returns {object[]}   §4 TypeFace records, with optional lane extensions
 */
export function detectFaces(doc, css, options = {}) {
  const { index } = collectTypeEvidence(doc, css);
  const available = options.available || FALLBACK_CANDIDATES;
  const maxFaces = options.maxFaces ?? 12;
  const minOccurrences = options.minOccurrences ?? 1;
  const includeFallbacks = options.includeFallbackFamilies === true;

  /** @type {any[]} */
  const faces = [];
  for (const ev of index.values()) {
    if (ev.occurrences < minOccurrences) continue;
    if (!includeFallbacks && isFallbackOnly(ev)) continue;
    faces.push(faceFromEvidence(ev, available));
  }

  // Deterministic order: role rank, then weight of evidence, then family name.
  const roleRank = { display: 0, body: 1, mono: 2 };
  faces.sort((a, b) =>
    (roleRank[a.role] - roleRank[b.role])
    || (b.evidence.occurrences - a.evidence.occurrences)
    || a.family.localeCompare(b.family));
  return faces.slice(0, maxFaces);
}

/**
 * True when every declaration that named this family put it behind another
 * family — the definition of a fallback. A family named by an `@font-face`
 * rule or a webfont link was chosen by the design regardless of where it sits
 * in any one stack.
 * @param {FaceEvidence} ev
 * @returns {boolean}
 */
export function isFallbackOnly(ev) {
  if (ev.sources.has('font-face') || ev.sources.has('link') || ev.sources.has('preload')) return false;
  if (ev.sources.has('user-file')) return false;
  return ev.stackPosition > 0;
}

/**
 * Turn one family's evidence into a §4 `TypeFace`.
 * @param {FaceEvidence} ev
 * @param {string[]} available
 * @returns {any}
 */
export function faceFromEvidence(ev, available) {
  // The canonical spelling is the one the page used most; ties go to the
  // lexicographically smallest so the answer never depends on iteration order.
  const family = Object.entries(ev.spellings)
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))[0]?.[0] || ev.family;

  const weightsSeen = [...ev.weights].sort((a, b) => a - b);
  const primaryWeight = representativeWeight(weightsSeen);
  const resolution = resolveFace(family, { available, weight: primaryWeight });
  const { role, scores, margin } = scoreRole({ ...ev, family });
  const metrics = metricsFor(family, primaryWeight);

  return {
    family,
    fallbackStack: resolution.stack,
    weightsSeen: weightsSeen.length ? weightsSeen : [400],
    role,
    metricDelta: metricDelta(family, resolution.resolved, primaryWeight),
    // §7/§18: detection never makes a face embeddable. Only `attachUserFont`
    // does, and only against a recorded rights assertion.
    embeddable: false,
    // --- optional lane extensions (§4 permits added optional fields) --------
    resolved: resolution.resolved,
    available: resolution.available,
    known: resolution.known,
    category: metrics.category,
    primaryWeight,
    confidence: faceConfidence(ev, resolution),
    roleScores: scores,
    roleMargin: margin,
    webfontLinked: ev.webfontLinked,
    webfontHosts: ev.hosts.slice().sort(),
    evidence: {
      occurrences: ev.occurrences,
      sources: [...ev.sources].sort(),
      selectors: ev.selectors.slice(0, 8),
      sizesPx: ev.sizesPx.slice().sort((a, b) => a - b),
    },
  };
}

/**
 * The weight a face's metrics are reported at. 400 when the page uses it,
 * because that is the weight body copy renders at and the weight a reader
 * measures a substitution against; otherwise the weight closest to 400, ties
 * going to the lighter cut.
 * @param {number[]} weights
 * @returns {number}
 */
export function representativeWeight(weights) {
  if (!weights || weights.length === 0) return 400;
  if (weights.includes(400)) return 400;
  return weights.slice().sort((a, b) => (Math.abs(a - 400) - Math.abs(b - 400)) || (a - b))[0];
}

/**
 * Confidence in one detected face (§7: sample size, agreement across sources,
 * and how far the fallback substitution moves the metrics — never hardcoded).
 * @param {FaceEvidence} ev
 * @param {{confidence: number}} resolution
 * @returns {number}
 */
export function faceConfidence(ev, resolution) {
  const sample = Math.min(1, ev.occurrences / FACE_SAMPLE_SATURATION);
  const agreement = Math.min(1, ev.sources.size / FACE_SOURCE_SATURATION);
  const substitution = Math.max(0, Math.min(1, resolution.confidence));
  const w = FACE_CONFIDENCE_WEIGHTS;
  return round6(Math.max(0, Math.min(1, w.sample * sample + w.agreement * agreement + w.substitution * substitution)));
}

/**
 * Confidence in the face group as a whole: the evidence-weighted mean of the
 * per-face confidences, discounted when no face is carrying body copy — a brand
 * whose body face was not found is a brand whose type was not really extracted.
 * @param {any[]} faces
 * @returns {number}
 */
export function facesConfidence(faces) {
  if (!faces || faces.length === 0) return 0;
  let num = 0;
  let den = 0;
  for (const f of faces) {
    const weight = Math.max(1, f.evidence?.occurrences ?? 1);
    num += (typeof f.confidence === 'number' ? f.confidence : 0) * weight;
    den += weight;
  }
  const mean = den > 0 ? num / den : 0;
  const hasBody = faces.some((f) => f.role === 'body');
  return round6(Math.max(0, Math.min(1, mean * (hasBody ? 1 : 0.6))));
}

// ------------------------------------------------------- user-supplied fonts

/**
 * @typedef {object} FontSupply
 * @property {string} family                 the family the file provides
 * @property {string} fileName
 * @property {Uint8Array} [bytes]
 * @property {string} [dataUri]              an already-encoded `data:` URI
 * @property {string} [mime]
 * @property {number[]} [weights]
 * @property {'normal'|'italic'} [style]
 * @property {{assertedBy: string, statement: string}} rightsAssertion
 */

/** Font MIME types, by extension, for the `@font-face` src this produces. */
const FONT_MIME = {
  woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf',
  otf: 'font/otf', eot: 'application/vnd.ms-fontobject',
};

/**
 * Attach a user-supplied font file to a detected face and mark it embeddable.
 *
 * This is the **only** function in the product that can set
 * `TypeFace.embeddable` to true, and it refuses to do so without an explicit
 * rights assertion naming who made it — §7 ("never fetch and embed a foundry's
 * webfont into an artifact you're going to hand a client") and §18.2 read
 * together mean the artifact must be able to say where the licence came from.
 *
 * The assertion is recorded on the face, timestamped from the injected clock so
 * the record is deterministic under §5.
 *
 * @param {any[]} faces
 * @param {FontSupply} supply
 * @param {{clock: () => string, available?: string[]}} deps
 * @returns {{faces: any[], face: any, assertion: {family: string, fileName: string, assertedBy: string, statement: string, assertedAt: string, bytes: number}}}
 */
export function attachUserFont(faces, supply, deps) {
  if (!supply || !supply.family) throw new Error('attachUserFont: a family is required');
  const assertion = supply.rightsAssertion;
  if (!assertion || !assertion.assertedBy || !assertion.statement) {
    throw new Error('attachUserFont: a rights assertion naming who asserted it is required before a font may be embedded');
  }
  if (!deps || typeof deps.clock !== 'function') throw new Error('attachUserFont: an injected clock is required');
  if (!supply.bytes && !supply.dataUri) throw new Error('attachUserFont: a font file (bytes or dataUri) is required');

  const list = Array.isArray(faces) ? faces.slice() : [];
  const key = normalizeFamily(supply.family);
  const available = [...(deps.available || FALLBACK_CANDIDATES), supply.family];
  const ext = String(supply.fileName || '').toLowerCase().split('.').pop() || '';
  const mime = supply.mime || FONT_MIME[ext] || 'application/octet-stream';

  let index = list.findIndex((f) => normalizeFamily(f.family) === key);
  if (index < 0) {
    const ev = evidenceFor(new Map(), supply.family);
    ev.sources.add('user-file');
    ev.occurrences = 1;
    for (const w of supply.weights || []) ev.weights.add(w);
    list.push(faceFromEvidence(ev, available));
    index = list.length - 1;
  }

  const before = list[index];
  const weightsSeen = dedupeSorted([...(before.weightsSeen || []), ...(supply.weights || [])]);
  const primaryWeight = representativeWeight(weightsSeen);
  // The file is present, so the family is available and the substitution is the
  // identity — which is exactly what makes overflow measurement honest.
  const resolution = resolveFace(before.family, { available, weight: primaryWeight });

  const face = {
    ...before,
    fallbackStack: resolution.stack,
    weightsSeen: weightsSeen.length ? weightsSeen : [400],
    metricDelta: metricDelta(before.family, resolution.resolved, primaryWeight),
    embeddable: true,
    resolved: resolution.resolved,
    available: true,
    primaryWeight,
    confidence: 1,
    fontFile: {
      fileName: supply.fileName || `${before.family}.${ext || 'bin'}`,
      mime,
      style: supply.style || 'normal',
      bytes: supply.bytes ? supply.bytes.length : null,
      dataUri: supply.dataUri || null,
    },
    rightsAssertion: {
      assertedBy: assertion.assertedBy,
      statement: assertion.statement,
      assertedAt: deps.clock(),
    },
  };
  list[index] = face;

  return {
    faces: list,
    face,
    assertion: {
      family: face.family,
      fileName: face.fontFile.fileName,
      assertedBy: face.rightsAssertion.assertedBy,
      statement: face.rightsAssertion.statement,
      assertedAt: face.rightsAssertion.assertedAt,
      bytes: supply.bytes ? supply.bytes.length : 0,
    },
  };
}

/** @param {number} n @returns {number} */
function round6(n) { return Math.round(n * 1e6) / 1e6; }
