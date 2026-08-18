/**
 * Capture hygiene and the services every strategy shares (§6, §8's inputs).
 *
 * §6 ends with a one-line law — "record `capturedAt` on everything" — and §5
 * says where that value may come from. Both are asserted here across every
 * importer at once, because a single strategy that reads a wall clock would
 * make the whole build non-reproducible.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  makeCapture, htmlCapture, documentMeta, documentReferences, now, ClockRequiredError,
  resolveUrl, originOf, pathOf, normalizeAssetRef, mimeForName, sniffMime, toDataUri, imageSize,
} from '../../src/ingest/capture.js';
import { parseHtml } from '../../src/ingest/html-parse.js';
import { importHtmlText, importManual } from '../../src/ingest/paste.js';
import { importHar } from '../../src/ingest/har.js';
import { importMhtml } from '../../src/ingest/mhtml.js';
import { importSavedPage } from '../../src/ingest/saved-page.js';
import { importOoxml } from '../../src/ingest/ooxml.js';
import { importPdf } from '../../src/ingest/pdf/index.js';
import { importImage, importPageImages, titleFromFilename, assetDataUri } from '../../src/ingest/image.js';
import { fixedClock, tinyPng, SAMPLE_PAGE, base64 } from './helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '..', 'fixtures', 'ingest');
const clock = fixedClock();
const PNG = tinyPng(6, 4);

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

test('now() demands an injected clock and an ISO string from it', () => {
  assert.equal(now({ clock: () => '2026-01-01T00:00:00Z' }), '2026-01-01T00:00:00Z');
  assert.throws(() => now({}), ClockRequiredError);
  assert.throws(() => now({ clock: 'not a function' }), ClockRequiredError);
  assert.throws(() => now({ clock: () => 0 }), ClockRequiredError);
  assert.throws(() => now({ clock: () => '' }), ClockRequiredError);
});

test('every importer stamps capturedAt from the injected clock, and none without one', async () => {
  const stamp = '2031-07-04T12:00:00.000Z';
  const pinned = () => stamp;
  const png = PNG;
  const harBody = JSON.stringify({
    log: { entries: [{ request: { url: 'https://a.example/' }, response: { status: 200, content: { mimeType: 'text/html', text: SAMPLE_PAGE } } }] },
  });
  const mhtmlBody = ['Content-Type: text/html; charset=utf-8', 'Content-Location: https://a.example/', '', SAMPLE_PAGE].join('\r\n');

  /** @type {[string, (deps: object) => any][]} */
  const importers = [
    ['paste', (deps) => importHtmlText(SAMPLE_PAGE, deps)],
    ['manual', (deps) => importManual({ text: '# T\n\nBody.' }, deps)],
    ['har', (deps) => importHar(harBody, deps)],
    ['mhtml', (deps) => importMhtml(mhtmlBody, deps)],
    ['saved-page', (deps) => importSavedPage([{ name: 'p.html', text: SAMPLE_PAGE }], deps)],
    ['docx', (deps) => importOoxml(new Uint8Array(readFileSync(join(FIXTURES, 'sample.docx'))), { name: 'x.docx', ...deps })],
    ['pptx', (deps) => importOoxml(new Uint8Array(readFileSync(join(FIXTURES, 'sample.pptx'))), { name: 'x.pptx', ...deps })],
    ['pdf', (deps) => importPdf(new Uint8Array(readFileSync(join(FIXTURES, 'sample.pdf'))), { name: 'x.pdf', ...deps })],
    ['image', (deps) => importImage(png, { name: 'logo.png', ...deps })],
    ['page-images', (deps) => importPageImages([{ name: 'p1.png', bytes: png }], deps)],
  ];

  for (const [label, run] of importers) {
    const good = await run({ clock: pinned });
    assert.equal(good.ok, true, `${label}: ${good.ok ? '' : good.error}`);
    const captures = Array.isArray(good.value) ? good.value : [good.value];
    for (const capture of captures) {
      assert.equal(capture.capturedAt, stamp, `${label} must stamp capturedAt from the clock`);
    }
    const bad = await run({});
    assert.equal(bad.ok, false, `${label} must refuse without a clock`);
    assert.match(bad.error, /clock/, `${label} must say why`);
  }
});

test('every capture carries the full RawCapture shape', async () => {
  const capture = importHtmlText('<p>x</p>', { clock }).value;
  for (const key of ['kind', 'sourceUrl', 'capturedAt', 'html', 'doc', 'blocks', 'assets', 'meta', 'strategy']) {
    assert.ok(key in capture, `a capture must declare ${key}`);
  }
  assert.ok(Array.isArray(capture.assets));
  assert.equal(typeof capture.meta, 'object');

  const bare = makeCapture({ capturedAt: 'x', strategy: 's' });
  assert.deepEqual(bare, {
    kind: 'html', sourceUrl: null, capturedAt: 'x', html: null, doc: null,
    blocks: null, assets: [], meta: {}, strategy: 's',
  });
});

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

test('documentMeta reads title, description, canonical, lang and og:*', () => {
  const doc = parseHtml(`
    <html lang="de-DE" dir="rtl"><head>
    <meta charset="UTF-8">
    <title>  Ein   Titel  </title>
    <meta name="description" content="Beschreibung">
    <meta name="robots" content="index,follow">
    <meta property="og:title" content="OG title">
    <meta property="og:image" content="https://cdn.example/og.png">
    <meta property="twitter:card" content="summary">
    <meta name="not-interesting" content="ignore me">
    <link rel="canonical" href="/canonical">
    <link rel="alternate" hreflang="FR-fr" href="/fr">
    </head><body><h1>H</h1></body></html>`);
  const meta = documentMeta(doc, 'https://a.example/page');
  assert.equal(meta.title, 'Ein Titel');
  assert.equal(meta.lang, 'de-DE');
  assert.equal(meta.dir, 'rtl');
  assert.equal(meta.charset, 'utf-8');
  assert.equal(meta.description, 'Beschreibung');
  assert.equal(meta.robots, 'index,follow');
  assert.equal(meta['og:title'], 'OG title');
  assert.equal(meta['twitter:card'], 'summary');
  assert.equal(meta.canonical, 'https://a.example/canonical');
  assert.equal(meta['hreflang.fr-fr'], 'https://a.example/fr');
  assert.equal(meta.sourceUrl, 'https://a.example/page');
  assert.equal('not-interesting' in meta, false);
});

test('a page with no title falls back to its h1, and description to og:description', () => {
  const doc = parseHtml('<html><head><meta property="og:description" content="From OG"></head><body><h1> The  heading </h1></body></html>');
  const meta = documentMeta(doc);
  assert.equal(meta.title, 'The heading');
  assert.equal(meta.description, 'From OG');
});

test('documentMeta on an empty or missing document is an empty object', () => {
  assert.deepEqual(documentMeta(null), {});
  assert.deepEqual(documentMeta(parseHtml('')), {});
});

test('documentReferences finds every URL-bearing attribute, srcset included', () => {
  const doc = parseHtml(`
    <img src="a.png" srcset="a-2x.png 2x, a-3x.png 3x">
    <video poster="p.jpg"><source src="v.mp4"></video>
    <a href="/x">l</a>
    <img data-src="lazy.png">
    <meta property="og:image" content="og.png">
    <meta name="viewport" content="width=device-width">`);
  const refs = documentReferences(doc, 'https://a.example/dir/');
  const raw = refs.map((r) => r.raw);
  for (const expected of ['a.png', 'a-2x.png', 'a-3x.png', 'p.jpg', 'v.mp4', '/x', 'lazy.png', 'og.png']) {
    assert.ok(raw.includes(expected), `${expected} should be found`);
  }
  assert.equal(raw.includes('width=device-width'), false, 'a viewport is not a URL');
  assert.equal(refs.find((r) => r.raw === 'a.png').url, 'https://a.example/dir/a.png');
});

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

test('resolveUrl resolves against a base and returns null rather than throwing', () => {
  assert.equal(resolveUrl('https://a.example/dir/page', '../img/x.png'), 'https://a.example/img/x.png');
  assert.equal(resolveUrl('https://a.example/dir/page', '/root.png'), 'https://a.example/root.png');
  assert.equal(resolveUrl(null, 'https://b.example/x'), 'https://b.example/x');
  assert.equal(resolveUrl(null, 'relative.png'), null);
  assert.equal(resolveUrl(null, ''), null);
  assert.equal(resolveUrl('https://a.example/', 'data:image/png;base64,AAA'), 'data:image/png;base64,AAA');
  assert.equal(resolveUrl('https://a.example/', 'mailto:x@y.example'), 'mailto:x@y.example');
});

test('originOf and pathOf are total', () => {
  assert.equal(originOf('https://a.example/x?y#z'), 'https://a.example');
  assert.equal(originOf('nonsense'), null);
  assert.equal(pathOf('https://a.example/x/y?z=1'), '/x/y');
  assert.equal(pathOf('/plain/path?q=1'), '/plain/path');
});

test('normalizeAssetRef strips fragments, decodes escapes and squares slashes', () => {
  assert.equal(normalizeAssetRef('./dir\\file%20name.png#frag'), 'dir/file name.png');
  assert.equal(normalizeAssetRef('  a.png  '), 'a.png');
  assert.equal(normalizeAssetRef('bad%escape.png'), 'bad%escape.png');
  assert.equal(normalizeAssetRef(null), '');
});

// ---------------------------------------------------------------------------
// Bytes
// ---------------------------------------------------------------------------

test('MIME is sniffed from magic bytes, and the filename is only a fallback', () => {
  assert.equal(sniffMime(PNG, 'mislabelled.jpg'), 'image/png');
  assert.equal(sniffMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), 'x.png'), 'image/jpeg');
  assert.equal(sniffMime(new Uint8Array([0x25, 0x50, 0x44, 0x46]), 'x.txt'), 'application/pdf');
  assert.equal(sniffMime(new TextEncoder().encode('<!doctype html><html>'), 'x'), 'text/html');
  assert.equal(sniffMime(new TextEncoder().encode('<svg viewBox="0 0 1 1"></svg>'), 'x'), 'image/svg+xml');
  assert.equal(sniffMime(new Uint8Array([1, 2, 3, 4]), 'x.css'), 'text/css');
  assert.equal(mimeForName('a/b/c.PPTX'), 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  assert.equal(mimeForName('unknown.zzz'), 'application/octet-stream');
});

test('imageSize measures PNG, GIF, BMP, JPEG and SVG without a decoder', () => {
  assert.deepEqual(imageSize(PNG), { w: 6, h: 4 });
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x00, 0x20, 0x00]);
  assert.deepEqual(imageSize(gif), { w: 64, h: 32 });
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 32"></svg>');
  assert.deepEqual(imageSize(svg), { w: 120, h: 32 });
  const svgSized = new TextEncoder().encode('<svg width="48" height="24"></svg>');
  assert.deepEqual(imageSize(svgSized), { w: 48, h: 24 });
  assert.equal(imageSize(new Uint8Array([1, 2])), null);
  assert.equal(imageSize(new Uint8Array(64), 'font/woff'), null);
});

test('toDataUri round-trips through the core parser', async () => {
  const uri = toDataUri(PNG, 'image/png');
  assert.match(uri, /^data:image\/png;base64,/);
  const { parseDataUri } = await import('../../src/core/bytes.js');
  const parsed = parseDataUri(uri);
  assert.equal(parsed.mime, 'image/png');
  assert.equal(parsed.base64, true);
  assert.equal(parsed.bytes, PNG.length);
  assert.equal(uri, `data:image/png;base64,${base64(PNG)}`);
});

// ---------------------------------------------------------------------------
// Image import
// ---------------------------------------------------------------------------

test('an imported image becomes a media block plus one asset, with its size in meta', () => {
  const result = importImage(PNG, { name: 'hero-image_v2.png', clock, alt: 'The hero' });
  assert.equal(result.ok, true);
  const capture = result.value;
  assert.equal(capture.kind, 'image');
  assert.deepEqual(capture.blocks, [{ type: 'media', ref: 'hero-image_v2.png', caption: 'The hero' }]);
  assert.equal(capture.assets.length, 1);
  assert.equal(capture.assets[0].mime, 'image/png');
  assert.equal(capture.meta['image.width'], '6');
  assert.equal(capture.meta['image.height'], '4');
  assert.equal(capture.meta['image.bytes'], String(PNG.length));
  assert.equal(capture.meta.title, 'hero image v2');
  assert.match(assetDataUri(capture.assets[0]), /^data:image\/png;base64,/);
});

test('a non-image and an empty file are refused with a reason', () => {
  const notImage = importImage(new TextEncoder().encode('%PDF-1.7 not an image'), { name: 'x.png', clock });
  assert.equal(notImage.ok, false);
  assert.match(notImage.error, /does not look like an image/);
  assert.equal(importImage(new Uint8Array(0), { name: 'x.png', clock }).ok, false);
});

test('titleFromFilename produces something a person would type', () => {
  assert.equal(titleFromFilename('northwind_hero-image.final.png'), 'northwind hero image final');
  assert.equal(titleFromFilename('a/b/logo.svg'), 'logo');
  assert.equal(titleFromFilename(''), 'image');
});
