# L11 Validate — lane decisions

Every judgment call the spec did not settle, per §23. Format follows
`DECISIONS.md`. Nothing here overrides `PITCHPROOF-BUILD-SPEC-v1.0.md`.

---

## L11-D1 — The overflow severity threshold is 2% of the container, and the number is measured

> **Amended after the §20 critic (CRITIQUE-1 F6).** The magnitude bands below
> decide whether there is anything to report. They no longer decide, on their
> own, whether it blocks — see **L11-D15**, which added the truncation mode as a
> second dimension.

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

## L11-D15 — Truncation blocks an emit when the viewer cannot see it happened

**Unsettled by:** §14 and §22.2 name text overflow without distinguishing text
that is *cut* from text that is *cut with a visible ellipsis*. Superseded my
earlier rule, which graded the clamp axis by how many lines were lost.

**What was wrong.** The §20 critic (F6) measured the previous grading against the
real corpus. `src/scene/parts.js` renders a panel title and a panel meta row
under every column with `data-pp-clamp="1"`, which `scenes.css` turns into
`white-space: nowrap; text-overflow: ellipsis` — a designed truncation with a
visible ellipsis. The detector graded it **severity 1**, so `splitBeforeAfter`,
`sideNote` and `stack` produced 14 to 60 blocking findings per specimen with no
seller-authored text in them at all. The text was the prospect's own page title
and source URL, which §18.3 forbids the tool from shortening, and severity 1
blocks emit with no override and no auto-fix. The layout the entire before/after
thesis rests on was un-emittable past a 54-character URL.

The critic also caught the inconsistency underneath it: losing **two lines of the
client's own copy** to a multi-line clamp graded 2, while losing the tail of a
URL to a one-line clamp graded 1.

**Decision.** Grade on the **signal**, not the quantity. L8 now reports
`textOverflow: 'clip' | 'ellipsis'` on every box in `SceneMeasurement`, derived
from the same design tokens that produce the artifact's CSS:

| truncation | severity | why |
|---|---|---|
| `clip` | **1** | The sentence stops and nothing says so. Nobody in the room knows there was more. This is §22.2's defect exactly — invisible until it isn't. |
| `ellipsis` | **2** | The trailing `…` is a signal the viewer reads. Truncating a long URL into a one-line meta row is a layout decision, and the client can ask what the rest of it was. |

It applies to the **width** and **clamp** axes, and not to **height**:
`text-overflow` is a horizontal property, and text running past the bottom of its
box carries no ellipsis anywhere.

`CLAMP_BLOCKING_LOST_LINES` is gone. There is no line-count rule left anywhere in
the detector, which removes the inconsistency rather than papering over it: a
multi-line clamp and a one-line clamp are now graded by the same question.

**An undeclared mode grades as `clip`**, because that is CSS's own initial value
and because defaulting the other way would silently downgrade real data loss on
every box whose measurement predates the field — the one direction §14 does not
allow. The finding says so in its message and carries
`detail.textOverflowDeclared: false`, so the gap is legible rather than silent.

**Measured effect.** On the critic's own reproduction
(`.tmp/critic/15-layout-corpus.mjs`), across four real corpus specimens × eight
layouts × three breakpoints, severity-1 overflow went from 51/30/60/14/38/49 on
the affected layouts to **0 everywhere**, while the overflows themselves are
still reported — as warnings, with the same measurements and the same remedies.
`test/validate/preflight.test.mjs` pins both halves: the prospect's URL and title
no longer refuse an emit, and the identical box with the mode taken away still
does.

**Provenance.** The two grades were set centrally by the integrator after the
critic's finding, so L8 and L11 were not negotiating the boundary between them.
L11 agrees with them and implemented them.

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

## L11-D16 — `BEAT_EMPTY` covers a beat whose reveals name nothing the layout renders

**Unsettled by:** §14 lists `BEAT_EMPTY` without saying what "empty" means, and
§4's `Beat.reveals` is a list of element ids with no referential integrity rule.

**What was wrong.** The §20 critic (F16) set
`beats[0].reveals = ['el_deadbeef00']` and the sweep said nothing at any
severity. `BEAT_EMPTY` covered a beat with *no* reveals; a beat whose reveals all
name elements nothing renders is functionally identical — the presenter presses
`→` and the screen does not change — and it was invisible.

**Decision.** Same code, same severity, same auto-fix. Preflight renders each
scene once through L2's layout registry, collects the ids carrying L2's
`data-pp-el`, and reports a beat whose reveals are **entirely** absent from that
set. Two guards keep it honest:

- **A beat that reveals some real ids and some dangling ones is not reported.**
  Partial drift still moves the screen, so it is not this defect, and firing on
  it would flag any layout that renders a subset.
- **A scene whose tree carries no revealable element at all is skipped**, because
  comparing against an empty set would make every beat in a still-frame layout a
  finding.

`detail.kind` distinguishes `'no-reveals'` from `'dangling-reveals'`, and the
auto-fix checks the corresponding condition before trimming, so a fix computed
against one shape cannot remove a beat of the other.

**The finding this exposed in my own fixtures.** `cleanProof()` wrote its beats
by hand as `elementId(sceneId, 'block/0')` — ids no layout mints. Every beat in
the control was a dead keypress, and the control was therefore not a proof the
studio could have produced. The fixture now renders each scene and takes its
reveals from the tree (`withRenderedReveals`), and `defectProof` re-derives them
after mutating, so changing which blocks a scene shows cannot plant a second,
unintended defect. A test asserts that swapping a scene's layout without
re-pointing its beats is caught, which is the studio path that produces this in
real use.

---

## L11-D17 — `metricDelta: null` is an answer, and every message says so

**Unsettled by:** §4 types `TypeFace.metricDelta` as nullable without saying when
it is null or what a consumer should do about it.

**Decision.** `core/text-metrics.js` returns `metricDelta: null` from
`resolveFace` for a family this build holds no published metrics for — the
honest answer, since comparing an unknown family to the category model it already
fell back to would report the substitution as metrically perfect. Every place
L11 reads a delta goes through `advanceDeltaOf(face)`, which returns
`number | null`, and every message that would have quoted a percentage says
instead that the movement is unmeasured and why. `resolveBoxFace` propagates the
null rather than recomputing a number, and the `FONT_UNAVAILABLE` auto-fix writes
`null` rather than a half-filled object, which §4 requires.

**Why it matters here specifically.** §22.2's case *is* the unknown family: a
prospect's custom webfont is precisely the face nobody has published metrics for.
Reporting "+0.0% average advance" for it would be the detector telling the seller
the substitution is free at the exact moment it is most likely not to be. The
critic's `15-layout-corpus.mjs` crashed L11 on a null delta, which is how this
was found; a test now measures an unknown family end to end.

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

## L11-D7 — ~~`hasPromotionRecord` is L11's, not imported from L7~~ (superseded by L11-D19)

> **Reversed.** The premise below — "`API.md` does not declare a reader on L7's
> surface" — stopped being true: `API.md` Part 5 now declares
> `hasPromotionRecord`, `verifyProvenance`, `renditionsRequiringLabel` and
> `PROMOTION_RECORD_RE` on `recipe/index.js`, for exactly this purpose. The
> decision below was acted on for one round, the two readers disagreed in
> production, and L11-D19 records the correction. Kept for the record.

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

**Measured, 112 cases × 3 axes = 336 judgements:** recall 1.0000 and precision
1.0000 on severity-1 overflow, with 336/336 exact severity agreement across all
three bands. `§17.4` requires recall ≥ 0.98; the suite asserts that and a stated
precision floor of 0.98, and prints the confusion matrix on every run so a
regression is legible rather than a number moving.

### What the oracle proves, and what it does not

**Amended after the §20 critic (CRITIQUE-1 F7).** The oracle is written
independently of `src/validate/`, but it necessarily encodes the *same policy* —
that a 27.7% excess past an ellipsised container warns rather than blocks. It
recomputes the 27.7% by itself; it does not independently decide what 27.7%
should mean.

So agreement between the two says the detector **measures what it claims to
measure**. It does not say the severity policy is right. Those are separate
claims and they now have separate evidence:

| claim | evidence |
|---|---|
| the arithmetic is right | the oracle, written independently, agrees on 336/336 |
| the published metrics are right | the browser cross-check against real Chromium |
| the policy is right | argued in L11-D1 and L11-D15; pinned by a table-driven test that calls `detectBoxOverflow` with **no oracle in the path**, so a policy change fails even if the oracle were changed to match |
| the corpus covers what the product emits | a distribution test that asserts the shapes, roles, breakpoints and truncation modes the layouts actually produce |

The last row is the one the critic's F7 was about, and it is the one that was
missing. A recall figure measured over a distribution that excludes the failure
mode is not a measurement of the detector, so the distribution is now asserted
rather than assumed.

### The distribution, asserted

`test/validate/overflow-corpus.test.mjs` runs the inspection the critic ran by
hand and fails on it: at least ten `maxLines: 1` cases, both truncation modes in
quantity at that clamp, the `panelMeta` and `panelTitle` roles by name, a
one-line clamp at each of `sm`/`md`/`lg`, and planted positives *and* negatives
on both sides of the discriminator. The corpus grew from 93 cases to 112 to
satisfy it.

---

## L11-D18 — The sweep is graded against a corpus-built proof as well as a planted one

**Unsettled by:** §17.4 asks for a planted-defect corpus and says nothing about
grading the sweep against real content.

**Decision.** Both, because they answer different questions.

- **The planted corpus** (`test/fixtures/overflow/`) proves the detector finds
  what was put there. Ground truth is knowable because the defects were placed
  at stated magnitudes.
- **The corpus proof** (`test/fixtures/corpus/proof.mjs` — four hostile pages and
  two binary documents through the published surfaces of L3–L9) proves the sweep
  does not invent things that were not. Ground truth is not knowable there, so
  what is asserted is the property that matters: **a proof assembled entirely
  through the declared lane surfaces must be presentable and emittable.** Zero
  severity-1 findings, every measured box declaring how it truncates, every
  finding's locus resolving to a real scene, every clamp finding quoting what it
  lost, every auto-fix pure, and the whole sweep deterministic across two
  independent builds of the pipeline.

**Why properties and not counts.** The §20 critic's leverage sentence was that
every severity-1 finding in the critique was reachable from a corpus-built proof
and none from `makeProof()`; a hand-written fixture agrees with whatever the lane
that wrote it believed, so it cannot disagree and cannot find anything. But a
corpus fixture is *tuned*: between writing this test and running it, the fixture
went from 6 spine scenes to 31 as scene chunking moved to heading boundaries, and
the warning count moved with it. A test that pinned the numbers would have broken
on an improvement while telling nobody anything. The distribution is printed on
every run so a regression is legible; only the invariants are asserted.

**What it found immediately.** On real client copy the layouts clamp long body
blocks, so the sweep reports every truncation as a severity-2 warning with the
truncated text quoted — which is the signal a seller wants before a pitch, and
correctly not a blocker. Two `FONT_UNAVAILABLE` warnings for a brand face that is
not embeddable. Nothing blocking.

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

---

## L11-D19 — There is one reader of the promotion record, and it is L7's

**Defect:** L10-D9, reported against the previous round. **Supersedes L11-D7.**

**Unsettled by:** §9 makes `promoteProvenance` the only route to
`verified-by-user` and says it records who promoted it and when. It does not say
who owns the *reader*.

**What was wrong.** `src/validate/provenance.js` carried its own reader, and
`runPreflight` defaulted to it. L7 writes a delimited, signed record —
`[[pp-promotion:1;by=…;at=…;of=…;from=…;sig=…]]`, frozen in
`docs/decisions/L7-recipes.md` D-L7-2 — and L11's regex was looking for an
English sentence ("promoted … by X at YYYY-MM-DD"). The two never matched. A
rendition promoted the only supported way therefore drew a **severity-1**
`PROVENANCE_UNLABELED` from preflight, so the studio disabled the emit button on
an honest proof, while `emit()` — which reads the record with L7's function —
accepted the same proof without complaint. Two readers of one format, disagreeing,
with the stricter one in front of the seller.

**Decision.** Deleted. `src/validate/lane-recipe.js` bridges to
`recipe/index.js` the way `lane-brand.js` and `lane-scene.js` bridge to L4 and
L8, and `validate/provenance.js` re-exports `hasPromotionRecord` and
`readPromotionRecord` from it. `promotionRecord` stays as a named L11 export
because callers use it, but it is now `readPromotionRecord` underneath and
returns L7's record shape — the same object L10's `promotionRecord` returns.
`deps.hasPromotionRecord` survives as an injection seam; nothing has to be
injected any more for preflight and the emitter to agree, and L10 can drop the
injection from its equivalence test.

**Why.** §4's point is that lanes talk through contracts, and a second
implementation of a format another lane owns needs a stronger justification than
"the reader was not declared". The reader is declared now. Beyond the drift: the
old reader was *more permissive in the wrong direction* — it accepted a sentence
anyone could type into `Rendition.notes`, which is precisely the forgery L7's
signature exists to make hard, and which `buildRendition` strips on the way in.
Deferring to L7 is both the safer reading and the smaller surface.

**Regression.** `test/validate/provenance.test.mjs` builds the record by calling
`promoteProvenance` rather than by writing a string that imitates it, asserts
L11, L10 and L7 all read it, asserts the English sentence is *not* accepted, and
asserts preflight's default answer is identical to the answer with L10's reader
injected.

---

## L11-D20 — `DUPLICATE_SCENE`'s content fingerprint is over structural paths, not element ids

**Defect:** reported by the integrator after L10 read the same symptom as a
`buildScene({id})` bug. It is not one: the id override works, which is exactly
why the fingerprint missed.

**Unsettled by:** §14 lists `DUPLICATE_SCENE` and §4 says `Beat.reveals` holds
element ids. Nothing says what makes two scenes "the same scene".

**What was wrong.** The rule has two halves. The id half — one scene id in more
than one place — worked. The content half hashed
`{layout, headline, subhead, specimenId, renditionIds, beats: reveals}` and
could never fire, because `elementId(sceneId, path)` mixes the scene id into
every reveal id. Two scenes that are duplicates in every visible way always hold
different reveal ids, so they always fingerprinted differently; the only scenes
whose reveals matched were scenes sharing an id, which the first half already
caught. Dead code, and the corpus `DUPLICATE_SCENE` plant went undetected.

**Decision.** The fingerprint is over what the room sees: layout, headline,
subhead, specimen, renditions, and the *shape* of the beats — how many, in what
order, and which structural elements each one reveals. The structure is
recoverable, and this is the part worth stating plainly: `elementId` is one-way,
but the path vocabulary is not a secret. It is whatever the layout passed to
`ctx.el()`. `revealPathIndex` (in `preflight.js`) renders every scene once with
`el` set to the identity, collects the paths in document order, and maps
`elementId(scene.id, path)` back to each. `beatShape` then relabels every reveal
as `@<path>`, keeping beat order and sorting within a beat, because a beat
reveals its elements together but the order of the beats is the telling.

Three consequences worth naming:

- The index is **deck-wide, not per scene**. A scene deep-copied rather than
  rebuilt keeps the ids of the scene it was copied from; looking those up across
  the deck resolves them to the paths they name, so both kinds of duplicate — the
  rebuilt twin and the copy-paste — reduce to the same shape. Ids are content
  hashes of `{sceneId, path}`, so a lookup landing on another scene's entry means
  the two genuinely name the same path.
- An id **no scene renders** — a stale reveal, or one typed by hand — falls back
  to the ordinal of its first appearance in that scene's own beats. Still
  id-free, so two scenes carrying the same structural mistake still fingerprint
  alike, and no scene id ever reaches the hash.
- Beats did **not** have to be dropped from the fingerprint, so the question the
  integrator flagged does not arise. Presenter notes and dwell hints are left
  out: they are the presenter's script, not what the audience sees, and a seller
  who reworded a note has not made it a different scene.

**Why this and not something looser.** Dropping beats entirely would have made
the fingerprint `{layout, headline, subhead, specimen, renditions}`, which reads
"a rebuilt scene is a duplicate of the hand-staged one it replaced" — false, and
noisy on any proof where a scene was re-planned. The control proof stages its
opening scene in two beats where `buildScene` would stage three; a test pins that
those two are *not* duplicates.

**Regression.** `test/integration/corpus-plants.test.mjs`'s `DUPLICATE_SCENE`
plant now detects, unchanged. In-lane: two `buildScene` twins under different
ids are caught, a deep copy carrying its original's ids is caught, a twin whose
beats are restaged into one is not, and a rebuild of a differently-staged scene
is not.

---

## L11-D21 — `ASSET_MISSING` accepts an SVG logo as markup **or** as a data URI

**Defect:** L10-D10.

**Unsettled by:** nothing — §4 settles it, and the rule disagreed with §4.

**What was wrong.** §4 documents `LogoAsset.data` as "inline SVG markup or data
URI" for **either** `kind`. The rule required `kind: 'svg'` to be literal markup
and reported `data:image/svg+xml,…` as a missing asset at **severity 1** — a
refusal to emit a proof the contract permits, which is the most expensive false
positive a severity-1 rule can have.

**Decision.** Built against the contract as written (§4 requires that of a lane
that disagrees, and here the lane does not disagree). `logoPayloadUsable`
accepts, for `kind: 'svg'`, either inline markup containing an `<svg` element or
a parseable data URI. Two refinements, both about payloads with nothing in them
rather than about form:

- A data URI that **declares** `image/svg+xml` and decodes to something with no
  `<svg` element in it is still reported. `data:image/svg+xml,` is as empty as
  `''`, and the check that catches empty inline markup should catch it too rather
  than waving it through on the strength of the `data:` prefix.
- A data URI of some **other** type on a `kind: 'svg'` logo is accepted. A PNG
  payload under an `svg` kind is a mislabelled kind, not a missing asset, and
  `ASSET_MISSING` is not the code for it. §4 gives no code that is; recorded here
  rather than smuggled in under this one.

`kind: 'raster'` still requires a data URI: inline SVG markup is not a raster
image, whatever the field's documentation permits in general.

**Why.** No dispute is filed, because there is nothing to dispute — the contract
is right and the rule was wrong. A severity-1 finding is an unoverridable refusal
(§14), and the bar for one is that the proof is genuinely unshippable.

**Regression.** `test/validate/rules.test.mjs` runs the clean proof with its logo
in all three legal forms — inline, percent-encoded data URI, base64 data URI —
and asserts silence, then runs four empty payloads and asserts one finding each.

---

## L11-D22 — A scene anchoring a branch that does not exist is `ASSET_MISSING`, at severity 2

**Defect:** F20, from the §20 critique's severity-3 tail.

**Unsettled by:** §11 and §14 describe coverage from the branch's side — a branch
nothing anchors. Neither says anything about the mirror image: a scene whose
`branchAnchors` names a branch that is not in the proof. `branchCoverage` reports
the first; nothing reported the second, at any severity.

**Decision.** Reported by the `ASSET_MISSING` rule, at **severity 2**, once per
scene that names the missing branch.

**Why this code.** §4's fourteen codes are closed, so this had to join an
existing one. `ASSET_MISSING` already owns "a scene references something that is
not in the proof" — it reports exactly that for `scene.specimenId` and for each
of `scene.renditionIds`. A branch anchor is the third member of that set and the
rule's `inspects` line now says so. `BRANCH_UNREACHABLE` was the alternative and
is wrong twice over: it is about a branch, and there is no branch here.

**Why severity 2 and not 1**, against the integrator's reading that this is
§22.4 stranding. It is not, and the difference is checkable: `buildDeck` filters
`branchAnchors` against the sequences that exist, so a ghost anchor produces no
affordance, no key and no navigation target in the artifact. Nobody is offered
anything, so nobody is stranded — the test asserts the filtering directly, so
this justification fails loudly if the deck ever stops doing it. What *is* wrong
is real but smaller: the model claims this scene offers a branch, the studio's
scene panel and inspector count it when they say how many branches a scene
offers, and the objection the anchor was placed for now has no way in from that
scene. That is a warning. Severity 1 blocks emit with no override (§14), and the
bar for that is a proof that would misrepresent the client or break in the room;
this breaks neither.

**Regression.** `test/validate/branch.test.mjs` asserts the deck filters the
ghost and that `branchCoverage` therefore says nothing, then asserts preflight
produces exactly one finding, its code, its severity and its locus.

---

## L11-D23 — `BRANCH_UNREACHABLE` stays severity 2, and says what the branch costs

**Defect:** F21, from the §20 critique's severity-3 tail. The critic's objection
was "non-blocking is defensible; shipping unreachable scenes silently is not."

**Unsettled by:** §14 lists the code and §11 defines the condition. Neither says
what the emitter should do with a branch that has no way in.

**Decision, in two parts.**

*Severity stays 2.* A branch with no anchor and no jump-index entry is a
tidiness problem: the deck presents correctly, nobody is stranded, and the client
sees nothing wrong. §14 makes severity 1 an unoverridable refusal, and
`emit()` now runs this whole rule set, so choosing 1 here would mean a seller
with an untidy project cannot ship at all. That is a worse outcome than the one
it prevents.

*The silence does not stay.* The message now says the branch's scenes ship
anyway, quotes an estimate of what they cost, and names both ways out — the
auto-fix that makes it reachable, and deleting it, which is the only thing that
takes the weight out of the file. `branchShipCost` estimates it the way
`SIZE_BUDGET_EXCEEDED` estimates the whole: the branch's scene JSON after
compression, plus media belonging to specimens and renditions **nothing else in
the deck shows**. Shared media is excluded rather than double-counted — removing
the branch would not recover it, so billing the branch for it would be a number
the seller cannot act on. A branch with no scenes is billed nothing and the
message says so.

**Why not have the emitter drop them.** It was the obvious alternative and it is
L10's call, not mine, so I have reported it upward rather than reaching across
the boundary. My recommendation is against: an emitter that silently deletes
authored content is a worse failure than one that ships it with a warning — the
seller who anchored a branch and then broke the anchor gets a file missing an
answer they thought they had prepared, and nothing tells them. §13's degradation
report exists because even *recompressing* an image is something the seller has
to be told about; deleting scenes is a larger act than that and deserves at least
the same. Reporting is enough because the finding is actionable in both
directions and the cost is now on the screen.

**Regression.** `test/validate/branch.test.mjs` pins the severity, the scene
count, a non-zero cost, the "ships anyway" and "delete it" halves of the message,
and the auto-fix; a hollow branch is asserted to be billed zero; and
`branchShipCost` is asserted to exclude media the spine also shows.

