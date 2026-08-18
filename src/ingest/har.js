/**
 * Strategy 3b (§6) — HAR import.
 *
 * A HAR is the richest thing a prospect-facing page can be handed over as: it
 * carries the document, every image, every stylesheet and every font, each with
 * its real URL and its real MIME type. Devtools → Network → right-click →
 * "Save all as HAR with content" gets it out of any browser, on any network,
 * with no proxy in the way.
 *
 * Assets are attached to the most recent HTML document that preceded them,
 * which is how a multi-page HAR keeps its pages apart deterministically.
 *
 * @module ingest/har
 */

import { ok, err } from '../core/result.js';
import { base64Decode, utf8Encode } from '../core/bytes.js';
import { htmlCapture, now, sniffMime, normalizeAssetRef } from './capture.js';

/**
 * @typedef {import('./capture.js').RawCapture} RawCapture
 * @typedef {import('./capture.js').CaptureAsset} CaptureAsset
 */

/** Content types worth keeping as assets. Everything else is noise for a proof. */
const ASSET_TYPES = /^(image|font|audio|video)\/|^application\/(font|x-font|vnd\.ms-fontobject|pdf)|^text\/css$/i;

/**
 * @param {string} url
 * @returns {string}
 */
function assetNameFor(url) {
  const clean = normalizeAssetRef(url);
  try {
    const parsed = new URL(clean);
    return `${parsed.host}${parsed.pathname}`.replace(/\/$/, '/index');
  } catch {
    return clean;
  }
}

/**
 * Import a HAR file's JSON text.
 *
 * @param {string} text
 * @param {{clock: () => string}} deps
 * @returns {import('../core/result.js').Result<RawCapture[]>}
 */
export function importHar(text, deps = /** @type {any} */ ({})) {
  let capturedAt;
  try { capturedAt = now(deps); } catch (e) { return err(e instanceof Error ? e.message : String(e)); }

  let har;
  try {
    har = JSON.parse(String(text || ''));
  } catch (e) {
    return err('That file is not valid JSON, so it cannot be a HAR. Re-export it from the Network panel with "Save all as HAR with content".', {
      cause: e instanceof Error ? e.message : String(e),
    });
  }

  const log = har && har.log;
  const entries = log && Array.isArray(log.entries) ? log.entries : null;
  if (!entries) return err('That JSON has no `log.entries`, so it is not a HAR.');
  if (!entries.length) return err('That HAR is empty — no requests were recorded.');

  /** @type {Map<string,string>} page id → title */
  const pageTitles = new Map();
  if (Array.isArray(log.pages)) {
    for (const page of log.pages) {
      if (page && page.id) pageTitles.set(String(page.id), String(page.title || ''));
    }
  }

  /** @type {RawCapture[]} */
  const captures = [];
  /** @type {RawCapture|null} */
  let current = null;
  let skipped = 0;

  for (const entry of entries) {
    const request = entry && entry.request;
    const response = entry && entry.response;
    if (!request || !response) { skipped += 1; continue; }
    const url = String(request.url || '');
    const status = Number(response.status || 0);
    const content = response.content || {};
    const mimeType = String(content.mimeType || '').split(';')[0].trim().toLowerCase();
    const body = decodeContent(content);

    const isHtml = (mimeType === 'text/html' || mimeType === 'application/xhtml+xml')
      && status >= 200 && status < 300
      && body.text !== null && /\S/.test(body.text);

    if (isHtml) {
      const capture = htmlCapture(/** @type {string} */ (body.text), {
        sourceUrl: url,
        capturedAt,
        strategy: 'har',
        meta: {
          'har.status': String(status),
          'har.mimeType': mimeType,
        },
      });
      if (entry.pageref && pageTitles.has(String(entry.pageref))) {
        const title = pageTitles.get(String(entry.pageref)) || '';
        if (title && !capture.meta.title) capture.meta.title = title;
        capture.meta['har.pageref'] = String(entry.pageref);
      }
      if (entry.startedDateTime) capture.meta['har.startedDateTime'] = String(entry.startedDateTime);
      captures.push(capture);
      current = capture;
      continue;
    }

    if (!body.bytes || !body.bytes.length) { skipped += 1; continue; }
    const looksAsset = ASSET_TYPES.test(mimeType) || ASSET_TYPES.test(sniffMime(body.bytes, url));
    if (!looksAsset) { skipped += 1; continue; }

    const asset = {
      name: assetNameFor(url),
      bytes: body.bytes,
      mime: mimeType || sniffMime(body.bytes, url),
      aliases: dedupe([url, normalizeAssetRef(url), pathOnly(url)]).filter((a) => a && a !== assetNameFor(url)),
    };
    const target = current || captures[0];
    if (target) target.assets.push(asset);
    else skipped += 1;
  }

  if (!captures.length) {
    return err('That HAR has no HTML document in it. Re-record with the page reload included, and make sure "with content" was checked.', { entries: entries.length });
  }

  for (const capture of captures) {
    capture.meta['har.assets'] = String(capture.assets.length);
    if (skipped) capture.meta['har.skipped'] = String(skipped);
  }
  return ok(captures);
}

/**
 * @param {string} url
 * @returns {string}
 */
function pathOnly(url) {
  try { return new URL(url).pathname; } catch { return url; }
}

/**
 * @template T
 * @param {T[]} items
 * @returns {T[]}
 */
function dedupe(items) { return Array.from(new Set(items)); }

/**
 * Decode a HAR content record into both text and bytes, honouring the base64
 * encoding flag that every browser sets on binary bodies.
 * @param {{text?: string, encoding?: string, mimeType?: string}} content
 * @returns {{text: string|null, bytes: Uint8Array|null}}
 */
export function decodeContent(content) {
  const raw = content && typeof content.text === 'string' ? content.text : null;
  if (raw === null) return { text: null, bytes: null };
  if (String(content.encoding || '').toLowerCase() === 'base64') {
    try {
      const bytes = base64Decode(raw);
      const mime = String(content.mimeType || '');
      const text = /^(text\/|application\/(json|xml|javascript|xhtml))/i.test(mime)
        ? new TextDecoder().decode(bytes)
        : null;
      return { text, bytes };
    } catch {
      return { text: null, bytes: null };
    }
  }
  return { text: raw, bytes: utf8Encode(raw) };
}
