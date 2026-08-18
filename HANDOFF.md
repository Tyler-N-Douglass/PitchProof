# HANDOFF

Everything a fresh session needs to pick up the PitchProof build cold. Read this,
then `PITCHPROOF-BUILD-SPEC-v1.0.md` (authoritative), then `PLAN.md` and
`DECISIONS.md`.

**Repo:** `Tyler-N-Douglass/PitchProof` · **Branch:** `claude/pitchproof-generator-pfla52`

---

## 1. State of the build

### Landed — L1 Core (partial), all verified against reference values

| File | What it is | Verification |
|---|---|---|
| `src/core/contracts.d.ts` | The §4 interfaces, extracted byte-for-byte from the spec, inside `FROZEN REGION BEGIN/END` markers | Diffed against `test/fixtures/frozen-contracts.txt` |
| `src/core/contracts.js` | Closed enumerations, the `ROLE_PAIR` table, emit-option normalisation, shape validator | `labelIllustrativeContent` forced true for review-reachable builds |
| `src/core/prng.js` | PCG32 XSH-RR, named substreams, `SeedBook` | Matches canonical vectors for seed 42 / stream 54: `a15c02b7 7b47f409 ba1d3330 83d2f293 bfa4784b cbed606e` |
| `src/core/hash.js` | Synchronous pure SHA-256, `stableStringify`, `contentHash` | Matches all four NIST vectors incl. the million-`a` case |
| `src/core/deflate.js` | Raw DEFLATE, LZ77 + package-merge length-limited Huffman | Round-trips through `zlib.inflateRawSync`; beats zlib level 9 on JSON (1389 v 1450) and base64 (1272 v 1275) |
| `src/core/inflate.js` | Raw INFLATE | Decodes `zlib` output at levels 0/1/6/9 |
| `src/core/vdom.js` | `h()` / `raw()` / `toHtml()` / `toDom()` / `walk()` — the VNode substrate | — |
| `src/core/bytes.js` | UTF-8, base64, hex, `parseDataUri` | — |
| `src/core/ids.js` | `contentId()`, `IdMinter`, `elementId` | — |
| `src/core/events.js`, `result.js` | Emitter, Result type | — |

Documents in place: `PLAN.md`, `DECISIONS.md` (13 entries), `CONTRACTS-DISPUTES.md`
(open, empty), `DEFERRED.md` (open, empty).

### Not yet built

**Rest of L1:** `storage.js` (IndexedDB + memory fallback, versioned schema,
migration path from `schemaVersion: 1`), `command.js` (undo/redo stack),
`text-metrics.js` (published AFM advance tables + greedy line breaking +
metric-compatible fallback selection — see DECISIONS D7), `zip.js` (OOXML reader
on `inflate.js`), `scripts/build.mjs` (deterministic bundler),
`scripts/lint-determinism.mjs`, and the L1 test suite.

**Everything else:** L2 through L12, and the §20 critic loop. No lane has been
fanned out. No subagents are running.

---

## 2. Order of work

1. Finish L1 Core. Gate: `node --test test/` green; `node scripts/build.mjs`
   produces a byte-identical bundle twice.
2. Land L2 Runtime skeleton — scene host, beat engine, keyboard model, overlay
   system, presenter view. Write the frozen L1+L2 public API into `API.md`; that
   document is the integration surface every other lane builds against.
3. Only then fan out L3–L11 in parallel as subagents, one lane each.
4. L12 Studio UI integrates last.
5. Critic loop per §21 until clean on all eleven §20 axes twice consecutively,
   the second pass against a freshly emitted artifact.

---

## 3. Environment notes

Node 22. No `node_modules` is committed. Playwright is used **only** by
`scripts/verify-offline.mjs` and the browser cross-check tests — never by the
studio, the runtime, or the artifact.

Chromium is preinstalled (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`) and
Playwright is installed globally, but ESM will not resolve it through `NODE_PATH`.
Link it once:

```bash
mkdir -p node_modules && G=$(npm root -g) \
  && ln -sfn $G/playwright node_modules/playwright \
  && ln -sfn $G/playwright-core node_modules/playwright-core
```

Do **not** run `playwright install`.

Commit signing occasionally returns a transient 503 — retry the commit.

---

## 4. The laws that are not negotiable

- **Zero network in the emitted artifact.** No telemetry, beacons, tracking,
  runtime font fetches, or CDN. The emitter scans and blocks; CI proves it with
  network blocked in a headless browser.
- **No backend, no accounts, no cloud.** Browser and local storage only.
- **Determinism.** Seeded PRNG or content hashes only. Two emits of one project
  are byte-identical, and a test asserts it.
- **Provenance enforced at the emitter**, not the UI. Illustrative content is
  labeled; the label cannot be hidden.
- **Severity-1 findings block emit. There is no override flag.**
- **Studio palette and artifact brand theming never share a variable**
  (`--st-*` vs `--pp-*`, asserted by test).

Golden tests that may not be weakened to make a build pass: colour science against
published reference values, and the planted-defect corpora for overflow detection
and chrome stripping. If a test is hard to satisfy, fix the implementation.

---

## 5. Copy-paste prompt for a fresh thread

The prompt used to seed a continuation session is reproduced verbatim below.

> You are building **PitchProof** to the specification in
> `PITCHPROOF-BUILD-SPEC-v1.0.md`, committed at the root of this repo. Read that
> spec completely before doing anything else. It is authoritative. Where this
> prompt and the spec disagree, the spec wins.
>
> Read `HANDOFF.md` for the state of the build, then `PLAN.md` (module graph, lane
> assignment, integration order, the six §22 risks and their mitigations) and
> `DECISIONS.md` (thirteen judgment calls already made — append, do not reverse
> without recording why).
>
> Continue from where `HANDOFF.md` says the build stands: finish L1 Core, land L2
> Runtime skeleton and freeze the L1+L2 API into `API.md`, then fan out L3–L11 in
> parallel as subagents, then integrate L12 Studio UI last, then run the §20 critic
> loop until it passes clean on all eleven axes twice consecutively with the second
> pass against a freshly emitted artifact.
>
> Each subagent owns exactly one lane directory and edits nothing outside it;
> implements every behavior in its lane fully — no stubs, no `TODO`, no "left as an
> exercise"; writes its own tests including the golden tests named for its lane in
> §17; communicates across lanes only through the frozen contracts in §4 and
> `API.md`; files any contract objection in `CONTRACTS-DISPUTES.md` and then builds
> against the contract as written anyway; and records every judgment call the spec
> didn't settle in `DECISIONS.md`. A lane that finishes early claims the next
> unclaimed lane. No lane expands its own scope.
>
> Honour the non-negotiables in `HANDOFF.md` §4 without exception. Run the full
> suite plus `scripts/verify-offline.mjs` after every integration.
>
> Commit and push to `claude/pitchproof-generator-pfla52` as each lane lands — the
> container is ephemeral and unpushed work is lost. Do not open a pull request
> unless asked. Apply maximum effort; think each lane through thoroughly before
> writing its files. The target is a complete, working product that could be used
> in a real client pitch the day it finishes, not a scaffold. Execute autonomously;
> at any decision point the spec does not settle, build the stronger option and
> record it in `DECISIONS.md` rather than pausing.
