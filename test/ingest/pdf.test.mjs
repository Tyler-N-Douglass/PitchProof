/**
 * PDF import (§6.5, D9).
 *
 * Two committed fixtures, regenerable with
 * `python3 test/fixtures/ingest/make-pdf.py`, cover the two cross-reference
 * mechanisms and both text paths:
 *
 *   sample.pdf      classic `xref` table, WinAnsi text through a standard-14
 *                   font, a Flate RGB image with a soft mask, and a DCTDecode
 *                   JPEG that must come out byte-identical.
 *   xrefstream.pdf  cross-reference *stream* plus an object stream, and a font
 *                   whose codes mean nothing without its `ToUnicode` CMap.
 *
 * D9's boundary is asserted too: no page is rasterized, and the page-image path
 * is explicit about the pixels being user-supplied.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { importPdf } from '../../src/ingest/pdf/index.js';
import { readPdf, PdfDocument } from '../../src/ingest/pdf/document.js';
import {
  asciiHexDecode, ascii85Decode, runLengthDecode, lzwDecode, applyPredictor, inflatePdf,
} from '../../src/ingest/pdf/filters.js';
import { Lexer, PdfString, Name, Ref, PdfStream } from '../../src/ingest/pdf/lexer.js';
import {
  parseCMap, glyphNameToUnicode, WIN_ANSI_ENCODING, MAC_ROMAN_ENCODING, STANDARD_ENCODING,
} from '../../src/ingest/pdf/encoding.js';
import { multiply, groupLines, linesToBlocks, modalSize, joinLines } from '../../src/ingest/pdf/text.js';
import { encodePngRgb, adler32, samplesToRgb } from '../../src/ingest/pdf/image.js';
import { importPageImages } from '../../src/ingest/image.js';
import { imageSize, sniffMime } from '../../src/ingest/capture.js';
import { fixedClock, tinyPng } from './helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '..', 'fixtures', 'ingest');
const clock = fixedClock();

const SAMPLE = new Uint8Array(readFileSync(join(FIXTURES, 'sample.pdf')));
const XREFSTREAM = new Uint8Array(readFileSync(join(FIXTURES, 'xrefstream.pdf')));

/** @param {any} result */
function value(result) {
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  return result.value;
}

/** @param {Uint8Array} bytes */
function bytesFrom(...values) { return new Uint8Array(values); }

// ---------------------------------------------------------------------------
// Lexer and object model
// ---------------------------------------------------------------------------

test('the lexer reads every PDF object type', () => {
  const src = new TextEncoder().encode('<< /Name /Foo /Num 3.5 /Neg -2 /Arr [1 (str) <414243> /N true false null] /Ref 12 0 R >>');
  const dict = new Lexer(src, 0).parseObject({});
  assert.ok(dict.Name instanceof Name);
  assert.equal(dict.Name.name, 'Foo');
  assert.equal(dict.Num, 3.5);
  assert.equal(dict.Neg, -2);
  assert.equal(dict.Arr[0], 1);
  assert.equal(dict.Arr[1].asText(), 'str');
  assert.equal(dict.Arr[2].asText(), 'ABC');
  assert.equal(dict.Arr[3].name, 'N');
  assert.deepEqual(dict.Arr.slice(4), [true, false, null]);
  assert.ok(dict.Ref instanceof Ref);
  assert.equal(dict.Ref.num, 12);
});

test('literal string escapes, nesting and octal are decoded', () => {
  const src = new TextEncoder().encode(String.raw`(a\(b\) \n \101 \\ (nested) end)`);
  const value_ = new Lexer(src, 0).parseObject({});
  assert.equal(value_.asText(), 'a(b) \n A \\ (nested) end');
});

test('a UTF-16BE text string is decoded through its byte-order mark', () => {
  const bytes = bytesFrom(0xfe, 0xff, 0x00, 0x48, 0x00, 0x69);
  assert.equal(new PdfString(bytes).asText(), 'Hi');
});

test('a name with a # escape resolves', () => {
  const src = new TextEncoder().encode('/A#20B');
  assert.equal(new Lexer(src, 0).parseObject({}).name, 'A B');
});

test('a stream with a wrong /Length still finds its endstream', () => {
  const src = new TextEncoder().encode('<< /Length 9999 >>\nstream\nHELLO\nendstream');
  const stream = new Lexer(src, 0).parseObject({ resolveLength: (v) => (typeof v === 'number' ? v : null) });
  assert.ok(stream instanceof PdfStream);
  assert.equal(new TextDecoder().decode(stream.raw), 'HELLO');
});

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

test('ASCIIHexDecode, ASCII85Decode and RunLengthDecode are exact', () => {
  assert.deepEqual([...asciiHexDecode(new TextEncoder().encode('48 65 6C6C 6F>'))], [...new TextEncoder().encode('Hello')]);
  assert.deepEqual([...ascii85Decode(new TextEncoder().encode('87cURD]j7BEbo80~>'))], [...new TextEncoder().encode('Hello world!')]);
  assert.deepEqual([...ascii85Decode(new TextEncoder().encode('z~>'))], [0, 0, 0, 0]);
  assert.deepEqual([...runLengthDecode(bytesFrom(2, 65, 66, 67, 254, 90, 128))], [65, 66, 67, 90, 90, 90]);
});

test('LZWDecode decodes the specification worked example', () => {
  // From the PDF specification, table 7.8: 45 45 45 45 45 65 45 45 45 66.
  const encoded = bytesFrom(0x80, 0x0b, 0x60, 0x50, 0x22, 0x0c, 0x0c, 0x85, 0x01);
  assert.deepEqual([...lzwDecode(encoded)], [45, 45, 45, 45, 45, 65, 45, 45, 45, 66]);
});

test('the PNG Up predictor is inverted correctly', () => {
  // Two rows of three bytes; the second row is filter type 2 (Up).
  const data = bytesFrom(0, 10, 20, 30, 2, 1, 1, 1);
  const out = applyPredictor(data, { predictor: 12, colors: 1, bitsPerComponent: 8, columns: 3 });
  assert.deepEqual([...out], [10, 20, 30, 11, 21, 31]);
});

test('the TIFF predictor is inverted correctly', () => {
  const data = bytesFrom(10, 5, 5, 20, 1, 1);
  const out = applyPredictor(data, { predictor: 2, colors: 1, bitsPerComponent: 8, columns: 3 });
  assert.deepEqual([...out], [10, 15, 20, 20, 21, 22]);
});

test('inflatePdf accepts both zlib-wrapped and raw deflate streams', () => {
  const raw = new TextEncoder().encode('the quick brown fox jumps over the lazy dog');
  // Stored deflate block, with and without a zlib header.
  const stored = bytesFrom(1, raw.length & 0xff, (raw.length >> 8) & 0xff, ~raw.length & 0xff, (~raw.length >> 8) & 0xff, ...raw);
  assert.deepEqual([...inflatePdf(stored)], [...raw]);
  assert.deepEqual([...inflatePdf(bytesFrom(0x78, 0x01, ...stored, 0, 0, 0, 0))], [...raw]);
});

// ---------------------------------------------------------------------------
// Encodings and CMaps
// ---------------------------------------------------------------------------

test('the three base encodings differ where the specification says they do', () => {
  assert.equal(WIN_ANSI_ENCODING[0x95], '•');
  assert.equal(WIN_ANSI_ENCODING[0x92], '’');
  assert.equal(WIN_ANSI_ENCODING[0x80], '€');
  assert.equal(WIN_ANSI_ENCODING[0xe9], 'é');
  assert.equal(MAC_ROMAN_ENCODING[0xa5], '•');
  assert.equal(MAC_ROMAN_ENCODING[0x8e], 'é');
  assert.equal(STANDARD_ENCODING[39], '’', 'Standard maps 39 to a right quote, WinAnsi to an apostrophe');
  assert.equal(WIN_ANSI_ENCODING[39], "'");
  assert.equal(STANDARD_ENCODING[0xb7], '•');
});

test('glyph names resolve through the glyph list and the algorithmic forms', () => {
  assert.equal(glyphNameToUnicode('eacute'), 'é');
  assert.equal(glyphNameToUnicode('quotedblleft'), '“');
  assert.equal(glyphNameToUnicode('uni20AC'), '€');
  assert.equal(glyphNameToUnicode('u1F600'), '😀');
  assert.equal(glyphNameToUnicode('A.sc'), 'A');
  assert.equal(glyphNameToUnicode('g42'), null, 'a bare glyph index means nothing without a CMap');
});

test('a ToUnicode CMap with bfchar and bfrange is parsed', () => {
  const cmap = parseCMap(new TextEncoder().encode(`
    1 begincodespacerange <00> <FF> endcodespacerange
    2 beginbfchar <01> <0041> <02> <0042> endbfchar
    2 beginbfrange
      <10> <12> <0030>
      <20> <22> [<0058> <0059> <005A>]
    endbfrange
  `));
  assert.deepEqual([...cmap.codeLengths], [1]);
  assert.equal(cmap.single.get(0x01), 'A');
  assert.equal(cmap.single.get(0x02), 'B');
  assert.equal(cmap.single.get(0x10), '0');
  assert.equal(cmap.single.get(0x12), '2');
  assert.equal(cmap.single.get(0x20), 'X');
  assert.equal(cmap.single.get(0x22), 'Z');
});

// ---------------------------------------------------------------------------
// Text geometry
// ---------------------------------------------------------------------------

test('matrix multiplication follows the PDF convention', () => {
  assert.deepEqual(multiply([1, 0, 0, 1, 5, 7], [2, 0, 0, 2, 0, 0]), [2, 0, 0, 2, 10, 14]);
});

test('runs on one baseline become one line, with gaps recovered as spaces', () => {
  const runs = [
    { text: 'Approval', x: 72, y: 700, width: 44, size: 11, font: 'F1', page: 1 },
    { text: 'chains', x: 120, y: 700, width: 30, size: 11, font: 'F1', page: 1 },
    { text: 'hold', x: 72, y: 686, width: 20, size: 11, font: 'F1', page: 1 },
  ];
  const lines = groupLines(runs);
  assert.deepEqual(lines.map((l) => l.text), ['Approval chains', 'hold']);
});

test('lines become paragraphs, headings and lists', () => {
  const lines = [
    { text: 'A headline', x: 72, y: 700, size: 24, page: 1 },
    { text: 'Body copy that wraps', x: 72, y: 668, size: 11, page: 1 },
    { text: 'onto a second line.', x: 72, y: 654, size: 11, page: 1 },
    { text: '• first', x: 72, y: 630, size: 11, page: 1 },
    { text: '• second', x: 72, y: 616, size: 11, page: 1 },
    { text: 'A smaller heading', x: 72, y: 580, size: 16, page: 1 },
    { text: 'More body copy.', x: 72, y: 560, size: 11, page: 1 },
  ];
  const blocks = linesToBlocks(lines);
  assert.deepEqual(blocks, [
    { type: 'heading', level: 1, text: 'A headline' },
    { type: 'paragraph', text: 'Body copy that wraps onto a second line.' },
    { type: 'list', ordered: false, items: ['first', 'second'] },
    { type: 'heading', level: 2, text: 'A smaller heading' },
    { type: 'paragraph', text: 'More body copy.' },
  ]);
});

test('the body size is the size most text is set in, not the largest', () => {
  assert.equal(modalSize([
    { text: 'X'.repeat(200), x: 0, y: 0, size: 11, page: 1 },
    { text: 'Huge', x: 0, y: 40, size: 48, page: 1 },
  ]), 11);
});

test('joinLines repairs hyphenation at a line break', () => {
  assert.equal(joinLines(['govern-', 'ance holds']), 'governance holds');
  assert.equal(joinLines(['one', 'two']), 'one two');
});

// ---------------------------------------------------------------------------
// The classic-xref fixture
// ---------------------------------------------------------------------------

test('a classic xref table, page tree and info dictionary are read', () => {
  const doc = readPdf(SAMPLE);
  assert.ok(doc instanceof PdfDocument);
  assert.equal(doc.pages().length, 2);
  assert.equal(doc.encrypted, false);
  assert.deepEqual(doc.info().Title, 'Northwind Field Guide');
  assert.equal(doc.language(), 'en-GB');
});

test('text comes out with WinAnsi punctuation resolved and words separated', () => {
  const capture = value(importPdf(SAMPLE, { name: 'sample.pdf', clock }));
  const text = capture.blocks.filter((b) => b.type === 'paragraph').map((b) => b.text).join(' ');
  assert.match(text, /Compile a prospect’s own content into a proof\./, 'the WinAnsi right quote resolved');
  assert.match(text, /A generic demo dies to the objection that our situation is different\./);
  assert.match(text, /Who approves this, and what does the reviewer see when they open it\?/);
});

test('type size promotes a line to a heading, and a smaller one to a lower level', () => {
  const capture = value(importPdf(SAMPLE, { name: 'sample.pdf', clock }));
  const headings = capture.blocks.filter((b) => b.type === 'heading');
  assert.deepEqual(headings.map((h) => h.text), ['Northwind Field Guide', 'What the room actually asks']);
  assert.equal(headings[0].level, 1);
});

test('bullet glyphs become a list', () => {
  const capture = value(importPdf(SAMPLE, { name: 'sample.pdf', clock }));
  const list = capture.blocks.find((b) => b.type === 'list');
  assert.deepEqual(list, {
    type: 'list',
    ordered: false,
    items: ['Start with the audit trail', 'Show the approval chain second'],
  });
});

test('an embedded DCTDecode image is lifted out as a JPEG, byte for byte', () => {
  const capture = value(importPdf(SAMPLE, { name: 'sample.pdf', clock }));
  const jpeg = capture.assets.find((a) => a.mime === 'image/jpeg');
  assert.ok(jpeg, 'the JPEG was extracted');
  assert.equal(sniffMime(jpeg.bytes), 'image/jpeg');
  assert.deepEqual([...jpeg.bytes.subarray(0, 3)], [0xff, 0xd8, 0xff]);
  assert.deepEqual([...jpeg.bytes.subarray(-2)], [0xff, 0xd9]);
  assert.deepEqual(imageSize(jpeg.bytes), { w: 8, h: 8 });
});

test('a FlateDecode bitmap is re-encoded as a PNG that carries its soft mask', () => {
  const capture = value(importPdf(SAMPLE, { name: 'sample.pdf', clock }));
  const png = capture.assets.find((a) => a.mime === 'image/png');
  assert.ok(png, 'the bitmap was re-encoded');
  assert.equal(sniffMime(png.bytes), 'image/png');
  assert.deepEqual(imageSize(png.bytes), { w: 4, h: 3 });
  assert.equal(png.bytes[25], 6, 'colour type 6 — the /SMask became a real alpha channel');
});

test('every extracted image gets a media block naming its page', () => {
  const capture = value(importPdf(SAMPLE, { name: 'sample.pdf', clock }));
  const media = capture.blocks.filter((b) => b.type === 'media');
  assert.equal(media.length, 2);
  assert.deepEqual(media.map((m) => m.caption), ['Page 1', 'Page 1']);
  for (const block of media) {
    assert.ok(capture.assets.some((a) => a.name === block.ref), `${block.ref} has bytes`);
  }
  assert.equal(capture.meta['pdf.images'], '2');
});

test('a shared resource dictionary does not double-count images', () => {
  const capture = value(importPdf(SAMPLE, { name: 'sample.pdf', clock }));
  assert.equal(capture.assets.length, 2, 'page 2 inherits the resource dict but draws nothing');
  assert.equal(capture.meta['pdf.pages'], '2');
});

test('document information becomes capture metadata', () => {
  const capture = value(importPdf(SAMPLE, { name: 'sample.pdf', clock }));
  assert.equal(capture.meta.title, 'Northwind Field Guide');
  assert.equal(capture.meta.author, 'Dana Reyes');
  assert.equal(capture.meta.description, 'How the team positions the platform');
  assert.equal(capture.meta.lang, 'en-GB');
  assert.equal(capture.capturedAt, '2026-03-04T09:15:00.000Z');
  assert.equal(capture.kind, 'document');
});

// ---------------------------------------------------------------------------
// The xref-stream / object-stream / ToUnicode fixture
// ---------------------------------------------------------------------------

test('a cross-reference stream and an object stream are both read', () => {
  const doc = readPdf(XREFSTREAM);
  assert.equal(doc.pages().length, 1);
  const catalog = doc.catalog();
  assert.ok(catalog, 'the catalog lives inside an object stream');
  assert.equal(doc.warnings.length, 0, 'no repair path was needed');
});

test('text is recovered through a ToUnicode CMap when the codes mean nothing else', () => {
  const capture = value(importPdf(XREFSTREAM, { name: 'xrefstream.pdf', clock }));
  const text = capture.blocks.map((b) => (b.type === 'paragraph' || b.type === 'heading' ? b.text : '')).join('');
  assert.equal(text, 'PROOF NOT DEMO');
});

// ---------------------------------------------------------------------------
// Robustness and D9's boundary
// ---------------------------------------------------------------------------

test('a PDF with a corrupted startxref is repaired by scanning for objects', () => {
  const damaged = SAMPLE.slice();
  const marker = new TextEncoder().encode('startxref');
  outer: for (let i = damaged.length - marker.length; i >= 0; i--) {
    for (let k = 0; k < marker.length; k++) if (damaged[i + k] !== marker[k]) continue outer;
    // Point startxref at a byte offset that is not a cross-reference section.
    for (let k = 0; k < 6; k++) damaged[i + 10 + k] = 0x39;
    break;
  }
  const capture = value(importPdf(damaged, { name: 'damaged.pdf', clock }));
  assert.ok(capture.blocks.length > 0, 'content was still recovered');
  assert.match(capture.meta['pdf.warnings'] || '', /scanned|unusable|damaged/);
});

test('a non-PDF, an empty file and a PDF with no content all degrade to a Result', () => {
  assert.equal(importPdf(new TextEncoder().encode('not a pdf at all'), { name: 'x.pdf', clock }).ok, false);
  assert.equal(importPdf(new Uint8Array(0), { name: 'x.pdf', clock }).ok, false);

  const shell = new TextEncoder().encode('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF');
  const empty = importPdf(shell, { name: 'empty.pdf', clock });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /no readable pages|gave up no text/);
});

test('a scanned PDF is told what to do instead, not silently emptied', () => {
  // A page whose content stream draws nothing: no text, no XObjects.
  const src = [
    '%PDF-1.4',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj',
    '4 0 obj << /Length 10 >> stream',
    '0 0 m S  ',
    'endstream endobj',
    'trailer << /Root 1 0 R >>',
    '%%EOF',
  ].join('\n');
  const result = importPdf(new TextEncoder().encode(src), { name: 'scan.pdf', clock });
  assert.equal(result.ok, false);
  assert.match(result.error, /most likely a scan/);
  assert.match(result.error, /Import page images/);
});

test('a missing clock is refused before any parsing happens', () => {
  const result = importPdf(SAMPLE, { name: 'sample.pdf' });
  assert.equal(result.ok, false);
  assert.match(result.error, /clock/);
});

test('import is deterministic: the same PDF twice gives the same blocks and bytes', () => {
  const a = value(importPdf(SAMPLE, { name: 'sample.pdf', clock }));
  const b = value(importPdf(SAMPLE, { name: 'sample.pdf', clock }));
  assert.deepEqual(a.blocks, b.blocks);
  assert.deepEqual(a.meta, b.meta);
  for (let i = 0; i < a.assets.length; i++) {
    assert.deepEqual([...a.assets[i].bytes], [...b.assets[i].bytes]);
  }
});

test('D9 holds: no page raster is produced, and the page-image path says where its pixels came from', () => {
  const capture = value(importPdf(SAMPLE, { name: 'sample.pdf', clock }));
  for (const asset of capture.assets) {
    assert.equal(/^page\d+\.(png|jpg)$/.test(asset.name), false, 'no whole-page raster is invented');
  }

  const pages = value(importPageImages([
    { name: 'p1.png', bytes: tinyPng(4, 4) },
    { name: 'p2.png', bytes: tinyPng(4, 4) },
  ], { clock, documentName: 'Northwind one-pager' }));
  assert.equal(pages.kind, 'document');
  assert.deepEqual(pages.blocks.map((b) => b.type), ['heading', 'media', 'media']);
  assert.deepEqual(pages.blocks.slice(1).map((b) => b.caption), ['Page 1', 'Page 2']);
  assert.match(pages.meta['pageImages.provenance'], /user-supplied/);
  assert.match(pages.meta['pageImages.provenance'], /does not rasterize/);

  const none = importPageImages([], { clock });
  assert.equal(none.ok, false);
  assert.match(none.error, /Export the pages/);
});

// ---------------------------------------------------------------------------
// The PNG encoder the bitmap path depends on
// ---------------------------------------------------------------------------

test('the PNG encoder produces a file the sniffer and the sizer both accept', () => {
  const rgb = new Uint8Array(3 * 4 * 3);
  for (let i = 0; i < rgb.length; i += 3) { rgb[i] = 11; rgb[i + 1] = 18; rgb[i + 2] = 32; }
  const png = encodePngRgb(4, 3, rgb);
  assert.equal(sniffMime(png), 'image/png');
  assert.deepEqual(imageSize(png), { w: 4, h: 3 });
  assert.equal(encodePngRgb(4, 3, rgb).length, png.length, 'encoding is deterministic');
});

test('adler32 matches its published value', () => {
  assert.equal(adler32(new TextEncoder().encode('Wikipedia')), 0x11e60398);
});

test('sample conversion handles gray, RGB, CMYK and indexed colour', () => {
  const gray = samplesToRgb(bytesFrom(0, 255), 2, 1, 8, { kind: 'gray', components: 1 }, false);
  assert.deepEqual([...gray], [0, 0, 0, 255, 255, 255]);

  const inverted = samplesToRgb(bytesFrom(0), 1, 1, 8, { kind: 'gray', components: 1 }, true);
  assert.deepEqual([...inverted], [255, 255, 255]);

  const rgb = samplesToRgb(bytesFrom(1, 2, 3), 1, 1, 8, { kind: 'rgb', components: 3 }, false);
  assert.deepEqual([...rgb], [1, 2, 3]);

  const cmyk = samplesToRgb(bytesFrom(0, 0, 0, 0), 1, 1, 8, { kind: 'cmyk', components: 4 }, false);
  assert.deepEqual([...cmyk], [255, 255, 255]);

  const indexed = samplesToRgb(bytesFrom(0x10), 2, 1, 4, {
    kind: 'indexed', components: 1, palette: bytesFrom(9, 9, 9, 4, 5, 6), hival: 1, baseComponents: 3,
  }, false);
  assert.deepEqual([...indexed], [4, 5, 6, 9, 9, 9]);

  assert.equal(samplesToRgb(bytesFrom(0), 1, 1, 8, null, false), null);
});
