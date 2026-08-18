/**
 * The network-reference scanner (§13, §18.4, §20 axis 4).
 *
 * Two corpora, because a detector is only proved by both halves:
 *
 *   - **Planted violations** — one per detection route, each asserted to be
 *     caught, at severity 1, with a locus that names the line it is on. §17.4
 *     makes the same argument about overflow: "planted-defect corpora are the
 *     only honest way to know a detector works".
 *   - **Legal artifacts** — inline SVG with its namespace, `data:` images, `#`
 *     fragments, `about:blank`, base64 payloads full of `//`, and the word
 *     `fetch` in a comment and in a string. A scanner that fails these gets
 *     switched off, and then §18.4's law is a README claim.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanForNetworkReferences } from '../../src/emit/scan.js';

/**
 * Every detection route D10 and the lane brief name, one planted violation
 * each. `route` is the label the assertion reports on failure.
 */
const PLANTED = [
  { route: 'script src', html: '<body>\n<script src="analytics.js"></script>\n</body>', match: /<script src>/ },
  { route: 'link rel=stylesheet', html: '<head>\n<link rel="stylesheet" href="theme.css">\n</head>', match: /rel="stylesheet"/ },
  { route: 'link rel=preconnect', html: '<head>\n<link rel="preconnect" href="https://fonts.example">\n</head>', match: /rel="preconnect"/ },
  { route: 'img src absolute', html: '<body>\n<img src="https://cdn.example/logo.png">\n</body>', match: /img\[src\]/ },
  { route: 'img src relative', html: '<body>\n<img src="assets/logo.png">\n</body>', match: /relative URL/ },
  { route: 'iframe src', html: '<body>\n<iframe src="https://embed.example/x"></iframe>\n</body>', match: /iframe\[src\]/ },
  { route: 'srcset', html: '<body>\n<img src="data:image/gif;base64,AA" srcset="hi.png 2x, //cdn.example/lo.png 1x">\n</body>', match: /srcset/ },
  { route: 'use href external', html: '<body>\n<svg xmlns="http://www.w3.org/2000/svg"><use href="sprite.svg#icon"/></svg>\n</body>', match: /use\[href\]|<use href>/ },
  { route: 'form action', html: '<body>\n<form action="https://forms.example/submit"></form>\n</body>', match: /form\[action\]/ },
  { route: 'meta refresh', html: '<head>\n<meta http-equiv="refresh" content="3;url=https://elsewhere.example">\n</head>', match: /meta refresh/ },
  { route: 'base href', html: '<head>\n<base href="https://cdn.example/">\n</head>', match: /<base>/ },
  { route: 'css @import', html: '<head>\n<style>@import url("fonts.css");</style>\n</head>', match: /@import/ },
  { route: 'css url(http)', html: '<head>\n<style>.a{background-image:url(http://cdn.example/bg.png)}</style>\n</head>', match: /CSS url\(/ },
  { route: 'css url relative', html: '<head>\n<style>.a{background:url(bg.png)}</style>\n</head>', match: /CSS url\(/ },
  { route: 'css in style attribute', html: '<body>\n<div style="background:url(https://cdn.example/x.png)"></div>\n</body>', match: /style attribute/ },
  { route: 'font-face src url', html: '<head>\n<style>@font-face{font-family:X;src:url(https://foundry.example/x.woff2)}</style>\n</head>', match: /url\(|absolute URL/ },
  { route: 'fetch', html: '<body>\n<script>fetch(endpoint).then(done);</script>\n</body>', match: /fetch\(\)/ },
  { route: 'XMLHttpRequest', html: '<body>\n<script>var x = new XMLHttpRequest();</script>\n</body>', match: /XMLHttpRequest/ },
  { route: 'WebSocket', html: '<body>\n<script>var s = new WebSocket(endpoint);</script>\n</body>', match: /WebSocket/ },
  { route: 'EventSource', html: '<body>\n<script>var e = new EventSource(endpoint);</script>\n</body>', match: /EventSource/ },
  { route: 'sendBeacon', html: '<body>\n<script>navigator.sendBeacon(endpoint, payload);</script>\n</body>', match: /sendBeacon/ },
  { route: 'importScripts', html: '<body>\n<script>importScripts(worker);</script>\n</body>', match: /importScripts/ },
  { route: 'dynamic import', html: '<body>\n<script>import(moduleName).then(run);</script>\n</body>', match: /dynamic import/ },
  { route: 'service worker', html: '<body>\n<script>navigator.serviceWorker.register(sw);</script>\n</body>', match: /serviceWorker/ },
  { route: 'WebRTC', html: '<body>\n<script>var pc = new RTCPeerConnection(config);</script>\n</body>', match: /RTCPeerConnection/ },
  { route: 'WebTransport', html: '<body>\n<script>var t = new WebTransport(endpoint);</script>\n</body>', match: /WebTransport/ },
  { route: 'eval', html: '<body>\n<script>eval(payload);</script>\n</body>', match: /eval\(\)/ },
  { route: 'new Function', html: '<body>\n<script>var f = new Function(body);</script>\n</body>', match: /new Function/ },
  { route: 'URL in a string literal', html: '<body>\n<script>var endpoint = "https://beacon.example/collect";</script>\n</body>', match: /absolute URL/ },
  { route: 'protocol-relative in a literal', html: '<body>\n<script>var endpoint = "//beacon.example/collect";</script>\n</body>', match: /protocol-relative/ },
  { route: 'inline event handler', html: '<body>\n<button onclick="fetch(url)">go</button>\n</body>', match: /fetch\(\)/ },
  { route: 'javascript: URL', html: '<body>\n<a href="javascript:track()">go</a>\n</body>', match: /javascript: URL/ },
  { route: 'anchor to the web', html: '<body>\n<a href="https://northwind.example/contact">Contact</a>\n</body>', match: /a\[href\]/ },
  { route: 'data-* attribute holding an endpoint', html: '<body>\n<div data-beacon="https://track.example/p"></div>\n</body>', match: /absolute URL/ },
  { route: 'W3C namespace used as a prefix (D14)', html: '<body>\n<svg xmlns="http://www.w3.org/2000/svg/../../../evil"></svg>\n</body>', match: /W3C namespace/ },
  { route: 'importmap', html: '<head>\n<script type="importmap">{"imports":{}}</script>\n</head>', match: /importmap/ },
  { route: 'nested SVG data URI', html: '<body>\n<img src="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cimage%20href%3D%22https%3A%2F%2Fcdn.example%2Fx.png%22%2F%3E%3C%2Fsvg%3E">\n</body>', match: /data: URI/ },
  { route: 'object data', html: '<body>\n<object data="viewer.pdf"></object>\n</body>', match: /object\[data\]/ },
  { route: 'video poster', html: '<body>\n<video poster="https://cdn.example/p.jpg"></video>\n</body>', match: /video\[poster\]/ },
  { route: 'CSS behavior', html: '<head>\n<style>.a{behavior:url(x.htc)}</style>\n</head>', match: /behavior/ },
];

test('every planted network reference is caught at severity 1 with a locus', () => {
  assert.ok(PLANTED.length >= 12, 'the corpus must cover at least a dozen routes');
  for (const planted of PLANTED) {
    const findings = scanForNetworkReferences(planted.html);
    assert.ok(findings.length > 0, `route "${planted.route}" was not caught at all`);
    for (const f of findings) {
      assert.equal(f.severity, 1, `route "${planted.route}" produced a finding at severity ${f.severity}`);
      assert.equal(f.code, 'NETWORK_REFERENCE');
      assert.equal(typeof f.id, 'string');
      assert.ok(f.id.startsWith('fd_'), 'a finding id must be minted by core/ids');
      assert.equal(typeof f.locus.line, 'number', `route "${planted.route}" reported no line`);
      assert.equal(typeof f.locus.column, 'number', `route "${planted.route}" reported no column`);
      assert.equal(f.locus.line, 2, `route "${planted.route}" reported line ${f.locus.line}, but the violation is on line 2`);
      assert.equal(typeof f.locus.excerpt, 'string');
      assert.ok(f.locus.excerpt.length > 0);
      assert.equal(f.autoFixAvailable, false, 'a network reference has no safe automatic fix');
    }
    assert.ok(
      findings.some((f) => planted.match.test(f.message)),
      `route "${planted.route}" was caught, but no message matched ${planted.match}. Got: ${findings.map((f) => f.message).join(' | ')}`,
    );
  }
});

test('planted findings are deterministic: the same input yields the same ids', () => {
  for (const planted of PLANTED.slice(0, 8)) {
    const a = scanForNetworkReferences(planted.html).map((f) => f.id);
    const b = scanForNetworkReferences(planted.html).map((f) => f.id);
    assert.deepEqual(a, b);
  }
});

const LEGAL = [
  { name: 'inline SVG with both W3C namespaces', html: '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><rect width="4" height="4"/></svg>' },
  { name: 'XHTML namespace', html: '<html xmlns="http://www.w3.org/1999/xhtml"><body></body></html>' },
  { name: 'data: image', html: '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==" alt="x">' },
  { name: 'data: image with srcset', html: '<img src="data:image/gif;base64,AA" srcset="data:image/gif;base64,AA 1x, data:image/gif;base64,BB 2x">' },
  { name: 'document fragment link', html: '<a href="#scene-4">Skip ahead</a>' },
  { name: 'use pointing at a fragment', html: '<svg xmlns="http://www.w3.org/2000/svg"><use href="#icon-check"/></svg>' },
  { name: 'about:blank iframe', html: '<iframe src="about:blank" title="presenter"></iframe>' },
  { name: 'CSS url() with a data: URI', html: '<style>.a{background:url(data:image/gif;base64,R0lGOD)}</style>' },
  { name: 'CSS url() with a fragment (SVG filter)', html: '<style>.a{fill:url(#grad-1)}</style>' },
  { name: 'font-face using a local face only', html: '<style>@font-face{font-family:Brand;src:local("Inter")}</style>' },
  { name: 'base64 payload containing slashes', html: '<script type="application/octet-stream">7b2//w+AA==0//1//2</script>' },
  { name: 'the SVG namespace as a string in code (D14)', html: '<script>var NS = "http://www.w3.org/2000/svg"; var el = document.createElementNS(NS, "svg");</script>' },
  { name: 'the word fetch in a comment', html: '<script>\n// the emitter proves no asset is a network fetch\nvar a = 1;\n</script>' },
  { name: 'the word fetch in a string', html: '<script>var help = "press f to fetch nothing";</script>' },
  { name: 'a regex mentioning WebSocket', html: '<script>var re = /WebSocket|EventSource/g;</script>' },
  { name: 'a URL in visible text', html: '<p>Read more at https://northwind.example/products — the prospect wrote that, not us.</p>' },
  { name: 'a URL in the document title', html: '<title>northwind.example — https://northwind.example</title>' },
  { name: 'window.open with no URL (D16 presenter view)', html: '<script>var w = window.open("", "pp-presenter", "width=900");</script>' },
  { name: 'empty src', html: '<img src="" alt="">' },
  { name: 'inert JSON manifest', html: '<script type="application/json">{"generator":"PitchProof"}</script>' },
];

test('legal artifacts do not trip the scanner', () => {
  for (const legal of LEGAL) {
    const findings = scanForNetworkReferences(legal.html);
    assert.deepEqual(
      findings.map((f) => f.message),
      [],
      `"${legal.name}" was flagged, and it is legal`,
    );
  }
});

test('the three W3C namespace URIs are permitted whole and never as a prefix (D14)', () => {
  for (const ns of ['http://www.w3.org/2000/svg', 'http://www.w3.org/1999/xlink', 'http://www.w3.org/1999/xhtml']) {
    assert.deepEqual(scanForNetworkReferences(`<svg xmlns="${ns}"></svg>`), []);
    assert.deepEqual(scanForNetworkReferences(`<script>var n = "${ns}";</script>`), []);
    const prefixed = scanForNetworkReferences(`<script>var n = "${ns}/collect";</script>`);
    assert.equal(prefixed.length, 1);
    assert.match(prefixed[0].message, /never as a prefix/);
    assert.equal(prefixed[0].severity, 1);
  }
});

test('an empty or absent document produces no findings and does not throw', () => {
  assert.deepEqual(scanForNetworkReferences(''), []);
  assert.deepEqual(scanForNetworkReferences(null), []);
  assert.deepEqual(scanForNetworkReferences(undefined), []);
});

test('malformed markup fails closed rather than throwing', () => {
  const nasty = '<a href="https://x.example" <div <<< "unterminated <script>fetch(1)';
  const findings = scanForNetworkReferences(nasty);
  assert.ok(findings.length > 0, 'hostile markup must still be scanned, not skipped');
  for (const f of findings) assert.equal(f.severity, 1);
});
