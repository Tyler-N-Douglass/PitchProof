/**
 * Strategy 4 (paste HTML) and strategy 6 (manual entry) from §6.
 *
 * Manual entry is the strategy that cannot fail, which is exactly why it has to
 * be good rather than a last resort: when a seller is forty minutes from a
 * meeting and the prospect's site is behind Akamai bot protection, typing the
 * hero copy in by hand is the path that gets the proof built. So the plain-text
 * parser understands the shorthand people already type — `#` headings, `-`
 * bullets, `>` quotes, pipe tables, `[label](href)` calls to action — and turns
 * it into real `ContentBlock`s rather than one undifferentiated paragraph.
 *
 * @module ingest/paste
 */

import { ok, err } from '../core/result.js';
import { htmlCapture, makeCapture, now } from './capture.js';

/**
 * @typedef {import('./capture.js').RawCapture} RawCapture
 * @typedef {import('../core/contracts.js').ContentBlock} ContentBlock
 */

/**
 * Strategy 4 — raw source pasted into a text area.
 *
 * Text with no markup at all is still accepted: it is wrapped into paragraphs
 * and flagged in `meta`, because a paste surface that rejects a paste is a
 * dead-end, and §6 forbids dead-ends.
 *
 * @param {string} html
 * @param {{sourceUrl?: string|null, clock: () => string, strategy?: string}} deps
 * @returns {import('../core/result.js').Result<RawCapture>}
 */
export function importHtmlText(html, deps = /** @type {any} */ ({})) {
  let capturedAt;
  try { capturedAt = now(deps); } catch (e) { return err(e instanceof Error ? e.message : String(e)); }

  const source = typeof html === 'string' ? html : '';
  if (!source.trim()) return err('Nothing was pasted. Copy the page source (Ctrl-U, then select all) and paste it here.');

  const hasMarkup = /<\/?[a-zA-Z][^>]*>/.test(source);
  const text = hasMarkup ? source : source
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeText(p.trim())}</p>`)
    .join('\n');

  const capture = htmlCapture(text, {
    sourceUrl: deps.sourceUrl === undefined ? null : deps.sourceUrl,
    capturedAt,
    strategy: deps.strategy || 'paste-html',
    meta: hasMarkup ? {} : { 'paste.wrapped': 'true' },
  });
  if (!hasMarkup) capture.blocks = parseTextBlocks(source);
  return ok(capture);
}

/**
 * Strategy 6 — manual entry.
 *
 * @param {{title?: string, text?: string, blocks?: ContentBlock[], sourceUrl?: string|null, meta?: Record<string,string>, kind?: 'document'|'html'|'image'}} input
 * @param {{clock: () => string}} deps
 * @returns {import('../core/result.js').Result<RawCapture>}
 */
export function importManual(input, deps = /** @type {any} */ ({})) {
  let capturedAt;
  try { capturedAt = now(deps); } catch (e) { return err(e instanceof Error ? e.message : String(e)); }

  const source = input || {};
  const blocks = Array.isArray(source.blocks) && source.blocks.length
    ? source.blocks.slice()
    : parseTextBlocks(source.text || '');
  const title = (source.title || '').trim() || firstHeading(blocks) || 'Untitled entry';

  if (!blocks.length) {
    return err('Nothing to import — type or paste some content first.');
  }

  /** @type {Record<string,string>} */
  const meta = { title, ...(source.meta || {}) };
  return ok(makeCapture({
    kind: source.kind || 'document',
    sourceUrl: source.sourceUrl === undefined ? null : source.sourceUrl,
    capturedAt,
    html: null,
    doc: null,
    blocks,
    assets: [],
    meta,
    strategy: 'manual-entry',
  }));
}

/**
 * @param {ContentBlock[]} blocks
 * @returns {string|null}
 */
function firstHeading(blocks) {
  for (const b of blocks) if (b.type === 'heading' && b.text.trim()) return b.text.trim();
  for (const b of blocks) if (b.type === 'paragraph' && b.text.trim()) return b.text.trim().slice(0, 80);
  return null;
}

/**
 * @param {string} s
 * @returns {string}
 */
function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// Plain-text → ContentBlock[]
// ---------------------------------------------------------------------------

const BULLET = /^\s*[-*+•]\s+(.*)$/;
const ORDERED = /^\s*(\d+)[.)]\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const TABLE_ROW = /^\s*\|(.*)\|\s*$/;
const TABLE_RULE = /^\s*\|?[\s:-]*-[\s|:-]*\|?\s*$/;
const CTA_ONLY = /^\s*\[([^\]]+)\]\(([^)\s]+)\)\s*$/;
const ATTRIBUTION = /^\s*[—–-]{1,2}\s*(.+)$/;
const HORIZONTAL_RULE = /^\s*([-*_])\1{2,}\s*$/;

/**
 * Turn typed text into content blocks. Deterministic, and lossless in the sense
 * that every non-empty line ends up in exactly one block.
 *
 * @param {string} text
 * @returns {ContentBlock[]}
 */
export function parseTextBlocks(text) {
  const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
  /** @type {ContentBlock[]} */
  const blocks = [];
  let i = 0;

  /** @param {string[]} buffer */
  const flushParagraph = (buffer) => {
    const joined = buffer.join(' ').replace(/\s+/g, ' ').trim();
    if (joined) blocks.push({ type: 'paragraph', text: joined });
  };

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i += 1; continue; }

    if (HORIZONTAL_RULE.test(line)) { i += 1; continue; }

    const heading = line.match(HEADING);
    if (heading) {
      const level = /** @type {1|2|3|4|5|6} */ (Math.min(6, heading[1].length));
      const value = heading[2].replace(/\s*#+\s*$/, '').trim();
      if (value) blocks.push({ type: 'heading', level, text: value });
      i += 1;
      continue;
    }

    // Setext heading: a line of text underlined with === or ---.
    if (i + 1 < lines.length && lines[i + 1] && /^\s*(=+|-{2,})\s*$/.test(lines[i + 1]) && line.trim() && !BULLET.test(line)) {
      const level = /** @type {1|2} */ (lines[i + 1].trim().startsWith('=') ? 1 : 2);
      blocks.push({ type: 'heading', level, text: line.trim() });
      i += 2;
      continue;
    }

    const cta = line.match(CTA_ONLY);
    if (cta) {
      blocks.push({ type: 'cta', label: cta[1].trim(), href: cta[2].trim() });
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      /** @type {string[]} */
      const quoteLines = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        quoteLines.push(/** @type {RegExpMatchArray} */ (lines[i].match(QUOTE))[1]);
        i += 1;
      }
      let attribution;
      while (quoteLines.length && !quoteLines[quoteLines.length - 1].trim()) quoteLines.pop();
      const last = quoteLines[quoteLines.length - 1] || '';
      const m = last.match(ATTRIBUTION);
      if (m && quoteLines.length > 1) { attribution = m[1].trim(); quoteLines.pop(); }
      const body = quoteLines.join(' ').replace(/\s+/g, ' ').trim();
      if (body) {
        blocks.push(attribution ? { type: 'quote', text: body, attribution } : { type: 'quote', text: body });
      }
      continue;
    }

    if (TABLE_ROW.test(line)) {
      /** @type {string[][]} */
      const rows = [];
      let header = false;
      let rowIndex = 0;
      while (i < lines.length && TABLE_ROW.test(lines[i])) {
        if (TABLE_RULE.test(lines[i]) && rowIndex === 1) { header = true; i += 1; continue; }
        const cells = /** @type {RegExpMatchArray} */ (lines[i].match(TABLE_ROW))[1]
          .split('|')
          .map((c) => c.trim());
        rows.push(cells);
        rowIndex += 1;
        i += 1;
      }
      if (rows.length) blocks.push({ type: 'table', rows, header });
      continue;
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      const ordered = !BULLET.test(line);
      /** @type {string[]} */
      const items = [];
      while (i < lines.length) {
        const bullet = lines[i].match(BULLET);
        const number = lines[i].match(ORDERED);
        if (bullet && !ordered) { items.push(bullet[1].trim()); i += 1; continue; }
        if (number && ordered) { items.push(number[2].trim()); i += 1; continue; }
        // A continuation line indented under the previous item belongs to it.
        if (items.length && /^\s{2,}\S/.test(lines[i]) && !BULLET.test(lines[i]) && !ORDERED.test(lines[i])) {
          items[items.length - 1] = `${items[items.length - 1]} ${lines[i].trim()}`;
          i += 1;
          continue;
        }
        break;
      }
      if (items.length) blocks.push({ type: 'list', ordered, items: items.filter(Boolean) });
      continue;
    }

    /** @type {string[]} */
    const paragraph = [];
    while (i < lines.length && lines[i].trim()
      && !HEADING.test(lines[i]) && !BULLET.test(lines[i]) && !ORDERED.test(lines[i])
      && !QUOTE.test(lines[i]) && !TABLE_ROW.test(lines[i]) && !CTA_ONLY.test(lines[i])
      && !HORIZONTAL_RULE.test(lines[i])) {
      if (i + 1 < lines.length && /^\s*(=+|-{2,})\s*$/.test(lines[i + 1] || '') && paragraph.length === 0) break;
      paragraph.push(lines[i].trim());
      i += 1;
    }
    if (!paragraph.length) { i += 1; continue; }
    flushParagraph(paragraph);
  }

  return blocks;
}
