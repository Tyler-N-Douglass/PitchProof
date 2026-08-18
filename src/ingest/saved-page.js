/**
 * Strategy 3a (§6) — saved-page import.
 *
 * "File → Save Page As → Webpage, Complete" is the most reliable way for a
 * seller to get a hostile enterprise page out of a browser and into PitchProof,
 * and it is the one that needs no proxy, no extension and no permission from
 * anybody's security team. The `.html` file plus its `_files` folder arrive as
 * a flat list of `{name, bytes}`; this module reunites them.
 *
 * Assets keep three names — the path they were saved at, their bare filename,
 * and every reference in the document that resolves to them — so L6 can look an
 * asset up however it happens to be holding the reference.
 *
 * @module ingest/saved-page
 */

import { ok, err } from '../core/result.js';
import {
  htmlCapture, now, sniffMime, normalizeAssetRef, documentReferences, resolveUrl,
} from './capture.js';
import { firstElement, attr, walk } from './html-parse.js';

/**
 * @typedef {import('./capture.js').RawCapture} RawCapture
 * @typedef {import('./capture.js').CaptureAsset} CaptureAsset
 * @typedef {{name?: string, bytes?: Uint8Array, text?: string, mime?: string}} DroppedFile
 */

/** Chrome and Firefox both write this banner into a saved page. */
const SAVED_FROM = /<!--\s*saved from url=\(\d+\)([^\s]+)\s*-->/i;

/**
 * @param {string} name
 * @returns {string}
 */
function dirNameOf(name) {
  const clean = String(name || '').replace(/\\/g, '/');
  const at = clean.lastIndexOf('/');
  return at < 0 ? '' : clean.slice(0, at + 1);
}

/**
 * @param {string} name
 * @returns {string}
 */
function baseNameOf(name) {
  const clean = String(name || '').replace(/\\/g, '/');
  const at = clean.lastIndexOf('/');
  return at < 0 ? clean : clean.slice(at + 1);
}

/**
 * Join a directory and a relative reference, collapsing `.` and `..`.
 * @param {string} dir
 * @param {string} ref
 * @returns {string}
 */
export function joinPath(dir, ref) {
  if (!ref) return dir;
  if (ref.startsWith('/')) return ref.slice(1);
  const parts = `${dir}${ref}`.split('/');
  /** @type {string[]} */
  const stack = [];
  for (const seg of parts) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { stack.pop(); continue; }
    stack.push(seg);
  }
  return stack.join('/');
}

/**
 * Import one or more saved pages plus their asset folders.
 *
 * @param {DroppedFile[]} files
 * @param {{clock: () => string}} deps
 * @returns {Promise<import('../core/result.js').Result<RawCapture[]>>}
 */
export async function importSavedPage(files, deps = /** @type {any} */ ({})) {
  let capturedAt;
  try { capturedAt = now(deps); } catch (e) { return err(e instanceof Error ? e.message : String(e)); }

  const list = (Array.isArray(files) ? files : []).filter((f) => f && (f.bytes || typeof f.text === 'string'));
  if (!list.length) return err('No files arrived. Drop the saved .html file together with its _files folder.');

  const decoder = new TextDecoder();
  /** @type {{file: DroppedFile, name: string, text: string}[]} */
  const pages = [];
  /** @type {{file: DroppedFile, name: string, bytes: Uint8Array, mime: string}[]} */
  const assets = [];

  for (const file of list) {
    const name = normalizeAssetRef(file.name || 'page.html');
    const bytes = file.bytes instanceof Uint8Array
      ? file.bytes
      : new TextEncoder().encode(String(file.text || ''));
    const mime = file.mime && file.mime !== 'application/octet-stream' ? file.mime : sniffMime(bytes, name);
    if (mime === 'text/html' || mime === 'application/xhtml+xml' || /\.x?html?$/i.test(name)) {
      pages.push({ file, name, text: typeof file.text === 'string' ? file.text : decoder.decode(bytes) });
    } else {
      assets.push({ file, name, bytes, mime });
    }
  }

  if (!pages.length) {
    return err('No .html file was in that drop. A saved page is the .html file plus the folder next to it.');
  }

  /** Index every asset under every name it could plausibly be referenced by. */
  /** @type {Map<string, {name: string, bytes: Uint8Array, mime: string}>} */
  const index = new Map();
  for (const asset of assets) {
    const record = { name: asset.name, bytes: asset.bytes, mime: asset.mime };
    for (const key of assetKeys(asset.name)) if (!index.has(key)) index.set(key, record);
  }

  /** @type {RawCapture[]} */
  const captures = [];
  for (const page of pages) {
    const dir = dirNameOf(page.name);
    const savedFrom = page.text.match(SAVED_FROM);
    let sourceUrl = savedFrom ? savedFrom[1] : null;

    const capture = htmlCapture(page.text, {
      sourceUrl,
      capturedAt,
      strategy: 'saved-page',
      meta: { 'savedPage.file': page.name },
    });

    // A `<base href>` beats the saved-from banner for resolving references,
    // because that is what the browser itself would have used.
    const base = firstElement(/** @type {any} */ (capture.doc), 'base');
    const baseHref = base ? attr(base, 'href') : null;
    if (!sourceUrl && baseHref && /^https?:/i.test(baseHref)) sourceUrl = baseHref;
    if (sourceUrl) {
      capture.sourceUrl = sourceUrl;
      capture.meta.sourceUrl = sourceUrl;
      capture.meta['savedPage.savedFrom'] = sourceUrl;
    }

    /** @type {Map<string, CaptureAsset>} */
    const used = new Map();
    /** @type {Set<string>} */
    const unresolved = new Set();

    for (const ref of documentReferences(/** @type {any} */ (capture.doc), null)) {
      const raw = normalizeAssetRef(ref.raw);
      if (!raw || /^(data|blob|javascript|mailto|tel|about|#):?/i.test(raw)) continue;
      const absolute = /^(https?:)?\/\//i.test(raw);
      const local = absolute ? null : index.get(joinPath(dir, raw)) || index.get(raw) || index.get(baseNameOf(raw));
      const hit = local || index.get(baseNameOf(raw));
      if (!hit) {
        if (!absolute) unresolved.add(raw);
        continue;
      }
      const existing = used.get(hit.name);
      if (existing) {
        if (!existing.aliases) existing.aliases = [];
        if (!existing.aliases.includes(raw)) existing.aliases.push(raw);
      } else {
        used.set(hit.name, {
          name: hit.name,
          bytes: hit.bytes,
          mime: hit.mime,
          aliases: dedupe([raw, baseNameOf(hit.name), ref.url || '']).filter((a) => a && a !== hit.name),
        });
      }
    }

    // Assets in the folder that nothing referenced are still carried: a font or
    // a logo the page loads from CSS is exactly the asset L5 wants.
    const folderPrefix = `${page.name.replace(/\.x?html?$/i, '')}_files/`;
    for (const asset of assets) {
      if (used.has(asset.name)) continue;
      if (!asset.name.startsWith(folderPrefix) && pages.length > 1) continue;
      used.set(asset.name, {
        name: asset.name,
        bytes: asset.bytes,
        mime: asset.mime,
        aliases: [baseNameOf(asset.name)].filter((a) => a !== asset.name),
      });
    }

    capture.assets = Array.from(used.values()).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    capture.meta['savedPage.assets'] = String(capture.assets.length);
    if (unresolved.size) capture.meta['savedPage.unresolved'] = String(unresolved.size);
    captures.push(capture);
  }

  return ok(captures);
}

/**
 * Every key an asset should be findable under.
 * @param {string} name
 * @returns {string[]}
 */
function assetKeys(name) {
  const keys = [name, baseNameOf(name)];
  const noQuery = name.split('?')[0];
  if (noQuery !== name) { keys.push(noQuery, baseNameOf(noQuery)); }
  try {
    const decoded = decodeURIComponent(name);
    if (decoded !== name) keys.push(decoded, baseNameOf(decoded));
  } catch { /* a broken escape sequence is not worth failing an import over */ }
  return dedupe(keys).filter(Boolean);
}

/**
 * @template T
 * @param {T[]} items
 * @returns {T[]}
 */
function dedupe(items) { return Array.from(new Set(items)); }

/**
 * Rewrite a saved page's local references to the canonical asset names, so a
 * consumer that only has `capture.assets` can still resolve every `src`.
 * Returns the number of attributes rewritten. Used by the studio when it wants
 * a self-consistent document; the importer itself leaves the source untouched
 * because §8 requires an untouched `raw` copy.
 *
 * @param {RawCapture} capture
 * @returns {number}
 */
export function relinkAssets(capture) {
  if (!capture || !capture.doc) return 0;
  /** @type {Map<string,string>} */
  const byAlias = new Map();
  for (const asset of capture.assets || []) {
    byAlias.set(asset.name, asset.name);
    for (const alias of asset.aliases || []) byAlias.set(alias, asset.name);
  }
  let count = 0;
  walk(capture.doc, (node) => {
    if (node.type !== 'element' || !node.attrs) return undefined;
    for (const a of ['src', 'href', 'poster']) {
      const raw = node.attrs[a];
      if (!raw) continue;
      const target = byAlias.get(normalizeAssetRef(raw));
      if (target && target !== raw) { node.attrs[a] = target; count += 1; }
    }
    return undefined;
  });
  return count;
}
