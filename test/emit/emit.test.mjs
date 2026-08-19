/**
 * `emit()` end to end (§13, §14, §18).
 *
 * The document structure asserted here is the one `docs/decisions/L10-emit.md`
 * documents and `scripts/verify-offline.mjs` drives, so L12 and the critic have
 * one description that a test keeps true.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emit, scanForNetworkReferences, inlineRuntime, layoutsMissingFor } from '../../src/emit/index.js';
import { resetLayouts } from '../../src/runtime/layouts.js';
import { registerTestLayouts } from '../fixtures/emit/layouts.mjs';
import { runtimeBundle, FIXED_CLOCK } from '../fixtures/emit/runtime-bundle.mjs';
import { artifactModel } from '../fixtures/emit/artifact-dom.mjs';
import { emitProof, tinyProof } from '../fixtures/emit/proofs.mjs';

const { js: runtimeJs, css: runtimeCss } = runtimeBundle();
const deps = { runtimeJs, runtimeCss, clock: FIXED_CLOCK };

/** @returns {Promise<{html: string, value: any}>} */
async function emitOk(proof = emitProof(), options = {}, extra = {}) {
  registerTestLayouts();
  const result = await emit(proof, options, { ...deps, ...extra });
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  return { html: result.value.html, value: result.value };
}

test('the artifact survives its own scanner', async () => {
  const { html } = await emitOk();
  const findings = scanForNetworkReferences(html);
  assert.deepEqual(findings.map((f) => `${f.locus.line}:${f.locus.column} ${f.message}`), []);
});

test('the artifact survives its own scanner with a large, degraded proof too', async () => {
  const proof = emitProof({ imageEdge: 200 });
  const full = await emitOk(proof, { maxBytes: 50_000_000 });
  const { html, value } = await emitOk(proof, { maxBytes: Math.round(full.value.bytes * 0.85) });
  assert.ok(value.degradations.length > 0, 'the tightened budget must actually force degradation');
  assert.deepEqual(scanForNetworkReferences(html), []);
});

test('the document structure is exactly what the decisions doc describes', async () => {
  const { html, value } = await emitOk();

  assert.ok(html.startsWith('<!doctype html>\n<html lang="en-GB" data-pp-artifact="1">'));
  assert.match(html, /<meta charset="utf-8">/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(html, /<title>Northwind Industrial<\/title>/);

  const order = [
    '<style id="pp-runtime-css">',
    '<style id="pp-theme-css">',
    '</head>',
    '<body>',
    '<div id="pp-stage-root" data-pp-prerendered>',
    '<noscript>',
    '<script id="pp-model" type="application/octet-stream">',
    '<script id="pp-media" type="application/octet-stream">',
    '<script id="pp-manifest" type="application/json">',
    '<script id="pp-runtime">',
    '<script id="pp-boot">',
  ];
  let at = -1;
  for (const marker of order) {
    const next = html.indexOf(marker);
    assert.notEqual(next, -1, `the document is missing ${marker}`);
    assert.ok(next > at, `${marker} is out of order — the stage root must precede every payload so the artifact paints first`);
    at = next;
  }

  assert.ok(html.trimEnd().endsWith('</body>\n</html>'), 'the document must close cleanly');

  // The opening beat really is in the file, already staged for beat 0.
  const stage = html.slice(html.indexOf('<div id="pp-stage-root"'), html.indexOf('<noscript>'));
  assert.match(stage, /class="pp-stage"/);
  assert.match(stage, /data-pp-scene="sc_spine_0"/);
  assert.match(stage, /data-pp-beat="0"/);
  assert.match(stage, /data-pp-hash="/);
  assert.match(stage, /pp-unrevealed/, 'later beats must be present but unrevealed, so nothing reflows');
  assert.match(stage, /pp-revealed/, 'beat 0 must already be revealed in the static markup');

  assert.equal(value.compression.mode, 'deflate');
  assert.ok(value.bytes > 0);
  assert.equal(value.bytes, Buffer.byteLength(html, 'utf8'));
});

test('the first paint carries no script and needs none to be legible', async () => {
  const { html } = await emitOk();
  const stage = html.slice(html.indexOf('<div id="pp-stage-root"'), html.indexOf('<noscript>'));
  assert.ok(!/<script/i.test(stage), 'the pre-rendered beat must contain no script at all');
  assert.ok(stage.length > 400, 'the pre-rendered beat must be real content, not an empty shell');
});

test('nothing in the artifact claims a capability was performed live (§18.5)', async () => {
  const { html } = await emitOk();
  const claims = [
    /generated (?:live|just now|on the fly)/i,
    /\bin real ?time\b/i,
    /\bjust generated\b/i,
    /\bpowered by\b/i,
    /\bproduced live\b/i,
  ];
  for (const re of claims) assert.ok(!re.test(html), `the artifact contains a live-capability claim matching ${re}`);
  assert.match(html, /The opening scene is shown above/, 'the noscript message must describe what is true');
});

test('emit refuses without a runtime, without CSS, or without a clock', async () => {
  registerTestLayouts();
  const proof = emitProof();
  assert.match((await emit(proof, {}, null)).error, /deps is required/);
  assert.match((await emit(proof, {}, { runtimeCss, clock: FIXED_CLOCK })).error, /runtimeJs/);
  assert.match((await emit(proof, {}, { runtimeJs, clock: FIXED_CLOCK })).error, /runtimeCss/);
  assert.match((await emit(proof, {}, { runtimeJs, runtimeCss })).error, /clock/);
});

test('emit refuses a proof that does not satisfy the §4 contract', async () => {
  registerTestLayouts();
  const broken = { ...emitProof(), schemaVersion: 2 };
  const result = await emit(broken, {}, deps);
  assert.equal(result.ok, false);
  assert.match(result.error, /does not satisfy the §4 contract/);
});

test('emit refuses when a layout the proof uses is not registered', async () => {
  resetLayouts();
  const proof = emitProof();
  assert.ok(layoutsMissingFor(proof).length > 0);
  const result = await emit(proof, {}, deps);
  assert.equal(result.ok, false);
  assert.match(result.error, /no layout is registered/);
  assert.match(result.error, /registerAllLayouts/);
});

test('a severity-1 refusal names every blocking finding and returns no artifact', async () => {
  registerTestLayouts({ omitLabel: true, ctaHref: 'https://northwind.example/contact' });
  const result = await emit(emitProof(), {}, deps);
  assert.equal(result.ok, false);
  const blocking = result.detail.findings.filter((f) => f.severity === 1);
  assert.ok(blocking.length >= 2, 'the fixture plants both a provenance failure and a network reference');
  for (const f of blocking) {
    assert.ok(result.error.includes(f.message), `the refusal does not name the finding: ${f.message}`);
    assert.ok(result.error.includes(f.code));
  }
  assert.match(result.error, /There is no override flag/);
  assert.equal(result.detail.html, '');
  assert.equal(result.detail.bytes, 0);
});

test('severity-2 and severity-3 findings do not block', async () => {
  registerTestLayouts();
  const result = await emit(emitProof(), {}, { runtimeJs, runtimeCss, clock: () => '2026-09-01T00:00:00.000Z' });
  assert.equal(result.ok, true);
  assert.ok(result.value.findings.length > 0);
  assert.ok(result.value.findings.every((f) => f.severity > 1));
  assert.ok(result.value.html.length > 0);
});

test('EmitResult matches the API.md shape', async () => {
  const { value } = await emitOk();
  assert.deepEqual(
    Object.keys(value).filter((k) => ['html', 'bytes', 'findings', 'degradations', 'compression'].includes(k)).sort(),
    ['bytes', 'compression', 'degradations', 'findings', 'html'],
  );
  assert.equal(typeof value.html, 'string');
  assert.equal(typeof value.bytes, 'number');
  assert.ok(Array.isArray(value.findings));
  assert.ok(Array.isArray(value.degradations));
  assert.deepEqual(Object.keys(value.compression).sort(), ['mediaBytes', 'mode', 'modelBytes']);
});

test('a review build never carries presenter notes, even inside the payload', async () => {
  const { html } = await emitOk(emitProof(), { mode: 'review' });
  const model = decodeModel(html);
  const notes = model.spine.flatMap((s) => s.beats.map((b) => b.presenterNote)).filter(Boolean);
  assert.deepEqual(notes, [], 'a note that travels in the payload is a note a recipient can read out of the file');
  const branchNotes = model.branches.flatMap((b) => b.scenes.flatMap((s) => s.beats.map((x) => x.presenterNote))).filter(Boolean);
  assert.deepEqual(branchNotes, []);
});

test('a presenter build carries the notes it was asked for', async () => {
  const { html } = await emitOk(emitProof(), { mode: 'presenter' });
  const model = decodeModel(html);
  const notes = model.spine.flatMap((s) => s.beats.map((b) => b.presenterNote)).filter(Boolean);
  assert.ok(notes.some((n) => n.includes('in their words')), 'a presenter build must keep its notes');
});

test('user CSS is applied last and is really in the file', async () => {
  const { html } = await emitOk(emitProof(), {}, { userCss: '.pp-headline{letter-spacing:-0.01em}' });
  const userAt = html.indexOf('<style id="pp-user-css">');
  const themeAt = html.indexOf('<style id="pp-theme-css">');
  assert.ok(userAt > themeAt, 'user CSS must come after the brand theme so it can override it');
  assert.match(html, /letter-spacing:-0\.01em/);
});

test('licence-asserted fonts are embedded and unasserted ones are not', async () => {
  const fonts = [
    { family: 'Northwind Sans', dataUri: 'data:font/woff2;base64,AAAA', weight: 400, licenseAsserted: true },
    { family: 'Foundry Display', dataUri: 'data:font/woff2;base64,BBBB', weight: 700, licenseAsserted: false },
  ];
  const { html } = await emitOk(emitProof(), {}, { fonts });
  assert.match(html, /font-family: "Northwind Sans"/);
  assert.ok(!html.includes('Foundry Display'), 'a face nobody asserted a licence for is never embedded (§7)');
});

test('the brand theme is compiled into --pp-* variables and never --st-*', async () => {
  const { html } = await emitOk();
  const theme = html.slice(html.indexOf('<style id="pp-theme-css">'), html.indexOf('</style>', html.indexOf('<style id="pp-theme-css">')));
  assert.match(theme, /--pp-primary: #123a8c;/);
  assert.match(theme, /--pp-font-body: Inter, Arial, sans-serif;/);
  assert.ok(!theme.includes('--st-'), 'D11: the artifact never wears the studio palette');
  // The runtime's own source comments explain the `--st-*` convention, so the
  // check is on declarations and usages, not on the letters appearing anywhere.
  assert.ok(!/--st-[\w-]+\s*:/.test(html), 'the artifact declares no studio variable');
  assert.ok(!/var\(\s*--st-/.test(html), 'the artifact reads no studio variable');
});

test("deps.themeCss wins over the emitter's fallback theme", async () => {
  const { html } = await emitOk(emitProof(), {}, { themeCss: ':root{--pp-primary:#ff0000}' });
  assert.match(html, /--pp-primary:#ff0000/);
  assert.ok(!html.includes('--pp-primary: #123a8c'));
});

test('inlineRuntime works from the five declared arguments alone', () => {
  const proof = tinyProof();
  const html = inlineRuntime({
    runtimeJs: 'var x = 1;',
    runtimeCss: '.pp-stage{color:#000}',
    themeCss: ':root{--pp-primary:#000}',
    proof,
    firstPaintHtml: '<div class="pp-stage"></div>',
  });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<script id="pp-model"/);
  assert.match(html, /ppBootArtifact\(/);
  assert.deepEqual(scanForNetworkReferences(html), []);
});

test('inlineRuntime refuses content that would end its own element', () => {
  const proof = tinyProof();
  assert.throws(
    () => inlineRuntime({ runtimeJs: 'var a = "</script>";', runtimeCss: '', themeCss: '', proof, firstPaintHtml: '' }),
    /would end its <script> element early/,
  );
  assert.throws(
    () => inlineRuntime({ runtimeJs: 'var a = 1;', runtimeCss: 'a{}</style>', themeCss: '', proof, firstPaintHtml: '' }),
    /would end its <style> element early/,
  );
  // A `</style>` inside JavaScript is harmless — the presenter window (D16)
  // writes a whole document as a string — and must not be refused.
  assert.doesNotThrow(() => inlineRuntime({
    runtimeJs: 'var doc = "<html><head><style>x</style></head></html>";',
    runtimeCss: '', themeCss: '', proof, firstPaintHtml: '',
  }));
});

test('a proof with no specimens, renditions or branches still emits', async () => {
  const { html, value } = await emitOk(tinyProof());
  assert.deepEqual(value.findings.filter((f) => f.severity === 1), [], 'nothing may block a minimal proof');
  assert.match(html, /data-pp-scene="sc_only"/);
  assert.equal(value.compression.mode, 'raw');
});

test('the document language follows the prospect, not the tool', async () => {
  const { html } = await emitOk();
  assert.match(html, /<html lang="en-GB"/, 'the specimen declares en-GB');
  const noLocale = await emitOk(tinyProof());
  assert.match(noLocale.html, /<html lang="en"/);
});

test('a prospect name containing markup cannot break out of the title', async () => {
  const proof = { ...emitProof(), prospectName: 'North</title><script>evil()</script>wind' };
  const { html } = await emitOk(proof);
  assert.ok(!html.includes('<title>North</title>'));
  assert.match(html, /&lt;\/title&gt;/);
  assert.deepEqual(scanForNetworkReferences(html), []);
});

/**
 * Decode the artifact's own model payload the way the artifact does, so an
 * assertion about what the file carries is an assertion about the real bytes.
 * @param {string} html
 * @returns {any}
 */
function decodeModel(html) {
  return artifactModel(html);
}
