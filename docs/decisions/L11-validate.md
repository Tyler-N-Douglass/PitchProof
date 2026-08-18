# L11 Validate — lane decisions

Every judgment call the spec did not settle, per §23. Format follows
`DECISIONS.md`. Nothing here overrides `PITCHPROOF-BUILD-SPEC-v1.0.md`.

---

## L11-D1 — The overflow severity threshold is 2% of the container, and the number is measured

**Unsettled by:** §14 requires `TEXT_OVERFLOW` and §22.2 makes it the most
important check in the tool, but neither says how much overflow blocks an emit.
The lane brief asks for "body text that overflows its container enough to be
visibly clipped" at severity 1 and "marginal overflow within a documented
tolerance" at severity 2, with the threshold defined and justified.

**Decision.** Three bands, on both axes, against the container extent along that
axis (`src/validate/overflow.js`):

| excess | severity | constant |
|---|---|---|
| ≤ max(0.5px, **0.5%** of the container) | no finding | `OVERFLOW_NOISE_RATIO`, `OVERFLOW_NOISE_PX` |
| above that, ≤ max(2px, **2%** of the container) | 2 — warn | `OVERFLOW_CLIP_RATIO`, `OVERFLOW_CLIP_MIN_PX` |
| above **2%** | 1 — blocks emit | `OVERFLOW_CLIP_RATIO` |

**Why 2%.** The threshold is set against a measured quantity rather than taste.
`test/validate/overflow-browser.test.mjs` lays the planted corpus out in real
headless Chromium and reports the residual between this engine and the
rasteriser. On this machine, for the families that are actually installed:

```
installed / Latin   n=67  mean 0.158%  p95 0.890%  max 1.184%  bias -0.016%
installed / CJK     n= 6  mean 0.514%  p95 3.084%  max 3.084%  bias -0.514%
line-count agreement on present families: 73/73
```

The Latin residual is asserted at ≤ 1.5% worst-case and ≤ 0.5% mean, and a
further assertion requires that tolerance to sit **at or below** the severity-1
threshold. That relationship is the entire argument: if the engine and the
browser agree to better than 2%, then an excess larger than 2% cannot be
explained by measurement disagreement, and a severity-1 finding is a statement
about the text rather than about the model. Inside the band the two can
legitimately disagree, so the finding warns and does not block.

The noise floor exists for the same reason from the other side. §14 calls
overflow detection the highest-value check in the tool; a check that fires where
no browser can reproduce it is a check the seller turns off, and a check that is
off has no value at all.

**The honest limit.** CJK is the weak case: the engine models every wide
codepoint as exactly one em, and the CJK face a machine actually has is close to
but not exactly that — 3.08% on this machine, and the bias is **negative**, so
the engine *under*-reports CJK width. A CJK overflow between 2% and 5% could
therefore be missed. That direction is the safe one (it costs recall, not
precision), and real CJK overflow is not marginal: translated East Asian copy
routinely runs 20–40% wider or narrower than its English source, which is far
outside the band. The browser test asserts CJK separately at a stated 4%
tolerance rather than folding it into the Latin number and hiding it.

---

## L11-D2 — Severity for each of the fourteen codes

**Unsettled by:** §4 fixes three severities (`FIXED_SEVERITY`) and §14 fixes
`CONTRAST_FAIL` for sub-4.5:1 body text. The other ten are the lane's call, and
the call matters: severity 1 blocks emit and there is no override.

**Decision.** `src/validate/severity.js` declares all fourteen in one table, with
the reasoning inline. The blocking set is:

`ASSET_MISSING`, `BRANCH_NO_RETURN`, `CONTRAST_FAIL`, `DUPLICATE_SCENE`,
`NETWORK_REFERENCE`, `PROVENANCE_UNLABELED`, `SIZE_BUDGET_EXCEEDED`,
`SPECIMEN_EMPTY`, `TEXT_OVERFLOW`.

The line drawn throughout is **does this defect break the meeting, or cost the
seller preparation?** A broken image, unreadable text, a stranded presenter,
content the client cannot see, a claim the tool cannot support and a network
call all break the meeting. A substituted typeface, an oversize asset, a dead
keypress and a branch nobody can reach cost preparation; they warn.

`severityOf(code)` reports the **worst** a code can be, so a caller asking "does
this block emit?" gets the honest answer. Six codes narrow to severity 2 inside
a documented band (`NARROWABLE`), and `resolveSeverity` throws on any other
combination — including any attempt to change a `FIXED_SEVERITY` code in either
direction. A rule cannot quietly soften a finding, because the function that
would have to allow it refuses.

---

## L11-D3 — `BRANCH_UNREACHABLE` warns; `BRANCH_NO_RETURN` blocks, but only for the causes that strand

**Unsettled by:** §11 lists the two coverage failures together without grading
them.

**Decision.** They are not equally serious.

- **`BRANCH_UNREACHABLE` — severity 2.** A branch with no anchor and no
  jump-index entry is content that never shows. It costs the seller the
  preparation, but the deck presents correctly and nobody is stranded.
- **`BRANCH_NO_RETURN` — severity 1, except for `unanchored`.** L9 publishes
  *why* a return does not resolve (`branchCoverage().details[].reasons`), and
  the causes differ. `no-scenes`, `nothing-to-return-from`, `empty-spine` and
  `anchor-chain-never-reaches-spine` leave a presenter with nowhere to go, which
  is §22.4's failure exactly. A branch that is merely **unanchored** is still
  reachable from the jump index and still returns to the position the jump was
  made from, so nothing is stranded — what is missing is the declaration, not
  the way back. That narrows to severity 2.

**Provenance of the split.** L9 proposed it and the integrator relayed it during
the parallel build (`unanchored` at 2, structural causes at 1). L11 agrees and
implemented it, and `BRANCH_NO_RETURN` was added to `NARROWABLE` with a floor of
2 to make it expressible. `test/validate/branch.test.mjs` pins both directions.

---

## L11-D4 — An auto-fix declares what it does: `resolves`, `plan`, or `mitigates`

**Unsettled by:** §14 says "auto-fix where safe and reversible" and names four
fixes, one of which — "downscale an asset" — cannot be done by a pure function
over a `Proof`.

**Decision.** Every entry `autoFixes()` returns carries an `effect`:

- **`resolves`** — re-running preflight no longer reports the finding. Seven of
  the nine fixes.
- **`plan`** — the edit instructs the emitter, and the finding clears when the
  emitter acts on it. `ASSET_OVERSIZE` and `SIZE_BUDGET_EXCEEDED` step the
  project's `imageQuality` down; resampling pixels needs an image codec, which
  belongs to L10's `budgetAssets` and to the studio's canvas.
- **`mitigates`** — the finding stands because it is true, and the fix reduces
  its consequence. `FONT_UNAVAILABLE` is the only one: a brand face that cannot
  be embedded stays unembeddable, and what the fix changes is *which* face
  renders in its place — the metric-closest one available rather than whatever
  the machine happens to default to, which is the difference between a
  substitution nobody notices and §22.2's overflow. Its post-condition is that
  the fix is no longer offered afterwards.

**Why not just claim they all resolve.** Because §18.9 asks for degradation
honesty, and a fix panel that says "fixed" when the bytes have not moved is the
same class of dishonesty applied to a smaller thing.

**Five codes have no fix, deliberately**: `TEXT_OVERFLOW` (rewriting a seller's
headline before a pitch is editorial), `NETWORK_REFERENCE` (the only fix is to
remove content the user put there, and §1.1 is a law rather than a nuisance),
`STALE_CAPTURE` and `SPECIMEN_EMPTY` (only re-capturing fixes them), and
`DUPLICATE_SCENE` (which copy to keep is a decision about the narrative).
`test/validate/autofix.test.mjs` asserts the three sets partition the fourteen
codes, so quietly adding or removing a fix fails the suite.

---

## L11-D5 — Auto-fixes are pure data, and purity *is* the reversibility

**Unsettled by:** §14 requires every auto-fix to be "logged and undoable".

**Decision.** A fix is `{finding, label, effect, apply: (proof) => Proof}`.
`apply` deep-copies, edits the copy and returns it; the proof handed in is never
touched. `autoFixCommand(proof, fix)` wraps it as a `CommandStack` command with
`scope: 'proof'` and `meta.autoFix: true`, so the studio's history shows which
entries the tool made and `undo()` unwinds them like any hand edit.

**Why.** Reversibility implemented as a separate `revert()` path is code that can
rot, and a rot no test notices until the day someone needs it. Purity makes the
revert state the object the caller already has, so apply-then-revert is not a
code path at all — it is the absence of one, and the test asserts it by
comparing the input proof before and after, for every fix on every finding.

**Composition is iterative, and the test says so.** Fixing a palette changes what
the next pair has to clear, so applying a list of fixes computed against the
*original* proof is not the whole answer. `test/validate/autofix.test.mjs` drives
to a fixpoint — fix, re-run, repeat — and asserts convergence, which is what a
studio does and what a single pass would have quietly got wrong.

---

## L11-D6 — Cross-lane surfaces reach L11 through one-line bridge modules

**Unsettled by:** `API.md` declares what L11 may call, but L11 was written in
parallel with L4, L8, L9 and L10, none of which existed when it started.

**Decision.** `src/validate/lane-brand.js`, `lane-scene.js`, `lane-branch.js` and
`lane-emit.js` are one-line re-exports of the declared surfaces. Every consumer
inside L11 imports from the bridge, and every call site also accepts the function
through `deps`, so a test can drive one rule without standing up a lane. During
the parallel build the bridges pointed at `src/validate/standin/`, which
implemented each declared surface to its `API.md` description; **all four now
point at the owning lanes, and the stand-in directory is deleted.**

**Why.** Switching a lane in was one line rather than a rewrite, tests kept
running while lanes were in flight, and the `deps` seam that made that possible
is the same seam the integrator uses.

---

## L11-D7 — `hasPromotionRecord` is L11's, not imported from L7

**Unsettled by:** §9 makes `promoteProvenance` the only route to
`verified-by-user` and says it records who and when. `API.md` does not declare a
reader for that record on L7's surface, and `API.md` rule 1 says a lane imports
only declared surfaces.

**Decision.** `src/validate/provenance.js` implements `hasPromotionRecord`
liberally: it accepts the sentence L7's `promoteProvenance` writes into
`Rendition.notes` (who, then when), and a structured `promotion: {by, at}` field
if a lane adds one, which §4 permits as an optional extension. It is injectable
through `deps.hasPromotionRecord`, so the integrator can hand L7's or L10's
version in without touching this module.

**Why.** Reaching for an undeclared export would make L11 depend on an internal,
which is the one thing `API.md` exists to prevent. Reading liberally means the
two readers agree on every record either can write, and the injection seam means
a single authority can be chosen at integration without a code change here.

---

## L11-D8 — Preflight duplicates two of the emitter's checks, and de-duplicates the result

**Unsettled by:** §14 lists `NETWORK_REFERENCE` and `PROVENANCE_UNLABELED` among
the codes the rehearsal sweep collects, while §9 and §22.6 put the enforcement of
both inside the emitter.

**Decision.** Both. The emitter stays the enforcement point — §22.6 is explicit
and L10 refuses the emit. Preflight raises the same findings earlier so the
seller meets them in rehearsal rather than at the emit button, and the two do not
report one defect twice:

- **Network.** Preflight scans what only the model can show — `raw` blocks
  carrying external references, media that never got inlined, a logo with a
  remote payload — and hands the runtime script, the runtime stylesheet, the
  rendered document and the emitted stylesheet to L10's
  `scanForNetworkReferences`. A stylesheet and a script are wrapped in `<style>`
  and `<script>` first, because L10's scanner guards a *document* and that is the
  shape those two reach the artifact in.
- **Provenance.** Preflight makes the two model-level checks itself, with an
  auto-fix attached to each (an unpromoted `verified-by-user` rendition; the
  label disabled on a Review-reachable build). When a rendered document is
  supplied it also calls `assertProvenance` with a scene renderer built from L2's
  layout registry, and **drops** the findings L10 tags `promotion-record` or
  `label-option`, which are its copies of the two preflight already made.

**Why.** The seller should find out during rehearsal, not at the last step, and
§14 asks for exactly that. Reporting the same defect twice — once with a fix and
once without — would make the panel look broken and the fix look optional.

---

## L11-D9 — `STALE_CAPTURE` covers specimens only, and does not run without a clock

**Unsettled by:** §6 says to raise it "when a specimen is older than 30 days at
emit time". A `BrandSystem` also carries `capturedAt`.

**Decision.** Specimens only, exactly as §6 says. Time reaches the rule solely
through the injected clock; with no clock, the rule does not run and every other
rule still does.

**Why.** A rebrand is worth knowing about, but the §4 `locus` has no slot for a
brand system, and stretching `assetId` to hold one would be a contract drift for
an informational finding. On the clock: §5 and `scripts/lint-determinism.mjs`
forbid reading the machine's clock in `src/`, and inventing a reference instant
would make the finding depend on when the sweep happened to run. Omitting the
clock is not an override — `STALE_CAPTURE` is severity 3 by contract and blocks
nothing, and no severity-1 rule depends on time.

---

## L11-D10 — Preflight refuses a proof that violates the §4 contract

**Unsettled by:** nothing says what the sweep should do with a malformed proof.

**Decision.** `runPreflight` runs `validateProofShape` first and throws, naming
the first violations, rather than returning findings.

**Why.** A proof missing its spine cannot be measured meaningfully, and an empty
finding list reads as a pass. The one thing a validator must never do is look
like it validated something it could not.

---

## L11-D11 — The ground truth for §17.4 is an oracle inside the test, and the corpus is not it

**Unsettled by:** §17.4 requires precision and recall against a planted corpus
without saying where ground truth comes from.

**Decision.** Three separable things:

1. **The corpus** (`test/fixtures/overflow/`) plants defects at *stated
   magnitudes* — `overBy: 0.12` means the text is exactly 12% wider than its
   container — by deriving each container from the text, the style and the
   substitution. It records the design intent, not the verdict.
2. **The oracle** lives in `test/validate/overflow-corpus.test.mjs` and never
   imports `src/validate/`. It re-implements family lookup, the weight→table
   decision, advance summation, `text-transform`, `letter-spacing`, break-
   opportunity segmentation, greedy line breaking, and the width/height/clamp
   verdicts. The test first asserts the oracle agrees with every planted intent,
   which is what proves the corpus is well formed, and only then measures the
   detector against it.
3. **The browser cross-check** answers the question neither of the first two can:
   *are the published metrics right?* The oracle shares the engine's metric
   **data** — the Adobe Core-14 AFM tables and the per-family width scales — and
   re-typing those numbers into the test file would produce an identical answer
   while merely looking more independent. What is independent is the algorithm.
   Real Chromium answers for the data.

The oracle states the thresholds itself and a test asserts they equal the
detector's exported constants, so a threshold change fails loudly instead of
silently skewing the measurement.

**Measured, 93 cases × 3 axes = 279 judgements:** recall 1.0000 and precision
1.0000 on severity-1 overflow, with 279/279 exact severity agreement across all
three bands. `§17.4` requires recall ≥ 0.98; the suite asserts that and a stated
precision floor of 0.98, and prints the confusion matrix on every run so a
regression is legible rather than a number moving.

---

## L11-D12 — The no-override check scans identifiers and calls, not words near words

**Unsettled by:** §14 says there is no override flag and §20 has the critic look
for one. Nothing says how a build proves the absence of something.

**Decision.** `test/validate/no-override.test.mjs` checks three things: that no
option passed to `runPreflight` or `dryRun` changes the findings (twenty
override-shaped options are tried), that no export in the lane reads as one, and
that no line in `src/` is one. The source scan strips comments and string
literals first — carrying block-comment state across lines — and matches
override-shaped **identifiers** and **calls** rather than a verb sitting near a
noun. A meta-test plants five overrides and asserts the scanner catches all five,
and plants the two shapes that *read* like an override but are the law being kept
(`disabled: !gate.canEmit`, `disabled: blocking.length > 0` — the emit button
greyed out because a finding blocks) and asserts it catches neither.

**Why.** The first version of this check matched a verb within forty characters
of "severity", and it flagged four lines across the repository, every one of them
either prose documenting the law or the law being enforced. A check that cries
wolf gets deleted, and a deleted check proves nothing. A scanner that cannot
catch a planted override proves nothing either, which is what the meta-test is
for — §20.4 has the critic do exactly this to the network scanner.

The one code change the check prompted was L11's own: `severity: worst.severity
=== 1 ? undefined : 2` was replaced with `severity: worst.severity`. The two are
equivalent — `undefined` means "let `makeFinding` apply the declared severity",
which is 1 — but a reader could not tell without chasing `makeFinding` whether
severity 1 was being defaulted or dropped, and §14 is the law where ambiguity
costs most.

---

## L11-D13 — Findings carry an optional `detail`, and their ids do not depend on it

**Unsettled by:** §4 freezes `Finding` at six fields and permits optional
extensions.

**Decision.** Findings carry an optional `detail` object of machine-readable
numbers — the measured excess, the breakpoint, the resolved face, the byte
counts, L9's coverage reasons. The auto-fixer locates its target from it and the
studio renders it without re-parsing prose.

A finding's **id is a hash of its code, its locus and a stable key** — never of
`detail`. The same defect therefore keeps the same id between runs even when a
measurement moves by a fraction of a pixel, which is what lets the studio
remember which findings a user has already looked at, and what makes the §5
determinism assertion mean something stronger than "the numbers came out the same
this time".

---

## L11-D14 — A `SceneMeasurement` box with no container is skipped, not reported

**Unsettled by:** `measureScene` could hand back a box with `containerWidthPx`
of 0.

**Decision.** Skipped silently. A zero-width container is a layout defect, not an
overflow, and `TEXT_OVERFLOW` is the wrong code for it — every box in the scene
would "overflow", burying the real findings.

**Why.** The check that catches it is `test/validate/preflight.test.mjs`, which
asserts every measured scene produces at least one box and that every box has a
positive container. A layout that measures nothing fails there, by name, instead
of producing a hundred meaningless overflow findings.
