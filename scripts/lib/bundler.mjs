/**
 * A deterministic ESM bundler for this repository (DECISIONS D3).
 *
 * §5 asks for "a small esbuild script committed in-repo"; D3 records why the
 * bundler is written here instead: three of the product's hard laws are about
 * what ends up in the emitted file, and a bundler we own makes byte-identical
 * re-emit (§17.6) a property of this repository rather than of a lockfile.
 *
 * It handles the ESM subset this repo is written in, and refuses anything else
 * loudly rather than mis-compiling it:
 *
 *   - relative imports only, always with an explicit `.js` extension;
 *   - named, namespace and default imports;
 *   - `export function|class|const|let|var`, and `export { a, b as c }`;
 *   - no `export *`, no `export default`, no dynamic `import()`, no cycles.
 *
 * Output is a single IIFE with a tiny module registry. Module order is a
 * post-order depth-first walk from the entry, so the bytes depend only on the
 * sources — never on filesystem iteration order, a clock, or a hash seed.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';

/** Thrown for source the bundler will not silently mis-compile. */
export class BundleError extends Error {}

/**
 * @typedef {object} ParsedModule
 * @property {string} id            path relative to the source root, POSIX separators
 * @property {string} file          absolute path
 * @property {string} body          source with import/export syntax rewritten
 * @property {string[]} deps        module ids, in source order
 * @property {string[]} exports     exported names
 */

const IMPORT_START = /^\s*import\b/;
const EXPORT_START = /^\s*export\b/;

/**
 * Split a source file into statements the bundler understands, joining the
 * multi-line forms of `import { … } from '…'` and `export { … }`.
 * @param {string} src
 * @returns {{kind: 'import'|'export-list'|'code', text: string, line: number}[]}
 */
function statements(src) {
  const lines = src.split('\n');
  /** @type {{kind: 'import'|'export-list'|'code', text: string, line: number}[]} */
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (IMPORT_START.test(line)) {
      let text = line;
      let n = i;
      while (!/from\s*['"][^'"]+['"]\s*;?\s*$/.test(text) && !/^\s*import\s*['"][^'"]+['"]\s*;?\s*$/.test(text)) {
        n += 1;
        if (n >= lines.length) throw new BundleError(`unterminated import starting at line ${i + 1}`);
        text += `\n${lines[n]}`;
      }
      out.push({ kind: 'import', text, line: i + 1 });
      // Preserve line count so stack traces stay honest.
      for (let k = i; k < n; k++) out.push({ kind: 'code', text: '', line: k + 1 });
      i = n;
      continue;
    }
    if (EXPORT_START.test(line) && /^\s*export\s*\{/.test(line)) {
      let text = line;
      let n = i;
      while (!/\}\s*;?\s*$/.test(text)) {
        n += 1;
        if (n >= lines.length) throw new BundleError(`unterminated export list at line ${i + 1}`);
        text += `\n${lines[n]}`;
      }
      out.push({ kind: 'export-list', text, line: i + 1 });
      for (let k = i; k < n; k++) out.push({ kind: 'code', text: '', line: k + 1 });
      i = n;
      continue;
    }
    out.push({ kind: 'code', text: line, line: i + 1 });
  }
  return out;
}

/**
 * Rewrite one module.
 * @param {string} file
 * @param {string} src
 * @param {string} root
 * @returns {ParsedModule}
 */
export function parseModule(file, src, root) {
  const id = toId(file, root);
  /** @type {string[]} */
  const deps = [];
  /** @type {{exported: string, local: string}[]} */
  const exported = [];
  /** @type {string[]} */
  const outLines = [];

  const addDep = (spec) => {
    if (!spec.startsWith('.')) {
      throw new BundleError(`${id}: bare import "${spec}" — this bundler takes relative paths only (D3: zero npm dependencies in the build path)`);
    }
    if (!spec.endsWith('.js')) {
      throw new BundleError(`${id}: import "${spec}" must carry an explicit .js extension`);
    }
    const depFile = resolve(dirname(file), spec);
    if (!existsSync(depFile)) throw new BundleError(`${id}: import "${spec}" does not resolve to a file`);
    const depId = toId(depFile, root);
    if (!deps.includes(depId)) deps.push(depId);
    return depId;
  };

  for (const st of statements(src)) {
    if (st.kind === 'import') {
      const m = st.text.match(/^\s*import\s+([\s\S]*?)\s+from\s*['"]([^'"]+)['"]\s*;?\s*$/)
        || st.text.match(/^\s*import\s*(?:)\s*['"]([^'"]+)['"]\s*;?\s*$/);
      if (!m) throw new BundleError(`${id}:${st.line}: cannot parse import`);
      if (m.length === 2) { addDep(m[1]); outLines.push(`__require(${JSON.stringify(addDep(m[1]))});`); continue; }
      const clause = m[1].trim();
      const depId = addDep(m[2]);
      outLines.push(importBinding(id, st.line, clause, depId));
      continue;
    }
    if (st.kind === 'export-list') {
      const m = st.text.match(/^\s*export\s*\{([\s\S]*?)\}\s*(?:from\s*['"]([^'"]+)['"]\s*)?;?\s*$/);
      if (!m) throw new BundleError(`${id}:${st.line}: cannot parse export list`);
      if (m[2]) throw new BundleError(`${id}:${st.line}: re-export from another module is not supported`);
      const parts = m[1].split(',').map((s) => s.trim()).filter(Boolean);
      for (const part of parts) {
        const [local, name = local] = part.split(/\s+as\s+/).map((s) => s.trim());
        exported.push({ exported: name, local });
      }
      // The assignment itself is emitted in the module tail, so an export list
      // placed above its declarations still binds the declared value.
      outLines.push('');
      continue;
    }

    const line = st.text;
    if (/^\s*export\s+default\b/.test(line)) throw new BundleError(`${id}:${st.line}: export default is not supported`);
    if (/^\s*export\s+\*/.test(line)) throw new BundleError(`${id}:${st.line}: export * is not supported`);
    const decl = line.match(/^(\s*)export\s+(async\s+function|function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/);
    if (decl) {
      exported.push({ exported: decl[3], local: decl[3] });
      outLines.push(line.replace(/^(\s*)export\s+/, '$1'));
      continue;
    }
    if (/^\s*export\b/.test(line)) throw new BundleError(`${id}:${st.line}: unsupported export form: ${line.trim()}`);
    if (/\bimport\s*\(/.test(line) && !/@type|@param|@returns|\*/.test(line)) {
      throw new BundleError(`${id}:${st.line}: dynamic import() is not supported`);
    }
    outLines.push(line);
  }

  const tail = exported.length
    ? `\n${exported.map((e) => `__exports[${JSON.stringify(e.exported)}] = ${e.local};`).join('\n')}\n`
    : '\n';

  return { id, file, body: `${outLines.join('\n')}${tail}`, deps, exports: dedupe(exported.map((e) => e.exported)) };
}

/**
 * @param {string} id @param {number} line @param {string} clause @param {string} depId
 * @returns {string}
 */
function importBinding(id, line, clause, depId) {
  const req = `__require(${JSON.stringify(depId)})`;
  const ns = clause.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
  if (ns) return `const ${ns[1]} = ${req};`;

  const named = clause.match(/^\{([\s\S]*)\}$/);
  if (named) return `const { ${destructure(named[1])} } = ${req};`;

  const both = clause.match(/^([A-Za-z_$][\w$]*)\s*,\s*\{([\s\S]*)\}$/);
  if (both) return `const __d = ${req}; const ${both[1]} = __d.default; const { ${destructure(both[2])} } = __d;`;

  const bare = clause.match(/^([A-Za-z_$][\w$]*)$/);
  if (bare) return `const ${bare[1]} = ${req}.default;`;

  throw new BundleError(`${id}:${line}: cannot parse import clause "${clause}"`);
}

/** @param {string} inner @returns {string} */
function destructure(inner) {
  return inner.split(',').map((s) => s.trim()).filter(Boolean).map((part) => {
    const [imported, local = imported] = part.split(/\s+as\s+/).map((s) => s.trim());
    return imported === local ? imported : `${imported}: ${local}`;
  }).join(', ');
}

/** @param {string[]} a @returns {string[]} */
function dedupe(a) { return [...new Set(a)]; }

/** @param {string} file @param {string} root @returns {string} */
function toId(file, root) {
  return relative(root, file).split(sep).join('/');
}

/**
 * Bundle an entry module and everything it reaches.
 *
 * @param {object} args
 * @param {string} args.entry     absolute path to the entry module
 * @param {string} args.root      absolute source root; module ids are relative to it
 * @param {string} [args.global]  when set, the entry's namespace is assigned to `globalThis[global]`
 * @param {string} [args.banner]  a comment placed at the top of the bundle
 * @returns {{code: string, modules: ParsedModule[]}}
 */
export function bundle({ entry, root, global: globalName, banner }) {
  /** @type {Map<string, ParsedModule>} */
  const modules = new Map();
  /** @type {string[]} */
  const order = [];
  /** @type {Set<string>} */
  const visiting = new Set();

  /** @param {string} file @param {string[]} trail */
  const visit = (file, trail) => {
    const id = toId(file, root);
    if (modules.has(id)) return;
    if (visiting.has(id)) {
      throw new BundleError(`import cycle: ${[...trail, id].join(' → ')} (D3: the bundler takes an acyclic graph)`);
    }
    visiting.add(id);
    const src = readFileSync(file, 'utf8');
    const mod = parseModule(file, src, root);
    for (const dep of mod.deps) visit(resolve(root, dep), [...trail, id]);
    visiting.delete(id);
    modules.set(id, mod);
    order.push(id);
  };

  visit(entry, []);

  const entryId = toId(entry, root);
  const parts = [];
  if (banner) parts.push(banner);
  parts.push('(function () {');
  parts.push("'use strict';");
  parts.push('var __modules = {};');
  parts.push('var __cache = {};');
  parts.push('function __require(id) {');
  parts.push('  var hit = __cache[id];');
  parts.push('  if (hit) return hit;');
  parts.push('  var exp = __cache[id] = {};');
  parts.push('  var factory = __modules[id];');
  parts.push('  if (!factory) throw new Error("module not bundled: " + id);');
  parts.push('  factory(exp, __require);');
  parts.push('  return exp;');
  parts.push('}');
  for (const id of order) {
    const mod = modules.get(id);
    parts.push(`__modules[${JSON.stringify(id)}] = function (__exports, __require) {`);
    parts.push(mod.body.replace(/\n+$/, ''));
    parts.push('};');
  }
  parts.push(`var __entry = __require(${JSON.stringify(entryId)});`);
  if (globalName) {
    parts.push(`if (typeof globalThis !== "undefined") globalThis[${JSON.stringify(globalName)}] = __entry;`);
  }
  parts.push('return __entry;');
  parts.push('})();');
  return { code: `${parts.join('\n')}\n`, modules: order.map((id) => modules.get(id)) };
}
