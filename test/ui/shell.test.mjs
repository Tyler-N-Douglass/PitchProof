/**
 * The document shell and the bundle that goes into it.
 *
 * `src/ui/shell.html` is the one file in this lane that the build reads rather
 * than imports, so its contract with `scripts/build.mjs` is checked here: three
 * markers, each exactly once, a studio root, and not one external reference.
 *
 * The second half of this file assembles the studio the way `buildStudio` does
 * and checks that the result is a document that actually runs — the bundle
 * parses as JavaScript, defines `PitchProofStudio`, exposes `bootStudio`, and
 * names no URL. That is the assertion that would have caught
 * `docs/disputes/L12-ui.md` D-L12-1, and the last test in this file pins the
 * fact that defect turns on.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from '../../scripts/lib/bundler.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(ROOT, 'src');
const UI = join(SRC, 'ui');
const SHELL = readFileSync(join(UI, 'shell.html'), 'utf8');

/** @param {string} dir @param {string} ext @param {string[]} [out] @returns {string[]} */
function filesUnder(dir, ext, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) filesUnder(p, ext, out);
    else if (name.endsWith(ext)) out.push(p);
  }
  return out;
}

test('the shell carries the three markers the build fills, each exactly once', () => {
  for (const marker of ['<!--PITCHPROOF_STYLES-->', '<!--PITCHPROOF_RUNTIME-->', '<!--PITCHPROOF_SCRIPT-->']) {
    assert.equal(SHELL.split(marker).length - 1, 1, `${marker} must appear exactly once`);
  }
  assert.match(SHELL, /<div id="pp-studio-root"><\/div>/);
  assert.ok(SHELL.indexOf('<!--PITCHPROOF_STYLES-->') < SHELL.indexOf('<!--PITCHPROOF_RUNTIME-->'));
  assert.ok(SHELL.indexOf('<!--PITCHPROOF_RUNTIME-->') < SHELL.indexOf('<!--PITCHPROOF_SCRIPT-->'));
});

test('the shell tells the user what happened when the bundle is missing', () => {
  assert.match(SHELL, /The studio bundle did not load/);
  assert.match(SHELL, /<noscript>/);
});

test('the studio entry bundles, defines its global and exposes bootStudio', () => {
  const { code, modules } = bundle({ entry: join(UI, 'index.js'), root: SRC, global: 'PitchProofStudio' });
  assert.ok(code.length > 50000, 'the studio is not a stub');
  assert.match(code, /globalThis\["PitchProofStudio"\]/);

  // It parses. `new Function` compiles without running, which is exactly the
  // check that a corrupted substitution fails.
  assert.doesNotThrow(() => new Function(code), 'the bundle must be syntactically valid JavaScript');

  const ids = modules.map((m) => m.id);
  assert.ok(ids.includes('ui/index.js'));
  assert.ok(ids.includes('ui/services.js'), 'the lane adapter is in the bundle');
  assert.ok(ids.includes('runtime/runtime.js'), 'the preview mounts the real runtime, so it is bundled with the studio');
});

test('the assembled document runs and reaches nothing', () => {
  const { code } = bundle({ entry: join(UI, 'index.js'), root: SRC, global: 'PitchProofStudio' });
  const css = filesUnder(UI, '.css').map((f) => readFileSync(f, 'utf8')).join('\n');
  // Function replacements: a string replacement would expand `$'` and `$&` in
  // the bundle. See docs/disputes/L12-ui.md D-L12-1.
  const html = SHELL
    .replace('<!--PITCHPROOF_STYLES-->', () => `<style>\n${css}\n</style>`)
    .replace('<!--PITCHPROOF_RUNTIME-->', () => '<script>window.__PITCHPROOF_RUNTIME_JS__="";window.__PITCHPROOF_RUNTIME_CSS__="";</script>')
    .replace('<!--PITCHPROOF_SCRIPT-->', () => `<script>\n${code}\n</script>`);

  assert.ok(!html.includes('<!--PITCHPROOF_'), 'every marker was filled');
  assert.equal(html.split('<script>').length - 1, html.split('</script>').length - 1, 'the script elements balance');

  // Boot the bundle in this process with no document: `bootStudio` must exist
  // and `mountStudio` must refuse a missing clock rather than half-starting.
  const globals = {};
  new Function('globalThis', `(function(){${code}})()`)(globals);
  const studio = globals.PitchProofStudio;
  assert.equal(typeof studio.bootStudio, 'function');
  assert.equal(typeof studio.mountStudio, 'function');
  assert.throws(() => studio.mountStudio({ document: {} }), /injected clock/);
  assert.throws(() => studio.mountStudio({}), /document is required/);
});

test('nothing in src/ui/** names a URL or loads a font', () => {
  for (const file of [...filesUnder(UI, '.js'), ...filesUnder(UI, '.css'), join(UI, 'shell.html')]) {
    const text = readFileSync(file, 'utf8');
    const urls = [...text.matchAll(/https?:\/\/[^\s'"`)]+/g)].map((m) => m[0]);
    const allowed = urls.filter((u) => /example|w3\.org/.test(u));
    assert.deepEqual(
      urls.filter((u) => !allowed.includes(u)),
      [],
      `${file} names a URL; the studio loads nothing and suggests no third-party host`,
    );
    assert.ok(!/@font-face/.test(text), `${file} declares a font face`);
  }
});

test('src/ui/** contains no $-sequence that a string replacement would expand', () => {
  // This lane's own sources are clean, so the build defect in D-L12-1 is not
  // one this lane introduced — and this test keeps it that way.
  for (const file of [...filesUnder(UI, '.js'), ...filesUnder(UI, '.css'), join(UI, 'shell.html')]) {
    const text = readFileSync(file, 'utf8');
    for (const seq of ["$'", '$`', '$&']) {
      assert.ok(!text.includes(seq), `${file} contains ${seq}, which String.replace would expand into the built document`);
    }
  }
});

test('the bundle does contain such sequences from other lanes — which is why the build must use a function replacer', () => {
  // Pinning the fact rather than the fix, because the fix is in a file this
  // lane may not edit. If this ever goes green-by-absence the dispute can be
  // closed; while it fails-by-presence, `scripts/build.mjs` must not pass a
  // string replacement. See docs/disputes/L12-ui.md D-L12-1.
  const { code } = bundle({ entry: join(UI, 'index.js'), root: SRC, global: 'PitchProofStudio' });
  const hits = ["$'", '$`', '$&'].filter((seq) => code.includes(seq));
  assert.ok(
    hits.length > 0,
    'if no bundled source contains a $-sequence any more, D-L12-1 is moot and this test should be deleted',
  );
});
