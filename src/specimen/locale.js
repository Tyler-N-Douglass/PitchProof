/**
 * Locale detection — §8: "Preserve `lang` and locale hints; they drive locale
 * scenarios later."
 *
 * Four signal families, in decreasing authority:
 *
 *   1. `hreflang` alternates whose href *is this page* — the site stating, in
 *      machine-readable form, which market this URL serves;
 *   2. `<html lang>` / `xml:lang`;
 *   3. `og:locale` and `<meta http-equiv="content-language">`;
 *   4. the URL — path segment, subdomain, query parameter, and (weakest)
 *      country-code TLD.
 *
 * The winner is the highest-authority signal, then refined: if a weaker signal
 * agrees on the language but is more specific, its specificity is adopted, so a
 * page with `lang="en"` served from `/en-gb/` is `en-GB` rather than a bare
 * `en`. Every signal found is retained by `localeSignals` for the studio.
 */

import { attrOf, byTag, elements, isElement, tagOf } from './dom.js';

/** ISO 639-1 codes, so a path segment like `/it/` is only read as a locale when it is one. */
const LANGUAGES = new Set(('aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy '
  + 'da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik '
  + 'io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt '
  + 'my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so '
  + 'sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu').split(' '));

/** Authority of each signal family. Higher wins. */
export const LOCALE_SIGNAL_RANK = {
  'hreflang-self': 5,
  'html-lang': 4,
  'og:locale': 3,
  'content-language': 3,
  'url-path': 2,
  'url-subdomain': 2,
  'url-query': 2,
  'tld': 1,
};

/**
 * Normalise a BCP-47-ish tag to canonical casing: `de_DE` → `de-DE`,
 * `ZH-hant-tw` → `zh-Hant-TW`. Returns null when the tag is not a language tag.
 * @param {string|null|undefined} tag
 * @returns {string|null}
 */
export function normalizeLocale(tag) {
  if (!tag) return null;
  const raw = String(tag).trim().replace(/_/g, '-').split(/[;,\s]/)[0];
  if (!raw) return null;
  const parts = raw.split('-').filter(Boolean);
  if (parts.length === 0) return null;
  const lang = parts[0].toLowerCase();
  if (!/^[a-z]{2,3}$/.test(lang)) return null;
  if (lang.length === 2 && !LANGUAGES.has(lang)) return null;
  /** @type {string[]} */
  const out = [lang];
  for (const part of parts.slice(1)) {
    if (/^[a-z]{4}$/i.test(part)) out.push(part[0].toUpperCase() + part.slice(1).toLowerCase());
    else if (/^[a-z]{2}$/i.test(part)) out.push(part.toUpperCase());
    else if (/^\d{3}$/.test(part)) out.push(part);
    else if (/^[a-z0-9]{5,8}$/i.test(part)) out.push(part.toLowerCase());
  }
  return out.join('-');
}

/** @param {string} locale @returns {string} */
function languageOf(locale) { return locale.split('-')[0]; }

/** @param {string} locale @returns {number} */
function specificity(locale) { return locale.split('-').length; }

/**
 * Every locale signal present on the page, strongest first.
 * @param {any} doc
 * @param {string|null} [url]
 * @returns {{source: string, value: string, locale: string, rank: number}[]}
 */
export function localeSignals(doc, url = null) {
  /** @type {{source: string, value: string, locale: string, rank: number}[]} */
  const signals = [];
  const push = (source, value) => {
    const locale = normalizeLocale(value);
    if (!locale) return;
    signals.push({ source, value: String(value), locale, rank: LOCALE_SIGNAL_RANK[source] || 0 });
  };

  if (doc) {
    const html = isElement(doc) && tagOf(doc) === 'html'
      ? doc
      : elements(doc).find((n) => tagOf(n) === 'html');
    if (html) {
      push('html-lang', attrOf(html, 'lang'));
      push('html-lang', attrOf(html, 'xml:lang'));
    }
    // A `lang` on `<body>` or on the article root is used by sites that serve
    // one shell in many markets.
    for (const n of elements(doc)) {
      const tag = tagOf(n);
      if (tag === 'body' || tag === 'main' || tag === 'article') {
        const lang = attrOf(n, 'lang');
        if (lang) push('html-lang', lang);
      }
    }

    for (const meta of byTag(doc, 'meta')) {
      const property = (attrOf(meta, 'property') || '').toLowerCase();
      const name = (attrOf(meta, 'name') || '').toLowerCase();
      const equiv = (attrOf(meta, 'http-equiv') || '').toLowerCase();
      const content = attrOf(meta, 'content');
      if (!content) continue;
      if (property === 'og:locale') push('og:locale', content);
      if (name === 'og:locale') push('og:locale', content);
      if (equiv === 'content-language' || name === 'content-language' || name === 'language') push('content-language', content);
    }

    if (url) {
      const self = normalizeUrl(url);
      for (const link of byTag(doc, 'link')) {
        const rel = (attrOf(link, 'rel') || '').toLowerCase();
        if (!rel.split(/\s+/).includes('alternate')) continue;
        const hreflang = attrOf(link, 'hreflang');
        const href = attrOf(link, 'href');
        if (!hreflang || !href) continue;
        if (hreflang.toLowerCase() === 'x-default') continue;
        if (normalizeUrl(href) === self) push('hreflang-self', hreflang);
      }
    }
  }

  for (const s of urlSignals(url)) push(s.source, s.value);

  return signals.sort((a, b) => (b.rank - a.rank) || (specificity(b.locale) - specificity(a.locale)));
}

/** Strip protocol, trailing slash and fragment so a self-referential alternate matches. */
function normalizeUrl(url) {
  return String(url || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/#.*$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/**
 * Locale hints carried by the URL itself.
 * @param {string|null} url
 * @returns {{source: string, value: string}[]}
 */
export function urlSignals(url) {
  /** @type {{source: string, value: string}[]} */
  const out = [];
  if (!url) return out;
  const text = String(url);
  const withoutProtocol = text.replace(/^[a-z]+:\/\//i, '');
  const [hostAndPath, query = ''] = withoutProtocol.split('?');
  const [host, ...segments] = hostAndPath.split('/');

  for (const segment of segments) {
    const seg = segment.split('#')[0];
    if (!seg) continue;
    if (/^[a-z]{2,3}([-_][a-z]{4})?([-_]([a-z]{2}|\d{3}))?$/i.test(seg) && normalizeLocale(seg)) {
      out.push({ source: 'url-path', value: seg });
    }
  }

  const hostParts = host.split('.');
  if (hostParts.length > 2) {
    const sub = hostParts[0];
    if (normalizeLocale(sub) && sub !== 'www') out.push({ source: 'url-subdomain', value: sub });
    // `de.example.com` and `www.de.example.com` are both used in the wild.
    if (hostParts[0] === 'www' && hostParts.length > 3 && normalizeLocale(hostParts[1])) {
      out.push({ source: 'url-subdomain', value: hostParts[1] });
    }
  }

  for (const pair of query.split('&')) {
    const [k, v] = pair.split('=');
    if (!k || !v) continue;
    if (['lang', 'locale', 'language', 'hl', 'l'].includes(k.toLowerCase())) {
      out.push({ source: 'url-query', value: decodeURIComponent(v) });
    }
  }

  const tld = (hostParts[hostParts.length - 1] || '').toLowerCase();
  const region = CCTLD_REGION[tld];
  if (region) {
    // A ccTLD says market, not language, so it is only ever a fallback and only
    // contributes a region when something else already named the language.
    // `.uk` is a market whose BCP-47 region is `GB`, which is exactly the kind
    // of detail a naive uppercase of the TLD gets wrong.
    out.push({ source: 'tld', value: `und-${region}` });
  }
  return out;
}

/**
 * Country-code TLDs that name a market, mapped to their BCP-47 region. Generic
 * and vanity TLDs (`.io`, `.co`, `.ai`, `.tv`) are deliberately absent: they
 * say nothing about where a page is read.
 */
const CCTLD_REGION = {
  uk: 'GB', de: 'DE', fr: 'FR', es: 'ES', it: 'IT', nl: 'NL', se: 'SE', no: 'NO',
  dk: 'DK', fi: 'FI', pl: 'PL', pt: 'PT', br: 'BR', mx: 'MX', ar: 'AR', cl: 'CL',
  jp: 'JP', cn: 'CN', kr: 'KR', in: 'IN', au: 'AU', nz: 'NZ', ca: 'CA', ch: 'CH',
  at: 'AT', be: 'BE', ie: 'IE', cz: 'CZ', sk: 'SK', hu: 'HU', ro: 'RO', bg: 'BG',
  gr: 'GR', tr: 'TR', ru: 'RU', ua: 'UA', za: 'ZA', sg: 'SG', hk: 'HK', tw: 'TW',
  th: 'TH', id: 'ID', my: 'MY', ph: 'PH', vn: 'VN', il: 'IL', ae: 'AE', sa: 'SA',
};

/**
 * §8 / API.md L6 — the page's locale, or null when nothing on the page says.
 * @param {any} doc
 * @param {string|null} [url]
 * @returns {string|null}
 */
export function detectLocale(doc, url = null) {
  const signals = localeSignals(doc, url).filter((s) => !s.locale.startsWith('und'));
  if (signals.length === 0) {
    // A ccTLD alone names a market but no language; that is a region hint the
    // studio can act on, not a locale, so it is not returned here.
    return null;
  }
  const best = signals[0];
  const language = languageOf(best.locale);
  let winner = best.locale;
  for (const s of signals) {
    if (languageOf(s.locale) !== language) continue;
    if (specificity(s.locale) > specificity(winner)) winner = s.locale;
  }
  if (specificity(winner) === 1) {
    // Region from a ccTLD, but only to refine a language we already know.
    const tld = localeSignals(doc, url).find((s) => s.source === 'tld');
    if (tld) {
      const region = tld.locale.split('-')[1];
      if (region) winner = `${winner}-${region}`;
    }
  }
  return winner;
}
