/**
 * PDF import (§6.5, D9).
 *
 * Scope, restated because it is a decision and not a limitation to be papered
 * over: this importer reads the object graph, inflates the content streams,
 * extracts text through the text-showing operators honouring `ToUnicode` CMaps,
 * and lifts embedded images out. It does **not** rasterize pages. A user who
 * needs page-accurate visuals goes through `importPageImages`, which is honest
 * about where those pixels came from.
 *
 * @module ingest/pdf
 */

import { ok, err } from '../../core/result.js';
import { makeCapture, now } from '../capture.js';
import { readPdf } from './document.js';
import { extractPageRuns, groupLines, linesToBlocks, stripRunningHeads } from './text.js';
import { extractPageImages } from './image.js';

/**
 * @typedef {import('../capture.js').RawCapture} RawCapture
 * @typedef {import('../../core/contracts.js').ContentBlock} ContentBlock
 */

/**
 * Import a PDF.
 *
 * @param {Uint8Array} bytes
 * @param {{name?: string, clock: () => string, sourceUrl?: string|null, maxPages?: number}} deps
 * @returns {import('../../core/result.js').Result<RawCapture>}
 */
export function importPdf(bytes, deps = /** @type {any} */ ({})) {
  let capturedAt;
  try { capturedAt = now(deps); } catch (e) { return err(e instanceof Error ? e.message : String(e)); }

  const name = deps.name || 'document.pdf';
  if (!(bytes instanceof Uint8Array) || bytes.length < 8) return err(`"${name}" is empty.`);

  /** @type {import('./document.js').PdfDocument|null} */
  let doc;
  try {
    doc = readPdf(bytes);
  } catch (e) {
    return err(`"${name}" could not be parsed as a PDF.`, { cause: e instanceof Error ? e.message : String(e) });
  }
  if (!doc) return err(`"${name}" does not start with a PDF header, so it is not a PDF.`);

  const pages = doc.pages();
  if (!pages.length) {
    return err(`"${name}" has no readable pages.${doc.encrypted ? ' The document is encrypted; open it in a viewer, print it to a new PDF, and try again.' : ''}`, {
      warnings: doc.warnings,
    });
  }

  const limit = Number.isFinite(deps.maxPages) ? Math.max(1, Number(deps.maxPages)) : pages.length;
  const pageCount = Math.min(pages.length, limit);

  /** @type {ContentBlock[]} */
  const blocks = [];
  /** @type {import('../capture.js').CaptureAsset[]} */
  const assets = [];
  const report = { skipped: /** @type {{name: string, filter: string}[]} */ ([]) };
  let textPages = 0;
  let imageCount = 0;

  for (let i = 0; i < pageCount; i++) {
    const page = pages[i];
    const pageNumber = i + 1;

    /** @type {import('./text.js').TextRun[]} */
    let runs = [];
    try {
      runs = extractPageRuns(doc, page, pageNumber);
    } catch (e) {
      doc.warnings.push(`page ${pageNumber} text could not be read: ${e instanceof Error ? e.message : String(e)}`);
    }
    const lines = stripRunningHeads(groupLines(runs), pageCount);
    if (lines.length) textPages += 1;
    blocks.push(...linesToBlocks(lines));

    /** @type {import('./image.js').ExtractedImage[]} */
    let images = [];
    try {
      images = extractPageImages(doc, page, pageNumber, report);
    } catch (e) {
      doc.warnings.push(`page ${pageNumber} images could not be read: ${e instanceof Error ? e.message : String(e)}`);
    }
    for (const image of images) {
      if (assets.some((a) => a.name === image.name)) continue;
      assets.push({ name: image.name, bytes: image.bytes, mime: image.mime });
      blocks.push({ type: 'media', ref: image.name, caption: `Page ${pageNumber}` });
      imageCount += 1;
    }
  }

  const info = doc.info();
  /** @type {Record<string,string>} */
  const meta = {
    'pdf.pages': String(pages.length),
    'pdf.pagesRead': String(pageCount),
    'pdf.textPages': String(textPages),
    'pdf.images': String(imageCount),
    'pdf.file': name,
  };
  if (info.Title) meta.title = info.Title;
  if (info.Author) meta.author = info.Author;
  if (info.Subject) meta.description = info.Subject;
  if (info.Keywords) meta.keywords = info.Keywords;
  if (info.Producer) meta['pdf.producer'] = info.Producer;
  if (info.Creator) meta['pdf.creator'] = info.Creator;
  if (info.CreationDate) meta['pdf.created'] = info.CreationDate;
  const lang = doc.language();
  if (lang) meta.lang = lang;
  if (doc.encrypted) meta['pdf.encrypted'] = 'true';
  if (report.skipped.length) {
    meta['pdf.imagesSkipped'] = String(report.skipped.length);
    meta['pdf.imagesSkippedReason'] = Array.from(new Set(report.skipped.map((s) => s.filter))).join(', ');
  }
  if (doc.warnings.length) meta['pdf.warnings'] = doc.warnings.slice(0, 8).join(' | ');

  if (!meta.title) {
    const heading = blocks.find((b) => b.type === 'heading');
    meta.title = heading && heading.type === 'heading'
      ? heading.text
      : (name.replace(/\.pdf$/i, '').replace(/[._-]+/g, ' ').trim() || name);
  }

  if (!blocks.length) {
    return err(
      `"${name}" gave up no text or images. It is most likely a scan. Export the pages as images and use "Import page images", or run OCR first.`,
      { warnings: doc.warnings },
    );
  }

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
