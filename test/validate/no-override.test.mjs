/**
 * §14, last line: **"Severity 1 findings block emit. There is no override flag.
 * If a lane proposes one, the critic rejects it."**
 *
 * A law like that decays quietly. Nobody adds `override: true`; somebody adds an
 * "acknowledge" list, or a "known issues" filter, or a `strict: false` that skips
 * a rule, and six weeks later a proof with unlabelled illustrative content ships
 * because the flag defaulted the wrong way. This file is the tripwire, and it
 * checks three separate things:
 *
 *  1. **No parameter behaves like one.** Every override-shaped option a caller
 *     could plausibly invent is passed to `runPreflight` and asserted to change
 *     nothing.
 *  2. **No export is one.** The lane's public surface is searched by name.
 *  3. **No source line is one.** `src/` is scanned for the token pairings an
 *     override would have to use, and any hit fails the suite by file and line.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FIXED_SEVERITY } from '../../src/core/contracts.js';
import * as validate from '../../src/validate/index.js';
import { defectProof, cleanProof, copy, NOW } from '../fixtures/validate/defects.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const clock = () => NOW;

/** Every `.js` file under a directory. */
function jsFiles(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) jsFiles(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('no option passed to runPreflight can suppress a severity-1 finding', async () => {
  const proof = defectProof('PROVENANCE_UNLABELED');
  const baseline = await validate.runPreflight(proof, { clock });
  assert.equal(baseline.filter((f) => f.severity === 1).length, 1);

  /** Every shape an override would plausibly take. */
  const attempts = [
    { override: true },
    { force: true },
    { strict: false },
    { allowSeverity1: true },
    { ignoreSeverity: [1] },
    { ignore: ['PROVENANCE_UNLABELED'] },
    { skip: ['PROVENANCE_UNLABELED'] },
    { acknowledged: ['PROVENANCE_UNLABELED'] },
    { suppress: ['PROVENANCE_UNLABELED'] },
    { waive: true },
    { minSeverity: 3 },
    { maxSeverity: 3 },
    { severity: 3 },
    { rules: [] },
    { RULES: [] },
    { disable: ['PROVENANCE_UNLABELED'] },
    { only: ['BEAT_EMPTY'] },
    { failOnSeverity1: false },
    { blockOnSeverity1: false },
    { emitAnyway: true },
  ];
  for (const attempt of attempts) {
    const findings = await validate.runPreflight(proof, { clock, ...attempt });
    assert.deepEqual(
      findings.map((f) => f.id),
      baseline.map((f) => f.id),
      `passing ${JSON.stringify(attempt)} changed the findings — that option is an override`,
    );
  }
});

test('no option passed to dryRun can suppress one either', async () => {
  const proof = defectProof('PROVENANCE_UNLABELED');
  const baseline = await validate.dryRun(proof, { clock });
  for (const attempt of [{ override: true }, { ignoreSeverity: [1] }, { strict: false }, { blocking: false }]) {
    const result = await validate.dryRun(proof, { clock, ...attempt });
    assert.equal(result.summary.blocking, baseline.summary.blocking);
    assert.equal(result.summary.canEmit, false);
  }
});

test('the lane exports nothing that reads as an override', () => {
  const banned = /(override|suppress|waive|bypass|acknowledge|silence|unblock|allowBlocking|forceEmit)/i;
  for (const name of Object.keys(validate)) {
    assert.ok(!banned.test(name), `src/validate exports "${name}", which reads as an override`);
  }
  // The one direction that exists is the honest one.
  assert.equal(typeof validate.blocksEmit, 'function');
  assert.equal(validate.blocksEmit([{ severity: 1 }]), true);
  assert.equal(validate.blocksEmit([{ severity: 2 }, { severity: 3 }]), false);
  assert.deepEqual(validate.blockingFindings([{ severity: 1, code: 'X' }, { severity: 2 }]), [{ severity: 1, code: 'X' }]);
});

test('summarize cannot be talked into canEmit while a severity-1 finding stands', async () => {
  const proof = defectProof('CONTRAST_FAIL');
  const findings = await validate.runPreflight(proof, { clock });
  assert.equal(validate.summarize(findings).canEmit, false);
  // Even an empty-looking list of exactly the blocking findings still blocks.
  assert.equal(validate.summarize(findings.filter((f) => f.severity === 1)).canEmit, false);
  assert.equal(validate.summarize([]).canEmit, true);
});

test('a fixed severity cannot be edited down through any public entry point', () => {
  for (const [code, fixed] of Object.entries(FIXED_SEVERITY)) {
    for (const attempt of [1, 2, 3]) {
      if (attempt === fixed) continue;
      assert.throws(() => validate.makeFinding({
        code,
        message: 'A message long enough to be a real message for a seller to act on.',
        severity: attempt,
      }), `${code} accepted severity ${attempt}`);
    }
  }
});

test('a severity-1 finding survives every auto-fix that does not actually fix it', async () => {
  // Auto-fixes are the one legitimate way a blocking finding disappears, and
  // they only do it by changing the proof. A fix list applied to a proof it was
  // not computed for must not silently clear anything.
  const proof = defectProof('SPECIMEN_EMPTY');
  const findings = await validate.runPreflight(proof, { clock });
  assert.equal(findings.filter((f) => f.severity === 1).length, 1);
  const fixes = validate.autoFixes(proof, findings);
  assert.deepEqual(fixes, [], 'SPECIMEN_EMPTY has no safe fix; offering one would be the override');
});

test('src/ contains no code path that lets a severity-1 finding through', () => {
  /**
   * Patterns an override would have to use. Each pairs an override verb with a
   * severity or finding noun, so ordinary uses of the words (a `force` flag on a
   * storage save, an `ignore` list of file globs) do not trip it.
   */
  const patterns = [
    { re: /\b(override|suppress|waive|bypass|silence|unblock|skip|ignore|disable)[A-Za-z]*\s*[:(]?\s*[^;\n]{0,40}\b(severity|finding|preflight|blocking|emit)\b/i, what: 'an override verb applied to severity, findings, preflight or emit' },
    { re: /\bseverity\s*(!==?|===?)\s*1\s*\?\s*(false|null|undefined|\[\])/i, what: 'a conditional that discards severity-1' },
    { re: /\bfilter\s*\(\s*\(?\s*\w+\s*\)?\s*=>\s*\w+\.severity\s*(!==|>)\s*1\s*\)/, what: 'a filter that drops severity-1 findings' },
    { re: /\bcanEmit\s*=\s*(true|!)/, what: 'canEmit assigned rather than computed' },
    { re: /\ballow(Blocking|Severity|Emit)\b/i, what: 'an allow-flag for blocking findings' },
    { re: /\bforce\s*(&&|\|\|)?\s*.{0,20}\bseverity\b/i, what: 'a force flag consulted alongside severity' },
  ];

  /** @type {string[]} */
  const hits = [];
  for (const file of jsFiles(join(ROOT, 'src'))) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((raw, i) => {
      // Prose about the law is not the law being broken.
      const code = raw.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
      if (!code.trim()) return;
      for (const p of patterns) {
        if (p.re.test(code)) hits.push(`${relative(ROOT, file)}:${i + 1}  ${p.what}\n      ${raw.trim()}`);
      }
    });
  }
  assert.deepEqual(hits, [], `§14 forbids an override flag; found:\n  ${hits.join('\n  ')}`);
});

test('the words "there is no override flag" are not the only thing enforcing it', async () => {
  // A last, blunt end-to-end check: take a proof with one of each blocking
  // defect, and confirm the sweep reports every one of them.
  const proof = copy(cleanProof());
  proof.renditions[0].provenance = 'verified-by-user';        // PROVENANCE_UNLABELED
  proof.brand.colors.find((c) => c.role === 'primary').hex = '#EDEFF5';   // CONTRAST_FAIL
  proof.specimens[0].blocks.push({ type: 'media', ref: 'md_gone' });      // ASSET_MISSING
  proof.specimens[0].blocks.push({ type: 'raw', html: '<img src="https://x.example.invalid/p.gif">' });  // NETWORK_REFERENCE
  proof.branches.push({
    id: 'bn_stranded', objection: 'x', aliases: [], returnPolicy: 'anchor',
    scenes: [{ ...copy(proof.spine[0]), id: 'sc_stranded' }],
  });                                                                     // BRANCH_NO_RETURN

  const findings = await validate.runPreflight(proof, { clock });
  const blocking = new Set(findings.filter((f) => f.severity === 1).map((f) => f.code));
  for (const code of ['PROVENANCE_UNLABELED', 'CONTRAST_FAIL', 'ASSET_MISSING', 'NETWORK_REFERENCE', 'BRANCH_NO_RETURN']) {
    assert.ok(blocking.has(code), `${code} was not reported as blocking`);
  }
  assert.equal(validate.summarize(findings).canEmit, false);
});
