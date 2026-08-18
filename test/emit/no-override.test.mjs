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
 * Identifiers that contain an override-shaped word but are not one. Each is
 * named individually — a pattern-shaped allowlist would let the next one in.
 */
const NOT_OVERRIDES = new Set([
  'manualOverrides',   // §4: the brand fields a user edited by hand
  'recordOverride',    // L12: records such an edit
  'renderOverrides',   // L12: displays the list
  'overrides',         // the same list, and test-fixture argument objects
  'overridden',        // prose in identifiers is rare, but harmless
]);

test('no override-shaped identifier exists anywhere in src/, scripts/ or test/emit/', () => {
  const suspicious = /\b(force|forced|forceEmit|override|overrides|overrideFindings|bypass|unsafe|skipValidation|skipProvenance|skipScan|ignoreFindings|allowSeverity1|allowBlocking|allowNetwork|blockOnSeverity)\b/g;
  /** @type {string[]} */
  const offenders = [];
  const roots = [join(ROOT, 'src'), join(ROOT, 'scripts'), join(ROOT, 'test', 'emit')];
  for (const root of roots) {
    for (const file of sourceFiles(root)) {
      const rel = relative(ROOT, file).split('\\').join('/');
      // This file names every override it attempts, on purpose.
      if (rel === 'test/emit/no-override.test.mjs') continue;
      const text = readFileSync(file, 'utf8');
      const code = maskJs(text).code;
      let m;
      suspicious.lastIndex = 0;
      while ((m = suspicious.exec(code)) !== null) {
        if (NOT_OVERRIDES.has(m[0])) continue;
        const line = code.slice(0, m.index).split('\n').length;
        offenders.push(`${rel}:${line}  ${m[0]}  →  ${text.split('\n')[line - 1].trim()}`);
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
