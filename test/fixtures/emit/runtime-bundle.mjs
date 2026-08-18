/**
 * The runtime bundle the emitter inlines, built the way `scripts/build.mjs`
 * builds it.
 *
 * The tests bundle rather than read `dist/`, so a stale `dist` cannot make a
 * green test lie, and so `test/emit/**` never depends on a build having been
 * run first.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from '../../../scripts/lib/bundler.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..', '..', '..');
const SRC = join(ROOT, 'src');

let cached = null;

/** @returns {{js: string, css: string}} */
export function runtimeBundle() {
  if (cached) return cached;
  const { code } = bundle({
    entry: join(SRC, 'runtime', 'index.js'),
    root: SRC,
    global: 'PitchProofRuntime',
    banner: '/* PitchProof runtime — test bundle */',
  });
  cached = { js: code, css: concatCss([...cssFiles(join(SRC, 'runtime')), ...cssFiles(join(SRC, 'branch')), ...cssFiles(join(SRC, 'scene'))]) };
  return cached;
}

/** @param {string} dir @returns {string[]} */
function cssFiles(dir) {
  if (!existsSync(dir)) return [];
  /** @type {string[]} */
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.css')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** @param {string[]} files @returns {string} */
function concatCss(files) {
  return files.map((f) => `/* ${relative(ROOT, f).split('\\').join('/')} */\n${readFileSync(f, 'utf8').trim()}`).join('\n\n');
}

/** A clock that never moves, so byte-identical re-emit is testable (§17.6). */
export const FIXED_CLOCK = () => '2026-03-01T12:00:00.000Z';
