/**
 * `SpecimenKind` inference (§4, §8).
 *
 * Four sources of evidence, scored rather than chained so that one weak hint
 * cannot override a strong one:
 *
 *   - schema.org markup: JSON-LD `@type`, microdata `itemtype`, RDFa `typeof`;
 *   - Open Graph `og:type`;
 *   - URL shape (`/blog/`, `/products/`, `/lp/`, `.pdf`);
 *   - page structure (a single `<article>` with a byline; a price and an
 *     add-to-cart control; a page that is one hero and one form).
 *
 * The capture's own kind wins outright when ingest already knows the answer:
 * an imported `.docx` is a `document` and an imported `.png` is an `image`, and
 * no amount of markup should talk us out of that.
 */

import { attrOf, byTag, childrenOf, elements, firstElement, isElement, tagOf, textOf } from './dom.js';

/** @typedef {'page'|'article'|'product'|'campaign'|'document'|'image'|'fragment'} SpecimenKind */

const SCHEMA_KIND = [
  [/\b(product|productmodel|individualproduct|productgroup|offer|vehicle|softwareapplication|book|movie)\b/i, 'product'],
  [/\b(article|newsarticle|blogposting|report|techarticle|scholarlyarticle|liveblogposting|socialmediaposting|review)\b/i, 'article'],
  [/\b(specialannouncement|event|promotion|discount|campaign)\b/i, 'campaign'],
  [/\b(digitaldocument|presentationdigitaldocument|textdigitaldocument|spreadsheetdigitaldocument|datasheet|manual|howto)\b/i, 'document'],
  [/\b(imageobject|photograph)\b/i, 'image'],
  [/\b(webpage|collectionpage|itempage|aboutpage|contactpage|faqpage|profilepage|searchresultspage|website|organization)\b/i, 'page'],
];

const OG_KIND = [
  [/^product/i, 'product'],
  [/^article$/i, 'article'],
  [/^book$/i, 'document'],
  [/^(video|music)\./i, 'page'],
  [/^website$/i, 'page'],
  [/^profile$/i, 'page'],
];

const URL_KIND = [
  [/\.(pdf|docx?|pptx?|xlsx?)($|[?#])/i, 'document'],
  [/\.(png|jpe?g|gif|webp|svg|avif)($|[?#])/i, 'image'],
  [/\/(blog|news|article|articles|insights|stories|story|press|newsroom|resources\/blog)\//i, 'article'],
  [/\/(product|products|p|sku|shop|store|item|catalog)\//i, 'product'],
  [/\/(lp|landing|campaign|campaigns|promo|promotion|offer|offers|get|try|demo|webinar)\//i, 'campaign'],
  // Documentation and support pages are marked up as `<article>` constantly;
  // the URL is the better witness for what they are.
  [/\/(docs|documentation|reference|guides?|manual|support|help)\//i, 'page'],
];

/**
 * Every `@type` mentioned by the page's structured data.
 * @param {any} doc
 * @returns {string[]}
 */
export function schemaTypes(doc) {
  /** @type {string[]} */
  const types = [];
  if (!doc) return types;
  for (const el of elements(doc)) {
    const itemtype = attrOf(el, 'itemtype');
    if (itemtype) types.push(...itemtype.split(/\s+/).map((t) => t.split(/[/#]/).pop() || ''));
    const typeOf = attrOf(el, 'typeof');
    if (typeOf) types.push(...typeOf.split(/\s+/));
    if (tagOf(el) !== 'script') continue;
    const type = (attrOf(el, 'type') || '').toLowerCase();
    if (!type.includes('ld+json')) continue;
    const text = rawScriptText(el);
    if (!text) continue;
    try {
      collectJsonLdTypes(JSON.parse(text), types);
    } catch {
      // Malformed JSON-LD is extremely common; a page is not less useful for it.
      const m = /"@type"\s*:\s*"([^"]+)"/g;
      let hit = m.exec(text);
      while (hit) { types.push(hit[1]); hit = m.exec(text); }
    }
  }
  return types.filter(Boolean);
}

/** @param {any} el @returns {string} */
function rawScriptText(el) {
  const kids = Array.isArray(el.children) ? el.children : [];
  return kids.filter((c) => c.type === 'text').map((c) => String(c.text ?? '')).join('');
}

/** @param {any} value @param {string[]} out */
function collectJsonLdTypes(value, out) {
  if (!value) return;
  if (Array.isArray(value)) { for (const v of value) collectJsonLdTypes(v, out); return; }
  if (typeof value !== 'object') return;
  const t = value['@type'];
  if (typeof t === 'string') out.push(t);
  else if (Array.isArray(t)) for (const x of t) if (typeof x === 'string') out.push(x);
  for (const v of Object.values(value)) if (v && typeof v === 'object') collectJsonLdTypes(v, out);
}

/**
 * Structural evidence, weighted.
 * @param {any} doc
 * @returns {{kind: SpecimenKind, weight: number, why: string}[]}
 */
function structuralEvidence(doc) {
  /** @type {{kind: SpecimenKind, weight: number, why: string}[]} */
  const out = [];
  if (!doc) return out;
  const text = textOf(doc);
  const articles = elements(doc).filter((n) => tagOf(n) === 'article');
  const hasByline = Boolean(firstElement(doc, (n) => tagOf(n) === 'time'))
    || /\bby\s+[A-Z][a-z]+\s+[A-Z][a-z]+/.test(text)
    || Boolean(firstElement(doc, (n) => /\b(byline|author|dateline|published)\b/i.test(`${attrOf(n, 'class') || ''} ${attrOf(n, 'rel') || ''} ${attrOf(n, 'itemprop') || ''}`)));
  if (articles.length === 1 && hasByline) out.push({ kind: 'article', weight: 1.4, why: 'single <article> with a byline' });
  else if (articles.length === 1) out.push({ kind: 'article', weight: 0.7, why: 'single <article>' });

  const priceLike = Boolean(firstElement(doc, (n) => /\b(price|pricing|amount)\b/i.test(`${attrOf(n, 'class') || ''} ${attrOf(n, 'itemprop') || ''} ${attrOf(n, 'data-testid') || ''}`)))
    || /(?:[$£€¥]\s?\d[\d.,]*|\b\d[\d.,]*\s?(?:USD|EUR|GBP))/.test(text);
  const cartLike = /\b(add to (?:cart|bag|basket)|buy now|in stock|out of stock|sku\b|free shipping)\b/i.test(text);
  if (priceLike && cartLike) out.push({ kind: 'product', weight: 1.5, why: 'price and cart controls' });
  else if (priceLike) out.push({ kind: 'product', weight: 0.5, why: 'price' });

  const forms = byTag(doc, 'form').length;
  const headings = byTag(doc, ['h1', 'h2', 'h3']).length;
  const paragraphs = byTag(doc, 'p').filter((p) => textOf(p).length > 80).length;
  if (forms >= 1 && paragraphs <= 2 && headings >= 1 && text.length < 2500) {
    out.push({ kind: 'campaign', weight: 0.9, why: 'form-led page with little prose' });
  }
  if (paragraphs >= 4) out.push({ kind: 'article', weight: 0.5, why: `${paragraphs} full paragraphs` });
  return out;
}

/**
 * Infer the specimen kind with the evidence behind it.
 * @param {any} doc
 * @param {string|null} url
 * @param {{captureKind?: string, blocks?: any[]}} [context]
 * @returns {{kind: SpecimenKind, confidence: number, evidence: {source: string, kind: string, weight: number, why: string}[]}}
 */
export function inferKindWithEvidence(doc, url, context = {}) {
  /** @type {{source: string, kind: string, weight: number, why: string}[]} */
  const evidence = [];

  if (context.captureKind === 'document') evidence.push({ source: 'capture', kind: 'document', weight: 3, why: 'imported document' });
  if (context.captureKind === 'image') evidence.push({ source: 'capture', kind: 'image', weight: 3, why: 'imported image' });

  for (const t of schemaTypes(doc)) {
    for (const [re, kind] of SCHEMA_KIND) {
      if (re.test(t)) { evidence.push({ source: 'schema.org', kind, weight: kind === 'page' ? 1.1 : 2, why: `@type ${t}` }); break; }
    }
  }

  if (doc) {
    for (const meta of byTag(doc, 'meta')) {
      const key = (attrOf(meta, 'property') || attrOf(meta, 'name') || '').toLowerCase();
      const content = attrOf(meta, 'content') || '';
      if (key !== 'og:type' || !content) continue;
      for (const [re, kind] of OG_KIND) {
        if (re.test(content)) { evidence.push({ source: 'og:type', kind, weight: kind === 'page' ? 0.9 : 1.6, why: `og:type ${content}` }); break; }
      }
    }
  }

  if (url) {
    for (const [re, kind] of URL_KIND) {
      if (re.test(String(url))) { evidence.push({ source: 'url', kind, weight: 1.2, why: `url matches ${re.source.slice(0, 32)}` }); break; }
    }
  }

  for (const e of structuralEvidence(doc)) evidence.push({ source: 'structure', kind: e.kind, weight: e.weight, why: e.why });

  // A capture with no head matter and no landmarks is a fragment: pasted
  // markup, an email module, a component. A parser always synthesises
  // `<html>`/`<body>`, so their presence proves nothing — what a real page has
  // and a fragment does not is a title, meta tags and a page skeleton.
  const head = doc ? firstElement(doc, (n) => tagOf(n) === 'head') : null;
  const hasHeadMatter = head
    ? childrenOf(head).some((c) => isElement(c) && ['title', 'meta', 'link'].includes(tagOf(c)))
    : false;
  const hasSkeleton = Boolean(doc)
    && Boolean(firstElement(doc, (n) => ['main', 'article', 'nav', 'header', 'footer', 'aside'].includes(tagOf(n))));
  const isFragment = Boolean(doc) && !hasHeadMatter && !hasSkeleton
    && (context.blocks ? context.blocks.length <= 6 : true);
  if (isFragment) evidence.push({ source: 'structure', kind: 'fragment', weight: 0.8, why: 'no head matter and no page skeleton' });

  /** @type {Map<string, number>} */
  const totals = new Map();
  for (const e of evidence) totals.set(e.kind, (totals.get(e.kind) || 0) + e.weight);
  let kind = 'page';
  let best = 0;
  let second = 0;
  for (const [k, v] of [...totals.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))) {
    if (v > best) { second = best; best = v; kind = k; }
    else if (v > second) second = v;
  }
  const confidence = best === 0 ? 0.2 : Math.max(0.2, Math.min(1, (best - second) / Math.max(1, best) * 0.6 + Math.min(1, best / 3) * 0.4));
  return { kind: /** @type {SpecimenKind} */ (kind), confidence, evidence };
}

/**
 * @param {any} doc
 * @param {string|null} url
 * @param {{captureKind?: string, blocks?: any[]}} [context]
 * @returns {SpecimenKind}
 */
export function inferKind(doc, url, context = {}) {
  return inferKindWithEvidence(doc, url, context).kind;
}
