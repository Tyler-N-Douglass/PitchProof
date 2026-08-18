/**
 * The parsing substrate the network scanner stands on (§13, DECISIONS D10).
 *
 * D10's whole point is that the scanner **parses rather than greps**: a literal
 * grep for `http://`, `//` and `src=` fails every legal artifact — inline SVG
 * carries a namespace URI, every image is a `data:` URI with `src=`, and every
 * base64 payload contains `//` by the thousand. A law that has to be switched
 * off is not a law, so this module gives the scanner enough structure to be
 * absolute about the things that actually reach the network and silent about
 * the things that never could.
 *
 * Three tokenizers, all position-preserving so every finding can name a line
 * and a column:
 *
 *   - `tokenizeHtml`  — tags, attributes (with offsets), text, comments, and
 *                       the raw-text elements whose content is script or CSS.
 *   - `maskJs`        — blanks comments and string/template/regex literals to
 *                       spaces of equal length, and reports the literals it
 *                       blanked. §13 exempts "inert string literals" from the
 *                       constructor rules; masking is how that exemption is
 *                       implemented rather than assumed.
 *   - `maskCss`       — blanks comments only; CSS string contents matter,
 *                       because `url("…")` is exactly the thing being checked.
 *
 * Nothing here is lenient in the way an HTML *content* parser is lenient. A
 * content parser guesses what an author meant; this one records what a browser
 * would see, and prefers to over-report structure it cannot resolve.
 *
 * @module emit/scan-parse
 */

/** Elements whose content is not markup. */
export const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes']);

/** Elements with no end tag. */
export const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/**
 * @typedef {object} HtmlAttr
 * @property {string} name        lower-cased attribute name
 * @property {string} rawName     the name as written
 * @property {string} value       the decoded-enough value (entities for &, <, >, ", ' resolved)
 * @property {number} index       offset of the attribute name in the source
 * @property {number} valueIndex  offset of the value in the source
 */

/**
 * @typedef {object} HtmlToken
 * @property {'tag'|'endtag'|'text'|'comment'|'doctype'|'rawtext'} kind
 * @property {string} name        lower-cased tag name, '' for text/comment
 * @property {HtmlAttr[]} attrs
 * @property {boolean} selfClosing
 * @property {string} text        text content for text/rawtext/comment tokens
 * @property {number} index       offset in the source
 * @property {string} [parent]    for rawtext: the tag whose content this is
 */

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'",
};

/**
 * Resolve the entity forms that can change how a URL parses. Deliberately
 * partial: an artifact whose `href` needs a rare named entity to be understood
 * is already suspicious, and the residual text still fails the allowlist.
 * @param {string} s
 * @returns {string}
 */
export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);?/g, (whole, body) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff) {
        try { return String.fromCodePoint(cp); } catch { return whole; }
      }
      return whole;
    }
    const hit = NAMED_ENTITIES[body.toLowerCase()];
    return hit === undefined ? whole : hit;
  });
}

/**
 * Tokenize a document. Never throws: malformed markup yields text tokens rather
 * than an exception, because a scanner that dies on hostile input has failed
 * open, which is the one outcome §13 cannot tolerate.
 *
 * @param {string} html
 * @returns {HtmlToken[]}
 */
export function tokenizeHtml(html) {
  const src = String(html);
  /** @type {HtmlToken[]} */
  const out = [];
  let i = 0;
  const n = src.length;

  const pushText = (start, end, kind = 'text', parent) => {
    if (end <= start) return;
    out.push({ kind, name: '', attrs: [], selfClosing: false, text: src.slice(start, end), index: start, parent });
  };

  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { pushText(i, n); break; }
    pushText(i, lt);

    // Comment / doctype / CDATA.
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      const stop = end < 0 ? n : end + 3;
      out.push({ kind: 'comment', name: '', attrs: [], selfClosing: false, text: src.slice(lt + 4, end < 0 ? n : end), index: lt });
      i = stop;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      const stop = end < 0 ? n : end + 3;
      pushText(lt + 9, end < 0 ? n : end);
      i = stop;
      continue;
    }
    if (src[lt + 1] === '!' || src[lt + 1] === '?') {
      const end = src.indexOf('>', lt);
      const stop = end < 0 ? n : end + 1;
      out.push({ kind: 'doctype', name: '', attrs: [], selfClosing: false, text: src.slice(lt, stop), index: lt });
      i = stop;
      continue;
    }

    // End tag.
    if (src[lt + 1] === '/') {
      const m = /^<\/\s*([A-Za-z][^\s>/]*)\s*>?/.exec(src.slice(lt));
      if (!m) { pushText(lt, lt + 1); i = lt + 1; continue; }
      out.push({ kind: 'endtag', name: m[1].toLowerCase(), attrs: [], selfClosing: false, text: '', index: lt });
      i = lt + m[0].length;
      continue;
    }

    // Start tag.
    const nameMatch = /^<([A-Za-z][^\s>/]*)/.exec(src.slice(lt));
    if (!nameMatch) { pushText(lt, lt + 1); i = lt + 1; continue; }
    const tagName = nameMatch[1].toLowerCase();
    let p = lt + nameMatch[0].length;
    /** @type {HtmlAttr[]} */
    const attrs = [];
    let selfClosing = false;

    while (p < n) {
      while (p < n && /\s/.test(src[p])) p++;
      if (p >= n) break;
      if (src[p] === '>') { p++; break; }
      if (src[p] === '/' && src[p + 1] === '>') { selfClosing = true; p += 2; break; }
      if (src[p] === '/') { p++; continue; }

      const nameStart = p;
      while (p < n && !/[\s=>/]/.test(src[p])) p++;
      const rawName = src.slice(nameStart, p);
      if (!rawName) { p++; continue; }
      while (p < n && /\s/.test(src[p])) p++;
      let value = '';
      let valueIndex = p;
      if (src[p] === '=') {
        p++;
        while (p < n && /\s/.test(src[p])) p++;
        const q = src[p];
        if (q === '"' || q === "'") {
          const close = src.indexOf(q, p + 1);
          const stop = close < 0 ? n : close;
          valueIndex = p + 1;
          value = src.slice(p + 1, stop);
          p = close < 0 ? n : close + 1;
        } else {
          valueIndex = p;
          const start = p;
          while (p < n && !/[\s>]/.test(src[p])) p++;
          value = src.slice(start, p);
        }
      }
      attrs.push({ name: rawName.toLowerCase(), rawName, value: decodeEntities(value), index: nameStart, valueIndex });
    }

    out.push({ kind: 'tag', name: tagName, attrs, selfClosing, text: '', index: lt });

    // Raw-text elements swallow everything up to their matching end tag.
    if (RAW_TEXT_TAGS.has(tagName) && !selfClosing) {
      const closeRe = new RegExp(`</\\s*${tagName}\\b`, 'i');
      const rest = src.slice(p);
      const m = closeRe.exec(rest);
      const contentEnd = m ? p + m.index : n;
      pushText(p, contentEnd, 'rawtext', tagName);
      i = contentEnd;
      continue;
    }
    i = p;
  }
  return out;
}

/**
 * Line and column (both 1-based) for a source offset.
 * @param {string} src
 * @param {number} index
 * @returns {{line: number, column: number}}
 */
export function lineColOf(src, index) {
  let line = 1;
  let last = -1;
  for (let i = 0; i < index && i < src.length; i++) {
    if (src.charCodeAt(i) === 10) { line++; last = i; }
  }
  return { line, column: index - last };
}

/**
 * A short, quoted excerpt around an offset, for a legible finding.
 * @param {string} src
 * @param {number} index
 * @param {number} [span]
 * @returns {string}
 */
export function excerptAt(src, index, span = 72) {
  const start = Math.max(0, index - 12);
  const text = src.slice(start, Math.min(src.length, start + span));
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * @typedef {object} MaskedSource
 * @property {string} code        same length as the input; comments and (for JS)
 *                                literals replaced by spaces
 * @property {{start: number, end: number, value: string, quote: string}[]} literals
 */

const REGEX_PRECEDERS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'do',
  'else', 'case', 'yield', 'await', 'throw',
]);

/**
 * Blank JavaScript comments and literals, preserving offsets.
 *
 * §13 exempts "inert string literals" from the constructor rules, so the
 * constructor scan runs over `code` while the URL scan runs over `literals`
 * as well — a `fetch` inside a string is inert, a URL inside a string is not
 * (D14 names the only three strings that are).
 *
 * @param {string} src
 * @returns {MaskedSource}
 */
export function maskJs(src) {
  const s = String(src);
  const out = new Array(s.length);
  /** @type {{start: number, end: number, value: string, quote: string}[]} */
  const literals = [];
  let i = 0;
  /** the last significant character emitted, used to disambiguate `/` */
  let prevSignificant = '';
  let prevWord = '';

  const blank = (from, to) => { for (let k = from; k < to; k++) out[k] = s.charCodeAt(k) === 10 ? '\n' : ' '; };
  const keep = (from, to) => { for (let k = from; k < to; k++) out[k] = s[k]; };

  while (i < s.length) {
    const c = s[i];
    const c2 = s[i + 1];

    if (c === '/' && c2 === '/') {
      let j = i;
      while (j < s.length && s[j] !== '\n') j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '/' && c2 === '*') {
      const end = s.indexOf('*/', i + 2);
      const j = end < 0 ? s.length : end + 2;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      const start = i;
      let j = i + 1;
      let value = '';
      while (j < s.length) {
        if (s[j] === '\\') { value += s[j + 1] === undefined ? '' : s[j + 1]; j += 2; continue; }
        if (s[j] === c) break;
        if (s[j] === '\n') break;      // unterminated; stop rather than swallow the file
        value += s[j];
        j++;
      }
      const end = Math.min(s.length, j + 1);
      blank(start, end);
      literals.push({ start, end, value, quote: c });
      i = end;
      prevSignificant = 'x';
      prevWord = '';
      continue;
    }
    if (c === '`') {
      const start = i;
      let j = i + 1;
      let value = '';
      let depth = 0;
      while (j < s.length) {
        if (s[j] === '\\') { value += s[j + 1] === undefined ? '' : s[j + 1]; j += 2; continue; }
        if (s[j] === '$' && s[j + 1] === '{') { depth++; j += 2; continue; }
        if (depth > 0 && s[j] === '}') { depth--; j++; continue; }
        if (depth === 0 && s[j] === '`') break;
        if (depth === 0) value += s[j];
        j++;
      }
      const end = Math.min(s.length, j + 1);
      // Template contents are blanked like a string, but any `${…}` inside was
      // real code; blanking it is the conservative direction only for the URL
      // scan, so the interpolations are re-scanned by the caller via `literals`.
      blank(start, end);
      literals.push({ start, end, value, quote: '`' });
      i = end;
      prevSignificant = 'x';
      prevWord = '';
      continue;
    }
    if (c === '/') {
      // Regex literal or division? Decide from the previous significant token.
      const regexOk = prevSignificant === '' || '(,=:[!&|?{};+-*%~^<>\n'.includes(prevSignificant)
        || REGEX_PRECEDERS.has(prevWord);
      if (regexOk) {
        let j = i + 1;
        let inClass = false;
        let ok = false;
        while (j < s.length) {
          const d = s[j];
          if (d === '\\') { j += 2; continue; }
          if (d === '\n') break;
          if (d === '[') inClass = true;
          else if (d === ']') inClass = false;
          else if (d === '/' && !inClass) { ok = true; break; }
          j++;
        }
        if (ok) {
          let end = j + 1;
          while (end < s.length && /[a-z]/i.test(s[end])) end++;
          blank(i, end);
          i = end;
          prevSignificant = 'x';
          prevWord = '';
          continue;
        }
      }
    }
    keep(i, i + 1);
    if (!/\s/.test(c)) {
      prevSignificant = c;
      prevWord = /[\w$]/.test(c) ? prevWord + c : '';
    } else if (/\s/.test(c)) {
      // a word ends at whitespace but stays available for the regex heuristic
      if (prevWord && !/[\w$]/.test(s[i + 1] || '')) { /* keep prevWord */ }
    }
    i++;
  }
  for (let k = 0; k < out.length; k++) if (out[k] === undefined) out[k] = ' ';
  return { code: out.join(''), literals };
}

/**
 * Blank CSS comments, preserving offsets. String contents are kept: in CSS the
 * interesting payload lives *inside* the quotes (`@import "…"`, `url("…")`).
 * @param {string} src
 * @returns {MaskedSource}
 */
export function maskCss(src) {
  const s = String(src);
  const out = s.split('');
  let i = 0;
  while (i < s.length) {
    if (s[i] === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      const stop = end < 0 ? s.length : end + 2;
      for (let k = i; k < stop; k++) out[k] = s.charCodeAt(k) === 10 ? '\n' : ' ';
      i = stop;
      continue;
    }
    i++;
  }
  return { code: out.join(''), literals: [] };
}
