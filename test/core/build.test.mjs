/**
 * The build path (DECISIONS D3) and the determinism linter.
 *
 * §17.6 requires the same project to emit byte-identical output twice. That
 * starts with the bundler: if the bundle is not reproducible, nothing
 * downstream of it can be.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bundle, parseModule, BundleError } from '../../scripts/lib/bundler.mjs';
import { scan, BANNED, jsFiles } from '../../scripts/lint-determinism.mjs';
import { buildAll, jsStringLiteral, cssFiles, concatCss, sourceFingerprint } from '../../scripts/build.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Build a throwaway source tree and return its root. */
function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'pp-bundle-'));
  for (const [name, contents] of Object.entries(files)) {
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, contents);
  }
  return dir;
}

test('a bundled module graph evaluates to the entry namespace', () => {
  const dir = tree({
    'a/util.js': 'export const two = 2;\nexport function twice(n) { return n * two; }\n',
    'a/mid.js': "import { twice } from './util.js';\nexport const six = twice(3);\n",
    'main.js': "import { six } from './a/mid.js';\nimport { two } from './a/util.js';\nexport const total = six + two;\n",
  });
  try {
    const { code, modules } = bundle({ entry: join(dir, 'main.js'), root: dir });
    assert.deepEqual(modules.map((m) => m.id), ['a/util.js', 'a/mid.js', 'main.js']);
    const ns = (0, eval)(code);
    assert.equal(ns.total, 8);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('bundling twice from the same sources is byte-identical', () => {
  const dir = tree({
    'x.js': 'export const x = 1;\n',
    'y.js': "import { x } from './x.js';\nexport const y = x + 1;\n",
    'main.js': "import { y } from './y.js';\nimport { x } from './x.js';\nexport const sum = x + y;\n",
  });
  try {
    const a = bundle({ entry: join(dir, 'main.js'), root: dir }).code;
    const b = bundle({ entry: join(dir, 'main.js'), root: dir }).code;
    assert.equal(a, b);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('every import form the repo uses is supported', () => {
  const dir = tree({
    'lib.js': 'export const a = 1;\nexport const b = 2;\nexport class C { v() { return 3; } }\nexport function f() { return 4; }\n',
    'main.js': [
      "import { a } from './lib.js';",
      "import { b as renamed } from './lib.js';",
      "import * as ns from './lib.js';",
      'export const total = a + renamed + new ns.C().v() + ns.f();',
    ].join('\n') + '\n',
  });
  try {
    const ns = (0, eval)(bundle({ entry: join(dir, 'main.js'), root: dir }).code);
    assert.equal(ns.total, 10);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a multi-line import and a multi-line export list are handled', () => {
  const dir = tree({
    'lib.js': 'const a = 1;\nconst b = 2;\nexport {\n  a,\n  b as bee,\n};\n',
    'main.js': "import {\n  a,\n  bee,\n} from './lib.js';\nexport const sum = a + bee;\n",
  });
  try {
    const ns = (0, eval)(bundle({ entry: join(dir, 'main.js'), root: dir }).code);
    assert.equal(ns.sum, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the bundler refuses what it cannot compile correctly', () => {
  const cases = [
    ["import x from 'lodash';\n", /bare import/],
    ["import { a } from './lib';\n", /explicit \.js extension/],
    ["export * from './lib.js';\n", /export \* is not supported/],
    ['export default 42;\n', /export default is not supported/],
  ];
  for (const [src, re] of cases) {
    const dir = tree({ 'lib.js': 'export const a = 1;\n', 'main.js': src });
    try {
      assert.throws(() => bundle({ entry: join(dir, 'main.js'), root: dir }), re, src);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('an import cycle is reported with its path, not silently mis-ordered', () => {
  const dir = tree({
    'a.js': "import { b } from './b.js';\nexport const a = b + 1;\n",
    'b.js': "import { a } from './a.js';\nexport const b = a + 1;\n",
  });
  try {
    assert.throws(() => bundle({ entry: join(dir, 'a.js'), root: dir }), /import cycle: a\.js → b\.js → a\.js/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('parseModule records exports and preserves line count', () => {
  const src = 'import { z } from "./z.js";\n\nexport const q = z;\nexport function g() {}\n';
  const dir = tree({ 'z.js': 'export const z = 1;\n', 'm.js': src });
  try {
    const mod = parseModule(join(dir, 'm.js'), src, dir);
    assert.deepEqual(mod.exports, ['q', 'g']);
    assert.deepEqual(mod.deps, ['z.js']);
    assert.ok(mod.body.includes('__exports["q"] = q;'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('every core module bundles and still behaves', () => {
  const src = join(ROOT, 'src');
  for (const entry of ['core/text-metrics.js', 'core/zip.js', 'core/storage.js', 'core/command.js', 'core/vdom.js', 'core/contracts.js']) {
    const { code } = bundle({ entry: join(src, entry), root: src });
    const ns = (0, eval)(code);
    assert.ok(Object.keys(ns).length > 0, `${entry} exported nothing`);
  }
  const tm = (0, eval)(bundle({ entry: join(src, 'core/text-metrics.js'), root: src }).code);
  assert.equal(tm.measureText('Hello', { family: 'Helvetica', fontSizePx: 1000 }), 2278);
});

test('the whole build is deterministic across two runs', () => {
  const a = buildAll();
  const b = buildAll();
  assert.deepEqual([...a.outputs.keys()].sort(), [...b.outputs.keys()].sort());

  // Two `buildAll()` calls that disagree have two very different explanations:
  // the build is not a pure function of its inputs, or somebody wrote to `src/`
  // between them. During a parallel lane build the second is overwhelmingly the
  // likelier — and that is exactly the circumstance in which the first must not
  // be waved away, so the two are separated rather than guessed at.
  const differing = [...a.outputs.keys()].filter((name) => a.outputs.get(name) !== b.outputs.get(name));
  if (differing.length && a.fingerprint !== b.fingerprint) {
    assert.fail(
      `src/ changed while this test ran, so ${differing.join(', ')} describe two different working trees. `
      + 'This is not a determinism result either way — re-run on a quiet tree.');
  }
  assert.deepEqual(differing, [], `${differing.join(', ')} differ between two builds of identical sources`);
});

test('the source fingerprint moves when a source moves, and not otherwise', () => {
  assert.equal(sourceFingerprint(), sourceFingerprint(), 'the real tree does not fingerprint stably');
  assert.match(sourceFingerprint(), /^[0-9a-f]{64}$/);

  // Probed against a temporary tree, never against `src/`. An earlier version of
  // this test wrote a probe file into `src/` and deleted it — which was harmless
  // in isolation and made `the whole build is deterministic across two runs`
  // fail intermittently in the full parallel run, because that test builds from
  // `src/` in another process at the same moment. A test that mutates the tree
  // other tests read is a source of exactly the flake the fingerprint exists to
  // diagnose.
  const dir = tree({ 'a.css': '.a{}', 'nested/b.js': 'export const b = 1;\n' });
  try {
    const before = sourceFingerprint(dir);
    assert.equal(sourceFingerprint(dir), before);

    writeFileSync(join(dir, 'c.css'), '/* probe */\n');
    const added = sourceFingerprint(dir);
    assert.notEqual(added, before, 'adding a file did not move the fingerprint');

    rmSync(join(dir, 'c.css'), { force: true });
    assert.equal(sourceFingerprint(dir), before, 'removing the file did not restore the fingerprint');

    writeFileSync(join(dir, 'a.css'), '.a{color:red}');
    assert.notEqual(sourceFingerprint(dir), before, 'editing a file did not move the fingerprint');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('embedded source strings cannot break out of a script element', () => {
  const lit = jsStringLiteral('</script><img onerror=alert(1)>');
  assert.ok(!lit.includes('</script>'));
  assert.equal((0, eval)(lit), '</script><img onerror=alert(1)>');
  assert.ok(!jsStringLiteral('a\u2028b').includes('\u2028'));
});

test('CSS concatenation is sorted, so the bundle does not depend on readdir order', () => {
  const dir = tree({ 'b.css': '.b{}', 'a.css': '.a{}', 'nested/c.css': '.c{}' });
  try {
    const files = cssFiles(dir);
    assert.deepEqual(files.map((f) => f.slice(dir.length + 1).split('\\').join('/')), ['a.css', 'b.css', 'nested/c.css']);
    assert.ok(concatCss(files).indexOf('.a{}') < concatCss(files).indexOf('.b{}'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('src/ contains no unseeded randomness or wall-clock reads', () => {
  const findings = scan(join(ROOT, 'src'));
  assert.deepEqual(findings, [], findings.map((f) => `${f.file}:${f.line} ${f.what}`).join('\n'));
});

test('the determinism linter actually catches a planted violation', () => {
  const dir = tree({
    'clean.js': 'export const a = 1;\n',
    'dirty.js': 'export const id = () => Math.random().toString(36);\n',
    'quarantined.js': 'export const t = () => Date.now(); // determinism-quarantine: presenter timer display\n',
    'in-a-comment.js': '// never call Math.random() here\nexport const b = 2;\n',
    'in-a-block-comment.js': '/**\n * Do not use Date.now() in a model path.\n */\nexport const c = 3;\n',
  });
  try {
    const findings = scan(dir);
    assert.equal(findings.length, 1, findings.map((f) => `${f.file}:${f.line}`).join(', '));
    assert.equal(findings[0].file.endsWith('dirty.js'), true);
    assert.equal(findings[0].what, 'Math.random()');
    assert.match(findings[0].fix, /PCG32/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the banned list covers every entropy and clock source the spec names', () => {
  const names = BANNED.map((b) => b.what);
  for (const needed of ['Math.random()', 'Date.now()', 'new Date()', 'crypto.getRandomValues()']) {
    assert.ok(names.includes(needed), `missing ${needed}`);
  }
});

test('the linter walks every .js file under src/', () => {
  const files = jsFiles(join(ROOT, 'src'));
  assert.ok(files.length >= 12, `only found ${files.length}`);
  assert.ok(files.every((f) => f.endsWith('.js')));
  assert.deepEqual(files, [...files].sort(), 'file order must be deterministic');
});
