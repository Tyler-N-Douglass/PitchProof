#!/usr/bin/env node
/**
 * §17.7 Offline integrity, proved rather than asserted.
 *
 * §12: "the runtime must be fully functional with networking disabled.
 * `verify-offline.mjs` enforces this in CI by loading the emitted artifact in a
 * headless browser with all network requests blocked and failing the build on
 * any request attempt." §18.4: "No tracking, no beacons, no network. Verified at
 * emit, not asserted in a README."
 *
 * `src/emit/scan.js` is the static half of that law. This is the dynamic half,
 * and it is the one that cannot be argued with: a real Chromium, a real
 * `file://` URL, every request recorded, and a real keyboard driving the deck.
 *
 * What it does, in order:
 *
 *   1. Bundles `src/artifact.js` and emits an artifact from a fixture proof —
 *      through `emit()`, so the laws that refuse an artifact have already run.
 *   2. Loads it from `file://` in headless Chromium with the context offline,
 *      DNS mapped to nothing, and every request recorded. **Any request other
 *      than the document itself is a failure**, and so is any console error.
 *   3. Measures first contentful paint and fails above 1500ms (§12).
 *   4. Walks every scene and every beat of the spine and of every branch with
 *      real key presses, comparing the browser's state hash at each step
 *      against an independent simulation of `navigate()` in Node. A divergence
 *      is state corruption and is reported as such.
 *   5. Exercises the jump index, nested jumps and their unwinding, the branch
 *      map, the contents index, the blank screen, `Home`, and a backward step
 *      from every beat.
 *   6. Repeats the load with `DecompressionStream` deleted, so the artifact's
 *      fallback decode path (D5) is proved on the real file rather than only in
 *      a unit test.
 *
 * Exits non-zero on any failure, with a legible report.
 *
 * Playwright is a dev dependency used only here (D3). Chromium is preinstalled;
 * this script never runs `playwright install`.
 */

import { mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SRC = join(ROOT, 'src');

/** §12's cold-boot budget, in milliseconds. */
export const FCP_BUDGET_MS = 1500;

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** @type {{ok: boolean, label: string, detail: string}[]} */
const results = [];
let failures = 0;

/** @param {string} label @param {string} [detail] */
function pass(label, detail = '') {
  results.push({ ok: true, label, detail });
  process.stdout.write(`  ok    ${label}${detail ? `  — ${detail}` : ''}\n`);
}

/** @param {string} label @param {string} detail */
function fail(label, detail) {
  failures++;
  results.push({ ok: false, label, detail });
  process.stdout.write(`  FAIL  ${label}\n        ${String(detail).split('\n').join('\n        ')}\n`);
}

/** @param {string} message */
function section(message) {
  process.stdout.write(`\n${message}\n`);
}

/**
 * A dependency this script needs that has not landed. Reported precisely and
 * fatally — a verification that quietly skips what it cannot check is worse
 * than no verification.
 * @param {string} what
 * @param {string} why
 */
function missingDependency(what, why) {
  process.stdout.write(`\nverify-offline: cannot run.\n  ${what}\n  ${why}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Build the artifact
// ---------------------------------------------------------------------------

/**
 * The proof this script verifies.
 *
 * By default it is the **corpus** proof: four hostile pages and two binary
 * documents ingested and run through the whole pipeline. The §20 critic's
 * finding was that every severity-1 defect in the critique was reachable from a
 * proof built out of the corpus and none from the hand-written fixture, and
 * this script is the last gate before an artifact is called offline-clean — so
 * it should be looking at the harder of the two. It is also the bigger deck,
 * which means a longer keyboard walk over more layouts.
 *
 * `--fixture` runs the hand-written proof instead. It is not redundant: it is
 * the only proof that reaches the raw/deflate crossover (a single-scene proof
 * correctly keeps `raw` and ships no inflater), the `deps.resample` hook, and
 * the many-references-one-payload budgeting case — the corpus shares its assets
 * through one `MediaLedger`, so its media is deduplicated before the budgeter
 * ever sees it.
 *
 * @returns {Promise<{proof: any, source: string, clock: () => string}>}
 */
async function verificationProof() {
  if (process.argv.includes('--fixture')) {
    const { emitProof } = await import('../test/fixtures/emit/proofs.mjs');
    return {
      proof: emitProof({ imageEdge: 96 }),
      source: 'hand-written fixture',
      clock: () => '2026-03-01T12:00:00.000Z',
    };
  }
  const { buildCorpusProof } = await import('../test/fixtures/corpus/proof.mjs');
  const { corpusClock } = await import('../test/fixtures/corpus/index.mjs');
  return {
    proof: await buildCorpusProof(),
    source: 'Northwind corpus, through the whole pipeline',
    clock: corpusClock(),
  };
}

/** @returns {Promise<{html: string, proof: any, deck: any, nav: any, bytes: number, compression: any}>} */
async function buildArtifact() {
  const entry = join(SRC, 'artifact.js');
  if (!existsSync(entry)) {
    missingDependency(
      'src/artifact.js is not present.',
      'It is the artifact composition root that wires L2\'s runtime to L8\'s layouts and L9\'s overlays. '
      + 'Without it there is no artifact to verify.',
    );
  }

  const { bundle } = await import('./lib/bundler.mjs');
  const { code } = bundle({ entry, root: SRC, global: 'PitchProofRuntime', banner: '/* PitchProof artifact runtime */' });
  const css = concatCss([...cssFiles(join(SRC, 'runtime')), ...cssFiles(join(SRC, 'branch')), ...cssFiles(join(SRC, 'scene'))]);

  const { emit } = await import('../src/emit/index.js');
  const { registerAllLayouts } = await import('../src/scene/index.js');
  const { missingLayouts } = await import('../src/runtime/layouts.js');
  const { buildDeck } = await import('../src/runtime/deck.js');
  const { initialState } = await import('../src/runtime/nav.js');
  registerAllLayouts();
  const stillMissing = missingLayouts();
  if (stillMissing.length) {
    missingDependency(
      `L8 has not registered these layouts: ${stillMissing.join(', ')}.`,
      'An artifact emitted now would render placeholder cards where the proof should be, and this script would be verifying the wrong file.',
    );
  }

  const { proof, source, clock } = await verificationProof();
  const result = await emit(proof, proof.emitOptions || {}, {
    runtimeJs: code,
    runtimeCss: css,
    clock,
  });
  if (!result.ok) {
    process.stdout.write(
      `\nverify-offline: the emitter refused the ${source} proof, which is the correct behaviour for a proof that `
      + `violates a law — but it leaves nothing to verify.\n\n${result.error}\n`);
    process.exit(1);
  }
  process.stdout.write(`  proof    ${source} — ${proof.spine.length} spine scene(s), ${proof.branches.length} branch(es)\n`);

  const deck = buildDeck(proof);
  return {
    html: result.value.html,
    proof,
    deck,
    nav: initialState(deck),
    bytes: result.value.bytes,
    compression: result.value.compression,
  };
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

// ---------------------------------------------------------------------------
// The keyboard walk
// ---------------------------------------------------------------------------

/** The key each navigation command is bound to, taken from L2's binding table. */
const KEYS = {
  nextBeat: 'ArrowRight',
  prevBeat: 'ArrowLeft',
  nextScene: 'ArrowDown',
  prevScene: 'ArrowUp',
  firstScene: 'Home',
  openJump: '/',
  toggleMap: 'm',
  toggleContents: 'c',
  toggleBlank: 'b',
  returnToSpine: 'r',
  escape: 'Escape',
};

/**
 * Drive the artifact through every position, comparing the browser against an
 * independent simulation in Node.
 *
 * @param {import('playwright').Page} page
 * @param {any} deck
 * @param {{navigate: Function, stateHash: Function, initialState: Function, allPositions: Function}} nav
 * @returns {Promise<{steps: number, mismatches: string[]}>}
 */
async function keyboardWalk(page, deck, nav) {
  /** @type {string[]} */
  const mismatches = [];
  let steps = 0;
  let state = nav.initialState(deck);

  /** @returns {Promise<{hash: string, sequence: string, beat: string, scene: string|null}>} */
  const readStage = async () => page.evaluate(() => {
    const stage = document.querySelector('.pp-stage');
    const scene = document.querySelector('.pp-scene, [data-pp-scene]');
    return {
      hash: stage ? stage.getAttribute('data-pp-hash') : null,
      sequence: stage ? stage.getAttribute('data-pp-sequence') : null,
      beat: stage ? stage.getAttribute('data-pp-beat') : null,
      scene: scene ? scene.getAttribute('data-pp-scene') : null,
      blank: !!document.querySelector('.pp-blank'),
      overlay: !!document.querySelector('.pp-overlay-layer'),
      placeholder: !!document.querySelector('.pp-layout--placeholder'),
    };
  });

  /**
   * @param {string} key
   * @param {import('../src/runtime/nav.js').NavAction|null} action
   * @param {string} what
   */
  const press = async (key, action, what) => {
    await page.keyboard.press(key);
    steps++;
    if (action) state = nav.navigate(deck, state, action);
    const seen = await readStage();
    if (seen.placeholder) mismatches.push(`${what}: the artifact rendered a placeholder layout`);
    if (!action) return seen;
    const expected = nav.stateHash(deck, state);
    if (seen.hash !== expected) {
      mismatches.push(`${what}: browser hash ${seen.hash} but navigate() says ${expected} (sequence ${seen.sequence}, beat ${seen.beat}, scene ${seen.scene})`);
      // Re-synchronise so one divergence does not cascade into hundreds.
      state = nav.initialState(deck);
      await page.keyboard.press(KEYS.firstScene);
    }
    return seen;
  };

  // 1. Forward through every position the deck has, then back to the start.
  const positions = nav.allPositions(deck);
  await press(KEYS.firstScene, { type: 'firstScene' }, 'Home');

  const spineBeats = deck.spine.scenes.reduce((sum, s) => sum + Math.max(1, (s.beats || []).length), 0);
  for (let i = 0; i < spineBeats + 2; i++) {
    await press(KEYS.nextBeat, { type: 'nextBeat' }, `spine forward step ${i + 1}`);
  }

  // 2. A backward step from every beat, then forward again: §17.9's
  //    reversibility, driven through the real keyboard.
  await press(KEYS.firstScene, { type: 'firstScene' }, 'Home');
  for (let i = 0; i < spineBeats; i++) {
    const before = await readStage();
    const moved = await press(KEYS.nextBeat, { type: 'nextBeat' }, `reversibility forward ${i}`);
    // At the deck's last beat there is nothing forward of here, so there is
    // nothing for a backward step to undo. Checking it would assert that
    // `prev` is a no-op, which is the opposite of what §17.9 asks.
    if (moved.hash === before.hash) break;
    await press(KEYS.prevBeat, { type: 'prevBeat' }, `reversibility back ${i}`);
    const after = await readStage();
    if (before.hash !== after.hash) {
      mismatches.push(`reversibility at beat ${i}: forward-then-back landed on ${after.scene}#${after.beat} (${after.hash}), not ${before.scene}#${before.beat} (${before.hash})`);
    }
    await press(KEYS.nextBeat, { type: 'nextBeat' }, `reversibility resume ${i}`);
  }

  // 3. Scene navigation.
  await press(KEYS.firstScene, { type: 'firstScene' }, 'Home');
  for (let i = 0; i < deck.spine.scenes.length + 1; i++) {
    await press(KEYS.nextScene, { type: 'nextScene' }, `nextScene ${i}`);
  }
  for (let i = 0; i < deck.spine.scenes.length + 1; i++) {
    await press(KEYS.prevScene, { type: 'prevScene' }, `prevScene ${i}`);
  }

  // 4. Every branch, by jump, walked to its end and returned — including the
  //    nested jump the fixture plants inside a branch (§22.4).
  const branches = [...deck.sequences.values()].filter((s) => s.kind === 'branch');
  for (const branch of branches) {
    await press(KEYS.firstScene, { type: 'firstScene' }, 'Home');
    state = nav.navigate(deck, state, { type: 'jump', branchId: branch.id });
    await page.evaluate((id) => window.__PITCHPROOF__.runtime.run('jump', id), branch.id);
    steps++;
    let seen = await readStage();
    if (seen.hash !== nav.stateHash(deck, state)) {
      mismatches.push(`jump to ${branch.id}: browser hash ${seen.hash} but navigate() says ${nav.stateHash(deck, state)}`);
      state = nav.initialState(deck);
      await page.keyboard.press(KEYS.firstScene);
      continue;
    }
    const branchBeats = branch.scenes.reduce((sum, s) => sum + Math.max(1, (s.beats || []).length), 0);
    for (let i = 0; i < branchBeats + 1; i++) {
      await press(KEYS.nextBeat, { type: 'nextBeat' }, `${branch.id} forward ${i}`);
    }
    await press(KEYS.returnToSpine, { type: 'returnToSpine' }, `${branch.id} return`);
    seen = await readStage();
    if (seen.sequence !== 'spine') mismatches.push(`${branch.id}: 'r' did not return to the spine (sequence ${seen.sequence})`);
  }

  // 5. A nested jump: into a branch, then into another branch from inside it,
  //    then unwind. The return stack has to pop in order (§11, §22.4).
  const nesting = branches.find((b) => b.scenes.some((s) => (s.branchAnchors || []).length > 0));
  if (nesting) {
    const inner = nesting.scenes.flatMap((s) => s.branchAnchors || [])[0];
    await press(KEYS.firstScene, { type: 'firstScene' }, 'Home');
    for (const id of [nesting.id, inner]) {
      state = nav.navigate(deck, state, { type: 'jump', branchId: id });
      await page.evaluate((branchId) => window.__PITCHPROOF__.runtime.run('jump', branchId), id);
      steps++;
    }
    let seen = await readStage();
    if (seen.hash !== nav.stateHash(deck, state)) {
      mismatches.push(`nested jump ${nesting.id} → ${inner}: browser hash ${seen.hash} but navigate() says ${nav.stateHash(deck, state)}`);
    }
    const depth = await page.evaluate(() => window.__PITCHPROOF__.runtime.nav.stack.length);
    if (depth !== 2) mismatches.push(`nested jump: return stack depth is ${depth}, expected 2`);
    await press(KEYS.returnToSpine, { type: 'returnToSpine' }, 'unwind to spine');
    const afterDepth = await page.evaluate(() => window.__PITCHPROOF__.runtime.nav.stack.length);
    if (afterDepth !== 0) mismatches.push(`after returning to the spine the stack is ${afterDepth} deep, not empty`);
    seen = await readStage();
    if (seen.sequence !== 'spine') mismatches.push(`unwind: landed on ${seen.sequence}, not the spine`);
  } else {
    mismatches.push('the fixture proof has no nested branch, so nested-jump unwinding was not exercised');
  }

  // 6. Overlays and the blank screen.
  await press(KEYS.firstScene, { type: 'firstScene' }, 'Home');
  const beforeBlank = await readStage();
  await page.keyboard.press(KEYS.toggleBlank);
  steps++;
  const blanked = await readStage();
  if (!blanked.blank) mismatches.push("'b' did not blank the screen");
  await page.keyboard.press(KEYS.toggleBlank);
  steps++;
  const unblanked = await readStage();
  if (unblanked.blank) mismatches.push("'b' did not unblank the screen");
  if (unblanked.hash !== beforeBlank.hash) mismatches.push(`blanking moved the deck: ${beforeBlank.hash} → ${unblanked.hash}`);

  for (const [key, label] of [[KEYS.openJump, 'jump index'], [KEYS.toggleMap, 'branch map'], [KEYS.toggleContents, 'contents index']]) {
    const before = await readStage();
    await page.keyboard.press(key);
    steps++;
    const open = await readStage();
    if (!open.overlay) mismatches.push(`'${key}' did not open the ${label}`);
    await page.keyboard.press(KEYS.escape);
    steps++;
    const closed = await readStage();
    if (closed.overlay) mismatches.push(`Escape did not close the ${label}`);
    // The state hash includes which overlay is open, by design, so the deck
    // position is what has to be unchanged — not the digest.
    const position = (s) => `${s.sequence}/${s.scene}#${s.beat}`;
    if (position(closed) !== position(before)) {
      mismatches.push(`opening the ${label} moved the deck from ${position(before)} to ${position(closed)}`);
    }
  }

  // 7. The jump index by typing, which is the thing a presenter actually does.
  //    §11: "The presenter types three characters of 'approvals' and lands in
  //    the approval-chain branch in under a second."
  await page.keyboard.press(KEYS.openJump);
  steps++;
  await page.keyboard.type('appr');
  steps += 4;
  const typed = await page.evaluate(() => {
    const input = document.querySelector('[data-pp-jump-input], .pp-jump-input');
    const rows = document.querySelectorAll('.pp-overlay [data-pp-command="jump"], .pp-overlay [data-pp-payload]');
    return {
      value: input ? input.value : null,
      caret: input ? input.selectionStart : null,
      focused: !!input && document.activeElement === input,
      matches: rows.length,
      first: rows.length ? rows[0].getAttribute('data-pp-payload') : null,
    };
  });
  if (typed.value !== 'appr') {
    mismatches.push(
      `jump index: typing "appr" produced ${JSON.stringify(typed.value)} in the search field. `
      + `The caret sits at ${typed.caret} after every keystroke, so each character is inserted before the last — `
      + 'the overlay re-render is replacing the input without restoring its selection.',
    );
  }
  // The oracle for "which branch should win" is read off the proof, not off the
  // search: the branch whose objection or aliases actually say "approv". Testing
  // the ranking against `searchJump`'s own answer would only prove the search
  // agrees with itself, and matching the branch *id* against /appr/ only worked
  // because the hand-written fixture happened to name its branch `bn_approvals`.
  const approvals = branches.filter((b) => /approv/i.test(
    `${b.objection || ''} ${(b.aliases || []).join(' ')}`));
  if (typed.matches === 0) {
    mismatches.push(`jump index: typing "appr" matched nothing (field held ${JSON.stringify(typed.value)}). §11 requires three characters to rank the branch first.`);
  } else if (approvals.length === 0) {
    mismatches.push('the proof has no branch about approvals, so §11\'s named interaction was not exercised');
  } else if (typed.value === 'appr' && typed.first && !approvals.some((b) => b.id === String(typed.first))) {
    const wanted = approvals.map((b) => `${b.id} ("${b.objection}")`).join(', ');
    mismatches.push(`jump index: "appr" ranked ${typed.first} first; the approvals branch is ${wanted}`);
  }
  await page.keyboard.press(KEYS.escape);
  steps++;

  return { steps, mismatches, positions: positions.length };
}

// ---------------------------------------------------------------------------
// One browser run
// ---------------------------------------------------------------------------

/**
 * @param {any} chromium
 * @param {string} fileUrl
 * @param {object} options
 * @param {boolean} [options.dropDecompressionStream]
 * @param {any} deck
 * @param {any} navModule
 */
async function runOnce(chromium, fileUrl, options, deck, navModule) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--host-resolver-rules=MAP * ~NOTFOUND', '--disable-background-networking', '--no-sandbox'],
  });
  const context = await browser.newContext();
  await context.setOffline(true);

  /** @type {string[]} */
  const requests = [];
  /** @type {string[]} */
  const consoleErrors = [];
  /** @type {string[]} */
  const pageErrors = [];

  context.on('request', (request) => { requests.push(`${request.method()} ${request.url()}`); });
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (url === fileUrl) { await route.continue(); return; }
    await route.abort('blockedbyclient');
  });

  const page = await context.newPage();
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (error) => { pageErrors.push(String(error && error.message ? error.message : error)); });

  if (options.dropDecompressionStream) {
    await page.addInitScript(() => {
      try { delete window.DecompressionStream; } catch { /* older engines simply do not have it */ }
      Object.defineProperty(window, 'DecompressionStream', { get: () => undefined, configurable: true });
    });
  }

  await page.goto(fileUrl, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__PITCHPROOF__ && window.__PITCHPROOF__.ready === true, null, { timeout: 15_000 })
    .catch(async () => {
      const err = await page.evaluate(() => (document.documentElement.getAttribute('data-pp-boot-error') || 'the boot script never completed'));
      throw new Error(`the artifact did not boot: ${err}`);
    });

  const fcp = await page.evaluate(() => {
    const entry = performance.getEntriesByName('first-contentful-paint')[0]
      || performance.getEntriesByType('paint').find((e) => e.name === 'first-contentful-paint');
    return entry ? entry.startTime : null;
  });

  const walk = await keyboardWalk(page, deck, navModule);

  const usedFallback = await page.evaluate(() => typeof window.DecompressionStream);

  await context.close();
  await browser.close();

  return { requests, consoleErrors, pageErrors, fcp, walk, decompressionStream: usedFallback };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (error) {
    missingDependency(
      'Playwright is not resolvable from this repository.',
      'Link it once:  mkdir -p node_modules && G=$(npm root -g) && ln -sfn $G/playwright node_modules/playwright && ln -sfn $G/playwright-core node_modules/playwright-core\n'
      + '  Do not run `playwright install`; Chromium is preinstalled at PLAYWRIGHT_BROWSERS_PATH.',
    );
  }

  section('Building the artifact');
  const artifact = await buildArtifact();
  pass('emitted', `${artifact.bytes.toLocaleString('en-US')} bytes, model ${artifact.compression.mode}`);

  const navModule = await import('../src/runtime/nav.js');
  const dir = mkdtempSync(join(tmpdir(), 'pitchproof-verify-'));
  const file = join(dir, 'northwind.pitchproof.html');
  writeFileSync(file, artifact.html);
  const fileUrl = pathToFileURL(file).href;

  try {
    for (const variant of [
      { label: 'platform decompression', dropDecompressionStream: false },
      { label: 'fallback decode path (no DecompressionStream)', dropDecompressionStream: true },
    ]) {
      section(`Loading from file:// — ${variant.label}`);
      let run;
      try {
        run = await runOnce(chromium, fileUrl, variant, artifact.deck, navModule);
      } catch (error) {
        fail(`${variant.label}: the artifact did not load`, String(error && error.message ? error.message : error));
        continue;
      }

      const foreign = run.requests.filter((r) => !r.endsWith(fileUrl));
      if (foreign.length === 0) pass(`${variant.label}: zero network requests attempted`, `${run.requests.length} request(s), all of them the document itself`);
      else fail(`${variant.label}: the artifact attempted the network`, foreign.join('\n'));

      if (run.pageErrors.length === 0) pass(`${variant.label}: no page errors`);
      else fail(`${variant.label}: the artifact threw`, run.pageErrors.join('\n'));

      if (run.consoleErrors.length === 0) pass(`${variant.label}: no console errors`);
      else fail(`${variant.label}: console errors`, run.consoleErrors.join('\n'));

      if (run.fcp === null) fail(`${variant.label}: first contentful paint`, 'the browser reported no paint entry');
      else if (run.fcp <= FCP_BUDGET_MS) pass(`${variant.label}: first contentful paint`, `${run.fcp.toFixed(0)}ms against a ${FCP_BUDGET_MS}ms budget`);
      else fail(`${variant.label}: first contentful paint`, `${run.fcp.toFixed(0)}ms exceeds the ${FCP_BUDGET_MS}ms budget (§12)`);

      if (variant.dropDecompressionStream && run.decompressionStream !== 'undefined') {
        fail(`${variant.label}: the fallback path was not exercised`, `DecompressionStream was still ${run.decompressionStream}`);
      }

      if (run.walk.mismatches.length === 0) {
        pass(`${variant.label}: keyboard walk`, `${run.walk.steps} key presses over ${run.walk.positions} deck positions, no state corruption`);
      } else {
        fail(`${variant.label}: state corruption during the keyboard walk`, run.walk.mismatches.join('\n'));
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  section(failures === 0 ? 'verify-offline: clean' : `verify-offline: ${failures} failure(s)`);
  if (failures > 0) {
    for (const r of results.filter((x) => !x.ok)) process.stdout.write(`  - ${r.label}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`verify-offline: ${error && error.stack ? error.stack : error}\n`);
    process.exit(1);
  });
}
