# Integration notes

Facts the lanes reported that the integrator has to act on, and the state of
each. This is a working document for the integration pass, not a specification:
anything here that survives becomes a line in `API.md`, `DECISIONS.md` or
`CONTRACTS-DISPUTES.md`.

---

## Done

### The artifact composition root (from L9's report)

L9 reported that `dist/pitchproof-runtime.js` contained no `registerBranchOverlays`,
so `/`, `m` and `c` opened nothing in an emitted artifact. Investigating it
surfaced the larger version of the same gap: the bundle contained no **layouts**
either, so the first keypress replaced the scene with "Layout not registered".

Fixed by `src/artifact.js`, the composition root, now the entry
`scripts/build.mjs` bundles. See DECISIONS D19. Asserted by
`test/integration/artifact.test.mjs`.

### The return-stack defect (from L9's property test)

`exitedFrom` recorded one return frame where `nextSpineScene` unwinds the whole
stack. Fixed in `src/runtime/nav.js`; see DECISIONS D18. L9 has been asked to
remove its fence and its pinned failing test.

---

## Outstanding — sent back to the owning lane

| Lane | Finding | State |
|---|---|---|
| L7 | The §18.2 fabricated-fact guard fires on the SMS variant's own segment count, so `channel-variants` renders nothing at all. A segment count is a derived fact about the rendition, not an invented claim about the client. | Repro sent |
| L6 | Passing the page under analysis inside its own `siblings` list makes every block "repeat across pages" and condemns the whole specimen — 614 words to 30, silently. | Sent |
| L10 | A `MediaRef` whose `dataUri` is a network URL is correctly refused but dropped with **no finding**, so a hero image can vanish from a proof silently. §13 requires degradation to be reported. | Sent |

---

## To fold into `API.md` at integration

Lanes published surfaces beyond what API.md Part 3 declared. Extra exports are
legal; these are the ones other lanes or the integrator actually need, so they
have to be pinned rather than left informal.

| Lane | Export | Why it matters |
|---|---|---|
| L7 | `renderRecipe`, `renderAll`, `RECIPE_TEMPLATES` | This is how a caller actually gets renditions out of a recipe. L12 needs it. |
| L7 | `hasPromotionRecord`, `readPromotionRecord`, `PROMOTION_RECORD_RE` | L10 and L11 must be able to detect a `verified-by-user` claim with no promotion record. |
| L7 | `assertNoAdapterSecrets`, `assertNoFabricatedFacts` | §9 and §18.2 enforcement points the emitter calls. |
| L9 | `installBranchInputBridge`, `JumpController`, `branchGraph`, `nestingDepths`, `highlightRuns` | The input bridge is required for `/` to work; the composition root calls it. |
| L9 | `branchCoverage().details[]` with machine-readable `reasons` | L11 grades these into findings. |
| L6 | `buildSpecimen(capture, {…, siblings})` | `siblings` is not in the declared signature; the lane must state what it accepts. |
| L5 | `attachUserFont` | The only route to `embeddable: true`; §7 requires an explicit user rights assertion. |
| L5 | `sampleFromPng`, and the documented `classifyImagery` input shape `{width, height, data: RGBA, id?, role?, weight?}` | The studio has to decode images with the platform and hand pixels in. |
| L5 | `assertNoStudioVars` | Throws on any `--st-` name reaching artifact CSS (D11 made mechanical). |

---

## Severity guidance to pass to L11 (from L9)

`branchCoverage` reports more than the two declared buckets. L9's
recommendation, which I agree with and am relaying rather than having the two
lanes negotiate:

- `unanchored` → **severity 2**, not 1. The proof is presentable, just
  under-declared: the branch is still reachable from the jump index.
- `no-scenes` and `anchor-chain-never-reaches-spine` → structural, severity 1.
  A branch with no scenes cannot be shown, and an anchor chain that never
  reaches the spine is the §22.4 stranding case in the model rather than in the
  reducer.

---

## Facts the studio (L12) must respect

- **Colour confidence belongs to L4.** `buildBrandSystem` reports
  `confidence.colors` as 0 when `parts.confidence.colors` is absent — it never
  invents a number. The studio must pass L4's computed value through, or the
  brand panel will show every palette as unreviewed.
- **`classifyImagery` takes decoded pixels**, not an encoded image. The studio
  decodes with the platform; `sampleFromPng` covers PNG in-repo for tests.
- **No brand module reaches the artifact bundle.** The theme ships as compiled
  CSS text, so an artifact pays nothing for the PNG codec or the imagery
  classifier. Keep it that way: importing `src/brand/**` from the composition
  root would put both into every emitted file.
- **The adapter key never leaves the machine.** It lives in `ProjectStore`'s
  meta store, never in a project export and never in an artifact; the emitter
  asserts its absence.

---

## Test-suite state at the last full run

1170 tests, 1163 passing, 2 skipped, 5 failing. The failures are all inside
lanes that had not yet reported — three in L3's PDF importer (ASCII filters,
`DCTDecode` extraction, `startxref` repair) and one in L6's kind inference — and
are the owning lanes' to fix, not the integrator's.
