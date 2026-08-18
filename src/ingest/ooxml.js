/**
 * OOXML import (§6.5) — `.docx` and `.pptx`, read directly.
 *
 * §1.1.3 forbids CMS and platform integrations, so the only way a prospect's
 * deck or one-pager reaches a proof is as a file the seller already has. Both
 * formats are ZIP archives of XML parts, and `src/core/zip.js` already owns the
 * container, so reading them costs no dependency and works identically in Node
 * and the browser.
 *
 * What comes out:
 *   `.docx` — paragraphs, headings resolved through the style table, numbered
 *             and bulleted lists grouped into single list blocks, tables with a
 *             header row decision, hyperlinks, and embedded media in document
 *             order with their alt text.
 *   `.pptx` — one section per slide in presentation order (read from
 *             `p:sldIdLst`, never from filename sort), title placeholders as
 *             headings, body placeholders as paragraphs or lists, tables,
 *             pictures, and speaker notes.
 *
 * @module ingest/ooxml
 */

import { ok, err } from '../core/result.js';
import { ZipArchive, ooxmlKind, readRelationships, mimeForPart } from '../core/zip.js';
import { makeCapture, now } from './capture.js';
import { parseXml, walkXml, findAll, findFirst, childNamed, childrenNamed, xmlAttr, xmlTextOf } from './xml.js';

/**
 * @typedef {import('./capture.js').RawCapture} RawCapture
 * @typedef {import('./capture.js').CaptureAsset} CaptureAsset
 * @typedef {import('../core/contracts.js').ContentBlock} ContentBlock
 * @typedef {import('./xml.js').XmlNode} XmlNode
 */

/**
 * Import a `.docx` or `.pptx`.
 *
 * @param {Uint8Array} bytes
 * @param {{name?: string, clock: () => string, sourceUrl?: string|null}} deps
 * @returns {import('../core/result.js').Result<RawCapture>}
 */
export function importOoxml(bytes, deps = /** @type {any} */ ({})) {
  let capturedAt;
  try { capturedAt = now(deps); } catch (e) { return err(e instanceof Error ? e.message : String(e)); }

  const name = deps.name || 'document';
  if (!(bytes instanceof Uint8Array) || bytes.length < 4) return err(`"${name}" is empty.`);

  /** @type {ZipArchive} */
  let zip;
  try {
    zip = new ZipArchive(bytes);
  } catch (e) {
    return err(`"${name}" is not a readable Office file — the ZIP container could not be opened.`, {
      cause: e instanceof Error ? e.message : String(e),
    });
  }

  const kind = ooxmlKind(zip);
  try {
    if (kind === 'docx') return ok(readDocx(zip, { name, capturedAt, sourceUrl: deps.sourceUrl || null }));
    if (kind === 'pptx') return ok(readPptx(zip, { name, capturedAt, sourceUrl: deps.sourceUrl || null }));
  } catch (e) {
    return err(`"${name}" could not be read: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
  if (kind === 'xlsx') {
    return err(`"${name}" is a spreadsheet. PitchProof ingests documents and decks; export the sheet as a PDF or paste the numbers you want to show.`);
  }
  return err(`"${name}" is a ZIP archive but not a Word document or a PowerPoint deck.`);
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/**
 * Every media part in the archive, as assets. Unreferenced media is kept: a
 * logo that only a slide master uses is exactly what L5 wants.
 * @param {ZipArchive} zip
 * @param {string} prefix
 * @returns {CaptureAsset[]}
 */
function mediaAssets(zip, prefix) {
  return zip.match((n) => n.startsWith(prefix)).map((entry) => ({
    name: entry.name,
    bytes: /** @type {Uint8Array} */ (zip.bytesOf(entry.name)),
    mime: mimeForPart(entry.name),
    aliases: [entry.name.split('/').pop() || entry.name],
  }));
}

/**
 * Collapse the whitespace a word processor leaves behind without destroying
 * deliberate spacing inside a run.
 * @param {string} s
 * @returns {string}
 */
function tidy(s) { return String(s).replace(/[\t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim(); }

// ---------------------------------------------------------------------------
// .docx
// ---------------------------------------------------------------------------

/**
 * Style id → resolved style facts.
 * @param {ZipArchive} zip
 * @returns {Map<string, {name: string, outlineLevel: number|null, basedOn: string|null}>}
 */
function readStyles(zip) {
  /** @type {Map<string, {name: string, outlineLevel: number|null, basedOn: string|null}>} */
  const styles = new Map();
  const xml = zip.textOf('word/styles.xml');
  if (!xml) return styles;
  const doc = parseXml(xml);
  for (const style of findAll(doc, 'w:style')) {
    const id = xmlAttr(style, 'w:styleId');
    if (!id) continue;
    const nameNode = childNamed(style, 'w:name');
    const outline = findFirst(style, 'w:outlineLvl');
    const basedOn = childNamed(style, 'w:basedOn');
    styles.set(id, {
      name: (nameNode && xmlAttr(nameNode, 'w:val')) || id,
      outlineLevel: outline ? Number(xmlAttr(outline, 'w:val')) : null,
      basedOn: basedOn ? xmlAttr(basedOn, 'w:val') : null,
    });
  }
  return styles;
}

/**
 * Heading level for a paragraph style, or null when it is body text.
 * @param {string|null} styleId
 * @param {Map<string, {name: string, outlineLevel: number|null, basedOn: string|null}>} styles
 * @returns {1|2|3|4|5|6|null}
 */
export function headingLevelForStyle(styleId, styles) {
  if (!styleId) return null;
  /** @type {Set<string>} */
  const seen = new Set();
  let current = styleId;
  while (current && !seen.has(current)) {
    seen.add(current);
    const style = styles.get(current);
    const label = (style ? style.name : current).toLowerCase().replace(/[_\s-]+/g, '');
    const m = label.match(/^heading([1-6])$/);
    if (m) return /** @type {1|2|3|4|5|6} */ (Number(m[1]));
    if (label === 'title') return 1;
    if (label === 'subtitle') return 2;
    if (style && style.outlineLevel !== null && Number.isFinite(style.outlineLevel) && style.outlineLevel >= 0 && style.outlineLevel <= 5) {
      return /** @type {1|2|3|4|5|6} */ (style.outlineLevel + 1);
    }
    current = style ? style.basedOn : null;
  }
  return null;
}

/**
 * numId → whether that list is ordered, resolved through the abstract numbering
 * definition the way Word actually resolves it.
 * @param {ZipArchive} zip
 * @returns {Map<string, boolean>}
 */
function readNumberingOrdered(zip) {
  /** @type {Map<string, boolean>} */
  const ordered = new Map();
  const xml = zip.textOf('word/numbering.xml');
  if (!xml) return ordered;
  const doc = parseXml(xml);
  /** @type {Map<string, string>} */
  const abstractFormats = new Map();
  for (const abstract of findAll(doc, 'w:abstractNum')) {
    const id = xmlAttr(abstract, 'w:abstractNumId');
    if (!id) continue;
    const levels = childrenNamed(abstract, 'w:lvl');
    const level0 = levels.find((l) => xmlAttr(l, 'w:ilvl') === '0') || levels[0];
    const fmt = level0 ? childNamed(level0, 'w:numFmt') : null;
    abstractFormats.set(id, (fmt && xmlAttr(fmt, 'w:val')) || 'bullet');
  }
  for (const num of findAll(doc, 'w:num')) {
    const id = xmlAttr(num, 'w:numId');
    const ref = childNamed(num, 'w:abstractNumId');
    if (!id) continue;
    const fmt = ref ? abstractFormats.get(xmlAttr(ref, 'w:val') || '') : undefined;
    ordered.set(id, fmt !== undefined && fmt !== 'bullet' && fmt !== 'none');
  }
  return ordered;
}

/**
 * Walk a paragraph in document order, producing its text and the media and
 * links it carries. In-order matters: an image between two sentences belongs
 * between them, not appended after the paragraph.
 *
 * @param {XmlNode} paragraph
 * @param {Map<string, {type: string, target: string, external: boolean}>} rels
 * @returns {{text: string, links: {text: string, href: string}[], images: {target: string, alt: string|null}[], bold: boolean}}
 */
export function docxParagraphContent(paragraph, rels) {
  let text = '';
  /** @type {{text: string, href: string}[]} */
  const links = [];
  /** @type {{target: string, alt: string|null}[]} */
  const images = [];
  let runs = 0;
  let boldRuns = 0;
  /** @type {{node: XmlNode, href: string, from: number}[]} */
  const linkStack = [];

  walkXml(paragraph, (node) => {
    if (node.type !== 'element') return undefined;
    switch (node.name) {
      case 'w:t':
        text += xmlTextOf(node);
        return false;
      case 'w:tab':
        text += '\t';
        return false;
      case 'w:br':
      case 'w:cr':
        text += '\n';
        return false;
      case 'w:noBreakHyphen':
        text += '-';
        return false;
      case 'w:sym': {
        const char = xmlAttr(node, 'w:char');
        if (char) {
          const cp = parseInt(char, 16);
          // Symbol-font private-use codepoints carry no meaning outside their
          // font; a bullet is the honest reading of the common ones.
          if (Number.isFinite(cp)) text += cp >= 0xf000 && cp <= 0xf0ff ? '•' : String.fromCodePoint(cp);
        }
        return false;
      }
      case 'w:r': {
        runs += 1;
        const rPr = childNamed(node, 'w:rPr');
        if (rPr) {
          const b = childNamed(rPr, 'w:b');
          if (b && xmlAttr(b, 'w:val') !== '0' && xmlAttr(b, 'w:val') !== 'false') boldRuns += 1;
        }
        return undefined;
      }
      case 'w:hyperlink': {
        const id = xmlAttr(node, 'r:id');
        const anchor = xmlAttr(node, 'w:anchor');
        const rel = id ? rels.get(id) : undefined;
        const href = rel ? rel.target : (anchor ? `#${anchor}` : '');
        if (href) linkStack.push({ node, href, from: text.length });
        return undefined;
      }
      case 'a:blip': {
        const id = xmlAttr(node, 'r:embed') || xmlAttr(node, 'r:link');
        const rel = id ? rels.get(id) : undefined;
        if (rel && !rel.external) {
          const container = ancestorNamed(node, 'w:drawing') || ancestorNamed(node, 'w:pict');
          const docPr = container ? findFirst(container, 'wp:docPr') : null;
          const alt = docPr ? (xmlAttr(docPr, 'descr') || xmlAttr(docPr, 'title') || xmlAttr(docPr, 'name')) : null;
          images.push({ target: rel.target, alt });
        }
        return false;
      }
      case 'v:imagedata': {
        const id = xmlAttr(node, 'r:id');
        const rel = id ? rels.get(id) : undefined;
        if (rel && !rel.external) images.push({ target: rel.target, alt: xmlAttr(node, 'o:title') });
        return false;
      }
      default:
        return undefined;
    }
  });

  // Close any hyperlink spans now that the text is complete.
  for (const link of linkStack) {
    const label = tidy(xmlTextOf(link.node));
    if (label) links.push({ text: label, href: link.href });
  }

  return { text, links, images, bold: runs > 0 && boldRuns === runs };
}

/**
 * @param {XmlNode} node
 * @param {string} name
 * @returns {XmlNode|null}
 */
function ancestorNamed(node, name) {
  let p = node.parent;
  while (p) {
    if (p.name === name) return p;
    p = p.parent || null;
  }
  return null;
}

/**
 * Read a `w:tbl` into a table block.
 * @param {XmlNode} table
 * @param {Map<string, {type: string, target: string, external: boolean}>} rels
 * @returns {ContentBlock|null}
 */
function docxTable(table, rels) {
  /** @type {string[][]} */
  const rows = [];
  let headerDeclared = false;
  let firstRowAllBold = true;
  let sawFirstRow = false;

  for (const tr of childrenNamed(table, 'w:tr')) {
    const trPr = childNamed(tr, 'w:trPr');
    if (trPr && childNamed(trPr, 'w:tblHeader')) headerDeclared = true;
    /** @type {string[]} */
    const cells = [];
    for (const tc of childrenNamed(tr, 'w:tc')) {
      const parts = childrenNamed(tc, 'w:p').map((p) => tidy(docxParagraphContent(p, rels).text));
      const value = parts.filter(Boolean).join(' ');
      cells.push(value);
      if (!sawFirstRow) {
        const bold = childrenNamed(tc, 'w:p').every((p) => docxParagraphContent(p, rels).bold);
        if (!bold || !value) firstRowAllBold = false;
      }
    }
    if (cells.length) rows.push(cells);
    sawFirstRow = true;
  }
  if (!rows.length) return null;
  return { type: 'table', rows, header: headerDeclared || (rows.length > 1 && firstRowAllBold) };
}

/**
 * @param {ZipArchive} zip
 * @param {{name: string, capturedAt: string, sourceUrl: string|null}} options
 * @returns {RawCapture}
 */
function readDocx(zip, options) {
  const xml = zip.textOf('word/document.xml');
  if (!xml) throw new Error('word/document.xml is missing');
  const doc = parseXml(xml);
  const rels = readRelationships(zip, 'word/document.xml');
  const styles = readStyles(zip);
  const ordered = readNumberingOrdered(zip);
  const body = findFirst(doc, 'w:body');

  /** @type {ContentBlock[]} */
  const blocks = [];
  /** @type {Set<string>} */
  const usedMedia = new Set();
  /** @type {{items: string[], ordered: boolean, numId: string}|null} */
  let openList = null;

  const closeList = () => {
    if (openList && openList.items.length) {
      blocks.push({ type: 'list', ordered: openList.ordered, items: openList.items });
    }
    openList = null;
  };

  /** @param {XmlNode[]} nodes */
  const emit = (nodes) => {
    for (const node of nodes) {
      if (node.type !== 'element') continue;
      if (node.name === 'w:sdt') {
        const content = childNamed(node, 'w:sdtContent');
        if (content) emit(content.children || []);
        continue;
      }
      if (node.name === 'w:tbl') {
        closeList();
        const table = docxTable(node, rels);
        if (table) blocks.push(table);
        continue;
      }
      if (node.name !== 'w:p') continue;

      const pPr = childNamed(node, 'w:pPr');
      const pStyle = pPr ? childNamed(pPr, 'w:pStyle') : null;
      const styleId = pStyle ? xmlAttr(pStyle, 'w:val') : null;
      const numPr = pPr ? childNamed(pPr, 'w:numPr') : null;
      const numIdNode = numPr ? childNamed(numPr, 'w:numId') : null;
      const numId = numIdNode ? xmlAttr(numIdNode, 'w:numId') || xmlAttr(numIdNode, 'w:val') : null;

      const content = docxParagraphContent(node, rels);
      const text = tidy(content.text);

      for (const image of content.images) {
        closeList();
        usedMedia.add(image.target);
        blocks.push(image.alt ? { type: 'media', ref: image.target, caption: image.alt } : { type: 'media', ref: image.target });
      }

      if (!text) continue;

      if (numId) {
        const isOrdered = ordered.get(numId) === true;
        if (!openList || openList.numId !== numId) { closeList(); openList = { items: [], ordered: isOrdered, numId }; }
        openList.items.push(text);
        continue;
      }
      closeList();

      const level = headingLevelForStyle(styleId, styles);
      if (level) { blocks.push({ type: 'heading', level, text }); continue; }

      // A paragraph that is nothing but one hyperlink is a call to action.
      if (content.links.length === 1 && tidy(content.links[0].text) === text) {
        blocks.push({ type: 'cta', label: text, href: content.links[0].href || null });
        continue;
      }

      const quoteStyle = styleId ? (styles.get(styleId) || { name: styleId }).name.toLowerCase() : '';
      if (/quote/.test(quoteStyle)) { blocks.push({ type: 'quote', text }); continue; }

      blocks.push({ type: 'paragraph', text });
    }
  };

  emit(body ? body.children || [] : []);
  closeList();

  const assets = mediaAssets(zip, 'word/media/');
  /** @type {Record<string,string>} */
  const meta = {
    'ooxml.kind': 'docx',
    'ooxml.file': options.name,
    'ooxml.mediaUsed': String(usedMedia.size),
  };
  Object.assign(meta, coreProperties(zip));
  if (!meta.title) {
    const firstHeading = blocks.find((b) => b.type === 'heading');
    meta.title = firstHeading && firstHeading.type === 'heading' ? firstHeading.text : titleFromName(options.name);
  }

  return makeCapture({
    kind: 'document',
    sourceUrl: options.sourceUrl,
    capturedAt: options.capturedAt,
    html: null,
    doc: null,
    blocks,
    assets,
    meta,
    strategy: 'file-import',
  });
}

// ---------------------------------------------------------------------------
// .pptx
// ---------------------------------------------------------------------------

/**
 * Slide parts in presentation order, read from `p:sldIdLst` rather than from a
 * filename sort — `slide10.xml` sorts before `slide2.xml`, and a deck presented
 * in the wrong order is a defect a client will notice before the seller does.
 * @param {ZipArchive} zip
 * @returns {string[]}
 */
export function slideOrder(zip) {
  const xml = zip.textOf('ppt/presentation.xml');
  const rels = readRelationships(zip, 'ppt/presentation.xml');
  /** @type {string[]} */
  const order = [];
  if (xml) {
    const doc = parseXml(xml);
    for (const sldId of findAll(doc, 'p:sldId')) {
      const id = xmlAttr(sldId, 'r:id');
      const rel = id ? rels.get(id) : undefined;
      if (rel && zip.has(rel.target)) order.push(rel.target);
    }
  }
  if (order.length) return order;
  // A deck with a damaged presentation part still has its slides.
  return zip
    .match((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .map((e) => e.name)
    .sort((a, b) => slideNumber(a) - slideNumber(b));
}

/**
 * @param {string} name
 * @returns {number}
 */
function slideNumber(name) {
  const m = name.match(/slide(\d+)\.xml$/);
  return m ? Number(m[1]) : 0;
}

/**
 * The reading position of a shape, from its transform. Decks are authored in
 * z-order, which is not reading order; sorting by position is what makes the
 * extracted text scan like the slide looks.
 * @param {XmlNode} shape
 * @returns {{y: number, x: number}|null}
 */
function shapePosition(shape) {
  const xfrm = findFirst(shape, 'a:xfrm');
  const off = xfrm ? childNamed(xfrm, 'a:off') : null;
  if (!off) return null;
  const x = Number(xmlAttr(off, 'x'));
  const y = Number(xmlAttr(off, 'y'));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

/**
 * The placeholder type of a shape (`title`, `ctrTitle`, `body`, `subTitle`, …).
 * @param {XmlNode} shape
 * @returns {string|null}
 */
function placeholderType(shape) {
  const ph = findFirst(shape, 'p:ph');
  return ph ? (xmlAttr(ph, 'type') || 'body') : null;
}

/**
 * Text of one `a:p`, with its bullet facts.
 * @param {XmlNode} paragraph
 * @returns {{text: string, level: number, bullet: 'char'|'auto'|'none'|null}}
 */
export function pptxParagraph(paragraph) {
  let text = '';
  walkXml(paragraph, (node) => {
    if (node.type !== 'element') return undefined;
    if (node.name === 'a:t') { text += xmlTextOf(node); return false; }
    if (node.name === 'a:br') { text += '\n'; return false; }
    return undefined;
  });
  const pPr = childNamed(paragraph, 'a:pPr');
  const level = pPr ? Number(xmlAttr(pPr, 'lvl') || 0) : 0;
  /** @type {'char'|'auto'|'none'|null} */
  let bullet = null;
  if (pPr) {
    if (childNamed(pPr, 'a:buNone')) bullet = 'none';
    else if (childNamed(pPr, 'a:buAutoNum')) bullet = 'auto';
    else if (childNamed(pPr, 'a:buChar')) bullet = 'char';
  }
  return { text: tidy(text), level: Number.isFinite(level) ? level : 0, bullet };
}

/**
 * Read a slide's shapes into blocks.
 * @param {XmlNode} slide
 * @param {Map<string, {type: string, target: string, external: boolean}>} rels
 * @param {Set<string>} usedMedia
 * @returns {{title: string|null, blocks: ContentBlock[]}}
 */
function pptxSlideBlocks(slide, rels, usedMedia) {
  const tree = findFirst(slide, 'p:spTree') || slide;
  /** @type {{node: XmlNode, kind: 'sp'|'pic'|'graphicFrame', index: number}[]} */
  const shapes = [];
  (tree.children || []).forEach((node, index) => {
    if (node.type !== 'element') return;
    if (node.name === 'p:sp') shapes.push({ node, kind: 'sp', index });
    else if (node.name === 'p:pic') shapes.push({ node, kind: 'pic', index });
    else if (node.name === 'p:graphicFrame') shapes.push({ node, kind: 'graphicFrame', index });
    else if (node.name === 'p:grpSp') {
      for (const inner of findAll(node, 'p:sp')) shapes.push({ node: inner, kind: 'sp', index });
      for (const inner of findAll(node, 'p:pic')) shapes.push({ node: inner, kind: 'pic', index });
      for (const inner of findAll(node, 'p:graphicFrame')) shapes.push({ node: inner, kind: 'graphicFrame', index });
    }
  });

  /** @type {string|null} */
  let title = null;
  /** @type {{sort: number[], index: number, blocks: ContentBlock[]}[]} */
  const parts = [];

  for (const shape of shapes) {
    const ph = shape.kind === 'sp' ? placeholderType(shape.node) : null;
    const isTitle = ph === 'title' || ph === 'ctrTitle';
    const position = shapePosition(shape.node);
    const sort = position ? [0, position.y, position.x] : [1, 0, 0];

    if (shape.kind === 'pic') {
      const blip = findFirst(shape.node, 'a:blip');
      const id = blip ? (xmlAttr(blip, 'r:embed') || xmlAttr(blip, 'r:link')) : null;
      const rel = id ? rels.get(id) : undefined;
      if (rel && !rel.external) {
        usedMedia.add(rel.target);
        const cNvPr = findFirst(shape.node, 'p:cNvPr');
        const alt = cNvPr ? (xmlAttr(cNvPr, 'descr') || xmlAttr(cNvPr, 'title') || null) : null;
        parts.push({
          sort,
          index: shape.index,
          blocks: [alt ? { type: 'media', ref: rel.target, caption: alt } : { type: 'media', ref: rel.target }],
        });
      }
      continue;
    }

    if (shape.kind === 'graphicFrame') {
      const tbl = findFirst(shape.node, 'a:tbl');
      if (tbl) {
        /** @type {string[][]} */
        const rows = [];
        for (const tr of findAll(tbl, 'a:tr')) {
          const cells = findAll(tr, 'a:tc').map((tc) => {
            const txBody = findFirst(tc, 'a:txBody');
            return txBody ? findAll(txBody, 'a:p').map((p) => pptxParagraph(p).text).filter(Boolean).join(' ') : '';
          });
          if (cells.length) rows.push(cells);
        }
        if (rows.length) {
          const firstRow = findFirst(tbl, 'a:tblPr');
          const declaredHeader = firstRow ? xmlAttr(firstRow, 'firstRow') === '1' : false;
          parts.push({ sort, index: shape.index, blocks: [{ type: 'table', rows, header: declaredHeader || rows.length > 1 }] });
        }
        continue;
      }
      // Charts and SmartArt carry their labels as ordinary text runs.
      const texts = findAll(shape.node, 'a:t').map((t) => tidy(xmlTextOf(t))).filter(Boolean);
      if (texts.length) parts.push({ sort, index: shape.index, blocks: [{ type: 'list', ordered: false, items: dedupe(texts) }] });
      continue;
    }

    const txBody = childNamed(shape.node, 'p:txBody');
    if (!txBody) continue;
    const paragraphs = findAll(txBody, 'a:p').map(pptxParagraph).filter((p) => p.text);
    if (!paragraphs.length) continue;

    if (isTitle) {
      const value = paragraphs.map((p) => p.text).join(' ');
      if (!title) title = value;
      parts.push({ sort: [-1, 0, 0], index: shape.index, blocks: [{ type: 'heading', level: 2, text: value }] });
      continue;
    }

    /** @type {ContentBlock[]} */
    const shapeBlocks = [];
    /** @type {string[]} */
    let listItems = [];
    let listOrdered = false;
    const bodyPlaceholder = ph === 'body' || ph === 'subTitle' || ph === 'obj' || ph === null;

    const flushList = () => {
      if (listItems.length) shapeBlocks.push({ type: 'list', ordered: listOrdered, items: listItems });
      listItems = [];
      listOrdered = false;
    };

    for (const p of paragraphs) {
      // PowerPoint bullets body placeholders by default; the markup only says
      // so when the author changed it. Indentation is the other tell.
      const bulleted = p.bullet === 'char' || p.bullet === 'auto'
        || (p.bullet === null && p.level > 0)
        || (p.bullet === null && bodyPlaceholder && paragraphs.length > 1);
      if (!bulleted) { flushList(); shapeBlocks.push({ type: 'paragraph', text: p.text }); continue; }
      const ordered = p.bullet === 'auto';
      if (listItems.length && ordered !== listOrdered) flushList();
      listOrdered = ordered;
      // Sub-levels are flattened: the §4 `list` block has no nesting, and §18.3
      // forbids modifying the prospect's own copy, so no indent marker is
      // injected into the text either.
      listItems.push(p.text);
    }
    flushList();
    if (shapeBlocks.length) parts.push({ sort, index: shape.index, blocks: shapeBlocks });
  }

  parts.sort((a, b) => {
    for (let i = 0; i < 3; i++) {
      if (a.sort[i] !== b.sort[i]) return a.sort[i] - b.sort[i];
    }
    return a.index - b.index;
  });

  /** @type {ContentBlock[]} */
  const blocks = [];
  for (const part of parts) blocks.push(...part.blocks);
  return { title, blocks };
}

/**
 * @param {ZipArchive} zip
 * @param {{name: string, capturedAt: string, sourceUrl: string|null}} options
 * @returns {RawCapture}
 */
function readPptx(zip, options) {
  const slides = slideOrder(zip);
  if (!slides.length) throw new Error('the deck contains no slides');

  /** @type {ContentBlock[]} */
  const blocks = [];
  /** @type {Record<string,string>} */
  const meta = {
    'ooxml.kind': 'pptx',
    'ooxml.file': options.name,
    'pptx.slides': String(slides.length),
  };
  Object.assign(meta, coreProperties(zip));
  /** @type {Set<string>} */
  const usedMedia = new Set();

  slides.forEach((part, index) => {
    const xml = zip.textOf(part);
    if (!xml) return;
    const slide = parseXml(xml);
    const rels = readRelationships(zip, part);
    const { title, blocks: slideBlocks } = pptxSlideBlocks(slide, rels, usedMedia);
    const number = index + 1;

    if (!title) blocks.push({ type: 'heading', level: 2, text: `Slide ${number}` });
    blocks.push(...slideBlocks);
    meta[`slide.${number}.title`] = title || '';
    meta[`slide.${number}.part`] = part;

    for (const [, rel] of rels) {
      if (!rel.type.endsWith('/notesSlide') || rel.external) continue;
      const notesXml = zip.textOf(rel.target);
      if (!notesXml) continue;
      const notes = parseXml(notesXml);
      /** @type {string[]} */
      const lines = [];
      for (const sp of findAll(notes, 'p:sp')) {
        if (placeholderType(sp) === 'sldNum') continue;
        const txBody = childNamed(sp, 'p:txBody');
        if (!txBody) continue;
        for (const p of findAll(txBody, 'a:p')) {
          const text = pptxParagraph(p).text;
          if (text) lines.push(text);
        }
      }
      if (lines.length) meta[`slide.${number}.notes`] = lines.join('\n');
    }
  });

  if (!meta.title) {
    const firstTitle = meta['slide.1.title'];
    meta.title = firstTitle || titleFromName(options.name);
  }
  meta['ooxml.mediaUsed'] = String(usedMedia.size);

  return makeCapture({
    kind: 'document',
    sourceUrl: options.sourceUrl,
    capturedAt: options.capturedAt,
    html: null,
    doc: null,
    blocks,
    assets: mediaAssets(zip, 'ppt/media/'),
    meta,
    strategy: 'file-import',
  });
}

// ---------------------------------------------------------------------------
// Shared metadata
// ---------------------------------------------------------------------------

/**
 * `docProps/core.xml` — the document's own title, author and language.
 * @param {ZipArchive} zip
 * @returns {Record<string,string>}
 */
export function coreProperties(zip) {
  /** @type {Record<string,string>} */
  const out = {};
  const xml = zip.textOf('docProps/core.xml');
  if (!xml) return out;
  const doc = parseXml(xml);
  const read = (tag, key) => {
    const node = findFirst(doc, tag);
    const value = node ? tidy(xmlTextOf(node)) : '';
    if (value) out[key] = value;
  };
  read('dc:title', 'title');
  read('dc:subject', 'description');
  read('dc:creator', 'author');
  read('dc:description', 'ooxml.description');
  read('dc:language', 'lang');
  read('cp:keywords', 'keywords');
  read('cp:lastModifiedBy', 'ooxml.lastModifiedBy');
  read('dcterms:modified', 'ooxml.modified');
  read('dcterms:created', 'ooxml.created');
  return out;
}

/**
 * @param {string} name
 * @returns {string}
 */
function titleFromName(name) {
  const base = String(name || 'document').split('/').pop() || 'document';
  return base.replace(/\.(docx|pptx)$/i, '').replace(/[._-]+/g, ' ').trim() || base;
}

/**
 * @template T
 * @param {T[]} items
 * @returns {T[]}
 */
function dedupe(items) { return Array.from(new Set(items)); }
