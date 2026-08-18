/**
 * Specimen assembly — §4 `Specimen`, §8 capture rules, §18.3 honesty.
 *
 * `buildSpecimen` turns an L3 `RawCapture` into a contract-valid `Specimen`:
 * chrome stripped with every removal retained, blocks normalised, media inlined
 * as data URIs, meta and locale read from the page, kind inferred, `capturedAt`
 * taken from the **injected clock** and ids from the **injected minter** — the
 * two things §5's determinism law will not let this lane reach for itself.
 *
 * Three §8/§18 obligations are modelled explicitly rather than assumed:
 *
 *   - `raw` keeps the untouched source HTML for fallback rendering, and
 *     `rawOptIn` gates it. `rawFallbackBlocks` returns nothing at all until a
 *     user has opted this specimen in by name; there is no path that surfaces
 *     raw HTML into a scene by default.
 *   - `edited` starts false and only `markEdited` sets it, so §18.3's "if a
 *     specimen was edited, the artifact says so" has a field to say it with.
 *   - `stripped` carries every removed block with its reason, its score and the
 *     positions its blocks occupied, which is what makes `restoreBlock` exact
 *     rather than approximate.
 */

import { countWords, validateSpecimen } from '../core/contracts.js';
import { contentId } from '../core/ids.js';
import { parseHtml } from '../ingest/index.js';
import { blocksWithTrace, repairHeadingLevels, unrepairHeadingLevels } from './blocks.js';
import { classifyChrome, dropNonRendered } from './chrome.js';
import {
  attrOf, bodyOf, byTag, childrenOf, cloneTree, elements, firstElement, isText,
  linkParents, normalizeSpace, selectorPath, tagOf, textOf,
} from './dom.js';
import { inferKindWithEvidence } from './kind.js';
import { detectLocale, localeSignals } from './locale.js';
import { captureMedia, MAX_EDGE } from './media.js';

/**
 * Page metadata: title, description, canonical, lang and the Open Graph and
 * article namespaces. Values are always strings — `Specimen.meta` is
 * `Record<string, string>` and the validator checks it.
 * @param {any} doc
 * @param {Record<string, string>} [base] metadata the importer already knows
 * @returns {Record<string, string>}
 */
export function extractMeta(doc, base = {}) {
  /** @type {Record<string, string>} */
  const meta = {};
  for (const [k, v] of Object.entries(base || {})) {
    if (v === undefined || v === null) continue;
    meta[k] = String(v);
  }
  if (!doc) return meta;

  const title = firstElement(doc, (n) => tagOf(n) === 'title');
  if (title) {
    // `<title>` lives in `<head>`, which renders nothing, so its text is read
    // directly rather than through the rendered-text helper.
    const text = normalizeSpace(childrenOf(title).filter(isText).map((c) => c.text || '').join(''));
    if (text) meta.title = text;
  }
  const html = firstElement(doc, (n) => tagOf(n) === 'html');
  const lang = html ? attrOf(html, 'lang') : null;
  if (lang) meta.lang = lang.trim();

  for (const link of byTag(doc, 'link')) {
    const rel = (attrOf(link, 'rel') || '').toLowerCase().split(/\s+/);
    const href = attrOf(link, 'href');
    if (!href) continue;
    if (rel.includes('canonical')) meta.canonical = href.trim();
  }

  for (const m of byTag(doc, 'meta')) {
    const key = (attrOf(m, 'property') || attrOf(m, 'name') || '').trim().toLowerCase();
    const content = attrOf(m, 'content');
    if (!key || content === null) continue;
    const value = normalizeSpace(content);
    if (!value) continue;
    if (key === 'description' || key === 'author' || key === 'keywords' || key === 'robots') meta[key] = value;
    else if (key.startsWith('og:') || key.startsWith('article:') || key.startsWith('twitter:')) meta[key] = value;
  }

  if (!meta.title && meta['og:title']) meta.title = meta['og:title'];
  if (!meta.description && meta['og:description']) meta.description = meta['og:description'];
  return meta;
}

/** Alt text and dimensions the page declares for each image, keyed by src. */
function imageHints(doc) {
  /** @type {Map<string, {alt: string|null}>} */
  const hints = new Map();
  if (!doc) return hints;
  for (const img of byTag(doc, 'img')) {
    const alt = attrOf(img, 'alt');
    for (const name of ['src', 'data-src', 'data-original']) {
      const src = attrOf(img, name);
      if (!src) continue;
      const key = src.trim();
      if (!hints.has(key)) hints.set(key, { alt: alt === null ? null : normalizeSpace(alt) });
      const base = key.split(/[?#]/)[0].split('/').pop();
      if (base && !hints.has(base)) hints.set(base, { alt: alt === null ? null : normalizeSpace(alt) });
    }
  }
  return hints;
}

/**
 * The first heading of a block list, used as a title of last resort.
 * @param {any[]} blocks
 * @returns {string}
 */
function firstHeading(blocks) {
  for (const b of blocks) if (b.type === 'heading') return b.text;
  for (const b of blocks) if (b.type === 'paragraph') return b.text.slice(0, 80);
  return '';
}

/**
 * §8 / API.md L6 — assemble a contract-valid `Specimen` from a `RawCapture`.
 *
 * @param {any} capture an L3 `RawCapture` (or anything with the same fields)
 * @param {{kind?: string, imageQuality?: number, clock?: () => string,
 *          idMinter?: {next: (kind: string) => string}, siblings?: any[],
 *          maxEdge?: number, repairHeadings?: boolean, parseHtml?: (html: string) => any,
 *          strip?: boolean, strict?: boolean}} [options]
 * @returns {import('../core/contracts.d.ts').Specimen}
 */
export function buildSpecimen(capture, options = {}) {
  if (!capture) throw new Error('buildSpecimen: a capture is required');
  const clock = options.clock;
  const minter = options.idMinter || null;
  const imageQuality = options.imageQuality === undefined ? 0.85 : options.imageQuality;
  const maxEdge = options.maxEdge === undefined ? MAX_EDGE : options.maxEdge;

  const doc = resolveDoc(capture, options);
  const sourceUrl = capture.sourceUrl === undefined ? null : capture.sourceUrl;
  const capturedAt = capture.capturedAt || (clock ? clock() : null);
  if (!capturedAt) throw new Error('buildSpecimen: capture.capturedAt or an injected clock is required (§5)');

  // --- media -------------------------------------------------------------
  const hints = imageHints(doc);
  const assets = (capture.assets || []).map((a) => {
    const hint = hints.get(a.name) || hints.get(String(a.name || '').split('/').pop()) || null;
    return { ...a, alt: a.alt !== undefined ? a.alt : (hint ? hint.alt : null) };
  });
  const media = captureMedia(assets, { imageQuality, maxEdge, idMinter: minter });

  // --- blocks and chrome -------------------------------------------------
  /** @type {any[]} */
  let blocks = [];
  /** @type {number[]} */
  let blockPositions = [];
  /** @type {any[]} */
  let stripped = [];
  let locator = 'none';
  let chromeRoot = null;
  let chromeSiblingPages = 0;
  /** @type {string[]} */
  let chromeNotes = [];

  if (Array.isArray(capture.blocks) && capture.blocks.length > 0) {
    // Document and image importers hand over blocks directly; there is no page
    // chrome in a `.docx`, and inventing some would be worse than none.
    blocks = capture.blocks.map((b) => ({ ...b }));
    blockPositions = blocks.map((_, i) => i);
    locator = 'importer';
  } else if (doc) {
    const clone = linkParents(cloneTree(doc));
    const body = bodyOf(clone);
    dropNonRendered(body);
    // `strip: false` builds the specimen with the whole page in it. It is how
    // the studio shows "everything we found" beside "what we kept", and it is
    // the reference the §17.5 reversibility test compares a fully restored
    // specimen against.
    const classified = options.strip === false
      ? { root: body, how: 'unstripped', removed: [] }
      : classifyChrome(body, { siblings: options.siblings });
    locator = classified.how;
    chromeRoot = selectorPath(classified.root, body);
    chromeSiblingPages = classified.siblingPages || 0;
    chromeNotes = classified.notes || [];

    /** @type {Map<any, number>} node → index into `classified.removed` */
    const removedByNode = new Map();
    classified.removed.forEach((entry, i) => removedByNode.set(entry.node, i));

    const traced = blocksWithTrace(body, { media });
    /** @type {any[][]} */
    const perEntry = classified.removed.map(() => []);
    /** @type {number[][]} */
    const perEntryPositions = classified.removed.map(() => []);

    traced.forEach((t, position) => {
      let owner = -1;
      // A block belongs to a removed region when *any* of the nodes it was
      // built from sits inside one; the outermost such region owns it.
      for (const source of (t.nodes && t.nodes.length ? t.nodes : [t.node])) {
        let cur = source;
        while (cur) {
          const hit = removedByNode.get(cur);
          if (hit !== undefined) owner = hit;
          cur = cur.parent;
        }
        if (owner >= 0) break;
      }
      if (owner >= 0) {
        perEntry[owner].push(t.block);
        perEntryPositions[owner].push(position);
      } else {
        blocks.push(t.block);
        blockPositions.push(position);
      }
    });

    stripped = classified.removed.map((entry, i) => ({
      id: contentId('block', { selector: entry.selector, path: entry.path, reason: entry.reason, text: entry.text }),
      reason: entry.reason,
      score: entry.score,
      signals: entry.signals,
      detail: entry.detail,
      selector: entry.selector,
      path: entry.path,
      outsideRoot: entry.outsideRoot,
      text: entry.text,
      blocks: perEntry[i],
      positions: perEntryPositions[i],
    }));
  }

  if (options.repairHeadings) repairHeadingLevels(blocks);

  // --- identity ----------------------------------------------------------
  const meta = extractMeta(doc, capture.meta || {});
  const locale = doc ? detectLocale(doc, sourceUrl) : (meta.lang || null);
  const inferred = inferKindWithEvidence(doc, sourceUrl, { captureKind: capture.kind, blocks });
  const kind = options.kind || inferred.kind;
  const title = meta.title || meta['og:title'] || firstHeading(blocks) || sourceUrl || 'Untitled specimen';
  const wordCount = countWords(blocks);

  const identity = {
    sourceUrl, capturedAt, kind, title, wordCount,
    blocks, locale, media: media.map((m) => m.digest || m.id),
  };
  const id = minter ? minter.next('specimen') : contentId('specimen', identity);

  /** @type {any} */
  const specimen = {
    id,
    kind,
    title: normalizeSpace(title).slice(0, 300) || 'Untitled specimen',
    sourceUrl: sourceUrl === null ? null : String(sourceUrl),
    capturedAt: String(capturedAt),
    blocks,
    media,
    meta,
    wordCount,
    locale,
    // --- lane extensions (§4 permits optional additions) -------------------
    /** Untouched source HTML, §8. Never rendered without `rawOptIn.allowed`. */
    raw: typeof capture.html === 'string' ? capture.html : null,
    rawOptIn: { allowed: false, by: null, at: null },
    /** §18.3 — set only by `markEdited`. */
    edited: false,
    editNotes: [],
    /** Chrome stripping, fully reversible. */
    stripped,
    restored: [],
    blockPositions,
    chrome: {
      locator,
      root: chromeRoot,
      removedCount: stripped.length,
      siblingPages: chromeSiblingPages,
      notes: chromeNotes,
    },
    headingsRepaired: Boolean(options.repairHeadings),
    kindConfidence: inferred.confidence,
    kindEvidence: inferred.evidence,
    localeSignals: doc ? localeSignals(doc, sourceUrl) : [],
    strategy: capture.strategy || null,
  };

  if (options.strict !== false) {
    /** @type {string[]} */
    const errs = [];
    validateSpecimen(specimen, 'specimen', errs);
    if (errs.length) throw new Error(`buildSpecimen: contract violation — ${errs.join('; ')}`);
  }
  return specimen;
}

/** @param {any} capture @param {any} options @returns {any|null} */
function resolveDoc(capture, options) {
  if (capture.doc) return capture.doc;
  if (typeof capture.html === 'string' && capture.html) {
    // HTML parsing belongs to ingest (D8); this lane never grows its own.
    const parse = options.parseHtml || parseHtml;
    return parse(capture.html);
  }
  return null;
}

/**
 * §8 / API.md L6 — put a stripped block back.
 *
 * Accepts either an entry from `specimen.stripped` or the corresponding entry
 * from `stripChrome`'s `removed` array; matching falls back to the structural
 * path and text so the studio can pass whichever it is holding. The returned
 * specimen is a new object — the caller's is untouched, which is what the
 * command stack (§15) needs to undo a restore.
 *
 * @param {any} specimen
 * @param {any} removedEntry
 * @returns {import('../core/contracts.d.ts').Specimen}
 */
export function restoreBlock(specimen, removedEntry) {
  if (!specimen) throw new Error('restoreBlock: a specimen is required');
  const stripped = Array.isArray(specimen.stripped) ? specimen.stripped : [];
  const entry = findStripped(stripped, removedEntry);
  if (!entry) throw new Error('restoreBlock: that block is not among this specimen\'s stripped blocks');

  const merged = [];
  const positions = [];
  let i = 0;
  let j = 0;
  const current = specimen.blocks || [];
  const currentPositions = Array.isArray(specimen.blockPositions) && specimen.blockPositions.length === current.length
    ? specimen.blockPositions
    : current.map((_, k) => k);
  while (i < current.length || j < entry.blocks.length) {
    const a = i < current.length ? currentPositions[i] : Infinity;
    const b = j < entry.blocks.length ? entry.positions[j] : Infinity;
    if (a <= b) { merged.push(current[i]); positions.push(a); i += 1; }
    else { merged.push(entry.blocks[j]); positions.push(b); j += 1; }
  }

  return {
    ...specimen,
    blocks: merged,
    blockPositions: positions,
    wordCount: countWords(merged),
    stripped: stripped.filter((e) => e !== entry),
    restored: [...(specimen.restored || []), entry.id],
    chrome: { ...(specimen.chrome || {}), removedCount: stripped.length - 1 },
  };
}

/** @param {any[]} stripped @param {any} wanted @returns {any|null} */
function findStripped(stripped, wanted) {
  if (!wanted) return null;
  if (typeof wanted === 'string') return stripped.find((e) => e.id === wanted) || null;
  if (wanted.id) {
    const byId = stripped.find((e) => e.id === wanted.id);
    if (byId) return byId;
  }
  if (wanted.selector) {
    const bySelector = stripped.find((e) => e.selector === wanted.selector
      && String(e.path) === String(wanted.path === undefined ? e.path : wanted.path));
    if (bySelector) return bySelector;
  }
  if (wanted.text) {
    const byText = stripped.find((e) => e.text === wanted.text);
    if (byText) return byText;
  }
  return null;
}

/**
 * Restore every stripped block: the specimen as it was before chrome stripping
 * ran. Used by the studio's "show everything" toggle and by the §17.5
 * reversibility test.
 * @param {any} specimen
 * @returns {import('../core/contracts.d.ts').Specimen}
 */
export function restoreAllBlocks(specimen) {
  let out = specimen;
  // Deterministic order: restoring is commutative because every block carries
  // its original position, but a stable order keeps `restored` legible.
  const order = [...(specimen.stripped || [])].sort((a, b) => (a.positions[0] ?? 0) - (b.positions[0] ?? 0));
  for (const entry of order) out = restoreBlock(out, entry);
  return out;
}

/**
 * §8 — the per-specimen opt-in that raw HTML rendering requires. Nothing else
 * in the codebase may set `rawOptIn.allowed`.
 * @param {any} specimen
 * @param {{allowed: boolean, by: string, at: string}} decision
 * @returns {import('../core/contracts.d.ts').Specimen}
 */
export function setRawHtmlOptIn(specimen, decision) {
  if (!decision || typeof decision.allowed !== 'boolean') {
    throw new Error('setRawHtmlOptIn: an explicit {allowed} decision is required');
  }
  if (decision.allowed && (!decision.by || !decision.at)) {
    throw new Error('setRawHtmlOptIn: opting in records who opted in and when');
  }
  return {
    ...specimen,
    rawOptIn: {
      allowed: decision.allowed,
      by: decision.allowed ? String(decision.by) : null,
      at: decision.allowed ? String(decision.at) : null,
    },
  };
}

/**
 * The raw-HTML fallback rendering for a specimen — empty unless a user opted
 * this specimen in. §8: "never present raw HTML in a scene without a user
 * opt-in per specimen."
 * @param {any} specimen
 * @returns {{blocks: import('../core/contracts.d.ts').ContentBlock[], allowed: boolean, reason: string}}
 */
export function rawFallbackBlocks(specimen) {
  const optIn = specimen && specimen.rawOptIn;
  if (!optIn || !optIn.allowed) {
    return { blocks: [], allowed: false, reason: 'raw HTML requires a per-specimen opt-in (§8)' };
  }
  if (typeof specimen.raw !== 'string' || !specimen.raw) {
    return { blocks: [], allowed: true, reason: 'no raw HTML was captured for this specimen' };
  }
  return { blocks: [{ type: 'raw', html: specimen.raw }], allowed: true, reason: `opted in by ${optIn.by} at ${optIn.at}` };
}

/**
 * §18.3 — record that a specimen's content was changed by the user, so the
 * artifact can say so. Editing is the only thing that sets this; stripping and
 * restoring chrome do not, because they do not alter the prospect's words.
 * @param {any} specimen
 * @param {{blocks?: any[], note: string, at?: string}} change
 * @returns {import('../core/contracts.d.ts').Specimen}
 */
export function markEdited(specimen, change) {
  if (!change || !change.note) throw new Error('markEdited: an edit must say what was changed (§18.3)');
  const blocks = change.blocks ? change.blocks.map((b) => ({ ...b })) : specimen.blocks;
  return {
    ...specimen,
    blocks,
    wordCount: countWords(blocks),
    edited: true,
    editNotes: [...(specimen.editNotes || []), change.at ? `${change.at}: ${change.note}` : change.note],
  };
}

/**
 * Undo a heading-level repair on a specimen (§8: the repair is reversible).
 * @param {any} specimen
 * @returns {import('../core/contracts.d.ts').Specimen}
 */
export function unrepairHeadings(specimen) {
  const blocks = specimen.blocks.map((b) => ({ ...b }));
  unrepairHeadingLevels(blocks);
  return { ...specimen, blocks, headingsRepaired: false };
}

/**
 * Apply the heading-level repair to an existing specimen.
 * @param {any} specimen
 * @returns {import('../core/contracts.d.ts').Specimen}
 */
export function repairHeadings(specimen) {
  const blocks = specimen.blocks.map((b) => ({ ...b }));
  repairHeadingLevels(blocks);
  return { ...specimen, blocks, headingsRepaired: true };
}

/**
 * Every distinct element the capture referenced but that no `MediaRef` covers.
 * L11 turns these into `ASSET_MISSING`; surfacing them here means the studio
 * can offer to fetch or upload them before that becomes a finding.
 * @param {any} specimen
 * @returns {string[]}
 */
export function unresolvedMediaRefs(specimen) {
  const known = new Set((specimen.media || []).map((m) => m.id));
  /** @type {Set<string>} */
  const missing = new Set();
  for (const b of specimen.blocks || []) {
    if (b.type === 'media' && !known.has(b.ref)) missing.add(b.ref);
  }
  return [...missing].sort();
}

/**
 * All elements of a parsed document, exposed for the studio's inspector.
 * @param {any} doc
 * @returns {number}
 */
export function elementCount(doc) { return elements(doc).length; }
