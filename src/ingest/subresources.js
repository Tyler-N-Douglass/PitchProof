/**
 * Sub-resource collection (§6, §7, §8).
 *
 * A document on its own is not a capture. §1.2's first promise is "paste a
 * prospect URL, get an extracted brand system and a specimen library", and
 * neither is reachable from the HTML alone: the colours and the type stack live
 * in the stylesheet, the logo lives behind `<img src>`, and every media block
 * L6 emits needs bytes behind it or it raises a blocking `ASSET_MISSING`.
 *
 * So after the document lands, this module resolves what it references and
 * fetches it — through the **same injected transport**, so there is still no
 * global network path anywhere in the lane, and through the same route the
 * document took, so a capture that needed the user's proxy does not then try to
 * fetch its stylesheet direct.
 *
 * Three properties are non-negotiable, and each is asserted by test:
 *
 *   **Bounded.** A cap on count, on total bytes, on per-resource bytes, on CSS
 *   recursion depth, and a per-resource timeout. A prospect's home page must
 *   never be able to make the studio download a gigabyte.
 *
 *   **Reported.** Every skip is recorded with its reason, in `capture.meta` for
 *   anything that reads strings and in `capture.subresources` for anything that
 *   wants the detail. A proof with holes in it is survivable; a proof with
 *   holes nobody mentioned is the §18 failure.
 *
 *   **Deterministic.** Candidates are ordered by role and document position,
 *   the budget is applied in that order regardless of which response arrives
 *   first, and `assets[]` comes out in that order every time — because ids
 *   downstream are content-derived and §17.6 requires byte-identical re-emit.
 *
 * A sub-resource that fails degrades quietly (§6): the document capture still
 * succeeds.
 *
 * @module ingest/subresources
 */

import { querySelectorAll } from './select.js';
import { attr, firstElement, walk } from './html-parse.js';
import { resolveUrl, normalizeAssetRef, sniffMime, asciiHead } from './capture.js';
import { robotsAllows } from './robots.js';

/**
 * @typedef {import('./capture.js').CaptureAsset} CaptureAsset
 * @typedef {import('./html-parse.js').DocNode} DocNode
 */

/**
 * @typedef {object} SubresourceLimits
 * @property {number} maxCount              resources fetched, total
 * @property {number} maxTotalBytes         bytes kept, total
 * @property {number} maxBytesPerResource   a single resource larger than this is skipped
 * @property {number} timeoutMs             per resource
 * @property {number} maxCssDepth           `@import` recursion
 * @property {number} concurrency           requests in flight within one wave
 * @property {boolean} respectRobots
 * @property {string[]} allowHosts          extra hosts treated as same-site
 */

/**
 * Defaults chosen against a real enterprise home page: one stylesheet, a
 * webfont set, a logo, a mark, a hero and a handful of section images is
 * comfortably inside forty resources and eight megabytes, and anything past
 * that is a carousel the proof does not need.
 * @type {SubresourceLimits}
 */
export const SUBRESOURCE_LIMITS = {
  maxCount: 40,
  maxTotalBytes: 8_000_000,
  maxBytesPerResource: 4_000_000,
  timeoutMs: 10_000,
  maxCssDepth: 3,
  concurrency: 4,
  respectRobots: true,
  allowHosts: [],
};

/** The largest §4 breakpoint. A `srcset` pick aims here and no higher. */
export const SRCSET_TARGET_WIDTH = 1600;

/**
 * Roles, in the order they are fetched. Stylesheets lead because the brand
 * engine needs them most and because their `url()` references are discovered
 * only once they are in hand.
 * @type {Record<string, number>}
 */
export const ROLE_ORDER = {
  stylesheet: 0,
  'css-import': 1,
  icon: 2,
  'og-image': 3,
  image: 4,
  use: 5,
  font: 6,
  'css-url': 7,
  preload: 8,
};

/** Roles the page declares about itself in `<head>`, which may point off-origin. */
const HEAD_DECLARED = new Set(['icon', 'og-image']);

/** A response that is HTML where an asset was expected is an error page. */
const ASSET_ROLES_REJECTING_HTML = new Set(['stylesheet', 'css-import', 'icon', 'og-image', 'image', 'use', 'font', 'css-url', 'preload']);

// ---------------------------------------------------------------------------
// Candidate discovery
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Candidate
 * @property {string} ref        the reference exactly as the document wrote it
 * @property {string} url        resolved, absolute
 * @property {string} role
 * @property {number} order      document position, for a stable sort
 * @property {string|null} alt
 * @property {string|null} note  why this candidate rather than a sibling
 * @property {string[]} [refs]   every reference in the document that resolves here
 */

/**
 * Every sub-resource a document references, in fetch order.
 *
 * @param {DocNode} doc
 * @param {string|null} baseUrl
 * @returns {Candidate[]}
 */
export function subresourceCandidates(doc, baseUrl) {
  /** @type {Candidate[]} */
  const out = [];
  if (!doc) return out;

  // A `<base href>` changes what every relative reference resolves against.
  const baseEl = firstElement(doc, 'base');
  const declaredBase = baseEl ? attr(baseEl, 'href') : null;
  const base = (declaredBase && resolveUrl(baseUrl, declaredBase)) || baseUrl;

  // Document position, walked once. `order` must be the position in the source,
  // not the order the loops below happen to run in, or two references of the
  // same role would sort by which collector saw them first.
  /** @type {Map<DocNode, number>} */
  const positions = new Map();
  let position = 0;
  walk(doc, (node) => { if (node.type === 'element') positions.set(node, position++); });
  let synthetic = position;

  /**
   * @param {string|null} ref
   * @param {string} role
   * @param {{element?: DocNode|null, alt?: string|null, note?: string|null}} [extra]
   */
  const push = (ref, role, extra = {}) => {
    if (!ref) return;
    const trimmed = String(ref).trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    if (/^(data|blob|javascript|mailto|tel|about):/i.test(trimmed)) return;
    const url = resolveUrl(base, trimmed);
    if (!url || !/^https?:/i.test(url)) return;
    const element = extra.element || null;
    out.push({
      ref: trimmed,
      url,
      role,
      order: element && positions.has(element) ? /** @type {number} */ (positions.get(element)) : synthetic++,
      alt: extra.alt === undefined ? null : extra.alt,
      note: extra.note === undefined ? null : extra.note,
    });
  };

  for (const link of querySelectorAll(doc, 'link[href]')) {
    const rel = (attr(link, 'rel') || '').toLowerCase().split(/\s+/).filter(Boolean);
    const href = attr(link, 'href');
    if (rel.includes('stylesheet')) { push(href, 'stylesheet', { element: link }); continue; }
    if (rel.includes('icon') || rel.includes('shortcut') || rel.includes('apple-touch-icon') || rel.includes('mask-icon')) {
      push(href, 'icon', { element: link });
      continue;
    }
    if (rel.includes('preload')) {
      const as = (attr(link, 'as') || '').toLowerCase();
      if (as === 'style') push(href, 'stylesheet', { element: link });
      else if (as === 'font') push(href, 'font', { element: link });
      else if (as === 'image') push(href, 'preload', { element: link });
    }
  }

  for (const meta of querySelectorAll(doc, 'meta[content]')) {
    const key = (attr(meta, 'property') || attr(meta, 'name') || '').toLowerCase();
    if (key === 'og:image' || key === 'og:image:url' || key === 'og:image:secure_url'
      || key === 'twitter:image' || key === 'twitter:image:src') {
      push(attr(meta, 'content'), 'og-image', { element: meta });
    }
  }

  // A `<picture>` is a set of alternatives for one image, so it contributes one
  // candidate — the way a browser resolves it — rather than every variant.
  /** @type {Set<DocNode>} */
  const consumed = new Set();
  for (const picture of querySelectorAll(doc, 'picture')) {
    const img = querySelectorAll(picture, 'img')[0] || null;
    const alt = img ? attr(img, 'alt') : null;
    let chosen = false;
    for (const source of querySelectorAll(picture, 'source')) {
      consumed.add(source);
      if (chosen) continue;
      const srcset = attr(source, 'srcset');
      const picked = srcset ? pickFromSrcset(srcset) : null;
      const ref = picked ? picked.url : attr(source, 'src');
      if (!ref) continue;
      push(ref, 'image', { element: source, alt, note: picked ? picked.note : null });
      chosen = true;
    }
    if (img) {
      consumed.add(img);
      if (!chosen) {
        const srcset = attr(img, 'srcset');
        const picked = srcset ? pickFromSrcset(srcset) : null;
        push(picked ? picked.url : attr(img, 'src'), 'image', { element: img, alt, note: picked ? picked.note : null });
      }
    }
  }

  for (const img of querySelectorAll(doc, 'img')) {
    if (consumed.has(img)) continue;
    const alt = attr(img, 'alt');
    const srcset = attr(img, 'srcset') || attr(img, 'data-srcset');
    if (srcset) {
      const picked = pickFromSrcset(srcset);
      if (picked) { push(picked.url, 'image', { element: img, alt, note: picked.note }); continue; }
    }
    const src = attr(img, 'src') || attr(img, 'data-src') || attr(img, 'data-original') || attr(img, 'data-lazy-src');
    push(src, 'image', { element: img, alt });
  }

  for (const source of querySelectorAll(doc, 'video > source, audio > source')) {
    if (consumed.has(source)) continue;
    const srcset = attr(source, 'srcset');
    if (srcset) {
      const picked = pickFromSrcset(srcset);
      if (picked) { push(picked.url, 'image', { element: source, note: picked.note }); continue; }
    }
    push(attr(source, 'src'), 'image', { element: source });
  }

  for (const video of querySelectorAll(doc, 'video[poster]')) push(attr(video, 'poster'), 'image', { element: video });

  // SVG references: an external sprite, or an `<image>` inside inline SVG.
  for (const node of querySelectorAll(doc, 'use, image')) {
    const href = attr(node, 'href') || attr(node, 'xlink:href');
    if (!href) continue;
    push(String(href).split('#')[0], node.tag === 'use' ? 'use' : 'image', { element: node });
  }

  // Stable order: role first, then document position.
  out.sort((a, b) => (ROLE_ORDER[a.role] - ROLE_ORDER[b.role]) || (a.order - b.order));
  return dedupeCandidates(out);
}

/**
 * Choose one `srcset` candidate, and say why.
 *
 * The rule: the narrowest candidate that still covers the largest §4 breakpoint
 * (1600px), falling back to the widest available when none does, then to the
 * highest pixel density, then to the first listed. Picking the widest available
 * would pull a 4000px hero the emitter then has to spend its whole budget
 * degrading; picking the narrowest would starve the `lg` breakpoint.
 *
 * @param {string} srcset
 * @returns {{url: string, note: string}|null}
 */
export function pickFromSrcset(srcset) {
  /** @type {{url: string, w: number|null, x: number|null, index: number}[]} */
  const candidates = [];
  let index = 0;
  for (const part of String(srcset).split(',')) {
    const bits = part.trim().split(/\s+/).filter(Boolean);
    if (!bits.length) continue;
    const url = bits[0];
    if (!url) continue;
    let w = null;
    let x = null;
    for (const descriptor of bits.slice(1)) {
      const wMatch = descriptor.match(/^(\d+(?:\.\d+)?)w$/i);
      const xMatch = descriptor.match(/^(\d+(?:\.\d+)?)x$/i);
      if (wMatch) w = Number(wMatch[1]);
      else if (xMatch) x = Number(xMatch[1]);
    }
    candidates.push({ url, w, x, index: index++ });
  }
  if (!candidates.length) return null;
  const total = candidates.length;
  if (total === 1) return { url: candidates[0].url, note: 'the only srcset candidate' };

  const withWidth = candidates.filter((c) => c.w !== null);
  if (withWidth.length) {
    const covering = withWidth
      .filter((c) => /** @type {number} */ (c.w) >= SRCSET_TARGET_WIDTH)
      .sort((a, b) => (/** @type {number} */ (a.w) - /** @type {number} */ (b.w)) || (a.index - b.index));
    const chosen = covering.length
      ? covering[0]
      : withWidth.slice().sort((a, b) => (/** @type {number} */ (b.w) - /** @type {number} */ (a.w)) || (a.index - b.index))[0];
    return {
      url: chosen.url,
      note: `chose ${chosen.w}w of ${total} srcset candidates (narrowest covering ${SRCSET_TARGET_WIDTH}px)`,
    };
  }

  const withDensity = candidates.filter((c) => c.x !== null)
    .sort((a, b) => (/** @type {number} */ (b.x) - /** @type {number} */ (a.x)) || (a.index - b.index));
  if (withDensity.length) {
    return { url: withDensity[0].url, note: `chose ${withDensity[0].x}x of ${total} srcset candidates (highest density)` };
  }
  return { url: candidates[0].url, note: `chose the first of ${total} srcset candidates (no descriptors)` };
}

/**
 * Collapse candidates that resolve to the same URL, keeping the first — which
 * is the highest-priority role, since the list is already sorted.
 * @param {Candidate[]} candidates
 * @returns {Candidate[]}
 */
function dedupeCandidates(candidates) {
  /** @type {Map<string, Candidate>} */
  const seen = new Map();
  for (const candidate of candidates) {
    const existing = seen.get(candidate.url);
    if (!existing) {
      seen.set(candidate.url, { ...candidate, refs: [candidate.ref] });
      continue;
    }
    if (!existing.refs.includes(candidate.ref)) existing.refs.push(candidate.ref);
    if (existing.alt === null && candidate.alt !== null) existing.alt = candidate.alt;
    if (existing.note === null && candidate.note !== null) existing.note = candidate.note;
  }
  // The name a consumer will hold is the document's own reference, so prefer a
  // relative one: an `og:image` naming the same file absolutely should not
  // rename the asset that `<img src="/assets/hero.png">` points at.
  for (const candidate of seen.values()) {
    const relative = candidate.refs.find((r) => !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(r));
    if (relative) candidate.ref = relative;
  }
  return Array.from(seen.values());
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

/**
 * The `@import` targets and `url()` references inside a stylesheet.
 *
 * @param {string} css
 * @param {string} baseUrl   the stylesheet's own URL, which relative `url()`s resolve against
 * @returns {{imports: {ref: string, url: string}[], urls: {ref: string, url: string, font: boolean}[]}}
 */
export function cssReferences(css, baseUrl) {
  const source = String(css == null ? '' : css).replace(/\/\*[\s\S]*?\*\//g, ' ');
  /** @type {{ref: string, url: string}[]} */
  const imports = [];
  /** @type {{ref: string, url: string, font: boolean}[]} */
  const urls = [];

  const importRe = /@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]*))\s*\)|"([^"]*)"|'([^']*)')/gi;
  let m;
  while ((m = importRe.exec(source))) {
    const ref = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5];
    if (!ref) continue;
    const url = resolveUrl(baseUrl, ref);
    if (url && /^https?:/i.test(url)) imports.push({ ref, url });
  }

  // Font faces are worth knowing about separately: L5 will not embed a foundry
  // webfont into an artifact (§7), but knowing the file exists is what lets it
  // report `embeddable: false` honestly rather than silently.
  /** @type {Set<string>} */
  const fontUrls = new Set();
  const faceRe = /@font-face\s*\{([^}]*)\}/gi;
  let face;
  while ((face = faceRe.exec(source))) {
    const urlRe = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]*))\s*\)/gi;
    let inner;
    while ((inner = urlRe.exec(face[1]))) {
      const ref = inner[1] ?? inner[2] ?? inner[3];
      if (ref) fontUrls.add(ref.trim());
    }
  }

  const urlRe = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]*))\s*\)/gi;
  let u;
  /** @type {Set<string>} */
  const seen = new Set();
  while ((u = urlRe.exec(source))) {
    const ref = (u[1] ?? u[2] ?? u[3] ?? '').trim();
    if (!ref || ref.startsWith('#')) continue;
    if (/^(data|blob|about):/i.test(ref)) continue;
    if (seen.has(ref)) continue;
    seen.add(ref);
    // `@import url(...)` is handled above.
    if (imports.some((i) => i.ref === ref)) continue;
    const url = resolveUrl(baseUrl, ref);
    if (url && /^https?:/i.test(url)) urls.push({ ref, url, font: fontUrls.has(ref) });
  }
  return { imports, urls };
}

// ---------------------------------------------------------------------------
// Origin policy
// ---------------------------------------------------------------------------

/**
 * Two hosts belong to the same site when they are equal, or when one is the
 * other with `www.` removed, or when one is a subdomain of the other's
 * `www.`-stripped form — so a prospect's own `cdn.` and `assets.` hosts count
 * and an ad network does not.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function sameSite(a, b) {
  const hostA = String(a || '').toLowerCase();
  const hostB = String(b || '').toLowerCase();
  if (!hostA || !hostB) return false;
  if (hostA === hostB) return true;
  const rootA = hostA.replace(/^www\./, '');
  const rootB = hostB.replace(/^www\./, '');
  if (rootA === rootB) return true;
  return hostA.endsWith(`.${rootB}`) || hostB.endsWith(`.${rootA}`);
}

/**
 * May this candidate be fetched?
 *
 * Same-site by default. A resource the page declares about *itself* in `<head>`
 * — its icon, its `og:image` — is allowed off-origin, because naming it there
 * is the page being explicit, and those two are exactly what the brand engine
 * needs when a prospect serves its logo from a CDN. Everything else off-origin
 * is skipped and reported rather than fetched quietly.
 *
 * @param {Candidate} candidate
 * @param {{host: string, robots: any, limits: SubresourceLimits}} context
 * @returns {{allowed: boolean, reason: string}}
 */
export function candidateAllowed(candidate, context) {
  let host = '';
  try { host = new URL(candidate.url).host.toLowerCase(); } catch { return { allowed: false, reason: 'bad-url' }; }

  const allowedHost = sameSite(host, context.host)
    || context.limits.allowHosts.some((h) => sameSite(host, String(h).toLowerCase()))
    || HEAD_DECLARED.has(candidate.role);
  if (!allowedHost) return { allowed: false, reason: 'cross-origin' };

  if (context.limits.respectRobots && sameSite(host, context.host) && !robotsAllows(context.robots, candidate.url)) {
    return { allowed: false, reason: 'robots' };
  }
  return { allowed: true, reason: '' };
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

/**
 * @typedef {object} SubresourceReport
 * @property {number} requested
 * @property {number} fetched
 * @property {number} bytes
 * @property {number} stylesheets
 * @property {{url: string, ref: string, role: string, reason: string, status?: number, bytes?: number}[]} skipped
 * @property {string|null} capped     'count' | 'bytes' when a limit stopped collection
 * @property {string[]} notes
 */

/**
 * Race a promise against a timer, so one unresponsive host cannot hang an
 * ingest. No clock is read: `setTimeout` is a scheduler, not a time source.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {() => void} [onTimeout]
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, onTimeout) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (onTimeout) { try { onTimeout(); } catch { /* an abort that throws is still a timeout */ } }
      reject(new Error('timeout'));
    }, ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/**
 * Fetch one candidate through the injected transport.
 * @param {Candidate} candidate
 * @param {(url: string, init?: object) => Promise<any>} fetchUrl
 * @param {SubresourceLimits} limits
 * @returns {Promise<{ok: true, bytes: Uint8Array, mime: string} | {ok: false, reason: string, status?: number, bytes?: number}>}
 */
async function fetchCandidate(candidate, fetchUrl, limits) {
  /** @type {AbortController|null} */
  let controller = null;
  try {
    if (typeof AbortController === 'function') controller = new AbortController();
  } catch { controller = null; }

  /** @type {any} */
  let res;
  try {
    const request = fetchUrl(candidate.url, controller ? { method: 'GET', signal: controller.signal } : { method: 'GET' });
    res = await withTimeout(Promise.resolve(request), limits.timeoutMs, () => { if (controller) controller.abort(); });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: message === 'timeout' ? 'timeout' : 'unreachable' };
  }
  if (!res || !res.ok) {
    const status = res && typeof res.status === 'number' ? res.status : 0;
    return { ok: false, reason: status === 404 ? 'not-found' : 'http-error', status };
  }

  /** @type {Uint8Array} */
  let bytes;
  try {
    if (typeof res.bytes === 'function') bytes = await withTimeout(Promise.resolve(res.bytes()), limits.timeoutMs);
    else if (typeof res.text === 'function') bytes = new TextEncoder().encode(await withTimeout(Promise.resolve(res.text()), limits.timeoutMs));
    else return { ok: false, reason: 'no-body' };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes || []);
  if (!bytes.length) return { ok: false, reason: 'empty' };
  if (bytes.length > limits.maxBytesPerResource) return { ok: false, reason: 'oversize', bytes: bytes.length };

  const declared = headerContentType(res);
  const mime = resolveMime(declared, bytes, candidate);
  if (ASSET_ROLES_REJECTING_HTML.has(candidate.role) && mime === 'text/html') {
    // A 200 that is really an error page. Keeping it would put an HTML
    // document behind an `<img src>` and call it a capture.
    return { ok: false, reason: 'wrong-type' };
  }
  return { ok: true, bytes, mime };
}

/**
 * @param {any} res
 * @returns {string}
 */
function headerContentType(res) {
  const headers = res && res.headers;
  if (!headers) return '';
  try {
    if (typeof headers.get === 'function') return String(headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const direct = headers['content-type'] || headers['Content-Type'];
    if (direct) return String(direct).split(';')[0].trim().toLowerCase();
  } catch { /* a hostile header bag is not worth an exception */ }
  return '';
}

/**
 * The MIME to record. A declared type is trusted for text formats, where bytes
 * are ambiguous; sniffing wins for everything else, where bytes are definitive.
 * @param {string} declared
 * @param {Uint8Array} bytes
 * @param {Candidate} candidate
 * @returns {string}
 */
function resolveMime(declared, bytes, candidate) {
  const sniffed = sniffMime(bytes, candidate.url);
  if (candidate.role === 'stylesheet' || candidate.role === 'css-import') {
    // A stylesheet is text; sniffing cannot tell CSS from anything else, and a
    // host that mislabels it as `text/plain` is still serving CSS.
    return looksLikeHtml(bytes) ? 'text/html' : 'text/css';
  }
  if (declared && declared !== 'application/octet-stream' && declared !== 'binary/octet-stream') {
    if (declared.startsWith('image/') && sniffed.startsWith('image/')) return sniffed;
    return declared;
  }
  return sniffed;
}

/**
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
function looksLikeHtml(bytes) {
  const head = asciiHead(bytes, 256).trimStart().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<head');
}

/**
 * Collect a document's sub-resources.
 *
 * @param {object} options
 * @param {DocNode} options.doc
 * @param {string} options.baseUrl
 * @param {(url: string, init?: object) => Promise<any>} options.fetchUrl
 * @param {any} [options.robots]
 * @param {Partial<SubresourceLimits>} [options.limits]
 * @returns {Promise<{assets: CaptureAsset[], report: SubresourceReport}>}
 */
export async function collectSubresources(options) {
  /** @type {SubresourceLimits} */
  const limits = { ...SUBRESOURCE_LIMITS, ...(options.limits || {}) };
  /** @type {SubresourceReport} */
  const report = { requested: 0, fetched: 0, bytes: 0, stylesheets: 0, skipped: [], capped: null, notes: [] };
  /** @type {CaptureAsset[]} */
  const assets = [];

  if (!options.doc || typeof options.fetchUrl !== 'function') return { assets, report };
  let host = '';
  try { host = new URL(options.baseUrl).host.toLowerCase(); } catch { host = ''; }

  const context = { host, robots: options.robots || null, limits };
  /** @type {Candidate[]} */
  let queue = subresourceCandidates(options.doc, options.baseUrl);
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {Candidate[]} */
  const tail = [];
  let cssDepth = 0;

  /** @param {Candidate} candidate @param {string} reason @param {object} [extra] */
  const skip = (candidate, reason, extra = {}) => {
    report.skipped.push({ url: candidate.url, ref: candidate.ref, role: candidate.role, reason, ...extra });
  };

  while (queue.length) {
    /** @type {Candidate[]} */
    const nextRound = [];

    for (let i = 0; i < queue.length; i += Math.max(1, limits.concurrency)) {
      const wave = queue.slice(i, i + Math.max(1, limits.concurrency));
      /** @type {{candidate: Candidate, gate: {allowed: boolean, reason: string}, result: any}[]} */
      const outcomes = [];

      // Fetch the wave in parallel, then fold it in candidate order. The order
      // of `assets[]` and of the budget decisions therefore depends only on the
      // document, never on which response happened to arrive first.
      await Promise.all(wave.map(async (candidate) => {
        if (seen.has(candidate.url)) { outcomes.push({ candidate, gate: { allowed: false, reason: 'duplicate' }, result: null }); return; }
        const gate = candidateAllowed(candidate, context);
        if (!gate.allowed) { outcomes.push({ candidate, gate, result: null }); return; }
        const result = await fetchCandidate(candidate, options.fetchUrl, limits);
        outcomes.push({ candidate, gate, result });
      }));

      outcomes.sort((a, b) => wave.indexOf(a.candidate) - wave.indexOf(b.candidate));

      for (const outcome of outcomes) {
        const { candidate, gate, result } = outcome;
        if (seen.has(candidate.url) && gate.reason === 'duplicate') continue;
        seen.add(candidate.url);

        if (!gate.allowed) { skip(candidate, gate.reason); continue; }

        if (report.requested >= limits.maxCount) {
          report.capped = report.capped || 'count';
          skip(candidate, 'count-cap');
          continue;
        }
        report.requested += 1;

        if (!result || !result.ok) {
          skip(candidate, result ? result.reason : 'unreachable', result && result.status !== undefined ? { status: result.status } : (result && result.bytes !== undefined ? { bytes: result.bytes } : {}));
          continue;
        }
        if (report.bytes + result.bytes.length > limits.maxTotalBytes) {
          report.capped = report.capped || 'bytes';
          skip(candidate, 'byte-cap', { bytes: result.bytes.length });
          continue;
        }

        report.fetched += 1;
        report.bytes += result.bytes.length;
        assets.push(buildAsset(candidate, result));

        if (candidate.role === 'stylesheet' || candidate.role === 'css-import') {
          report.stylesheets += 1;
          const css = new TextDecoder().decode(result.bytes);
          const refs = cssReferences(css, candidate.url);
          if (cssDepth < limits.maxCssDepth) {
            for (const entry of refs.imports) {
              if (seen.has(entry.url)) continue;
              nextRound.push({ ref: entry.ref, url: entry.url, role: 'css-import', order: nextRound.length, alt: null, note: `@import from ${candidate.ref}` });
            }
          } else if (refs.imports.length) {
            report.notes.push(`@import depth limit (${limits.maxCssDepth}) reached in ${candidate.ref}`);
          }
          for (const entry of refs.urls) {
            if (seen.has(entry.url)) continue;
            tail.push({
              ref: entry.ref,
              url: entry.url,
              role: entry.font ? 'font' : 'css-url',
              order: tail.length,
              alt: null,
              note: `url() in ${candidate.ref}`,
            });
          }
        }
      }
      if (report.capped === 'count') break;
    }

    cssDepth += 1;
    queue = report.capped === 'count' ? [] : nextRound;
  }

  // CSS-discovered resources last: fonts and background images matter, but not
  // more than the stylesheet and the logo they sit behind.
  if (report.capped !== 'count' && tail.length) {
    const ordered = tail.slice().sort((a, b) => (ROLE_ORDER[a.role] - ROLE_ORDER[b.role]) || (a.order - b.order));
    for (let i = 0; i < ordered.length; i += Math.max(1, limits.concurrency)) {
      const wave = ordered.slice(i, i + Math.max(1, limits.concurrency));
      /** @type {{candidate: Candidate, gate: any, result: any}[]} */
      const outcomes = [];
      await Promise.all(wave.map(async (candidate) => {
        if (seen.has(candidate.url)) { outcomes.push({ candidate, gate: { allowed: false, reason: 'duplicate' }, result: null }); return; }
        const gate = candidateAllowed(candidate, context);
        if (!gate.allowed) { outcomes.push({ candidate, gate, result: null }); return; }
        outcomes.push({ candidate, gate, result: await fetchCandidate(candidate, options.fetchUrl, limits) });
      }));
      outcomes.sort((a, b) => wave.indexOf(a.candidate) - wave.indexOf(b.candidate));

      let stop = false;
      for (const { candidate, gate, result } of outcomes) {
        if (seen.has(candidate.url) && gate.reason === 'duplicate') continue;
        seen.add(candidate.url);
        if (!gate.allowed) { skip(candidate, gate.reason); continue; }
        if (report.requested >= limits.maxCount) { report.capped = report.capped || 'count'; skip(candidate, 'count-cap'); stop = true; continue; }
        report.requested += 1;
        if (!result || !result.ok) {
          skip(candidate, result ? result.reason : 'unreachable', result && result.status !== undefined ? { status: result.status } : (result && result.bytes !== undefined ? { bytes: result.bytes } : {}));
          continue;
        }
        if (report.bytes + result.bytes.length > limits.maxTotalBytes) {
          report.capped = report.capped || 'bytes';
          skip(candidate, 'byte-cap', { bytes: result.bytes.length });
          continue;
        }
        report.fetched += 1;
        report.bytes += result.bytes.length;
        assets.push(buildAsset(candidate, result));
      }
      if (stop) break;
    }
  }

  return { assets, report };
}

/**
 * The asset record.
 *
 * `name` is the reference **exactly as the document wrote it**, because that is
 * what both consumers key on: L5's `indexAssets` resolves `<img src>` through
 * it, and L6's `imageHints` is keyed by the same string. `aliases` carries the
 * absolute URL, the path, and the bare filename so a consumer holding any of
 * those still finds the bytes.
 *
 * @param {Candidate} candidate
 * @param {{bytes: Uint8Array, mime: string}} result
 * @returns {CaptureAsset}
 */
function buildAsset(candidate, result) {
  let path = candidate.url;
  try { path = new URL(candidate.url).pathname; } catch { /* keep the URL */ }
  const basename = path.split('/').filter(Boolean).pop() || path;
  const aliases = Array.from(new Set([
    ...(candidate.refs || []),
    candidate.url,
    path,
    normalizeAssetRef(candidate.ref),
    basename,
  ])).filter((a) => a && a !== candidate.ref);

  /** @type {any} */
  const asset = {
    name: candidate.ref,
    bytes: result.bytes,
    mime: result.mime,
    aliases,
    url: candidate.url,
    src: candidate.ref,
    role: candidate.role,
  };
  if (candidate.alt) asset.alt = candidate.alt;
  if (candidate.note) asset.note = candidate.note;
  return asset;
}

/**
 * Fold a collection report into a capture: namespaced `meta` strings for
 * anything that reads strings, and the structured report for anything that
 * wants the detail.
 *
 * @param {import('./capture.js').RawCapture} capture
 * @param {SubresourceReport} report
 * @returns {import('./capture.js').RawCapture}
 */
export function applySubresourceReport(capture, report) {
  capture.meta['subresources.requested'] = String(report.requested);
  capture.meta['subresources.fetched'] = String(report.fetched);
  capture.meta['subresources.bytes'] = String(report.bytes);
  capture.meta['subresources.stylesheets'] = String(report.stylesheets);
  if (report.skipped.length) {
    capture.meta['subresources.skipped'] = String(report.skipped.length);
    /** @type {Map<string, number>} */
    const byReason = new Map();
    for (const entry of report.skipped) byReason.set(entry.reason, (byReason.get(entry.reason) || 0) + 1);
    capture.meta['subresources.skippedReasons'] = Array.from(byReason.entries())
      .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))
      .map(([reason, count]) => `${reason}×${count}`)
      .join(', ');
    capture.meta['subresources.skippedDetail'] = report.skipped
      .slice(0, 12)
      .map((entry) => `${entry.reason}: ${entry.ref}`)
      .join(' | ');
  }
  if (report.capped) capture.meta['subresources.capped'] = report.capped;
  if (report.notes.length) capture.meta['subresources.notes'] = report.notes.slice(0, 6).join(' | ');
  // The structured report, for a studio that wants to list what it could not
  // get rather than parse a string.
  /** @type {any} */ (capture).subresources = report;
  return capture;
}
