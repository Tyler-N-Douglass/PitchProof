/**
 * The ZIP/OOXML reader (§6.5). Fixtures are built inside the test with our own
 * DEFLATE and a hand-written ZIP writer, so the reader is exercised against
 * bytes it did not produce and against every structure it claims to handle.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import {
  ZipArchive, readCentralDirectory, readEntry, crc32, ooxmlKind,
  readRelationships, resolvePart, parseXmlAttrs, decodeXmlEntities, xmlText, mimeForPart,
} from '../../src/core/zip.js';
import { utf8Encode, utf8Decode, concatBytes } from '../../src/core/bytes.js';

/**
 * A minimal ZIP writer, used only to build fixtures. Deliberately independent
 * of the reader so the test is not asserting a round-trip of one code path.
 * @param {{name: string, data: Uint8Array, store?: boolean}[]} files
 * @returns {Uint8Array}
 */
function writeZip(files) {
  /** @type {Uint8Array[]} */
  const chunks = [];
  /** @type {Uint8Array[]} */
  const central = [];
  let offset = 0;

  const u16 = (v) => new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
  const u32 = (v) => new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);

  for (const f of files) {
    const nameBytes = utf8Encode(f.name);
    const body = f.store ? f.data : new Uint8Array(zlib.deflateRawSync(Buffer.from(f.data), { level: 9 }));
    const method = f.store ? 0 : 8;
    const crc = crc32(f.data);
    const local = concatBytes(
      u32(0x04034b50), u16(20), u16(0x0800), u16(method), u16(0), u16(0),
      u32(crc), u32(body.length), u32(f.data.length), u16(nameBytes.length), u16(0),
      nameBytes, body,
    );
    chunks.push(local);
    central.push(concatBytes(
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(method), u16(0), u16(0),
      u32(crc), u32(body.length), u32(f.data.length),
      u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset),
      nameBytes,
    ));
    offset += local.length;
  }

  const cd = concatBytes(...central);
  const eocd = concatBytes(
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(cd.length), u32(offset), u16(0),
  );
  return concatBytes(...chunks, cd, eocd);
}

const DOC_XML = '<?xml version="1.0"?><w:document xmlns:w="x"><w:body>'
  + '<w:p><w:r><w:t>Northwind quarterly &amp; annual</w:t></w:r></w:p>'
  + '<w:p><w:r><w:t xml:space="preserve">Second paragraph</w:t></w:r></w:p>'
  + '</w:body></w:document>';

const RELS_XML = '<?xml version="1.0"?><Relationships>'
  + '<Relationship Id="rId1" Type="http://schemas/image" Target="media/image1.png"/>'
  + '<Relationship Id="rId2" Type="http://schemas/hyperlink" Target="https://example.com" TargetMode="External"/>'
  + '</Relationships>';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(500).fill(7)]);

function docxFixture() {
  return writeZip([
    { name: '[Content_Types].xml', data: utf8Encode('<Types>wordprocessingml.document</Types>') },
    { name: 'word/document.xml', data: utf8Encode(DOC_XML) },
    { name: 'word/_rels/document.xml.rels', data: utf8Encode(RELS_XML) },
    { name: 'word/media/image1.png', data: PNG, store: true },
  ]);
}

test('CRC-32 matches the published check value', () => {
  assert.equal(crc32(utf8Encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('the central directory lists every entry with its sizes', () => {
  const bytes = docxFixture();
  const entries = readCentralDirectory(bytes);
  assert.deepEqual(entries.map((e) => e.name), [
    '[Content_Types].xml', 'word/document.xml', 'word/_rels/document.xml.rels', 'word/media/image1.png',
  ]);
  const doc = entries.find((e) => e.name === 'word/document.xml');
  assert.equal(doc.method, 8);
  assert.equal(doc.uncompressedSize, utf8Encode(DOC_XML).length);
  assert.equal(entries.find((e) => e.name.endsWith('.png')).method, 0, 'stored entries stay stored');
});

test('entries inflate and verify their CRC', () => {
  const bytes = docxFixture();
  const zip = new ZipArchive(bytes);
  assert.equal(zip.textOf('word/document.xml'), DOC_XML);
  assert.deepEqual([...zip.bytesOf('word/media/image1.png')], [...PNG]);
  assert.equal(zip.bytesOf('nope/missing.xml'), null);
  assert.equal(zip.has('word/document.xml'), true);
});

test('a corrupted entry is refused, not half-decoded', () => {
  const bytes = docxFixture();
  const zip = new ZipArchive(bytes);
  const entry = { ...zip.index.get('word/media/image1.png') };
  const damaged = new Uint8Array(bytes);
  // Flip a byte inside the stored PNG payload.
  const start = entry.localHeaderOffset + 30 + utf8Encode('word/media/image1.png').length;
  damaged[start + 20] ^= 0xff;
  assert.throws(() => readEntry(damaged, entry), /CRC mismatch/);
});

test('an unsupported compression method is refused by name', () => {
  const bytes = docxFixture();
  const zip = new ZipArchive(bytes);
  const entry = { ...zip.index.get('word/document.xml'), method: 12 };
  assert.throws(() => readEntry(bytes, entry), /unsupported compression method 12/);
});

test('a truncated archive fails with a readable message', () => {
  assert.throws(() => new ZipArchive(utf8Encode('not a zip at all')), /end-of-central-directory/);
});

test('an archive with a trailing comment is still found', () => {
  const base = docxFixture();
  const commented = concatBytes(base.subarray(0, base.length - 2), new Uint8Array([9, 0]), utf8Encode('trailing!'));
  const zip = new ZipArchive(commented);
  assert.equal(zip.entries.length, 4);
});

test('OOXML kind detection reads the parts, then the content types', () => {
  assert.equal(ooxmlKind(new ZipArchive(docxFixture())), 'docx');
  assert.equal(ooxmlKind(new ZipArchive(writeZip([{ name: 'ppt/presentation.xml', data: utf8Encode('<p/>') }]))), 'pptx');
  assert.equal(ooxmlKind(new ZipArchive(writeZip([{ name: 'xl/workbook.xml', data: utf8Encode('<w/>') }]))), 'xlsx');
  assert.equal(ooxmlKind(new ZipArchive(writeZip([
    { name: '[Content_Types].xml', data: utf8Encode('<Types>presentationml</Types>') },
  ]))), 'pptx');
  assert.equal(ooxmlKind(new ZipArchive(writeZip([{ name: 'readme.txt', data: utf8Encode('hi') }]))), 'unknown');
});

test('relationships resolve against the part directory and flag external targets', () => {
  const zip = new ZipArchive(docxFixture());
  const rels = readRelationships(zip, 'word/document.xml');
  assert.equal(rels.get('rId1').target, 'word/media/image1.png');
  assert.equal(rels.get('rId1').external, false);
  assert.equal(rels.get('rId2').target, 'https://example.com');
  assert.equal(rels.get('rId2').external, true, 'an external target must never be resolved to a part');
  assert.equal(readRelationships(zip, 'word/missing.xml').size, 0);
});

test('part resolution handles absolute, relative and parent paths', () => {
  assert.equal(resolvePart('word/', 'media/a.png'), 'word/media/a.png');
  assert.equal(resolvePart('word/', '/docProps/core.xml'), 'docProps/core.xml');
  assert.equal(resolvePart('ppt/slides/', '../media/b.png'), 'ppt/media/b.png');
  assert.equal(resolvePart('ppt/slides/', './c.xml'), 'ppt/slides/c.xml');
});

test('XML attribute and entity handling covers what OOXML emits', () => {
  const attrs = parseXmlAttrs(' Id="rId1" w:val=\'left\' Target="a&amp;b" ');
  assert.deepEqual(attrs, { Id: 'rId1', 'w:val': 'left', Target: 'a&b' });
  assert.equal(decodeXmlEntities('&lt;a&gt; &#65;&#x42; &quot;&apos;'), '<a> AB "\'');
  assert.equal(decodeXmlEntities('&unknownentity;'), '&unknownentity;');
  assert.equal(xmlText(DOC_XML).includes('Northwind quarterly & annual'), true);
});

test('media MIME types come from the part extension', () => {
  assert.equal(mimeForPart('word/media/image1.PNG'), 'image/png');
  assert.equal(mimeForPart('a/b.jpeg'), 'image/jpeg');
  assert.equal(mimeForPart('a/b.svg'), 'image/svg+xml');
  assert.equal(mimeForPart('a/b.bin'), 'application/octet-stream');
});

test('match filters non-directory entries', () => {
  const zip = new ZipArchive(docxFixture());
  assert.deepEqual(zip.match((n) => n.startsWith('word/media/')).map((e) => e.name), ['word/media/image1.png']);
});

test('a large archive with many entries reads correctly', () => {
  const files = Array.from({ length: 120 }, (_, i) => ({
    name: `ppt/slides/slide${i + 1}.xml`,
    data: utf8Encode(`<sld n="${i}">${'content '.repeat(40)}</sld>`),
  }));
  const zip = new ZipArchive(writeZip(files));
  assert.equal(zip.entries.length, 120);
  assert.equal(utf8Decode(zip.bytesOf('ppt/slides/slide73.xml')).includes('n="72"'), true);
});
