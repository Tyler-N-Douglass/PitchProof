/**
 * D11 / §15 made mechanical.
 *
 * "The artifact never wears this palette... a single shared CSS variable between
 * studio chrome and artifact output is a bug." A rule stated in prose across
 * eleven lanes is a rule that decays, so this test asserts the three things that
 * make it true:
 *
 *   1. the `--st-*` and `--pp-*` name sets are disjoint;
 *   2. no file under `src/ui/**` mentions a `--pp-` name;
 *   3. no file under `src/runtime/**`, `src/scene/**` or `src/branch/**`
 *      mentions a `--st-` name.
 *
 * Points 2 and 3 are the ones that matter in practice: a shared *value* is a
 * coincidence, but a shared *name* is a dependency, and a dependency is how the
 * artifact ends up wearing the studio's ground colour in front of a client.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(ROOT, 'src');

/**
 * Every file under a directory whose name ends with one of the extensions.
 * @param {string} dir
 * @param {string[]} extensions
 * @returns {string[]}
 */
function filesUnder(dir, extensions) {
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (extensions.some((e) => name.endsWith(e))) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** @param {string} text @param {string} prefix @returns {Set<string>} */
function variablesIn(text, prefix) {
  const found = new Set();
  const re = new RegExp(`--${prefix}-[A-Za-z0-9_-]+`, 'g');
  for (const match of text.matchAll(re)) found.add(match[0]);
  return found;
}

const UI_FILES = filesUnder(join(SRC, 'ui'), ['.js', '.css', '.html']);
const ARTIFACT_DIRS = ['runtime', 'scene', 'branch'];

test('the studio declares --st-* variables and the artifact declares --pp-* variables', () => {
  const uiCss = filesUnder(join(SRC, 'ui'), ['.css']).map((f) => readFileSync(f, 'utf8')).join('\n');
  const st = variablesIn(uiCss, 'st');
  assert.ok(st.size >= 20, `expected the studio stylesheet to define a real palette, found ${st.size} --st-* names`);
  assert.ok(st.has('--st-ground'), 'the §15 ground colour must be a named token');
  assert.ok(st.has('--st-primary'), 'the §15 primary colour must be a named token');
  assert.ok(st.has('--st-signal'), 'the §15 signal colour must be a named token');

  const artifactCss = ARTIFACT_DIRS
    .flatMap((d) => filesUnder(join(SRC, d), ['.css']))
    .map((f) => readFileSync(f, 'utf8')).join('\n');
  const pp = variablesIn(artifactCss, 'pp');
  assert.ok(pp.size >= 10, `expected the artifact stylesheet to define a palette, found ${pp.size} --pp-* names`);

  const shared = [...st].filter((name) => pp.has(name));
  assert.deepEqual(shared, [], 'the two variable namespaces must be disjoint');
});

test('the §15 palette values are the ones the spec fixes', () => {
  const css = readFileSync(join(SRC, 'ui', 'studio.css'), 'utf8');
  for (const [name, value] of [
    ['--st-ground', '#0B1220'],
    ['--st-primary', '#3B2EEA'],
    ['--st-secondary', '#8B93F4'],
    ['--st-signal', '#F0728C'],
  ]) {
    const re = new RegExp(`${name}:\\s*${value}\\s*;`, 'i');
    assert.match(css, re, `${name} must be ${value} (§15)`);
  }
  assert.match(css, /--st-font-ui:\s*Geist/, 'Geist is the interface face (§15)');
  assert.match(css, /--st-font-mono:\s*"Geist Mono"/, 'Geist Mono carries numerals, ids and code (§15)');
});

test('no file under src/ui/** references a --pp- name', () => {
  const offenders = [];
  for (const file of UI_FILES) {
    const text = readFileSync(file, 'utf8');
    const hits = variablesIn(text, 'pp');
    if (hits.size) offenders.push(`${relative(ROOT, file)}: ${[...hits].join(', ')}`);
  }
  assert.deepEqual(offenders, [], 'the studio must never read or write an artifact variable');
});

test('no artifact source references a --st- name', () => {
  const offenders = [];
  for (const dir of ARTIFACT_DIRS) {
    for (const file of filesUnder(join(SRC, dir), ['.js', '.css'])) {
      const text = readFileSync(file, 'utf8');
      const hits = variablesIn(text, 'st');
      if (hits.size) offenders.push(`${relative(ROOT, file)}: ${[...hits].join(', ')}`);
    }
  }
  assert.deepEqual(offenders, [], 'the artifact must never read or write a studio variable');
});

test('the studio class prefix and the artifact class prefix do not collide', () => {
  // A shared class name is the same defect as a shared variable, one level up:
  // the artifact renders inside the studio's preview, so a `pp-` rule written in
  // the studio stylesheet would restyle the client's proof.
  const uiCss = filesUnder(join(SRC, 'ui'), ['.css']).map((f) => readFileSync(f, 'utf8')).join('\n');
  const ppClasses = [...uiCss.matchAll(/\.pp-[A-Za-z0-9_-]+/g)].map((m) => m[0]);
  assert.deepEqual([...new Set(ppClasses)], [], 'the studio stylesheet must not style artifact classes');
});

test('the shell carries exactly the three build markers and no external reference', () => {
  const shell = readFileSync(join(SRC, 'ui', 'shell.html'), 'utf8');
  for (const marker of ['<!--PITCHPROOF_STYLES-->', '<!--PITCHPROOF_RUNTIME-->', '<!--PITCHPROOF_SCRIPT-->']) {
    assert.equal(shell.split(marker).length - 1, 1, `${marker} must appear exactly once`);
  }
  assert.match(shell, /<div id="pp-studio-root"><\/div>/, 'the shell reserves the studio root element');

  // No `src=`, no `href=`, no protocol-relative reference anywhere.
  assert.ok(!/\ssrc\s*=/.test(shell), 'the shell loads nothing');
  assert.ok(!/\shref\s*=/.test(shell), 'the shell links to nothing');
  assert.ok(!/https?:\/\//.test(shell), 'the shell names no URL');
  assert.ok(!/@import/.test(shell), 'the shell imports no stylesheet');
});

test('the studio stylesheet loads no font over the network', () => {
  const css = filesUnder(join(SRC, 'ui'), ['.css']).map((f) => readFileSync(f, 'utf8')).join('\n');
  assert.ok(!/@font-face/.test(css), 'no @font-face rule — nothing may be loaded over the network, ever (§15)');
  assert.ok(!/@import/.test(css), 'no @import');
  assert.ok(!/url\(\s*['"]?https?:/.test(css), 'no absolute url() reference');
});
