/**
 * A dependency-free HTML tokenizer and tree builder (D8).
 *
 * Why this exists: §22.3 names chrome stripping on real sites as a top-three
 * risk, and §17.5 requires a block-level F1 measured against hand-labelled
 * fixtures. That measurement has to run under `node --test`, where there is no
 * `DOMParser`. One parser also means the studio and the test suite can never
 * disagree about what a page contains.
 *
 * What it handles, because real enterprise HTML contains all of it:
 *   - void elements and raw-text elements (`script` holding `</div>`);
 *   - optional end tags — `<p>`, `<li>`, `<td>`, `<tr>`, `<option>`, `<dt>`;
 *   - attributes quoted, single-quoted, unquoted and valueless, including
 *     values that contain `>` or a comment-looking run;
 *   - comments, bogus comments, processing instructions, doctypes, CDATA;
 *   - character references (see `entities.js`);
 *   - foreign content: `svg`/`math` subtrees keep their camelCase tag and
 *     attribute names and honour self-closing syntax, because L5 reads inline
 *     SVG logos straight out of this tree;
 *   - stray end tags, unterminated tags at EOF, `<div <span>` and friends.
 *
 * The output is the `DocNode` shape declared in `API.md`. It is a light tree,
 * not a DOM: no live collections, no namespaces object, no CSSOM. `parent` is
 * a real back-reference, so anything that serialises a node must break the
 * cycle itself (`plainTree` does).
 *
 * @module ingest/html-parse
 */

import { decodeEntities } from './entities.js';

/**
 * @typedef {object} DocNode
 * @property {'element'|'text'|'comment'} type
 * @property {string} [tag]
 * @property {Record<string,string>} [attrs]
 * @property {DocNode[]} [children]
 * @property {string} [text]
 * @property {DocNode} [parent]
 * @property {string} [doctype]   only on the `#document` root
 */

/** Elements that never have children. */
export const VOID_ELEMENTS = new Set([
  'area', 'base', 'basefont', 'bgsound', 'br', 'col', 'embed', 'frame', 'hr',
  'img', 'input', 'keygen', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/** Elements whose content is text with no markup and no character references. */
export const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes']);

/** Elements whose content is text with character references but no markup. */
export const ESCAPABLE_RAW_TEXT_ELEMENTS = new Set(['textarea', 'title']);

/** Elements that live in `<head>` when no body content has started yet. */
export const HEAD_ELEMENTS = new Set([
  'base', 'basefont', 'bgsound', 'link', 'meta', 'noscript', 'script', 'style', 'template', 'title',
]);

/** Inline/formatting elements an implied `</p>` is allowed to close through. */
const INLINE_ELEMENTS = new Set([
  'a', 'abbr', 'acronym', 'b', 'bdi', 'bdo', 'big', 'cite', 'code', 'data', 'del',
  'dfn', 'em', 'font', 'i', 'ins', 'kbd', 'label', 'mark', 'nobr', 'q', 'rp', 'rt',
  'ruby', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'time',
  'tt', 'u', 'var',
]);

/** Start tags that imply `</p>`. */
const P_CLOSERS = new Set([
  'address', 'article', 'aside', 'blockquote', 'center', 'details', 'dialog', 'dir',
  'div', 'dl', 'dt', 'dd', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'li', 'main', 'menu',
  'nav', 'ol', 'p', 'pre', 'search', 'section', 'summary', 'table', 'ul',
]);

/**
 * Optional-end-tag rules. For a start tag `k`, walk up the open-element stack:
 * close any open element named in `closes`, and stop the walk at any element
 * named in `stopAt` (or at a scope boundary) so nested structures still nest.
 * @type {Record<string, {closes: string[], stopAt: string[]}>}
 */
const IMPLICIT_CLOSE = {
  li: { closes: ['li'], stopAt: ['ul', 'ol', 'menu', 'template'] },
  dt: { closes: ['dt', 'dd'], stopAt: ['dl', 'template'] },
  dd: { closes: ['dt', 'dd'], stopAt: ['dl', 'template'] },
  option: { closes: ['option'], stopAt: ['select', 'datalist', 'optgroup', 'template'] },
  optgroup: { closes: ['option', 'optgroup'], stopAt: ['select', 'template'] },
  td: { closes: ['td', 'th'], stopAt: ['tr', 'template'] },
  th: { closes: ['td', 'th'], stopAt: ['tr', 'template'] },
  tr: { closes: ['td', 'th', 'tr'], stopAt: ['table', 'template'] },
  tbody: { closes: ['td', 'th', 'tr', 'tbody', 'thead', 'tfoot', 'caption', 'colgroup'], stopAt: ['table', 'template'] },
  thead: { closes: ['td', 'th', 'tr', 'tbody', 'thead', 'tfoot', 'caption', 'colgroup'], stopAt: ['table', 'template'] },
  tfoot: { closes: ['td', 'th', 'tr', 'tbody', 'thead', 'tfoot', 'caption', 'colgroup'], stopAt: ['table', 'template'] },
  caption: { closes: ['caption', 'colgroup'], stopAt: ['table', 'template'] },
  colgroup: { closes: ['caption', 'colgroup'], stopAt: ['table', 'template'] },
  // A `<table>` inside a cell nests; a `<table>` while another table is open at
  // the same level replaces it, which is what browsers do with `<table><table>`.
  table: { closes: ['table'], stopAt: ['td', 'th', 'caption', 'template'] },
  h1: { closes: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'], stopAt: [] },
  h2: { closes: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'], stopAt: [] },
  h3: { closes: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'], stopAt: [] },
  h4: { closes: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'], stopAt: [] },
  h5: { closes: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'], stopAt: [] },
  h6: { closes: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'], stopAt: [] },
  rt: { closes: ['rt', 'rp'], stopAt: ['ruby', 'template'] },
  rp: { closes: ['rt', 'rp'], stopAt: ['ruby', 'template'] },
};

/**
 * HTML5's "in scope" stoppers: an end tag never unwinds past one of these, so a
 * single unbalanced `</div>` inside a table cell cannot destroy a page.
 */
const SCOPE_BOUNDARIES = new Set(['html', 'body', 'head', 'template', 'td', 'th', 'caption', 'table', 'button', 'object', 'marquee']);

/**
 * HTML5's "in table scope" stoppers, which are far weaker: `</table>` and
 * `</tr>` are *expected* to close the cells and rows above them, and a parser
 * that refuses to do so silently swallows the rest of the document into the
 * first table it meets — which is exactly what real pages with implied `</td>`
 * would trigger.
 */
const TABLE_SCOPE_BOUNDARIES = new Set(['html', 'body', 'head', 'template']);

/** End tags resolved in table scope rather than ordinary scope. */
const TABLE_ELEMENTS = new Set(['table', 'tbody', 'thead', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup']);

/** SVG tag names whose canonical form is not all-lowercase. */
const SVG_TAG_ADJUST = new Map([
  ['altglyph', 'altGlyph'], ['altglyphdef', 'altGlyphDef'], ['altglyphitem', 'altGlyphItem'],
  ['animatecolor', 'animateColor'], ['animatemotion', 'animateMotion'], ['animatetransform', 'animateTransform'],
  ['clippath', 'clipPath'], ['feblend', 'feBlend'], ['fecolormatrix', 'feColorMatrix'],
  ['fecomponenttransfer', 'feComponentTransfer'], ['fecomposite', 'feComposite'],
  ['feconvolvematrix', 'feConvolveMatrix'], ['fediffuselighting', 'feDiffuseLighting'],
  ['fedisplacementmap', 'feDisplacementMap'], ['fedistantlight', 'feDistantLight'],
  ['fedropshadow', 'feDropShadow'], ['feflood', 'feFlood'], ['fefunca', 'feFuncA'],
  ['fefuncb', 'feFuncB'], ['fefuncg', 'feFuncG'], ['fefuncr', 'feFuncR'],
  ['fegaussianblur', 'feGaussianBlur'], ['feimage', 'feImage'], ['femerge', 'feMerge'],
  ['femergenode', 'feMergeNode'], ['femorphology', 'feMorphology'], ['feoffset', 'feOffset'],
  ['fepointlight', 'fePointLight'], ['fespecularlighting', 'feSpecularLighting'],
  ['fespotlight', 'feSpotLight'], ['fetile', 'feTile'], ['feturbulence', 'feTurbulence'],
  ['foreignobject', 'foreignObject'], ['glyphref', 'glyphRef'], ['lineargradient', 'linearGradient'],
  ['radialgradient', 'radialGradient'], ['textpath', 'textPath'],
]);

/** SVG/MathML attribute names whose canonical form is not all-lowercase. */
const FOREIGN_ATTR_ADJUST = new Map([
  ['attributename', 'attributeName'], ['attributetype', 'attributeType'], ['basefrequency', 'baseFrequency'],
  ['baseprofile', 'baseProfile'], ['calcmode', 'calcMode'], ['clippathunits', 'clipPathUnits'],
  ['diffuseconstant', 'diffuseConstant'], ['edgemode', 'edgeMode'], ['filterunits', 'filterUnits'],
  ['glyphref', 'glyphRef'], ['gradienttransform', 'gradientTransform'], ['gradientunits', 'gradientUnits'],
  ['kernelmatrix', 'kernelMatrix'], ['kernelunitlength', 'kernelUnitLength'], ['keypoints', 'keyPoints'],
  ['keysplines', 'keySplines'], ['keytimes', 'keyTimes'], ['lengthadjust', 'lengthAdjust'],
  ['limitingconeangle', 'limitingConeAngle'], ['markerheight', 'markerHeight'], ['markerunits', 'markerUnits'],
  ['markerwidth', 'markerWidth'], ['maskcontentunits', 'maskContentUnits'], ['maskunits', 'maskUnits'],
  ['numoctaves', 'numOctaves'], ['pathlength', 'pathLength'], ['patterncontentunits', 'patternContentUnits'],
  ['patterntransform', 'patternTransform'], ['patternunits', 'patternUnits'], ['pointsatx', 'pointsAtX'],
  ['pointsaty', 'pointsAtY'], ['pointsatz', 'pointsAtZ'], ['preservealpha', 'preserveAlpha'],
  ['preserveaspectratio', 'preserveAspectRatio'], ['primitiveunits', 'primitiveUnits'],
  ['refx', 'refX'], ['refy', 'refY'], ['repeatcount', 'repeatCount'], ['repeatdur', 'repeatDur'],
  ['requiredextensions', 'requiredExtensions'], ['requiredfeatures', 'requiredFeatures'],
  ['specularconstant', 'specularConstant'], ['specularexponent', 'specularExponent'],
  ['spreadmethod', 'spreadMethod'], ['startoffset', 'startOffset'], ['stddeviation', 'stdDeviation'],
  ['stitchtiles', 'stitchTiles'], ['surfacescale', 'surfaceScale'], ['systemlanguage', 'systemLanguage'],
  ['tablevalues', 'tableValues'], ['targetx', 'targetX'], ['targety', 'targetY'],
  ['textlength', 'textLength'], ['viewbox', 'viewBox'], ['viewtarget', 'viewTarget'],
  ['xchannelselector', 'xChannelSelector'], ['ychannelselector', 'yChannelSelector'], ['zoomandpan', 'zoomAndPan'],
]);

const WHITESPACE_ONLY = /^[\t\n\f\r ]*$/;

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

/**
 * @typedef {{type:'start', tag:string, attrs:Record<string,string>, selfClosing:boolean, start:number}
 *         | {type:'end', tag:string, start:number}
 *         | {type:'text', text:string, start:number}
 *         | {type:'comment', text:string, start:number}
 *         | {type:'doctype', name:string, start:number}} Token
 */

/**
 * True for a character that may start a tag name.
 * @param {string|undefined} c
 */
function isAsciiAlpha(c) { return c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')); }

/**
 * True for tag-name and attribute-name terminators.
 * @param {string} c
 */
function isSpace(c) { return c === ' ' || c === '\t' || c === '\n' || c === '\f' || c === '\r'; }

/**
 * Tokenize a source string. Never throws: malformed input degrades to text.
 * @param {string} src
 * @returns {Token[]}
 */
export function tokenize(src) {
  const s = String(src);
  const n = s.length;
  /** @type {Token[]} */
  const tokens = [];
  let i = 0;
  /** Accumulated plain text, flushed when markup interrupts it. */
  let textStart = 0;
  let text = '';

  const flushText = () => {
    if (text.length) { tokens.push({ type: 'text', text, start: textStart }); text = ''; }
  };

  while (i < n) {
    const c = s[i];
    if (c !== '<') {
      if (!text.length) textStart = i;
      const next = s.indexOf('<', i);
      const stop = next < 0 ? n : next;
      text += s.slice(i, stop);
      i = stop;
      continue;
    }

    // `<!--` comment
    if (s.startsWith('<!--', i)) {
      flushText();
      let end = s.indexOf('-->', i + 4);
      let after;
      if (end < 0) {
        const bang = s.indexOf('--!>', i + 4);
        if (bang >= 0) { end = bang; after = bang + 4; } else { end = n; after = n; }
      } else {
        after = end + 3;
      }
      tokens.push({ type: 'comment', text: s.slice(i + 4, end), start: i });
      i = after;
      continue;
    }

    // CDATA — legal only in foreign content; the tree builder decides.
    if (s.startsWith('<![CDATA[', i)) {
      flushText();
      const end = s.indexOf(']]>', i + 9);
      const stop = end < 0 ? n : end;
      tokens.push({ type: 'text', text: s.slice(i + 9, stop), start: i });
      i = end < 0 ? n : end + 3;
      continue;
    }

    // Doctype, or a bogus comment such as `<!foo>`.
    if (s.startsWith('<!', i)) {
      flushText();
      const end = s.indexOf('>', i);
      const stop = end < 0 ? n : end;
      const body = s.slice(i + 2, stop);
      if (/^doctype/i.test(body)) {
        tokens.push({ type: 'doctype', name: body.slice(7).trim(), start: i });
      } else {
        tokens.push({ type: 'comment', text: body, start: i });
      }
      i = end < 0 ? n : end + 1;
      continue;
    }

    // Processing instruction — a bogus comment per HTML5.
    if (s[i + 1] === '?') {
      flushText();
      const end = s.indexOf('>', i);
      const stop = end < 0 ? n : end;
      tokens.push({ type: 'comment', text: s.slice(i + 1, stop), start: i });
      i = end < 0 ? n : end + 1;
      continue;
    }

    // End tag.
    if (s[i + 1] === '/') {
      if (!isAsciiAlpha(s[i + 2])) {
        // `</>` and `</ ...>` are bogus comments; `</` at EOF is text.
        const end = s.indexOf('>', i);
        if (end < 0) { if (!text.length) textStart = i; text += s.slice(i); i = n; continue; }
        flushText();
        if (end > i + 2) tokens.push({ type: 'comment', text: s.slice(i + 2, end), start: i });
        i = end + 1;
        continue;
      }
      flushText();
      let j = i + 2;
      while (j < n && !isSpace(s[j]) && s[j] !== '>' && s[j] !== '/') j++;
      const tag = s.slice(i + 2, j).toLowerCase();
      const end = s.indexOf('>', j);
      tokens.push({ type: 'end', tag, start: i });
      i = end < 0 ? n : end + 1;
      continue;
    }

    if (!isAsciiAlpha(s[i + 1])) {
      // A lone `<` is text.
      if (!text.length) textStart = i;
      text += '<';
      i += 1;
      continue;
    }

    // Start tag.
    flushText();
    let j = i + 1;
    while (j < n && !isSpace(s[j]) && s[j] !== '>' && s[j] !== '/') j++;
    const rawTag = s.slice(i + 1, j);
    const tag = rawTag.toLowerCase();
    const parsed = parseAttributes(s, j);
    if (parsed === null) {
      // Unterminated tag at EOF: browsers drop it entirely.
      i = n;
      continue;
    }
    tokens.push({ type: 'start', tag, attrs: parsed.attrs, selfClosing: parsed.selfClosing, start: i });
    i = parsed.next;

    // Raw-text content is consumed here, not by the tree builder, because the
    // only thing that terminates it is its own end tag.
    if (!parsed.selfClosing && (RAW_TEXT_ELEMENTS.has(tag) || ESCAPABLE_RAW_TEXT_ELEMENTS.has(tag))) {
      const closeAt = findRawTextEnd(s, i, tag);
      const body = s.slice(i, closeAt.content);
      if (body.length) {
        tokens.push({
          type: 'text',
          text: ESCAPABLE_RAW_TEXT_ELEMENTS.has(tag) ? decodeEntities(body) : body,
          start: i,
        });
      }
      if (closeAt.found) tokens.push({ type: 'end', tag, start: closeAt.content });
      i = closeAt.next;
    }
  }
  flushText();
  return tokens;
}

/**
 * Find the end of a raw-text element's content.
 * @param {string} s
 * @param {number} from
 * @param {string} tag
 * @returns {{content: number, next: number, found: boolean}}
 */
function findRawTextEnd(s, from, tag) {
  const n = s.length;
  const len = tag.length;
  for (let at = from; at < n; at++) {
    if (s.charCodeAt(at) !== 0x3c) continue;          // '<'
    if (s.charCodeAt(at + 1) !== 0x2f) continue;      // '/'
    let ok = true;
    for (let k = 0; k < len; k++) {
      const c = s.charCodeAt(at + 2 + k);
      const want = tag.charCodeAt(k);
      // ASCII-case-insensitive compare, without allocating a lowered copy of
      // the whole source (which would also be unsafe: some Unicode lowercase
      // mappings change string length and would shift every index).
      if (c !== want && (c | 0x20) !== want) { ok = false; break; }
    }
    if (!ok) continue;
    const after = s[at + 2 + len];
    if (after === undefined || isSpace(after) || after === '>' || after === '/') {
      const gt = s.indexOf('>', at);
      return { content: at, next: gt < 0 ? n : gt + 1, found: true };
    }
  }
  return { content: n, next: n, found: false };
}

/**
 * Parse a start tag's attribute list, beginning at the first character after
 * the tag name.
 * @param {string} s
 * @param {number} from
 * @returns {{attrs: Record<string,string>, selfClosing: boolean, next: number}|null}
 */
function parseAttributes(s, from) {
  const n = s.length;
  /** @type {Record<string,string>} */
  const attrs = {};
  let i = from;
  let selfClosing = false;
  for (;;) {
    while (i < n && isSpace(s[i])) i++;
    if (i >= n) return null;
    if (s[i] === '>') return { attrs, selfClosing, next: i + 1 };
    if (s[i] === '/') {
      // `/` is only self-closing immediately before `>`; anywhere else it is
      // simply skipped, matching the tokenizer's "after attribute name" state.
      let k = i + 1;
      while (k < n && isSpace(s[k])) k++;
      if (s[k] === '>') return { attrs, selfClosing: true, next: k + 1 };
      i += 1;
      continue;
    }
    // Attribute name. `<` and `"` are legal here in the wild (`<div <span>`).
    const nameStart = i;
    while (i < n && !isSpace(s[i]) && s[i] !== '=' && s[i] !== '>' && !(s[i] === '/' && s[i + 1] === '>')) i++;
    let name = s.slice(nameStart, i).toLowerCase();
    if (!name) { i += 1; continue; }
    let value = '';
    let k = i;
    while (k < n && isSpace(s[k])) k++;
    if (s[k] === '=') {
      k += 1;
      while (k < n && isSpace(s[k])) k++;
      const q = s[k];
      if (q === '"' || q === "'") {
        const end = s.indexOf(q, k + 1);
        if (end < 0) { value = s.slice(k + 1); i = n; }
        else { value = s.slice(k + 1, end); i = end + 1; }
      } else {
        const vs = k;
        while (k < n && !isSpace(s[k]) && s[k] !== '>') k++;
        value = s.slice(vs, k);
        i = k;
      }
      value = decodeEntities(value, { inAttribute: true });
    } else {
      i = k;
    }
    // First declaration wins, per HTML5.
    if (!(name in attrs)) attrs[name] = value;
  }
}

// ---------------------------------------------------------------------------
// Tree construction
// ---------------------------------------------------------------------------

/**
 * Create an element node.
 * @param {string} tag
 * @param {Record<string,string>} [attrs]
 * @returns {DocNode}
 */
export function createElement(tag, attrs = {}) {
  return { type: 'element', tag, attrs, children: [] };
}

/**
 * Append a child, wiring the parent back-reference.
 * @param {DocNode} parent
 * @param {DocNode} child
 * @returns {DocNode}
 */
export function appendChild(parent, child) {
  if (!parent.children) parent.children = [];
  parent.children.push(child);
  child.parent = parent;
  return child;
}

/**
 * Parse a document. Always returns a `#document` root with an `html` element,
 * a `head` and a `body`, whether or not the source declared them — every
 * consumer downstream (chrome stripping, brand extraction, meta reading) wants
 * to ask for `head` and `body` without first asking whether they exist.
 *
 * @param {string} source
 * @returns {DocNode}
 */
export function parseHtml(source) {
  const tokens = tokenize(source == null ? '' : String(source));

  /** @type {DocNode} */
  const document = { type: 'element', tag: '#document', attrs: {}, children: [], doctype: null };
  const html = appendChild(document, createElement('html'));
  const head = appendChild(html, createElement('head'));
  /** @type {DocNode|null} */
  let body = null;
  /** Open element stack; index 0 is always `html`. */
  /** @type {DocNode[]} */
  let stack = [html, head];
  let inBody = false;

  const openBody = () => {
    if (inBody) return;
    // Close everything still open in the head.
    while (stack.length > 1) stack.pop();
    body = appendChild(html, createElement('body'));
    stack.push(body);
    inBody = true;
  };

  const current = () => stack[stack.length - 1];

  /** True when the insertion point is inside an `svg` or `math` subtree. */
  const inForeign = () => {
    for (let k = stack.length - 1; k >= 0; k--) {
      const t = stack[k].tag;
      if (t === 'svg' || t === 'math') return true;
      if (t === 'foreignObject' || t === 'desc' || t === 'title') {
        // Foreign content re-enters HTML inside these integration points.
        for (let m = k - 1; m >= 0; m--) {
          if (stack[m].tag === 'svg' || stack[m].tag === 'math') return false;
        }
        return false;
      }
    }
    return false;
  };

  /**
   * Pop elements per an optional-end-tag rule.
   * @param {string} tag
   */
  const applyImplicitClose = (tag) => {
    const rule = IMPLICIT_CLOSE[tag];
    if (rule) {
      // Walk outward, remembering the shallowest element the rule closes, and
      // stop at the structure that owns it. `<tr><td>a<tr>` has to close both
      // the cell and the row, not just the cell.
      let cut = -1;
      for (let k = stack.length - 1; k >= 1; k--) {
        const name = /** @type {string} */ (stack[k].tag);
        if (rule.closes.includes(name)) { cut = k; continue; }
        if (rule.stopAt.includes(name) || SCOPE_BOUNDARIES.has(name)) break;
      }
      if (cut > 0) stack.length = cut;
      return;
    }
    if (P_CLOSERS.has(tag)) {
      for (let k = stack.length - 1; k >= 1; k--) {
        const name = /** @type {string} */ (stack[k].tag);
        if (name === 'p') { stack.length = k; return; }
        if (!INLINE_ELEMENTS.has(name)) return;
      }
    }
  };

  for (const token of tokens) {
    if (token.type === 'doctype') {
      if (document.doctype === null) document.doctype = token.name;
      continue;
    }

    if (token.type === 'comment') {
      appendChild(current(), { type: 'comment', text: token.text });
      continue;
    }

    if (token.type === 'text') {
      const openTag = /** @type {string} */ (current().tag);
      const rawHost = RAW_TEXT_ELEMENTS.has(openTag) || ESCAPABLE_RAW_TEXT_ELEMENTS.has(openTag);
      if (!rawHost) {
        if (!inBody && WHITESPACE_ONLY.test(token.text)) {
          // Inter-element whitespace in the head is dropped, as in a browser.
          continue;
        }
        if (!inBody) openBody();
      }
      const parentTag = /** @type {string} */ (current().tag);
      // The tokenizer already decoded escapable raw text; script and style are
      // never decoded at all.
      const decoded = rawHost ? token.text : decodeEntities(token.text);
      const last = current().children && current().children[current().children.length - 1];
      if (last && last.type === 'text') last.text += decoded;
      else appendChild(current(), { type: 'text', text: decoded });
      continue;
    }

    if (token.type === 'start') {
      const tag = token.tag;

      if (tag === 'html') {
        Object.assign(html.attrs, missingOnly(html.attrs, token.attrs));
        continue;
      }
      if (tag === 'head') {
        Object.assign(head.attrs, missingOnly(head.attrs, token.attrs));
        continue;
      }
      if (tag === 'body') {
        openBody();
        if (body) Object.assign(body.attrs, missingOnly(body.attrs, token.attrs));
        continue;
      }
      if (tag === 'frameset') {
        // Frameset documents have no body; treat the frameset as the body so
        // the tree stays uniform and frame `src` values remain reachable.
        openBody();
      }

      if (!inBody && !HEAD_ELEMENTS.has(tag)) openBody();

      const foreign = inForeign() || tag === 'svg' || tag === 'math';
      if (!foreign) applyImplicitClose(tag);

      const finalTag = foreign ? (SVG_TAG_ADJUST.get(tag) || tag) : tag;
      const attrs = foreign ? adjustForeignAttrs(token.attrs) : token.attrs;
      const el = appendChild(current(), createElement(finalTag, attrs));

      if (VOID_ELEMENTS.has(tag)) continue;
      if (token.selfClosing && (foreign || !isKnownHtmlElement(tag))) continue;
      stack.push(el);
      continue;
    }

    if (token.type === 'end') {
      const tag = token.tag;
      if (tag === 'br') {
        // `</br>` is a `<br>` per HTML5. Real sites emit it.
        if (!inBody) openBody();
        appendChild(current(), createElement('br'));
        continue;
      }
      if (tag === 'html' || tag === 'body') {
        if (inBody && body) { stack.length = stack.indexOf(body) + 1; }
        continue;
      }
      if (tag === 'head') {
        if (!inBody) openBody();
        continue;
      }
      const target = foreignAwareName(tag, inForeign());
      const boundaries = TABLE_ELEMENTS.has(tag) ? TABLE_SCOPE_BOUNDARIES : SCOPE_BOUNDARIES;
      for (let k = stack.length - 1; k >= 1; k--) {
        if (stack[k].tag === target || stack[k].tag === tag) { stack.length = k; break; }
        // A stray end tag inside an unrelated subtree is ignored rather than
        // unwinding the document, which is what browsers do and what keeps a
        // single unbalanced `</div>` from destroying a page's structure.
        if (boundaries.has(/** @type {string} */ (stack[k].tag))) break;
      }
      continue;
    }
  }

  if (!inBody) openBody();
  return document;
}

/**
 * Attribute names not already present, so an explicit `<html lang>` later in
 * the document cannot silently override an earlier one.
 * @param {Record<string,string>} existing
 * @param {Record<string,string>} incoming
 * @returns {Record<string,string>}
 */
function missingOnly(existing, incoming) {
  /** @type {Record<string,string>} */
  const out = {};
  for (const [k, v] of Object.entries(incoming)) if (!(k in existing)) out[k] = v;
  return out;
}

/**
 * @param {Record<string,string>} attrs
 * @returns {Record<string,string>}
 */
function adjustForeignAttrs(attrs) {
  /** @type {Record<string,string>} */
  const out = {};
  for (const [k, v] of Object.entries(attrs)) out[FOREIGN_ATTR_ADJUST.get(k) || k] = v;
  return out;
}

/**
 * @param {string} tag
 * @param {boolean} foreign
 * @returns {string}
 */
function foreignAwareName(tag, foreign) {
  return foreign ? (SVG_TAG_ADJUST.get(tag) || tag) : tag;
}

/** Every element name HTML defines. Used only to decide whether `/>` is real. */
const KNOWN_HTML_ELEMENTS = new Set([
  'a', 'abbr', 'address', 'area', 'article', 'aside', 'audio', 'b', 'base', 'bdi', 'bdo',
  'blockquote', 'body', 'br', 'button', 'canvas', 'caption', 'cite', 'code', 'col',
  'colgroup', 'data', 'datalist', 'dd', 'del', 'details', 'dfn', 'dialog', 'div', 'dl',
  'dt', 'em', 'embed', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2',
  'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hgroup', 'hr', 'html', 'i', 'iframe', 'img',
  'input', 'ins', 'kbd', 'label', 'legend', 'li', 'link', 'main', 'map', 'mark', 'menu',
  'meta', 'meter', 'nav', 'noscript', 'object', 'ol', 'optgroup', 'option', 'output', 'p',
  'param', 'picture', 'pre', 'progress', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'script',
  'search', 'section', 'select', 'slot', 'small', 'source', 'span', 'strong', 'style',
  'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th',
  'thead', 'time', 'title', 'tr', 'track', 'u', 'ul', 'var', 'video', 'wbr',
  'font', 'center', 'strike', 'big', 'tt', 'nobr', 'frame', 'frameset', 'noframes',
]);

/**
 * @param {string} tag
 * @returns {boolean}
 */
export function isKnownHtmlElement(tag) { return KNOWN_HTML_ELEMENTS.has(tag); }

/**
 * Parse a fragment without synthesising `html`/`head`/`body`. Used by the MHTML
 * and saved-page importers when they are handed a partial document, and by the
 * paste surface when a user pastes a component rather than a page.
 * @param {string} source
 * @returns {DocNode}
 */
export function parseFragment(source) {
  const doc = parseHtml(source);
  const body = firstElement(doc, 'body');
  const head = firstElement(doc, 'head');
  const root = createElement('#fragment');
  const move = (from) => {
    if (!from || !from.children) return;
    for (const child of from.children) appendChild(root, child);
  };
  move(head);
  move(body);
  return root;
}

// ---------------------------------------------------------------------------
// Node utilities
// ---------------------------------------------------------------------------

/**
 * Depth-first walk in document order. `visit` returning `false` prunes the
 * subtree; returning `'stop'` ends the walk.
 * @param {DocNode} node
 * @param {(node: DocNode, depth: number) => (boolean|'stop'|void)} visit
 * @param {number} [depth]
 * @returns {boolean} false once the walk has been stopped
 */
export function walk(node, visit, depth = 0) {
  if (!node) return true;
  const verdict = visit(node, depth);
  if (verdict === 'stop') return false;
  if (verdict === false) return true;
  const kids = node.children;
  if (kids) {
    for (let i = 0; i < kids.length; i++) {
      if (!walk(kids[i], visit, depth + 1)) return false;
    }
  }
  return true;
}

/**
 * The concatenated text of a subtree. `script` and `style` contribute nothing,
 * because their contents are code and would otherwise poison every word count
 * and every text extraction downstream.
 * @param {DocNode|null|undefined} node
 * @returns {string}
 */
export function textContent(node) {
  if (!node) return '';
  if (node.type === 'text') return node.text || '';
  if (node.type === 'comment') return '';
  let out = '';
  walk(node, (n) => {
    if (n === node) return undefined;
    if (n.type === 'text') { out += n.text || ''; return undefined; }
    if (n.type === 'element' && (n.tag === 'script' || n.tag === 'style' || n.tag === 'template')) return false;
    return undefined;
  });
  return out;
}

/**
 * Text with whitespace collapsed the way a rendering engine would collapse it.
 * @param {DocNode|null|undefined} node
 * @returns {string}
 */
export function normalizedText(node) {
  return textContent(node).replace(/[\t\n\f\r ]+/g, ' ').trim();
}

/**
 * One attribute value, or null. Attribute names are matched case-insensitively
 * except in foreign content, where the canonical camelCase name is tried too.
 * @param {DocNode|null|undefined} node
 * @param {string} name
 * @returns {string|null}
 */
export function attr(node, name) {
  if (!node || node.type !== 'element' || !node.attrs) return null;
  const lower = String(name).toLowerCase();
  if (lower in node.attrs) return node.attrs[lower];
  const adjusted = FOREIGN_ATTR_ADJUST.get(lower);
  if (adjusted && adjusted in node.attrs) return node.attrs[adjusted];
  if (name in node.attrs) return node.attrs[name];
  return null;
}

/**
 * True when the attribute is present at all, valueless included.
 * @param {DocNode|null|undefined} node
 * @param {string} name
 */
export function hasAttr(node, name) { return attr(node, name) !== null; }

/**
 * Element children only.
 * @param {DocNode|null|undefined} node
 * @returns {DocNode[]}
 */
export function childElements(node) {
  if (!node || !node.children) return [];
  return node.children.filter((c) => c.type === 'element');
}

/**
 * The first element with a tag name, in document order.
 * @param {DocNode} root
 * @param {string} tag
 * @returns {DocNode|null}
 */
export function firstElement(root, tag) {
  /** @type {DocNode|null} */
  let found = null;
  walk(root, (n) => {
    if (n.type === 'element' && n.tag === tag) { found = n; return 'stop'; }
    return undefined;
  });
  return found;
}

/**
 * Every element with a tag name, in document order.
 * @param {DocNode} root
 * @param {string} tag
 * @returns {DocNode[]}
 */
export function elementsByTag(root, tag) {
  /** @type {DocNode[]} */
  const out = [];
  walk(root, (n) => { if (n.type === 'element' && n.tag === tag) out.push(n); });
  return out;
}

/**
 * The class list of an element, split and de-duplicated.
 * @param {DocNode} node
 * @returns {string[]}
 */
export function classList(node) {
  const value = attr(node, 'class');
  if (!value) return [];
  return Array.from(new Set(value.split(/[\t\n\f\r ]+/).filter(Boolean)));
}

/**
 * The chain of ancestors, nearest first.
 * @param {DocNode} node
 * @returns {DocNode[]}
 */
export function ancestors(node) {
  /** @type {DocNode[]} */
  const out = [];
  let p = node.parent;
  while (p) { out.push(p); p = p.parent; }
  return out;
}

/**
 * A stable structural path for a node — `html/body/div[2]/p[1]`. Deterministic
 * and independent of any id, so two parses of the same source name the same
 * node the same way.
 * @param {DocNode} node
 * @returns {string}
 */
export function nodePath(node) {
  /** @type {string[]} */
  const parts = [];
  let cur = node;
  while (cur && cur.parent) {
    const parent = cur.parent;
    const siblings = (parent.children || []).filter((c) => c.type === cur.type && (cur.type !== 'element' || c.tag === cur.tag));
    const index = siblings.indexOf(cur);
    parts.unshift(cur.type === 'element' ? `${cur.tag}[${index}]` : `#${cur.type}[${index}]`);
    cur = parent;
  }
  return parts.join('/');
}

/**
 * A cycle-free copy of a subtree — the same shape without `parent`. Tests
 * assert against this; so does anything that wants to `JSON.stringify` a node.
 * @param {DocNode} node
 * @returns {object}
 */
export function plainTree(node) {
  if (!node) return null;
  if (node.type === 'text') return { type: 'text', text: node.text };
  if (node.type === 'comment') return { type: 'comment', text: node.text };
  /** @type {any} */
  const out = { type: 'element', tag: node.tag };
  if (node.attrs && Object.keys(node.attrs).length) out.attrs = { ...node.attrs };
  if (node.children && node.children.length) out.children = node.children.map(plainTree);
  return out;
}

/**
 * Serialize a subtree back to HTML. Round-trips well enough that a saved-page
 * or MHTML import can hand `html` back to a consumer that wants source, and
 * exactly enough that §8's untouched `raw` copy stays faithful.
 * @param {DocNode} node
 * @returns {string}
 */
export function serialize(node) {
  if (!node) return '';
  if (node.type === 'text') {
    const parentTag = node.parent && node.parent.tag;
    if (parentTag && RAW_TEXT_ELEMENTS.has(parentTag)) return node.text || '';
    return String(node.text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  if (node.type === 'comment') return `<!--${node.text || ''}-->`;
  const tag = node.tag;
  if (tag === '#document' || tag === '#fragment') {
    const prefix = tag === '#document' && node.doctype !== null && node.doctype !== undefined
      ? `<!DOCTYPE ${node.doctype}>` : '';
    return prefix + (node.children || []).map(serialize).join('');
  }
  const attrs = Object.entries(node.attrs || {})
    .map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`))
    .join('');
  if (VOID_ELEMENTS.has(tag)) return `<${tag}${attrs}>`;
  return `<${tag}${attrs}>${(node.children || []).map(serialize).join('')}</${tag}>`;
}
