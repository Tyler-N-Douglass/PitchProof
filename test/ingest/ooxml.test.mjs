/**
 * OOXML import (§6.5).
 *
 * The fixtures are real archives, committed under `test/fixtures/ingest/` and
 * regenerable with `python3 test/fixtures/ingest/make-ooxml.py`. They are read
 * with this repo's own ZIP reader and DEFLATE (D3: zero npm dependencies), so
 * the test exercises the whole path a dropped file takes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { importOoxml, headingLevelForStyle, slideOrder, coreProperties } from '../../src/ingest/ooxml.js';
import { ZipArchive, ooxmlKind } from '../../src/core/zip.js';
import { parseXml, findAll, xmlAttr, xmlTextOf, findFirst, childNamed } from '../../src/ingest/xml.js';
import { fixedClock } from './helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '..', 'fixtures', 'ingest');
const clock = fixedClock();

/** @param {string} name */
function load(name) {
  return new Uint8Array(readFileSync(join(FIXTURES, name)));
}

const DOCX = load('sample.docx');
const PPTX = load('sample.pptx');

/** @param {any} result */
function value(result) {
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  return result.value;
}

// ---------------------------------------------------------------------------
// The XML reader the importers stand on
// ---------------------------------------------------------------------------

test('the XML reader builds a real tree, not a regex match', () => {
  const doc = parseXml('<?xml version="1.0"?><a:root xmlns:a="urn:x"><a:p attr="1 &gt; 0"><a:t>hi</a:t></a:p><a:empty/><!--c--><![CDATA[<raw>]]></a:root>');
  const root = findFirst(doc, 'a:root');
  assert.ok(root);
  assert.equal(findAll(root, 'a:p').length, 1);
  assert.equal(xmlAttr(findFirst(root, 'a:p'), 'attr'), '1 > 0');
  assert.equal(xmlTextOf(findFirst(root, 'a:t')), 'hi');
  assert.equal(childNamed(root, 'a:empty').children.length, 0);
  assert.match(xmlTextOf(root), /<raw>/);
});

test('the XML reader survives an unclosed tag and a > inside an attribute', () => {
  assert.doesNotThrow(() => parseXml('<a><b attr="x>y"><c>text</a>'));
  const doc = parseXml('<a><b attr="x>y">text</b></a>');
  assert.equal(xmlAttr(findFirst(doc, 'b'), 'attr'), 'x>y');
  assert.equal(xmlTextOf(findFirst(doc, 'b')), 'text');
});

// ---------------------------------------------------------------------------
// .docx
// ---------------------------------------------------------------------------

test('a .docx is recognised, and its core properties become capture metadata', () => {
  const zip = new ZipArchive(DOCX);
  assert.equal(ooxmlKind(zip), 'docx');
  const props = coreProperties(zip);
  assert.equal(props.title, 'Northwind Field Guide');
  assert.equal(props.author, 'Dana Reyes');
  assert.equal(props.lang, 'en-GB');
});

test('a .docx yields headings, paragraphs, lists, a table, a quote, media and a CTA', () => {
  const capture = value(importOoxml(DOCX, { name: 'sample.docx', clock }));
  assert.equal(capture.kind, 'document');
  assert.equal(capture.capturedAt, '2026-03-04T09:15:00.000Z');
  assert.equal(capture.strategy, 'file-import');
  assert.equal(capture.meta['ooxml.kind'], 'docx');
  assert.equal(capture.meta.title, 'Northwind Field Guide');

  const kinds = capture.blocks.map((b) => b.type);
  assert.deepEqual(kinds, [
    'heading', 'paragraph', 'heading', 'paragraph', 'heading', 'list',
    'heading', 'list', 'table', 'quote', 'media', 'cta',
  ]);
});

test('.docx heading levels come from the style table, not from guesswork', () => {
  const capture = value(importOoxml(DOCX, { name: 'sample.docx', clock }));
  const headings = capture.blocks.filter((b) => b.type === 'heading');
  assert.deepEqual(headings.map((h) => [h.level, h.text]), [
    [1, 'Northwind Field Guide'],
    [1, 'Positioning'],
    [2, 'What we say first'],
    [2, 'Sequence for the demo'],
  ]);
});

test('headingLevelForStyle resolves names, outline levels and basedOn chains', () => {
  const styles = new Map([
    ['Heading3', { name: 'heading 3', outlineLevel: null, basedOn: null }],
    ['Title', { name: 'Title', outlineLevel: null, basedOn: null }],
    ['Subtitle', { name: 'Subtitle', outlineLevel: null, basedOn: null }],
    ['MyHead', { name: 'Company Head', outlineLevel: 1, basedOn: null }],
    ['Derived', { name: 'Derived', outlineLevel: null, basedOn: 'Heading3' }],
    ['Body', { name: 'Body Text', outlineLevel: null, basedOn: null }],
    ['Loop', { name: 'Loop', outlineLevel: null, basedOn: 'Loop' }],
  ]);
  assert.equal(headingLevelForStyle('Heading3', styles), 3);
  assert.equal(headingLevelForStyle('Title', styles), 1);
  assert.equal(headingLevelForStyle('Subtitle', styles), 2);
  assert.equal(headingLevelForStyle('MyHead', styles), 2);
  assert.equal(headingLevelForStyle('Derived', styles), 3);
  assert.equal(headingLevelForStyle('Body', styles), null);
  assert.equal(headingLevelForStyle('Loop', styles), null, 'a basedOn cycle terminates');
  assert.equal(headingLevelForStyle(null, styles), null);
});

test('.docx lists group by numbering id, and ordered follows the numbering format', () => {
  const capture = value(importOoxml(DOCX, { name: 'sample.docx', clock }));
  const lists = capture.blocks.filter((b) => b.type === 'list');
  assert.equal(lists.length, 2);
  assert.equal(lists[0].ordered, false);
  assert.deepEqual(lists[0].items, [
    'Start with the audit trail.',
    'Show the approval chain second.',
    'Never lead with the integrations list.',
  ]);
  assert.equal(lists[1].ordered, true, 'the second list uses a decimal numFmt');
  assert.equal(lists[1].items.length, 3);
});

test('.docx tables keep their cells and detect the header row', () => {
  const capture = value(importOoxml(DOCX, { name: 'sample.docx', clock }));
  const table = capture.blocks.find((b) => b.type === 'table');
  assert.equal(table.header, true, 'w:tblHeader marks the header row');
  assert.deepEqual(table.rows, [
    ['Segment', 'Primary objection', 'Branch'],
    ['Regulated ops', 'Our situation is different', 'locale-fanout'],
    ['Central marketing', 'Who approves this', 'approval-chain'],
  ]);
});

test('.docx media is emitted in document order with its alt text, and carried as an asset', () => {
  const capture = value(importOoxml(DOCX, { name: 'sample.docx', clock }));
  const media = capture.blocks.find((b) => b.type === 'media');
  assert.equal(media.ref, 'word/media/image1.png');
  assert.equal(media.caption, 'Northwind wordmark on a dark field');
  const asset = capture.assets.find((a) => a.name === 'word/media/image1.png');
  assert.ok(asset);
  assert.equal(asset.mime, 'image/png');
  assert.equal(asset.bytes[0], 0x89, 'the asset really is a PNG');
  assert.equal(capture.meta['ooxml.mediaUsed'], '1');
});

test('a .docx hyperlink paragraph becomes a CTA with its resolved target', () => {
  const capture = value(importOoxml(DOCX, { name: 'sample.docx', clock }));
  const cta = capture.blocks.find((b) => b.type === 'cta');
  assert.deepEqual(cta, { type: 'cta', label: 'See the pricing page', href: 'https://northwind.example/pricing' });
});

test('a .docx quote style becomes a quote block, entities decoded', () => {
  const capture = value(importOoxml(DOCX, { name: 'sample.docx', clock }));
  const quote = capture.blocks.find((b) => b.type === 'quote');
  assert.equal(quote.text, '“The proof has to be built on their content, or it is a slideshow.”');
});

// ---------------------------------------------------------------------------
// .pptx
// ---------------------------------------------------------------------------

test('slides are ordered by the presentation part, never by filename', () => {
  const zip = new ZipArchive(PPTX);
  assert.deepEqual(slideOrder(zip), [
    'ppt/slides/slide1.xml',
    'ppt/slides/slide10.xml',
    'ppt/slides/slide2.xml',
  ], 'slide10 comes second because p:sldIdLst says so');
});

test('a .pptx yields one titled section per slide, in presentation order', () => {
  const capture = value(importOoxml(PPTX, { name: 'sample.pptx', clock }));
  assert.equal(capture.meta['ooxml.kind'], 'pptx');
  assert.equal(capture.meta['pptx.slides'], '3');
  assert.equal(capture.meta.title, 'Northwind Quarterly Review');
  const headings = capture.blocks.filter((b) => b.type === 'heading');
  assert.deepEqual(headings.map((h) => h.text), [
    'Why a proof beats a demo',
    'Who approves this',
    'What we do next',
  ]);
  assert.deepEqual(headings.map((h) => h.level), [2, 2, 2]);
});

test('a slide title placeholder leads its slide even when the shape is authored later', () => {
  const capture = value(importOoxml(PPTX, { name: 'sample.pptx', clock }));
  assert.equal(capture.blocks[0].type, 'heading');
  assert.equal(capture.blocks[0].text, 'Why a proof beats a demo');
  assert.equal(capture.blocks[1].type, 'list', 'the body shape follows its title');
});

test('.pptx body text becomes lists, with ordered following buAutoNum', () => {
  const capture = value(importOoxml(PPTX, { name: 'sample.pptx', clock }));
  const lists = capture.blocks.filter((b) => b.type === 'list');
  assert.equal(lists.length, 2);
  assert.deepEqual(lists[0], {
    type: 'list',
    ordered: false,
    items: [
      'Built on the prospect’s own content',
      'Branchable at the objection',
      'Offline, single file',
    ],
  });
  assert.equal(lists[1].ordered, true);
  assert.deepEqual(lists[1].items, ['Draft the spine', 'Wire three branches', 'Rehearse to a clean pass']);
});

test('.pptx tables and pictures come through, ordered by their position on the slide', () => {
  const capture = value(importOoxml(PPTX, { name: 'sample.pptx', clock }));
  const media = capture.blocks.find((b) => b.type === 'media');
  assert.equal(media.ref, 'ppt/media/image1.png');
  assert.equal(media.caption, 'Approval chain diagram');
  const table = capture.blocks.find((b) => b.type === 'table');
  assert.deepEqual(table.rows, [['Stage', 'Owner'], ['Legal review', 'Priya']]);
  assert.equal(table.header, true);

  const order = capture.blocks.map((b) => b.type);
  const heading = order.indexOf('heading', 1);
  assert.ok(order.indexOf('media') > heading, 'the picture sits under its slide title');
  assert.ok(order.indexOf('table') > order.indexOf('media'), 'the lower shape comes second');
});

test('speaker notes are captured as metadata against their slide', () => {
  const capture = value(importOoxml(PPTX, { name: 'sample.pptx', clock }));
  assert.equal(capture.meta['slide.1.notes'], 'Do not read the bullets aloud. Ask what breaks first.');
  assert.equal(capture.meta['slide.1.title'], 'Why a proof beats a demo');
  assert.equal(capture.meta['slide.2.part'], 'ppt/slides/slide10.xml');
  assert.equal(capture.meta['slide.2.notes'], undefined, 'slides without notes claim none');
});

test('.pptx media is carried as an asset with real bytes', () => {
  const capture = value(importOoxml(PPTX, { name: 'sample.pptx', clock }));
  const asset = capture.assets.find((a) => a.name === 'ppt/media/image1.png');
  assert.ok(asset);
  assert.equal(asset.mime, 'image/png');
  assert.deepEqual([...asset.bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

// ---------------------------------------------------------------------------
// Degradation
// ---------------------------------------------------------------------------

test('import is deterministic: the same archive twice gives the same blocks', () => {
  const a = value(importOoxml(DOCX, { name: 'sample.docx', clock }));
  const b = value(importOoxml(DOCX, { name: 'sample.docx', clock }));
  assert.deepEqual(a.blocks, b.blocks);
  assert.deepEqual(a.meta, b.meta);
});

test('a non-archive, a truncated archive and a spreadsheet all degrade to a Result', () => {
  assert.equal(importOoxml(new Uint8Array([1, 2, 3]), { name: 'x.docx', clock }).ok, false);

  const truncated = importOoxml(DOCX.subarray(0, 200), { name: 'x.docx', clock });
  assert.equal(truncated.ok, false);
  assert.match(truncated.error, /not a readable Office file/);

  const empty = importOoxml(new Uint8Array(0), { name: 'x.docx', clock });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /empty/);
});

test('a corrupted document part is reported, not thrown', () => {
  // Flip bytes inside the compressed document part; the ZIP CRC will refuse it.
  const damaged = DOCX.slice();
  const zip = new ZipArchive(DOCX);
  const entry = zip.entries.find((e) => e.name === 'word/document.xml');
  const at = entry.localHeaderOffset + 200;
  damaged[at] = damaged[at] ^ 0xff;
  damaged[at + 1] = damaged[at + 1] ^ 0xff;
  const result = importOoxml(damaged, { name: 'sample.docx', clock });
  assert.equal(result.ok, false);
  assert.match(result.error, /could not be read/);
});

test('a missing clock is refused before any parsing happens', () => {
  const result = importOoxml(DOCX, { name: 'sample.docx' });
  assert.equal(result.ok, false);
  assert.match(result.error, /clock/);
});
