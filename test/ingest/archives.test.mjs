/**
 * Strategy 3 (§6) — saved page, HAR and MHTML.
 *
 * Every fixture in this file is **built inside the test** from one shared page
 * plus one shared image, and then asserted to come back out with its structure,
 * its metadata and its bytes intact. That is what makes these round-trips
 * rather than snapshots: the same content goes into three different containers
 * and has to survive all three.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { importSavedPage, relinkAssets, joinPath } from '../../src/ingest/saved-page.js';
import { importHar, decodeContent } from '../../src/ingest/har.js';
import {
  importMhtml, parseHeaders, headerParam, decodeQuotedPrintable, decodePartBytes, decodeWithCharset,
} from '../../src/ingest/mhtml.js';
import { normalizedText, firstElement, elementsByTag, attr } from '../../src/ingest/html-parse.js';
import { querySelectorAll } from '../../src/ingest/select.js';
import { fixedClock, SAMPLE_PAGE, tinyPng, base64, bytesOf } from './helpers.mjs';

const clock = fixedClock();
const PAGE_URL = 'https://northwind.example/approvals';
const IMAGE = tinyPng(4, 3);
const CSS = 'body{color:#0B1220}.cta{background:#3B2EEA}';

/**
 * Assert the shared page came through whatever container carried it.
 * @param {import('../../src/ingest/capture.js').RawCapture} capture
 */
function assertPageSurvived(capture) {
  assert.equal(capture.kind, 'html');
  assert.equal(capture.capturedAt, '2026-03-04T09:15:00.000Z');
  assert.equal(capture.meta.title, 'Northwind — Approval chains');
  assert.equal(capture.meta.lang, 'en-GB');
  assert.equal(capture.meta.description, 'Every change has a named reviewer.');
  assert.equal(capture.meta.canonical, 'https://northwind.example/approvals');
  assert.equal(normalizedText(firstElement(capture.doc, 'h1')), 'Approval chains');
  assert.equal(elementsByTag(capture.doc, 'li').length, 2);
  assert.equal(attr(querySelectorAll(capture.doc, 'img')[0], 'alt'), 'Approval chain');
}

// ---------------------------------------------------------------------------
// Saved page
// ---------------------------------------------------------------------------

test('joinPath collapses . and .. the way a saved page references its folder', () => {
  assert.equal(joinPath('docs/', 'img/a.png'), 'docs/img/a.png');
  assert.equal(joinPath('docs/deep/', '../img/a.png'), 'docs/img/a.png');
  assert.equal(joinPath('docs/', './a.png'), 'docs/a.png');
  assert.equal(joinPath('docs/', '/root.png'), 'root.png');
});

test('a saved page plus its _files folder round-trips with every asset attached', async () => {
  const files = [
    { name: 'page.html', text: `<!-- saved from url=(0043)${PAGE_URL} -->\n${SAMPLE_PAGE}` },
    { name: 'page_files/chain.png', bytes: IMAGE },
    { name: 'page_files/site.css', text: CSS },
    { name: 'page_files/app.js', text: 'console.log(1)' },
  ];
  const result = await importSavedPage(files, { clock });
  assert.equal(result.ok, true);
  assert.equal(result.value.length, 1);
  const capture = result.value[0];

  assertPageSurvived(capture);
  assert.equal(capture.strategy, 'saved-page');
  assert.equal(capture.sourceUrl, PAGE_URL, 'the saved-from banner is the provenance');
  assert.equal(capture.meta['savedPage.savedFrom'], PAGE_URL);

  const names = capture.assets.map((a) => a.name).sort();
  assert.deepEqual(names, ['page_files/app.js', 'page_files/chain.png', 'page_files/site.css']);
  const image = capture.assets.find((a) => a.name === 'page_files/chain.png');
  assert.equal(image.mime, 'image/png');
  assert.deepEqual([...image.bytes], [...IMAGE], 'asset bytes survive byte for byte');
  assert.ok(image.aliases.includes('chain.png'), 'assets are findable by bare filename too');
  assert.equal(capture.meta['savedPage.assets'], '3');
});

test('a page whose references carry a query or an escape still finds its assets', async () => {
  const html = '<img src="./p_files/a%20b.png?v=3"><link rel=stylesheet href="p_files/s.css">';
  const files = [
    { name: 'p.html', text: html },
    { name: 'p_files/a b.png', bytes: IMAGE },
    { name: 'p_files/s.css', text: CSS },
  ];
  const result = await importSavedPage(files, { clock });
  assert.equal(result.ok, true);
  const capture = result.value[0];
  assert.equal(capture.assets.length, 2);
  assert.ok(capture.assets.some((a) => a.name === 'p_files/a b.png'));
});

test('relinkAssets rewrites local references to the canonical asset names', async () => {
  const files = [
    { name: 'p.html', text: '<img src="./p_files/chain.png"><img src="https://cdn.example/x.png">' },
    { name: 'p_files/chain.png', bytes: IMAGE },
  ];
  const capture = (await importSavedPage(files, { clock })).value[0];
  const rewritten = relinkAssets(capture);
  assert.equal(rewritten, 1);
  const srcs = querySelectorAll(capture.doc, 'img').map((n) => attr(n, 'src'));
  assert.deepEqual(srcs, ['p_files/chain.png', 'https://cdn.example/x.png']);
});

test('a drop with no HTML, and an empty drop, both degrade to a Result', async () => {
  const none = await importSavedPage([{ name: 'a.png', bytes: IMAGE }], { clock });
  assert.equal(none.ok, false);
  assert.match(none.error, /No \.html file/);
  const empty = await importSavedPage([], { clock });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /No files arrived/);
});

test('a saved page with no clock refuses rather than stamping a wall-clock time', async () => {
  const result = await importSavedPage([{ name: 'p.html', text: SAMPLE_PAGE }], {});
  assert.equal(result.ok, false);
  assert.match(result.error, /clock/);
});

// ---------------------------------------------------------------------------
// HAR
// ---------------------------------------------------------------------------

/**
 * Build a HAR the way a browser writes one.
 * @param {{url: string, mimeType: string, body: string|Uint8Array, status?: number, pageref?: string}[]} entries
 */
function buildHar(entries, pages = []) {
  return JSON.stringify({
    log: {
      version: '1.2',
      creator: { name: 'test', version: '1' },
      pages,
      entries: entries.map((e) => ({
        startedDateTime: '2026-03-04T09:00:00.000Z',
        pageref: e.pageref,
        request: { method: 'GET', url: e.url },
        response: {
          status: e.status === undefined ? 200 : e.status,
          content: e.body instanceof Uint8Array
            ? { mimeType: e.mimeType, encoding: 'base64', text: base64(e.body), size: e.body.length }
            : { mimeType: e.mimeType, text: e.body, size: e.body.length },
        },
      })),
    },
  });
}

test('a HAR round-trips the document and attaches its assets', () => {
  const har = buildHar([
    { url: PAGE_URL, mimeType: 'text/html', body: SAMPLE_PAGE, pageref: 'page_1' },
    { url: 'https://northwind.example/page_files/site.css', mimeType: 'text/css', body: CSS },
    { url: 'https://northwind.example/page_files/chain.png', mimeType: 'image/png', body: IMAGE },
    { url: 'https://analytics.example/collect', mimeType: 'application/json', body: '{"ok":1}' },
  ], [{ id: 'page_1', title: 'Northwind approvals' }]);

  const result = importHar(har, { clock });
  assert.equal(result.ok, true);
  assert.equal(result.value.length, 1);
  const capture = result.value[0];

  assertPageSurvived(capture);
  assert.equal(capture.strategy, 'har');
  assert.equal(capture.sourceUrl, PAGE_URL);
  assert.equal(capture.meta['har.pageref'], 'page_1');
  assert.equal(capture.meta['har.startedDateTime'], '2026-03-04T09:00:00.000Z');

  assert.equal(capture.assets.length, 2, 'the analytics beacon is not an asset');
  const image = capture.assets.find((a) => a.mime === 'image/png');
  assert.deepEqual([...image.bytes], [...IMAGE]);
  assert.equal(image.name, 'northwind.example/page_files/chain.png');
  assert.ok(image.aliases.includes('https://northwind.example/page_files/chain.png'));
});

test('a multi-page HAR splits into one capture per document, assets following their page', () => {
  const second = SAMPLE_PAGE.replaceAll('Approval chains', 'Locale fan-out');
  const har = buildHar([
    { url: PAGE_URL, mimeType: 'text/html', body: SAMPLE_PAGE },
    { url: 'https://northwind.example/a.png', mimeType: 'image/png', body: IMAGE },
    { url: 'https://northwind.example/locales', mimeType: 'text/html', body: second },
    { url: 'https://northwind.example/b.png', mimeType: 'image/png', body: IMAGE },
    { url: 'https://northwind.example/c.png', mimeType: 'image/png', body: IMAGE },
  ]);
  const result = importHar(har, { clock });
  assert.equal(result.ok, true);
  assert.equal(result.value.length, 2);
  assert.equal(result.value[0].assets.length, 1);
  assert.equal(result.value[1].assets.length, 2);
  assert.equal(normalizedText(firstElement(result.value[1].doc, 'h1')), 'Locale fan-out');
});

test('a redirect and a 404 in the HAR do not become captures', () => {
  const har = buildHar([
    { url: 'https://northwind.example/old', mimeType: 'text/html', body: '', status: 301 },
    { url: 'https://northwind.example/gone', mimeType: 'text/html', body: '<p>404</p>', status: 404 },
    { url: PAGE_URL, mimeType: 'text/html', body: SAMPLE_PAGE },
  ]);
  const result = importHar(har, { clock });
  assert.equal(result.ok, true);
  assert.equal(result.value.length, 1);
  assert.equal(result.value[0].sourceUrl, PAGE_URL);
});

test('decodeContent handles both the plain and the base64 encodings', () => {
  assert.equal(decodeContent({ text: 'hello', mimeType: 'text/html' }).text, 'hello');
  const encoded = decodeContent({ text: base64(IMAGE), encoding: 'base64', mimeType: 'image/png' });
  assert.deepEqual([...encoded.bytes], [...IMAGE]);
  assert.equal(encoded.text, null, 'binary content is not pretending to be text');
  assert.deepEqual(decodeContent({}), { text: null, bytes: null });
});

test('a HAR that is not JSON, has no entries, or has no document all degrade to a Result', () => {
  const notJson = importHar('<html>', { clock });
  assert.equal(notJson.ok, false);
  assert.match(notJson.error, /not valid JSON/);

  const notHar = importHar('{"hello":1}', { clock });
  assert.equal(notHar.ok, false);
  assert.match(notHar.error, /log\.entries/);

  const empty = importHar('{"log":{"entries":[]}}', { clock });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /empty/);

  const noHtml = importHar(buildHar([{ url: 'https://a.example/x.png', mimeType: 'image/png', body: IMAGE }]), { clock });
  assert.equal(noHtml.ok, false);
  assert.match(noHtml.error, /no HTML document/);
});

// ---------------------------------------------------------------------------
// MHTML
// ---------------------------------------------------------------------------

/**
 * Encode a string as quoted-printable, the way Chrome writes MHTML text parts.
 * @param {string} text
 */
function quotedPrintable(text) {
  const bytes = bytesOf(text);
  let out = '';
  let lineLength = 0;
  for (const b of bytes) {
    const printable = b >= 33 && b <= 126 && b !== 61;
    const chunk = printable || b === 32 || b === 9
      ? String.fromCharCode(b)
      : b === 10 ? '\n' : `=${b.toString(16).toUpperCase().padStart(2, '0')}`;
    if (chunk === '\n') { out += '\r\n'; lineLength = 0; continue; }
    if (lineLength + chunk.length > 72) { out += '=\r\n'; lineLength = 0; }
    out += chunk;
    lineLength += chunk.length;
  }
  return out;
}

/**
 * Build an MHTML archive.
 * @param {{location: string, type: string, encoding: string, body: string}[]} parts
 */
function buildMhtml(parts, boundary = '----=_NextPart_000_0000_01DA') {
  const head = [
    'From: <Saved by Blink>',
    'Snapshot-Content-Location: ' + PAGE_URL,
    'Subject: Northwind approvals',
    'MIME-Version: 1.0',
    `Content-Type: multipart/related;\r\n\ttype="text/html";\r\n\tboundary="${boundary}"`,
    '',
    '',
  ].join('\r\n');
  const body = parts.map((p) => [
    `--${boundary}`,
    `Content-Type: ${p.type}`,
    `Content-Transfer-Encoding: ${p.encoding}`,
    `Content-Location: ${p.location}`,
    '',
    p.body,
    '',
  ].join('\r\n')).join('');
  return `${head}${body}--${boundary}--\r\n`;
}

test('an MHTML archive round-trips the page and its base64 assets', () => {
  const mhtml = buildMhtml([
    { location: PAGE_URL, type: 'text/html; charset=utf-8', encoding: 'quoted-printable', body: quotedPrintable(SAMPLE_PAGE) },
    { location: 'https://northwind.example/page_files/site.css', type: 'text/css', encoding: 'quoted-printable', body: quotedPrintable(CSS) },
    { location: 'https://northwind.example/page_files/chain.png', type: 'image/png', encoding: 'base64', body: base64(IMAGE) },
  ]);

  const result = importMhtml(mhtml, { clock });
  assert.equal(result.ok, true);
  const capture = result.value[0];

  assertPageSurvived(capture);
  assert.equal(capture.strategy, 'mhtml');
  assert.equal(capture.sourceUrl, PAGE_URL);
  assert.equal(capture.meta['mhtml.main'], 'true');
  assert.equal(capture.assets.length, 2);
  const image = capture.assets.find((a) => a.mime === 'image/png');
  assert.deepEqual([...image.bytes], [...IMAGE], 'base64 parts survive byte for byte');
  const css = capture.assets.find((a) => a.mime === 'text/css');
  assert.equal(new TextDecoder().decode(css.bytes), CSS, 'quoted-printable parts survive');
});

test('the main document is the one the archive names, even when it is not first', () => {
  const iframe = '<html><body><p>tracking iframe</p></body></html>';
  const mhtml = buildMhtml([
    { location: 'https://ads.example/frame.html', type: 'text/html', encoding: 'quoted-printable', body: quotedPrintable(iframe) },
    { location: PAGE_URL, type: 'text/html; charset=utf-8', encoding: 'quoted-printable', body: quotedPrintable(SAMPLE_PAGE) },
  ]);
  const result = importMhtml(mhtml, { clock });
  assert.equal(result.ok, true);
  assert.equal(result.value.length, 2);
  assert.equal(result.value[0].sourceUrl, PAGE_URL, 'the snapshot location wins');
  assert.equal(result.value[0].meta['mhtml.main'], 'true');
  assert.equal(result.value[1].meta['mhtml.main'], 'false');
});

test('a single-part text/html archive with no boundary is still readable', () => {
  const single = ['Content-Type: text/html; charset=utf-8', 'Content-Location: ' + PAGE_URL, '', SAMPLE_PAGE].join('\r\n');
  const result = importMhtml(single, { clock });
  assert.equal(result.ok, true);
  assertPageSurvived(result.value[0]);
});

test('MIME header parsing unfolds continuations and reads parameters', () => {
  const headers = parseHeaders('Content-Type: multipart/related;\r\n\tboundary="abc";\r\n type="text/html"\r\nX-Other: 1');
  assert.equal(headers.get('x-other'), '1');
  assert.equal(headerParam(headers.get('content-type'), 'boundary'), 'abc');
  assert.equal(headerParam(headers.get('content-type'), 'type'), 'text/html');
  assert.equal(headerParam(headers.get('content-type'), 'missing'), null);
});

test('the transfer-encoding decoders are exact', () => {
  assert.equal(new TextDecoder().decode(decodeQuotedPrintable('caf=C3=A9=\r\n bar')), 'café bar');
  assert.deepEqual([...decodePartBytes(base64(IMAGE), 'base64')], [...IMAGE]);
  assert.equal(new TextDecoder().decode(decodePartBytes('plain text', '7bit')), 'plain text');
  assert.equal(decodeWithCharset(new Uint8Array([0xe9]), 'iso-8859-1'), 'é');
  assert.equal(decodeWithCharset(bytesOf('ok'), 'not-a-charset'), 'ok', 'an unknown charset falls back to UTF-8');
});

test('an empty, non-MIME or HTML-free archive degrades to a Result', () => {
  assert.equal(importMhtml('', { clock }).ok, false);
  const notMime = importMhtml('just some text\r\n\r\nwith no headers', { clock });
  assert.equal(notMime.ok, false);
  assert.match(notMime.error, /not a MIME web archive/);
  const noHtml = importMhtml(buildMhtml([
    { location: 'https://a.example/x.png', type: 'image/png', encoding: 'base64', body: base64(IMAGE) },
  ]), { clock });
  assert.equal(noHtml.ok, false);
  assert.match(noHtml.error, /no HTML part/);
});

// ---------------------------------------------------------------------------
// The three containers agree
// ---------------------------------------------------------------------------

test('the same page through all three containers yields the same content', async () => {
  const saved = (await importSavedPage([
    { name: 'page.html', text: SAMPLE_PAGE },
    { name: 'page_files/chain.png', bytes: IMAGE },
  ], { clock })).value[0];

  const har = importHar(buildHar([
    { url: PAGE_URL, mimeType: 'text/html', body: SAMPLE_PAGE },
    { url: 'https://northwind.example/page_files/chain.png', mimeType: 'image/png', body: IMAGE },
  ]), { clock }).value[0];

  const mhtml = importMhtml(buildMhtml([
    { location: PAGE_URL, type: 'text/html; charset=utf-8', encoding: 'quoted-printable', body: quotedPrintable(SAMPLE_PAGE) },
    { location: 'https://northwind.example/page_files/chain.png', type: 'image/png', encoding: 'base64', body: base64(IMAGE) },
  ]), { clock }).value[0];

  for (const capture of [saved, har, mhtml]) {
    assert.equal(normalizedText(firstElement(capture.doc, 'h1')), 'Approval chains');
    assert.equal(capture.meta.title, 'Northwind — Approval chains');
    assert.equal(capture.capturedAt, '2026-03-04T09:15:00.000Z');
    const image = capture.assets.find((a) => a.mime === 'image/png');
    assert.ok(image, 'every container carried the image');
    assert.deepEqual([...image.bytes], [...IMAGE]);
  }
});
