/**
 * The L3 surface, as `API.md` Part 3 declares it.
 *
 * API.md is binding: "a lane exports exactly the surface declared here, from
 * the module path declared here, with the signature declared here." Nine lanes
 * are written in parallel against code that does not exist yet, so this test is
 * the mechanism that turns that sentence into a build failure rather than an
 * integration surprise.
 *
 * It also enforces the two cross-cutting laws that apply to every file in the
 * lane: determinism (§5) and the bundler's ESM subset (D3).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative } from 'node:path';

import * as ingest from '../../src/ingest/index.js';
import { bundle } from '../../scripts/lib/bundler.mjs';
import { tinyPng } from './helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const SRC = join(ROOT, 'src');
const LANE = join(SRC, 'ingest');

/** Every `.js` file in the lane, sorted. */
function laneFiles(dir = LANE, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) laneFiles(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

const FILES = laneFiles();
const PNG = tinyPng(4, 3);

test('the lane has files, and they all live under src/ingest', () => {
  assert.ok(FILES.length >= 10, 'the lane should be more than a stub');
  for (const file of FILES) assert.ok(file.startsWith(LANE), file);
});

// ---------------------------------------------------------------------------
// The declared surface
// ---------------------------------------------------------------------------

test('every export API.md declares for L3 is present, and is a function', () => {
  const declared = [
    'parseHtml', 'querySelectorAll', 'textContent', 'attr',
    'fetchStrategies', 'ingestUrl', 'importSavedPage', 'importHar', 'importMhtml',
    'importHtmlText', 'importOoxml', 'importPdf', 'importImage',
    'discoverSitemap', 'rankCandidates',
  ];
  for (const name of declared) {
    assert.equal(typeof ingest[name], 'function', `src/ingest/index.js must export ${name}`);
  }
});

test('the declared signatures take the arguments API.md says they take', () => {
  const arity = {
    parseHtml: 1, querySelectorAll: 2, textContent: 1, attr: 2,
    fetchStrategies: 0, ingestUrl: 2, importSavedPage: 2, importHar: 2, importMhtml: 2,
    importHtmlText: 2, importOoxml: 2, importPdf: 2, importImage: 2,
    discoverSitemap: 2, rankCandidates: 1,
  };
  for (const [name, expected] of Object.entries(arity)) {
    const fn = ingest[name];
    // A parameter with a default does not count towards `length`, so the
    // declared arity is the upper bound.
    assert.ok(fn.length <= expected, `${name} declares ${fn.length} required parameters, more than API.md's ${expected}`);
  }
});

test('the DocNode shape is the one API.md declares', () => {
  const doc = ingest.parseHtml('<div class="a">text<!--c--></div>');
  const div = ingest.querySelectorAll(doc, 'div')[0];
  assert.equal(div.type, 'element');
  assert.equal(typeof div.tag, 'string');
  assert.equal(typeof div.attrs, 'object');
  assert.ok(Array.isArray(div.children));
  assert.equal(div.parent.type, 'element');
  assert.deepEqual(div.children.map((c) => c.type), ['text', 'comment']);
  assert.equal(div.children[0].text, 'text');
  assert.equal(ingest.textContent(div), 'text');
  assert.equal(ingest.attr(div, 'class'), 'a');
  assert.equal(ingest.attr(div, 'missing'), null);
});

test('the RawCapture shape is the one API.md declares, for every importer', async () => {
  const clock = () => '2026-03-04T09:15:00.000Z';
  const results = [
    ingest.importHtmlText('<p>x</p>', { clock }),
    ingest.importImage(PNG, { name: 'logo.png', clock }),
    ingest.importPdf(new Uint8Array(readFileSync(join(ROOT, 'test', 'fixtures', 'ingest', 'sample.pdf'))), { name: 'x.pdf', clock }),
    ingest.importOoxml(new Uint8Array(readFileSync(join(ROOT, 'test', 'fixtures', 'ingest', 'sample.docx'))), { name: 'x.docx', clock }),
    await ingest.importSavedPage([{ name: 'p.html', text: '<title>T</title><p>x</p>' }], { clock }),
  ];
  const kinds = new Set(['html', 'document', 'image']);
  for (const result of results) {
    if (!result.ok) continue;
    for (const capture of Array.isArray(result.value) ? result.value : [result.value]) {
      assert.ok(kinds.has(capture.kind), `kind must be one of ${[...kinds]}, got ${capture.kind}`);
      assert.ok(capture.sourceUrl === null || typeof capture.sourceUrl === 'string');
      assert.equal(typeof capture.capturedAt, 'string');
      assert.ok(capture.html === null || typeof capture.html === 'string');
      assert.ok(capture.doc === null || capture.doc.type === 'element');
      assert.ok(capture.blocks === null || Array.isArray(capture.blocks));
      assert.ok(Array.isArray(capture.assets));
      for (const asset of capture.assets) {
        assert.equal(typeof asset.name, 'string');
        assert.ok(asset.bytes instanceof Uint8Array);
        assert.equal(typeof asset.mime, 'string');
      }
      assert.equal(typeof capture.meta, 'object');
      for (const [key, value] of Object.entries(capture.meta)) {
        assert.equal(typeof value, 'string', `meta.${key} must be a string`);
      }
      assert.equal(typeof capture.strategy, 'string');
    }
  }
});

test('every block an importer produces is a legal §4 ContentBlock', async () => {
  const { validateBlock } = await import('../../src/core/contracts.js');
  const clock = () => '2026-03-04T09:15:00.000Z';
  const captures = [
    ingest.importPdf(new Uint8Array(readFileSync(join(ROOT, 'test', 'fixtures', 'ingest', 'sample.pdf'))), { name: 'x.pdf', clock }),
    ingest.importOoxml(new Uint8Array(readFileSync(join(ROOT, 'test', 'fixtures', 'ingest', 'sample.docx'))), { name: 'x.docx', clock }),
    ingest.importOoxml(new Uint8Array(readFileSync(join(ROOT, 'test', 'fixtures', 'ingest', 'sample.pptx'))), { name: 'x.pptx', clock }),
    ingest.importManual({ text: '# H\n\nBody.\n\n- a\n\n> q\n\n| a | b |\n\n[L](https://x.example)' }, { clock }),
  ];
  for (const result of captures) {
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    /** @type {string[]} */
    const errs = [];
    result.value.blocks.forEach((block, i) => validateBlock(block, `blocks[${i}]`, errs));
    assert.deepEqual(errs, [], `${result.value.strategy} produced an illegal block`);
  }
});

test('a Strategy record carries everything a studio needs to render it', () => {
  for (const strategy of ingest.fetchStrategies()) {
    assert.equal(typeof strategy.id, 'string');
    assert.equal(typeof strategy.order, 'number');
    assert.equal(typeof strategy.specOrder, 'number');
    assert.equal(typeof strategy.label, 'string');
    assert.equal(typeof strategy.describe, 'string');
    assert.ok(['network', 'file', 'paste', 'manual'].includes(strategy.kind));
    assert.equal(typeof strategy.automatic, 'boolean');
    assert.ok(Array.isArray(strategy.accepts));
    assert.ok(Array.isArray(strategy.requires));
    assert.equal(typeof strategy.run, 'function');
  }
});

test('a SitemapEntry carries the fields a ranker and a studio both read', () => {
  const parsed = ingest.parseSitemap('<urlset><url><loc>https://a.example/blog/a-post-with-a-slug</loc><lastmod>2026-01-01</lastmod></url></urlset>', '');
  const [entry] = ingest.rankCandidates(parsed.entries);
  for (const key of ['url', 'lastmod', 'changefreq', 'priority', 'alternates', 'source', 'kind', 'depth', 'slug', 'score', 'signals']) {
    assert.ok(key in entry, `a SitemapEntry must declare ${key}`);
  }
});

// ---------------------------------------------------------------------------
// Cross-cutting laws
// ---------------------------------------------------------------------------

test('no source file in the lane reads a clock or an unseeded random source (§5)', () => {
  const banned = [
    /\bMath\s*\.\s*random\s*\(/,
    /\bDate\s*\.\s*now\s*\(/,
    /\bnew\s+Date\s*\(\s*\)/,
    /\bperformance\s*\.\s*now\s*\(/,
    /\bcrypto\s*\.\s*getRandomValues\s*\(/,
    /\bcrypto\s*\.\s*randomUUID\s*\(/,
  ];
  for (const file of FILES) {
    const source = readFileSync(file, 'utf8');
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    for (const pattern of banned) {
      assert.equal(pattern.test(code), false, `${relative(ROOT, file)} uses ${pattern}`);
    }
  }
});

test('nothing in the lane touches a global network API (API.md: http is injected)', () => {
  for (const file of FILES) {
    const source = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    for (const pattern of [/(^|[^.\w])fetch\s*\(/, /\bXMLHttpRequest\b/, /\bWebSocket\b/, /\bEventSource\b/, /\bsendBeacon\b/]) {
      assert.equal(pattern.test(source), false, `${relative(ROOT, file)} reaches for a global transport: ${pattern}`);
    }
  }
});

test('every import is relative, carries a .js extension, and points inside core or the lane', () => {
  for (const file of FILES) {
    const source = readFileSync(file, 'utf8');
    const imports = [...source.matchAll(/(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const spec of imports) {
      assert.ok(spec.startsWith('.'), `${relative(ROOT, file)} imports "${spec}" — the bundler takes relative paths only`);
      assert.ok(spec.endsWith('.js'), `${relative(ROOT, file)} imports "${spec}" without a .js extension`);
      const target = resolve(dirname(file), spec);
      assert.ok(
        target.startsWith(join(SRC, 'core')) || target.startsWith(LANE) || target.startsWith(join(SRC, 'runtime')),
        `${relative(ROOT, file)} reaches into ${relative(ROOT, target)} — a lane may import only core, runtime and itself`,
      );
    }
  }
});

test('the lane uses no syntax the bundler refuses (D3)', () => {
  for (const file of FILES) {
    const source = readFileSync(file, 'utf8');
    assert.equal(/^\s*export\s+\*/m.test(source), false, `${relative(ROOT, file)} uses export *`);
    assert.equal(/^\s*export\s+default\b/m.test(source), false, `${relative(ROOT, file)} uses export default`);
    assert.equal(/[^.\w]import\s*\(/.test(source.replace(/\/\*[\s\S]*?\*\//g, '')), false, `${relative(ROOT, file)} uses a dynamic import`);
  }
});

test('the lane bundles, deterministically, with no import cycle', () => {
  const once = bundle({ entry: join(LANE, 'index.js'), root: SRC, global: 'PitchProofIngest' });
  const twice = bundle({ entry: join(LANE, 'index.js'), root: SRC, global: 'PitchProofIngest' });
  assert.equal(once.code, twice.code, 'two bundles of the same source must be byte-identical');
  assert.ok(once.code.length > 10000);
  assert.ok(once.modules.length >= FILES.length);
});
