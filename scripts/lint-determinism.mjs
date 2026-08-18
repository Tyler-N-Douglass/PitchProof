#!/usr/bin/env node
/**
 * The determinism law, enforced (§5, PLAN §1 cross-cutting law 1).
 *
 * "Every id is generated from a seeded PRNG or content hash — never
 * `Math.random()`, never `Date.now()` inside model construction" is only a law
 * if a machine checks it. This script walks `src/` and fails on any
 * non-deterministic source of entropy or time.
 *
 * A line may use one only if it carries an explicit marker naming the reason:
 *
 *     const now = Date.now(); // determinism-quarantine: presenter timer display
 *
 * The marker is the whole exemption mechanism. There is no allowlist of files
 * and no environment variable, because either of those would drift.
 */

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/** Patterns that make a build non-reproducible. */
export const BANNED = [
  { re: /\bMath\s*\.\s*random\s*\(/, what: 'Math.random()', fix: 'draw from a named PCG32 substream (core/prng.js)' },
  { re: /\bDate\s*\.\s*now\s*\(/, what: 'Date.now()', fix: 'take an injected clock parameter' },
  { re: /\bnew\s+Date\s*\(\s*\)/, what: 'new Date()', fix: 'take an injected clock parameter' },
  { re: /\bperformance\s*\.\s*now\s*\(/, what: 'performance.now()', fix: 'only legal for presentation timing, never for model construction' },
  { re: /\bcrypto\s*\.\s*getRandomValues\s*\(/, what: 'crypto.getRandomValues()', fix: 'draw from a named PCG32 substream (core/prng.js)' },
  { re: /\bcrypto\s*\.\s*randomUUID\s*\(/, what: 'crypto.randomUUID()', fix: 'mint ids with core/ids.js' },
  { re: /\bUUID\s*\(\s*\)/, what: 'a UUID call', fix: 'mint ids with core/ids.js' },
];

const MARKER = /determinism-quarantine:\s*\S/;

/**
 * @param {string} dir
 * @param {string[]} [out]
 * @returns {string[]}
 */
export function jsFiles(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) jsFiles(p, out);
    else if (name.endsWith('.js') && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/**
 * Strip line and block comments so a pattern named in prose does not fail the
 * build. String literals are left alone deliberately: a banned call hidden in a
 * string is either dead or is about to be `eval`ed, and both deserve a failure.
 * @param {string} line
 * @returns {string}
 */
function stripLineComment(line) {
  const i = line.indexOf('//');
  const j = line.indexOf('*');
  if (i >= 0 && (j < 0 || i < j)) return line.slice(0, i);
  if (/^\s*[*]/.test(line)) return '';
  return line;
}

/**
 * @param {string} root
 * @returns {{file: string, line: number, what: string, fix: string, text: string}[]}
 */
export function scan(root) {
  /** @type {{file: string, line: number, what: string, fix: string, text: string}[]} */
  const findings = [];
  let inBlockComment = false;
  for (const file of jsFiles(root)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    inBlockComment = false;
    lines.forEach((raw, i) => {
      let line = raw;
      if (inBlockComment) {
        const end = line.indexOf('*/');
        if (end < 0) return;
        line = line.slice(end + 2);
        inBlockComment = false;
      }
      const start = line.indexOf('/*');
      if (start >= 0) {
        const end = line.indexOf('*/', start + 2);
        if (end < 0) { inBlockComment = true; line = line.slice(0, start); }
        else line = line.slice(0, start) + line.slice(end + 2);
      }
      const code = stripLineComment(line);
      if (!code.trim()) return;
      if (MARKER.test(raw)) return;
      for (const b of BANNED) {
        if (b.re.test(code)) {
          findings.push({ file: relative(ROOT, file), line: i + 1, what: b.what, fix: b.fix, text: raw.trim() });
        }
      }
    });
  }
  return findings;
}

function main() {
  const findings = scan(join(ROOT, 'src'));
  if (findings.length === 0) {
    console.log('determinism: clean — no unseeded randomness or wall-clock reads in src/');
    return;
  }
  console.error(`determinism: ${findings.length} violation(s)\n`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  ${f.what}`);
    console.error(`      ${f.text}`);
    console.error(`      → ${f.fix}, or mark the line "// determinism-quarantine: <reason>"\n`);
  }
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
