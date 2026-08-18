/**
 * The optional runtime adapter (§9).
 *
 * "A settings panel where the user can configure a generation endpoint and key
 * at runtime. Rules: the key lives in memory and IndexedDB on their machine
 * only; it is **never** written into an emitted artifact; the emitter must
 * assert its absence; and every adapter-produced rendition is stamped
 * `provenance: 'illustrative'` until the user explicitly promotes it."
 *
 * Four properties this module holds, each testable:
 *
 * 1. **`http` is injected.** There is no global `fetch` here, and no other module
 *    in L7 references the network at all. A test drives the adapter with a stub;
 *    the studio supplies the real transport.
 * 2. **The key never leaves this call.** It is placed in one `Authorization`
 *    header on the request the caller's own transport makes, and never in the
 *    request body, never in the rendition, never in `notes`, never in a log
 *    line, never on the module. Only a *fingerprint* — a SHA-256 of the key — is
 *    retained, so `assertNoAdapterSecrets` can look for the literal key in
 *    anything L10 is about to serialise without holding the key to do it.
 * 3. **Every adapter rendition is `illustrative` at creation**, enforced in
 *    `buildRendition` by `producedBy: 'adapter'`, not by this module remembering
 *    to ask.
 * 4. **Failure is a `Result` err.** Never a throw, never a silent empty
 *    rendition. A rendition with no blocks would render as an empty "after"
 *    panel in a live pitch, which is worse than an error the studio can show.
 *
 * @module recipe/adapter
 */

import { ok, err } from '../core/result.js';
import { sha256Hex } from '../core/hash.js';
import { buildRendition } from './provenance.js';
import { parsePasted } from './paste.js';
import { assertNoFabricatedFacts, unsourcedNote } from './facts.js';
import { validateBlock } from '../core/contracts.js';

/**
 * SHA-256 fingerprints of keys this session has used. Fingerprints only: the
 * key itself is not retained, so this set cannot leak one even if it were
 * serialised by accident.
 * @type {Set<string>}
 */
const SECRET_FINGERPRINTS = new Set();

/** Property names whose value is a secret, or a network reference, by name. */
const SECRET_KEY_NAMES = /^(key|apikey|api_key|secret|token|access_token|refresh_token|authorization|auth|bearer|password|passwd|credential|credentials|endpoint|proxybase|proxy_base)$/i;

/** Value shapes that read as credentials wherever they appear. */
const SECRET_VALUE_SHAPES = [
  { re: /\bsk-[A-Za-z0-9_-]{16,}/, what: 'an sk- prefixed API key' },
  { re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i, what: 'a bearer token' },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, what: 'a JSON Web Token' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, what: 'an AWS access key id' },
  { re: /\bghp_[A-Za-z0-9]{20,}/, what: 'a GitHub personal access token' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, what: 'a Slack token' },
];

/** Token separators, for the fingerprint scan of a longer string. */
const TOKEN_SPLIT = /[^A-Za-z0-9_\-.+/=]+/;

/**
 * Record a key's fingerprint so `assertNoAdapterSecrets` can recognise it later
 * without the key being retained anywhere.
 * @param {string} key
 * @returns {string} the fingerprint
 */
export function noteAdapterSecret(key) {
  const fp = sha256Hex(String(key));
  SECRET_FINGERPRINTS.add(fp);
  return fp;
}

/** Forget every fingerprint. The studio calls this when a project closes. */
export function forgetAdapterSecrets() {
  SECRET_FINGERPRINTS.clear();
}

/** How many fingerprints are held. Never the keys themselves. */
export function adapterSecretCount() {
  return SECRET_FINGERPRINTS.size;
}

/**
 * Prove that a value carries no adapter secret.
 *
 * L10 calls this on the proof, on the rendition list, and on the serialised
 * artifact before writing it. **Empty means clean**, matching the house style of
 * `validateProofShape`.
 *
 * Three checks, in increasing generality:
 *
 * 1. **Fingerprint match.** Any string, or any token inside a string, whose
 *    SHA-256 matches a key this session configured. This is the exact check: it
 *    finds the user's real key wherever it ended up.
 * 2. **Key names.** A property called `key`, `token`, `authorization`,
 *    `endpoint` and so on, with a non-empty string value. Adapter configuration
 *    has no business in a proof at all, so the name is enough.
 * 3. **Value shapes.** Strings shaped like credentials — `sk-…`, a bearer
 *    header, a JWT, an AWS key id — even when this session never saw them.
 *
 * What it cannot do: recognise an unknown-format key this session never
 * configured, that is not shaped like any listed credential, and that sits under
 * an innocuous property name. Check 1 is the one that matters, and it is exact.
 *
 * @param {unknown} value
 * @param {{path?: string, maxDepth?: number}} [options]
 * @returns {string[]} one line per finding; empty means clean
 */
export function assertNoAdapterSecrets(value, options = {}) {
  /** @type {string[]} */
  const findings = [];
  const maxDepth = typeof options.maxDepth === 'number' ? options.maxDepth : 64;
  const seen = new Set();

  /**
   * @param {string} s
   * @param {string} path
   */
  const scanString = (s, path) => {
    if (!s) return;
    if (SECRET_FINGERPRINTS.size) {
      if (SECRET_FINGERPRINTS.has(sha256Hex(s))) {
        findings.push(`${path}: contains a configured adapter key verbatim`);
        return;
      }
      if (s.length < 4096) {
        for (const token of s.split(TOKEN_SPLIT)) {
          if (token.length < 8) continue;
          if (SECRET_FINGERPRINTS.has(sha256Hex(token))) {
            findings.push(`${path}: embeds a configured adapter key`);
            return;
          }
        }
      }
    }
    for (const shape of SECRET_VALUE_SHAPES) {
      if (shape.re.test(s)) { findings.push(`${path}: looks like ${shape.what}`); return; }
    }
  };

  /**
   * @param {unknown} v
   * @param {string} path
   * @param {number} depth
   */
  const walk = (v, path, depth) => {
    if (v === null || v === undefined || depth > maxDepth) return;
    if (typeof v === 'string') { scanString(v, path); return; }
    if (typeof v !== 'object') return;
    if (seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) { v.forEach((item, i) => walk(item, `${path}[${i}]`, depth + 1)); return; }
    if (v instanceof Map) { for (const [k, item] of v) walk(item, `${path}.${String(k)}`, depth + 1); return; }
    if (v instanceof Set) { let i = 0; for (const item of v) walk(item, `${path}{${i++}}`, depth + 1); return; }
    for (const [k, item] of Object.entries(v)) {
      const childPath = `${path}.${k}`;
      if (SECRET_KEY_NAMES.test(k) && typeof item === 'string' && item.trim()) {
        findings.push(`${childPath}: adapter configuration must never reach an artifact (property "${k}")`);
        continue;
      }
      walk(item, childPath, depth + 1);
    }
  };

  walk(value, options.path || 'value', 0);
  return findings;
}

/**
 * Normalise whatever an adapter endpoint answered with into blocks.
 *
 * Three shapes are accepted, in order: a `blocks` array of contract-valid
 * `ContentBlock`s; a `text` or `markdown` string, which goes through the paste
 * parser; or a bare string body. Anything else is a failure, not an empty
 * rendition.
 *
 * @param {unknown} payload
 * @returns {{blocks: import('../core/contracts.d.ts').ContentBlock[], label: string|null}|null}
 */
export function blocksFromAdapterPayload(payload) {
  if (payload === null || payload === undefined) return null;
  if (typeof payload === 'string') {
    const blocks = parsePasted(payload);
    return blocks.length ? { blocks, label: null } : null;
  }
  if (typeof payload !== 'object') return null;
  const body = /** @type {Record<string, unknown>} */(payload);
  const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim() : null;

  if (Array.isArray(body.blocks)) {
    /** @type {string[]} */
    const errs = [];
    body.blocks.forEach((b, i) => validateBlock(b, `blocks[${i}]`, errs));
    if (errs.length || body.blocks.length === 0) return null;
    return { blocks: /** @type {any} */(body.blocks), label };
  }
  for (const field of ['text', 'markdown', 'html', 'content', 'output']) {
    const v = body[field];
    if (typeof v === 'string' && v.trim()) {
      const blocks = parsePasted(v);
      if (blocks.length) return { blocks, label };
    }
  }
  return null;
}

/**
 * Run a configured generation endpoint against a specimen.
 *
 * @param {import('../core/contracts.d.ts').Recipe} recipe
 * @param {import('../core/contracts.d.ts').Specimen} specimen
 * @param {object} config
 * @param {string} config.endpoint
 * @param {string} config.key
 * @param {(url: string, init: object) => Promise<{ok: boolean, status: number, text: () => Promise<string>|string}>} config.http
 * @param {string} [config.label]         the rendition label to request
 * @param {AbortSignal} [config.signal]
 * @returns {Promise<{ok: true, value: import('../core/contracts.d.ts').Rendition} | {ok: false, error: string, detail?: unknown}>}
 */
export async function runAdapter(recipe, specimen, config = /** @type {any} */({})) {
  const { endpoint, key, http, label, signal } = config;

  if (!recipe || typeof recipe.id !== 'string') return err('runAdapter: a recipe is required');
  if (!specimen || typeof specimen.id !== 'string') return err('runAdapter: a specimen is required');
  if (typeof endpoint !== 'string' || !endpoint.trim()) return err('runAdapter: no endpoint is configured');
  if (typeof key !== 'string' || !key.trim()) return err('runAdapter: no key is configured');
  if (typeof http !== 'function') {
    return err('runAdapter: an http transport must be injected; this module never calls the network itself');
  }

  noteAdapterSecret(key);
  const requestedLabel = typeof label === 'string' && label.trim()
    ? label.trim()
    : (recipe.outputLabels && recipe.outputLabels[0]) || recipe.name;

  // The body carries the prompt and the source. It does not carry the key.
  const body = {
    prompt: recipe.adapterPrompt,
    recipe: { id: recipe.id, name: recipe.name, intent: recipe.intent, outputLabels: recipe.outputLabels },
    label: requestedLabel,
    specimen: {
      id: specimen.id,
      kind: specimen.kind,
      title: specimen.title,
      locale: specimen.locale,
      blocks: specimen.blocks,
    },
  };

  let response;
  try {
    response = await http(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    return err(`runAdapter: transport failed — ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!response || typeof response !== 'object') return err('runAdapter: transport returned nothing');
  if (response.ok === false) {
    return err(`runAdapter: endpoint answered ${typeof response.status === 'number' ? response.status : 'an error'}`);
  }

  let raw;
  try {
    raw = typeof response.text === 'function' ? await response.text() : '';
  } catch (e) {
    return err(`runAdapter: could not read the response — ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof raw !== 'string' || !raw.trim()) return err('runAdapter: endpoint returned an empty response');

  /** @type {unknown} */
  let payload = raw;
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { payload = JSON.parse(trimmed); } catch { payload = raw; }
  }

  const parsed = blocksFromAdapterPayload(payload);
  if (!parsed) return err('runAdapter: endpoint returned no usable content; refusing to build an empty rendition');

  const violations = assertNoFabricatedFacts(parsed.blocks, specimen);
  const factNote = unsourcedNote(violations);
  const notes = [
    `Produced by the configured adapter for recipe ${recipe.id}. Illustrative until a person promotes it (§9).`,
    violations.length
      ? `${violations.length} value(s) in this output are not present in the source specimen and need a human check before use (§18.2).`
      : 'Every numeral, quotation and named entity in this output is present in the source specimen.',
    factNote,
  ].filter(Boolean).join(' ');

  let rendition;
  try {
    rendition = buildRendition({
      specimen,
      recipe,
      label: parsed.label || requestedLabel,
      blocks: parsed.blocks,
      media: [],
      producedBy: 'adapter',
      notes,
    });
  } catch (e) {
    return err(`runAdapter: could not build a rendition — ${e instanceof Error ? e.message : String(e)}`);
  }

  // Belt and braces. `buildRendition` forces this, and the adapter refuses to
  // hand back anything else even if that rule were ever weakened.
  if (rendition.provenance !== 'illustrative') {
    return err('runAdapter: adapter output must be illustrative at creation (§9); refusing');
  }

  const leaks = assertNoAdapterSecrets(rendition, { path: 'rendition' });
  if (leaks.length) {
    return err(`runAdapter: refusing a rendition that carries adapter configuration — ${leaks.join('; ')}`);
  }

  return ok(rendition);
}
