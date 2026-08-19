/**
 * The comment stripper (§13, critic finding F17).
 *
 * The stripper decides, byte by byte, whether a `/` opens a comment or is part
 * of a string, a template literal or a regular expression. Every one of those
 * decisions can corrupt an artifact silently — a mis-read regex swallows the
 * rest of a function, a mis-read quote deletes live code — so each construct is
 * checked directly here rather than only through the bundle.
 *
 * The last test is the one that matters most: it strips the real runtime bundle
 * and asserts it still evaluates to the same export surface. That is the same
 * class of check `test/integration/studio.test.mjs` added after D5, where 1608
 * tests were green while the built file did not parse.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { stripComments, stripCssComments, collapseBlankLines } from '../../scripts/lib/strip-comments.mjs';
import { buildRuntime } from '../../scripts/build.mjs';

/** @param {string} s */
const tidy = (s) => collapseBlankLines(stripComments(s)).trim();

test('a line comment goes, and the line it was on stays', () => {
  assert.equal(stripComments('const a = 1; // why\nconst b = 2;\n'), 'const a = 1; \nconst b = 2;\n');
});

test('a block comment goes, and the lines it spanned stay', () => {
  const src = 'a;\n/* one\n   two\n   three */\nb;\n';
  const out = stripComments(src);
  assert.equal(out.split('\n').length, src.split('\n').length, 'a line number moved');
  // One blank line survives where the comment was: `collapseBlankLines` closes
  // runs, it does not weld statements together.
  assert.equal(tidy(out), 'a;\n\nb;');
});

test('a trailing line comment with no newline is removed cleanly', () => {
  assert.equal(stripComments('a; // end'), 'a; ');
});

test('an unterminated block comment does not lose the file silently', () => {
  assert.equal(tidy('a;\n/* never closed\nb;'), 'a;');
});

test('`//` inside a single-quoted string survives', () => {
  const src = "const url = 'https://example.com/a'; // real comment\n";
  assert.equal(stripComments(src), "const url = 'https://example.com/a'; \n");
});

test('`/* */` inside a double-quoted string survives', () => {
  const src = 'const s = "/* not a comment */"; /* a comment */\n';
  assert.equal(tidy(src), 'const s = "/* not a comment */";');
});

test('a regex containing `//` is not read as a comment', () => {
  const src = 'const re = /https?:\\/\\//; // strip me\nnext();\n';
  assert.equal(tidy(src), 'const re = /https?:\\/\\//;\nnext();');
});

test('a `/` inside a character class does not end the regex', () => {
  const src = 'const re = /[/*]+/g; // strip me\nnext();\n';
  assert.equal(tidy(src), 'const re = /[/*]+/g;\nnext();');
});

test('a regex after `return` is a regex, not division', () => {
  assert.equal(tidy('function f() { return /a\\/b/.test(x); } // gone'), 'function f() { return /a\\/b/.test(x); }');
});

test('division is not read as a regex', () => {
  // If `/` after `b` opened a regex, everything to the next `/` would be
  // swallowed and the `// gone` would survive as code.
  assert.equal(tidy('const r = a / b / c; // gone'), 'const r = a / b / c;');
});

test('comment syntax inside a template literal survives', () => {
  const src = 'const t = `a // b /* c */ d`; // gone\n';
  assert.equal(tidy(src), 'const t = `a // b /* c */ d`;');
});

test('a comment inside a template interpolation is stripped, the literal is not', () => {
  const src = 'const t = `x${ /* gone */ y }z // kept`;\n';
  assert.equal(tidy(src), 'const t = `x${  y }z // kept`;');
});

test('an object literal inside an interpolation does not end the template', () => {
  // If the first `}` were read as closing the interpolation, the rest of the
  // line would be scanned as template text and the comment would survive.
  const src = 'const t = `a${ f({ k: 1 }) }b`; // gone\n';
  assert.equal(tidy(src), 'const t = `a${ f({ k: 1 }) }b`;');
});

test('a nested template literal is tracked', () => {
  const src = 'const t = `a${ `b // c` }d`; // gone\n';
  assert.equal(tidy(src), 'const t = `a${ `b // c` }d`;');
});

test('code after a template literal is scanned as code again', () => {
  // The stack must be popped when the literal ends. If it leaked, the later
  // `}` would be mistaken for the end of an interpolation.
  const src = 'const t = `a`;\nfunction f() { return 1; } // gone\nconst u = `b`; // gone too\n';
  assert.equal(tidy(src), 'const t = `a`;\nfunction f() { return 1; }\nconst u = `b`;');
});

test('an apostrophe inside a comment does not open a string', () => {
  // §18's prose is full of them, and a comment that opened a string would
  // silently consume the code that followed it.
  const src = "// the seller's own words\nconst a = 1;\n";
  assert.equal(tidy(src), 'const a = 1;');
});

test('CSS comments go, quoted comment syntax stays', () => {
  const css = '/* header */\n.a { content: "/*"; }\n.b { color: red } /* tail */\n';
  const out = stripCssComments(css);
  assert.ok(!out.includes('header'));
  assert.ok(!out.includes('tail'));
  assert.ok(out.includes('content: "/*";'));
  assert.ok(out.includes('color: red'));
});

test('stripping is idempotent', () => {
  const src = 'const re = /[/*]/; // a\n/* b */\nconst t = `x${1}// y`;\n';
  const once = stripComments(src);
  assert.equal(stripComments(once), once);
});

test('the real runtime bundle strips to the same export surface', () => {
  const runtime = buildRuntime();
  assert.ok(runtime, 'the runtime lane has not landed');

  // `buildRuntime` already strips. Rebuild the unstripped bundle to compare
  // against, so this test proves the transform is sound rather than assuming it.
  const raw = buildRuntime({ stripComments: false });

  assert.ok(raw.js.length > runtime.js.length, 'stripping removed nothing at all');

  const evalExports = (code) => {
    const g = new Function(`${code}\n; return globalThis.PitchProofRuntime;`)();
    return Object.keys(g || {}).sort();
  };
  const before = evalExports(raw.js);
  const after = evalExports(runtime.js);
  assert.ok(before.length > 0, 'the unstripped bundle exported nothing');
  assert.deepEqual(after, before);

  // Every module the bundler registered is keyed by its source path as a string
  // literal, so provenance survives stripping (§18.4).
  const ids = (code) => [...code.matchAll(/__modules\["([^"]+)"\]/g)].map((m) => m[1]).sort();
  assert.deepEqual(ids(runtime.js), ids(raw.js));

  // And the saving is the point of the exercise.
  const saved = 1 - runtime.js.length / raw.js.length;
  assert.ok(saved > 0.2, `stripping saved only ${(saved * 100).toFixed(1)}% of the runtime bundle`);
});

test('the artifact stylesheet strips without losing a rule', () => {
  const runtime = buildRuntime();
  const raw = buildRuntime({ stripComments: false });
  const rules = (css) => (css.match(/\{/g) || []).length;
  assert.equal(rules(runtime.css), rules(raw.css));
  assert.ok(runtime.css.length < raw.css.length);
  // The `--pp-*` namespace is what the artifact theme is written over (D11).
  for (const v of ['--pp-primary', '--pp-surface', '--pp-on-surface']) {
    assert.ok(runtime.css.includes(v), `${v} did not survive stripping`);
  }
});
