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
import { allScenesOf, labelOptionFinding } from './provenance.js';
import { budgetAssets, collectAssets, sizeBudgetFinding } from './budget.js';
import { runEmitGate } from './gate.js';

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
  // §2: a Review build has "no presenter notes". The runtime already refuses to
  // open presenter view without them, but a note that travels in the payload is
  // a note a recipient can read out of the file — and presenter notes are where
  // the internal read on the room lives. So they are removed from the model,
  // not merely hidden.
  const original = stripPresenterNotes({ ...proof, emitOptions }, emitOptions.includePresenterNotes);
  let working = original;
  /** @type {import('./budget.js').DegradationLine[]} */
  let degradations = [];
  /** @type {{assetId: string, bytes: number, reason: string}[]} */
  let undegradable = [];
  let built = buildDocument(working, { runtimeJs, runtimeCss, themeCss, userCss, fontCss });

  for (let pass = 0; pass < BUDGET_PASSES && built.bytes > emitOptions.maxBytes; pass++) {
    const assetBytes = collectAssets(working).reduce((sum, a) => sum + a.bytes, 0);
    const reserveBytes = Math.max(0, built.bytes - assetBytes);
    // Always from `original`, never from the previous pass's output. Each pass
    // refines the reserve — the bytes the document costs before assets — but a
    // plan measured against an already-degraded proof would report savings
    // relative to a state that never shipped, and §13 says the report has to be
    // the real one. Budgeting `original` also keeps the presenter-note stripping
    // that a Review build depends on.
    const budgeted = budgetAssets(original, emitOptions.maxBytes, {
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

  // §14, in one call: every rule in the §4 set, run against the artifact that
  // is about to ship. These are L11's rule objects, not a second copy of them,
  // so the emitter and the rehearsal sweep cannot disagree — see `emit/gate.js`
  // for why this is not simply a call to `runPreflight`.
  try {
    findings.push(...await runEmitGate({
      proof: reconstructed,
      renderScene,
      html,
      css: finalCss,
      runtimeJs,
      runtimeCss,
      clock,
    }));
  } catch (error) {
    return err(
      `emit: the §14 gate could not run, so this artifact cannot be shown to be clean: ${error && error.message ? error.message : error}. `
      + 'The emit is refused rather than shipped unchecked.',
      error,
    );
  }

  // Scenes past the first are not in the document — they are rendered at
  // presentation time from the model payload. The gate scans the document, so
  // scanning only that would leave every later scene unchecked, which is most
  // of the proof.
  for (const { scene, branchId } of allScenesOf(reconstructed)) {
    const sceneHtml = toHtml(renderScene(scene));
    findings.push(...scanForNetworkReferences(sceneHtml, {
      where: `scene ${scene.id}`,
      locus: branchId ? { sceneId: scene.id, branchId } : { sceneId: scene.id },
    }));
  }

  // A network reference *inside* an asset that is properly inlined. The gate's
  // rule checks that every asset is a data: URI; this checks what is in one.
  findings.push(...scanModelAssets(reconstructed, { nestedOnly: true }));

  // §9's label-option check. `normalizeEmitOptions` has already forced the flag
  // back to true, so the model the gate reads no longer records that the caller
  // asked for it to be off — only the emitter still knows, and L11's rule skips
  // L10's copy of this finding precisely so that there is one of it.
  const optionFinding = labelOptionFinding(reconstructed, { labelDisableRequested, mode: emitOptions.mode });
  if (optionFinding) findings.push(optionFinding);

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
    return err(describeRefusal(blocking), result);
  }

  return ok(result);
}

/**
 * Remove presenter notes from every beat when the build does not carry them.
 * @param {import('../core/contracts.d.ts').Proof} proof
 * @param {boolean} keep
 * @returns {import('../core/contracts.d.ts').Proof}
 */
export function stripPresenterNotes(proof, keep) {
  if (keep) return proof;
  const scrub = (scene) => ({
    ...scene,
    beats: (scene.beats || []).map((b) => (b.presenterNote === null ? b : { ...b, presenterNote: null })),
  });
  return {
    ...proof,
    spine: (proof.spine || []).map(scrub),
    branches: (proof.branches || []).map((b) => ({ ...b, scenes: (b.scenes || []).map(scrub) })),
  };
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
 * The refusal a seller reads.
 *
 * §14 requires the emit to be refused and the caller to be told why; how it is
 * told is the emitter's product surface, and the first version of it was a wall
 * of near-identical paragraphs. A five-rendition `splitBeforeAfter` scene
 * produced **eleven** blocking findings that were **three** distinct defects,
 * each stated three or four times because the same body text is measured in
 * several cells. A seller scrolling that cannot tell whether they have three
 * problems or eleven, and the natural conclusion — that the tool is broken — is
 * the wrong one.
 *
 * So identical defects are collapsed with a count, the distinct ones are all
 * kept, and the refusal opens with the shape of the problem: how many, of what,
 * and where. Nothing is hidden; a defect that appears once still appears once.
 *
 * @param {import('../core/contracts.d.ts').Finding[]} blocking
 * @returns {string}
 */
export function describeRefusal(blocking) {
  /** @type {Map<string, {finding: any, count: number, scenes: Set<string>}>} */
  const groups = new Map();
  for (const finding of blocking) {
    const key = `${finding.code}\u0000${finding.message}`;
    let group = groups.get(key);
    if (!group) {
      group = { finding, count: 0, scenes: new Set() };
      groups.set(key, group);
    }
    group.count += 1;
    if (finding.locus && finding.locus.sceneId) group.scenes.add(String(finding.locus.sceneId));
  }

  /** @type {Record<string, number>} */
  const byCode = {};
  /** @type {Set<string>} */
  const allScenes = new Set();
  for (const f of blocking) {
    byCode[f.code] = (byCode[f.code] || 0) + 1;
    if (f.locus && f.locus.sceneId) allScenes.add(String(f.locus.sceneId));
  }
  const codeSummary = Object.keys(byCode).sort().map((c) => `${byCode[c]} × ${c}`).join(', ');
  const where = allScenes.size === 0 ? ''
    : allScenes.size <= 4 ? ` in ${allScenes.size === 1 ? 'scene' : 'scenes'} ${[...allScenes].sort().join(', ')}`
      : ` across ${allScenes.size} scenes`;

  const distinct = [...groups.values()];
  const shown = distinct.slice(0, 20);
  const lines = shown.map((group, i) => {
    const times = group.count > 1 ? ` ×${group.count}` : '';
    return `  ${i + 1}. [${group.finding.code}${times}] ${group.finding.message}${locusSuffix(group.finding.locus)}`;
  });
  if (distinct.length > shown.length) {
    lines.push(`  … and ${distinct.length - shown.length} further distinct finding(s) of the same kind.`);
  }

  const head = distinct.length === blocking.length
    ? `emit refused: ${blocking.length} severity-1 finding(s) block this artifact`
    : `emit refused: ${blocking.length} severity-1 finding(s), ${distinct.length} distinct, block this artifact`;

  return `${head} — ${codeSummary}${where}. There is no override flag (§14).\n${lines.join('\n')}`;
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
