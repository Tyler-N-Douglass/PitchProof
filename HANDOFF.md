# HANDOFF

Everything a fresh session needs to pick up the PitchProof build cold. Read this,
then `PITCHPROOF-BUILD-SPEC-v1.0.md` (authoritative), then `PLAN.md`,
`API.md` and `DECISIONS.md`.

**Repo:** `Tyler-N-Douglass/PitchProof` · **Branch:** `claude/pitchproof-generator-pfla52`

---

## 1. State of the build

### Landed and green

**L1 Core** — `src/core/`

| File | What it is | Verification |
|---|---|---|
| `contracts.d.ts` | The §4 interfaces, byte-for-byte from the spec, inside `FROZEN REGION` markers | Diffed against `test/fixtures/frozen-contracts.txt`, which is itself diffed against the spec |
| `contracts.js` | Closed enumerations, `ROLE_PAIR`, emit-option normalisation, shape validators | `labelIllustrativeContent` forced true for review-reachable builds |
| `prng.js` | PCG32 XSH-RR, named substreams, `SeedBook` | Canonical vectors for seed 42 / stream 54 |
| `hash.js` | Synchronous pure SHA-256, `stableStringify`, `contentHash`, FNV-1a | All four NIST vectors, plus every block-boundary length against `node:crypto` |
| `deflate.js` / `inflate.js` | Raw DEFLATE with package-merge Huffman | Round-trips both ways against `zlib`; within 5% of level 9, ahead on large JSON |
| `text-metrics.js` | Published Core-14 AFM tables, family scale models, greedy line breaking, metric-compatible fallback selection | Advance widths and vertical metrics against the published AFM values |
| `zip.js` | ZIP + ZIP64 central directory, CRC-verified extraction, OOXML parts and relationships | Real archives built in-test |
| `storage.js` | IndexedDB + memory fallback, versioned envelope with a migration walker, autosave that skips no-ops, 80% pressure warning | Failure paths asserted, never swallowed |
| `command.js` | Undo/redo with coalescing and atomic transactions | §15 |
| `vdom.js`, `bytes.js`, `ids.js`, `events.js`, `result.js` | The substrate | — |

**L2 Runtime** — `src/runtime/`: `deck.js`, `nav.js` (pure reducer + return stack
with invariants), `beats.js`, `keymap.js`, `overlays.js`, `layouts.js` (registry),
`runtime.js` (document-free state machine), `host.js` (DOM binding, hydrates the
pre-rendered first paint), `presenter.js` (second window, manual stopwatch),
`index.js` (`boot`), `runtime.css` (`--pp-*` only).

**Build path** — `scripts/lib/bundler.mjs` (deterministic zero-dependency ESM
bundler), `scripts/build.mjs` (three outputs, `--verify-repeat`),
`scripts/lint-determinism.mjs`.

### In flight

L3–L11 are being written in parallel as subagent lanes, each owning one
directory and building against `API.md`. L12 Studio UI integrates last.

### Documents

`PLAN.md`, `API.md` (the frozen integration surface — **read this before writing
any lane code**), `DECISIONS.md` (D1–D17), `CONTRACTS-DISPUTES.md`, `DEFERRED.md`.
Lane-local decisions and disputes land in `docs/decisions/L<n>-*.md` and
`docs/disputes/L<n>-*.md` and are merged into the top-level documents at
integration.

---

## 2. Order of work

1. ~~Finish L1 Core.~~ Done.
2. ~~Land L2 Runtime skeleton and freeze `API.md`.~~ Done.
3. Fan out L3–L11 in parallel, one lane each. **In flight.**
4. Integration pass A — wire the lanes together, full suite plus
   `scripts/verify-offline.mjs`.
5. L12 Studio UI integrates last.
6. Critic loop per §21 until clean on all eleven §20 axes twice consecutively,
   the second pass against a freshly emitted artifact.

---

## 3. Verification gates

```
node scripts/lint-determinism.mjs       # no unseeded randomness or clock reads in src/
npm test                                # node --test over test/**/*.test.mjs
node scripts/build.mjs --verify-repeat  # two builds, byte-identical
node scripts/verify-offline.mjs         # headless, network blocked, keyboard walk, FCP budget
```

---

## 4. Environment notes

- Node 22. Zero npm dependencies in `src/`; Playwright is the only dev
  dependency, used by `verify-offline.mjs` and the browser cross-checks.
- Chromium is preinstalled at `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` and
  Playwright is linked into `node_modules`. **Do not run `playwright install`.**
  If the link is missing, restore it with:
  `mkdir -p node_modules && G=$(npm root -g) && ln -sfn $G/playwright node_modules/playwright && ln -sfn $G/playwright-core node_modules/playwright-core`
- The container is ephemeral. Commit and push as each lane lands.
