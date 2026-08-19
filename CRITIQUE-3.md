# CRITIQUE-3

Adversarial critic, pass 3, against `PITCHPROOF-BUILD-SPEC-v1.0.md` §20.

**Verdict: 10 axes pass, 1 fails. 2 severity-1 findings, 5 severity-2, 5 severity-3.
The artifact is close to done. The studio hands it the wrong content.**

Both of CRITIQUE-2's failed axes are genuinely fixed, and I say so with numbers I
derived myself rather than read: I measured overflow recall in Chromium my own
way, over a population I chose, and landed on **0.9921 (125/126), precision
1.0000** — their figure, to four decimals, with the single miss being exactly the
box `DEFERRED.md` records. I chose my own budgets on two different proofs and the
reported saving equals the actual saving to within 3–11 bytes at every one. Both
deferrals survive contact: `badgeNumber` overflows its box by exactly 2px and is
never clipped, and C1's residual is the headline at `sm|sc_c5edf6412639`, 0.69%
apart, as recorded.

What neither predecessor reached is the studio's own output. Pass 1 found the
studio unusable; pass 2 drove it and found it good. Neither read what it wrote.
**Every specimen the studio captures is minted the same id.** A seller who pastes
three of the prospect's pages and builds six scenes across them gets a deck in
which all six scenes render the same page — verified by export, and by the
runtime's own `specimenById` map, which holds one entry for three specimens. The
same collision makes `ASSET_MISSING`'s locus point at the wrong specimen, so its
auto-fix is a no-op: I clicked the studio's own remediation button 40 times over
232 seconds, watched the blocker count stall at 3, and never reached an emit.

Everything downstream of the emitter is in good shape and getting better. The
problem is one function in `src/ui/services.js`.

---

## §20 axis scorecard

| # | Axis | Verdict |
|---|---|---|
| 1 | Contract fidelity | **PASS** — with P1's note |
| 2 | Determinism | **PASS**, proven |
| 3 | Colour correctness | **PASS**, proven |
| 4 | Offline integrity | **PASS** — 9 planted violations, 9 caught |
| 5 | Overflow detection efficacy | **PASS** — 0.9921/1.0000 reproduced; with P3 |
| 6 | Branch integrity | **PASS** — orphans caught, 0 state corruption |
| 7 | Provenance enforcement | **PASS** — with P8 |
| 8 | Presentation robustness | **PASS** |
| 9 | Degradation honesty | **PASS** — with P4, P7 |
| 10 | Studio usability under pressure | **FAIL** — P1, P2 |
| 11 | Non-goal violations | **PASS** |

---

## §20 preamble: what I ran before writing

> "The critic must actually build and present a proof end to end from the fixture
> corpus before writing its report."

I built the corpus proof through `buildCorpusProof()` → `emit()`, wrote a
412,956-byte artifact, opened it in headless Chromium from `file://` with every
non-`file://` request aborted, walked all 99 spine positions and every beat of
every branch with real key presses, drove the jump index by typing, opened the
presenter window and drove the deck from it, and looked at 31 scene screenshots
plus the branch badge, the four overlays and the blank screen. Then I built a
second proof in the built studio (`dist/pitchproof-studio.html`) from paste to
attempted emit, and exported the project to read what it had actually made.

Everything is under
`/tmp/claude-0/-home-user-PitchProof/4f4867db-5fdf-5b7b-bf15-0e36c8d8a775/scratchpad/c3/`.

| Script | What it did |
|---|---|
| `01-emit.mjs` | Corpus → artifact. 31 spine scenes, 99 beats, 4 branches, 6 specimens, 31 renditions, 412,956 bytes, 0 degradations, 127 findings (125 sev-2 `TEXT_OVERFLOW`, 2 sev-2 `FONT_UNAVAILABLE`). |
| `02-walk.mjs` | 99 spine positions forward, then `←` from every one: **0 hash mismatches**, 0 network attempts, 0 page errors. |
| `03/04/05-*.mjs` | Blank screen, help, map, contents, jump index; four-deep nested jumps into distinct branches; `Backspace` unwinding; `r`; the no-match query. |
| `06-reverse.mjs` | Every beat of every branch: forward, then back from each, comparing state hash **and** the set of visible `data-pp-el` nodes. 0 mismatches. Auto-exit reversed immediately re-enters the branch at the beat it left. |
| `07/08-shots.mjs` | Screenshots of all 31 scenes at their last beat. |
| `10-overflow.mjs` | **My own overflow ground truth.** Every element with direct text under `#pp-stage-root`, at 390/1024/1600, over 188 deck positions (spine **and** all four branches, every beat). Overflow judged by the union of `Range.getClientRects()` against the element's content box, and "cut" judged by walking ancestors for a clipping `overflow` or an active `text-overflow: ellipsis` — not by any marker the model writes. 739 overflowing boxes, 295 of them cut. |
| `11-preflight.mjs` | `runPreflight` on the same proof: 125 `TEXT_OVERFLOW`, 2 `FONT_UNAVAILABLE`. |
| `12-badge.mjs` | The branch badge measured and screenshotted at `lg` and `sm`. |
| `20/21/22-*.mjs` | Budget arithmetic at 9 absolute budgets on the corpus, then at 5 fractions each on a proof with a 1.4 MP noise hero and a 1.6 MP photographic hero. |
| `30/31-*.mjs` | 39 CSS routes to an invisible provenance label through `deps.userCss`, each re-checked in a real browser. |
| `40..46-*.mjs` | 22 network references planted through the model into branch scenes, then 9 planted into the finished HTML including 7 spellings of a foreign `<script>` claiming an emitter id. |
| `50/51-*.mjs` | 10 branch orphans, id collisions and cycles, each through `runPreflight` and `emit()`, then driven in a browser to see whether the "orphan" was actually reachable. |
| `61/62/63-*.mjs` | Presenter window (D16); `emitOptions.mode` × `includePresenterNotes` × `labelIllustrativeContent`; presenter-note stripping checked with a distinctive secret string. |
| `70/71-*.mjs` | `dir`/`lang`/`pre` end to end; all eight seed recipes run through `renderRecipe`. |
| `80/81/82-*.mjs` | Determinism ×3 under `TZ=Pacific/Kiritimati`; different seeds; OKLab and WCAG against published values. |
| `90..99, A0..A1, B0..B5, C0..C6` | The studio: boot, keyboard model, paste ingest ×3, brand review, recipe run, 12 scenes, 3 branches, sweep, auto-fix grind, project export, font attach. |

**Gate results, re-run by me, on a tree `git status` reported clean:**

```
node --test "test/**/*.test.mjs"          2007 pass, 0 fail, 0 skipped
node scripts/lint-determinism.mjs         clean
node scripts/build.mjs --verify-repeat 3  3 output(s) byte-identical
node scripts/verify-offline.mjs           clean — 0 requests, FCP 104ms/92ms,
                                          510 key presses / 111 positions, both decode paths
node scripts/emit-demo.mjs --check        current — 412,875 bytes
```

All five agree with the integrator's numbers. **None of them detects P1 or P2** —
the studio's own output is not asserted by any test in the suite.

---

## Severity 1

### P1 · Every specimen the studio captures gets the same id, so every scene shows the same page

`src/ui/services.js:987-993` (`minterFor`), called at `src/ui/services.js:409`.

```js
export function minterFor(seed) {
  let n = 0;
  return {
    next(kind) { n += 1; return contentId(kind, { seed, n }); },
    reset() { n = 0; },
  };
}
```

Its own doc comment states the property it fails to provide: *"seeded per call,
so two captures in the same session do not collide."* It is constructed **fresh
for every capture** (line 409), so `n` restarts at 1 each time and `seed` is the
project seed, constant across captures. The first id minted by every capture is
therefore `contentId('specimen', { seed, n: 1 })` — the same string every time.

Reproduced from an empty Chromium profile (`C6-repro.mjs`), pasting three
different fixture pages into the built studio and exporting the project:

```
three pastes ->
  id sp_004ebe5c150e | title "Northwind Industrial — Process equipment tha" | words 422 | blocks 19
  id sp_004ebe5c150e | title "HX-400 shell-and-tube heat exchanger — North" | words 386 | blocks 16
  id sp_004ebe5c150e | title "Designing fouling margin you will actually u" | words 614 | blocks 20
distinct ids: 1 of 3
```

The consequence, computed the way the runtime computes it
(`new Map(proof.specimens.map(s => [s.id, s]))`, `src/runtime/runtime.js:69`):

```
specimenById map size: 1 (specimens: 3)
every lookup resolves to: "Designing fouling margin you will actually use — N"

sc_8be87e5eb68a quoteCard         -> sp_004ebe5c150e -> "Designing fouling margin you will actually us…"
sc_4c52f6ce1017 splitBeforeAfter  -> sp_004ebe5c150e -> "Designing fouling margin you will actually us…"
sc_aa7a39e1c996 fanOut            -> sp_004ebe5c150e -> "Designing fouling margin you will actually us…"
sc_eb1ddb8c42f5 sideNote          -> sp_004ebe5c150e -> "Designing fouling margin you will actually us…"
sc_8912b4edd42e systemMap         -> sp_004ebe5c150e -> "Designing fouling margin you will actually us…"
sc_e0eb909eb994 stack             -> sp_004ebe5c150e -> "Designing fouling margin you will actually us…"
```

Six scenes built deliberately across three of the prospect's pages. All six show
the third page. The seller sees the right thing while building — the panels hold
the real objects — and the deck resolves by id.

`validateProofShape` has no uniqueness check, so nothing in `src/core/contracts.js`
refuses the proof, and `emit()` will happily write it. The corpus fixture does not
collide (it threads one `IdMinter` through the whole build,
`test/fixtures/corpus/proof.mjs:507`), which is why 2007 tests are green: **the
studio is the only producer of proofs that no test reads back.**

Renditions, scenes, branches and beats do not collide, because each set is minted
inside a single service call. Anything minted *first* by a fresh `minterFor` does.

**To reproduce:** open `dist/pitchproof-studio.html`, paste any two different
pages into Specimens → "Capture from the paste", then Project → `Ctrl E` and read
`record.proof.specimens[*].id`.

---

### P2 · The studio's auto-fix loop never terminates on the paste route

Consequence of P1, but a distinct symptom and the one a seller actually meets.

`src/validate/autofix.js` (`ASSET_MISSING` fix), driven from
`src/ui/panels/rehearse.js`; locus set in `src/validate/rules.js`.

Pasted pages carry `media` blocks whose `ref` is the source path
(`/assets/product-hx400.png`) and no `MediaRef`, because a paste has no bytes to
inline. `runPreflight` correctly raises `ASSET_MISSING` at severity 1 — one per
image per specimen, plus one per rendition that inherits the block. On the
three-page paste with the seed recipe library run and six scenes, the status bar
read **22 things block the emit** the moment the first sweep finished, and the
sweep's own summary named `ASSET_MISSING` for renditions "Brand review",
"lg — 1600px" and "ru-RU" among others, all citing `"/assets/hero-plant.png"`.

Each carries `locus.specimenId`, and by P1 every specimen has the same id, so the
auto-fix resolves to the *first* specimen — which does not contain the block
named. Measured (`C2-grind.mjs`), clicking exactly one auto-fix and running a full
sweep between each, transcribed from the run:

```
  fix  9: 10 blocking   ( 56s)
  fix 10:  9 blocking   ( 62s)
  fix 11:  8 blocking   ( 68s)
  fix 12:  7 blocking   ( 73s)
  fix 13:  6 blocking   ( 79s)
  fix 14:  5 blocking   ( 85s)
  fix 15:  4 blocking   ( 90s)
  fix 16:  3 blocking   ( 96s)
  fix 17:  3 blocking   (102s)
  fix 18:  3 blocking   (107s)
  fix 19:  3 blocking   (113s)
  …  every row from 17 to 40 reads 3 …
  fix 40:  3 blocking   (232s)
TOTAL 40 auto-fix clicks, 232s;  final: 3
Save enabled: false
```

Each fix up to the sixteenth clears exactly one finding. The seventeenth onwards
change nothing, for twenty-four consecutive clicks and 136 seconds, and the panel
keeps offering the button. (A separate single-fix run, `B3-onefix.mjs`, isolates
the working case: 20 blocking → one auto-fix → 19 after re-sweep, with the
transient 21 in between being `NO_PREFLIGHT` correctly reappearing because the
mutation invalidated the sweep.) The two survivors name two different specimen titles and the **same**
`sp_004ebe5c150e`:

```
ASSET_MISSING
Block 2 of specimen "HX-400 shell-and-tube heat exchanger — Northwind Industrial"
shows media "/assets/product-hx400.png", and no media reference with that id exists…
sp_004ebe5c150e
Auto-fix: Remove the block referencing missing media "/assets/product-hx400.png"

ASSET_MISSING
Block 6 of specimen "Designing fouling margin you will actually use — Northwind Industrial"
shows media "/assets/uptime-figure.png", and no media reference with that id exists…
sp_004ebe5c150e
Auto-fix: Remove the block referencing missing media "/assets/uptime-figure.png"
```

`Save the file` never becomes enabled. §6's law — *"Ingest must degrade gracefully
and never dead-end"* — is broken on the route the studio's own copy calls "Works
when nothing else does."

---

## Severity 2

### P3 · The branch badge cuts the client's own objection, and the overflow detector cannot see it

`src/runtime/runtime.js:308`; `src/runtime/runtime.css:141` and `:144`.

```js
h('span', { class: 'pp-branch-badge-label' }, seq.objection || 'Branch'),
```
```css
.pp-branch-badge       { max-width: min(60ch, 70vw); }
.pp-branch-badge-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

The badge is what tells the presenter and the room which objection they jumped
to, and §11 requires that objection to be *"the objection in the client's words."*
Measured in the emitted corpus artifact after jumping into the fouling-margin
branch:

```
lg (1600×900)  "Your fouling margin assumptions are more optimistic than ours"
               clientWidth 325  scrollWidth 359   cut 34px
sm (390×844)   clientWidth 164  scrollWidth 359   cut 195px  (119% of the box)
```

On screen at 1600px, with the rest of the stage empty:

> `Your fouling margin assumptions are more optimistic t…  R to return`

The badge is rendered by L2's runtime, not by an L8 layout, so it carries **no
`data-pp-tx`** and no `SceneMeasurement` box exists for it. `TEXT_OVERFLOW`
cannot fire on it at any severity, at any breakpoint, ever.

This is what separates my recall figure from L11's. Over the population that
carries `data-pp-tx`, my independent Chromium measurement reproduces theirs
exactly:

```
recall over data-pp-tx-marked boxes only: 0.9921 (125/126)   precision 1.0000
missed: [ 'sm|sc_c5edf6412639|headline' ]        <- exactly DEFERRED.md's residual
```

Over every box Chromium actually cuts, including the badge:

```
TRUTH clipped boxes: 132   DETECTOR findings: 125   matched: 125
RECALL    = 0.9470
PRECISION = 1.0000
--- MISSED ---
  sm|sc_c5edf6412639|headline                       (the recorded residual)
  sm|sc_896021d2ba7c|cls:pp-branch-badge-label
  sm|sc_6788af7a71ce|cls:pp-branch-badge-label
  sm|sc_b59d488f0773|cls:pp-branch-badge-label
  sm|sc_b3372216d1f2|cls:pp-branch-badge-label
  md|sc_896021d2ba7c|cls:pp-branch-badge-label
  lg|sc_896021d2ba7c|cls:pp-branch-badge-label
```

§17.4's 0.98 is stated for severity-1 overflow and there is none on this corpus —
all 125 findings are severity 2 — so I do not fail the axis on 0.9470. But the
number is what it is, and the blind spot is structural: **the detector's
population is defined by the thing being measured.** Runtime chrome that renders
client copy is outside it.

### P4 · An embedded font is outside the size budget, and the refusal blames a 178-byte PNG

`src/emit/budget.js:119-160` (`collectAssets` walks `media` and `logo` only);
`src/emit/emit.js:282` (`measureFootprint`), which therefore puts every font byte
in `reserveBytes`.

A seller attaches four weights of a licensed font through the studio's own
"Attach the licensed font file" control (485 KB of data URI) and sets a 420 KB
budget. Measured:

```
4 weights: bytes 898426   assetBytes 6892   reserve 891534
maxBytes 420000: REFUSED

REFUSAL MESSAGE:
emit refused: 1 severity-1 finding(s) block this artifact — 1 × SIZE_BUDGET_EXCEEDED.
  1. [SIZE_BUDGET_EXCEEDED] The artifact is 895224 bytes, 475224 over the 420000-byte
     budget, after 5 degradation(s). 1 asset(s) could not be degraded:
     md_14d5cd1f989c (178 bytes — image/png cannot be re-encoded any smaller …)
```

The seller is told the obstacle is a **178-byte PNG**. The obstacle is 485,000
bytes of font — 54% of the file and the whole of the overage — which is never
mentioned, because `undegradable` is only populated when *asset* bytes exceed the
allocator's budget, and fonts are not assets. Meanwhile five of the prospect's
own images were degraded for a budget that could never be met.

`budget.js:756` states the rule this breaks, about a different payload: *"a seller
told 'nothing else can be degraded' while a megabyte of inline SVG sits in the
payload has been told something untrue."*

The rest of axis 9 is exact, and I checked it my own way — see §9 below.

### P5 · The corpus fixture never runs a recipe, so every §20 pass has measured a pipeline with L7's stage skipped

`test/fixtures/corpus/proof.mjs:312-346` (`buildCorpusRenditions`).

It calls `recipeLane.buildRendition` directly with the specimen's own blocks. It
never calls `renderRecipe`. Measured on the built proof:

```
corpus rendition producedBy: [ 'manual-paste' ]
renditions that are a verbatim slice of their specimen: 31   transformed: 0
renditions carrying dir/lang: []
```

So all 31 renditions are copies of their own source, labelled with recipe *names*:
"Locale fan-out 3/5", "System assembly 1/6", "Approval chain 4/5". The
splitBeforeAfter scenes put the prospect's copy on the left and a slice of the
same copy on the right, under `Illustrative example — not client-approved
content`. I have the screenshots.

The seed library is not at fault — it is excellent, and I ran all eight through
the published surface on a corpus specimen:

```
locale-fanout      9 | en-US[ltr] · de-DE[ltr] · fr-FR[ltr] · es-MX[ltr] …
channel-variants   4 | Email · Paid social · In-product message · SMS
system-assembly    3 | sm — 390px · md — 1024px · lg — 1600px
brief-to-asset     2 | Brief · Structured asset
governed-iteration 5 | Iteration 1 … Iteration 5
approval-chain     5 | Draft · Brand review · Legal review · Localization review …
dam-round-trip     3 | Sourced asset · Variant produced · Metadata written back
volume-view        3 | 1 rendition · 40 renditions · 400 renditions
```

The studio runs them too (34 renditions from 8 recipes, one click). It is the
fixture that bypasses them — and the fixture is what §20 makes every critic
judge, what `verify-offline.mjs` verifies, and what `dist/northwind-demo.pitchproof.html`
is. Overflow recall, budget honesty, provenance and layout coverage have all been
measured on a proof whose "after" side is its own "before" side. It also means
pass 2's C8 (`dir="rtl"` never reaching the artifact) cannot regress-test itself
on the corpus: there is no `dir` in it to lose.

### P6 · The paste route leaves dangling media refs that are severity-1 by construction

`src/specimen/specimen.js` (`captureMedia`) via `src/ui/services.js:402`.

A pasted page has markup but no bytes, so no `MediaRef` can be minted — correct.
But the `media` **block** survives carrying the source path as its `ref`, and
`ASSET_MISSING` is severity 1. Exported from a clean three-page paste:

```
sp_… "Northwind Industrial — Process equipment"  mediaRefs 0  mediaBlocks 0  dangling: []
sp_… "HX-400 shell-and-tube heat exchanger — N"  mediaRefs 0  mediaBlocks 1  dangling: ["/assets/product-hx400.png"]
sp_… "Designing fouling margin you will actual"  mediaRefs 0  mediaBlocks 1  dangling: ["/assets/uptime-figure.png"]
```

Even with P1 fixed, this costs one auto-fix click and one full sweep per image per
rendition. §6 asks ingest to degrade gracefully; dropping the block at capture and
recording the loss in the block trace (which §4-dispute #5 and #12 already do for
nesting) would degrade; emitting a reference that blocks the emit does not. The
auto-fix's remedy — *"Remove the block referencing missing media"* — also edits the
prospect's own content, and I saw nothing set `specimen.edited` / `editNotes`,
which §18.3 and dispute #4 exist for.

### P7 · The budgeter overshoots its budget by up to 47×

`src/emit/budget.js:43` (`SCALE_LADDER`), `:694-728` (the greedy loop).

With a 1.6 MP photographic hero (1,181,306 bytes as a data URI) on a 1,594,939-byte
artifact:

| budget | needed | result | reported saving | actual saving | delta | overshoot |
|---|---|---|---|---|---|---|
| 1,586,964 | 7,975 | 1,216,082 | 378,868 | 378,857 | −11 | **47.5×** |
| 1,563,040 | 31,899 | 1,216,078 | 378,868 | 378,861 | −7 | 11.9× |
| 1,515,192 | 79,747 | 1,216,074 | 378,868 | 378,865 | −3 | 4.8× |
| 1,435,445 | 159,494 | 1,216,082 | 378,868 | 378,857 | −11 | 2.4× |
| 1,275,951 | 318,988 | 1,216,082 | 378,868 | 378,857 | −11 | 1.2× |

To shed 7,975 bytes the emitter takes the client's hero from 1600×1000 to
1200×750 and throws away 378,857 — and produces the **identical file** at every
budget across a 25% range, so the setting does nothing over most of its span. §13
asks the emitter to *"downscale progressively until under budget"*; this is one
step of a coarse ladder taken on the single largest asset. The loss is reported
(the `from`/`to` dimensions are right there), which is why axis 9 still passes —
but it is a real quality loss the seller did not ask for, and step ranking runs
backwards in effect: ranks 5 and 6, the *least* important assets, took `steps: 0`
while rank 0, the hero, took `steps: 1`.

---

## Severity 3

### P8 · Two more routes to an unreadable provenance label

`src/emit/provenance.js:320-402` and `judgeLabelRoom` at `:455`.

I ran 39 CSS attacks through `deps.userCss` and re-checked each in Chromium.
Thirty-seven behave correctly. Two are emitted and then verified to work:

| attack | emitter | in Chromium |
|---|---|---|
| `.pp-provenance{-webkit-text-fill-color:transparent}` | **emitted** | `webkitTextFillColor: rgba(0,0,0,0)`, `color` unchanged and compliant. Label box 284×38.4 and in view; text gone. Surrounding illustrative content fully readable. |
| `.pp-provenance{filter:blur(20px)}` | **emitted** | 12px type under a 20px blur — an unreadable smear, everything else crisp. |

The filter check at `:366` matches only `opacity(0)`. Every other spelling on my
list is caught, including `scale:0`, `zoom:0`, `rotate` + zero width,
`mix-blend-mode`, `filter:brightness(0)`, `opacity:0.02`, `content-visibility`,
`position:fixed` off-screen and eleven others. Screenshots of both holes are in
`c3/label/`.

Severity 3 rather than 2 because `deps.userCss` has no product path today — the
studio never passes it (`src/emit/emit.js:65` is the only reader) — which is the
same reasoning `DEFERRED.md` applies to C16. It is the class C9 closed, reopened
with two new spellings.

### P9 · `deps.fonts` can carry a face the model does not mark embeddable

`src/emit/emit.js:106` (`compileFontFaces(deps.fonts)`).

Passing a real font in `deps.fonts` without setting `TypeFace.embeddable`:

```
with font: bytes 534331   @font-face in the doc: true
in-browser: fonts loaded [{family:"Sohne", status:"loaded"}], document.fonts.check → true
FONT_UNAVAILABLE still reported: 2
```

The artifact renders in the embedded face while preflight measured all 125
`TEXT_OVERFLOW` findings against Arial. Setting `embeddable: true` fixes it
(`resolvedFamily` flips Arial → Sohne, one `FONT_UNAVAILABLE` clears), and the
studio does set it — `src/ui/services.js:891` derives `deps.fonts` from
`proof.brand`, so the two cannot diverge on the product path. A lane API that can
put the emitter and the validator on different faces is worth closing anyway.

Otherwise font embedding is clean: inlined `@font-face`, loads and is used, zero
network requests, offline walk unaffected.

### P10 · `verify-offline.mjs` verifies a bundle nothing ships

`scripts/verify-offline.mjs:146` bundles `src/artifact.js` directly and never
calls `stripComments`. `scripts/build.mjs:170` (`buildRuntime`) always strips, and
that is what the emitter, `emit-demo.mjs` and the studio use. The gate's artifact
is 630,185 bytes; the shipped one is 412,875. So D9's comment stripper — the
change that removed 37.8% of every artifact and is guarded by an export-surface
assertion — is not exercised by the offline gate at all. I loaded the *stripped*
artifact in Chromium myself and it is clean (0 requests, 0 errors, full walk), so
nothing is broken; the gate is simply looking at the wrong file.

### P11 · No apply-all for auto-fixes, though `applyAll` exists

`src/validate/autofix.js` exports `applyAll` (re-exported at
`src/validate/index.js:24`). Nothing in `src/ui/` calls it: I enumerated every
button on the rehearse panel and every command in `Ctrl K`, and the only controls
are one `Auto-fix: …` button per finding. Each application invalidates the sweep
(correctly — `NO_PREFLIGHT` reappears), so clearing N findings costs N clicks and
N full sweeps at ~5s each. On the paste route that is 20+ cycles before the emit
button can even be evaluated.

### P12 · A branch with an empty objection shows its internal id to the room

`src/branch/jump-index.js` falls back to the branch id as the display label. With
`objection: ''` and `aliases: []` the jump index renders:

```
Jump to an objection   4/4
  We already have a supplier for heat exchangers        1 SCENE
  bn_0c0a82c55c49                                       1 SCENE
  Even approved, this lands in next year's capital budget 1 SCENE · JUMP ONLY
  bn_5837b0fa7309                                       1 SCENE
```

The fallback is the right instinct — the branch stays reachable, so
`BRANCH_UNREACHABLE` correctly does not fire — but nothing raises a finding for an
objection that is empty, and §11 asks for the objection in the client's words. The
same string goes into the branch badge on stage.

---

## Axis by axis

### 1. Contract fidelity — **PASS**

`CONTRACTS-DISPUTES.md` is the best artefact in this repo: 36 objections indexed,
every one built against the contract as written, plus 17 defects found in frozen
code and closed. I spot-checked five (#1 promotion records, #8 `rightsAssertion`,
#13 three `Finding.locus` extensions, #25 `containerId`, #31 the `cta` allowlist)
and each is an optional additive field with the declared behaviour intact.
`test/core/contracts-freeze.test.mjs` passes.

The note: `validateProofShape` (`src/core/contracts.js`) checks shape but not id
uniqueness, which is why P1's proof — three `Specimen`s sharing one `id` — passes
every gate and reaches `emit()`. §4 declares `id: string` and means an identity;
the enforcement stops at the type.

*What would have caught this failing:* I diffed the shipped `contracts.d.ts`
against `test/fixtures/frozen-contracts.txt`, and checked that each disputed field
is present with its declared type on real objects produced by the pipeline rather
than on fixtures.

### 2. Determinism — **PASS**, proven

Three full corpus builds and emits in one process under `TZ=Pacific/Kiritimati`:

```
bytes 412875  hash c32e68c81736c7a3  proofHash 25b84b2b002506ca   (×3, identical)
```

§17.6's second half holds too. Seeds `seed-A` and `seed-B` give different ids
(`sc_c5ae5e012927` vs `sc_e7dd36484664`) and, after normalising all 249 ids
positionally and eliding the base64 payloads, the two documents are **identical
except for `data-pp-hash`** — which is derived from ids and is meant to change:

```
id counts 249 249   same order/shape: true
document (minus payload, ids normalised): first and only diff at index 41349
  A: data-pp-hash="89c7bf01cf4e7e18…"
  B: data-pp-hash="6ef2d132f8b626a2…"
```

`lint-determinism.mjs` is clean and `--verify-repeat 3` is byte-identical.

*What would have caught this failing:* a wall-clock read would have shown up as a
hash difference across the three in-process builds or against the exotic timezone;
an unseeded PRNG would have broken the id-normalised comparison at more than one
site.

### 3. Colour correctness — **PASS**, proven

Against Björn Ottosson's published sRGB→OKLab values, with an implementation I
did not read:

```
#ff0000  got 0.6279553606, 0.2248630611, 0.1258462985   published 0.6279554, 0.2248631, 0.1258463
#00ff00  got 0.8664396115, -0.2338875742, 0.1794984799  published 0.8664396, -0.2338874, 0.1794985
#0000ff  got 0.4520137184, -0.0324569842, -0.3115281477 published 0.4520137, -0.0324484, -0.3115281
```

Two of three agree to 1e-7; blue's `a` differs at 8.6e-6, which is at the
precision of the table I used rather than of the code — the repo's own reference
test asserts against a fuller set and passes.

W3C worked examples: 21.0000, 4.5422 (`#767676`), 4.5578 (`#757575`), 3.9985
(red on white). Exact.

The corpus's hostile palette solves: `onAccent` on the mid-orange `#E8622C` is
5.195:1, derived rather than picked, and every reported `contrastWithPair` matches
what I compute to 0.01. No `onX` pair is below 4.5.

*What would have caught this failing:* the reference values are the check — a
transposed matrix or a linearisation error moves them in the third decimal.

### 4. Offline integrity — **PASS**

I planted nine violations into the finished artifact at the true document end and
in `<head>`, including seven spellings aimed squarely at `scanForeignScripts`,
which no critic has attacked before. Every one is a severity-1 refusal:

```
CAUGHT sev1=3 net=1  script with no id + fetch()
CAUGHT sev1=2 net=0  a second <script id="pp-model" type="application/octet-stream"> + sendBeacon
CAUGHT sev1=2 net=0  id="pp-model " (trailing space, a different id to the DOM)
CAUGHT sev1=2 net=0  id="pp-mode&#108;" (entity-encoded, decodes to pp-model)
CAUGHT sev1=2 net=0  id="pp-manifest" type="application/json;charset=utf-8"
CAUGHT sev1=2 net=0  id="pp-model " planted BEFORE the genuine one
CAUGHT sev1=2 net=0  entity id planted BEFORE the genuine one
CAUGHT sev1=1 net=1  <img src="https://…">
CAUGHT sev1=1 net=0  <svg><use xlink:href="https://…">
```

Two of them made a real request in Chromium with routing off, so the plants are
live rather than decorative. `sendBeacon` appended inside the genuine
`<script id="pp-runtime">` is caught with two findings and does phone home if you
let it. Twenty-two more planted through the model into branch scenes were either
refused at emit (`<img>`, `<iframe>`, `<link>`, `@import`, swapped `dataUri`, logo
URLs, `<svg><image href>`, uppercase `<SCRIPT>`) or shown to be inert — I checked
the inert ones by rendering the branch in a browser and confirming the string
never reaches the DOM and no request is attempted.

The shipped artifact: zero `sendBeacon`/`gtag`/`analytics`/`dataLayer` tokens,
zero requests over a 99-position walk plus every branch beat.

*What would have caught this failing:* the id-spoofing plants. If `seen` were
keyed after the `expected !== null` guard, or if entity decoding ran on one side
only, the "planted before the genuine one" pair would have gone through.

### 5. Overflow detection efficacy — **PASS**, with P3

I measured this from scratch, in a browser, with a criterion the model does not
use: `Range.getClientRects()` unioned against the computed content box, and
"cut" decided by walking ancestors for a clipping `overflow` or an active
`text-overflow: ellipsis`. 188 deck positions — the spine **and** all four
branches, every beat — at 390/1024/1600.

```
739 overflowing boxes;  295 of them cut
after collapsing repeats: 132 distinct cut boxes,  126 of them carrying data-pp-tx
detector: 125 TEXT_OVERFLOW findings

recall over data-pp-tx-marked boxes:  0.9921  (125/126)     precision 1.0000
recall over every box Chromium cuts:  0.9470  (125/132)     precision 1.0000
```

The single marked miss is `sm|sc_c5edf6412639|headline` — "HX-400 shell-and-tube
heat exchanger — Northwind Industrial", clamped to two lines where Chromium draws
three, overflowing by 25px in height. That is precisely the residual `DEFERRED.md`
records at 351.13px vs 348.70px against a 350px container. **The deferral's
reasoning survives contact**: it is one box in 126, it sits inside the residual
`overflow-browser.test.mjs` already publishes (installed Latin mean 0.133%, p95
0.890%), and closing it means either per-glyph hinted metrics or widening the band
until the check stops working. L11 and L8 declining to buy the number by widening
the band is the right call and I would not have accepted it if they had.

Precision is genuinely 1.0000. The three apparent false positives in my first
pass were two real sibling elements (`stackStep#1` and `stackStep#2`) rendering
the same text at different beats — my dedup, not their detector.

The six unmarked misses are all P3's branch badge.

*What would have caught this failing:* the ground truth is browser-side and
marker-independent, so a detector that agreed with itself would still have shown
a gap; and I walked branch scenes, which pass 2 did not, specifically to find
boxes outside the spine.

### 6. Branch integrity — **PASS**

I built ten malformed branch graphs by hand and ran each through `runPreflight`
and `emit()`:

| construction | preflight | emit |
|---|---|---|
| no anchor anywhere, no aliases, empty objection | `BRANCH_UNREACHABLE`/s2 + `BRANCH_NO_RETURN`/s2 | emitted (severity split per dispute #17) |
| anchored to a scene id that does not exist | `BRANCH_UNREACHABLE`/s2 + `BRANCH_NO_RETURN`/s2 | emitted |
| branch with zero scenes | `BRANCH_NO_RETURN`/**s1** | **blocked** |
| unknown `returnPolicy` | throws on §4 shape | **blocked** |
| two branches sharing one id | `DUPLICATE_SCENE`/**s1** | **blocked** (pass 2's C5, closed) |
| branch scene id colliding with a spine scene | `DUPLICATE_SCENE`/**s1** | **blocked** |
| rendition id that does not exist | `ASSET_MISSING`/**s1** | **blocked** |
| beat revealing nothing | `BEAT_EMPTY`/s2 | emitted |
| anchored only from another branch scene | nothing | emitted |
| two branches anchoring only each other, neither on the spine | `BRANCH_NO_RETURN`/s2 | emitted |

The last two look like escapes and are not. I emitted the cycle and drove it: the
jump index still lists both, falling back to the branch id as a label (P12), so
the branches *are* reachable and `BRANCH_UNREACHABLE` is right not to fire. I
confirmed by walking the whole spine without ever entering one, then reaching both
through `/`.

Return-stack behaviour, driven by keyboard on the emitted artifact:

```
jump "fouling"  → bn_5837b0f  stack[spine@0.0]
jump "appro"    → bn_0c0a82c  stack[spine@0.0 | bn_5837b0f@0.0]
jump "suppl"    → bn_5924df6  stack[spine@0.0 | bn_5837b0f@0.0 | bn_0c0a82c@0.0]
jump "capital"  → bn_53d3e30  stack[spine@0.0 | … | bn_5924df6@0.0]
Backspace       → bn_5924df6  stack depth 3
Backspace       → spine@1.0   stack []          (nextSpineScene unwinds all — D1, by design)
r from 4 deep   → spine@1.0   stack []
```

Beat reversibility across every beat of all four branches: **0 mismatches** on
state hash and on the visible element set. Walking off the end of a branch exits
correctly, and an immediate `←` re-enters at the beat it left (`exitedFrom` doing
its job), while a `←` after other transitions does not — which is what the code
documents.

*What would have caught this failing:* comparing the DOM's visible reveal set as
well as the state hash, so a hash that agreed while the screen did not would have
shown; and driving the cycle in a browser rather than trusting the finding list.

### 7. Provenance enforcement — **PASS**, with P8

Blocked at the emitter, not the UI, on every route I could find:

- `labelIllustrativeContent: false` — refused with `1 × PROVENANCE_UNLABELED` in
  `mode: 'both'` **and** in `mode: 'review'`, and the studio panel says so in
  plain English rather than offering a toggle.
- 37 of 39 stylesheet attacks refused, including everything pass 2 tried plus
  `scale:0`, `zoom:0`, `rotate` with zero width, `mix-blend-mode:multiply`,
  `filter:brightness(0)`, `content-visibility:hidden`, `opacity:0.02`,
  `position:fixed` off-screen, and a near-background colour. Two get through (P8).
- Ancestor-level attacks that hide the label also hide the content, so they are
  broken decks rather than provenance leaks — I checked each in a browser rather
  than assuming.
- Presenter notes: I put a distinctive string in a spine beat and a branch beat
  and emitted six mode/notes combinations. In `review` and in any build with
  `includePresenterNotes: false`, `notesInModel` is **0**, read from the decoded
  payload in the running artifact. The generic coaching strings that do appear in
  the file are `src/scene/plan.js`'s `NOTES` table inside the bundle — library
  defaults, not the seller's read on the room. I checked, because it looked like a
  leak.

*What would have caught this failing:* every CSS attack was verified in Chromium
after the emit, so a rule that merely *looked* strict would have shown as an
emitted-and-invisible label. That is how P8 was found.

### 8. Presentation robustness — **PASS**

99 spine positions forward and back, every beat of every branch, four-deep nested
jumps into distinct branches with correct stack growth and unwinding, `Backspace`
one level, `r` to the spine, blank screen, help, branch map, contents, jump index
with live typing (`appr` → 2/4 with the matched substring highlighted and the
caret at position 4 — D3 stays fixed), the no-match state (*"Nothing matches
'zzzzqqq'"*, Enter is a no-op, Escape closes).

Zero state-hash mismatches. Zero page errors. Zero console errors. Zero network
attempts.

The presenter window (D16, barely touched by either predecessor) opens on `p`,
carries scene/beat counters, a **manual** `Start`/`Reset` timer with no automatic
countdown, the presenter note, the next-beat preview, branch availability and the
full key reference; it tracks the deck live as the main window advances, and keys
pressed **in** the presenter window drive the main deck. `emitOptions.mode: 'both'`
correctly boots as `review` with presenter view available but not assumed (§2).

The only wart is a harness-level one worth naming: with the jump overlay open and
focus in its input, every navigation key types into the field. That is correct —
D2's fix — but a presenter whose query matches nothing sees a deck that appears
frozen until they press Escape, and the overlay does say `Esc closes`.

*What would have caught this failing:* comparing the visible element set as well
as the hash at each of the ~200 positions, and walking branches rather than only
the spine.

### 9. Degradation honesty — **PASS**, with P4 and P7

I picked my own budgets on two proofs I built myself. On a corpus proof carrying a
1.6 MP photographic hero:

```
budget 1,586,964  reported 378,868  actual 378,857  delta  −11
budget 1,563,040  reported 378,868  actual 378,861  delta   −7
budget 1,515,192  reported 378,868  actual 378,865  delta   −3
budget 1,435,445  reported 378,868  actual 378,857  delta  −11
budget 1,275,951  reported 378,868  actual 378,857  delta  −11
```

and on one carrying a 1.4 MP noise hero, seven more budgets, all within 16 bytes.
The residual is the deflate ratio on the model, not an accounting error. **The 2×
double-count is gone and the ledger is exact.** Each line carries `copies`,
`beforeBytes`, `afterBytes`, `savedBytes = beforeBytes − afterBytes`, and
`predicted` alongside `actual` so the allocator's own error is visible (it
predicts 117,966 where the truth is 40,686 — pessimistic, and admitted).

On the unmodified corpus, `assetBytes` is 6,892 of 412,875, so every budget below
~406 KB is correctly and honestly refused: the emitter will not pretend it can
shrink its own runtime.

Two findings against it: P4, where the *refusal* explanation is wrong in a way the
degradation ledger is not, and P7, where the overshoot is large but reported.

*What would have caught this failing:* choosing absolute budgets rather than
fractions, on two proofs with different image statistics, and computing actual
savings from `len(html)` rather than from anything the emitter reports.

### 10. Studio usability under pressure — **FAIL**

The studio is, in every respect but one, a pleasure. It boots clean with zero
console errors from a 2 MB single file. `Ctrl K` lists 30 commands with their
bindings; `Alt 1`–`Alt 9` reach every section; `Alt R` sweeps, `Alt D` dry-runs,
`Alt H` shows history, `Alt ←/→/↑/↓` drive the preview, `Ctrl E` exports. Tab
order is sane. Every empty state says something true and useful — *"§1.2 asks for
at least three objection branches before a proof is done. There are 0"*; *"No
branches yet, so there is nothing for the index to find"*; *"A severity-1 finding
blocks the emit. This is a product law, not a setting: there is no override
control in this studio."* The §7 review gate refuses to be signed off on groups
that hold nothing and says which, and offers manual entry for imagery treatment,
radius, border width and shadow tier. Autosave stamps "Saved 19 Aug 2026, 05:57"
and survives a reload — I built across two sessions in one profile and everything
was there. The whole flow from empty to a swept proof took me 30 seconds of
scripted keys.

And then it writes a proof whose scenes all point at the same specimen (P1), and
offers a repair button that cannot repair it (P2).

Timed, from an empty profile:

```
 7s specimens captured (3 pastes)   — 7 things block the emit — 0 scenes, 0 branches
11s brand reviewed                  — 3 things block the emit
17s 34 renditions from 8 recipes    — 3 things block the emit
20s 6 scenes added                  — 2 things block the emit — 6 scenes
23s 3 branches created              — 2 things block the emit — 6 scenes, 3 branches
28s swept                           — 22 things block the emit
… 40 auto-fix clicks, 232s …        —  3 things block the emit — Save the file: disabled
```

Smaller things, none of them blocking: no apply-all (P11); the branch panel's
objection field is a `<textarea>` while every other primary field is an `<input>`,
which cost me two runs to discover but is not wrong; the rehearse sweep is not run
by opening the panel, which is correct but means `NO_PREFLIGHT` greets you the
first time.

### 11. Non-goal violations — **PASS**

No telemetry: verified by scanner and by browser, above. No forecasting, ROI,
scoring or measurement dashboard: I grepped `src/` for `forecast|ROI|payback|
projected|calculator` and every hit is `centroid` matching `roi`. The `score`
symbols in `src/ui/panels/` are sitemap richness ranking and recipe-fit ranking;
`estimate` is byte estimates and storage quota. No backend: the studio is one
file on `file://` with IndexedDB and no fetch except the user's own opt-in CORS
proxy and adapter, both empty by default. No live generation: the artifact renders
only from its baked model, and `dwellHintMs` is read by the presenter view and by
no timer — the deck never moved on its own across ~700 key presses.

---

## The deferrals, judged

**C1's residual — holds.** I found the same box, independently, by a different
method: `sm|sc_c5edf6412639|headline`, "HX-400 shell-and-tube heat exchanger —
Northwind Industrial", clamped to two lines where Chromium draws three. It is one
box in 126, it sits inside the published residual band, and the alternative is
buying the number by widening the band. Correctly declined.

**`badgeNumber` — holds, and is smaller than described.** Measured across all 15
occurrences at all three breakpoints:

```
badgeNumber: overW 0, overH 2, clipped false   (15 of 15)
deco:        overW 0, overH 1, clipped false   (114 of 114)
```

Exactly the 2px the note claims, never cut, nothing lost. The hole is real — a
role whose height cannot be checked is a hole — but it is costing nothing today
and the note is accurate about why.

**C16 (base64-obfuscated API name) — holds.** I could not find a product path to
it either. `scanForeignScripts`, written for exactly this, refused seven distinct
attempts to smuggle a script past it, including the two that spoof an emitter id
by trailing whitespace and by HTML entity. Refusing foreign script wholesale is a
better answer than decoding base64, and it works.

---

## What is genuinely strong

- **The emitter is the best part of this build.** Nine planted network violations,
  nine severity-1 refusals, including every spelling I could invent for a script
  claiming to be one of the emitter's own. `scanForeignScripts` is the right shape
  for the problem — it does not ask what the code does, it asks who wrote it.
- **The overflow detector is honest about a hard measurement.** 0.9921 recall and
  perfect precision over 126 real boxes in real layouts, reproduced by a stranger
  using a different criterion, and every finding carries the requested family, the
  resolved family, the excess in pixels and percent, the axis, and a suggested
  font size and character count. The message *"Sohne is not available to the
  artifact and substitutes to Arial (how much that moves the advance is unknown —
  this build holds no published metrics for the requested face)"* is a model of
  how to report a measurement whose uncertainty you understand.
- **The degradation ledger is now exact.** Twelve budgets across two proofs, worst
  error 16 bytes on 431,100.
- **The runtime does not corrupt.** ~700 key presses, ~200 positions, four-deep
  nesting, four overlays, blank screen, back-navigation from everything: zero
  mismatches, zero errors.
- **The presenter window is finished work**, not a stub — manual timer, live
  tracking, next-beat preview, and keys that drive the main deck.
- **The seed recipe library delivers §9 in full.** Nine locales with real writing
  direction, four channels, three breakpoints, five approval states, a volume
  view. It deserves a fixture that uses it.
- **`CONTRACTS-DISPUTES.md` and `DEFERRED.md` are exemplary.** Thirty-six
  objections, seventeen defects in frozen code, two deferrals with reasoning that
  both survived my attempt to break them. This is what §4's channel was for.
- **The studio's copy is honest everywhere I looked.** No panel claims a capability
  it does not have; the emit panel explains that it cannot override the law rather
  than offering a disabled button.

## What I did not exercise

Stated plainly, because a critique that overclaims is worse than one with gaps.

- **A second browser engine.** `/opt/pw-browsers` holds Chromium only, and I was
  told not to install more. Every measurement here — my overflow ground truth
  included — is Chromium's, on a container whose only real Latin faces are Arial
  and Times New Roman. §12's law is about the presenter's machine; the residual
  the build itself reports for substituted families (mean 18.3%, max 44.6%) is
  the size of what neither of us can see from here.
- **Whether the studio can ever emit.** I never reached a saved `.html` through
  the studio, because P1/P2 blocked it. Pass 2 did, so this is a regression in
  reach as well as a defect; I have no first-hand evidence about
  `emit.download` / `emit.verify`, the size-budget panel on a real payload, or
  what the studio's artifact looks like once P1 is fixed.
- **P1's blast radius beyond specimens.** I proved the collision for specimens and
  proved that renditions, scenes, branches, beats and logos do **not** collide in
  the project I built. I did not enumerate every `minterFor` call site, and any
  object minted first in its own service call is a candidate.
- **The undo/redo command stack under depth.** I confirmed autosave across
  reloads and that auto-fixes go through the command stack (the panel says so),
  but `Alt H` returned no overlay I could read, and I did not undo 200 mutations.
- **Ingest routes other than paste.** No `.har`, `.mhtml`, saved page, `.docx`,
  `.pptx`, `.pdf`, no CORS proxy, no runtime adapter. Pass 2 covered these and I
  took it on trust; note that P1 is a studio-side id defect and may well affect
  them all identically.
- **Chrome-stripping F1, quota pressure, and project import.** Pass 1 and pass 2
  measured these; I did not re-measure.
- **`dir`/`lang`/`pre` in a rendered scene.** I confirmed L7 writes them (nine
  locales, `ar-SA` at `dir: 'rtl'`), that `src/scene/blocks.js:137-150` renders
  `pre` with `data-pp-ws="pre-wrap"` so the measurer counts the same lines, and
  that the corpus carries none of them (P5). I planted an RTL rendition but could
  not get it onto a stage — the layout renders selected blocks, not appended ones
  — so I have no browser evidence that RTL text lays out correctly end to end.
  Pass 2's C8 is claimed closed and I could neither confirm nor refute it.
- **Cold boot on real hardware, USB stick, email attachment.** 104ms FCP in a
  container is not §13's claim.
- **The composition quality of the corpus deck.** Beyond P5, several scenes leave
  most of the frame empty. That is fixture authorship, and I did not grade it.

---

## Is this build close to done?

**Yes — the artifact is close to done, and the studio is one function away from
being.** I want to be precise about that, because §21's exit turns on it.

Everything from `Proof` to `.html` is in good order: the emitter refuses what it
should, the runtime does not corrupt, the measurements are honest and now
reproducible by a stranger, the colour math is exact, the determinism is proven,
and the two axes that failed last pass are genuinely fixed rather than
re-described. The severity-2 register here is small and specific: a badge that
needs a `data-pp-tx`, a font that needs to be an asset, a ladder that needs a
finer step, a fixture that needs to call `renderRecipe`.

What is not done is that the studio writes proofs the artifact cannot render
correctly, and no test reads back what the studio writes. P1 is a five-line fix
(`minterFor` needs to be created once per project and carried, or `n` needs to be
seeded from something per-capture) and P2 disappears with it. The test that
belongs beside the fix is the one that does not exist anywhere in 2007: build a
proof **through `src/ui/`** and assert its ids are unique and its scenes resolve
to distinct specimens.

Fix P1, give the corpus fixture a real `renderRecipe` call, and I would expect the
next pass to come back clean.

---

## Reproducing this

```sh
S=/tmp/claude-0/-home-user-PitchProof/4f4867db-5fdf-5b7b-bf15-0e36c8d8a775/scratchpad/c3
export PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers

node $S/01-emit.mjs            # corpus -> dist-equivalent artifact, 412,956 bytes
node $S/02-walk.mjs            # 99 positions forward and back, 0 mismatches
node $S/05-nest2.mjs           # four-deep nesting, Backspace, r, no-match query
node $S/06-reverse.mjs         # every beat of every branch, forward-then-back
node $S/10-overflow.mjs        # P3 — my own ground truth, 188 positions x 3 viewports
node $S/11-preflight.mjs       # the detector's 125 findings
node $S/12-badge.mjs           # P3 — the badge measured and screenshotted
node $S/22-ladder.mjs          # P7 — overshoot, and the exact degradation ledger
node $S/30-label-attack.mjs    # 39 CSS routes to an invisible label
node $S/31-label-verify.mjs    # P8 — the two that get through, in a browser
node $S/46-htmlplants2.mjs     # 9 planted network references, incl. 7 script-id spoofs
node $S/50-orphans.mjs         # 10 branch orphans
node $S/51-unreachable.mjs     # the cycle that is reachable after all
node $S/61-presenter.mjs       # the presenter window, driven
node $S/62-modes.mjs           # emitOptions.mode x notes x labelling
node $S/71-recipes.mjs         # P5 — 31 of 31 renditions are slices of their specimen
node $S/80-determinism.mjs     # TZ=Pacific/Kiritimati node $S/80-determinism.mjs
node $S/81-seeds.mjs           # different seeds, identical rendering
node $S/82-colour.mjs          # OKLab + WCAG against published values
node $S/C0-font.mjs            # font embedding end to end
node $S/C1-font2.mjs           # P4 — the font outside the budget, and the refusal
node $S/C6-repro.mjs           # P1 — three pastes, one specimen id, from an empty profile
node $S/C2-grind.mjs           # P2 — 40 auto-fix clicks, 232s, emit still closed
```

Two notes on the working tree. `scripts/build.mjs --verify-repeat 3` rewrites
`dist/`; the three outputs came back byte-identical to the committed ones, so
nothing drifted, but a critic's run is not read-only. And the studio scripts write
Chromium profiles under `$S/profile*`, which hold IndexedDB — delete them to
reproduce P1 from a genuinely empty state, as `C6-repro.mjs` does.
