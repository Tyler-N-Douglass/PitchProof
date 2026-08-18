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

/**
 * Strip comments and string literals from a source file, keeping line numbers,
 * so prose *about* the law is not mistaken for the law being broken. Block
 * comment state carries across lines; a JSDoc paragraph is not code.
 * @param {string} source
 * @returns {string[]} one entry per line, code only
 */
export function codeLines(source) {
  const out = [];
  let inBlock = false;
  for (const raw of source.split('\n')) {
    let line = raw;
    let code = '';
    let i = 0;
    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf('*/', i);
        if (end < 0) { i = line.length; break; }
        inBlock = false;
        i = end + 2;
        continue;
      }
      const ch = line[i];
      const next = line[i + 1];
      if (ch === '/' && next === '*') { inBlock = true; i += 2; continue; }
      if (ch === '/' && next === '/') break;
      if (ch === '"' || ch === "'" || ch === '`') {
        // A string literal is data, not control flow. Keep the quotes so a
        // property key still reads as one, and drop the contents.
        const quote = ch;
        i++;
        while (i < line.length) {
          if (line[i] === '\\') { i += 2; continue; }
          if (line[i] === quote) { i++; break; }
          i++;
        }
        code += `${quote}${quote}`;
        continue;
      }
      code += ch;
      i++;
    }
    out.push(code);
  }
  return out;
}

test('src/ contains no code path that lets a severity-1 finding through', () => {
  /**
   * An override has to be an *identifier* or a *call*, not a word that happens
   * to sit near another word. `disabled: !gate.canEmit` is the emit button being
   * greyed out because a finding blocks — the law being enforced, not evaded —
   * and it must not trip this check, while `skipSeverity`, `bypassPreflight` and
   * `emit(proof, {force: true})` all must.
   */
  const patterns = [
    { re: /\b(override|suppress|waive|bypass|silence|unblock|skip|ignore|disable|allow|force)[A-Za-z]*?(Severity|Findings|Finding|Preflight|Blocking|Block|Emit|Validation|Rules|Rule|Gate)\b/, what: 'an override-shaped identifier' },
    { re: /\b(severity|finding|findings|preflight|blocking|emit|validation)[A-Z]?\w*\s*(Override|Bypass|Waiver|Escape)\b/i, what: 'an override-shaped identifier' },
    { re: /\b(emit|runPreflight|dryRun|autoFixes)\s*\([^)]{0,120}\b(force|override|bypass|skipValidation|ignoreFindings)\s*:/, what: 'an override argument passed to a gate function' },
    { re: /\bseverity\s*(!==?|===?)\s*1\s*\?\s*(false|null|\[\])/, what: 'a conditional that discards severity-1' },
    { re: /\.filter\s*\(\s*\(?\s*\w+\s*\)?\s*=>\s*\w+\.severity\s*(!==|>)\s*1\s*\)/, what: 'a filter that drops severity-1 findings' },
    { re: /\bcanEmit\s*[:=]\s*(true|!\w)/, what: 'canEmit asserted rather than computed' },
    { re: /\b(force|override|bypass)\b[^;\n]{0,30}\bseverity\s*(===?|!==?|<|>)/, what: 'a force flag consulted alongside severity' },
  ];

  /** @type {string[]} */
  const hits = [];
  for (const file of jsFiles(join(ROOT, 'src'))) {
    codeLines(readFileSync(file, 'utf8')).forEach((code, i) => {
      if (!code.trim()) return;
      for (const p of patterns) {
        if (p.re.test(code)) hits.push(`${relative(ROOT, file)}:${i + 1}  ${p.what}\n      ${code.trim()}`);
      }
    });
  }
  assert.deepEqual(hits, [], `§14 forbids an override flag; found:\n  ${hits.join('\n  ')}`);
});

test('the scanner itself catches an override when one is planted', () => {
  const planted = [
    'function emitAnyway(findings) { return findings.filter((f) => f.severity !== 1); }',
    'const skipFindings = true;',
    'emit(proof, { force: true });',
    'return { canEmit: true };',
    'const bypassPreflight = options.bypassPreflight;',
  ];
  const patterns = [
    /\b(override|suppress|waive|bypass|silence|unblock|skip|ignore|disable|allow|force)[A-Za-z]*?(Severity|Findings|Finding|Preflight|Blocking|Block|Emit|Validation|Rules|Rule|Gate)\b/,
    /\b(emit|runPreflight|dryRun|autoFixes)\s*\([^)]{0,120}\b(force|override|bypass|skipValidation|ignoreFindings)\s*:/,
    /\.filter\s*\(\s*\(?\s*\w+\s*\)?\s*=>\s*\w+\.severity\s*(!==|>)\s*1\s*\)/,
    /\bcanEmit\s*[:=]\s*(true|!\w)/,
  ];
  for (const line of planted) {
    assert.ok(patterns.some((re) => re.test(line)), `the scanner would miss: ${line}`);
  }
  // And the two shapes that read like an override but are the law being kept.
  for (const line of ['disabled: !gate.canEmit || app.ui.emit.running,', "act: 'emit.download', disabled: blocking.length > 0,"]) {
    assert.ok(!patterns.some((re) => re.test(line)), `the scanner false-positives on: ${line}`);
  }
});

test('the words "there is no override flag" are not the only thing enforcing it', async () => {
  // A last, blunt end-to-end check: take a proof with one of each blocking
  // defect, and confirm the sweep reports every one of them.
  const proof = copy(cleanProof());
  proof.renditions[0].provenance = 'verified-by-user';        // PROVENANCE_UNLABELED
  proof.brand.colors.find((c) => c.role === 'primary').hex = '#EDEFF5';   // CONTRAST_FAIL
  proof.specimens[0].blocks.push({ type: 'media', ref: 'md_gone' });      // ASSET_MISSING
  proof.specimens[0].blocks.push({ type: 'raw', html: '<img src="https://x.example.invalid/p.gif">' });  // NETWORK_REFERENCE
  // An anchor chain that never reaches the spine: BRANCH_NO_RETURN at severity 1.
  const outerScene = { ...copy(proof.spine[0]), id: 'sc_outer', beats: [{ id: 'sc_outer_b0', reveals: ['e'], presenterNote: null, dwellHintMs: null }], branchAnchors: ['bn_inner'] };
  proof.branches.push({
    id: 'bn_outer', objection: 'The outer objection', aliases: [], returnPolicy: 'anchor', scenes: [outerScene],
  });
  proof.branches.push({
    id: 'bn_inner', objection: 'The inner objection', aliases: [], returnPolicy: 'nextSpineScene',
    scenes: [{ ...copy(proof.spine[0]), id: 'sc_inner', beats: [{ id: 'sc_inner_b0', reveals: ['e'], presenterNote: null, dwellHintMs: null }] }],
  });

  const findings = await validate.runPreflight(proof, { clock });
  const blocking = new Set(findings.filter((f) => f.severity === 1).map((f) => f.code));
  for (const code of ['PROVENANCE_UNLABELED', 'CONTRAST_FAIL', 'ASSET_MISSING', 'NETWORK_REFERENCE', 'BRANCH_NO_RETURN']) {
    assert.ok(blocking.has(code), `${code} was not reported as blocking`);
  }
  assert.equal(validate.summarize(findings).canEmit, false);
});
