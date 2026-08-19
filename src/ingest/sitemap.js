/**
 * Sitemap assist (§6).
 *
 * Once any fetch strategy works, the fastest way to a good proof is to point
 * the seller at the four or five pages that will actually carry a scene. §6 is
 * explicit about how to choose them: **rank by structural richness, not by
 * position.** A sitemap lists the home page first because it is a sitemap, not
 * because the home page is the most useful specimen.
 *
 * So the ranker scores each candidate on signals that correlate with a page
 * having real content — slug specificity, path depth, declared alternates,
 * relative freshness — and then *diversifies*: the head of the list is one home
 * page, one product/PDP, one article and one locale variant, because those four
 * are what the scenario library needs, and four articles is a worse starting
 * set than four different kinds of page.
 *
 * @module ingest/sitemap
 */

import { ok, err } from '../core/result.js';
import { inflateRaw } from '../core/inflate.js';
import { originOf, resolveUrl } from './capture.js';
import { parseRobots } from './robots.js';

/**
 * @typedef {object} SitemapEntry
 * @property {string} url
 * @property {string|null} lastmod
 * @property {string|null} changefreq
 * @property {number|null} priority
 * @property {{hreflang: string, href: string}[]} alternates
 * @property {string} source        the sitemap the entry came from
 * @property {'home'|'product'|'article'|'locale'|'category'|'other'} kind
 * @property {number} depth
 * @property {string} slug
 * @property {number} score
 * @property {Record<string, number>} signals
 */

/** Ranking order for the diversified head of the list. §6 names these four. */
export const KIND_PRIORITY = ['home', 'product', 'article', 'locale', 'category', 'other'];

const MAX_SITEMAPS = 8;
const MAX_ENTRIES = 5000;

/**
 * Discover a site's sitemap through `/robots.txt` and the conventional paths,
 * following sitemap indexes one level down.
 *
 * @param {string} base            any URL on the site
 * @param {{http?: (url: string, init?: object) => Promise<any>}} deps
 * @returns {Promise<import('../core/result.js').Result<SitemapEntry[]>>}
 */
export async function discoverSitemap(base, deps = /** @type {any} */ ({})) {
  const origin = originOf(base) || originOf(`https://${base}`);
  if (!origin) return err(`"${base}" is not a URL I can look for a sitemap on.`);
  if (typeof deps.http !== 'function') {
    return err('No network transport is configured, so sitemap discovery was skipped. Import pages directly instead.');
  }

  /** @type {string[]} */
  const candidates = [];
  /** @type {string[]} */
  const notes = [];

  const robotsText = await fetchText(deps.http, `${origin}/robots.txt`);
  if (robotsText !== null) {
    for (const declared of parseRobots(robotsText).sitemaps) {
      const url = resolveUrl(origin, declared);
      if (url && !candidates.includes(url)) candidates.push(url);
    }
    if (!candidates.length) notes.push('robots.txt named no sitemap');
  } else {
    notes.push('robots.txt was not readable');
  }

  for (const path of ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml', '/sitemap/sitemap.xml']) {
    const url = `${origin}${path}`;
    if (!candidates.includes(url)) candidates.push(url);
  }

  /** @type {SitemapEntry[]} */
  const entries = [];
  /** @type {Set<string>} */
  const fetched = new Set();
  /** @type {string[]} */
  let queue = candidates.slice();
  let depth = 0;

  while (queue.length && fetched.size < MAX_SITEMAPS && depth < 3) {
    /** @type {string[]} */
    const next = [];
    for (const url of queue) {
      if (fetched.size >= MAX_SITEMAPS) break;
      if (fetched.has(url)) continue;
      fetched.add(url);
      const xml = await fetchSitemapText(deps.http, url);
      if (xml === null) continue;
      const parsed = parseSitemap(xml, url);
      if (parsed.kind === 'index') {
        for (const child of parsed.sitemaps) if (!fetched.has(child)) next.push(child);
      } else {
        for (const entry of parsed.entries) {
          if (entries.length >= MAX_ENTRIES) break;
          entries.push(entry);
        }
      }
    }
    queue = next;
    depth += 1;
  }

  if (!entries.length) {
    return err(
      `No sitemap was readable for ${origin}. ${notes.join('; ') || 'Nothing answered at the usual paths.'} You can still add pages by URL, or import them from files.`,
      { tried: Array.from(fetched) },
    );
  }
  return ok(rankCandidates(entries));
}

/**
 * @param {(url: string, init?: object) => Promise<any>} http
 * @param {string} url
 * @returns {Promise<string|null>}
 */
async function fetchText(http, url) {
  try {
    const res = await http(url, { method: 'GET' });
    if (!res || !res.ok) return null;
    if (typeof res.text === 'function') return await res.text();
    if (typeof res.bytes === 'function') return new TextDecoder().decode(await res.bytes());
    return null;
  } catch {
    return null;
  }
}

/**
 * Fetch a sitemap, transparently un-gzipping `.xml.gz`, which is what large
 * sites serve.
 * @param {(url: string, init?: object) => Promise<any>} http
 * @param {string} url
 * @returns {Promise<string|null>}
 */
async function fetchSitemapText(http, url) {
  if (!/\.gz(\?|$)/i.test(url)) return fetchText(http, url);
  try {
    const res = await http(url, { method: 'GET' });
    if (!res || !res.ok || typeof res.bytes !== 'function') return null;
    const bytes = await res.bytes();
    const plain = gunzip(bytes);
    return plain ? new TextDecoder().decode(plain) : null;
  } catch {
    return null;
  }
}

/**
 * Strip a gzip wrapper and inflate the DEFLATE stream inside it.
 * @param {Uint8Array} bytes
 * @returns {Uint8Array|null}
 */
export function gunzip(bytes) {
  if (!bytes || bytes.length < 18 || bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 8) return null;
  const flags = bytes[3];
  let at = 10;
  if (flags & 4) { at += 2 + (bytes[at] | (bytes[at + 1] << 8)); }          // FEXTRA
  if (flags & 8) { while (at < bytes.length && bytes[at] !== 0) at += 1; at += 1; }   // FNAME
  if (flags & 16) { while (at < bytes.length && bytes[at] !== 0) at += 1; at += 1; }  // FCOMMENT
  if (flags & 2) at += 2;                                                   // FHCRC
  try {
    return inflateRaw(bytes.subarray(at, bytes.length - 8));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a sitemap or a sitemap index.
 *
 * @param {string} xml
 * @param {string} source
 * @returns {{kind: 'index', sitemaps: string[], entries: SitemapEntry[]} | {kind: 'urlset', sitemaps: string[], entries: SitemapEntry[]}}
 */
export function parseSitemap(xml, source = '') {
  const text = String(xml || '');
  const isIndex = /<sitemapindex[\s>]/i.test(text);
  /** @type {string[]} */
  const sitemaps = [];
  /** @type {SitemapEntry[]} */
  const entries = [];

  if (isIndex) {
    const re = /<sitemap\b[\s\S]*?<\/sitemap>/gi;
    let m;
    while ((m = re.exec(text))) {
      const loc = firstTag(m[0], 'loc');
      if (loc) {
        const url = resolveUrl(source || null, loc) || loc;
        if (!sitemaps.includes(url)) sitemaps.push(url);
      }
    }
    return { kind: 'index', sitemaps, entries };
  }

  const re = /<url\b[\s\S]*?<\/url>/gi;
  let m;
  while ((m = re.exec(text))) {
    const block = m[0];
    const loc = firstTag(block, 'loc');
    if (!loc) continue;
    const url = resolveUrl(source || null, loc) || loc;
    const priorityText = firstTag(block, 'priority');
    const priority = priorityText === null ? null : Number(priorityText);
    /** @type {{hreflang: string, href: string}[]} */
    const alternates = [];
    const linkRe = /<xhtml:link\b([^>]*)\/?>|<link\b([^>]*)\/?>/gi;
    let link;
    while ((link = linkRe.exec(block))) {
      const attrs = link[1] || link[2] || '';
      const rel = (attrs.match(/rel\s*=\s*"([^"]*)"/i) || attrs.match(/rel\s*=\s*'([^']*)'/i) || [])[1];
      if (!rel || rel.toLowerCase() !== 'alternate') continue;
      const hreflang = (attrs.match(/hreflang\s*=\s*"([^"]*)"/i) || attrs.match(/hreflang\s*=\s*'([^']*)'/i) || [])[1];
      const href = (attrs.match(/href\s*=\s*"([^"]*)"/i) || attrs.match(/href\s*=\s*'([^']*)'/i) || [])[1];
      if (hreflang && href) alternates.push({ hreflang: hreflang.toLowerCase(), href });
    }
    entries.push(makeEntry({
      url,
      lastmod: firstTag(block, 'lastmod'),
      changefreq: firstTag(block, 'changefreq'),
      priority: priority !== null && Number.isFinite(priority) ? priority : null,
      alternates,
      source,
    }));
    if (entries.length >= MAX_ENTRIES) break;
  }
  return { kind: 'urlset', sitemaps, entries };
}

/**
 * @param {string} block
 * @param {string} tag
 * @returns {string|null}
 */
function firstTag(block, tag) {
  const m = block.match(new RegExp(`<(?:[a-zA-Z0-9]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[a-zA-Z0-9]+:)?${tag}>`, 'i'));
  if (!m) return null;
  const value = m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
  return value || null;
}

/**
 * Build an entry with its structural facts already computed.
 * @param {{url: string, lastmod?: string|null, changefreq?: string|null, priority?: number|null, alternates?: {hreflang: string, href: string}[], source?: string}} parts
 * @returns {SitemapEntry}
 */
export function makeEntry(parts) {
  const url = parts.url;
  const path = pathSegments(url);
  const slug = path.length ? path[path.length - 1] : '';
  return {
    url,
    lastmod: parts.lastmod || null,
    changefreq: parts.changefreq || null,
    priority: parts.priority === undefined ? null : parts.priority,
    alternates: parts.alternates || [],
    source: parts.source || '',
    kind: classify(url, path, parts.alternates || []),
    depth: path.length,
    slug,
    score: 0,
    signals: {},
  };
}

/**
 * @param {string} url
 * @returns {string[]}
 */
function pathSegments(url) {
  let pathname = url;
  try { pathname = new URL(url).pathname; } catch { pathname = String(url).split(/[?#]/)[0]; }
  return pathname.split('/').filter(Boolean);
}

/** Two-letter language, optionally with a region: `de`, `de-DE`, `pt_BR`. */
const LOCALE_SEGMENT = /^[a-z]{2}([-_][a-zA-Z]{2,4})?$/;

const PRODUCT_HINT = /^(products?|p|shop|store|items?|sku|catalog|catalogue|buy|collections?)$/i;
const ARTICLE_HINT = /^(blog|news|articles?|insights?|stories|story|press|posts?|resources?|library|case-studies|case-study|customers?|guides?|research|reports?)$/i;
const CATEGORY_HINT = /^(category|categories|solutions?|industries|services|platform|use-cases?|sectors?|topics?)$/i;

/**
 * Classify a URL by what kind of specimen it would make.
 * @param {string} url
 * @param {string[]} path
 * @param {{hreflang: string, href: string}[]} alternates
 * @returns {'home'|'product'|'article'|'locale'|'category'|'other'}
 */
export function classify(url, path = pathSegments(url), alternates = []) {
  const segments = path.filter((s) => !/^index\.(html?|php|aspx?)$/i.test(s));
  const localePrefix = segments.length && LOCALE_SEGMENT.test(segments[0]) ? segments[0] : null;
  const rest = localePrefix ? segments.slice(1) : segments;

  if (!rest.length) return localePrefix ? 'locale' : 'home';

  const hasDate = rest.some((s) => /^(19|20)\d{2}$/.test(s));
  for (const segment of rest) {
    if (PRODUCT_HINT.test(segment)) return localePrefix ? 'locale' : 'product';
  }
  for (const segment of rest) {
    if (ARTICLE_HINT.test(segment)) return localePrefix ? 'locale' : 'article';
  }
  if (hasDate) return localePrefix ? 'locale' : 'article';
  if (localePrefix) return 'locale';
  for (const segment of rest) {
    if (CATEGORY_HINT.test(segment)) return 'category';
  }
  // A single deep segment with a wordy slug reads as an article; a shallow one
  // reads as a section.
  if (rest.length === 1) return slugWords(rest[0]) >= 3 ? 'article' : 'category';
  if (alternates.length >= 2) return 'locale';
  return 'other';
}

/**
 * @param {string} slug
 * @returns {number}
 */
function slugWords(slug) {
  const stem = String(slug).replace(/\.(html?|php|aspx?)$/i, '');
  return stem.split(/[-_]+/).filter(Boolean).length;
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

const CHANGEFREQ_WEIGHT = {
  always: 0.2, hourly: 0.4, daily: 0.8, weekly: 1, monthly: 0.8, yearly: 0.4, never: 0.2,
};

/**
 * Score one entry on structural richness. Every term is a property of the URL
 * or of the sitemap record — never of where it appeared in the file.
 *
 * @param {SitemapEntry} entry
 * @param {{newest: number, oldest: number}} freshness
 * @returns {SitemapEntry}
 */
export function scoreEntry(entry, freshness) {
  /** @type {Record<string, number>} */
  const signals = {};

  // A wordy slug is the strongest single predictor of a page with real copy.
  const words = slugWords(entry.slug);
  signals.slugWords = Math.min(words, 8) / 8;

  // Depth 1–3 is the sweet spot: deep enough to be a real page, shallow enough
  // not to be a filtered listing.
  const depth = entry.depth;
  signals.depth = depth === 0 ? 0.55 : depth <= 3 ? 1 - Math.abs(2 - depth) * 0.12 : Math.max(0, 0.76 - (depth - 3) * 0.18);

  // Declared alternates mean the site is genuinely localized, which is exactly
  // the evidence the locale-fanout scenario needs.
  signals.alternates = Math.min(entry.alternates.length, 9) / 9;

  // Freshness is relative, and computed without a clock: a `lastmod` is ranked
  // against the other entries in the same sitemap (§5 forbids reading the wall
  // clock, and a relative comparison is the honest question anyway).
  const stamp = parseStamp(entry.lastmod);
  if (stamp !== null && freshness.newest > freshness.oldest) {
    signals.freshness = (stamp - freshness.oldest) / (freshness.newest - freshness.oldest);
  } else {
    signals.freshness = stamp !== null ? 0.5 : 0.25;
  }

  // Self-declared hints. Weighted lightly on purpose: they are the site's
  // opinion, not evidence.
  signals.priority = entry.priority === null ? 0.5 : Math.max(0, Math.min(1, entry.priority));
  signals.changefreq = entry.changefreq
    ? (CHANGEFREQ_WEIGHT[entry.changefreq.toLowerCase()] ?? 0.5)
    : 0.5;

  // Penalties for URLs that will not make a good specimen.
  let penalty = 0;
  if (/\?/.test(entry.url)) penalty += 0.25;
  if (/\/(page|p)\/\d+\/?$/i.test(entry.url) || /[?&]page=\d+/i.test(entry.url)) penalty += 0.45;
  if (/\.(pdf|xml|json|jpe?g|png|gif|zip|csv)$/i.test(entry.url.split(/[?#]/)[0])) penalty += 0.5;
  if (/\/(tag|tags|author|search|cart|checkout|account|login|feed|amp)\//i.test(entry.url)) penalty += 0.35;
  if (depth > 6) penalty += 0.3;
  signals.penalty = penalty;

  const score = 0.34 * signals.slugWords
    + 0.24 * signals.depth
    + 0.14 * signals.alternates
    + 0.14 * signals.freshness
    + 0.07 * signals.priority
    + 0.07 * signals.changefreq
    - penalty;

  entry.signals = signals;
  entry.score = Math.round(score * 10000) / 10000;
  return entry;
}

/**
 * @param {string|null} value
 * @returns {number|null}
 */
function parseStamp(value) {
  if (!value) return null;
  // W3C datetime, compared lexicographically after normalisation — no clock,
  // no `Date` construction (§5).
  const m = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return Number(y) * 1e10 + Number(mo) * 1e8 + Number(d) * 1e6
    + Number(h || 0) * 1e4 + Number(mi || 0) * 1e2 + Number(s || 0);
}

/**
 * Rank candidates by structural richness, then diversify.
 *
 * The result is deterministic: entries with equal scores fall back to URL
 * order, so two runs over the same sitemap suggest the same pages.
 *
 * @param {SitemapEntry[]} entries
 * @returns {SitemapEntry[]}
 */
export function rankCandidates(entries) {
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && e.url);
  if (!list.length) return [];

  const stamps = list.map((e) => parseStamp(e.lastmod)).filter((s) => s !== null);
  const freshness = {
    newest: stamps.length ? Math.max(...stamps) : 0,
    oldest: stamps.length ? Math.min(...stamps) : 0,
  };
  for (const entry of list) scoreEntry(entry, freshness);

  /** @type {Map<string, SitemapEntry[]>} */
  const byKind = new Map();
  for (const entry of list) {
    const bucket = byKind.get(entry.kind) || [];
    bucket.push(entry);
    byKind.set(entry.kind, bucket);
  }
  for (const bucket of byKind.values()) {
    bucket.sort((a, b) => (b.score - a.score) || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  }

  /** @type {SitemapEntry[]} */
  const out = [];
  /** @type {Set<SitemapEntry>} */
  const taken = new Set();

  // Round-robin across kinds in §6's order, so the head of the list covers a
  // home page, a product, an article and a locale variant before it offers a
  // second of anything.
  let progress = true;
  while (progress) {
    progress = false;
    for (const kind of KIND_PRIORITY) {
      const bucket = byKind.get(kind);
      if (!bucket) continue;
      const next = bucket.find((e) => !taken.has(e));
      if (!next) continue;
      taken.add(next);
      out.push(next);
      progress = true;
    }
  }
  return out;
}

/**
 * The suggestion set a studio would show first: the best of each kind, in §6's
 * order, capped.
 * @param {SitemapEntry[]} ranked
 * @param {number} [limit]
 * @returns {SitemapEntry[]}
 */
export function topSuggestions(ranked, limit = 6) {
  return ranked.slice(0, Math.max(1, limit));
}
