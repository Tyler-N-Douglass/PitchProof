# PitchProof — BUILD PLAN

Derived from `PITCHPROOF-BUILD-SPEC-v1.0.md`. The spec is authoritative; this
document records how the spec is decomposed, in what order it is integrated, and
how the six failure modes in §22 are defused.

Repo location: `Tyler-N-Douglass/PitchProof`, repo slug `pitchproof`. The
spec's `/src /test /scripts /dist` layout sits at the repository root.
Work happens on branch `claude/pitchproof-generator-pfla52`.

---

## 1. Module graph

Arrows point from dependency to dependent. Every cross-lane edge crosses a
frozen contract (§4) or an L1/L2 API frozen in `API.md`.

```
                       ┌──────────────────────────── L1 core ────────────────────────────┐
                       │ contracts.d.ts (frozen §4)  contracts.js (defaults + validator)  │
                       │ prng.js (PCG32 substreams)  hash.js (SHA-256/FNV/stable-json)    │
                       │ ids.js  bytes.js  result.js  events.js                           │
                       │ deflate.js / inflate.js (raw DEFLATE, pure, deterministic)       │
                       │ zip.js (OOXML reader)       storage.js (IndexedDB + memory)      │
                       │ command.js (undo/redo stack) vdom.js (VNode → HTML | DOM)        │
                       │ text-metrics.js (AFM tables, shaping, line-break, measurement)   │
                       └───────┬──────────┬──────────┬─────────┬─────────┬────────┬──────┘
                               │          │          │         │         │        │
        ┌──────────────────────┘          │          │         │         │        └────────────┐
        │                                 │          │         │         │                     │
   ┌────▼─────┐                    ┌──────▼────┐ ┌───▼─────┐ ┌─▼───────┐ │              ┌──────▼──────┐
   │ L2       │                    │ L3 ingest │ │ L4      │ │ L5      │ │              │ L10 emit    │
   │ runtime  │                    │ fetch/HAR │ │ brand:  │ │ brand:  │ │              │ inline      │
   │ skeleton │                    │ MHTML/    │ │ color   │ │ type    │ │              │ budget      │
   │          │                    │ OOXML/PDF │ │ OKLab   │ │ logo    │ │              │ compress    │
   │ host     │                    │ html-parse│ │ kmeans  │ │ shape   │ │              │ net-scan    │
   │ beats    │                    │ sitemap   │ │ roles   │ │ imagery │ │              │             │
   │ keymap   │                    └─────┬─────┘ │ derive  │ │ theme   │ │              └──────▲──────┘
   │ overlays │                          │       └───┬─────┘ └───┬─────┘ │                     │
   │ presenter│                          │           │           │       │                     │
   └────┬─────┘                    ┌─────▼─────┐     │           │       │                     │
        │                          │ L6        │     └─────┬─────┘       │                     │
        │                          │ specimen  │           │             │                     │
        │                          │ strip     │           │             │                     │
        │                          │ blocks    │           │             │                     │
        │                          │ media     │           │             │                     │
        │                          └─────┬─────┘           │             │                     │
        │                                │                 │             │                     │
        │                          ┌─────▼─────┐           │             │                     │
        │                          │ L7 recipe │           │             │                     │
        │                          │ library   │           │             │                     │
        │                          │ align     │           │             │                     │
        │                          │ adapter   │           │             │                     │
        │                          │ provenance│           │             │                     │
        │                          └─────┬─────┘           │             │                     │
        │                                │                 │             │                     │
   ┌────▼────────────────────────────────▼─────────────────▼──────┐      │                     │
   │ L8 scenes — 8 layouts, reveal system, motion budget           ├──────┴─────────────────────┤
   └────┬──────────────────────────────────────────────────────────┘                            │
        │                                                                                       │
   ┌────▼───────────────────────────────┐                                                       │
   │ L9 branches — graph, jump index,   ├───────────────────────────────────────────────────────┤
   │ fuzzy search, return stack, map    │                                                       │
   └────┬───────────────────────────────┘                                                       │
        │                                                                                       │
   ┌────▼───────────────────────────────────────────────────────────────────────────────────────▼──┐
   │ L11 validate — rules engine, all 14 finding codes, overflow measurement, auto-fix, dry-run     │
   └────┬───────────────────────────────────────────────────────────────────────────────────────────┘
        │
   ┌────▼───────────────────────────────────────────────────────────────────────────────────────────┐
   │ L12 studio UI — shell, rail, canvas, inspector, undo/redo wiring, storage pressure, settings   │
   └────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Three build outputs (`scripts/build.mjs`, zero npm dependencies, deterministic):

| Output | Contents |
|---|---|
| `dist/pitchproof-runtime.js` | L2 + L8 + L9 + brand theme compile, bundled. Never shipped alone. |
| `dist/pitchproof-studio.html` | Everything, inline. Embeds the runtime bundle as a string constant for the emitter. |
| `*.pitchproof.html` | Emitted by the studio at runtime. |

### Cross-cutting engineering laws

1. **Determinism.** `Math.random` and `Date.now` are banned inside `src/` except
   in three quarantined places (`storage.js` timestamps for autosave metadata,
   `ingest` `capturedAt`, `ui` clock display), all of which are injected through
   an explicit `clock` parameter so tests pin them. A lint test greps `src/` and
   fails on any other occurrence. Ids come from PCG32 named substreams or from
   content hashes (`hash.js`).
2. **DOM-free core.** Layouts and the runtime host produce **VNode trees**
   (`vdom.js`), not DOM. `toDom()` mounts in a browser; `toHtml()` serializes for
   the emitter and for Node tests. This makes every layout, every reveal, and the
   whole automated sweep testable under `node --test` with no browser, and gives
   the emitter a static first-paint snapshot for the cold-boot budget.
3. **Two theming systems, never one.** Studio CSS variables are `--st-*`;
   artifact CSS variables are `--pp-*`. `test/ui/theme-isolation.test.mjs` asserts
   the two namespaces are disjoint and that neither file references the other's
   prefix.
4. **Text measurement is a first-class, deterministic service.** `text-metrics.js`
   carries published AFM advance-width tables (Helvetica/Arial, Helvetica-Bold,
   Times-Roman, Times-Bold, Courier) plus documented per-family scale models for
   the rest, and implements greedy line breaking. Overflow detection, type-metric
   deltas and fallback selection all read from it, so the highest-value check in
   the tool (§22.2) runs identically in Node, in the studio, and in CI.

---

## 2. Lane assignment

| Lane | Owns (exclusive write scope) | Golden tests it must land (§17) |
|---|---|---|
| **L1 Core** | `src/core/**`, `scripts/build.mjs`, `test/core/**` | 6 determinism (id + hash + PRNG), DEFLATE round-trip vs `zlib`, contract-freeze test |
| **L2 Runtime** | `src/runtime/**`, `test/runtime/**` | 9 beat reversibility (state hash), keyboard model, overlay focus |
| **L3 Ingest** | `src/ingest/**`, `test/ingest/**`, `test/fixtures/ingest/**` | HTML parser conformance, HAR/MHTML/saved-page, ZIP/OOXML, PDF text |
| **L4 Brand colour** | `src/brand/color.js`, `oklab.js`, `cluster.js`, `roles.js`, `derive.js`, `confidence.js`, `test/brand/color*` | 1 colour science vs published reference values, 2 contrast solving vs hostile palettes |
| **L5 Brand type/logo/shape** | `src/brand/type.js`, `logo.js`, `shape.js`, `imagery.js`, `theme.js`, `test/brand/type*` | 3 type metrics vs known font pairs |
| **L6 Specimen** | `src/specimen/**`, `test/specimen/**`, `test/fixtures/specimen/**` | 5 chrome stripping, block-level F1 ≥ 0.9 on hand-labelled fixtures |
| **L7 Recipes** | `src/recipe/**`, `test/recipe/**` | provenance stamping invariants, all 8 seed recipes, channel budget enforcement |
| **L8 Scenes** | `src/scene/**`, `test/scene/**` | layout purity, reveal additivity, motion budget ≤240ms, reduced-motion |
| **L9 Branches** | `src/branch/**`, `test/branch/**` | 8 return-stack property test (random walks terminate on spine) |
| **L10 Emitter** | `src/emit/**`, `test/emit/**`, `scripts/verify-offline.mjs` | 6 byte-identical re-emit, 10 size budgeting monotonicity, planted network-reference corpus |
| **L11 Validate** | `src/validate/**`, `test/validate/**`, `test/fixtures/overflow/**` | 4 overflow recall ≥ 0.98 on planted corpus, contrast severity, provenance blocking |
| **L12 Studio UI** | `src/ui/**`, `test/ui/**` | theme isolation, undo/redo across all mutations, keyboard reachability |

Rules for every lane: exclusive directory ownership; no stubs or `TODO`; own
tests; cross-lane communication only through §4 contracts and `API.md`; contract
objections go to `CONTRACTS-DISPUTES.md` and the lane builds against the contract
as written anyway; unsettled judgment calls go to `DECISIONS.md`.

---

## 3. Integration order

1. **L1 Core** — lands alone. Freezes `API.md`. Gate: `node --test test/core`
   green, `scripts/build.mjs` produces a byte-identical bundle twice.
2. **L2 Runtime skeleton** — lands alone on top of L1. Freezes the host/beat/
   keymap/overlay/layout-registry API in `API.md`. Gate: beat reversibility and
   keyboard tests green.
3. **Fan-out** — L3, L4, L5, L6, L7, L8, L9, L10, L11 in parallel, each against
   the frozen surfaces. L6 consumes L3's HTML parser, L7 consumes L6's blocks,
   L8 consumes L4/L5 theme output, L9 consumes L8 scenes, L10/L11 consume L8/L9
   — all through contracts, so they build concurrently against fixtures rather
   than waiting on each other's implementations.
4. **Integration pass A** — wire the lanes together into `scripts/build.mjs`,
   run the full suite plus `scripts/verify-offline.mjs`.
5. **L12 Studio UI** — integrates last, wiring everything already built.
6. **Critic loop (§21)** — full suite + verify-offline + adversarial critic
   across all eleven §20 axes. Fix every severity-1 and every failed axis. Repeat
   until the critic passes clean twice consecutively, the second pass against a
   freshly emitted artifact.

---

## 4. The six things most likely to be wrong (§22) and the mitigation for each

### 4.1 Contrast role solving
**Failure mode.** Naive palette swapping yields unreadable proofs on real brands;
a near-white primary with white text ships and the pitch looks broken.

**Mitigation.** Role assignment is a constrained optimisation, not a heuristic
chain. The solver enumerates candidate assignments over the cluster set and
scores them with an explicit cost function (contrast against intended pairing,
chroma appropriateness per role, lightness ordering across surface roles, hue
separation between primary and accent, area-weight preference). Contrast is
computed with exact WCAG 2.1 relative luminance — never approximated from
OKLab L. Any `onX` role that cannot reach 4.5:1 from the extracted set is
**derived**: walk L in OKLCH holding H, clamping C into the sRGB gamut by
binary search, until the contrast constraint is met with margin, and stamp
`source:'derived'`. A hard post-condition rejects any solution where an `onX`
role is below 4.5:1 — the solver cannot return a palette that fails.
**Proof.** `test/brand/color-reference.test.mjs` pins sRGB↔OKLab↔OKLCH against
published reference values at 1e-6 and WCAG ratios against the W3C worked
examples; `test/brand/contrast-solve.test.mjs` runs an adversarial corpus
(near-white primary, neon accent, monochrome, single-hue, ultra-dark,
low-chroma-grey, two-colour) and asserts every `onX` in every solved palette
meets 4.5:1 and every derived colour is in gamut.

### 4.2 Text overflow after font substitution
**Failure mode.** The brand's face is unavailable, a fallback with wider metrics
substitutes in, a headline silently overflows its container, and nobody sees it
until it is on the client's projector.

**Mitigation.** Measurement is post-substitution by construction: the overflow
detector takes the *resolved* face (the fallback that will actually render, with
its `metricDelta` applied), never the requested family. It runs on every text
node of every beat of every scene at all three breakpoints (`sm 390`, `md 1024`,
`lg 1600`), using the shared deterministic measurement service — the same code
path in Node, the studio and CI, so a check that passes in rehearsal cannot fail
in the artifact. Detection covers both axes: single-line width overflow for
no-wrap contexts and wrapped line-count × line-height against container height,
plus a clamp-aware path for `-webkit-line-clamp`.
**Proof.** `test/validate/overflow-corpus.test.mjs` runs a planted-defect corpus
whose ground truth is computed by an independent oracle in the test file (not by
importing the detector), with comfortable margins on both sides, and asserts
recall ≥ 0.98 for severity-1 overflow plus a reported precision floor. A
browser cross-check asserts the deterministic engine agrees with real Chromium
measurement within tolerance for the fonts actually installed.

### 4.3 Chrome stripping on real sites
**Failure mode.** Under-stripping leaves cookie banners, mega-nav and
personalization shells inside every specimen, poisoning everything downstream.

**Mitigation.** Four independent signals, combined with a scored classifier
rather than a single rule: (a) landmark roles and semantic elements
(`nav/header/footer/aside`, `role=navigation|banner|contentinfo|search|dialog`),
(b) link-density ratio per block (link text chars ÷ total text chars, with a
short-text guard), (c) boilerplate lexicon and structural signatures for cookie/
consent/subscribe/personalization shells, (d) repeated-across-pages detection —
when two or more pages from the same site are present, blocks whose normalized
text or DOM path repeats across pages are chrome by definition. A main-content
locator (`<main>`, `article`, text-density peak) sets the extraction root.
Everything is reversible: each stripped block is retained with its reason, and
the studio can restore it.
**Proof.** `test/specimen/chrome-strip.test.mjs` scores block-level precision/
recall/F1 against hand-labelled hostile fixtures and asserts F1 ≥ 0.9.

### 4.4 The return stack
**Failure mode.** A nested jump does not unwind and the presenter is stranded
off-spine mid-pitch.

**Mitigation.** Navigation is a pure reducer over an explicit machine state
`{ sequence, sceneIndex, beatIndex, stack[] }`; every jump pushes a frame
recording the exact `(sequence, sceneIndex, beatIndex, returnPolicy)` it left,
and every branch exit pops exactly one frame. `r` (return-to-spine) unwinds the
whole stack in one step rather than popping once. The reducer has a hard
invariant checked on every transition: the stack depth never goes negative, a
frame is never popped by anything but a return, and when the stack is empty the
active sequence *is* the spine. Validation raises `BRANCH_UNREACHABLE` and
`BRANCH_NO_RETURN` before emit.
**Proof.** `test/branch/return-stack.property.test.mjs` runs seeded random walks
(1000 walks × 200 steps over a generated graph with nested branches) asserting
every walk terminates on the spine, the stack is empty whenever the sequence is
the spine, and no state is ever an orphan.

### 4.5 Size budget vs cold-boot
**Failure mode.** A 60 MB artifact that takes eleven seconds to open.

**Mitigation.** Split payload: media stays as plain base64 data URIs (already
compressed formats; a second compression pass costs time and saves nothing),
while the model JSON is raw-DEFLATE compressed and inflated at boot via
`DecompressionStream` with a stored-block fallback — and the emitter keeps
whichever of compressed/raw is actually smaller. First paint does not wait on any
of it: the emitter pre-renders scene 0 (at its first beat) as static HTML into
the document so the artifact paints before a line of JavaScript runs, then
hydrates. Budgeting is a greedy allocator over an explicit importance rank
(spine before branch, early-revealed before late-revealed, logo/hero before
incidental) that progressively downscales and recompresses, and reports every
degradation as a line item with predicted and actual bytes.
**Proof.** `test/emit/budget.test.mjs` asserts degradation is monotonic in
importance rank and that reported savings equal actual byte deltas exactly;
`scripts/verify-offline.mjs` measures first-contentful-paint from `file://` in
headless Chromium with the network blocked and fails above 1.5 s.

### 4.6 Provenance leakage
**Failure mode.** A proof implies generated sample content is the client's
approved copy. This is the only reputational risk in the product.

**Mitigation.** Enforcement lives in the emit path, not the UI. `assertProvenance()`
runs inside `emit()` before serialization: every rendition whose provenance is
not `client-supplied` or `verified-by-user` must carry a label node in the
rendered scene HTML, the label must survive the emitted CSS (computed contrast
≥ 4.5:1 against its own background and font-size ≥ 11px, both checked against
the *final* stylesheet, including any user CSS), and `labelIllustrativeContent`
is forced true for any build whose mode includes `review`. Failure is
`PROVENANCE_UNLABELED`, severity 1, no override flag anywhere in the codebase.
Adapter-produced renditions are stamped `illustrative` at creation and can only
become `verified-by-user` through an explicit user promotion that records who
promoted it and when.
**Proof.** `test/emit/provenance.test.mjs` attempts four attacks — omit the
label, set `labelIllustrativeContent:false` on a review build, style the label
to `opacity:0`/`display:none`/1px, and promote provenance without a promotion
record — and asserts all four are blocked at the emitter with severity 1.

---

## 5. Verification gates run after every integration

```
node --test test/                     # full suite
node scripts/build.mjs                # deterministic bundle
node scripts/build.mjs --verify-repeat # byte-identical rebuild
node scripts/verify-offline.mjs       # headless, network blocked, keyboard walk, FCP budget
node scripts/lint-determinism.mjs     # no Math.random / Date.now outside quarantine
```
