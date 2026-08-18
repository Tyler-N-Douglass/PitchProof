/**
 * The end-to-end fixture corpus.
 *
 * §20 requires the adversarial critic to "actually build and present a proof end
 * to end from the fixture corpus" before it is allowed to write a report. This
 * is that corpus: a fictional but deliberately realistic prospect site —
 * Northwind Industrial, a process-equipment manufacturer — with the things that
 * make real enterprise sites hostile:
 *
 *   - a mega-nav, a utility bar, breadcrumbs, a sticky bar and a footer nav;
 *   - a cookie-consent dialog, a newsletter gate, a personalization shell, a
 *     social bar and a chat widget;
 *   - a brand with a genuinely awkward palette: a mid-orange accent (`#E8622C`)
 *     that cannot carry white text at 4.5:1 and must have its `onAccent` role
 *     derived, over a deep navy that can;
 *   - a webfont family (`Sohne`) that is not installed anywhere, so every
 *     measurement is post-substitution — the §22.2 case;
 *   - four pages including a locale variant, so repeated-across-pages chrome
 *     detection has something to work with.
 *
 * Nothing here is a real company, a real customer, or a real testimonial. The
 * quotes are attributed to roles, not to named people, precisely because §18.2
 * forbids the tool inventing named customers — and a fixture that modelled the
 * thing the product refuses to do would be a bad fixture.
 *
 * Lanes own their own fixture directories. This one is shared: it exists for
 * integration, `verify-offline.mjs`, and the critic loop.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CORPUS_ROOT = join(HERE, 'northwind');

/** The origin the fixture pages claim to be served from. */
export const CORPUS_ORIGIN = 'https://www.northwind-industrial.example';

/**
 * @typedef {object} CorpusPage
 * @property {string} id
 * @property {string} file        path relative to `CORPUS_ROOT`
 * @property {string} url         the absolute URL the page claims
 * @property {import('../../../src/core/contracts.d.ts').SpecimenKind} kind
 * @property {string} locale
 * @property {string} title
 */

/** @type {CorpusPage[]} */
export const CORPUS_PAGES = [
  {
    id: 'home',
    file: 'index.html',
    url: `${CORPUS_ORIGIN}/`,
    kind: 'page',
    locale: 'en-GB',
    title: 'Northwind Industrial — Process equipment that stays running',
  },
  {
    id: 'product',
    file: 'product-hx-400.html',
    url: `${CORPUS_ORIGIN}/equipment/heat-exchangers/hx-400/`,
    kind: 'product',
    locale: 'en-GB',
    title: 'HX-400 shell-and-tube heat exchanger',
  },
  {
    id: 'article',
    file: 'insights-fouling-margins.html',
    url: `${CORPUS_ORIGIN}/insights/fouling-margins/`,
    kind: 'article',
    locale: 'en-GB',
    title: 'Designing fouling margin you will actually use',
  },
  {
    id: 'article-de',
    file: 'de/einblicke-verschmutzungsreserve.html',
    url: `${CORPUS_ORIGIN}/de/einblicke/verschmutzungsreserve/`,
    kind: 'article',
    locale: 'de-DE',
    title: 'Verschmutzungsreserve richtig auslegen',
  },
];

/** Assets the pages reference, by the path they use. */
export const CORPUS_ASSETS = [
  { path: '/assets/site.css', file: 'assets/site.css', mime: 'text/css' },
  { path: '/assets/logo.svg', file: 'assets/logo.svg', mime: 'image/svg+xml' },
  { path: '/assets/mark.svg', file: 'assets/mark.svg', mime: 'image/svg+xml' },
  { path: '/assets/hero-plant.png', file: 'assets/hero-plant.png', mime: 'image/png' },
  { path: '/assets/product-hx400.png', file: 'assets/product-hx400.png', mime: 'image/png' },
  { path: '/assets/uptime-figure.png', file: 'assets/uptime-figure.png', mime: 'image/png' },
];

/**
 * The colours the fixture brand actually uses, for tests that need to know what
 * a correct extraction looks like. White on `#E8622C` is 3.38:1 — below the 4.5
 * body-text floor — so a solver that hands back white-on-orange has failed, and
 * a solver that derives a compliant `onAccent` has not.
 */
export const CORPUS_BRAND = {
  navy: '#0F2A47',
  navyDeep: '#071A2E',
  orange: '#E8622C',
  steel: '#5A6B7C',
  mist: '#EEF2F6',
  paper: '#FFFFFF',
  ink: '#14202B',
  line: '#D3DBE3',
  families: { display: 'Sohne', body: 'Sohne', mono: 'Sohne Mono' },
};

/**
 * Read one page's HTML.
 * @param {string} id
 * @returns {string}
 */
export function pageHtml(id) {
  const page = CORPUS_PAGES.find((p) => p.id === id);
  if (!page) throw new Error(`corpus: no page "${id}"`);
  return readFileSync(join(CORPUS_ROOT, page.file), 'utf8');
}

/**
 * Read one asset's bytes.
 * @param {string} path  the path the pages reference, e.g. `/assets/logo.svg`
 * @returns {Uint8Array}
 */
export function assetBytes(path) {
  const asset = CORPUS_ASSETS.find((a) => a.path === path);
  if (!asset) throw new Error(`corpus: no asset "${path}"`);
  return new Uint8Array(readFileSync(join(CORPUS_ROOT, asset.file)));
}

/**
 * An injectable `http` stand-in that serves the corpus and refuses everything
 * else, so ingest can be driven end to end with no network at all. Matches the
 * `http` shape declared in `API.md` Part 3 → L3.
 * @returns {(url: string) => Promise<{ok: boolean, status: number, text: () => Promise<string>, bytes: () => Promise<Uint8Array>}>}
 */
export function corpusHttp() {
  return async (url) => {
    const path = String(url).startsWith(CORPUS_ORIGIN) ? String(url).slice(CORPUS_ORIGIN.length) : String(url);
    const page = CORPUS_PAGES.find((p) => p.url === url || p.url.slice(CORPUS_ORIGIN.length) === path);
    if (page) {
      const html = pageHtml(page.id);
      return { ok: true, status: 200, text: async () => html, bytes: async () => new Uint8Array(Buffer.from(html, 'utf8')) };
    }
    const asset = CORPUS_ASSETS.find((a) => a.path === path);
    if (asset) {
      const bytes = assetBytes(asset.path);
      return { ok: true, status: 200, text: async () => Buffer.from(bytes).toString('utf8'), bytes: async () => bytes };
    }
    if (path === '/robots.txt') {
      const body = `User-agent: *\nDisallow: /login/\nDisallow: /quote/\nSitemap: ${CORPUS_ORIGIN}/sitemap.xml\n`;
      return { ok: true, status: 200, text: async () => body, bytes: async () => new Uint8Array(Buffer.from(body)) };
    }
    if (path === '/sitemap.xml') {
      const body = sitemapXml();
      return { ok: true, status: 200, text: async () => body, bytes: async () => new Uint8Array(Buffer.from(body)) };
    }
    return { ok: false, status: 404, text: async () => '', bytes: async () => new Uint8Array(0) };
  };
}

/** @returns {string} */
export function sitemapXml() {
  const urls = CORPUS_PAGES.map((p) => `  <url><loc>${p.url}</loc><lastmod>2026-01-20</lastmod></url>`).join('\n');
  const extra = [
    '/equipment/', '/equipment/heat-exchangers/', '/equipment/separators/',
    '/industries/refining/', '/service/', '/service/turnaround/', '/about/', '/careers/', '/contact/',
  ].map((p) => `  <url><loc>${CORPUS_ORIGIN}${p}</loc><lastmod>2026-01-20</lastmod></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n${extra}\n</urlset>\n`;
}

/** A pinned clock, so a corpus-driven run is reproducible. */
export function corpusClock(iso = '2026-02-10T10:00:00.000Z') {
  return () => iso;
}
