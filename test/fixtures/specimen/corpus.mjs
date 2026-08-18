/**
 * The §17.5 chrome-stripping corpus: seven hand-labelled pages of one hostile
 * enterprise site — the six §17.5 asks for, plus an adversarial seventh whose
 * *content* is written to look like chrome.
 *
 * Every fixture is ordinary HTML carrying hand-written ground-truth labels:
 * `data-pp-truth="content"` on the regions a human says are the page's own
 * content, `data-pp-truth="chrome"` on the furniture. Labels nest — a chrome
 * shell inside a content region is excluded from the truth — and anything
 * unlabelled is chrome by default.
 *
 * The classifier never sees `data-pp-truth`: it reads tag, id, class, role,
 * aria-* and text, and `identityTokens` deliberately excludes the label
 * attribute. Nothing in `src/specimen/**` mentions it.
 *
 * Ground truth is expressed as **blocks**, because §17.5 asks for block-level
 * precision/recall/F1: the truth block list is what `toBlocks` produces from
 * the content-labelled subtrees with the chrome-labelled ones removed, which
 * isolates the chrome decision from block normalisation (normalisation has its
 * own tests in `test/specimen/blocks.test.mjs`).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { toBlocks } from '../../../src/specimen/blocks.js';
import { dropNonRendered } from '../../../src/specimen/chrome.js';
import { attrOf, bodyOf, childrenOf, cloneTree, detach, elements, isElement, linkParents } from '../../../src/specimen/dom.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The parser actually in use, so a run says which one produced its numbers. */
export let PARSER_SOURCE = 'test/fixtures/specimen/doc-builder.mjs (local fallback)';

/** @type {(html: string) => any} */
let parse;
try {
  ({ parseHtml: parse } = await import('../../../src/ingest/index.js'));
  PARSER_SOURCE = 'src/ingest/index.js (L3)';
} catch {
  try {
    ({ parseHtml: parse } = await import('../../../src/ingest/html-parse.js'));
    PARSER_SOURCE = 'src/ingest/html-parse.js (L3)';
  } catch {
    ({ buildDoc: parse } = await import('./doc-builder.mjs'));
  }
}

export const parseFixtureHtml = parse;

/**
 * The corpus. `contentBlocks` is asserted by the test so that a fixture whose
 * labels drift is loud rather than quietly easier.
 */
export const FIXTURES = [
  {
    name: 'home.html',
    label: 'enterprise home page — mega-nav, cookie banner, personalization shell',
    url: 'https://www.northwind-industrial.example/',
    contentBlocks: 13,
  },
  {
    name: 'product.html',
    label: 'product detail — personalization shell, sticky bar, breadcrumbs, related rail',
    url: 'https://www.northwind-industrial.example/products/controllers/nx-8400',
    contentBlocks: 11,
  },
  {
    name: 'article.html',
    label: 'news article — subscribe interstitial, social bar, related rail',
    url: 'https://www.northwind-industrial.example/news/retrofit-year-two',
    contentBlocks: 11,
  },
  {
    name: 'article-de.html',
    label: 'locale variant of the same article — translated shell, identical structure',
    url: 'https://www.northwind-industrial.example/de-de/news/retrofit-year-two',
    contentBlocks: 9,
  },
  {
    name: 'docs.html',
    label: 'documentation page — sidebar tree, breadcrumb, on-this-page rail',
    url: 'https://www.northwind-industrial.example/docs/studio/loops',
    contentBlocks: 11,
  },
  {
    name: 'adversarial.html',
    label: 'knowledge-base article about consent — content that reads like chrome',
    url: 'https://www.northwind-industrial.example/kb/portal-cookie-consent',
    contentBlocks: 11,
  },
  {
    name: 'landing.html',
    label: 'landing page that is almost all chrome, and has no <main>',
    url: 'https://www.northwind-industrial.example/lp/uptime-audit',
    contentBlocks: 6,
  },
];

/** @param {string} name @returns {string} */
export function fixtureHtml(name) {
  return readFileSync(join(HERE, name), 'utf8');
}

/**
 * @param {string} name
 * @returns {{name: string, url: string, label: string, html: string, doc: any, contentBlocks: number}}
 */
export function loadFixture(name) {
  const meta = FIXTURES.find((f) => f.name === name);
  if (!meta) throw new Error(`unknown fixture ${name}`);
  const html = fixtureHtml(name);
  return { ...meta, html, doc: parse(html) };
}

/** @returns {ReturnType<typeof loadFixture>[]} */
export function loadCorpus() {
  return FIXTURES.map((f) => loadFixture(f.name));
}

/** The hand-written label on a node, or null. */
export function truthLabel(node) {
  return isElement(node) ? attrOf(node, 'data-pp-truth') : null;
}

/**
 * The ground-truth content blocks of a fixture: every outermost
 * `data-pp-truth="content"` subtree, in document order, with any
 * `data-pp-truth="chrome"` descendants removed first.
 * @param {any} doc
 * @param {{media?: any}} [options]
 * @returns {any[]}
 */
export function groundTruthBlocks(doc, options = {}) {
  const clone = linkParents(cloneTree(doc));
  const body = bodyOf(clone);
  dropNonRendered(body);

  for (const el of elements(body)) {
    if (truthLabel(el) === 'chrome') detach(el);
  }

  /** @type {any[]} */
  const roots = [];
  const visit = (node) => {
    for (const child of childrenOf(node)) {
      if (!isElement(child)) continue;
      if (truthLabel(child) === 'content') roots.push(child);
      else visit(child);
    }
  };
  visit(body);

  /** @type {any[]} */
  const blocks = [];
  for (const root of roots) blocks.push(...toBlocks(root, { media: options.media }));
  return blocks;
}

/**
 * A block reduced to the string the scoring compares. Type and text only:
 * two blocks are the same block when they would read the same on the slide.
 * @param {any} block
 * @returns {string}
 */
export function blockKey(block) {
  switch (block.type) {
    case 'heading': return `heading:${block.level}:${block.text}`;
    case 'paragraph': return `paragraph:${block.text}`;
    case 'list': return `list:${block.ordered ? 'ol' : 'ul'}:${block.items.join('|')}`;
    case 'quote': return `quote:${block.text}|${block.attribution || ''}`;
    case 'table': return `table:${block.header}:${block.rows.map((r) => r.join('~')).join('|')}`;
    case 'cta': return `cta:${block.label}`;
    case 'media': return `media:${block.ref}`;
    case 'raw': return `raw:${block.html}`;
    default: return `?:${JSON.stringify(block)}`;
  }
}

/**
 * Multiset precision / recall / F1 over block keys.
 * @param {any[]} predicted
 * @param {any[]} truth
 * @returns {{precision: number, recall: number, f1: number, tp: number, fp: number, fn: number,
 *            falsePositives: string[], falseNegatives: string[]}}
 */
export function scoreBlocks(predicted, truth) {
  /** @type {Map<string, number>} */
  const remaining = new Map();
  for (const b of truth) {
    const k = blockKey(b);
    remaining.set(k, (remaining.get(k) || 0) + 1);
  }
  let tp = 0;
  /** @type {string[]} */
  const falsePositives = [];
  for (const b of predicted) {
    const k = blockKey(b);
    const left = remaining.get(k) || 0;
    if (left > 0) { remaining.set(k, left - 1); tp += 1; }
    else falsePositives.push(k);
  }
  /** @type {string[]} */
  const falseNegatives = [];
  for (const [k, n] of remaining) for (let i = 0; i < n; i++) falseNegatives.push(k);

  const fp = falsePositives.length;
  const fn = falseNegatives.length;
  const precision = predicted.length === 0 ? (truth.length === 0 ? 1 : 0) : tp / predicted.length;
  const recall = truth.length === 0 ? 1 : tp / truth.length;
  const f1 = (precision + recall) === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1, tp, fp, fn, falsePositives, falseNegatives };
}

/** @param {number} n @returns {string} */
export function pct(n) { return `${(n * 100).toFixed(1)}%`; }
