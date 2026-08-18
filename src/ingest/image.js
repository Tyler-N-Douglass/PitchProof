/**
 * Image import (§6.5), and the explicit page-image path D9 promises.
 *
 * D9 decided the PDF importer extracts text and embedded images but does not
 * rasterize pages, because a half-built PDF renderer produces *wrong* pages and
 * a wrong page in a proof artifact is worse than no page. The honest
 * replacement is this: an explicit entry point where the user supplies page
 * images they exported themselves, labelled as what they are.
 *
 * @module ingest/image
 */

import { ok, err } from '../core/result.js';
import { makeCapture, now, sniffMime, imageSize, toDataUri } from './capture.js';

/**
 * @typedef {import('./capture.js').RawCapture} RawCapture
 */

/**
 * Import one image as a specimen source.
 *
 * @param {Uint8Array} bytes
 * @param {{name?: string, mime?: string, clock: () => string, sourceUrl?: string|null, alt?: string|null}} deps
 * @returns {import('../core/result.js').Result<RawCapture>}
 */
export function importImage(bytes, deps = /** @type {any} */ ({})) {
  let capturedAt;
  try { capturedAt = now(deps); } catch (e) { return err(e instanceof Error ? e.message : String(e)); }

  if (!(bytes instanceof Uint8Array) || !bytes.length) {
    return err('That image file is empty.');
  }
  const name = deps.name || 'image';
  const mime = deps.mime && deps.mime.startsWith('image/') ? deps.mime : sniffMime(bytes, name);
  if (!mime.startsWith('image/')) {
    return err(`"${name}" does not look like an image (it sniffs as ${mime}).`);
  }

  const size = imageSize(bytes, mime);
  /** @type {Record<string,string>} */
  const meta = {
    title: titleFromFilename(name),
    'image.mime': mime,
    'image.bytes': String(bytes.length),
  };
  if (size) {
    meta['image.width'] = String(size.w);
    meta['image.height'] = String(size.h);
  }

  const caption = deps.alt || null;
  return ok(makeCapture({
    kind: 'image',
    sourceUrl: deps.sourceUrl === undefined ? null : deps.sourceUrl,
    capturedAt,
    html: null,
    doc: null,
    blocks: [caption ? { type: 'media', ref: name, caption } : { type: 'media', ref: name }],
    assets: [{ name, bytes, mime }],
    meta,
    strategy: 'file-import',
  }));
}

/**
 * D9's "import page images" entry point: the user exports pages from their PDF
 * viewer (or scans, or screenshots) and hands them over in order. Each becomes
 * one media block, captioned with its page number, so a specimen made from
 * them reads as a document rather than as a pile of pictures.
 *
 * @param {{name?: string, bytes: Uint8Array, mime?: string, caption?: string}[]} images
 * @param {{title?: string, clock: () => string, sourceUrl?: string|null, documentName?: string}} deps
 * @returns {import('../core/result.js').Result<RawCapture>}
 */
export function importPageImages(images, deps = /** @type {any} */ ({})) {
  let capturedAt;
  try { capturedAt = now(deps); } catch (e) { return err(e instanceof Error ? e.message : String(e)); }

  const list = (Array.isArray(images) ? images : []).filter((i) => i && i.bytes instanceof Uint8Array && i.bytes.length);
  if (!list.length) return err('No page images were supplied. Export the pages from your PDF viewer and drop them in order.');

  /** @type {import('../core/contracts.js').ContentBlock[]} */
  const blocks = [];
  /** @type {import('./capture.js').CaptureAsset[]} */
  const assets = [];
  const documentName = deps.documentName || deps.title || 'Imported pages';
  blocks.push({ type: 'heading', level: 1, text: documentName });

  list.forEach((image, index) => {
    const page = index + 1;
    const mime = image.mime && image.mime.startsWith('image/') ? image.mime : sniffMime(image.bytes, image.name || '');
    const name = image.name || `page-${String(page).padStart(3, '0')}.${extensionFor(mime)}`;
    assets.push({ name, bytes: image.bytes, mime });
    blocks.push({ type: 'media', ref: name, caption: image.caption || `Page ${page}` });
  });

  /** @type {Record<string,string>} */
  const meta = {
    title: documentName,
    'pageImages.count': String(list.length),
    // Honesty (§18.5): the artifact must never imply a capability it did not
    // perform. These pages were supplied, not rendered by PitchProof.
    'pageImages.provenance': 'user-supplied page exports; PitchProof does not rasterize PDF pages (D9)',
  };

  return ok(makeCapture({
    kind: 'document',
    sourceUrl: deps.sourceUrl === undefined ? null : deps.sourceUrl,
    capturedAt,
    html: null,
    doc: null,
    blocks,
    assets,
    meta,
    strategy: 'file-import',
  }));
}

/**
 * @param {string} mime
 * @returns {string}
 */
function extensionFor(mime) {
  switch (mime) {
    case 'image/png': return 'png';
    case 'image/jpeg': return 'jpg';
    case 'image/gif': return 'gif';
    case 'image/webp': return 'webp';
    case 'image/avif': return 'avif';
    case 'image/svg+xml': return 'svg';
    default: return 'bin';
  }
}

/**
 * A human title from a filename: `hero-image_v2.final.png` → `hero image v2`.
 * @param {string} name
 * @returns {string}
 */
export function titleFromFilename(name) {
  const base = String(name || '').split('/').pop() || 'image';
  const stem = base.replace(/\.[a-z0-9]{1,5}$/i, '');
  const cleaned = stem
    .replace(/[._-]+/g, ' ')
    .replace(/\b(final|copy|v\d+|\d{2,4}x\d{2,4})\b/gi, (m) => m)
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || base;
}

/**
 * Convenience for consumers that want an inline preview before L6 runs its own
 * downscale-and-recompress pass.
 * @param {import('./capture.js').CaptureAsset} asset
 * @returns {string}
 */
export function assetDataUri(asset) {
  return toDataUri(asset.bytes, asset.mime);
}
