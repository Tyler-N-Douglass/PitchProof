/**
 * `emit()` — the whole of §13, in order.
 *
 * The emitter is the last gate in the product. Three of PitchProof's hard laws
 * are laws *about the emitted file*, so this is where they stop being
 * intentions:
 *
 *   - §1.1 / §18.4 — no telemetry, verifiably. Every byte of the finished
 *     document goes through `scanForNetworkReferences`, and so does every scene
 *     the artifact can render later from its model payload, because a scene
 *     that only exists inside the compressed model is still a scene a client
 *     will see.
 *   - §9 / §18.1 / §22.6 — provenance, enforced here rather than in the UI, and
 *     checked against the final stylesheet rather than the markup alone.
 *   - §22.5 — the size budget, met by actually re-encoding images and reporting
 *     the real bytes, and refused when it cannot be met.
 *
 * **A severity-1 finding refuses the emit.** There is no override parameter, no
 * environment variable, and no "force" flag — not here and nowhere else in this
 * lane. §14 says so in one sentence: "Severity 1 findings block emit. There is
 * no override flag. If a lane proposes one, the critic rejects it." The refusal
 * comes back as `err`, so a caller cannot mistake it for a success with
 * warnings, and it names every blocking finding.
 *
 * **Determinism (§5, §17.6).** No wall-clock value reaches the artifact. The
 * injected `clock` is used for the §6 staleness check and for nothing else, so
 * two emits of the same project are byte-identical whatever the hour.
 *
 * @module emit/emit
 */

import { ok, err } from '../core/result.js';
import { normalizeEmitOptions, validateProofShape } from '../core/contracts.js';
import { utf8Length } from '../core/bytes.js';
import { contentId } from '../core/ids.js';
import { stableStringify } from '../core/hash.js';
import { toHtml } from '../core/vdom.js';
import { Runtime } from '../runtime/runtime.js';
import { getLayout } from '../runtime/layouts.js';
import { encodePayload, splitMedia } from './model.js';
import { ppRehydrateMedia } from './artifact-runtime.js';
import { inlineRuntime } from './document.js';
import { compileFallbackTheme, compileFontFaces } from './theme.js';
import { scanForNetworkReferences, scanModelAssets } from './scan.js';
import { assertProvenance, allScenesOf } from './provenance.js';
import { budgetAssets, collectAssets, sizeBudgetFinding } from './budget.js';

/** §6: a specimen older than this at emit time is stale. */
export const STALE_CAPTURE_DAYS = 30;

/** How many times the emitter re-budgets before giving up on fitting. */
const BUDGET_PASSES = 4;

/**
 * Emit a proof as one self-contained `.html` file.
 *
 * @param {import('../core/contracts.d.ts').Proof} proof
 * @param {Partial<import('../core/contracts.d.ts').EmitOptions>} [options]
 * @param {object} deps
 * @param {string} deps.runtimeJs        the bundled presentation runtime
 * @param {string} deps.runtimeCss       the bundled artifact stylesheet
 * @param {() => string} deps.clock      injected clock, returns an ISO string
 * @param {string} [deps.themeCss]       L5's `compileTheme(brand).css`
 * @param {string} [deps.userCss]        stylesheet the user added
 * @param {{family: string, dataUri: string, weight?: number, style?: string, licenseAsserted?: boolean}[]} [deps.fonts]
 * @param {(input: any) => any} [deps.resample]  host image resampler, for formats the in-repo codec cannot re-encode
 * @returns {Promise<import('../core/result.js').Result<import('./index.js').EmitResult>>}
 */
export async function emit(proof, options, deps) {
  if (!deps || typeof deps !== 'object') {
    return err('emit: deps is required — the emitter never reads the filesystem, so {runtimeJs, runtimeCss, clock} must be supplied');
  }
  const { runtimeJs, runtimeCss, clock } = deps;
  if (typeof runtimeJs !== 'string' || runtimeJs.trim() === '') {
    return err('emit: deps.runtimeJs must be the bundled presentation runtime; an artifact without it cannot be navigated');
  }
  if (typeof runtimeCss !== 'string') {
    return err('emit: deps.runtimeCss must be a string (it may be empty, but it must be supplied deliberately)');
  }
  if (typeof clock !== 'function') {
    return err('emit: deps.clock must be an injected clock returning an ISO string (§5 — no lane reads the wall clock directly)');
  }

  const shapeErrors = validateProofShape(proof);
  if (shapeErrors.length) {
    return err(`emit: the proof does not satisfy the §4 contract:\n  ${shapeErrors.join('\n  ')}`, shapeErrors);
  }

  const requestedOptions = { ...(proof.emitOptions || {}), ...(options || {}) };
  const emitOptions = normalizeEmitOptions(requestedOptions);
  const labelDisableRequested = requestedOptions.labelIllustrativeContent === false;

  const missingLayouts = layoutsMissingFor(proof);
  if (missingLayouts.length) {
    return err(
      `emit: no layout is registered for ${missingLayouts.map((l) => `"${l}"`).join(', ')}. `
      + 'Register L8\'s layouts (registerAllLayouts()) before emitting — otherwise the artifact would ship placeholder cards where the proof should be.',
      missingLayouts,
    );
  }

  const themeCss = typeof deps.themeCss === 'string' && deps.themeCss.trim()
    ? deps.themeCss
    : compileFallbackTheme(proof.brand).css;
  const fontCss = compileFontFaces(deps.fonts || []);
  const userCss = typeof deps.userCss === 'string' ? deps.userCss : '';
  const finalCss = [runtimeCss, fontCss, themeCss, userCss].filter((s) => s && s.trim()).join('\n\n');

  // ---- build, budget, rebuild ------------------------------------------
  let working = { ...proof, emitOptions };
  /** @type {import('./budget.js').DegradationLine[]} */
  let degradations = [];
  /** @type {{assetId: string, bytes: number, reason: string}[]} */
  let undegradable = [];
  let built = buildDocument(working, { runtimeJs, runtimeCss, themeCss, userCss, fontCss });

  for (let pass = 0; pass < BUDGET_PASSES && built.bytes > emitOptions.maxBytes; pass++) {
    const assetBytes = collectAssets(working).reduce((sum, a) => sum + a.bytes, 0);
    const reserveBytes = Math.max(0, built.bytes - assetBytes);
    const budgeted = budgetAssets({ ...proof, emitOptions }, emitOptions.maxBytes, {
      reserveBytes,
      renderScene: built.renderScene,
      quality: emitOptions.imageQuality,
      resample: deps.resample,
    });
    if (budgeted.plan.length === 0) { undegradable = budgeted.undegradable; break; }
    degradations = budgeted.plan;
    undegradable = budgeted.undegradable;
    working = budgeted.proof;
    built = buildDocument(working, { runtimeJs, runtimeCss, themeCss, userCss, fontCss });
  }

  const { html, bytes, renderScene, reconstructed, encoded } = built;

  // ---- the laws ---------------------------------------------------------
  /** @type {import('../core/contracts.d.ts').Finding[]} */
  const findings = [];

  findings.push(...scanForNetworkReferences(html, { where: 'artifact document' }));

  // An asset the model names but never inlines would vanish from the artifact
  // without ever reaching the document, so the document scan cannot see it.
  findings.push(...scanModelAssets(reconstructed));

  // Scenes past the first are not in the document — they are rendered at
  // presentation time from the model payload. Scanning only the file would
  // leave every one of them unchecked, which is most of the proof.
  for (const { scene, branchId } of allScenesOf(reconstructed)) {
    const sceneHtml = toHtml(renderScene(scene));
    findings.push(...scanForNetworkReferences(sceneHtml, {
      where: `scene ${scene.id}`,
      locus: branchId ? { sceneId: scene.id, branchId } : { sceneId: scene.id },
    }));
  }

  findings.push(...assertProvenance(reconstructed, html, finalCss, {
    renderScene,
    labelDisableRequested,
    mode: emitOptions.mode,
  }));

  findings.push(...staleCaptureFindings(reconstructed, clock));

  if (bytes > emitOptions.maxBytes) {
    const over = bytes - emitOptions.maxBytes;
    const blocked = undegradable.length
      ? ` ${undegradable.length} asset(s) could not be degraded: ${undegradable.slice(0, 5).map((u) => `${u.assetId} (${u.bytes} bytes — ${u.reason})`).join('; ')}.`
      : '';
    findings.push(sizeBudgetFinding(
      `The artifact is ${bytes} bytes, ${over} over the ${emitOptions.maxBytes}-byte budget, after ${degradations.length} degradation(s).${blocked}`,
      { assetId: undegradable.length ? undegradable[0].assetId : undefined, bytes, maxBytes: emitOptions.maxBytes, over },
    ));
  }

  const blocking = findings.filter((f) => f.severity === 1);
  const result = {
    html: blocking.length ? '' : html,
    bytes: blocking.length ? 0 : bytes,
    findings,
    degradations,
    compression: { mode: encoded.mode, modelBytes: encoded.modelBytes, mediaBytes: encoded.mediaBytes },
    measured: encoded.measured,
    undegradable,
  };

  if (blocking.length) {
    const lines = blocking.map((f, i) => `  ${i + 1}. [${f.code}] ${f.message}${locusSuffix(f.locus)}`);
    return err(
      `emit refused: ${blocking.length} severity-1 finding(s) block this artifact. `
      + 'There is no override flag (§14).\n' + lines.join('\n'),
      result,
    );
  }

  return ok(result);
}

/**
 * Which of the proof's layouts nobody registered.
 * @param {import('../core/contracts.d.ts').Proof} proof
 * @returns {string[]}
 */
export function layoutsMissingFor(proof) {
  /** @type {Set<string>} */
  const used = new Set();
  for (const scene of proof.spine || []) used.add(scene.layout);
  for (const branch of proof.branches || []) for (const scene of branch.scenes || []) used.add(scene.layout);
  return [...used].filter((name) => !getLayout(name)).sort();
}

/**
 * Serialize a proof to a document, and hand back everything the checks need.
 *
 * The first paint is rendered from the **reconstructed** model — the proof put
 * through exactly the encode/decode the artifact will perform — so the static
 * markup in the file and the tree the runtime builds at boot cannot disagree.
 *
 * @param {import('../core/contracts.d.ts').Proof} proof
 * @param {{runtimeJs: string, runtimeCss: string, themeCss: string, userCss: string, fontCss: string}} parts
 */
export function buildDocument(proof, parts) {
  const encoded = encodePayload(proof);
  const split = splitMedia(proof);
  const reconstructed = ppRehydrateMedia(JSON.parse(stableStringify(split.model)), split.table);

  const runtime = new Runtime(reconstructed, {});
  const renderScene = (scene) => runtime.renderScene(scene);
  const firstPaintHtml = toHtml(runtime.render());

  const html = inlineRuntime({
    runtimeJs: parts.runtimeJs,
    runtimeCss: parts.runtimeCss,
    themeCss: parts.themeCss,
    userCss: parts.userCss,
    fontCss: parts.fontCss,
    proof: reconstructed,
    firstPaintHtml,
    payload: encoded.payload,
    mediaText: encoded.mediaText,
    mode: encoded.mode,
    bootSource: encoded.bootSource,
  });

  return { html, bytes: utf8Length(html), renderScene, reconstructed, runtime, encoded, firstPaintHtml };
}

/**
 * §6: "record `capturedAt` on everything and raise `STALE_CAPTURE` at severity 3
 * when a specimen is older than 30 days at emit time." This is the one place
 * the injected clock is read, and nothing it produces reaches the artifact —
 * which is what keeps §17.6's byte-identical re-emit true at any hour.
 *
 * @param {import('../core/contracts.d.ts').Proof} proof
 * @param {() => string} clock
 * @returns {import('../core/contracts.d.ts').Finding[]}
 */
export function staleCaptureFindings(proof, clock) {
  /** @type {import('../core/contracts.d.ts').Finding[]} */
  const out = [];
  let nowMs;
  try { nowMs = Date.parse(clock()); } catch { return out; }
  if (!Number.isFinite(nowMs)) return out;

  for (const specimen of proof.specimens || []) {
    const capturedMs = Date.parse(specimen.capturedAt);
    if (!Number.isFinite(capturedMs)) continue;
    const ageDays = Math.floor((nowMs - capturedMs) / 86_400_000);
    if (ageDays <= STALE_CAPTURE_DAYS) continue;
    const message = `Specimen "${specimen.title}" was captured ${ageDays} days ago. §6 flags anything older than ${STALE_CAPTURE_DAYS} days at emit time — the prospect's page may have moved on.`;
    out.push({
      id: contentId('finding', { code: 'STALE_CAPTURE', specimenId: specimen.id, ageDays }),
      severity: 3,
      code: 'STALE_CAPTURE',
      message,
      locus: { specimenId: specimen.id },
      autoFixAvailable: false,
    });
  }
  return out;
}

/**
 * @param {Record<string, unknown>} locus
 * @returns {string}
 */
function locusSuffix(locus) {
  const parts = [];
  if (locus.sceneId) parts.push(`scene ${locus.sceneId}`);
  if (locus.branchId) parts.push(`branch ${locus.branchId}`);
  if (locus.renditionId) parts.push(`rendition ${locus.renditionId}`);
  if (locus.assetId) parts.push(`asset ${locus.assetId}`);
  if (locus.where) parts.push(String(locus.where));
  if (locus.line) parts.push(`line ${locus.line}:${locus.column}`);
  return parts.length ? `  [${parts.join(', ')}]` : '';
}
