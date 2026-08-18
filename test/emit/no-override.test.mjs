/**
 * There is no override flag (§14, §20 axis 11).
 *
 * §14: "Severity 1 findings block emit. There is no override flag. If a lane
 * proposes one, the critic rejects it." A law like that is only real if
 * something looks for the flag, so this file does two things:
 *
 *   1. **Behaviour.** Every plausible shape of an override — an option, a dep,
 *      an environment variable, a mutated finding — is attempted against a
 *      proof that must be refused, and the refusal is asserted each time.
 *   2. **Source.** The repository is searched for an override-shaped identifier
 *      with comments stripped, so prose that *describes* the law does not trip
 *      the check that *enforces* it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emit } from '../../src/emit/index.js';
import { maskJs } from '../../src/emit/scan-parse.js';
import { registerTestLayouts } from '../fixtures/emit/layouts.mjs';
import { runtimeBundle, FIXED_CLOCK } from '../fixtures/emit/runtime-bundle.mjs';
import { emitProof } from '../fixtures/emit/proofs.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { js: runtimeJs, css: runtimeCss } = runtimeBundle();
const deps = { runtimeJs, runtimeCss, clock: FIXED_CLOCK };

/** Every shape an override could plausibly take. */
const OVERRIDE_OPTIONS = [
  { force: true },
  { override: true },
  { overrideFindings: true },
  { skipValidation: true },
  { skipProvenance: true },
  { allowSeverity1: true },
  { ignoreFindings: true },
  { unsafe: true },
  { bypass: true },
  { blockOnSeverity: 99 },
  { labelIllustrativeContent: false, force: true },
];

test('no option can make a refused emit succeed', async () => {
  for (const options of OVERRIDE_OPTIONS) {
    registerTestLayouts({ omitLabel: true });
    const result = await emit(emitProof(), options, deps);
    assert.equal(result.ok, false, `emit accepted ${JSON.stringify(options)}`);
    assert.equal(result.detail.html, '', `emit handed back an artifact for ${JSON.stringify(options)}`);
  }
});

test('no dep can make a refused emit succeed', async () => {
  for (const extra of [{ force: true }, { override: true }, { skipScan: true }, { allowNetwork: true }]) {
    registerTestLayouts({ omitLabel: true });
    const result = await emit(emitProof(), {}, { ...deps, ...extra });
    assert.equal(result.ok, false, `emit accepted dep ${JSON.stringify(extra)}`);
  }
});

test('no environment variable can make a refused emit succeed', async () => {
  const names = ['PITCHPROOF_FORCE', 'PITCHPROOF_OVERRIDE', 'PP_FORCE', 'FORCE', 'CI', 'NODE_ENV', 'PITCHPROOF_SKIP_VALIDATION'];
  const saved = names.map((n) => [n, process.env[n]]);
  try {
    for (const n of names) process.env[n] = '1';
    registerTestLayouts({ omitLabel: true });
    const result = await emit(emitProof(), {}, deps);
    assert.equal(result.ok, false, 'an environment variable changed the emitter\'s answer');
  } finally {
    for (const [n, v] of saved) {
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
    }
  }
});

test('a network reference cannot be talked out of blocking either', async () => {
  for (const options of OVERRIDE_OPTIONS) {
    registerTestLayouts({ ctaHref: 'https://northwind.example/contact' });
    const result = await emit(emitProof(), options, deps);
    assert.equal(result.ok, false, `a network reference survived ${JSON.stringify(options)}`);
  }
});

test('an over-budget artifact cannot be talked out of blocking either', async () => {
  for (const options of OVERRIDE_OPTIONS) {
    registerTestLayouts();
    const result = await emit(emitProof({ imageEdge: 96 }), { ...options, maxBytes: 60_000 }, deps);
    assert.equal(result.ok, false, `an over-budget artifact survived ${JSON.stringify(options)}`);
  }
});

test('src/ reads no environment variable at all', () => {
  const offenders = [];
  for (const file of sourceFiles(join(ROOT, 'src'))) {
    const code = maskJs(readFileSync(file, 'utf8')).code;
    if (/\bprocess\s*\.\s*env\b/.test(code)) offenders.push(relative(ROOT, file));
  }
  assert.deepEqual(offenders, [], 'a product law must not depend on how the process was launched');
});

/**
 * An override is a **verb welded to a noun**, not a word that happens to appear.
 *
 * The first version of this check matched the bare word `force` and failed on
 * `rmSync(dir, {recursive: true, force: true})` — this script's own temp-file
 * cleanup. That is the third instance of the same failure mode in this build:
 * one scanner matched prose *documenting* that there is no override, another
 * matched `disabled: blocking.length > 0`, which is the law being enforced.
 * A lexical match without context produces a check nobody trusts, and an
 * untrusted check gets suppressed, which is how a law becomes a README claim.
 *
 * So the pattern is narrow and shaped like the thing it is looking for:
 *
 *   - an override verb immediately followed by an override noun, as one
 *     identifier: `forceEmit`, `skipFindings`, `bypassPreflight`,
 *     `allowSeverity1`, `overrideValidation`;
 *   - an option of that shape passed into `emit(...)`.
 *
 * `overrideOffenders` is exercised against planted positives below, because a
 * scanner that cannot catch a planted override proves nothing.
 */
const OVERRIDE_VERB = 'force|skip|ignore|bypass|allow|override|unsafe|disable|suppress|silence';
const OVERRIDE_NOUN = 'Emit|Emits|Emitted|Finding|Findings|Severity|Severities|Severity1|Blocking|Blocker|Blockers'
  + '|Preflight|Validation|Validate|Provenance|Scan|Scanner|Network|Budget|Law|Laws|Refusal|Gate|Guard|Check|Checks';
const WELDED = new RegExp(`\\b(${OVERRIDE_VERB})(${OVERRIDE_NOUN})\\b`, 'gi');

/** An override-shaped option handed to `emit(...)`. */
const EMIT_OPTION = new RegExp(
  `\\bemit\\s*\\([\\s\\S]{0,240}?\\{[\\s\\S]{0,240}?\\b(${OVERRIDE_VERB})[A-Za-z0-9_$]*\\s*:`,
  'gi',
);

/**
 * Named exemptions. Each one is a specific file and a specific token with a
 * specific reason — a pattern-shaped exemption would let the next one in.
 * @type {{file: string, token: string, why: string}[]}
 */
const EXEMPT = [];

/**
 * @param {string} text  source with comments and string literals already masked
 * @returns {{token: string, index: number}[]}
 */
function overrideOffenders(text) {
  /** @type {{token: string, index: number}[]} */
  const out = [];
  for (const re of [WELDED, EMIT_OPTION]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) out.push({ token: m[0], index: m.index });
  }
  return out;
}

test('the override scanner catches a planted override', () => {
  const planted = [
    'const skipFindings = true;',
    'function forceEmit(proof) { return proof; }',
    'if (options.bypassPreflight) return ok(result);',
    'const allowSeverity = 1;',
    'export const overrideValidation = false;',
    'const r = await emit(proof, { force: true }, deps);',
    'const r = await emit(proof, {\n  skipValidation: true,\n}, deps);',
  ];
  for (const sample of planted) {
    assert.ok(overrideOffenders(sample).length > 0, `the scanner missed a planted override: ${sample}`);
  }
});

test('the override scanner does not fire on code that is not an override', () => {
  const innocent = [
    'rmSync(dir, { recursive: true, force: true });',
    'await store.save({ id, name, proof, seed, force: true });',
    'h("button", { disabled: blocking.length > 0 }, "Emit");',
    'const overrides = brand.manualOverrides;',
    'notice("bad", "A severity-1 finding blocks the emit. There is no override.");',
    'if (!force && this.lastHash.get(id) === hash) return skipped;',
    'const scan = scanForNetworkReferences(html);',
    'const emitted = await emit(proof, { maxBytes: 1000 }, deps);',
    'let allowed = true;',
  ];
  for (const sample of innocent) {
    assert.deepEqual(overrideOffenders(sample), [], `the scanner fired on innocent code: ${sample}`);
  }
});

test('no override-shaped identifier exists anywhere in src/, scripts/ or test/emit/', () => {
  /** @type {string[]} */
  const offenders = [];
  const roots = [join(ROOT, 'src'), join(ROOT, 'scripts'), join(ROOT, 'test', 'emit')];
  for (const root of roots) {
    for (const file of sourceFiles(root)) {
      const rel = relative(ROOT, file).split('\\').join('/');
      // This file names every override it attempts, on purpose.
      if (rel === 'test/emit/no-override.test.mjs') continue;
      const text = readFileSync(file, 'utf8');
      // Comments and string literals are masked: prose that *documents* the law
      // must not fail the check that *enforces* it.
      const code = maskJs(text).code;
      for (const hit of overrideOffenders(code)) {
        if (EXEMPT.some((e) => e.file === rel && e.token === hit.token)) continue;
        const line = code.slice(0, hit.index).split('\n').length;
        offenders.push(`${rel}:${line}  ${hit.token}  \u2192  ${text.split('\n')[line - 1].trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `override-shaped code found:\n${offenders.join('\n')}`);
});

test('the emitter exposes no function that returns an artifact past a blocking finding', async () => {
  const api = await import('../../src/emit/index.js');
  const names = Object.keys(api);
  for (const name of names) {
    assert.ok(
      !/force|override|bypass|unsafe|skip|ignore/i.test(name),
      `src/emit/index.js exports "${name}", which reads like an escape hatch`,
    );
  }
});

/** @param {string} dir @param {string[]} [out] @returns {string[]} */
function sourceFiles(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir).sort(); } catch { return out; }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}
