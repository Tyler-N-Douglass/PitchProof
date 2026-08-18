/**
 * The emitter's own strings must survive the emitter's own scanner.
 *
 * D14 puts it plainly: "a law you evade in your own source is not a law". Every
 * string this lane writes into an artifact — the boot code, the document
 * skeleton, the fallback theme, the noscript message — is scanned here with the
 * same function that scans a customer's proof, at the same severity, with no
 * exemptions.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanForNetworkReferences, scanJs, scanCss } from '../../src/emit/scan.js';
import { artifactRuntimeSource } from '../../src/emit/artifact-runtime.js';
import { inlineRuntime } from '../../src/emit/document.js';
import { compileFallbackTheme, compileFontFaces } from '../../src/emit/theme.js';
import { runtimeBundle } from '../fixtures/emit/runtime-bundle.mjs';
import { emitProof, tinyProof } from '../fixtures/emit/proofs.mjs';

test('the artifact boot source is clean in both variants', () => {
  for (const mode of ['deflate', 'raw']) {
    const source = artifactRuntimeSource(mode);
    assert.deepEqual(scanJs(source).map((f) => f.message), [], `the ${mode} boot source trips the scanner`);
    assert.deepEqual(
      scanForNetworkReferences(`<script>${source}</script>`).map((f) => f.message),
      [],
      `the ${mode} boot source trips the scanner when embedded`,
    );
  }
});

test('the bundled presentation runtime is clean', () => {
  const { js, css } = runtimeBundle();
  assert.deepEqual(scanJs(js).map((f) => f.message), [], 'the runtime bundle trips the scanner');
  assert.deepEqual(scanCss(css).map((f) => f.message), [], 'the runtime stylesheet trips the scanner');
});

test('the fallback theme and embedded font rules are clean', () => {
  const proof = emitProof();
  assert.deepEqual(scanCss(compileFallbackTheme(proof.brand).css).map((f) => f.message), []);
  const fontCss = compileFontFaces([{ family: 'Brand', dataUri: 'data:font/woff2;base64,AAAA', licenseAsserted: true }]);
  assert.deepEqual(scanCss(fontCss).map((f) => f.message), []);
});

test('an assembled document with an empty runtime is clean', () => {
  const html = inlineRuntime({
    runtimeJs: '/* nothing */',
    runtimeCss: '',
    themeCss: '',
    proof: tinyProof(),
    firstPaintHtml: '<div class="pp-stage"></div>',
  });
  assert.deepEqual(scanForNetworkReferences(html).map((f) => f.message), []);
});

test('the scanner is not fooled by its own allowlist appearing in the runtime', () => {
  const { js } = runtimeBundle();
  assert.ok(js.includes('http://www.w3.org/2000/svg'), 'the runtime needs the SVG namespace for createElementNS (D14)');
  assert.deepEqual(scanJs(js).map((f) => f.message), []);
  // The same runtime with one character added to that namespace must fail.
  const tampered = js.replace('http://www.w3.org/2000/svg', 'http://www.w3.org/2000/svgx');
  const findings = scanJs(tampered);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /never as a prefix|absolute URL/);
});

test('every finding the scanner can produce carries the fixed severity', () => {
  const planted = '<img src="https://x.example/a.png"><style>@import "y.css"</style><script>fetch(z)</script>';
  const findings = scanForNetworkReferences(planted);
  assert.ok(findings.length >= 3);
  for (const f of findings) {
    assert.equal(f.severity, 1, 'FIXED_SEVERITY pins NETWORK_REFERENCE at 1 and no lane may lower it');
    assert.equal(f.code, 'NETWORK_REFERENCE');
  }
});
