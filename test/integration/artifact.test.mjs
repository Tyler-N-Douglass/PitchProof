/**
 * The whole chain, end to end: model → scenes → emit → a file a client opens.
 *
 * Each lane proves its own part. This proves the seams between them, which is
 * where parallel work actually breaks, and it proves the two things §1.2 calls
 * the definition of done: that an emitted artifact opens on a machine with
 * networking disabled, and that it can be presented start to finish from the
 * keyboard.
 *
 * §13 and §17.7 are the load-bearing assertions here. A single attempted
 * request is a failure, not a warning.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { bundle } from '../../scripts/lib/bundler.mjs';
import { makeProof } from '../fixtures/make-proof.mjs';
import { corpusClock } from '../fixtures/corpus/index.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Lanes land at different times; skip cleanly rather than fail spuriously. */
function lanesReady() {
  return existsSync(join(ROOT, 'src/emit/index.js')) && existsSync(join(ROOT, 'src/scene/index.js'));
}

async function loadChromium() {
  try { return (await import('playwright')).chromium; } catch { return null; }
}

/** Bundle the runtime and collect the artifact stylesheet, as the build does. */
function runtimeDeps() {
  const runtimeJs = bundle({
    entry: join(ROOT, 'src/runtime/index.js'),
    root: join(ROOT, 'src'),
    global: 'PitchProofRuntime',
  }).code;
  const cssParts = [join(ROOT, 'src/runtime/runtime.css')];
  for (const extra of ['src/branch/branch.css', 'src/scene/scenes.css']) {
    const p = join(ROOT, extra);
    if (existsSync(p)) cssParts.push(p);
  }
  return { runtimeJs, runtimeCss: cssParts.map((p) => readFileSync(p, 'utf8')).join('\n') };
}

/**
 * @returns {Promise<{emit: Function, registerAllLayouts: Function}>}
 */
async function lanes() {
  const { emit } = await import(join(ROOT, 'src/emit/index.js'));
  const { registerAllLayouts } = await import(join(ROOT, 'src/scene/index.js'));
  registerAllLayouts();
  return { emit, registerAllLayouts };
}

test('a proof emits a single self-contained file with no blocking findings', async (t) => {
  if (!lanesReady()) return t.skip('emit or scene lane has not landed yet');
  const { emit } = await lanes();
  const result = await emit(makeProof(), {}, { ...runtimeDeps(), clock: corpusClock() });

  assert.equal(result.ok, true, result.ok ? '' : String(result.error));
  const artifact = result.value;
  assert.ok(artifact.bytes > 10_000, `an artifact of ${artifact.bytes} bytes cannot contain a runtime`);
  assert.deepEqual(
    artifact.findings.filter((f) => f.severity === 1),
    [],
    'a severity-1 finding must block the emit, so a successful emit cannot carry one',
  );
  assert.ok(artifact.html.startsWith('<!doctype html>') || artifact.html.startsWith('<!DOCTYPE html>'), artifact.html.slice(0, 40));
  assert.ok(['deflate', 'raw'].includes(artifact.compression.mode));
});

test('§17.6: the same proof emits byte-identical output twice', async (t) => {
  if (!lanesReady()) return t.skip('emit or scene lane has not landed yet');
  const { emit } = await lanes();
  const deps = runtimeDeps();
  const a = await emit(makeProof(), {}, { ...deps, clock: corpusClock() });
  const b = await emit(makeProof(), {}, { ...deps, clock: corpusClock() });
  assert.equal(a.ok && b.ok, true);
  assert.equal(a.value.html.length, b.value.html.length);
  assert.equal(a.value.html, b.value.html, 'two emits of the same project must be byte-identical');
});

test('§13/§17.7: the emitted artifact opens from file:// with the network blocked', async (t) => {
  if (!lanesReady()) return t.skip('emit or scene lane has not landed yet');
  const chromium = await loadChromium();
  if (!chromium) return t.skip('playwright is not linked in node_modules');

  const { emit } = await lanes();
  const result = await emit(makeProof(), {}, { ...runtimeDeps(), clock: corpusClock() });
  assert.equal(result.ok, true, result.ok ? '' : String(result.error));

  const dir = mkdtempSync(join(tmpdir(), 'pp-artifact-'));
  const file = join(dir, 'northwind.pitchproof.html');
  writeFileSync(file, result.value.html);

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    /** @type {string[]} */
    const attempted = [];
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith('file://')) { route.continue(); return; }
      attempted.push(url);
      route.abort();
    });
    const page = await context.newPage();
    /** @type {string[]} */
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('requestfailed', (r) => { if (!r.url().startsWith('file://')) attempted.push(r.url()); });

    await page.goto(pathToFileURL(file).href, { waitUntil: 'load' });

    assert.deepEqual(attempted, [], `the artifact attempted ${attempted.length} request(s): ${attempted.join(', ')}`);
    assert.deepEqual(errors, [], errors.join('\n'));

    // §12 cold-boot budget: first meaningful paint under 1.5s from a local file.
    const fcp = await page.evaluate(() => new Promise((res) => {
      const entry = performance.getEntriesByName('first-contentful-paint')[0];
      if (entry) return res(entry.startTime);
      new PerformanceObserver((list, obs) => {
        for (const e of list.getEntries()) if (e.name === 'first-contentful-paint') { obs.disconnect(); res(e.startTime); }
      }).observe({ type: 'paint', buffered: true });
      setTimeout(() => res(-1), 5000);
    }));
    assert.ok(fcp >= 0, 'the artifact never painted');
    assert.ok(fcp < 1500, `first-contentful-paint was ${fcp}ms, over the 1.5s budget`);

    // The scene is on screen because the emitter pre-rendered it, not because
    // a script drew it.
    const sceneText = (await page.textContent('.pp-scene')) || '';
    assert.ok(sceneText.trim().length > 0, 'the opening scene is blank');

    // A full keyboard walk of the deck, then back to the spine.
    for (let i = 0; i < 60; i += 1) await page.keyboard.press('ArrowRight');
    await page.keyboard.press('r');
    const state = await page.evaluate(() => {
      const el = document.querySelector('.pp-stage');
      return { sequence: el.getAttribute('data-pp-sequence'), beat: el.getAttribute('data-pp-beat') };
    });
    assert.equal(state.sequence, 'spine', 'a full walk must never strand the presenter off the spine');

    // Blank screen and the help overlay both work from the keyboard.
    await page.keyboard.press('b');
    assert.equal(await page.locator('.pp-blank').count(), 1, 'blank screen');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.pp-blank').count(), 0);
    await page.keyboard.press('?');
    assert.equal(await page.locator('.pp-overlay--help').count(), 1, 'help overlay');
    await page.keyboard.press('Escape');

    // Still nothing on the wire after driving the whole deck.
    assert.deepEqual(attempted, [], `requests attempted during the walk: ${attempted.join(', ')}`);
    assert.deepEqual(errors, [], errors.join('\n'));
  } finally {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the artifact survives its own network scanner', async (t) => {
  if (!lanesReady()) return t.skip('emit or scene lane has not landed yet');
  const { emit } = await lanes();
  const { scanForNetworkReferences } = await import(join(ROOT, 'src/emit/index.js'));
  const result = await emit(makeProof(), {}, { ...runtimeDeps(), clock: corpusClock() });
  assert.equal(result.ok, true, result.ok ? '' : String(result.error));
  const findings = scanForNetworkReferences(result.value.html);
  assert.deepEqual(findings, [], findings.map((f) => `${f.code}: ${f.message}`).join('\n'));
});

test('the scanner catches every planted violation and passes every legal one (§20.4)', async (t) => {
  if (!lanesReady()) return t.skip('emit lane has not landed yet');
  const { scanForNetworkReferences } = await import(join(ROOT, 'src/emit/index.js'));

  const planted = [
    ['remote image', '<img src="https://x.example/a.png">'],
    ['remote script', '<script src="https://x.example/a.js"></script>'],
    ['remote stylesheet', '<link rel="stylesheet" href="https://x.example/a.css">'],
    ['css @import', '<style>@import url("https://x.example/a.css");</style>'],
    ['a fetch call', '<script>fetch("https://x.example/a")</script>'],
    ['a beacon', '<script>navigator.sendBeacon("/t", "x")</script>'],
    ['protocol-relative', '<img src="//cdn.example/a.png">'],
  ];
  for (const [label, body] of planted) {
    const findings = scanForNetworkReferences(`<!doctype html><html><body>${body}</body></html>`);
    assert.ok(findings.length > 0, `${label} was not caught`);
    assert.equal(findings[0].code, 'NETWORK_REFERENCE', label);
    assert.equal(findings[0].severity, 1, `${label} must be severity 1`);
  }

  const legal = [
    ['inline SVG', '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'],
    ['data URI image', '<img src="data:image/png;base64,iVBORw0KGgo=">'],
    ['fragment link', '<a href="#sc_1">Jump</a>'],
  ];
  for (const [label, body] of legal) {
    const findings = scanForNetworkReferences(`<!doctype html><html><body>${body}</body></html>`);
    assert.deepEqual(findings, [], `${label} must not trip the scanner (D10)`);
  }
});

test('content carrying a network reference never reaches the artifact', async (t) => {
  if (!lanesReady()) return t.skip('emit or scene lane has not landed yet');
  const { emit } = await lanes();
  const deps = { ...runtimeDeps(), clock: corpusClock() };

  // Exactly what the §20 critic will try: smuggle a tracking pixel into
  // content that the artifact renders.
  const withRawPixel = makeProof();
  withRawPixel.specimens = [{
    id: 'sp_planted', kind: 'page', title: 'Planted', sourceUrl: null,
    capturedAt: '2026-02-01T09:00:00.000Z',
    blocks: [{ type: 'raw', html: '<img src="https://tracker.example/pixel.gif" width="1" height="1">' }],
    media: [], meta: {}, wordCount: 0, locale: null,
  }];
  withRawPixel.spine[0].specimenId = 'sp_planted';
  const rawResult = await emit(withRawPixel, {}, deps);
  if (rawResult.ok) {
    assert.ok(!rawResult.value.html.includes('tracker.example'),
      'a tracking pixel reached the artifact — §8 requires a per-specimen opt-in before raw HTML renders at all');
  } else {
    assert.match(String(rawResult.error), /NETWORK_REFERENCE|network/i);
  }

  // A MediaRef whose dataUri is a network URL is a model that is wrong: §4
  // says media is "always inlined by emit time".
  const withRemoteMedia = makeProof();
  withRemoteMedia.specimens = [{
    id: 'sp_media', kind: 'page', title: 'Media', sourceUrl: null,
    capturedAt: '2026-02-01T09:00:00.000Z',
    blocks: [{ type: 'media', ref: 'md_remote', caption: 'Hero' }],
    media: [{ id: 'md_remote', dataUri: 'https://cdn.example/hero.png', alt: 'Hero', intrinsic: { w: 800, h: 400 }, bytes: 1000 }],
    meta: {}, wordCount: 0, locale: null,
  }];
  withRemoteMedia.spine[0].specimenId = 'sp_media';
  const mediaResult = await emit(withRemoteMedia, {}, deps);
  if (mediaResult.ok) {
    assert.ok(!mediaResult.value.html.includes('cdn.example'), 'a remote media URL reached the artifact');
  } else {
    assert.match(String(mediaResult.error), /NETWORK_REFERENCE|ASSET_MISSING|network/i);
  }

  // A logo whose inline SVG loads an external image is the same attack through
  // the brand rather than through content.
  const withRemoteLogo = makeProof();
  withRemoteLogo.brand.logos = [{
    id: 'lg_evil', kind: 'svg', variant: 'primary',
    data: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><image href="https://evil.example/x.png" width="10" height="10"/></svg>',
    intrinsic: { w: 10, h: 10 }, hasTransparency: true,
  }];
  const logoResult = await emit(withRemoteLogo, {}, deps);
  if (logoResult.ok) {
    assert.ok(!logoResult.value.html.includes('evil.example'), 'a remote image inside a logo reached the artifact');
  } else {
    assert.match(String(logoResult.error), /NETWORK_REFERENCE|network/i);
  }
});

test('no code path anywhere lets a severity-1 finding through (§14)', async () => {
  const { readdirSync, statSync, readFileSync } = await import('node:fs');
  /** @param {string} dir @param {string[]} out */
  const walk = (dir, out = []) => {
    if (!existsSync(dir)) return out;
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (name.endsWith('.js')) out.push(p);
    }
    return out;
  };
  /** @type {string[]} */
  const suspicious = [];
  for (const file of walk(join(ROOT, 'src'))) {
    const src = readFileSync(file, 'utf8');
    // An override would have to be spelled something like this to be usable.
    for (const re of [/\b(force|skip|ignore|bypass|allow|override)(Emit|Findings|Severity|Blocking|Preflight|Validation)\b/g,
      /\bemit\s*\([^)]*\bforce\s*:/g]) {
      for (const m of src.matchAll(re)) {
        suspicious.push(`${file.slice(ROOT.length + 1)}: ${m[0]}`);
      }
    }
  }
  assert.deepEqual(suspicious, [], `possible severity-1 override:\n  ${suspicious.join('\n  ')}`);
});
